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
import path from "node:path";
import fs from "node:fs";
import { getUpdateInfo, checkVersionExists } from "./update-checker.js";
import { getHomeDir, getQQBotDataDir, getTempDir, isWindows } from "./utils/platform.js";
import { saveCredentialBackup } from "./credential-backup.js";
import { fileURLToPath } from "node:url";
import { getPackageVersion } from "./utils/pkg-version.js";
import { getQQBotRuntime } from "./runtime.js";
import { isApprovalFeatureAvailable } from "./approval-handler.js";
const require = createRequire(import.meta.url);

let PLUGIN_VERSION = getPackageVersion(import.meta.url);

// 获取 openclaw 框架版本（从 package.json 读取）
export function getFrameworkVersion(): string {
  try {
    // 尝试从全局安装的 package.json 读取版本
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const version = tryReadGlobalPackageVersion(cli);
      if (version) {
        return version;
      }
    }

    // 尝试从本地 node_modules 读取
    const localVersion = tryReadLocalPackageVersion();
    if (localVersion) {
      return localVersion;
    }
  } catch {
    // fallback
  }
  return "unknown";
}

/**
 * 尝试从全局 npm 安装的 package.json 读取版本
 */
function tryReadGlobalPackageVersion(packageName: string): string | null {
  try {
    // 尝试常见的全局安装路径
    const homeDir = getHomeDir();
    const candidates = [
      // npm 全局安装路径
      path.join(homeDir, ".nvm", "versions", "node", process.version, "lib", "node_modules", packageName, "package.json"),
      path.join(homeDir, ".nvm", "versions", "node", process.version, "lib", "node_modules", packageName, "lib", "node_modules", packageName, "package.json"),
      // npm root -g 路径（尝试常见的 Node 版本目录）
      path.join(homeDir, ".n", "versions", "node", process.version, "lib", "node_modules", packageName, "package.json"),
      path.join("/usr", "local", "lib", "node_modules", packageName, "package.json"),
      path.join("/usr", "lib", "node_modules", packageName, "package.json"),
      // fnm 路径
      path.join(homeDir, ".fnm", "node-versions", process.version, "installation", "lib", "node_modules", packageName, "package.json"),
      // volta 路径
      path.join(homeDir, ".volta", "tools", "image", "packages", packageName, "package.json"),
    ];

    for (const pkgPath of candidates) {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.version) {
          return `${packageName} ${pkg.version}`;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * 尝试从本地 node_modules 读取 openclaw 版本
 */
function tryReadLocalPackageVersion(): string | null {
  try {
    // 从当前文件向上查找 node_modules
    const currentFile = fileURLToPath(import.meta.url);
    let dir = path.dirname(currentFile);
    for (let i = 0; i < 10; i++) {
      for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
        const pkgPath = path.join(dir, "node_modules", cli, "package.json");
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg.version) {
            return `${cli} ${pkg.version}`;
          }
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return null;
}

// ============ 热更新兼容性检查 ============

/**
 * 热更新可执行的环境要求：
 * - 最低 OpenClaw 框架版本
 * - 支持的操作系统
 * - 最低 Node.js 版本
 */
const UPGRADE_REQUIREMENTS = {
  /** OpenClaw 最低版本（YYYY.M.D 格式，如 "2026.3.10"） */
  minFrameworkVersion: "2026.3.2",
  /** 支持的操作系统列表（process.platform 值） */
  supportedPlatforms: ["darwin", "linux"] as string[],
  /** 最低 Node.js 版本 */
  minNodeVersion: "18.0.0",
};

interface UpgradeCompatResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * 解析框架版本字符串中的日期版本号
 * 输入示例: "OpenClaw 2026.3.13 (61d171a)" → "2026.3.13"
 */
export function parseFrameworkDateVersion(versionStr: string): string | null {
  const m = versionStr.match(/(\d{4}\.\d{1,2}\.\d{1,2})/);
  return m ? m[1] : null;
}

/**
 * 比较 YYYY.M.D 格式的版本号
 * @returns >0 if a > b, <0 if a < b, 0 if equal
 */
function compareDateVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 比较 semver 版本号（简化版，仅比较 major.minor.patch）
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 检查当前环境是否满足热更新要求
 */
function checkUpgradeCompatibility(): UpgradeCompatResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const req = UPGRADE_REQUIREMENTS;

  // 1. 检查操作系统
  const platform = process.platform;
  if (!req.supportedPlatforms.includes(platform)) {
    const supported = req.supportedPlatforms.map(p => {
      if (p === "darwin") return "macOS";
      if (p === "linux") return "Linux";
      if (p === "win32") return "Windows";
      return p;
    }).join("、");
    const current = platform === "win32" ? "Windows"
      : platform === "darwin" ? "macOS"
      : platform;
    errors.push(`❌ 当前操作系统 **${current}** 不支持热更新（支持：${supported}）`);
  }

  // 2. 检查 OpenClaw 框架版本
  const fwVersion = getFrameworkVersion();
  if (fwVersion === "unknown") {
    // 打包环境（HoldClaw/QQAIO）中 CLI 可能不在 PATH，版本检测会失败，
    // 但 findCli() 的 fallback 仍可能找到 CLI 执行升级，所以只是警告不阻断。
    warnings.push(`⚠️ 无法检测 OpenClaw 框架版本，热更新可能失败`);
  } else {
    const dateVer = parseFrameworkDateVersion(fwVersion);
    if (dateVer && compareDateVersions(dateVer, req.minFrameworkVersion) < 0) {
      errors.push(`❌ OpenClaw 框架版本过低：当前 **${dateVer}**，热更新要求最低 **${req.minFrameworkVersion}**。请先升级框架：\`openclaw upgrade\``);
    }
  }

  // 3. 检查 Node.js 版本
  const nodeVer = process.version.replace(/^v/, "");
  if (compareSemver(nodeVer, req.minNodeVersion) < 0) {
    errors.push(`❌ Node.js 版本过低：当前 **v${nodeVer}**，热更新要求最低 **v${req.minNodeVersion}**`);
  }

  // 4. 检查系统架构（arm 等特殊架构提示）
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    warnings.push(`⚠️ 当前 CPU 架构 **${arch}** 未经充分测试，热更新可能存在兼容性问题`);
  }

  return { ok: errors.length === 0, errors, warnings };
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
  /** Bot App ID */
  appId: string;
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

/** 斜杠指令返回值：文本、带文件的结果、委托给模型、或 null（不处理） */
export type SlashCommandResult = string | SlashCommandFileResult | SlashCommandDelegateResult | null;

/** 带文件的指令结果（先回复文本，再发送文件） */
export interface SlashCommandFileResult {
  text: string;
  /** 要发送的本地文件路径 */
  filePath: string;
}

/** 委托给 AI 模型处理：用加工后的 prompt 替换原始消息入队 */
export interface SlashCommandDelegateResult {
  /** 替换原始消息内容的 prompt，交给 AI 模型执行 */
  delegatePrompt: string;
}

/** 斜杠指令定义 */
interface SlashCommand {
  /** 指令名（不含 /） */
  name: string;
  /** 简要描述 */
  description: string;
  /** 详细用法说明（支持多行），用于 /指令 ? 查询 */
  usage?: string;
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
 * /bot-ping — 测试当前 openclaw 与 QQ 连接的网络延迟
 */
registerCommand({
  name: "bot-ping",
  description: "测试当前 openclaw 与 QQ 连接的网络延迟",
  usage: [
    `/bot-ping`,
    ``,
    `测试 OpenClaw 主机与 QQ 服务器之间的网络延迟。`,
    `返回网络传输耗时和插件处理耗时。`,
  ].join("\n"),
  handler: (ctx) => {
    const now = Date.now();
    const eventTime = new Date(ctx.eventTimestamp).getTime();
    if (isNaN(eventTime)) {
      return `✅ pong!`;
    }
    const totalMs = now - eventTime;
    const qqToPlugin = ctx.receivedAt - eventTime;
    const pluginProcess = now - ctx.receivedAt;
    const lines = [
      `✅ pong！`,
      ``,
      `⏱ 延迟: ${totalMs}ms`,
      `  ├ 网络传输: ${qqToPlugin}ms`,
      `  └ 插件处理: ${pluginProcess}ms`,
    ];
    return lines.join("\n");
  },
});

/**
 * /bot-version — 查看插件版本号
 */
registerCommand({
  name: "bot-version",
  description: "查看插件版本号",
  usage: [
    `/bot-version`,
    ``,
    `查看当前 QQBot 插件版本和 OpenClaw 框架版本。`,
    `同时检查是否有新版本可用。`,
  ].join("\n"),
  handler: async () => {
    const frameworkVersion = getFrameworkVersion();
    const lines = [
      `🦞框架版本：${frameworkVersion}`,
      `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
    ];
    const info = await getUpdateInfo();
    if (info.checkedAt === 0) {
      lines.push(`⏳ 版本检查中...`);
    } else if (info.error) {
      lines.push(`⚠️ 版本检查失败`);
    } else if (info.hasUpdate && info.latest) {
      lines.push(`🆕最新可用版本：v${info.latest}，点击 <qqbot-cmd-input text="/bot-upgrade" show="/bot-upgrade"/> 查看升级指引`);
    } 
    lines.push(`🌟官方 GitHub 仓库：[点击前往](https://github.com/tencent-connect/openclaw-qqbot/)`);
    return lines.join("\n");
  },
});

/**
 * /bot-help — 查看所有指令以及用途
 */
registerCommand({
  name: "bot-help",
  description: "查看所有指令以及用途",
  usage: [
    `/bot-help`,
    ``,
    `列出所有可用的 QQBot 插件内置指令及其简要说明。`,
    `使用 /指令名 ? 可查看某条指令的详细用法。`,
  ].join("\n"),
  handler: (ctx) => {
    // 群聊场景排除仅限私聊的指令
    const GROUP_EXCLUDED_COMMANDS = new Set(["bot-upgrade", "bot-clear-storage"]);
    const isGroup = ctx.type === "group";

    const lines = [`### QQBot插件内置调试指令`, ``];
    for (const [name, cmd] of commands) {
      if (isGroup && GROUP_EXCLUDED_COMMANDS.has(name)) continue;
      lines.push(`<qqbot-cmd-input text="/${name}" show="/${name}"/> ${cmd.description}`);
    }
    lines.push(``, `> 插件版本 v${PLUGIN_VERSION}`);
    return lines.join("\n");
  },
});

const DEFAULT_UPGRADE_URL = "https://docs.qq.com/doc/DSGxOZk1oVnVKVkpq";

function saveUpgradeGreetingTarget(accountId: string, appId: string, openid: string): void {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const safeAppId = appId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(getQQBotDataDir("data"), `upgrade-greeting-target-${safeAccountId}-${safeAppId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({
      accountId,
      appId,
      openid,
      savedAt: new Date().toISOString(),
    }) + "\n");
  } catch {
    // ignore
  }
}

// ============ 热更新 ============

/**
 * 找到 CLI 命令名或完整路径（openclaw / clawdbot / moltbot）
 *
 * 查找策略（纯文件系统，不使用 shell）：
 * 1. 打包环境（HoldClaw / QQAIO）：从当前文件路径向上推断 CLI 位置
 * 2. ~/.openclaw/bin/ 等常见安装路径
 * 3. 全局 npm 安装路径
 */
function findCli(): string | null {
  // 打包环境：从当前文件路径推断 CLI
  // 典型路径: .../gateway/node_modules/openclaw-qqbot/dist/src/slash-commands.js
  // CLI 位于: .../gateway/node_modules/openclaw/openclaw.mjs
  // 或者:     .../gateway/node_modules/.bin/openclaw
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);

    // 向上查找 node_modules 目录
    let dir = currentDir;
    for (let i = 0; i < 10; i++) {
      const basename = path.basename(dir);
      if (basename === "node_modules") {
        // 检查 .bin 下的 CLI
        for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
          const binName = isWindows() ? `${cli}.cmd` : cli;
          const binPath = path.join(dir, ".bin", binName);
          if (fs.existsSync(binPath)) return binPath;
        }
        // 检查 openclaw/openclaw.mjs（直接通过 node 调用）
        for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
          const mjsPath = path.join(dir, cli, `${cli}.mjs`);
          if (fs.existsSync(mjsPath)) return mjsPath;
        }
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }

  // ~/.openclaw/bin/ 等常见安装路径
  const homeDir = getHomeDir();
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    const ext = isWindows() ? ".exe" : "";
    const candidates = [
      path.join(homeDir, `.${cli}`, "bin", `${cli}${ext}`),
      path.join(homeDir, `.${cli}`, `${cli}${ext}`),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 全局 npm 安装路径（常见位置）
  try {
    const homeDir = getHomeDir();
    const nodeVersion = process.version;
    const candidates = [
      // nvm 路径
      path.join(homeDir, ".nvm", "versions", "node", nodeVersion, "bin", "openclaw"),
      path.join(homeDir, ".nvm", "versions", "node", nodeVersion, "bin", "clawdbot"),
      path.join(homeDir, ".nvm", "versions", "node", nodeVersion, "bin", "moltbot"),
      // n 路径
      path.join(homeDir, ".n", "versions", "node", nodeVersion, "bin", "openclaw"),
      path.join(homeDir, ".n", "versions", "node", nodeVersion, "bin", "clawdbot"),
      path.join(homeDir, ".n", "versions", "node", nodeVersion, "bin", "moltbot"),
      // fnm 路径
      path.join(homeDir, ".fnm", "node-versions", nodeVersion, "installation", "bin", "openclaw"),
      path.join(homeDir, ".fnm", "node-versions", nodeVersion, "installation", "bin", "clawdbot"),
      path.join(homeDir, ".fnm", "node-versions", nodeVersion, "installation", "bin", "moltbot"),
      // volta 路径
      path.join(homeDir, ".volta", "bin", "openclaw"),
      path.join(homeDir, ".volta", "bin", "clawdbot"),
      path.join(homeDir, ".volta", "bin", "moltbot"),
      // 系统路径
      "/usr/local/bin/openclaw",
      "/usr/local/bin/clawdbot",
      "/usr/local/bin/moltbot",
      "/usr/bin/openclaw",
      "/usr/bin/clawdbot",
      "/usr/bin/moltbot",
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } catch {
    // ignore
  }

  return null;
}


/**
 * 找到升级脚本路径（兼容源码运行、dist 运行、已安装扩展目录、打包环境）
 * Windows 优先查找 .ps1，Mac/Linux 查找 .sh
 */
function getUpgradeScriptPath(): string | null {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const scriptName = isWindows() ? "upgrade-via-npm.ps1" : "upgrade-via-npm.sh";

  const candidates = [
    // 源码运行: src/slash-commands.ts → ../../scripts/
    // dist 运行: dist/src/slash-commands.js → ../../scripts/
    path.resolve(currentDir, "..", "..", "scripts", scriptName),
    // npm 安装: node_modules/@tencent-connect/openclaw-qqbot/dist/src → ../../scripts
    path.resolve(currentDir, "..", "scripts", scriptName),
    path.resolve(process.cwd(), "scripts", scriptName),
  ];

  // 向上查找包含 scripts/ 的祖先目录（适应各种嵌套深度的打包环境）
  let dir = currentDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "scripts", scriptName);
    if (!candidates.includes(candidate)) candidates.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const homeDir = getHomeDir();
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    candidates.push(path.join(homeDir, `.${cli}`, "extensions", "openclaw-qqbot", "scripts", scriptName));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/** 允许执行的 shell 命令白名单 */
const ALLOWED_SHELLS = new Set(["bash", "sh", "pwsh", "powershell", "powershell.exe"]);

/** 验证升级脚本路径是否合法 */
function validateUpgradeScriptPath(scriptPath: string): boolean {
  // 必须是非空字符串
  if (!scriptPath || typeof scriptPath !== "string") return false;

  // 必须是绝对路径
  if (!path.isAbsolute(scriptPath)) return false;

  // 必须存在
  if (!fs.existsSync(scriptPath)) return false;

  // 必须是文件
  const stat = fs.statSync(scriptPath);
  if (!stat.isFile()) return false;

  // 必须在允许的目录下（用户主目录或临时目录）
  const homeDir = getHomeDir();
  const tmpDir = getTempDir();
  const normalizedPath = path.normalize(scriptPath);

  // 检查是否在允许的目录下
  const isInHomeDir = normalizedPath.startsWith(path.normalize(homeDir));
  const isInTmpDir = normalizedPath.startsWith(path.normalize(tmpDir));

  if (!isInHomeDir && !isInTmpDir) {
    console.error(`[qqbot] validateUpgradeScriptPath: script not in allowed directory: ${scriptPath}`);
    return false;
  }

  return true;
}

/** 验证 shell 参数是否合法 */
function validateShellArgs(shell: string, args: string[]): boolean {
  // 验证 shell 在白名单内
  const shellName = path.basename(shell).toLowerCase();
  if (!ALLOWED_SHELLS.has(shellName)) {
    console.error(`[qqbot] validateShellArgs: shell not in whitelist: ${shell}`);
    return false;
  }

  // 验证参数不包含危险字符
  for (const arg of args) {
    if (typeof arg !== "string") return false;
    // 禁止包含 shell 注入字符
    const dangerousChars = /[;&|`$(){}[\]\n\r]/;
    if (dangerousChars.test(arg)) {
      console.error(`[qqbot] validateShellArgs: dangerous character in arg: ${arg}`);
      return false;
    }
  }

  return true;
}

type HotUpgradeStartResult = {
  ok: boolean;
  reason?: "no-script" | "no-cli" | "no-bash" | "no-powershell" | "invalid-script" | "invalid-args";
};

/**
 * 在 Windows 上查找可用的 bash（Git Bash / WSL 等）
 * 仅作为 Windows 上的 fallback（优先使用 PowerShell）
 * 纯文件系统检测，不执行 shell 命令
 */
function findBash(): string | null {
  if (!isWindows()) return "bash";

  // Git Bash 常见路径
  const candidates = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe"),
    // WSL 路径
    "C:\\Windows\\System32\\bash.exe",
  ];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * 将 openclaw.json 中的 qqbot 插件 source 从 "path" 切换为 "npm"。
 * 用于热更新场景：从 npm 拉取新版本后，确保 openclaw 不再从本地源码加载。
 *
 * 安全保障：写回配置前验证 channels.qqbot 未丢失，防止竞态写入导致凭证消失。
 */
function switchPluginSourceToNpm(): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;

      // 读取当前配置（保留原始文本用于回退）
      const raw = fs.readFileSync(cfgPath, "utf8");

      let cfg: any;
      try {
        cfg = JSON.parse(raw);
      } catch {
        // 配置文件已经是损坏的 JSON，不要继续操作以免加剧问题
        break;
      }

      const inst = cfg?.plugins?.installs?.["openclaw-qqbot"];
      if (!inst || inst.source === "npm") {
        break; // 无需修改
      }

      // 记录修改前的完整快照，用于写后校验
      const channelsBefore = JSON.stringify(cfg.channels ?? null);

      inst.source = "npm";
      delete inst.sourcePath;
      const newRaw = JSON.stringify(cfg, null, 4) + "\n";

      // 写后校验：重新解析确认整个 JSON 合法且 channels 未被破坏
      let verify: any;
      try {
        verify = JSON.parse(newRaw);
      } catch {
        // stringify 后竟然无法 parse（理论上不会），放弃写入
        break;
      }
      const channelsAfter = JSON.stringify(verify.channels ?? null);
      if (channelsBefore !== channelsAfter) {
        // channels 数据异常，放弃写入
        break;
      }

      // 原子写入：先写临时文件，再 rename 替换，避免写入中途崩溃导致配置文件损坏
      const tmpPath = cfgPath + ".qqbot-upgrade.tmp";
      fs.writeFileSync(tmpPath, newRaw, { mode: 0o644 });

      // 再次校验临时文件的完整性
      try {
        JSON.parse(fs.readFileSync(tmpPath, "utf8"));
      } catch {
        // 写入的临时文件不完整，清理后放弃
        try { fs.unlinkSync(tmpPath); } catch {}
        break;
      }

      fs.renameSync(tmpPath, cfgPath);
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 热更新前保存当前账户的 appId/secret 到暂存文件。
 * 从 openclaw.json 中直接读取 clientSecret（slash command ctx 中不含 secret）。
 */
function preUpgradeCredentialBackup(accountId: string, appId: string): void {
  try {
    const homeDir = getHomeDir();
    for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const qqbot = cfg?.channels?.qqbot;
      if (!qqbot) break;
      // 从默认账户或 accounts 子节点中读取 secret
      let secret = "";
      if (accountId === "default" && qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      } else if (qqbot.accounts?.[accountId]?.clientSecret) {
        secret = qqbot.accounts[accountId].clientSecret;
      } else if (qqbot.clientSecret) {
        secret = qqbot.clientSecret;
      }
      if (appId && secret) {
        saveCredentialBackup(accountId, appId, secret);
      }
      break;
    }
  } catch {
    // 非关键操作，静默忽略
  }
}

/**
 * 在 Windows 上查找 PowerShell（pwsh 优先，powershell.exe 兜底）
 * 纯文件系统检测，不执行 shell 命令
 */
function findPowerShell(): string | null {
  // pwsh = PowerShell 7+（跨平台），powershell.exe = Windows 内置 5.1
  const candidates = [
    // PowerShell 7+ (pwsh)
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "pwsh.exe"),
    "pwsh",
    // Windows 内置 PowerShell 5.1
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell",
  ];

  for (const p of candidates) {
    if (p && !p.includes("\\") && !p.includes("/")) {
      // 如果是不带路径的命令名，直接返回（由调用方决定如何处理）
      return p;
    }
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 将升级脚本复制到临时位置，避免升级过程中插件目录被清理后脚本丢失。
 * 返回临时脚本路径，失败返回 null。
 */
function copyScriptToTemp(scriptPath: string): string | null {
  try {
    const ext = path.extname(scriptPath);
    const tmpDir = path.join(getHomeDir(), ".openclaw", ".qqbot-upgrade-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpScript = path.join(tmpDir, `upgrade-via-npm${ext}`);
    fs.copyFileSync(scriptPath, tmpScript);
    if (!isWindows()) {
      fs.chmodSync(tmpScript, 0o755);
    }
    return tmpScript;
  } catch {
    return null;
  }
}

const REMOTE_UPGRADE_SCRIPT_URL = "https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.sh";
const REMOTE_UPGRADE_SCRIPT_URL_WIN = "https://raw.githubusercontent.com/tencent-connect/openclaw-qqbot/main/scripts/upgrade-via-npm.ps1";

/**
 * 从远端下载升级脚本到临时目录，返回临时脚本路径，失败返回 null。
 * 使用 Node.js fetch API，不执行 shell 命令
 */
async function downloadRemoteUpgradeScript(): Promise<string | null> {
  try {
    const url = isWindows() ? REMOTE_UPGRADE_SCRIPT_URL_WIN : REMOTE_UPGRADE_SCRIPT_URL;
    const ext = isWindows() ? ".ps1" : ".sh";
    const tmpDir = path.join(getHomeDir(), ".openclaw", ".qqbot-upgrade-tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpScript = path.join(tmpDir, `upgrade-via-npm${ext}`);

    // 使用 Node.js fetch API 下载
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.error(`[qqbot] downloadRemoteUpgradeScript: HTTP ${response.status}`);
      return null;
    }

    const content = await response.text();
    if (content.length < 100) {
      console.error(`[qqbot] downloadRemoteUpgradeScript: downloaded content too small`);
      return null;
    }

    fs.writeFileSync(tmpScript, content, "utf8");

    if (!isWindows()) {
      fs.chmodSync(tmpScript, 0o755);
    }

    console.log(`[qqbot] downloadRemoteUpgradeScript: fetched from ${url} → ${tmpScript}`);
    return tmpScript;
  } catch (e: any) {
    console.error(`[qqbot] downloadRemoteUpgradeScript: failed: ${e.message}`);
    return null;
  }
}

/**
 * 清理临时升级脚本目录
 */
function cleanupTempScript(): void {
  try {
    const tmpDir = path.join(getHomeDir(), ".openclaw", ".qqbot-upgrade-tmp");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // 非关键，静默忽略
  }
}

/**
 * 执行热更新：生成升级脚本和重启脚本，返回给用户手动执行
 *
 * 为满足 OpenClaw 安全扫描要求，本函数不再执行任何外部命令。
 * 改为生成脚本文件并返回需要手动执行的命令列表。
 */
async function fireHotUpgrade(targetVersion?: string, pkg?: string, useLocal?: boolean): Promise<HotUpgradeStartResult & { commands?: string[] }> {
  // --local: 直接使用本地脚本，跳过远端下载
  // 默认: 优先从远端下载升级脚本，避免使用本地可能过时的版本
  let scriptPath: string | null = null;

  if (useLocal) {
    const local = getUpgradeScriptPath();
    if (local) {
      console.log(`[qqbot] fireHotUpgrade: --local specified, using local script: ${local}`);
      scriptPath = copyScriptToTemp(local) || local;
    }
  } else {
    // 尝试从远端下载
    const remotePath = await downloadRemoteUpgradeScript();
    if (remotePath) {
      scriptPath = remotePath;
    } else {
      // 回退到本地脚本
      const local = getUpgradeScriptPath();
      if (local) {
        console.log(`[qqbot] fireHotUpgrade: remote download failed, falling back to local script: ${local}`);
        scriptPath = copyScriptToTemp(local) || local;
      }
    }
  }

  if (!scriptPath) return { ok: false, reason: "no-script" };

  // 验证脚本路径合法性
  if (!validateUpgradeScriptPath(scriptPath)) {
    return { ok: false, reason: "invalid-script" };
  }

  const cli = findCli();
  if (!cli) return { ok: false, reason: "no-cli" };

  // 生成命令列表供用户手动执行
  const commands: string[] = [];

  if (isWindows()) {
    // Windows: PowerShell 执行 .ps1
    const ps = findPowerShell();
    if (!ps) return { ok: false, reason: "no-powershell" };

    const versionArg = targetVersion ? ` -Version ${targetVersion}` : "";
    const pkgArg = pkg ? ` -Pkg ${pkg}` : "";
    commands.push(`${ps} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" -NoRestart${versionArg}${pkgArg}`);

    // 生成重启脚本路径
    const ps1Path = path.join(getHomeDir(), ".openclaw", ".qqbot-restart.ps1");
    const cliInvoke = cli.endsWith(".mjs") ? `& '${process.execPath}' '${cli}'` : `& '${cli}'`;
    const ps1Content = [
      `Write-Host '[qqbot-upgrade] Stopping gateway...'`,
      `${cliInvoke} gateway stop`,
      `Write-Host '[qqbot-upgrade] Waiting for process to exit...'`,
      `Start-Sleep -Seconds 3`,
      `Write-Host '[qqbot-upgrade] Starting gateway...'`,
      `${cliInvoke} gateway start`,
      `Write-Host '[qqbot-upgrade] Done.'`,
      `Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue`,
    ].join("\r\n");
    fs.writeFileSync(ps1Path, ps1Content, "utf8");
    commands.push(`${ps} -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ps1Path}"`);
  } else {
    // Mac / Linux: bash 执行 .sh
    const bash = findBash();
    if (!bash) return { ok: false, reason: "no-bash" };

    const versionArg = targetVersion ? ` --version ${targetVersion}` : "";
    const pkgArg = pkg ? ` --pkg ${pkg}` : "";
    commands.push(`${bash} "${scriptPath}" --no-restart${versionArg}${pkgArg}`);

    // 生成重启脚本
    const homeDir = getHomeDir();
    const configPath = path.join(homeDir, ".openclaw", "openclaw.json");
    const qqbotChannelBackup = path.join(homeDir, ".openclaw", ".qqbot-channel-backup.json");
    const restartScript = path.join(homeDir, ".openclaw", ".qqbot-restart.sh");
    const cliInvoke = cli.endsWith(".mjs") ? `"${process.execPath}" "${cli}"` : `"${cli}"`;

    // 保存 channels.qqbot 到临时文件
    try {
      const cfgRaw = fs.readFileSync(configPath, "utf8");
      const cfg = JSON.parse(cfgRaw);
      const qqbot = cfg?.channels?.qqbot;
      if (qqbot) {
        fs.writeFileSync(qqbotChannelBackup, JSON.stringify(qqbot, null, 2), "utf8");
      }
    } catch { /* ignore */ }

    const shContent = `#!/bin/bash
CLI=${cliInvoke}
CONFIG="${configPath}"
BACKUP="${qqbotChannelBackup}"

# 为 gateway stop 创建临时配置
TEMP_RESTART_CONFIG=""
if [ -f "$BACKUP" ]; then
  TEMP_RESTART_CONFIG="$(mktemp)"
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (cfg.channels && cfg.channels.qqbot) {
      delete cfg.channels.qqbot;
      if (Object.keys(cfg.channels).length === 0) delete cfg.channels;
    }
    if (cfg.plugins && cfg.plugins.entries && cfg.plugins.entries['openclaw-qqbot']) {
      delete cfg.plugins.entries['openclaw-qqbot'];
      if (Object.keys(cfg.plugins.entries).length === 0) delete cfg.plugins.entries;
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(cfg, null, 4) + '\\n');
  " "$CONFIG" "$TEMP_RESTART_CONFIG" 2>/dev/null
fi

echo "[qqbot-upgrade] Stopping gateway..."
if [ -n "$TEMP_RESTART_CONFIG" ]; then
  OPENCLAW_CONFIG_PATH="$TEMP_RESTART_CONFIG" $CLI gateway stop 2>/dev/null || true
else
  $CLI gateway stop 2>/dev/null || true
fi
sleep 2

[ -n "$TEMP_RESTART_CONFIG" ] && rm -f "$TEMP_RESTART_CONFIG"

echo "[qqbot-upgrade] Starting gateway..."
if $CLI gateway start 2>/dev/null; then
  echo "[qqbot-upgrade] Gateway started successfully"
else
  # 尝试带配置修复启动
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    if (cfg.channels && cfg.channels.qqbot) {
      delete cfg.channels.qqbot;
      if (Object.keys(cfg.channels).length === 0) delete cfg.channels;
    }
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 4) + '\\n');
  " "$CONFIG" 2>/dev/null
  $CLI gateway start 2>/dev/null || echo "[qqbot-upgrade] WARNING: gateway start failed"
  sleep 8
  # 恢复配置
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    const qqbot = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    if (!cfg.channels) cfg.channels = {};
    cfg.channels.qqbot = qqbot;
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 4) + '\\n');
  " "$CONFIG" "$BACKUP" 2>/dev/null
fi

rm -f "$BACKUP" "$0"
echo "[qqbot-upgrade] Done."
`;
    fs.writeFileSync(restartScript, shContent, { mode: 0o755 });
    commands.push(`${bash} "${restartScript}"`);
  }

  // 文件替换成功，在返回之前把 source 从 path 切换为 npm
  switchPluginSourceToNpm();

  return { ok: true, commands };
}

/**
 * /bot-upgrade — 统一升级入口
 *
 * upgradeMode 开关：
 *   - "doc"（默认）：只展示升级指引文档，不执行热更新
 *   - "hot-reload"：执行 npm 升级脚本进行热更新
 *
 * 热更新模式下的产品流程：
 *   /bot-upgrade              — 展示版本信息+确认按钮（不直接升级）
 *   /bot-upgrade --latest     — 确认升级到最新版本
 *   /bot-upgrade --version X  — 升级到指定版本
 *   /bot-upgrade --force      — 强制升级（即使当前已是最新版）
 */
let _upgrading = false; // 升级锁

registerCommand({
  name: "bot-upgrade",
  description: "检查更新并查看升级指引",
  usage: [
    `/bot-upgrade              检查是否有新版本`,
    `/bot-upgrade --latest     确认升级到最新版本（需 upgradeMode=hot-reload）`,
    `/bot-upgrade --version X  升级到指定版本（需 upgradeMode=hot-reload）`,
    `/bot-upgrade --pkg scope/name  指定 npm 包（如 ryantest/openclaw-qqbot）`,
    `/bot-upgrade --force      强制重新安装当前版本（需 upgradeMode=hot-reload）`,
    `/bot-upgrade --local      使用本地升级脚本（跳过远端下载）`,
  ].join("\n"),
  handler: async (ctx) => {
    const url = ctx.accountConfig?.upgradeUrl || DEFAULT_UPGRADE_URL;
    const upgradeMode = ctx.accountConfig?.upgradeMode || "hot-reload";
    const args = ctx.args.trim();
    const info = await getUpdateInfo();

    const GITHUB_URL = "https://github.com/tencent-connect/openclaw-qqbot/";

    // ── doc 模式（默认）：只展示升级指引，不执行热更新 ──
    if (upgradeMode !== "hot-reload") {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate) {
        return [
          `✅ 当前已是最新版本 v${PLUGIN_VERSION}`,
          ``,
          `项目地址：[GitHub](${GITHUB_URL})`,
        ].join("\n");
      }

      return [
        `🆕 发现新版本`,
        ``,
        `当前版本：**v${PLUGIN_VERSION}**`,
        `最新版本：**v${info.latest}**`,
        ``,
        `📖 升级指引：[点击查看](${url})`,
        `🌟 官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
      ].join("\n");
    }

    // ── hot-reload 模式：执行热更新 ──

    // 升级相关指令仅在私聊中可用
    if (ctx.type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    // 升级锁：防止重复触发
    if (_upgrading) {
      return `⏳ 正在升级中，请稍候...`;
    }

    let isForce = false;
    let isLatest = false;
    let isLocal = false;
    let versionArg: string | undefined;
    let pkgArg: string | undefined;
    const tokens = args ? args.split(/\s+/).filter(Boolean) : [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (t === "--force") {
        isForce = true;
        continue;
      }
      if (t === "--latest") {
        isLatest = true;
        continue;
      }
      if (t === "--local") {
        isLocal = true;
        continue;
      }
      if (t === "--pkg") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("--")) {
          return `❌ 参数错误：--pkg 需要包名\n\n示例：/bot-upgrade --pkg ryantest/openclaw-qqbot`;
        }
        pkgArg = next;
        i += 1;
        continue;
      }
      if (t.startsWith("--pkg=")) {
        const v = t.slice("--pkg=".length).trim();
        if (!v) {
          return `❌ 参数错误：--pkg 需要包名\n\n示例：/bot-upgrade --pkg ryantest/openclaw-qqbot`;
        }
        pkgArg = v;
        continue;
      }
      if (t === "--version") {
        const next = tokens[i + 1];
        if (!next || next.startsWith("--")) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.5`;
        }
        versionArg = next.replace(/^v/, "");
        i += 1;
        continue;
      }
      if (t.startsWith("--version=")) {
        const v = t.slice("--version=".length).trim();
        if (!v) {
          return `❌ 参数错误：--version 需要版本号\n\n示例：/bot-upgrade --version 1.6.5`;
        }
        versionArg = v.replace(/^v/, "");
        continue;
      }
      if (!t.startsWith("--") && !versionArg) {
        versionArg = t.replace(/^v/, "");
        continue;
      }
    }

    // ── 无参数（也没有 --latest / --version / --force）：只展示信息+确认按钮 ──
    if (!versionArg && !isLatest && !isForce) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate) {
        const lines = [
          `✅ 当前已是最新版本 v${PLUGIN_VERSION}`,
          ``,
          `项目地址：[GitHub](${GITHUB_URL})`,
        ];
        return lines.join("\n");
      }

      // 有新版本：展示信息 + 确认按钮
      return [
        `🆕 发现新版本`,
        ``,
        `当前版本：**v${PLUGIN_VERSION}**`,
        `最新版本：**v${info.latest}**`,
        ``,
        `升级将重启 Gateway 服务，期间短暂不可用。`,
        `请确认主机网络可正常访问 npm 仓库。`,
        ``,
        `**点击确认升级** <qqbot-cmd-enter text="/bot-upgrade --latest" />`,
        ``,
        `手动升级指引：[点击查看](${url})`,
        `🌟官方 GitHub 仓库：[点击前往](${GITHUB_URL})`,
      ].join("\n");
    }

    // 解析 npm 包名：--pkg 参数 > 配置项 upgradePkg > 默认
    // 支持 "scope/name"（自动补 @）和 "@scope/name" 两种格式
    let upgradePkg = pkgArg || ctx.accountConfig?.upgradePkg;
    if (upgradePkg) {
      upgradePkg = upgradePkg.trim();
      if (!upgradePkg.startsWith("@")) upgradePkg = `@${upgradePkg}`;
    }

    // ── --version 指定版本：先校验版本号是否存在 ──
    if (versionArg) {
      const exists = await checkVersionExists(versionArg, upgradePkg);
      if (!exists) {
        return `❌ 版本 ${versionArg} 不存在，请检查版本号`;
      }

      // 检查是否就是当前版本
      if (versionArg === PLUGIN_VERSION && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    // ── --latest：检查是否需要升级 ──
    if (isLatest && !versionArg) {
      if (info.checkedAt === 0) {
        return `⏳ 版本检查中，请稍后再试`;
      }
      if (info.error) {
        return [
          `❌ 主机网络访问异常，无法检查更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (!info.hasUpdate && !isForce) {
        return `✅ 当前已是 v${PLUGIN_VERSION}，无需升级`;
      }
    }

    const targetVersion = versionArg || info.latest || undefined;

    // --force 时如果 targetVersion 等于当前版本，属于强制重装
    const isReinstall = isForce && targetVersion === PLUGIN_VERSION;

    // ── 环境兼容性检查 ──
    const compat = checkUpgradeCompatibility();
    if (!compat.ok) {
      return [
        `🚫 当前环境不满足热更新要求：`,
        ``,
        ...compat.errors,
        ...(compat.warnings.length ? [``, ...compat.warnings] : []),
        ``,
        `查看手动升级指引：[点击查看](${url})`,
      ].join("\n");
    }

    // 加锁
    _upgrading = true;

    // 热更新前保存凭证快照，防止更新过程被打断导致 appId/secret 丢失
    preUpgradeCredentialBackup(ctx.accountId, ctx.appId);

    // 异步执行升级
    const startResult = await fireHotUpgrade(targetVersion, upgradePkg, isLocal);
    if (!startResult.ok) {
      _upgrading = false;
      if (startResult.reason === "no-script") {
        return [
          `❌ 未找到升级脚本，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (startResult.reason === "no-cli") {
        return [
          `❌ 未找到 CLI 工具，无法执行热更新`,
          ``,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      if (startResult.reason === "no-powershell") {
        return [
          `❌ 未找到 PowerShell，无法执行热更新`,
          ``,
          `请确认系统中已安装 PowerShell（Windows 10+ 自带）`,
          `查看手动升级指引：[点击查看](${url})`,
        ].join("\n");
      }
      return [
        `❌ 当前环境不支持热更新（需要 bash）`,
        ``,
        `查看手动升级指引：[点击查看](${url})`,
      ].join("\n");
    }

    saveUpgradeGreetingTarget(ctx.accountId, ctx.appId, ctx.senderId);

    // 展示需要手动执行的命令
    const commands = startResult.commands || [];
    const cmdLines = commands.map((cmd, i) => `  ${i + 1}. ${cmd}`).join("\n");

    const resultLines = isReinstall
      ? [
        `🔄 重新安装准备完成`,
        ``,
        `当前版本：v${PLUGIN_VERSION}`,
        ``,
        `请在服务器终端依次执行以下命令：`,
        "```bash",
        cmdLines,
        "```",
        ``,
        `执行完成后，网关将自动重启并加载新版本。`,
      ]
      : [
        `🔄 升级准备完成`,
        ``,
        `当前版本：v${PLUGIN_VERSION}`,
        ...(targetVersion ? [`目标版本：v${targetVersion}`] : []),
        ``,
        `请在服务器终端依次执行以下命令：`,
        "```bash",
        cmdLines,
        "```",
        ``,
        `执行完成后，网关将自动重启并加载新版本。`,
      ];

    // 立即释放升级锁（因为不再自动执行）
    _upgrading = false;

    return resultLines.join("\n");
  },
});

/**
 * 从 openclaw.json / clawdbot.json / moltbot.json 的 logging.file 配置中
 * 提取用户自定义的日志文件路径（直接文件路径，非目录）。
 */
function getConfiguredLogFiles(): string[] {
  const homeDir = getHomeDir();
  const files: string[] = [];
  for (const cli of ["openclaw", "clawdbot", "moltbot"]) {
    try {
      const cfgPath = path.join(homeDir, `.${cli}`, `${cli}.json`);
      if (!fs.existsSync(cfgPath)) continue;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const logFile = cfg?.logging?.file;
      if (logFile && typeof logFile === "string") {
        files.push(path.resolve(logFile));
      }
      break;
    } catch {
      // ignore
    }
  }
  return files;
}

/**
 * /bot-logs — 导出本地日志文件
 *
 * 日志定位策略（兼容腾讯云/各云厂商不同安装路径）：
 * 0. 优先从 openclaw.json 的 logging.file 配置中读取自定义日志路径（最精确）
 * 1. 使用 *_STATE_DIR 环境变量（OPENCLAW/CLAWDBOT/MOLTBOT）
 * 2. 扫描常见状态目录：~/.openclaw, ~/.clawdbot, ~/.moltbot 及其 logs 子目录
 * 3. 扫描 home/cwd/AppData 下名称包含 openclaw/clawdbot/moltbot 的目录
 * 4. 扫描 /var/log 下的 openclaw/clawdbot/moltbot 目录
 * 5. 在候选目录中选取最近更新的日志文件（gateway/openclaw/clawdbot/moltbot）
 */
function collectCandidateLogDirs(): string[] {
  const homeDir = getHomeDir();
  const dirs = new Set<string>();

  const pushDir = (p?: string) => {
    if (!p) return;
    const normalized = path.resolve(p);
    dirs.add(normalized);
  };

  const pushStateDir = (stateDir?: string) => {
    if (!stateDir) return;
    pushDir(stateDir);
    pushDir(path.join(stateDir, "logs"));
  };

  // 0. 从配置文件的 logging.file 提取目录
  for (const logFile of getConfiguredLogFiles()) {
    pushDir(path.dirname(logFile));
  }

  // 1. 环境变量 *_STATE_DIR
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/STATE_DIR$/i.test(key) && /(OPENCLAW|CLAWDBOT|MOLTBOT)/i.test(key)) {
      pushStateDir(value);
    }
  }

  // 2. 常见状态目录
  for (const name of [".openclaw", ".clawdbot", ".moltbot", "openclaw", "clawdbot", "moltbot"]) {
    pushDir(path.join(homeDir, name));
    pushDir(path.join(homeDir, name, "logs"));
  }

  // 3. home/cwd/AppData 下包含 openclaw/clawdbot/moltbot 的子目录
  const searchRoots = new Set<string>([
    homeDir,
    process.cwd(),
    path.dirname(process.cwd()),
  ]);
  if (process.env.APPDATA) searchRoots.add(process.env.APPDATA);
  if (process.env.LOCALAPPDATA) searchRoots.add(process.env.LOCALAPPDATA);

  for (const root of searchRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!/(openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        const base = path.join(root, entry.name);
        pushDir(base);
        pushDir(path.join(base, "logs"));
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  // 4. /var/log 下的常见日志目录（Linux 服务器部署场景）
  if (!isWindows()) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join("/var/log", name));
    }
  }

  // 5. /tmp 和系统临时目录下的日志（gateway 默认日志路径可能在 /tmp/openclaw/）
  const tmpRoots = new Set<string>();
  if (isWindows()) {
    // Windows: C:\tmp, %TEMP%, %LOCALAPPDATA%\Temp
    tmpRoots.add("C:\\tmp");
    if (process.env.TEMP) tmpRoots.add(process.env.TEMP);
    if (process.env.TMP) tmpRoots.add(process.env.TMP);
    if (process.env.LOCALAPPDATA) tmpRoots.add(path.join(process.env.LOCALAPPDATA, "Temp"));
  } else {
    tmpRoots.add("/tmp");
  }
  for (const tmpRoot of tmpRoots) {
    for (const name of ["openclaw", "clawdbot", "moltbot"]) {
      pushDir(path.join(tmpRoot, name));
    }
  }

  return Array.from(dirs);
}

type LogCandidate = {
  filePath: string;
  sourceDir: string;
  mtimeMs: number;
};

function collectRecentLogFiles(logDirs: string[]): LogCandidate[] {
  const candidates: LogCandidate[] = [];
  const dedupe = new Set<string>();

  const pushFile = (filePath: string, sourceDir: string) => {
    const normalized = path.resolve(filePath);
    if (dedupe.has(normalized)) return;
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) return;
      dedupe.add(normalized);
      candidates.push({ filePath: normalized, sourceDir, mtimeMs: stat.mtimeMs });
    } catch {
      // 文件不存在或无权限
    }
  };

  // 优先级最高：用户在 openclaw.json logging.file 中显式配置的日志文件
  for (const logFile of getConfiguredLogFiles()) {
    pushFile(logFile, path.dirname(logFile));
  }

  for (const dir of logDirs) {
    pushFile(path.join(dir, "gateway.log"), dir);
    pushFile(path.join(dir, "gateway.err.log"), dir);
    pushFile(path.join(dir, "openclaw.log"), dir);
    pushFile(path.join(dir, "clawdbot.log"), dir);
    pushFile(path.join(dir, "moltbot.log"), dir);

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!/\.(log|txt)$/i.test(entry.name)) continue;
        if (!/(gateway|openclaw|clawdbot|moltbot)/i.test(entry.name)) continue;
        pushFile(path.join(dir, entry.name), dir);
      }
    } catch {
      // 无权限或不存在，跳过
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

registerCommand({
  name: "bot-logs",
  description: "导出本地日志文件",
  usage: [
    `/bot-logs`,
    ``,
    `导出最近的 OpenClaw 日志文件（最多 4 个）。`,
    `每个文件最多保留最后 1000 行，以文件形式返回。`,
  ].join("\n"),
  handler: () => {
    const logDirs = collectCandidateLogDirs();
    const recentFiles = collectRecentLogFiles(logDirs).slice(0, 4);

    if (recentFiles.length === 0) {
      const existingDirs = logDirs.filter(d => { try { return fs.existsSync(d); } catch { return false; } });
      const searched = existingDirs.length > 0
        ? existingDirs.map(d => `  • ${d}`).join("\n")
        : logDirs.slice(0, 6).map(d => `  • ${d}`).join("\n") + (logDirs.length > 6 ? `\n  …及其他 ${logDirs.length - 6} 个路径` : "");
      return [
        `⚠️ 未找到日志文件`,
        ``,
        `已搜索以下${existingDirs.length > 0 ? "已存在的" : ""}路径：`,
        searched,
        ``,
        `💡 如果日志在自定义路径，请在配置文件中添加：`,
        `  "logging": { "file": "/path/to/your/logfile.log" }`,
      ].join("\n");
    }

    const lines: string[] = [];
    let totalIncluded = 0;
    let totalOriginal = 0;
    let truncatedCount = 0;
    const MAX_LINES_PER_FILE = 1000;
    for (const logFile of recentFiles) {
      try {
        const content = fs.readFileSync(logFile.filePath, "utf8");
        const allLines = content.split("\n");
        const totalFileLines = allLines.length;
        const tail = allLines.slice(-MAX_LINES_PER_FILE);
        if (tail.length > 0) {
          const fileName = path.basename(logFile.filePath);
          lines.push(`\n========== ${fileName} (last ${tail.length} of ${totalFileLines} lines) ==========`);
          lines.push(`from: ${logFile.sourceDir}`);
          lines.push(...tail);
          totalIncluded += tail.length;
          totalOriginal += totalFileLines;
          if (totalFileLines > MAX_LINES_PER_FILE) truncatedCount++;
        }
      } catch {
        lines.push(`[读取 ${path.basename(logFile.filePath)} 失败]`);
      }
    }

    if (lines.length === 0) {
      return `⚠️ 找到日志文件但读取失败，请检查文件权限`;
    }

    const tmpDir = getQQBotDataDir("downloads");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const tmpFile = path.join(tmpDir, `bot-logs-${timestamp}.txt`);
    fs.writeFileSync(tmpFile, lines.join("\n"), "utf8");

    const fileCount = recentFiles.length;
    const topSources = Array.from(new Set(recentFiles.map(item => item.sourceDir))).slice(0, 3);
    // 紧凑摘要：N 个日志文件，共 X 行（如有截断则注明）
    let summaryText = `${fileCount} 个日志文件，共 ${totalIncluded} 行`;
    if (truncatedCount > 0) {
      summaryText += `（${truncatedCount} 个文件因过长仅保留最后 ${MAX_LINES_PER_FILE} 行，原始共 ${totalOriginal} 行）`;
    }
    return {
      text: `📋 ${summaryText}\n📂 来源：${topSources.join(" | ")}`,
      filePath: tmpFile,
    };
  },
});

// ============ /bot-clear-storage ============

/**
 * 扫描指定目录下的所有文件，递归统计。
 * 返回按文件大小降序排列的文件列表。
 */
function scanDirectoryFiles(dirPath: string): { filePath: string; size: number }[] {
  const files: { filePath: string; size: number }[] = [];
  if (!fs.existsSync(dirPath)) return files;

  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          files.push({ filePath: fullPath, size: stat.size });
        } catch {
          // 跳过无法访问的文件
        }
      }
    }
  };

  walk(dirPath);
  // 按大小降序排列
  files.sort((a, b) => b.size - a.size);
  return files;
}

