#!/bin/bash

# qqbot 通过 npm 包升级（纯文件操作版本）
#
# 默认只做文件替换，不修改 openclaw.json 配置文件。
# 但如果提供了 --appid/--secret 参数（首次安装场景），
# 则在文件安装完成后自动写入通道配置。
#
# 用法:
#   upgrade-via-npm.sh                                    # 升级到 latest（默认）
#   upgrade-via-npm.sh --version <version>                # 升级到指定版本
#   upgrade-via-npm.sh --self-version                     # 升级到当前仓库 package.json 版本
#   upgrade-via-npm.sh --appid <appid> --secret <secret>  # 首次安装时配置 appid/secret
#   upgrade-via-npm.sh --no-restart                        # 只做文件替换，不重启 gateway（供热更指令使用）

set -eo pipefail

PKG_NAME="@tencent-connect/openclaw-qqbot"
INSTALL_SRC=""
APPID=""
SECRET=""
NO_RESTART=false
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOCAL_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$PROJECT_DIR', 'package.json');
    const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
    if (v) process.stdout.write(String(v));
  } catch {}
" 2>/dev/null || true)"

print_usage() {
    echo "用法:"
    echo "  upgrade-via-npm.sh                              # 升级到 latest（默认）"
    echo "  upgrade-via-npm.sh --version <版本号>            # 升级到指定版本"
    if [ -n "$LOCAL_VERSION" ]; then
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本（$LOCAL_VERSION）"
    else
        echo "  upgrade-via-npm.sh --self-version               # 升级到当前仓库版本"
    fi
    echo ""
    echo "  --appid <appid>       QQ机器人 appid（首次安装时必填）"
    echo "  --secret <secret>     QQ机器人 secret（首次安装时必填）"
    echo ""
    echo "也可以通过环境变量设置:"
    echo "  QQBOT_APPID           QQ机器人 appid"
    echo "  QQBOT_SECRET          QQ机器人 secret"
    echo "  QQBOT_TOKEN           QQ机器人 token (appid:secret)"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --tag)
            [ -z "$2" ] && echo "❌ --tag 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --version)
            [ -z "$2" ] && echo "❌ --version 需要参数" && exit 1
            INSTALL_SRC="${PKG_NAME}@$2"
            shift 2
            ;;
        --self-version)
            [ -z "$LOCAL_VERSION" ] && echo "❌ 无法从 package.json 读取版本" && exit 1
            INSTALL_SRC="${PKG_NAME}@${LOCAL_VERSION}"
            shift 1
            ;;
        --appid)
            [ -z "$2" ] && echo "❌ --appid 需要参数" && exit 1
            APPID="$2"
            shift 2
            ;;
        --secret)
            [ -z "$2" ] && echo "❌ --secret 需要参数" && exit 1
            SECRET="$2"
            shift 2
            ;;
        --no-restart)
            NO_RESTART=true
            shift 1
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *) echo "未知选项: $1"; print_usage; exit 1 ;;
    esac
done
INSTALL_SRC="${INSTALL_SRC:-${PKG_NAME}@latest}"

# 环境变量 fallback
APPID="${APPID:-$QQBOT_APPID}"
SECRET="${SECRET:-$QQBOT_SECRET}"
if [ -z "$APPID" ] && [ -z "$SECRET" ] && [ -n "$QQBOT_TOKEN" ]; then
    APPID="${QQBOT_TOKEN%%:*}"
    SECRET="${QQBOT_TOKEN#*:}"
fi

# 检测 CLI（仅用于确定 extensions 目录路径）
CMD=""
for name in openclaw clawdbot moltbot; do
    command -v "$name" &>/dev/null && CMD="$name" && break
done
[ -z "$CMD" ] && echo "❌ 未找到 openclaw / clawdbot / moltbot" && exit 1

EXTENSIONS_DIR="$HOME/.$CMD/extensions"

echo "==========================================="
echo "  qqbot npm 升级: $INSTALL_SRC"
echo "==========================================="
echo ""

