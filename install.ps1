[CmdletBinding()]
param(
  [switch]$KeepBackup
)

$ErrorActionPreference = "Stop"

$PluginName = "opencode-v2-metrics-plugin"
$LegacyEntry = "./plugins/$PluginName"

function Get-ConfigRoot {
  $xdg = [Environment]::GetEnvironmentVariable("XDG_CONFIG_HOME")
  if ($xdg) { return (Join-Path $xdg "opencode") }
  return (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".config\opencode")
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $parent = Split-Path -Parent $Path
  if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Write-JsonFile {
  param([string]$Path, [object]$Value)
  Write-Utf8NoBom $Path (($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine)
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Remove-MarkerBlock {
  param([string]$Text, [string]$Start, [string]$End)
  $pattern = "(?ms)\s*" + [regex]::Escape($Start) + ".*?" + [regex]::Escape($End) + ",?"
  return [regex]::Replace($Text, $pattern, "")
}

function Remove-LegacyConfigEntry {
  param([string]$ConfigFile)
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return }

  $extension = [IO.Path]::GetExtension($ConfigFile).ToLowerInvariant()
  if ($extension -eq ".json") {
    $object = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
    if ($null -eq $object.plugins) { return }
    $before = @($object.plugins)
    $after = @($before | Where-Object { [string]$_ -ne $LegacyEntry })
    if ($after.Count -eq $before.Count) { return }
    if ($after.Count -eq 0) {
      $object.PSObject.Properties.Remove("plugins")
    } else {
      $object.plugins = $after
    }
    Write-JsonFile $ConfigFile $object
    return
  }

  $text = Get-Content -LiteralPath $ConfigFile -Raw
  $clean = Remove-MarkerBlock $text "// OPENCODE_V2_METRICS_PLUGIN_BEGIN" "// OPENCODE_V2_METRICS_PLUGIN_END"
  $clean = Remove-MarkerBlock $clean "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_BEGIN" "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_END"
  $clean = [regex]::Replace($clean, '(?m)^\s*"\./plugins/opencode-v2-metrics-plugin"\s*,?\s*\r?\n', "")
  if ($clean -ne $text) { Write-Utf8NoBom $ConfigFile $clean }
}

function Remove-LegacyArtifacts {
  param([string]$ConfigRoot)
  foreach ($configFile in @(
    (Join-Path $ConfigRoot "opencode.jsonc"),
    (Join-Path $ConfigRoot "opencode.json")
  )) {
    Remove-LegacyConfigEntry $configFile
  }

  foreach ($path in @(
    (Join-Path $ConfigRoot "plugin-tools\$PluginName"),
    (Join-Path $ConfigRoot "plugins\.$PluginName.staging"),
    (Join-Path $ConfigRoot "plugins\.$PluginName.previous")
  )) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}

function Remove-EmptyDirectories {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
  Get-ChildItem -LiteralPath $Root -Directory -Recurse -Force |
    Sort-Object { $_.FullName.Length } -Descending |
    ForEach-Object {
      if (@(Get-ChildItem -LiteralPath $_.FullName -Force).Count -eq 0) {
        Remove-Item -LiteralPath $_.FullName -Force
      }
    }
}

$packageRoot = $PSScriptRoot
$manifest = Read-JsonFile (Join-Path $packageRoot "manifest.json")
if (-not $manifest -or $manifest.id -ne $PluginName) {
  throw "安装包 manifest.json 无效或插件 ID 不匹配。"
}

$configRoot = Get-ConfigRoot
$pluginRoot = Join-Path $configRoot "plugins\$PluginName"
$dataRoot = Join-Path $configRoot "$PluginName-data"
$statePath = Join-Path $dataRoot "install-state.json"
$uninstallerRoot = Join-Path $configRoot "uninstallers\$PluginName"
$stagingRoot = Join-Path $configRoot "plugins\.$PluginName-staging-$PID"
$backupRoot = Join-Path $configRoot "plugins\.$PluginName-backup-$PID"

New-Item -ItemType Directory -Path $configRoot, (Split-Path -Parent $pluginRoot), $dataRoot, $uninstallerRoot -Force | Out-Null
Remove-LegacyArtifacts $configRoot

$oldState = Read-JsonFile $statePath
$oldFiles = if ($oldState -and $oldState.ownedFiles) {
  @($oldState.ownedFiles)
} else {
  @("package.json", "src\index.ts", "src\rpc.ts", "src\gui.tsx", "dist\gui-experimental.cjs")
}
$newFiles = @($manifest.pluginFiles)

try {
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
  foreach ($relativeFile in $newFiles) {
    $source = Join-Path $packageRoot ([string]$relativeFile)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      throw "安装包缺少文件：$relativeFile"
    }
    $staged = Join-Path $stagingRoot ([string]$relativeFile)
    New-Item -ItemType Directory -Path (Split-Path -Parent $staged) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $staged -Force
  }

  if (Test-Path -LiteralPath $pluginRoot) {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($relativeFile in $oldFiles) {
      $oldFile = Join-Path $pluginRoot ([string]$relativeFile)
      if (-not (Test-Path -LiteralPath $oldFile -PathType Leaf)) { continue }
      $backupFile = Join-Path $backupRoot ([string]$relativeFile)
      New-Item -ItemType Directory -Path (Split-Path -Parent $backupFile) -Force | Out-Null
      Copy-Item -LiteralPath $oldFile -Destination $backupFile -Force
    }
    foreach ($relativeFile in $oldFiles) {
      $oldFile = Join-Path $pluginRoot ([string]$relativeFile)
      if (Test-Path -LiteralPath $oldFile -PathType Leaf) { Remove-Item -LiteralPath $oldFile -Force }
    }
    Remove-EmptyDirectories $pluginRoot
  }

  New-Item -ItemType Directory -Path $pluginRoot -Force | Out-Null
  foreach ($relativeFile in $newFiles) {
    $staged = Join-Path $stagingRoot ([string]$relativeFile)
    $destination = Join-Path $pluginRoot ([string]$relativeFile)
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $staged -Destination $destination -Force
  }

  $state = [ordered]@{
    id = $manifest.id
    version = $manifest.version
    pluginRoot = $pluginRoot
    dataRoot = $dataRoot
    uninstallerRoot = $uninstallerRoot
    ownedFiles = $newFiles
    installedAt = [DateTime]::UtcNow.ToString("o")
  }
  Write-JsonFile $statePath $state

  Copy-Item -LiteralPath (Join-Path $packageRoot "uninstall.ps1") -Destination (Join-Path $uninstallerRoot "uninstall.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $packageRoot "uninstall.cmd") -Destination (Join-Path $uninstallerRoot "uninstall.cmd") -Force

  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (-not $KeepBackup) { Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue }

  Write-Host "安装/更新成功：$($manifest.id) v$($manifest.version)"
  Write-Host "插件目录：$pluginRoot"
  Write-Host "卸载器：$(Join-Path $uninstallerRoot 'uninstall.cmd')"
  Write-Host "如 OpenCode 未自动发现变更，请在 TUI/桌面版执行 /reload。"
} catch {
  Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($relativeFile in $newFiles) {
    $newFile = Join-Path $pluginRoot ([string]$relativeFile)
    if (Test-Path -LiteralPath $newFile -PathType Leaf) { Remove-Item -LiteralPath $newFile -Force }
  }
  if (Test-Path -LiteralPath $backupRoot) {
    foreach ($relativeFile in $oldFiles) {
      $backupFile = Join-Path $backupRoot ([string]$relativeFile)
      if (-not (Test-Path -LiteralPath $backupFile -PathType Leaf)) { continue }
      $restoreFile = Join-Path $pluginRoot ([string]$relativeFile)
      New-Item -ItemType Directory -Path (Split-Path -Parent $restoreFile) -Force | Out-Null
      Copy-Item -LiteralPath $backupFile -Destination $restoreFile -Force
    }
  }
  if ($oldState) { Write-JsonFile $statePath $oldState }
  elseif (Test-Path -LiteralPath $statePath) { Remove-Item -LiteralPath $statePath -Force }
  throw
}