/** 格式化文件大小为人类可读形式 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * /bot-clear-storage — 清理通过 QQBot 对话产生的文件以及下载的资源
 *
 * 仅在私聊（c2c）中可用。
 * --force 执行时删除整个 appId 目录下的所有文件（不区分用户 openid）。
 *
 * 产品流程：
 *   /bot-clear-storage          — 扫描并列出当前 appId 下的文件，展示确认按钮
 *   /bot-clear-storage --force   — 确认执行删除
 */
registerCommand({
  name: "bot-clear-storage",
  description: "清理通过QQBot对话产生的文件以及下载的资源（保存在 OpenClaw 运行环境的主机上）",
  usage: [
    `/bot-clear-storage`,
    ``,
    `扫描当前机器人产生的下载文件并列出明细。`,
    `确认后执行删除，释放主机磁盘空间。`,
    ``,
    `/bot-clear-storage --force   确认执行清理`,
    ``,
    `⚠️ 仅在私聊中可用。`,
  ].join("\n"),
  handler: (ctx) => {
    const { appId, type } = ctx;

    // 仅私聊可用
    if (type !== "c2c") {
      return `💡 请在私聊中使用此指令`;
    }

    const isForce = ctx.args.trim() === "--force";

    // 删除粒度为 appId 目录（不区分用户 openid）
    // 路径: downloads/{appId}/
    const targetDir = path.join(getHomeDir(), ".openclaw", "media", "qqbot", "downloads", appId);
    const displayDir = `~/.openclaw/media/qqbot/downloads/${appId}`;

    if (!isForce) {
      // ── 第一步：扫描并展示文件列表 ──
      const files = scanDirectoryFiles(targetDir);

      if (files.length === 0) {
        return [
          `✅ 当前没有需要清理的文件`,
          ``,
          `目录 \`${displayDir}\` 为空或不存在。`,
        ].join("\n");
      }

      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const MAX_DISPLAY = 10;

      const lines: string[] = [
        `即将清理 \`${displayDir}\` 目录下所有文件，总共 ${files.length} 个文件，占用磁盘存储空间 ${formatBytes(totalSize)}。`,
        ``,
        `目录文件概况：`,
      ];

      // 展示前 MAX_DISPLAY 个（按大小降序）
      const displayFiles = files.slice(0, MAX_DISPLAY);
      for (const f of displayFiles) {
        const relativePath = path.relative(targetDir, f.filePath);
        // 在 Windows 上统一用 / 分隔显示
        const displayName = relativePath.replace(/\\/g, "/");
        lines.push(`${displayName} (${formatBytes(f.size)})`, ``, ``);
      }
      if (files.length > MAX_DISPLAY) {
        lines.push(`...[合计：${files.length} 个文件（${formatBytes(totalSize)}）]`, ``);
      }

      lines.push(
        ``,
        `---`,
        ``,
        `确认清理后，上述保存在 OpenClaw 运行主机磁盘上的文件将永久删除，后续对话过程中AI无法再找回相关文件。`,
        `‼️ 点击指令确认删除`,
        `<qqbot-cmd-enter text="/bot-clear-storage --force" />`,
      );

      return lines.join("\n");
    }

    // ── 第二步：--force 执行删除 ──
    const files = scanDirectoryFiles(targetDir);

    if (files.length === 0) {
      return `✅ 目录已为空，无需清理`;
    }

    let deletedCount = 0;
    let deletedSize = 0;
    let failedCount = 0;

    for (const f of files) {
      try {
        fs.unlinkSync(f.filePath);
        deletedCount++;
        deletedSize += f.size;
      } catch {
        failedCount++;
      }
    }

    // 尝试清理空目录（递归删除空子目录）
    try {
      removeEmptyDirs(targetDir);
    } catch {
      // 非关键，静默忽略
    }

    if (failedCount === 0) {
      return [
        `✅ 清理成功`,
        ``,
        `已删除 ${deletedCount} 个文件，释放 ${formatBytes(deletedSize)} 磁盘空间。`,
      ].join("\n");
    }

    return [
      `⚠️ 部分清理完成`,
      ``,
      `已删除 ${deletedCount} 个文件（${formatBytes(deletedSize)}），${failedCount} 个文件删除失败。`,
    ].join("\n");
  },
});

