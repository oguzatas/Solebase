<#
.SYNOPSIS
  Copy Prompt2UI core/ (+ optional icons/) into an example folder.

.EXAMPLE
  .\scripts\copy-core.ps1 -Target examples\calorie-tracker
  .\scripts\copy-core.ps1 -Target examples\notes -IncludeIcons
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Target,
  [switch]$IncludeIcons
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = if ([System.IO.Path]::IsPathRooted($Target)) { $Target } else { Join-Path $root $Target }

if (-not (Test-Path $dest)) {
  throw "Target folder not found: $dest"
}

$coreSrc = Join-Path $root 'core'
$coreDest = Join-Path $dest 'core'
if (Test-Path $coreDest) {
  Remove-Item -Recurse -Force $coreDest
}
Copy-Item -Recurse -Force $coreSrc $coreDest
Write-Host "Copied core/ → $coreDest"

if ($IncludeIcons) {
  $iconsSrc = Join-Path $root 'icons'
  $iconsDest = Join-Path $dest 'icons'
  if (Test-Path $iconsDest) {
    Remove-Item -Recurse -Force $iconsDest
  }
  Copy-Item -Recurse -Force $iconsSrc $iconsDest
  Write-Host "Copied icons/ → $iconsDest"
}

Write-Host 'Done. Each example stays independently servable (no symlinks).'
