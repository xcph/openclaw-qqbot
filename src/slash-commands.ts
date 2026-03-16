/**
 * QQBot 插件级斜杠指令处理器
 *
 * 设计原则：
 * 1. 在消息入队前拦截，匹配到插件级指令后直接回复，不进入 AI 处理队列
 * 2. 不匹配的 "/" 消息照常入队，交给 OpenClaw 框架处理
 * 3. 每个指令通过 SlashCommand 接口注册，易于扩展
 *
 * 时间线追踪：
 *   开平推送时间戳 → 插件收到(Date.now()) → 指令处理完成(Date.now())
 *   从而计算「开平→插件」和「插件处理」两段耗时
 */

import type { QQBotAccountConfig } from "./types.js";
import { createRequire } from "node:module";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getUpdateInfo, formatUpdateNotice } from "./update-checker.js";
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

// 读取 package.json 中的版本号
let PLUGIN_VERSION = "unknown";
try {
  const pkg = require("../package.json");
  PLUGIN_VERSION = pkg.version ?? "unknown";
} catch {
  // fallback
}

// ============ 类型定义 ============

/** 斜杠指令上下文（消息元数据 + 运行时状态） */
export interface SlashCommandContext {
  /** 消息类型 */
  type: "c2c" | "guild" | "dm" | "group";
  /** 发送者 ID */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 消息 ID（用于被动回复） */
  messageId: string;
  /** 开平推送的事件时间戳（ISO 字符串） */
  eventTimestamp: string;
  /** 插件收到消息的本地时间（ms） */
  receivedAt: number;
  /** 原始消息内容 */
  rawContent: string;
  /** 指令参数（去掉指令名后的部分） */
  args: string;
  /** 频道 ID（guild 类型） */
  channelId?: string;
  /** 群 openid（group 类型） */
  groupOpenid?: string;
  /** 账号 ID */
  accountId: string;
  /** 账号配置（供指令读取可配置项） */
  accountConfig?: QQBotAccountConfig;
  /** 当前用户队列状态快照 */
  queueSnapshot: QueueSnapshot;
}

/** 队列状态快照 */
export interface QueueSnapshot {
  /** 各用户队列中的消息总数 */
  totalPending: number;
  /** 正在并行处理的用户数 */
  activeUsers: number;
  /** 最大并发用户数 */
  maxConcurrentUsers: number;
  /** 当前发送者在队列中的待处理消息数 */
  senderPending: number;
}

/** 斜杠指令返回值：直接回复文本，null 表示不处理（交给框架） */
type SlashCommandResult = string | null;

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 处理函数 */
  handler: (ctx: SlashCommandContext) => SlashCommandResult | Promise<SlashCommandResult>;
}

// ============ 指令注册表 ============

const commands: Map<string, SlashCommand> = new Map();

function registerCommand(cmd: SlashCommand): void {
  commands.set(cmd.name.toLowerCase(), cmd);
}

// ============ 内置指令 ============

/**
 * /ping — 轻量连通性检查
 */
registerCommand({
  name: "ping",
  description: "连通性检查",
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    const latency = isNaN(eventTime) ? "N/A" : `${now - eventTime}ms`;
    return `🏓 pong! (${latency})`;
  },
});

/**
 * /version — 版本号
 */
registerCommand({
  name: "version",
  description: "插件版本号",
  handler: () => {
    const lines = [`QQBot Plugin v${PLUGIN_VERSION}`];
    const info = getUpdateInfo();
    const notice = formatUpdateNotice(info);
    if (notice) {
      lines.push("", notice);
    }
    return lines.join("\n");
  },
});

/**
 * /help — 列出所有插件级斜杠指令
 */
registerCommand({
  name: "help",
  description: "列出所有插件级斜杠指令",
  handler: (ctx) => {
    const url = ctx.accountConfig?.upgradeUrl || DEFAULT_UPGRADE_URL;
    const lines = [`**qqbot 插件 v${PLUGIN_VERSION}**`, ``];
    for (const [name, cmd] of commands) {
      lines.push(`- \`/${name}\` — ${cmd.description}`);
    }
    lines.push(``, `**升级指引**: ${url}`);
    // 如有更新可用，追加提示
    const info = getUpdateInfo();
    const notice = formatUpdateNotice(info);
    if (notice) {
      lines.push("", notice);
    }
    return lines.join("\n");
  },
});

