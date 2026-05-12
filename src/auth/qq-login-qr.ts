import { randomUUID } from "node:crypto";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { QQBotQrLoginConfig } from "../config.js";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

type ActiveLogin = {
  sessionKey: string;
  id: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  botToken?: string;
  status?: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  error?: string;
  currentApiBaseUrl?: string;
  botType: string;
};

const activeLogins = new Map<string, ActiveLogin>();

interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export function resolveQQBotQrLoginFromConfig(
  cfg: OpenClawConfig,
): (QQBotQrLoginConfig & { baseUrl: string; writeToAccountKey: string }) | null {
  const qq = cfg.channels?.qqbot as { qrLogin?: QQBotQrLoginConfig } | undefined;
  const q = qq?.qrLogin;
  if (!q?.botType?.trim()) {
    return null;
  }
  const baseRaw = q.baseUrl?.trim() || "https://ilinkai.weixin.qq.com";
  const baseUrl = baseRaw.replace(/\/+$/, "");
  return {
    ...q,
    botType: q.botType.trim(),
    baseUrl,
    writeToAccountKey: q.writeToAccountKey?.trim() || "default",
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

function normalizeIlinkBaseUrl(raw: string | undefined): string | undefined {
  const t = raw?.trim();
  if (!t) return undefined;
  if (t.startsWith("http://") || t.startsWith("https://")) {
    return t.replace(/\/+$/, "");
  }
  return `https://${t.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function pickConfirmedLoginBaseUrl(
  status: StatusResponse,
  login: ActiveLogin,
  fallbackBase: string,
): string {
  const fromServer = normalizeIlinkBaseUrl(status.baseurl);
  if (fromServer) return fromServer;
  return (login.currentApiBaseUrl ?? fallbackBase).replace(/\/+$/, "");
}

async function apiGetFetch(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs?: number;
  label: string;
}): Promise<string> {
  const url = `${params.baseUrl.replace(/\/+$/, "")}/${params.endpoint.replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timer =
    params.timeoutMs != null
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`${params.label}: HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchQRCode(apiBaseUrl: string, botType: string): Promise<QRCodeResponse> {
  const rawText = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: "qqbot.fetchQRCode",
  });
  return JSON.parse(rawText) as QRCodeResponse;
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<StatusResponse> {
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "qqbot.pollQRStatus",
    });
    return JSON.parse(rawText) as StatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    return { status: "wait" };
  }
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
  ilinkBotId?: string;
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
        "未配置 QQ Bot 扫码登录：请在 openclaw.json 的 channels.qqbot.qrLogin 中设置 botType（ilink get_bot_qrcode 参数）。",
      sessionKey,
    };
  }

  purgeExpiredLogins();

  const existing = activeLogins.get(sessionKey);
  if (
    !params.force &&
    existing &&
    isLoginFresh(existing) &&
    existing.qrcodeUrl &&
    existing.botType === qrCfg.botType
  ) {
    return {
      qrDataUrl: existing.qrcodeUrl,
      message: "二维码已就绪，请扫描完成登录。",
      sessionKey,
    };
  }

  try {
    const initialBase = qrCfg.baseUrl;
    const qrResponse = await fetchQRCode(initialBase, qrCfg.botType);
    const login: ActiveLogin = {
      sessionKey,
      id: randomUUID(),
      qrcode: qrResponse.qrcode,
      qrcodeUrl: qrResponse.qrcode_img_content,
      startedAt: Date.now(),
      botType: qrCfg.botType,
      currentApiBaseUrl: initialBase,
    };
    activeLogins.set(sessionKey, login);

    return {
      qrDataUrl: qrResponse.qrcode_img_content,
      message: "请使用移动端扫描以下二维码，完成 QQ Bot（ilink）绑定。",
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
  let activeLogin = activeLogins.get(params.sessionKey);

  if (!qrCfg) {
    return { connected: false, message: "未配置 channels.qqbot.qrLogin，无法等待扫码。" };
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
  let scannedPrinted = false;
  let qrRefreshCount = 1;

  activeLogin.currentApiBaseUrl = qrCfg.baseUrl;

  while (Date.now() < deadline) {
    try {
      const currentBaseUrl = activeLogin.currentApiBaseUrl ?? qrCfg.baseUrl;
      const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode);
      activeLogin.status = statusResponse.status;

      switch (statusResponse.status) {
        case "wait":
          if (params.verbose) {
            process.stdout.write(".");
          }
          break;
        case "scaned":
          if (!scannedPrinted) {
            process.stdout.write("\n已扫码，请在手机上确认…\n");
            scannedPrinted = true;
          }
          break;
        case "expired": {
          qrRefreshCount++;
          if (qrRefreshCount > MAX_QR_REFRESH_COUNT) {
            activeLogins.delete(params.sessionKey);
            return {
              connected: false,
              message: "登录超时：二维码多次过期，请重新开始。",
            };
          }
          try {
            const qrResponse = await fetchQRCode(qrCfg.baseUrl, activeLogin.botType);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content;
            activeLogin.startedAt = Date.now();
            scannedPrinted = false;
          } catch (refreshErr) {
            activeLogins.delete(params.sessionKey);
            return {
              connected: false,
              message: `刷新二维码失败：${String(refreshErr)}`,
            };
          }
          break;
        }
        case "scaned_but_redirect": {
          const redirectHost = statusResponse.redirect_host;
          if (redirectHost) {
            activeLogin.currentApiBaseUrl = `https://${redirectHost}`;
          }
          break;
        }
        case "confirmed": {
          if (!statusResponse.ilink_bot_id) {
            activeLogins.delete(params.sessionKey);
            return {
              connected: false,
              message: "登录失败：服务器未返回 ilink_bot_id（将作为 appId 写入配置）。",
            };
          }

          activeLogin.botToken = statusResponse.bot_token;
          activeLogins.delete(params.sessionKey);

          return {
            connected: true,
            botToken: statusResponse.bot_token,
            ilinkBotId: statusResponse.ilink_bot_id,
            baseUrl: pickConfirmedLoginBaseUrl(statusResponse, activeLogin, qrCfg.baseUrl),
            message: "QQ Bot 扫码登录成功",
          };
        }
      }
    } catch (err) {
      activeLogins.delete(params.sessionKey);
      return {
        connected: false,
        message: `登录失败：${String(err)}`,
      };
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  activeLogins.delete(params.sessionKey);
  return { connected: false, message: "登录超时，请重试。" };
}