# [1/5] 下载并安装新版本到临时目录
echo "[1/5] 下载新版本..."
TMPDIR_PACK=$(mktemp -d)
EXTRACT_DIR=$(mktemp -d)
trap "rm -rf '$TMPDIR_PACK' '$EXTRACT_DIR'" EXIT

cd "$TMPDIR_PACK"
# 多 registry fallback：npmjs.org → npmmirror（国内镜像）→ 默认 registry
PACK_OK=false
for _registry in "https://registry.npmjs.org/" "https://registry.npmmirror.com/" ""; do
    if [ -n "$_registry" ]; then
        echo "  尝试 registry: $_registry"
        npm pack "$INSTALL_SRC" --registry "$_registry" --quiet 2>&1 && PACK_OK=true && break
    else
        echo "  尝试默认 registry..."
        npm pack "$INSTALL_SRC" --quiet 2>&1 && PACK_OK=true && break
    fi
done
$PACK_OK || { echo "❌ npm pack 失败（所有 registry 均不可用）"; exit 1; }
TGZ_FILE=$(ls -1 *.tgz 2>/dev/null | head -1)
[ -z "$TGZ_FILE" ] && echo "❌ 未找到下载的 tgz 文件" && exit 1
echo "  已下载: $TGZ_FILE"

tar xzf "$TGZ_FILE" -C "$EXTRACT_DIR"
PACKAGE_DIR="$EXTRACT_DIR/package"
[ ! -d "$PACKAGE_DIR" ] && echo "❌ 解压失败，未找到 package 目录" && exit 1

# 准备 staging 目录：放在 ~/.openclaw/ 下（extensions 的父目录），
# 同一文件系统保证 mv 原子操作，同时避免 OpenClaw 扫描 extensions/ 时发现它。
STAGING_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$PACKAGE_DIR/"* "$STAGING_DIR/"

# 依赖处理：所有 production dependencies 都声明为 bundledDependencies，
# npm pack 时已打包进 tgz，解压后 node_modules/ 已包含全部依赖，无需 npm install。
# 注意：不能执行 npm install，否则会安装 peerDependencies（openclaw 平台及其 400+ 传递依赖），
# 导致插件目录膨胀到 900MB+，而这些依赖在运行时由宿主 openclaw 提供。
if [ -d "$STAGING_DIR/node_modules" ]; then
    BUNDLED_COUNT=$(ls -d "$STAGING_DIR/node_modules"/*/ "$STAGING_DIR/node_modules"/@*/*/ 2>/dev/null | wc -l | tr -d ' ')
    echo "  bundled 依赖已就绪（${BUNDLED_COUNT} 个包）"
else
    echo "  ⚠️  未找到 bundled node_modules，尝试安装依赖..."
    NPM_TMP_CACHE=$(mktemp -d)
    (cd "$STAGING_DIR" && npm install --omit=dev --omit=peer --ignore-scripts --cache="$NPM_TMP_CACHE" --quiet 2>&1) || echo "  ⚠️  依赖安装失败"
    rm -rf "$NPM_TMP_CACHE"
fi

# 清理下载临时文件
rm -rf "$TMPDIR_PACK" "$EXTRACT_DIR"
cd "$HOME"

# ── Preflight 检查：在写入 extensions 之前确保新包完整有效 ──
echo ""
echo "[2/5] Preflight 检查..."
PREFLIGHT_OK=true

# (a) package.json 存在且可解析，且包含 version 字段
STAGING_PKG="$STAGING_DIR/package.json"
if [ ! -f "$STAGING_PKG" ]; then
    echo "  ❌ 新包缺少 package.json"
    PREFLIGHT_OK=false
else
    STAGING_VERSION="$(node -e "
      try {
        const v = JSON.parse(require('fs').readFileSync('$STAGING_PKG', 'utf8')).version;
        if (v) process.stdout.write(String(v));
      } catch {}
    " 2>/dev/null || true)"
    if [ -z "$STAGING_VERSION" ]; then
        echo "  ❌ package.json 无法解析或缺少 version 字段"
        PREFLIGHT_OK=false
    else
        echo "  ✅ 版本号: $STAGING_VERSION"
    fi
fi

