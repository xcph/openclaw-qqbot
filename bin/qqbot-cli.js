#!/usr/bin/env node

/**
 * qqbot CLI - 用于升级和管理 qqbot 插件
 * 
 * 用法:
 *   npx openclaw-qqbot upgrade    # 升级插件
 *   npx openclaw-qqbot install    # 安装插件
 * 
 * 不调用子进程执行外部命令：为满足 OpenClaw 插件安全扫描，本脚本仅做本地清理与配置读取，
 * 具体 `openclaw`/`clawdbot` 命令请用户在本机终端自行执行（见下方打印）。
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

/** 允许的 CLI 命令白名单 */
const ALLOWED_CLI_COMMANDS = new Set(['openclaw', 'clawdbot', 'moltbot']);

/** 验证命令是否安全（防止命令注入） */
function validateCommand(cmd) {
  if (!cmd || typeof cmd !== 'string') return false;
  
  // 检查是否包含危险字符
  const dangerousChars = /[;&|`$(){}[\]\n\r<>]/;
  if (dangerousChars.test(cmd)) {
    console.error(`Error: Dangerous character in command: ${cmd}`);
    return false;
  }
  
  return true;
}

/** 验证参数是否安全 */
function validateArg(arg) {
  if (!arg || typeof arg !== 'string') return false;

  // 检查是否包含危险字符
  // 允许字母数字、冒号（用于token）、连字符、下划线、点号
  const dangerousChars = /[;&|`$(){}[\]\n\r<>]/;
  if (dangerousChars.test(arg)) {
    console.error(`Error: Dangerous character in argument`);
    return false;
  }

  return true;
}

/** 验证 CLI 命令是否在白名单内 */
function validateCliCommand(cmd) {
  if (!ALLOWED_CLI_COMMANDS.has(cmd)) {
    console.error(`Error: CLI command not in whitelist: ${cmd}`);
    return false;
  }
  return true;
}

// 检测使用的是 clawdbot 还是 openclaw
function detectInstallation() {
  const home = homedir();
  if (existsSync(join(home, '.openclaw'))) {
    return 'openclaw';
  }
  if (existsSync(join(home, '.clawdbot'))) {
    return 'clawdbot';
  }
  return null;
}

// 需要清理的所有可能的插件 ID / 包名（原仓库 + 本仓库 + 框架推断名）
const PLUGIN_IDS = ['qqbot', 'openclaw-qq', '@sliverp/qqbot', '@tencent-connect/openclaw-qq', '@tencent-connect/qqbot', '@tencent-connect/openclaw-qqbot', 'openclaw-qqbot'];
// 可能的扩展目录名
const EXTENSION_DIR_NAMES = ['qqbot', 'openclaw-qq', 'openclaw-qqbot'];

// 清理旧版本插件，返回旧的 qqbot 配置
function cleanupInstallation(appName) {
  const home = homedir();
  const appDir = join(home, `.${appName}`);
  const configFile = join(appDir, `${appName}.json`);

  let oldQqbotConfig = null;

  console.log(`\n>>> 处理 ${appName} 安装...`);

  // 1. 先读取旧的 qqbot 配置（尝试所有可能的 channel key）
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      if (config.channels?.qqbot) {
        oldQqbotConfig = { ...config.channels.qqbot };
        console.log('已保存旧的 qqbot 配置');
      }
    } catch (err) {
      console.error('读取配置文件失败:', err.message);
    }
  }

  // 2. 删除所有可能的旧扩展目录
  for (const dirName of EXTENSION_DIR_NAMES) {
    const extensionDir = join(appDir, 'extensions', dirName);
    if (existsSync(extensionDir)) {
      console.log(`删除旧版本插件: ${extensionDir}`);
      rmSync(extensionDir, { recursive: true, force: true });
    }
  }

  // 3. 清理配置文件中所有可能的插件 ID 相关字段
  if (existsSync(configFile)) {
    console.log('清理配置文件中的插件字段...');
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf8'));

      for (const id of PLUGIN_IDS) {
        // 删除 channels.<id>
        if (config.channels?.[id]) {
          delete config.channels[id];
          console.log(`  - 已删除 channels.${id}`);
        }

        // 删除 plugins.entries.<id>
        if (config.plugins?.entries?.[id]) {
          delete config.plugins.entries[id];
          console.log(`  - 已删除 plugins.entries.${id}`);
        }

        // 删除 plugins.installs.<id>
        if (config.plugins?.installs?.[id]) {
          delete config.plugins.installs[id];
          console.log(`  - 已删除 plugins.installs.${id}`);
        }

        // 删除 plugins.allow 中的 <id>
        if (Array.isArray(config.plugins?.allow)) {
          const before = config.plugins.allow.length;
          config.plugins.allow = config.plugins.allow.filter((x) => x !== id);
          if (config.plugins.allow.length !== before) {
            console.log(`  - 已删除 plugins.allow.${id}`);
          }
        }
      }

      writeFileSync(configFile, JSON.stringify(config, null, 2));
      console.log('配置文件已更新');
    } catch (err) {
      console.error('清理配置文件失败:', err.message);
    }
  } else {
    console.log(`未找到配置文件: ${configFile}`);
  }

  return oldQqbotConfig;
}

