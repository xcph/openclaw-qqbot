import { randomUUID } from "node:crypto";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import type { QQBotQrLoginConfig } from "../config.js";

const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH_COUNT = 3;

type QQQrResolved = QQBotQrLoginConfig & {
  baseUrl: string;
  writeToAccountKey: string;
  skRouteTag: string;
};

function buildIlinkFetchHeaders(skRouteTag: string): Record<string, string> {
  return {
    "iLink-App-ClientVersion": "1",
    SKRouteTag: skRouteTag,
    "User-Agent": "OpenClaw-QQBot-QR/1.0",
  };
}

function unwrapIlinkJsonRoot(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const o = parsed as Record<string, unknown>;
  const inner = o.data ?? o.result;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return o;
}

function pickNonEmptyString(root: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = root[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  return "";
}

function coerceQrDisplayUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (t.startsWith("http://") || t.startsWith("https://") || t.startsWith("data:image")) {
    return t;
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(t) && t.length >= 64) {
    return `data:image/png;base64,${t.replace(/\s+/g, "")}`;
  }
  return t;
}

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

type StatusKey = StatusResponse["status"];

function parseQrFetchBody(rawText: string): QRCodeResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error("ilink get_bot_qrcode 返回非 JSON");
  }
  const root = unwrapIlinkJsonRoot(parsed);
  const qrcode = pickNonEmptyString(root, ["qrcode", "qr_code", "qrCode", "QrCode"]);
  const imgRaw = pickNonEmptyString(root, [
    "qrcode_img_content",
    "qrcodeImgContent",
    "qrcode_url",
    "qrcodeUrl",
    "img_content",
    "image_url",
    "imageUrl",
    "qr_url",
    "url",
  ]);
  const qrcode_img_content = coerceQrDisplayUrl(imgRaw);
  return { qrcode, qrcode_img_content };
}

function normalizeIlinkStatus(raw: unknown): StatusKey {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  const allowed = new Set<StatusKey>([
    "wait",
    "scaned",
    "confirmed",
    "expired",
    "scaned_but_redirect",
  ]);
  if (allowed.has(s as StatusKey)) {
    return s as StatusKey;
  }
  return "wait";
}

function parseStatusFetchBody(rawText: string): StatusResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText) as unknown;
  } catch {
    return { status: "wait" };
  }
  const root = unwrapIlinkJsonRoot(parsed);
  const status = normalizeIlinkStatus(root.status ?? root.Status);
  const bot_token = pickNonEmptyString(root, ["bot_token", "botToken"]);
  const ilink_bot_id = pickNonEmptyString(root, ["ilink_bot_id", "ilinkBotId"]);
  const baseurl = pickNonEmptyString(root, ["baseurl", "baseUrl"]);
  const ilink_user_id = pickNonEmptyString(root, ["ilink_user_id", "ilinkUserId"]);
  const redirect_host = pickNonEmptyString(root, ["redirect_host", "redirectHost"]);
  return {
    status,
    ...(bot_token ? { bot_token } : {}),
    ...(ilink_bot_id ? { ilink_bot_id } : {}),
    ...(baseurl ? { baseurl } : {}),
    ...(ilink_user_id ? { ilink_user_id } : {}),
    ...(redirect_host ? { redirect_host } : {}),
  };
}

export function resolveQQBotQrLoginFromConfig(cfg: OpenClawConfig): QQQrResolved | null {
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
    skRouteTag: q.skRouteTag?.trim() || "1001",
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
  skRouteTag: string;
}): Promise<string> {
  const url = `${params.baseUrl.replace(/\/+$/, "")}/${params.endpoint.replace(/^\/+/, "")}`;
  const controller = new AbortController();
  const timer =
    params.timeoutMs != null
      ? setTimeout(() => controller.abort(), params.timeoutMs)
      : undefined;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: buildIlinkFetchHeaders(params.skRouteTag),
    });
    if (!res.ok) {
      throw new Error(`${params.label}: HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchQRCode(
  apiBaseUrl: string,
  botType: string,
  skRouteTag: string,
): Promise<QRCodeResponse> {
  const rawText = await apiGetFetch({
    baseUrl: apiBaseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    label: "qqbot.fetchQRCode",
    skRouteTag,
  });
  return parseQrFetchBody(rawText);
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
  skRouteTag: string,
): Promise<StatusResponse> {
  try {
    const rawText = await apiGetFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: "qqbot.pollQRStatus",
      skRouteTag,
    });
    return parseStatusFetchBody(rawText);
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
    const qrResponse = await fetchQRCode(initialBase, qrCfg.botType, qrCfg.skRouteTag);
    if (!qrResponse.qrcode) {
      return {
        message:
          "ilink 未返回二维码令牌（qrcode）。请核对 channels.qqbot.qrLogin.botType、baseUrl，必要时设置 skRouteTag。",
        sessionKey,
      };
    }
    if (!qrResponse.qrcode_img_content) {
      return {
        message:
          "ilink 未返回二维码展示链接或图片字段（如 qrcode_img_content）。请核对接入环境与 botType，或在 qrLogin 中配置 skRouteTag。",
        sessionKey,
      };
    }
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
      const statusResponse = await pollQRStatus(
        currentBaseUrl,
        activeLogin.qrcode,
        qrCfg.skRouteTag,
      );
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
            const qrResponse = await fetchQRCode(qrCfg.baseUrl, activeLogin.botType, qrCfg.skRouteTag);
            activeLogin.qrcode = qrResponse.qrcode;
            activeLogin.qrcodeUrl = qrResponse.qrcode_img_content || activeLogin.qrcodeUrl;
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
