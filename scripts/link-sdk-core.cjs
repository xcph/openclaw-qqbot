/**
 * 公共模块：openclaw plugin-sdk symlink 创建逻辑。
 *
 * 被 preload.cjs 和 postinstall-link-sdk.js 共同使用，避免代码重复。
 * 必须是 CJS 格式，因为 preload.cjs 需要同步 require()。
 * 使用纯文件系统 API，不执行 shell 命令。
 */
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const CLI_NAMES = ["openclaw", "clawdbot", "moltbot"];

/**
 * 比较版本号是否 >= target
 * Strip pre-release suffix (e.g. "2026.3.23-2" → "2026.3.23")
 */
function compareVersionGte(version, target) {
  const parts = version.replace(/-.*$/, "").split(".").map(Number);
  for (let i = 0; i < target.length; i++) {
    const v = parts[i] || 0;
    const t = target[i];
    if (v > t) return true;
    if (v < t) return false;
  }
  return true;
}

/**
 * 获取可能的 npm 全局安装根目录列表
 */
function getPossibleGlobalRoots() {
  const homeDir = os.homedir();
  const roots = [];

  // nvm 路径
  try {
    const nodeVersion = process.version;
    roots.push(path.join(homeDir, ".nvm", "versions", "node", nodeVersion, "lib", "node_modules"));
  } catch {}

  // fnm 路径
  try {
    const nodeVersion = process.version;
    roots.push(path.join(homeDir, ".fnm", "node-versions", nodeVersion, "installation", "lib", "node_modules"));
  } catch {}

  // volta 路径
  roots.push(path.join(homeDir, ".volta", "tools", "image", "packages"));

  // n 路径
  try {
    const nodeVersion = process.version;
    roots.push(path.join(homeDir, ".n", "versions", "node", nodeVersion, "lib", "node_modules"));
  } catch {}

  // 系统路径
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");

  // Windows 路径
  if (process.platform === "win32") {
    roots.push(path.join(process.env.APPDATA || "", "npm", "node_modules"));
    roots.push(path.join(process.env.LOCALAPPDATA || "", "npm", "node_modules"));
  }

  return roots;
}

/**
 * 检查 openclaw 版本是否 >= 2026.3.22（需要 symlink 的最低版本）。
 * 使用文件系统检测，不执行 shell 命令。
 * 如果无法检测版本，返回 true（保守策略：宁可多创建也不遗漏）。
 */
function isOpenclawVersionRequiresSymlink() {
  const REQUIRED = [2026, 3, 22];

  // Strategy 1: 从全局 openclaw 的 package.json 读取版本
  const globalRoots = getPossibleGlobalRoots();
  for (const globalRoot of globalRoots) {
    for (const name of CLI_NAMES) {
      const pkgPath = path.join(globalRoot, name, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const v = JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
          if (v) return compareVersionGte(v, REQUIRED);
        } catch {}
      }
    }
  }

  // Strategy 2: 从已知 CLI 路径推断
  const homeDir = os.homedir();
  const cliPaths = [
    // npm 全局 bin 目录
    path.join(homeDir, ".nvm", "versions", "node", process.version, "bin"),
    path.join(homeDir, ".fnm", "node-versions", process.version, "installation", "bin"),
    path.join(homeDir, ".n", "versions", "node", process.version, "bin"),
    path.join(homeDir, ".volta", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    // Windows
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps"),
  ];

  for (const cliDir of cliPaths) {
    for (const name of CLI_NAMES) {
      const cliPath = path.join(cliDir, process.platform === "win32" ? `${name}.cmd` : name);
      if (fs.existsSync(cliPath)) {
        // 尝试从 CLI 所在目录推断包位置
        const possiblePkg = path.join(cliDir, "..", "lib", "node_modules", name, "package.json");
        if (fs.existsSync(possiblePkg)) {
          try {
            const v = JSON.parse(fs.readFileSync(possiblePkg, "utf-8")).version;
            if (v) return compareVersionGte(v, REQUIRED);
          } catch {}
        }
      }
    }
  }

  // 无法检测版本时，保守返回 true
  return true;
}

/**
 * 查找全局 openclaw 安装路径。
 * 三种策略依次尝试：文件系统扫描、已知 CLI 路径、从 extensions 目录推断。
 * 纯文件系统检测，不执行 shell 命令。
 */