# (b) 入口文件存在（dist/index.js 或 index.js）
ENTRY_FILE=""
for candidate in "dist/index.js" "index.js"; do
    if [ -f "$STAGING_DIR/$candidate" ]; then
        ENTRY_FILE="$candidate"
        break
    fi
done
if [ -z "$ENTRY_FILE" ]; then
    echo "  ❌ 缺少入口文件（dist/index.js 或 index.js）"
    PREFLIGHT_OK=false
else
    echo "  ✅ 入口文件: $ENTRY_FILE"
fi

# (c) 核心目录 dist/src 存在
if [ ! -d "$STAGING_DIR/dist/src" ]; then
    echo "  ❌ 缺少核心目录 dist/src/"
    PREFLIGHT_OK=false
else
    CORE_JS_COUNT=$(find "$STAGING_DIR/dist/src" -name "*.js" -type f 2>/dev/null | wc -l | tr -d ' ')
    echo "  ✅ dist/src/ 包含 ${CORE_JS_COUNT} 个 JS 文件"
    if [ "$CORE_JS_COUNT" -lt 5 ]; then
        echo "  ❌ JS 文件数量异常偏少（预期 ≥ 5，实际 ${CORE_JS_COUNT}）"
        PREFLIGHT_OK=false
    fi
fi

# (d) 关键模块文件存在
MISSING_MODULES=""
for module in "dist/src/gateway.js" "dist/src/api.js" "dist/src/admin-resolver.js"; do
    if [ ! -f "$STAGING_DIR/$module" ]; then
        MISSING_MODULES="$MISSING_MODULES $module"
    fi
done
if [ -n "$MISSING_MODULES" ]; then
    echo "  ❌ 缺少关键模块:$MISSING_MODULES"
    PREFLIGHT_OK=false
else
    echo "  ✅ 关键模块完整"
fi

# (e) bundled node_modules 健康检查
if [ -d "$STAGING_DIR/node_modules" ]; then
    BUNDLED_OK=true
    for dep in "ws" "silk-wasm"; do
        if [ ! -d "$STAGING_DIR/node_modules/$dep" ]; then
            echo "  ⚠️  bundled 依赖缺失: $dep"
            BUNDLED_OK=false
        fi
    done
    if $BUNDLED_OK; then
        echo "  ✅ 核心 bundled 依赖完整"
    fi
fi

# (f) 如果有旧版本，检查新版本是否合理（不允许降级到 0.x 等异常版本）
if [ -n "$STAGING_VERSION" ]; then
    STAGING_MAJOR="$(echo "$STAGING_VERSION" | cut -d. -f1)"
    if [ "$STAGING_MAJOR" = "0" ]; then
        echo "  ⚠️  新版本主版本号为 0（$STAGING_VERSION），可能不是正式发布版"
    fi
fi

# 检查结果
if [ "$PREFLIGHT_OK" != "true" ]; then
    echo ""
    echo "❌ Preflight 检查未通过，中止升级（旧版本未受影响）"
    rm -rf "$STAGING_DIR"
    exit 1
fi
echo "  ✅ Preflight 检查全部通过"

# [3/5] 原子替换：使用 mv -T/rename 确保目录切换尽可能原子
# 策略：先把 staging 放到 extensions/ 同级的临时名，再做单次 mv 替换
echo ""
echo "[3/5] 原子替换插件目录..."
TARGET_DIR="$EXTENSIONS_DIR/openclaw-qqbot"
OLD_DIR="$(dirname "$EXTENSIONS_DIR")/.qqbot-upgrade-old"

rm -rf "$OLD_DIR"

# 先把 staging 目录移到 extensions/ 下的临时位置（同文件系统，确保 mv 是 rename 操作）
STAGING_IN_EXT="$EXTENSIONS_DIR/.openclaw-qqbot-new"
rm -rf "$STAGING_IN_EXT"
mv "$STAGING_DIR" "$STAGING_IN_EXT"

if [ -d "$TARGET_DIR" ]; then
    # 使用连续两个 mv 但中间零操作，最小化目录不存在的时间窗口
    mv "$TARGET_DIR" "$OLD_DIR" && mv "$STAGING_IN_EXT" "$TARGET_DIR"
else
    mv "$STAGING_IN_EXT" "$TARGET_DIR"
