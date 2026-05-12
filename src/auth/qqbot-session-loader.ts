/**
 * `@tencent-connect/qqbot-connector` 的 package.json `exports` 仅暴露根入口，
 * 无法 `import ".../qqbot-session.js"`。官方 CLI 内部与此同源；此处用包根路径定位文件 URL 加载。
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkgRoot = dirname(require.resolve("@tencent-connect/qqbot-connector/package.json"));
const sessionHref = pathToFileURL(join(pkgRoot, "dist/esm/qqbot-session.js")).href;

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