const DEFAULT_UPGRADE_URL = "https://github.com/tencent-connect/openclaw-qqbot";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE_SCRIPT = path.resolve(__dirname, "../scripts/upgrade-via-npm.sh");

/**
 * /upgrade [version] — 触发插件版本升级
 * 无参数: 升级到 latest
 * 带参数: 升级到指定版本，如 /upgrade 1.6.1
 */
registerCommand({
  name: "upgrade",
  description: "升级插件版本（/upgrade [版本号]）",
  handler: async (ctx) => {
    const targetVersion = ctx.args.trim();
    const scriptArgs = targetVersion ? ["--version", targetVersion] : [];

    let upgradeOk = false;
    let report = "";
    try {
      const { stdout, stderr } = await execFileAsync("bash", [UPGRADE_SCRIPT, ...scriptArgs], {
        timeout: 120_000,
        env: { ...process.env, PATH: process.env.PATH },
      });
      const output = (stdout + stderr).trim();

      // 从脚本输出解析报告文本（QQBOT_REPORT=...）和版本号
      const reportMatch = output.match(/QQBOT_REPORT=(.+)/);
      const versionMatch = output.match(/QQBOT_NEW_VERSION=(\S+)/);
      const newVersion = versionMatch?.[1] || "unknown";
      report = reportMatch?.[1] || `✅ QQBot 升级完成: v${newVersion}`;

      upgradeOk = newVersion !== "unknown" && newVersion !== PLUGIN_VERSION;
      if (!upgradeOk && newVersion === PLUGIN_VERSION) {
        report = `ℹ️ 已是最新版本 v${PLUGIN_VERSION}`;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      report = `❌ 升级失败: ${msg}`;
    }

    if (upgradeOk) {
      setTimeout(() => {
        try { updatePluginsInstalls(); } catch {}
        const cliNames = ["openclaw", "clawdbot", "moltbot"];
        const tryRestart = (idx: number) => {
          if (idx >= cliNames.length) { process.exit(0); return; }
          const cli = cliNames[idx];
          const child = spawn(cli, ["gateway", "restart"], {
            detached: true, stdio: "ignore", env: process.env,
          });
          child.on("error", () => tryRestart(idx + 1));
          child.unref();
        };
        tryRestart(0);
      }, 2000);
    }

    return report;
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<string | null> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}

/**
 * 更新 openclaw.json 中的 plugins.installs 记录。
 * - 如果 source 是 "path"（开发目录），改为 "npm" 并删除 sourcePath
 * - 更新 installPath、version、installedAt
 */
function updatePluginsInstalls(): void {
  const cliNames = ["openclaw", "clawdbot", "moltbot"];
  let configPath = "";
  let cliName = "";
  for (const name of cliNames) {
    const candidate = path.join(process.env.HOME || "~", `.${name}`, `${name}.json`);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      cliName = name;
      break;
    }
  }
  if (!configPath) return;

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const extensionsDir = path.join(process.env.HOME || "~", `.${cliName}`, "extensions");
  const installPath = path.join(extensionsDir, "openclaw-qqbot");

  // 读取新安装的版本号
  let newVersion = "unknown";
  try {
    const pkgPath = path.join(installPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      newVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || "unknown";
    }
  } catch {}

  cfg.plugins = cfg.plugins || {};
  cfg.plugins.installs = cfg.plugins.installs || {};

  const existing = cfg.plugins.installs["openclaw-qqbot"] || {};

  // 保留已有记录，只更新关键字段
  cfg.plugins.installs["openclaw-qqbot"] = {
    ...existing,
    source: "npm",
    installPath,
    version: newVersion,
    installedAt: new Date().toISOString(),
  };
  // 如果之前是 source:"path"，清除 sourcePath（指向开发目录）
  delete cfg.plugins.installs["openclaw-qqbot"].sourcePath;

  // 确保 plugins.entries 存在
  cfg.plugins.entries = cfg.plugins.entries || {};
  if (!cfg.plugins.entries["openclaw-qqbot"]) {
    cfg.plugins.entries["openclaw-qqbot"] = { enabled: true };
  }

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 4) + "\n");
}
