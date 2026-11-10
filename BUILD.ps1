#requires -Version 5.1
param([string]$Go, [string]$Python)

$ErrorActionPreference = 'Stop'
$synoWakeTools = Join-Path (Split-Path -Parent $PSScriptRoot) 'SynoWake\work\toolchains'

function Resolve-Tool {
    param([string]$Requested, [string]$Name, [string]$Fallback, [string]$Option)
    if ($Requested) { return $Requested }
    $installed = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike '*\Microsoft\WindowsApps\*' } |
        Select-Object -First 1
    if ($installed) { return $installed.Source }
    $portable = Join-Path $synoWakeTools $Fallback
    if (Test-Path -LiteralPath $portable -PathType Leaf) { return $portable }
    throw "Cannot find $Name. Pass -$Option with the full executable path."
}

$Go = Resolve-Tool $Go 'go' 'go-1.27.1-amd64\go\bin\go.exe' 'Go'
$Python = Resolve-Tool $Python 'python' 'python-3.13.12-amd64\python.exe' 'Python'
& $Python (Join-Path $PSScriptRoot 'scripts\build.py') --go $Go
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