/** 递归删除空目录（从叶子向上清理） */
function removeEmptyDirs(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dirPath, entry.name));
    }
  }
  // 重新读取，如果目录已空则删除
  try {
    const remaining = fs.readdirSync(dirPath);
    if (remaining.length === 0) {
      fs.rmdirSync(dirPath);
    }
  } catch {
    // 目录可能正在被使用，跳过
  }
}

// ============ /bot-streaming ============

/**
 * /bot-streaming on|off — 一键开关流式消息
 *
 * 直接修改当前账户的 streaming 配置项并持久化到 openclaw.json。
 * 修改后即时生效（下一条消息起按新配置处理）。
 */
registerCommand({
  name: "bot-streaming",
  description: "一键开关流式消息",
  usage: [
    `/bot-streaming on     开启流式消息`,
    `/bot-streaming off    关闭流式消息`,
    `/bot-streaming        查看当前流式消息状态`,
    ``,
    `开启后，AI 的回复会以流式形式逐步显示（打字机效果）。`,
    `注意：仅 C2C（私聊）支持流式消息。`,
  ].join("\n"),
  handler: async (ctx) => {
    // 流式消息仅支持 C2C（私聊），群/频道场景直接提示
    if (ctx.type !== "c2c") {
      return `❌ 流式消息仅支持私聊场景，请在私聊中使用 /bot-streaming 指令`;
    }

    const arg = ctx.args.trim().toLowerCase();

    // 读取当前 streaming 状态
    const currentStreaming = ctx.accountConfig?.streaming === true;

    // 无参数：查看当前状态
    if (!arg) {
      return [
        `📡 流式消息状态：${currentStreaming ? "✅ 已开启" : "❌ 已关闭"}`,
        ``,
        `使用 <qqbot-cmd-input text="/bot-streaming on" show="/bot-streaming on"/> 开启`,
        `使用 <qqbot-cmd-input text="/bot-streaming off" show="/bot-streaming off"/> 关闭`,
      ].join("\n");
    }

    if (arg !== "on" && arg !== "off") {
      return `❌ 参数错误，请使用 on 或 off\n\n示例：/bot-streaming on`;
    }

    const newStreaming = arg === "on";

    // 如果状态没变，直接返回
    if (newStreaming === currentStreaming) {
      return `📡 流式消息已经是${newStreaming ? "开启" : "关闭"}状态，无需操作`;
    }

    // 更新配置（参考 handleInteractionCreate 中的配置更新逻辑）
    try {
      const runtime = getQQBotRuntime();
      const configApi = runtime.config as {
        loadConfig: () => Record<string, unknown>;
        writeConfigFile: (cfg: unknown) => Promise<void>;
      };

      const currentCfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
      const qqbot = ((currentCfg.channels ?? {}) as Record<string, unknown>).qqbot as Record<string, unknown> | undefined;

      if (!qqbot) {
        return `❌ 配置文件中未找到 qqbot 通道配置`;
      }

      const accountId = ctx.accountId;
      const isNamedAccount = accountId !== "default" && (qqbot.accounts as Record<string, Record<string, unknown>> | undefined)?.[accountId];

      if (isNamedAccount) {
        // 命名账户：更新 accounts.{accountId}.streaming
        const accounts = qqbot.accounts as Record<string, Record<string, unknown>>;
        const acct = accounts[accountId] ?? {};
        acct.streaming = newStreaming;
        accounts[accountId] = acct;
        qqbot.accounts = accounts;
      } else {
        // 默认账户：更新 qqbot.streaming
        qqbot.streaming = newStreaming;
      }

      await configApi.writeConfigFile(currentCfg);

      return [
        `✅ 流式消息已${newStreaming ? "开启" : "关闭"}`,
        ``,
        newStreaming
          ? `AI 的回复将以流式形式逐步显示（仅私聊生效）。`
          : `AI 的回复将恢复为完整发送。`,
      ].join("\n");
    } catch (err) {
      const fwVer = getFrameworkVersion();
      return [
        `❌ 当前版本不支持该指令`,
        ``,
        `🦞框架版本：${fwVer}`,
        `🤖QQBot 插件版本：v${PLUGIN_VERSION}`,
        ``,
        `可通过以下命令手动开启流式消息：`,
        ``,
        `\`\`\`shell`,
        `# 1. 开启流式消息`,
        `openclaw config set channels.qqbot.streaming true`,
        ``,
        `# 2. 重启网关使配置生效`,
        `openclaw gateway restart`,
        `\`\`\``,
      ].join("\n");
    }
  },
});

