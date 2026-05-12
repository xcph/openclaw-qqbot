import { randomUUID } from "node:crypto";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { QQBotQrLoginConfig } from "../config.js";
import { qqbotSessionPromise, type QQBotSessionModule } from "./qqbot-session-loader.js";

type QQBotEnv = "production" | "test";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
/** 与 `@tencent-connect/qqbot-connector` 内轮询节奏对齐 */
const POLL_INTERVAL_MS = 2_000;

/**
 * 解析后的扫码配置（与官方 CLI finalize 中 `qrConnect({ source: "openclaw" })` 同源，
 * 使用 q.qq.com create_bind_task / poll_bind_result）。
 */
type QQQrResolved = {
  writeToAccountKey: string;
  connectorSource: string;
  qqBotEnv: QQBotEnv;
};

type ActiveLogin = {
  sessionKey: string;
  id: string;
  taskId: string;
  bindKey: string;
  /** Tencent buildConnectUrl — Flutter `qrDataUrl`（链接页或图链） */
  connectUrl: string;
  startedAt: number;
  qqBotEnv: QQBotEnv;
  connectorSource: string;
};

const activeLogins = new Map<string, ActiveLogin>();

export function resolveQQBotQrLoginFromConfig(cfg: OpenClawConfig): QQQrResolved | null {
  const qq = cfg.channels?.qqbot as { qrLogin?: QQBotQrLoginConfig } | undefined;
  if (!qq) {
    return null;
  }
  const q = qq.qrLogin ?? {};
  const envRaw = q.qqBotEnv;
  const qqBotEnv: QQBotEnv =
    envRaw === "test" || envRaw === "production" ? envRaw : "production";

  return {
    writeToAccountKey: q.writeToAccountKey?.trim() || "default",
    connectorSource: q.connectorSource?.trim() || "openclaw",
    qqBotEnv,
  };
}

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [id, login] of activeLogins) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(id);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function session(): Promise<QQBotSessionModule> {
  return qqbotSessionPromise;
}

export type QQBotQrStartResult = {
  qrDataUrl?: string;
  message: string;
  sessionKey: string;
  connected?: boolean;
};

export type QQBotQrWaitResult = {
  connected: boolean;
  botToken?: string;
  /** QQ 开放平台扫码绑定返回的机器人 AppID（与 poll_bind_result 一致）。 */
  botAppId?: string;
  baseUrl?: string;
  message: string;
};

export async function startQQBotLoginWithQr(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  force?: boolean;
  verbose?: boolean;
}): Promise<QQBotQrStartResult> {
  const qrCfg = resolveQQBotQrLoginFromConfig(params.cfg);
  const sessionKey = params.accountId || randomUUID();

  if (!qrCfg) {
    return {
      message:
        "未配置 channels.qqbot：无法使用网关扫码。请在 openclaw.json 中加入 qqbot 渠道配置（可选 channels.qqbot.qrLogin 覆盖 connectorSource / qqBotEnv）。",
      sessionKey,
    };
  }

  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (
    !params.force &&
    existing &&
    isLoginFresh(existing) &&
    existing.connectUrl &&
    existing.qqBotEnv === qrCfg.qqBotEnv &&
    existing.connectorSource === qrCfg.connectorSource
  ) {
    return {
      qrDataUrl: existing.connectUrl,
      message: "二维码已就绪，请扫描完成登录。",
      sessionKey,
    };
  }

  try {
    const s = await session();
    const { taskId, key } = await s.createBindTask(qrCfg.qqBotEnv);
    const connectUrl = s.buildConnectUrl(taskId, qrCfg.connectorSource);

    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      taskId,
      bindKey: key,
      connectUrl,
      startedAt: Date.now(),
      qqBotEnv: qrCfg.qqBotEnv,
      connectorSource: qrCfg.connectorSource,
    };
    activeLogins.set(sessionKey, login);

    return {
      qrDataUrl: connectUrl,
      message:
        "请使用移动端 QQ 扫描以下二维码完成绑定（与官方 `openclaw channels add` 扫码同源：q.qq.com bind-task）。",
      sessionKey,
    };
  } catch (err) {
    return {
      message: `发起扫码登录失败：${String(err)}`,
      sessionKey,
    };
  }
}

export async function waitForQQBotLogin(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  timeoutMs?: number;
  verbose?: boolean;
}): Promise<QQBotQrWaitResult> {
  const qrCfg = resolveQQBotQrLoginFromConfig(params.cfg);
  const activeLogin = activeLogins.get(params.sessionKey);

  if (!qrCfg) {
    return { connected: false, message: "未配置 channels.qqbot，无法等待扫码。" };
  }

  if (!activeLogin) {
    return {
      connected: false,
      message: "当前没有进行中的登录，请先发起 qqbot-web.login.start。",
    };
  }

  if (!isLoginFresh(activeLogin)) {
    activeLogins.delete(params.sessionKey);
    return { connected: false, message: "二维码已过期，请重新生成。" };
  }

  const timeoutMs = Math.max(params.timeoutMs ?? 480_000, 1000);
  const deadline = Date.now() + timeoutMs;

  const s = await session();
  const BS = s.BindStatus;

  while (Date.now() < deadline) {
    try {
      const poll = await s.pollBindResult(activeLogin.taskId, activeLogin.qqBotEnv);

      if (poll.status === BS.COMPLETED) {
        const appSecret = s.decryptSecret(poll.botEncryptSecret, activeLogin.bindKey);
        activeLogins.delete(params.sessionKey);
        return {
          connected: true,
          botToken: appSecret,
          botAppId: poll.botAppId,
          baseUrl: `https://${activeLogin.qqBotEnv === "test" ? "test.q.qq.com" : "q.qq.com"}`,
          message: "QQ Bot 扫码登录成功",
        };
      }

      if (poll.status === BS.EXPIRED) {
        activeLogins.delete(params.sessionKey);
        return {
          connected: false,
          message: "二维码已过期，请重新发起 qqbot-web.login.start（Flutter：/qq-login new）。",
        };
      }
    } catch {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  activeLogins.delete(params.sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