fi
rm -rf "$OLD_DIR"

# 清理可能残留的旧版 staging 目录（extensions 内外都清理）
rm -rf "$EXTENSIONS_DIR/openclaw-qqbot.staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-staging"
rm -rf "$EXTENSIONS_DIR/.qqbot-upgrade-old"

# 同时清理历史遗留的其他目录名
for dir_name in qqbot openclaw-qq; do
    [ -d "$EXTENSIONS_DIR/$dir_name" ] && rm -rf "$EXTENSIONS_DIR/$dir_name"
done
echo "  已安装到: $TARGET_DIR"

# 执行 postinstall 脚本创建 openclaw SDK symlink
# （upgrade-via-npm 是纯文件操作，不走 npm install，所以 postinstall 不会自动触发）
POSTINSTALL_SCRIPT="$TARGET_DIR/scripts/postinstall-link-sdk.js"
if [ -f "$POSTINSTALL_SCRIPT" ]; then
    echo "  执行 postinstall: 创建 openclaw SDK symlink..."
    POSTINSTALL_OUTPUT="$(cd "$TARGET_DIR" && node "$POSTINSTALL_SCRIPT" 2>&1)" || true
    [ -n "$POSTINSTALL_OUTPUT" ] && echo "  $POSTINSTALL_OUTPUT"
    # 验证 symlink 是否创建成功
    if [ -d "$TARGET_DIR/node_modules/openclaw" ]; then
        echo "  ✅ openclaw SDK symlink 已就绪"
    else
        echo "  ⚠️  openclaw SDK symlink 未创建，插件可能无法加载"
        echo "  尝试手动创建 symlink..."
        # 手动 fallback：尝试从 CLI 数据目录名推断全局包名
        _CLI_DATA_DIR="$(dirname "$EXTENSIONS_DIR")"
        _CLI_NAME="$(basename "$_CLI_DATA_DIR" | sed 's/^\.//')"
        _GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
        if [ -n "$_GLOBAL_ROOT" ] && [ -n "$_CLI_NAME" ] && [ -d "$_GLOBAL_ROOT/$_CLI_NAME" ]; then
            mkdir -p "$TARGET_DIR/node_modules"
            ln -sf "$_GLOBAL_ROOT/$_CLI_NAME" "$TARGET_DIR/node_modules/openclaw" 2>/dev/null && \
                echo "  ✅ 手动 symlink 创建成功: -> $_GLOBAL_ROOT/$_CLI_NAME" || \
                echo "  ❌ 手动 symlink 创建也失败了"
        else
            echo "  ❌ 无法定位全局 $_CLI_NAME 安装路径（npm root -g: $_GLOBAL_ROOT）"
        fi
    fi
else
    echo "  ⚠️  未找到 postinstall 脚本，跳过 symlink 创建"
fi

# [4/5] 输出新版本号和升级报告（供调用方解析）
echo ""
echo "[4/5] 验证安装..."
NEW_VERSION="$(node -e "
  try {
    const fs = require('fs');
    const path = require('path');
    const p = path.join('$EXTENSIONS_DIR', 'openclaw-qqbot', 'package.json');
    if (fs.existsSync(p)) {
      const v = JSON.parse(fs.readFileSync(p, 'utf8')).version;
      if (v) { process.stdout.write(v); process.exit(0); }
    }
  } catch {}
" 2>/dev/null || true)"
echo "QQBOT_NEW_VERSION=${NEW_VERSION:-unknown}"

# 输出结构化升级报告（QQBOT_REPORT=...），供 TS handler 解析后直接回复用户
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    echo "QQBOT_REPORT=✅ QQBot 升级完成: v${NEW_VERSION}"
else
    echo "QQBOT_REPORT=⚠️ QQBot 升级异常，无法确认新版本"
fi

echo ""
echo "==========================================="
echo "  ✅ 文件安装完成"
echo "==========================================="