// ============ /bot-approve 审批配置管理 ============

/**
 * /bot-approve — 管理命令执行审批配置
 *
 * 修改 openclaw.json 中 tools.exec.security / tools.exec.ask 字段。
 *
 * security: deny | allowlist | full
 * ask: off | on-miss | always
 */
registerCommand({
  name: "bot-approve",
  description: "管理命令执行审批配置",
  usage: [
    `/bot-approve            查看操作指引`,
    `/bot-approve on         开启审批（白名单模式，推荐）`,
    `/bot-approve off        关闭审批，命令直接执行`,
    `/bot-approve always     始终审批，每次执行都需审批`,
    `/bot-approve reset      恢复框架默认值`,
    `/bot-approve status     查看当前审批配置`,
  ].join("\n"),
  handler: async (ctx) => {
    const arg = ctx.args.trim().toLowerCase();

    // 审批功能需要 openclaw >= 3.22（gateway-runtime 模块）
    if (!isApprovalFeatureAvailable()) {
      return `❌ 当前 OpenClaw 版本不支持审批功能，请升级至最新版本后重试。`;
    }

    let runtime;
    try {
      runtime = getQQBotRuntime();
    } catch {
      // runtime 不可用，构造 prompt 委托给 AI 模型通过 CLI 完成
      const presetMap: Record<string, { security: string; ask: string; desc: string }> = {
        on: { security: "allowlist", ask: "on-miss", desc: "开启审批（白名单模式）" },
        off: { security: "full", ask: "off", desc: "关闭审批" },
        always: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
        strict: { security: "allowlist", ask: "always", desc: "严格模式（每次都审批）" },
      };
      const preset = presetMap[arg];
      if (preset) {
        return {
          delegatePrompt: [
            `请帮我${preset.desc}。执行以下单条命令（不要拆开）：`,
            `openclaw config set tools.exec.security ${preset.security} && openclaw config set tools.exec.ask ${preset.ask}`,
            `执行完成后告诉用户审批配置已更新为 security=${preset.security}, ask=${preset.ask}。`,
          ].join("\n"),
        };
      }
      if (arg === "reset") {
        return {
          delegatePrompt: [
            `请帮我重置审批配置。执行以下单条命令（不要拆开）：`,
            `openclaw config unset tools.exec.security && openclaw config unset tools.exec.ask`,
            `执行完成后告诉用户审批配置已重置为框架默认值。`,
          ].join("\n"),
        };
      }
      if (arg === "status") {
        return {
          delegatePrompt: [
            `请帮我查看当前命令执行审批配置。执行以下单条命令（不要拆开）：`,
            `echo "security=$(openclaw config get tools.exec.security)" && echo "ask=$(openclaw config get tools.exec.ask)"`,
            `然后告诉用户当前 security 和 ask 的值，以及可用的操作选项：`,
            `- /bot-approve on    开启审批（白名单模式）`,
            `- /bot-approve off   关闭审批`,
            `- /bot-approve always 严格模式`,
            `- /bot-approve reset 恢复默认`,
          ].join("\n"),
        };
      }
      // 无参数或未知参数：直接返回操作指引
      return [
        `🔐 命令执行审批配置`,
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
      ].join("\n");
    }
    const configApi = runtime.config as {
      loadConfig: () => Record<string, unknown>;
      writeConfigFile: (cfg: unknown) => Promise<void>;
    };

    const loadExecConfig = () => {
      const cfg = configApi.loadConfig() as Record<string, unknown>;
      const tools = (cfg.tools ?? {}) as Record<string, unknown>;
      const exec = (tools.exec ?? {}) as Record<string, unknown>;
      return {
        security: String(exec.security ?? "deny"),
        ask: String(exec.ask ?? "on-miss"),
      };
    };

    const writeExecConfig = async (security: string, ask: string) => {
      const cfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
      const tools = ((cfg.tools ?? {}) as Record<string, unknown>);
      const exec = ((tools.exec ?? {}) as Record<string, unknown>);
      exec.security = security;
      exec.ask = ask;
      tools.exec = exec;
      cfg.tools = tools;
      await configApi.writeConfigFile(cfg);
    };

    const formatStatus = (security: string, ask: string) => {
      const secIcon = security === "full" ? "🟢" : security === "allowlist" ? "🟡" : "🔴";
      const askIcon = ask === "off" ? "🟢" : ask === "always" ? "🔴" : "🟡";
      return [
        `🔐 当前审批配置`,
        ``,
        `${secIcon} 安全模式 (security): **${security}**`,
        `${askIcon} 审批模式 (ask): **${ask}**`,
        ``,
        security === "deny" ? `⚠️ 当前为 deny 模式，所有命令执行被拒绝` :
        security === "full" && ask === "off" ? `✅ 所有命令无需审批直接执行` :
        security === "allowlist" && ask === "on-miss" ? `🛡️ 白名单命令直接执行，其余需审批` :
        ask === "always" ? `🔒 每次命令执行都需要人工审批` :
        `ℹ️ security=${security}, ask=${ask}`,
      ].join("\n");
    };

    // 无参数：操作指引
    if (!arg) {
      return [
        `🔐 命令执行审批配置`,
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批（白名单模式）`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
        `<qqbot-cmd-input text="/bot-approve status" show="/bot-approve status"/> 查看当前配置`,
      ].join("\n");
    }

    // status: 查看当前配置
    if (arg === "status") {
      const { security, ask } = loadExecConfig();
      return [
        formatStatus(security, ask),
        ``,
        `<qqbot-cmd-input text="/bot-approve on" show="/bot-approve on"/> 开启审批`,
        `<qqbot-cmd-input text="/bot-approve off" show="/bot-approve off"/> 关闭审批`,
        `<qqbot-cmd-input text="/bot-approve always" show="/bot-approve always"/> 严格模式`,
        `<qqbot-cmd-input text="/bot-approve reset" show="/bot-approve reset"/> 恢复默认`,
      ].join("\n");
    }

    // on: 开启审批（白名单 + 未命中审批）
    if (arg === "on") {
      try {
        await writeExecConfig("allowlist", "on-miss");
        return [
          `✅ 审批已开启`,
          ``,
          `• security = allowlist（白名单模式）`,
          `• ask = on-miss（未命中白名单时需审批）`,
          ``,
          `已批准的命令自动加入白名单，下次直接执行。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // off: 关闭审批
    if (arg === "off") {
      try {
        await writeExecConfig("full", "off");
        return [
          `✅ 审批已关闭`,
          ``,
          `• security = full（允许所有命令）`,
          `• ask = off（不需要审批）`,
          ``,
          `⚠️ 所有命令将直接执行，不会弹出审批确认。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // always: 始终审批（每次都审批）
    if (arg === "always") {
      try {
        await writeExecConfig("allowlist", "always");
        return [
          `✅ 已切换为严格审批模式`,
          ``,
          `• security = allowlist`,
          `• ask = always（每次执行都需审批）`,
          ``,
          `每个命令都会弹出审批按钮，需手动确认。`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    // reset: 删除配置，恢复框架默认值
    if (arg === "reset") {
      try {
        const cfg = structuredClone(configApi.loadConfig()) as Record<string, unknown>;
        const tools = (cfg.tools ?? {}) as Record<string, unknown>;
        const exec = (tools.exec ?? {}) as Record<string, unknown>;
        delete exec.security;
        delete exec.ask;
        if (Object.keys(exec).length === 0) {
          delete tools.exec;
        } else {
          tools.exec = exec;
        }
        if (Object.keys(tools).length === 0) {
          delete cfg.tools;
        } else {
          cfg.tools = tools;
        }
        await configApi.writeConfigFile(cfg);
        return [
          `✅ 审批配置已重置`,
          ``,
          `已移除 tools.exec.security 和 tools.exec.ask`,
          `框架将使用默认值（security=deny, ask=on-miss）`,
          ``,
          `如需开启命令执行，请使用 /bot-approve on`,
        ].join("\n");
      } catch (err) {
        return `❌ 配置更新失败: ${err}`;
      }
    }

    return [
      `❌ 未知参数: ${arg}`,
      ``,
      `可用选项: on | off | always | reset`,
      `输入 /bot-approve ? 查看详细用法`,
    ].join("\n");
  },
});

// ============ 匹配入口 ============

/**
 * 尝试匹配并执行插件级斜杠指令
 *
 * @returns 回复文本（匹配成功），null（不匹配，应入队正常处理）
 */
export async function matchSlashCommand(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const content = ctx.rawContent.trim();
  if (!content.startsWith("/")) return null;

  // 解析指令名和参数
  const spaceIdx = content.indexOf(" ");
  const cmdName = (spaceIdx === -1 ? content.slice(1) : content.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

  const cmd = commands.get(cmdName);
  if (!cmd) return null; // 不是插件级指令，交给框架

  // /指令 ? — 返回用法说明
  if (args === "?") {
    if (cmd.usage) {
      return `📖 /${cmd.name} 用法：\n\n${cmd.usage}`;
    }
    return `/${cmd.name} — ${cmd.description}`;
  }

  ctx.args = args;
  const result = await cmd.handler(ctx);
  return result;
}

/** 获取插件版本号（供外部使用） */
export function getPluginVersion(): string {
  return PLUGIN_VERSION;
}