/** 将参数格式化为可在 shell 中安全复制的片段（POSIX 风格单引号） */
function escapeShellArgForDisplay(arg) {
  const s = String(arg);
  if (/^[a-zA-Z0-9._/@:\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 不执行子进程：仅校验并打印一条可复制到终端的完整命令。
 * @returns 校验通过为 true
 */
function printCliInstruction(label, cmd, cmdArgs = []) {
  if (!validateCommand(cmd)) {
    console.error(`Error: Invalid command: ${cmd}`);
    return false;
  }
  if (!validateCliCommand(cmd)) {
    return false;
  }
  for (const arg of cmdArgs) {
    if (!validateArg(arg)) {
      console.error(`Error: Invalid argument`);
      return false;
    }
  }
  const line = [cmd, ...cmdArgs.map(escapeShellArgForDisplay)].join(' ');
  if (label) console.log(label);
  console.log(`  ${line}`);
  return true;
}

// 升级命令
function upgrade() {
  console.log('=== qqbot 插件升级脚本 ===');

  let foundInstallation = null;
  let savedConfig = null;
  const home = homedir();

  // 检查 openclaw
  if (existsSync(join(home, '.openclaw'))) {
    savedConfig = cleanupInstallation('openclaw');
    foundInstallation = 'openclaw';
  }

  // 检查 clawdbot
  if (existsSync(join(home, '.clawdbot'))) {
    const clawdbotConfig = cleanupInstallation('clawdbot');
    if (!savedConfig) savedConfig = clawdbotConfig;
    foundInstallation = 'clawdbot';
  }

  if (!foundInstallation) {
    console.log('\n未找到 clawdbot 或 openclaw 安装目录');
    console.log('请确认已安装 clawdbot 或 openclaw');
    process.exit(1);
  }

  console.log('\n=== 清理完成 ===');

  console.log('\n请在终端中依次执行以下命令（本脚本不会自动调用 CLI）：\n');

  printCliInstruction(
    '[1/2] 安装新版本插件',
    foundInstallation,
    ['plugins', 'install', 'openclaw-qqbot'],
  );

  if (savedConfig?.appId && savedConfig?.clientSecret) {
    const appIdPattern = /^[a-zA-Z0-9_-]+$/;
    const secretPattern = /^[a-zA-Z0-9_-]+$/;
    if (!appIdPattern.test(savedConfig.appId) || !secretPattern.test(savedConfig.clientSecret)) {
      console.error('Error: 无效的 appId 或 clientSecret 格式');
      return;
    }

    const token = `${savedConfig.appId}:${savedConfig.clientSecret}`;
    console.log(`\n已根据备份生成 token（appId=${savedConfig.appId}）`);

    printCliInstruction(
      '[2/2] 配置机器人通道',
      foundInstallation,
      ['channels', 'add', '--channel', 'qqbot', '--token', token],
    );

    if (savedConfig.markdownSupport !== undefined) {
      printCliInstruction(
        '（可选）恢复 markdownSupport',
        foundInstallation,
        ['config', 'set', 'channels.qqbot.markdownSupport', String(savedConfig.markdownSupport)],
      );
    }
  } else {
    console.log('\n未找到已保存的 qqbot 配置，请手动添加通道，例如：');
    printCliInstruction('', foundInstallation, ['channels', 'add', '--channel', 'qqbot', '--token', 'appid:appsecret']);
    return;
  }

  console.log('\n=== 本地清理与命令提示已完成 ===');
  console.log('\n启动 Gateway 示例（请在本机终端执行）：');
  console.log(`  ${foundInstallation} gateway stop && ${foundInstallation} gateway --port 18789 --verbose`);
}

// 安装命令
function install() {
  console.log('=== qqbot 插件安装 ===');

  const cmd = detectInstallation();
  if (!cmd) {
    console.log('未找到 clawdbot 或 openclaw 安装');
    console.log('请先安装 openclaw 或 clawdbot');
    process.exit(1);
  }

  console.log(`\n请在终端执行以下命令安装插件：\n`);
  printCliInstruction('', cmd, ['plugins', 'install', '@tencent-connect/openclaw-qqbot']);

  console.log('\n=== 命令已打印 ===');
  console.log('\n请配置机器人通道:');
  console.log(`  ${cmd} channels add --channel qqbot --token "appid:appsecret"`);
}

// 显示帮助
function showHelp() {
  console.log(`
qqbot CLI - QQ机器人插件管理工具

用法:
  npx openclaw-qqbot <命令>

命令:
  upgrade       清理旧版本插件（升级前执行）
  install       安装插件到 openclaw/clawdbot

示例:
  npx openclaw-qqbot upgrade
  npx openclaw-qqbot install
`);
}

// 主入口
switch (command) {
  case 'upgrade':
    upgrade();
    break;
  case 'install':
    install();
    break;
  case '-h':
  case '--help':
  case 'help':
    showHelp();
    break;
  default:
    if (command) {
      console.log(`未知命令: ${command}`);
    }
    showHelp();
    process.exit(command ? 1 : 0);
}
