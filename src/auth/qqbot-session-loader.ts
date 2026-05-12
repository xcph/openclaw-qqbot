/**
 * `@tencent-connect/qqbot-connector` 的 `exports` 仅暴露根入口，
 * 无法 `import ".../qqbot-session.js"`。通过 `require.resolve` 主入口得到目录，
 * 再加载同级的 `qqbot-session.js`（勿解析未导出的 `package.json`）。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
/** 勿 resolve `package.json`（未列入 exports）；主入口与 qqbot-session 同目录（esm 或 cjs）。 */
const connectorMain = require.resolve("@tencent-connect/qqbot-connector");
const connectorDir = dirname(connectorMain);
const sessionHref = pathToFileURL(join(connectorDir, "qqbot-session.js")).href;

export type QQBotSessionModule = {
  BindStatus: {
    NONE: number;
    PENDING: number;
    COMPLETED: number;
    EXPIRED: number;
  };
  buildConnectUrl: (taskId: string, source?: string) => string;
  createBindTask: (
    env?: "production" | "test",
    timeoutMs?: number,
  ) => Promise<{ taskId: string; key: string }>;
  decryptSecret: (encryptedBase64: string, keyBase64: string) => string;
  pollBindResult: (
    taskId: string,
    env?: "production" | "test",
    timeoutMs?: number,
  ) => Promise<{
    status: number;
    botAppId: string;
    botEncryptSecret: string;
  }>;
};

export const qqbotSessionPromise: Promise<QQBotSessionModule> = import(sessionHref);
