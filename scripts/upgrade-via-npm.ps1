# qqbot upgrade via npm package (Windows PowerShell)
#
# Windows-native equivalent of upgrade-via-npm.sh.
# No bash / Git Bash / WSL required.
#
# Usage:
#   .\upgrade-via-npm.ps1                                    # upgrade to latest (default)
#   .\upgrade-via-npm.ps1 -Version <version>                 # upgrade to specific version
#   .\upgrade-via-npm.ps1 -SelfVersion                       # upgrade to local package.json version
#   .\upgrade-via-npm.ps1 -AppId <appid> -Secret <secret>    # configure on first install
#   .\upgrade-via-npm.ps1 -NoRestart                         # file replacement only (for hot-upgrade)

param(
    [string]$Version = "",
    [switch]$SelfVersion,
    [string]$AppId = "",
    [string]$Secret = "",
    [switch]$NoRestart,
    [string]$Tag = "",
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$PKG_NAME = "@tencent-connect/openclaw-qqbot"
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PROJECT_DIR = Split-Path -Parent $SCRIPT_DIR

# Read local version
$LOCAL_VERSION = ""
try {
    $pkgPath = Join-Path $PROJECT_DIR "package.json"
    if (Test-Path $pkgPath) {
        $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
        $LOCAL_VERSION = $pkg.version
    }
} catch {}

if ($Help) {
    Write-Host "Usage:"
    Write-Host "  .\upgrade-via-npm.ps1                              # upgrade to latest (default)"
    Write-Host "  .\upgrade-via-npm.ps1 -Version [version]           # upgrade to specific version"
    Write-Host "  .\upgrade-via-npm.ps1 -SelfVersion                 # upgrade to repo version ($LOCAL_VERSION)"
    Write-Host ""
    Write-Host "  -AppId [appid]       QQ bot appid (required on first install)"
    Write-Host "  -Secret [secret]     QQ bot secret (required on first install)"
    exit 0
}

# Determine install source
$INSTALL_SRC = ""
if ($Tag) {
    $INSTALL_SRC = "${PKG_NAME}@${Tag}"
} elseif ($Version) {
    $INSTALL_SRC = "${PKG_NAME}@${Version}"
} elseif ($SelfVersion) {
    if (-not $LOCAL_VERSION) {
        Write-Host "[ERROR] Cannot read version from package.json" -ForegroundColor Red
        exit 1
    }
    $INSTALL_SRC = "${PKG_NAME}@${LOCAL_VERSION}"
} else {
    $INSTALL_SRC = "${PKG_NAME}@latest"
}

# Environment variable fallback
if (-not $AppId) { $AppId = $env:QQBOT_APPID }
if (-not $Secret) { $Secret = $env:QQBOT_SECRET }
if ((-not $AppId) -and (-not $Secret) -and $env:QQBOT_TOKEN) {
    $parts = $env:QQBOT_TOKEN -split ":", 2
    $AppId = $parts[0]
    $Secret = $parts[1]
}

# Detect CLI
$CMD = ""
foreach ($name in @("openclaw", "clawdbot", "moltbot")) {
    try {
        $null = Get-Command $name -ErrorAction Stop
        $CMD = $name
        break
    } catch {}
}
if (-not $CMD) {
    Write-Host "[ERROR] openclaw / clawdbot / moltbot not found" -ForegroundColor Red
    exit 1
}

$HOME_DIR = $env:USERPROFILE
if (-not $HOME_DIR) { $HOME_DIR = [Environment]::GetFolderPath("UserProfile") }
$EXTENSIONS_DIR = Join-Path (Join-Path $HOME_DIR ".$CMD") "extensions"

Write-Host "==========================================="
Write-Host "  qqbot npm upgrade: $INSTALL_SRC"
Write-Host "==========================================="
Write-Host ""

# [1/3] Download and extract new version
Write-Host "[1/3] Downloading new version..."
$TMPDIR_PACK = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-pack-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$EXTRACT_DIR = Join-Path ([System.IO.Path]::GetTempPath()) "qqbot-extract-$([guid]::NewGuid().ToString('N').Substring(0,8))"
New-Item -ItemType Directory -Path $TMPDIR_PACK -Force | Out-Null
New-Item -ItemType Directory -Path $EXTRACT_DIR -Force | Out-Null

try {
    Push-Location $TMPDIR_PACK

    # Multi-registry fallback
    $PACK_OK = $false
    $registries = @("https://registry.npmjs.org/", "https://registry.npmmirror.com/", "")
    foreach ($registry in $registries) {
        try {
            if ($registry) {
                Write-Host "  Trying registry: $registry"
                & npm pack $INSTALL_SRC --registry $registry --quiet 2>&1 | Out-Null
            } else {
                Write-Host "  Trying default registry..."
                & npm pack $INSTALL_SRC --quiet 2>&1 | Out-Null
            }
            if ($LASTEXITCODE -eq 0) {
                $PACK_OK = $true
                break
            }
        } catch {}
    }

    if (-not $PACK_OK) {
        Write-Host "[ERROR] npm pack failed (all registries unavailable)" -ForegroundColor Red
        exit 1
    }

    $TGZ_FILE = Get-ChildItem -Path $TMPDIR_PACK -Filter "*.tgz" | Select-Object -First 1
    if (-not $TGZ_FILE) {
        Write-Host "[ERROR] Downloaded tgz file not found" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Downloaded: $($TGZ_FILE.Name)"

    # Extract tgz (tar is built-in on Windows 10+)
    & tar xzf $TGZ_FILE.FullName -C $EXTRACT_DIR
    $PACKAGE_DIR = Join-Path $EXTRACT_DIR "package"
    if (-not (Test-Path $PACKAGE_DIR)) {
        Write-Host "[ERROR] Extraction failed, package directory not found" -ForegroundColor Red
        exit 1
    }

    Pop-Location

    # Prepare staging directory
    $STAGING_DIR = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-staging"
    if (Test-Path $STAGING_DIR) { Remove-Item -Recurse -Force $STAGING_DIR }
    Copy-Item -Recurse -Force $PACKAGE_DIR $STAGING_DIR

    # Check bundled dependencies
    $nmDir = Join-Path $STAGING_DIR "node_modules"
    if (Test-Path $nmDir) {
        $bundledCount = (Get-ChildItem -Directory $nmDir -ErrorAction SilentlyContinue | Measure-Object).Count
        # Count scoped packages
        Get-ChildItem -Directory $nmDir -Filter "@*" -ErrorAction SilentlyContinue | ForEach-Object {
            $bundledCount += (Get-ChildItem -Directory $_.FullName -ErrorAction SilentlyContinue | Measure-Object).Count - 1
        }
        Write-Host "  Bundled dependencies ready (${bundledCount} packages)"
    } else {
        Write-Host "  [WARN] Bundled node_modules not found, installing dependencies..."
        Push-Location $STAGING_DIR
        try { & npm install --omit=dev --omit=peer --ignore-scripts --quiet 2>&1 | Out-Null } catch {}
        Pop-Location
    }

} finally {
    # Clean up temp files
    if (Test-Path $TMPDIR_PACK) { Remove-Item -Recurse -Force $TMPDIR_PACK -ErrorAction SilentlyContinue }
    if (Test-Path $EXTRACT_DIR) { Remove-Item -Recurse -Force $EXTRACT_DIR -ErrorAction SilentlyContinue }
}

# [2/3] Replace plugin directory (in-place overwrite to avoid file-lock issues)
Write-Host ""
Write-Host "[2/3] Replacing plugin directory..."
$TARGET_DIR = Join-Path $EXTENSIONS_DIR "openclaw-qqbot"

if (-not (Test-Path $TARGET_DIR)) {
    # Fresh install: just move staging into place
    Move-Item -Path $STAGING_DIR -Destination $TARGET_DIR
} else {
    # In-place overwrite using robocopy /MIR (mirrors source to dest, works even with locked files)
    Write-Host "  Overwriting in-place with robocopy /MIR ..."
    $roboArgs = @($STAGING_DIR, $TARGET_DIR, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:3", "/W:2")
    $roboResult = & robocopy @roboArgs 2>&1
    $roboExit = $LASTEXITCODE
    # robocopy exit codes: 0-7 = success (various levels of copy), 8+ = error
    if ($roboExit -ge 8) {
        Write-Host "  robocopy failed (exit $roboExit), falling back to Copy-Item..." -ForegroundColor Yellow
        # Fallback: recursive Copy-Item -Force (overwrites files even if target exists)
        try {
            Copy-Item -Path (Join-Path $STAGING_DIR "*") -Destination $TARGET_DIR -Recurse -Force -ErrorAction Stop
            Write-Host "  Copy-Item fallback succeeded"
        } catch {
            Write-Host "  [ERROR] Copy-Item also failed: $($_.Exception.Message)" -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "  robocopy completed (exit $roboExit)"
    }
    # Clean up staging
    Remove-Item -Recurse -Force $STAGING_DIR -ErrorAction SilentlyContinue
}

# Clean up leftover directories
foreach ($leftover in @("openclaw-qqbot.staging", ".qqbot-upgrade-staging", ".qqbot-upgrade-old", ".openclaw-qqbot-new")) {
    $p = Join-Path $EXTENSIONS_DIR $leftover
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
$oldDir = Join-Path (Split-Path $EXTENSIONS_DIR -Parent) ".qqbot-upgrade-old"
if (Test-Path $oldDir) { Remove-Item -Recurse -Force $oldDir -ErrorAction SilentlyContinue }
foreach ($legacyName in @("qqbot", "openclaw-qq")) {
    $p = Join-Path $EXTENSIONS_DIR $legacyName
    if (Test-Path $p) { Remove-Item -Recurse -Force $p -ErrorAction SilentlyContinue }
}
Write-Host "  Installed to: $TARGET_DIR"

# [3/3] Verify installation
Write-Host ""
Write-Host "[3/3] Verifying installation..."
$NEW_VERSION = "unknown"
try {
    $newPkgPath = Join-Path $TARGET_DIR "package.json"
    if (Test-Path $newPkgPath) {
        $newPkg = Get-Content $newPkgPath -Raw | ConvertFrom-Json
        if ($newPkg.version) { $NEW_VERSION = $newPkg.version }
    }
} catch {}

Write-Host "QQBOT_NEW_VERSION=$NEW_VERSION"

if ($NEW_VERSION -ne "unknown") {
    Write-Host "QQBOT_REPORT=QQBot upgrade complete: v${NEW_VERSION}"
} else {
    Write-Host "QQBOT_REPORT=[WARN] QQBot upgrade status unknown, cannot confirm new version"
}

Write-Host ""
Write-Host "==========================================="
Write-Host "  File installation complete"
Write-Host "==========================================="

# --NoRestart mode
if ($NoRestart) {
    Write-Host ""
    Write-Host "[Skip restart] -NoRestart specified, exiting for caller to trigger gateway restart"
    exit 0
}

# [4/4] Configure appid/secret
if ($AppId -and $Secret) {
    Write-Host ""
    Write-Host "[Config] Writing qqbot channel config..."
    $DESIRED_TOKEN = "${AppId}:${Secret}"

    try {
        & $CMD channels add --channel qqbot --token $DESIRED_TOKEN 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  Channel config saved"
        } else { throw "channels add failed" }
    } catch {
        Write-Host "  [WARN] $CMD channels add failed, trying direct config edit..." -ForegroundColor Yellow
        $CONFIG_FILE = Join-Path (Join-Path $HOME_DIR ".$CMD") "$CMD.json"
        if (Test-Path $CONFIG_FILE) {
            try {
                $cfg = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
                if (-not $cfg.channels) { $cfg | Add-Member -NotePropertyName channels -NotePropertyValue @{} }
                if (-not $cfg.channels.qqbot) { $cfg.channels | Add-Member -NotePropertyName qqbot -NotePropertyValue @{} }
                $cfg.channels.qqbot | Add-Member -NotePropertyName appId -NotePropertyValue $AppId -Force
                $cfg.channels.qqbot | Add-Member -NotePropertyName clientSecret -NotePropertyValue $Secret -Force
                $cfg | ConvertTo-Json -Depth 10 | Set-Content $CONFIG_FILE -Encoding UTF8
                Write-Host "  Channel config saved (direct file edit)"
            } catch {
                Write-Host "  [ERROR] Config write failed, please configure manually:" -ForegroundColor Red
                Write-Host "     $CMD channels add --channel qqbot --token `"${AppId}:${Secret}`""
            }
        }
    }
} elseif ($AppId -or $Secret) {
    Write-Host ""
    Write-Host "[WARN] -AppId and -Secret must be provided together" -ForegroundColor Yellow
}

# [5/5] Restart gateway
Write-Host ""
Write-Host "[Restart] Restarting gateway..."
try {
    & $CMD gateway restart 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Gateway restarted"
    } else { throw "restart failed" }
} catch {
    Write-Host "  [WARN] Gateway restart failed, please run manually: $CMD gateway restart" -ForegroundColor Yellow
}
