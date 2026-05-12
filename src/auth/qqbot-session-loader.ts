/**
 * `@tencent-connect/qqbot-connector` 的 `exports` 仅暴露根入口，无法直接 `import` 子路径。
 * 用 `require.resolve` 定位安装目录后，**必须**加载 `dist/esm/qqbot-session.js`（见下方注释）。
 */
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
/**
 * createRequire 解析到的主入口常为 `dist/cjs/index.js`，同目录下 qqbot-session 为 **CommonJS**；
 * 连接器包声明 `"type":"module"`，对 `.js` 按 ESM 解析会触发 `exports is not defined`。
 * 始终加载 `dist/esm/qqbot-session.js`（真实 ESM）。
 */
const connectorMain = require.resolve("@tencent-connect/qqbot-connector");
let connectorDir = dirname(connectorMain);
if (basename(connectorDir) === "cjs") {
  connectorDir = join(dirname(connectorDir), "esm");
}
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
