# Phase 9 stress test from a Windows PC (double-click RUN_PHASE9_STRESS_TEST.bat, which calls this file).
# 1) makes a Python venv with Locust, 2) reads PIPELINE_ADMIN_TOKEN from signature_service\.env,
# 3) runs Locust against the EC2 API: 1 -> 5 -> 10 -> 20 -> 40 users, 90 s each (about 8 minutes),
# 4) writes loadtest\results\ec2_t3large_* (git-ignored raw data). Then build the report:
#      python loadtest\report.py --run loadtest\results\ec2_t3large --instance "..." --workers "..."
param(
    [string]$ApiUrl = "http://13.236.244.226:8000",
    [string]$Steps = "1,5,10,20,40",
    [int]$StepSeconds = 90,
    [string]$RunName = "ec2_t3large"
)
$ErrorActionPreference = "Stop"
$Service = Split-Path -Parent $PSScriptRoot          # ...\signature_service
Set-Location $Service
New-Item -ItemType Directory -Force -Path "loadtest\results" | Out-Null
Start-Transcript -Path "loadtest\results\${RunName}_console.log" -Force | Out-Null

function Find-Python {
    # returns the full path of a Python 3 interpreter (py launcher first, then python on PATH)
    foreach ($cmd in @("py -3", "python")) {
        try {
            $exe = (cmd /c "$cmd -c ""import sys; print(sys.executable)"" 2>nul")
            if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { return $exe.Trim() }
        } catch {}
    }
    throw "Python 3 not found. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH')."
}

try {
    Write-Host "== 1/4 Python environment (loadtest\.venv)"
    if (-not (Test-Path "loadtest\.venv\Scripts\python.exe")) {
        $py = Find-Python
        Write-Host "   using $py"
        & $py -m venv "loadtest\.venv"
    }
    $vpy = Join-Path $Service "loadtest\.venv\Scripts\python.exe"
    & $vpy -m pip install --quiet --upgrade pip
    & $vpy -m pip install --quiet locust requests pillow matplotlib
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

    Write-Host "== 2/4 admin token from signature_service\.env (not printed)"
    $line = Get-Content ".env" | Where-Object { $_ -match '^PIPELINE_ADMIN_TOKEN=' } | Select-Object -First 1
    if (-not $line) { throw "PIPELINE_ADMIN_TOKEN missing in signature_service\.env" }
    $env:ADMIN_TOKEN = ($line -replace '^PIPELINE_ADMIN_TOKEN=', '').Trim()

    Write-Host "== 3/4 server check: $ApiUrl"
    $health = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 30
    Write-Host ("   health: " + ($health | ConvertTo-Json -Compress))
    $model = Invoke-RestMethod -Uri "$ApiUrl/v1/model" -TimeoutSec 30
    Write-Host ("   model:  " + ($model | ConvertTo-Json -Compress -Depth 3))

    Write-Host "== 4/4 Locust: steps $Steps users, $StepSeconds s each (do not close this window)"
    $env:STEPS = $Steps
    $env:STEP_SECONDS = "$StepSeconds"
    $env:RUN_NAME = $RunName
    $env:IMAGES_DIR = Join-Path $Service "loadtest\images"
    $env:RESULTS_DIR = Join-Path $Service "loadtest\results"
    & $vpy -m locust -f "loadtest\locustfile.py" --host $ApiUrl --headless `
        --csv "loadtest\results\$RunName" --html "loadtest\results\$RunName.html" --only-summary
    Write-Host ""
    Write-Host "PHASE 9 LOAD TEST FINISHED. Raw data: signature_service\loadtest\results\$RunName*"
}
catch {
    Write-Host ""
    Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
    Stop-Transcript | Out-Null
}
