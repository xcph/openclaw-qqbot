#!/usr/bin/env node

// When installed as an openclaw extension under ~/.openclaw/extensions/,
// the plugin needs access to `openclaw/plugin-sdk` at runtime.
// openclaw's jiti loader resolves this via alias by walking up from the plugin
// path to find the openclaw package root — but ~/.openclaw/extensions/ is not
// under the openclaw package tree, so the alias lookup fails.
//
// This script creates a symlink from the plugin's node_modules/openclaw to the
// globally installed openclaw package, allowing Node's native ESM resolver
// (used by jiti with tryNative:true for .js files) to find `openclaw/plugin-sdk`.
// 使用纯文件系统 API，不执行 shell 命令。

import { existsSync, lstatSync, symlinkSync, unlinkSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, "..");

const linkTarget = join(pluginRoot, "node_modules", "openclaw");

const CLI_NAMES = ["openclaw", "clawdbot", "moltbot"];

/**
 * 获取可能的 npm 全局安装根目录列表
 */
function getPossibleGlobalRoots() {
  const homeDir = homedir();
  const roots = [];

  // nvm 路径
  try {
    const nodeVersion = process.version;
    roots.push(join(homeDir, ".nvm", "versions", "node", nodeVersion, "lib", "node_modules"));
  } catch {}

  // fnm 路径
  try {
    const nodeVersion = process.version;
    roots.push(join(homeDir, ".fnm", "node-versions", nodeVersion, "installation", "lib", "node_modules"));
  } catch {}

  // volta 路径
  roots.push(join(homeDir, ".volta", "tools", "image", "packages"));

  // n 路径
  try {
    const nodeVersion = process.version;
    roots.push(join(homeDir, ".n", "versions", "node", nodeVersion, "lib", "node_modules"));
  } catch {}

  // 系统路径
  roots.push("/usr/local/lib/node_modules");
  roots.push("/usr/lib/node_modules");

  // Windows 路径
  if (process.platform === "win32") {
    roots.push(join(process.env.APPDATA || "", "npm", "node_modules"));
    roots.push(join(process.env.LOCALAPPDATA || "", "npm", "node_modules"));
  }

  return roots;
}

// Check if already a valid symlink pointing to a directory with plugin-sdk/core
if (existsSync(linkTarget)) {
  try {
    const stat = lstatSync(linkTarget);
    if (stat.isSymbolicLink()) {
      // Symlink exists — verify it has plugin-sdk/core
      if (existsSync(join(linkTarget, "plugin-sdk", "core.js"))) {
        process.exit(0);
      }
      // Symlink is stale or points to wrong target, remove and re-create
      unlinkSync(linkTarget);
    } else if (existsSync(join(linkTarget, "plugin-sdk", "core.js"))) {
      // Real directory with correct structure (e.g. npm installed a good version)
      process.exit(0);
    } else {
      // Real directory from npm install but missing plugin-sdk/core — replace with symlink
      rmSync(linkTarget, { recursive: true, force: true });
    }
  } catch {
    // If stat fails, try to remove and re-create
    try { rmSync(linkTarget, { recursive: true, force: true }); } catch {}
  }
}

// Find the global openclaw installation
let openclawRoot = null;

// Strategy 1: scan common global npm directories
if (!openclawRoot) {
  const globalRoots = getPossibleGlobalRoots();
  for (const globalRoot of globalRoots) {
    for (const name of CLI_NAMES) {
      const candidate = join(globalRoot, name);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
        break;
      }
    }
    if (openclawRoot) break;
  }
}

// Strategy 2: check known CLI paths
if (!openclawRoot) {
  const homeDir = homedir();
  const cliDirs = [
    join(homeDir, ".nvm", "versions", "node", process.version, "bin"),
    join(homeDir, ".fnm", "node-versions", process.version, "installation", "bin"),
    join(homeDir, ".n", "versions", "node", process.version, "bin"),
    join(homeDir, ".volta", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    process.platform === "win32" ? join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps") : null,
  ].filter(Boolean);

  for (const cliDir of cliDirs) {
    for (const name of CLI_NAMES) {
      const binName = process.platform === "win32" ? `${name}.cmd` : name;
      const binPath = join(cliDir, binName);
      if (existsSync(binPath)) {
        try {
          const realBin = realpathSync(binPath);
          // Try to infer package root from binary location
          const candidate = resolve(dirname(realBin), "..", "lib", "node_modules", name);
          if (existsSync(join(candidate, "package.json"))) {
            openclawRoot = candidate;
            break;
          }
          const candidate2 = resolve(dirname(realBin), "..");
          if (existsSync(join(candidate2, "package.json")) && existsSync(join(candidate2, "plugin-sdk"))) {
            openclawRoot = candidate2;
            break;
          }
        } catch {}
      }
    }
    if (openclawRoot) break;
  }
}

// Strategy 3: walk up from the extensions directory to find the CLI's data root,
// then look for a global node_modules sibling
if (!openclawRoot) {
  // pluginRoot is like /home/user/.openclaw/extensions/openclaw-qqbot
  // The CLI data dir is /home/user/.openclaw (or .clawdbot, .moltbot)
  const extensionsDir = dirname(pluginRoot);
  const dataDir = dirname(extensionsDir);
  const dataDirName = dataDir.split("/").pop() || dataDir.split("\\").pop() || "";
  // dataDirName is like ".openclaw" → strip the dot to get "openclaw"
  const cliName = dataDirName.replace(/^\./, "");
  if (cliName) {
    const globalRoots = getPossibleGlobalRoots();
    for (const globalRoot of globalRoots) {
      const candidate = join(globalRoot, cliName);
      if (existsSync(join(candidate, "package.json"))) {
        openclawRoot = candidate;
        break;
      }
    }
  }
}

if (!openclawRoot) {
  // Not fatal — plugin may work if openclaw loads it with proper alias resolution
  // But log a warning so upgrade scripts can detect the failure
  console.error("[postinstall-link-sdk] WARNING: could not find openclaw/clawdbot/moltbot global installation, symlink not created");
  process.exit(0);
}

try {
  mkdirSync(join(pluginRoot, "node_modules"), { recursive: true });
  symlinkSync(openclawRoot, linkTarget, "junction");
  console.log(`[postinstall-link-sdk] symlink created: node_modules/openclaw -> ${openclawRoot}`);
} catch (e) {
  console.error(`[postinstall-link-sdk] WARNING: symlink creation failed: ${e.message}`);
}