function findOpenclawRoot(pluginRoot) {
  // Strategy 1: 扫描常见的全局 npm 安装目录
  const globalRoots = getPossibleGlobalRoots();
  for (const globalRoot of globalRoots) {
    for (const name of CLI_NAMES) {
      const candidate = path.join(globalRoot, name);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  }

  // Strategy 2: 检查已知 CLI 路径
  const homeDir = os.homedir();
  const cliDirs = [
    path.join(homeDir, ".nvm", "versions", "node", process.version, "bin"),
    path.join(homeDir, ".fnm", "node-versions", process.version, "installation", "bin"),
    path.join(homeDir, ".n", "versions", "node", process.version, "bin"),
    path.join(homeDir, ".volta", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps") : null,
  ].filter(Boolean);

  for (const cliDir of cliDirs) {
    for (const name of CLI_NAMES) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const binPath = path.join(cliDir, binName);
      if (fs.existsSync(binPath)) {
        try {
          const realBin = fs.realpathSync(binPath);
          // 尝试从 bin 位置推断包根目录
          const c1 = path.resolve(path.dirname(realBin), "..", "lib", "node_modules", name);
          if (fs.existsSync(path.join(c1, "package.json"))) return c1;
          const c2 = path.resolve(path.dirname(realBin), "..");
          if (fs.existsSync(path.join(c2, "package.json")) && fs.existsSync(path.join(c2, "plugin-sdk"))) return c2;
        } catch {}
      }
    }
  }

  // Strategy 3: 从 extensions 目录推断
  const extensionsDir = path.dirname(pluginRoot);
  const dataDir = path.dirname(extensionsDir);
  const dataDirName = path.basename(dataDir);
  const cliName = dataDirName.replace(/^\./, "");
  if (cliName) {
    for (const globalRoot of globalRoots) {
      const candidate = path.join(globalRoot, cliName);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  }

  return null;
}

/**
 * 验证现有 node_modules/openclaw 是否完整可用。
 *
 * openclaw plugins install 可能安装了不完整的 peerDep 副本
 * （只有 dist/plugin-sdk/index.js，缺少 core.js 等子模块），覆盖了之前的 symlink。
 *
 * 判断标准：
 * - symlink → 只需确认 dist/plugin-sdk 目录存在（target 有完整文件树）
 * - 真实目录 → 必须检查 dist/plugin-sdk/core.js 是否存在
 */
function isLinkValid(linkTarget) {
  try {
    const stat = fs.lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk"))
        || fs.existsSync(path.join(linkTarget, "plugin-sdk"));
    }
    // 真实目录
    return fs.existsSync(path.join(linkTarget, "dist", "plugin-sdk", "core.js"));
  } catch {
    return false;
  }
}

/**
 * 确保 plugin-sdk symlink 存在。
 *
 * @param {string} pluginRoot - 插件根目录路径
 * @param {string} [tag="[link-sdk]"] - 日志前缀
 * @returns {boolean} true 如果 symlink 已存在或成功创建
 */
function ensurePluginSdkSymlink(pluginRoot, tag) {
  tag = tag || "[link-sdk]";
  try {
    if (!pluginRoot.includes("extensions")) return true;

    const linkTarget = path.join(pluginRoot, "node_modules", "openclaw");

    if (fs.existsSync(linkTarget)) {
      if (isLinkValid(linkTarget)) return true;
      // 无效/不完整 → 删除后重建
      try {
        fs.rmSync(linkTarget, { recursive: true, force: true });
        console.log(`${tag} removed incomplete node_modules/openclaw`);
      } catch {}
    }

    if (!isOpenclawVersionRequiresSymlink()) return true;

    const openclawRoot = findOpenclawRoot(pluginRoot);
    if (!openclawRoot) {
      console.error(`${tag} WARNING: could not find openclaw global installation, symlink not created`);
      return false;
    }

    fs.mkdirSync(path.join(pluginRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(openclawRoot, linkTarget, "junction");
    console.log(`${tag} symlink created: node_modules/openclaw -> ${openclawRoot}`);
    return true;
  } catch (e) {
    console.error(`${tag} WARNING: symlink check failed: ${e.message || e}`);
    return false;
  }
}

module.exports = {
  CLI_NAMES,
  compareVersionGte,
  isOpenclawVersionRequiresSymlink,
  findOpenclawRoot,
  isLinkValid,
  ensurePluginSdkSymlink,
};
