<#
.SYNOPSIS
  Windows wrapper for the existing bash-based doctor script.
.DESCRIPTION
  Prefers Git Bash / bash.exe when available. Falls back to a clear message
  when bash is missing, because the full diagnostics live in doctor.sh.
#>

$ErrorActionPreference = 'Stop'

$doctorScript = Join-Path (Split-Path -Parent $PSCommandPath) 'doctor.sh'

if (-not (Test-Path $doctorScript)) {
    Write-Error "doctor.sh not found at $doctorScript"
    exit 1
}

$bash = Get-Command bash -ErrorAction SilentlyContinue
if (-not $bash) {
    Write-Host "bash was not found in PATH."
    Write-Host "Install Git Bash or another bash environment, then run:"
    Write-Host "  bash `"$doctorScript`""
    exit 1
}

& $bash.Source $doctorScript
exit $LASTEXITCODE
