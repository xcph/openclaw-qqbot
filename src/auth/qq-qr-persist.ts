import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { applyQQBotAccountConfig, DEFAULT_ACCOUNT_ID } from "../config.js";

import { resolveQQBotQrLoginFromConfig } from "./qq-login-qr.js";

export async function persistQQBotQrCredentials(params: {
  writeToAccountKey: string;
  appId: string;
  clientSecret: string;
}): Promise<void> {
  const { loadConfig, writeConfigFile } = await import("openclaw/plugin-sdk/config-runtime");
  const cfg = loadConfig();
  const next = applyQQBotAccountConfig(cfg, params.writeToAccountKey, {
    appId: params.appId,
    clientSecret: params.clientSecret,
  });
  await writeConfigFile(next as OpenClawConfig);
}

export function resolveQQBotQrWriteAccountKey(params: {
  cfg: OpenClawConfig;
  gatewayAccountId?: string | null;
}): string {
  const g = params.gatewayAccountId?.trim();
  if (g) return g;
  const qr = resolveQQBotQrLoginFromConfig(params.cfg);
  return qr?.writeToAccountKey ?? DEFAULT_ACCOUNT_ID;
}
