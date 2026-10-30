[CmdletBinding()]
param(
  [switch]$Worker,
  [switch]$KeepData,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$PluginName = "opencode-v2-metrics-plugin"
$LegacyEntry = "./plugins/$PluginName"

function Get-ConfigRoot {
  $xdg = [Environment]::GetEnvironmentVariable("XDG_CONFIG_HOME")
  if ($xdg) { return (Join-Path $xdg "opencode") }
  return (Join-Path ([Environment]::GetFolderPath("UserProfile")) ".config\opencode")
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
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
    if ($after.Count -eq 0) { $object.PSObject.Properties.Remove("plugins") }
    else { $object.plugins = $after }
    Write-Utf8NoBom $ConfigFile (($object | ConvertTo-Json -Depth 30) + [Environment]::NewLine)
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
  )) { Remove-LegacyConfigEntry $configFile }
  foreach ($path in @(
    (Join-Path $ConfigRoot "plugin-tools\$PluginName"),
    (Join-Path $ConfigRoot "plugins\.$PluginName.staging"),
    (Join-Path $ConfigRoot "plugins\.$PluginName.previous")
  )) { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force } }
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

if (-not $Worker) {
  $workerScript = Join-Path $env:TEMP "opencode-v2-metrics-uninstall-$PID.ps1"
  Copy-Item -LiteralPath $PSCommandPath -Destination $workerScript -Force
  $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
  $powershell = if ($pwsh) { $pwsh.Source } else { (Get-Command powershell).Source }
  $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $workerScript, "-Worker")
  if ($KeepData) { $arguments += "-KeepData" }
  if ($Force) { $arguments += "-Force" }
  & $powershell @arguments
  $exitCode = $LASTEXITCODE
  Remove-Item -LiteralPath $workerScript -Force -ErrorAction SilentlyContinue
  exit $exitCode
}

$configRoot = Get-ConfigRoot
$defaultPluginRoot = Join-Path $configRoot "plugins\$PluginName"
$defaultDataRoot = Join-Path $configRoot "$PluginName-data"
$defaultUninstallerRoot = Join-Path $configRoot "uninstallers\$PluginName"
$statePath = Join-Path $defaultDataRoot "install-state.json"
$state = Read-JsonFile $statePath
$pluginRoot = if ($state -and $state.pluginRoot) { [string]$state.pluginRoot } else { $defaultPluginRoot }
$dataRoot = if ($state -and $state.dataRoot) { [string]$state.dataRoot } else { $defaultDataRoot }
$uninstallerRoot = if ($state -and $state.uninstallerRoot) { [string]$state.uninstallerRoot } else { $defaultUninstallerRoot }
$ownedFiles = if ($state -and $state.ownedFiles) { @($state.ownedFiles) } else { @("package.json", "src\index.ts", "src\rpc.ts", "src\gui.tsx", "dist\gui-experimental.cjs") }

if (-not $Force) {
  $answer = Read-Host "确认卸载 OpenCode V2 Metrics 插件？输入 Y 继续"
  if ($answer -notmatch "^(?i:y|yes|是)$") { Write-Host "已取消。"; exit 0 }
}

foreach ($relativeFile in $ownedFiles) {
  $path = Join-Path $pluginRoot ([string]$relativeFile)
  if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}
Remove-EmptyDirectories $pluginRoot
if (Test-Path -LiteralPath $pluginRoot -PathType Container) {
  $remaining = @(Get-ChildItem -LiteralPath $pluginRoot -Force)
  if ($remaining.Count -eq 0) { Remove-Item -LiteralPath $pluginRoot -Force }
  else { Write-Host "插件目录中存在未由安装器管理的文件，已保留：$pluginRoot" }
}

Remove-LegacyArtifacts $configRoot
if (-not $KeepData -and (Test-Path -LiteralPath $dataRoot)) { Remove-Item -LiteralPath $dataRoot -Recurse -Force }
if (Test-Path -LiteralPath $uninstallerRoot) { Remove-Item -LiteralPath $uninstallerRoot -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host "卸载完成。OpenCode 如未自动更新，请执行 /reload。"