# --no-restart 模式（热更新场景）：文件替换完成后立即退出，
# 让调用方尽快触发 gateway restart，避免 openclaw 配置轮询
# 在旧进程中检测到插件变更产生 "plugin not found" warning 刷屏。
# appid/secret 配置在热更新场景下已经存在，无需重新写入。
if [ "$NO_RESTART" = "true" ]; then
    echo ""
    echo "[跳过重启] --no-restart 已指定，脚本立即退出以便调用方触发 gateway restart"
    exit 0
fi

# 以下步骤仅在非热更新（手动执行）场景中执行

# [配置] appid/secret（仅在提供了参数时执行）
if [ -n "$APPID" ] && [ -n "$SECRET" ]; then
    echo ""
    echo "[配置] 写入 qqbot 通道配置..."
    DESIRED_TOKEN="${APPID}:${SECRET}"

    # 读取当前已有的 token
    CURRENT_TOKEN=""
    for _app in openclaw clawdbot moltbot; do
        _cfg="$HOME/.$_app/$_app.json"
        if [ -f "$_cfg" ]; then
            CURRENT_TOKEN=$(node -e "
                const cfg = JSON.parse(require('fs').readFileSync('$_cfg', 'utf8'));
                const keys = ['qqbot', 'openclaw-qqbot', 'openclaw-qq'];
                for (const key of keys) {
                    const ch = cfg.channels && cfg.channels[key];
                    if (!ch) continue;
                    if (ch.token) { process.stdout.write(ch.token); process.exit(0); }
                    if (ch.appId && ch.clientSecret) { process.stdout.write(ch.appId + ':' + ch.clientSecret); process.exit(0); }
                }
            " 2>/dev/null || true)
            [ -n "$CURRENT_TOKEN" ] && break
        fi
    done

    if [ "$CURRENT_TOKEN" = "$DESIRED_TOKEN" ]; then
        echo "  ✅ 当前配置已是目标值，跳过写入"
    elif $CMD channels add --channel qqbot --token "$DESIRED_TOKEN" 2>&1; then
        echo "  ✅ 通道配置写入成功"
    else
        echo "  ⚠️  $CMD channels add 失败，尝试直接编辑配置文件..."
        CONFIG_FILE="$HOME/.$CMD/$CMD.json"
        if [ -f "$CONFIG_FILE" ] && node -e "
            const fs = require('fs');
            const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
            if (!cfg.channels) cfg.channels = {};
            if (!cfg.channels.qqbot) cfg.channels.qqbot = {};
            cfg.channels.qqbot.appId = '$APPID';
            cfg.channels.qqbot.clientSecret = '$SECRET';
            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(cfg, null, 4) + '\n');
        " 2>&1; then
            echo "  ✅ 通道配置写入成功（直接编辑配置文件）"
        else
            echo "  ❌ 配置写入失败，请手动配置:"
            echo "     $CMD channels add --channel qqbot --token \"${APPID}:${SECRET}\""
        fi
    fi
elif [ -n "$APPID" ] || [ -n "$SECRET" ]; then
    echo ""
    echo "⚠️  --appid 和 --secret 必须同时提供"
fi

# [5/5] 重启 gateway 使新版本生效
echo ""

# 手动升级场景：提前写入 startup-marker，阻止重启后 bot 重复推送升级通知
# （控制台已打印同款提示语，无需 bot 再发一次）
if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
    MARKER_DIR="$HOME/.openclaw/qqbot/data"
    mkdir -p "$MARKER_DIR"
    MARKER_FILE="$MARKER_DIR/startup-marker.json"
    NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)"
    echo "{\"version\":\"$NEW_VERSION\",\"startedAt\":\"$NOW\",\"greetedAt\":\"$NOW\"}" > "$MARKER_FILE"
fi

echo "[重启] 重启 gateway 使新版本生效..."
if $CMD gateway restart 2>&1; then
    echo "  ✅ gateway 已重启"
    # 打印与 bot 通知同款的更新提示语（手动升级场景无需通过 bot 推送）
    echo ""
    if [ -n "$NEW_VERSION" ] && [ "$NEW_VERSION" != "unknown" ]; then
        echo "🎉 QQBot 插件已更新至 v${NEW_VERSION}，在线等候你的吩咐。"
    fi
else
    echo "  ⚠️  gateway 重启失败，请手动执行: $CMD gateway restart"
fi
