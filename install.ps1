$ErrorActionPreference = "Stop"

$PluginName = "opencode-v2-metrics-plugin"
$MarkerStart = "// OPENCODE_V2_METRICS_PLUGIN_BEGIN"
$MarkerEnd = "// OPENCODE_V2_METRICS_PLUGIN_END"
$PropertyMarkerStart = "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_BEGIN"
$PropertyMarkerEnd = "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_END"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Get-ConfigRoot {
  if ($env:XDG_CONFIG_HOME) {
    return Join-Path $env:XDG_CONFIG_HOME "opencode"
  }
  return Join-Path $HOME ".config\opencode"
}

function Get-ConfigFile([string]$ConfigRoot) {
  $jsonc = Join-Path $ConfigRoot "opencode.jsonc"
  $json = Join-Path $ConfigRoot "opencode.json"
  if (Test-Path $jsonc) { return $jsonc }
  if (Test-Path $json) { return $json }
  return $jsonc
}

function Remove-MarkerBlock([string]$Text) {
  $pattern = "(?ms)\s*" + [regex]::Escape($MarkerStart) + ".*?" + [regex]::Escape($MarkerEnd) + ",?"
  return [regex]::Replace($Text, $pattern, "")
}

function Remove-PropertyMarkerBlock([string]$Text) {
  $pattern = "(?ms)\s*" + [regex]::Escape($PropertyMarkerStart) + ".*?" + [regex]::Escape($PropertyMarkerEnd) + ",?"
  return [regex]::Replace($Text, $pattern, "")
}

function Add-PluginEntry([string]$Text, [string]$ConfigExtension) {
  $entry = @"
    $MarkerStart
    "./plugins/$PluginName",
    $MarkerEnd
"@

  if ($ConfigExtension -eq ".json") {
    $object = $Text | ConvertFrom-Json
    $plugins = if ($null -eq $object.plugins) { @() } else { @($object.plugins) }
    if ($plugins -notcontains "./plugins/$PluginName") {
      $plugins += "./plugins/$PluginName"
    }
    $object | Add-Member -NotePropertyName plugins -NotePropertyValue $plugins -Force
    return ($object | ConvertTo-Json -Depth 100)
  }

  $clean = Remove-PropertyMarkerBlock (Remove-MarkerBlock $Text)
  $pluginsMatch = [regex]::Match($clean, '(?s)"plugins"\s*:\s*\[')
  if ($pluginsMatch.Success) {
    $position = $pluginsMatch.Index + $pluginsMatch.Length
    return $clean.Insert($position, "`r`n$entry")
  }

  $lastBrace = $clean.LastIndexOf("}")
  if ($lastBrace -lt 0) { throw "无法找到配置文件末尾。" }
  $before = $clean.Substring(0, $lastBrace).TrimEnd()
  $after = $clean.Substring($lastBrace)
  if (-not $before.EndsWith(",")) { $before += "," }
  $property = @"
  $PropertyMarkerStart
  "plugins": [
    $MarkerStart
    "./plugins/$PluginName",
    $MarkerEnd
  ]
  $PropertyMarkerEnd
"@
  return "$before`r`n$property`r`n$after"
}

$configRoot = Get-ConfigRoot
$configFile = Get-ConfigFile $configRoot
$runtimeRoot = Join-Path $configRoot "plugins\$PluginName"
$toolRoot = Join-Path $configRoot "plugin-tools\$PluginName"
$toolUninstaller = Join-Path $toolRoot "uninstall.ps1"
$toolManifest = Join-Path $toolRoot "manifest.json"
$backupDir = Join-Path $toolRoot "backups"

if (-not (Test-Path (Join-Path $SourceRoot "dist\gui-experimental.cjs"))) {
  throw "缺少 dist\gui-experimental.cjs，请使用完整压缩包。"
}

New-Item -ItemType Directory -Force $configRoot | Out-Null
New-Item -ItemType Directory -Force (Split-Path $configFile) | Out-Null
New-Item -ItemType Directory -Force $backupDir | Out-Null

if (Test-Path $configFile) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item $configFile (Join-Path $backupDir "opencode.$stamp.bak") -Force
  $configText = Get-Content $configFile -Raw
} else {
  $configText = @'
{
  "$schema": "https://opencode.ai/config.json"
}
'@
}

$configExtension = [IO.Path]::GetExtension($configFile).ToLowerInvariant()
$updatedConfig = Add-PluginEntry $configText $configExtension
Set-Content -Path $configFile -Value $updatedConfig -Encoding UTF8

$stageRoot = Join-Path $configRoot "plugins\.$PluginName.staging"
$oldRoot = Join-Path $configRoot "plugins\.$PluginName.previous"
if (Test-Path $stageRoot) { Remove-Item $stageRoot -Recurse -Force }
if (Test-Path $oldRoot) { Remove-Item $oldRoot -Recurse -Force }
New-Item -ItemType Directory -Force $stageRoot | Out-Null
Copy-Item (Join-Path $SourceRoot "package.json") (Join-Path $stageRoot "package.json") -Force
Copy-Item (Join-Path $SourceRoot "src") (Join-Path $stageRoot "src") -Recurse -Force
Copy-Item (Join-Path $SourceRoot "dist") (Join-Path $stageRoot "dist") -Recurse -Force

if (Test-Path $runtimeRoot) { Move-Item $runtimeRoot $oldRoot -Force }
try {
  Move-Item $stageRoot $runtimeRoot -Force
  if (Test-Path $oldRoot) { Remove-Item $oldRoot -Recurse -Force }
} catch {
  if (Test-Path $runtimeRoot) { Remove-Item $runtimeRoot -Recurse -Force }
  if (Test-Path $oldRoot) { Move-Item $oldRoot $runtimeRoot -Force }
  throw
}

New-Item -ItemType Directory -Force $toolRoot | Out-Null
Copy-Item (Join-Path $SourceRoot "uninstall.ps1") $toolUninstaller -Force

$manifest = [ordered]@{
  plugin = $PluginName
  configFile = $configFile
  runtimeRoot = $runtimeRoot
  toolRoot = $toolRoot
  markerStart = $MarkerStart
  markerEnd = $MarkerEnd
  propertyMarkerStart = $PropertyMarkerStart
  propertyMarkerEnd = $PropertyMarkerEnd
  version = (Get-Content (Join-Path $SourceRoot "package.json") -Raw | ConvertFrom-Json).version
  installedAt = (Get-Date).ToString("o")
}
$manifest | ConvertTo-Json | Set-Content $toolManifest -Encoding UTF8

Write-Host "已安装 $PluginName"
Write-Host "配置文件: $configFile"
Write-Host "运行目录: $runtimeRoot"
Write-Host "OpenCode 会自动重新加载；如未显示，请执行 /reload。"
