$ErrorActionPreference = "Stop"

$PluginName = "opencode-v2-metrics-plugin"
$MarkerStart = "// OPENCODE_V2_METRICS_PLUGIN_BEGIN"
$MarkerEnd = "// OPENCODE_V2_METRICS_PLUGIN_END"
$PropertyMarkerStart = "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_BEGIN"
$PropertyMarkerEnd = "// OPENCODE_V2_METRICS_PLUGIN_PROPERTY_END"
$SourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Remove-MarkerBlock([string]$Text) {
  $pattern = "(?ms)\s*" + [regex]::Escape($MarkerStart) + ".*?" + [regex]::Escape($MarkerEnd) + ",?"
  return [regex]::Replace($Text, $pattern, "")
}

function Remove-PropertyMarkerBlock([string]$Text) {
  $pattern = "(?ms)\s*" + [regex]::Escape($PropertyMarkerStart) + ".*?" + [regex]::Escape($PropertyMarkerEnd) + ",?"
  return [regex]::Replace($Text, $pattern, "")
}

$configRoot = Split-Path (Split-Path $SourceRoot -Parent) -Parent
$manifestFile = Join-Path $SourceRoot "manifest.json"
if (-not (Test-Path $manifestFile)) {
  Write-Host "未找到安装清单，插件可能已经卸载。"
  exit 0
}

$manifest = Get-Content $manifestFile -Raw | ConvertFrom-Json
$configFile = [string]$manifest.configFile
$runtimeRoot = [string]$manifest.runtimeRoot

if (Test-Path $configFile) {
  $extension = [IO.Path]::GetExtension($configFile).ToLowerInvariant()
  if ($extension -eq ".json") {
    $object = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($null -ne $object.plugins) {
      $object.plugins = @($object.plugins | Where-Object { $_ -ne "./plugins/$PluginName" })
      if ($object.plugins.Count -eq 0) { $object.PSObject.Properties.Remove("plugins") }
      $object | ConvertTo-Json -Depth 100 | Set-Content $configFile -Encoding UTF8
    }
  } else {
    $clean = Remove-PropertyMarkerBlock (Remove-MarkerBlock (Get-Content $configFile -Raw))
    Set-Content -Path $configFile -Value $clean -Encoding UTF8
  }
}

if (Test-Path $runtimeRoot) { Remove-Item $runtimeRoot -Recurse -Force }

Write-Host "已卸载 $PluginName"
Write-Host "Downloads 中的插件源文件保留未动。"
Write-Host "持久卸载器保留在: $SourceRoot"
