$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

if (-not $env:PORT) {
  $env:PORT = "9000"
}

py -3.12 main.py
