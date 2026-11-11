# Phase 8 evidence traffic from a Windows PC (double-click RUN_PHASE8_DEMO.bat, which calls this file).
# Sends every scenario of scripts/observability_demo.py to the EC2 API so each one appears as a trace in Logfire,
# and saves the console output (job ids to search in Logfire) to loadtest\results\phase8_demo_console.log.
# Scenarios 4 and 5 (retries) only work while ALLOW_FAILURE_SIMULATION=true on the server.
param([string]$ApiUrl = "http://13.236.244.226:8000")
$ErrorActionPreference = "Stop"
$Service = Split-Path -Parent $PSScriptRoot          # ...\signature_service
Set-Location $Service
New-Item -ItemType Directory -Force -Path "loadtest\results" | Out-Null
Start-Transcript -Path "loadtest\results\phase8_demo_console.log" -Force | Out-Null
try {
    $vpy = Join-Path $Service "loadtest\.venv\Scripts\python.exe"
    if (-not (Test-Path $vpy)) {
        $exe = (cmd /c "py -3 -c ""import sys; print(sys.executable)"" 2>nul")
        if (-not $exe) { $exe = (cmd /c "python -c ""import sys; print(sys.executable)"" 2>nul") }
        if (-not $exe) { throw "Python 3 not found (python.org, tick 'Add python.exe to PATH')." }
        & $exe.Trim() -m venv "loadtest\.venv"
    }
    & $vpy -m pip install --quiet requests pillow
    $line = Get-Content ".env" | Where-Object { $_ -match '^PIPELINE_ADMIN_TOKEN=' } | Select-Object -First 1
    $token = ($line -replace '^PIPELINE_ADMIN_TOKEN=', '').Trim()
    $image = Get-ChildItem "loadtest\images" -Filter *.jpg -ErrorAction SilentlyContinue | Select-Object -First 1
    $demoArgs = @("scripts\observability_demo.py", "--url", $ApiUrl, "--admin-token", $token)
    if ($image) { $demoArgs += @("--image", $image.FullName) }
    & $vpy @args
    Write-Host ""
    Write-Host "PHASE 8 DEMO FINISHED $(Get-Date -Format o)"
}
catch { Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red }
finally { Stop-Transcript | Out-Null }
