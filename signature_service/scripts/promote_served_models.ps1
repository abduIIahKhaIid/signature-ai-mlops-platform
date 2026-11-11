# Create the 'production' aliases from the models the workers serve right now (docs/setup/model_promotion.md, step 3).
# Double-click PROMOTE_SERVED_MODELS.bat. Reads PIPELINE_ADMIN_TOKEN from signature_service\.env (never printed).
param([string]$ApiUrl = "http://13.236.244.226:8000")
$ErrorActionPreference = "Stop"
$Service = Split-Path -Parent $PSScriptRoot
Set-Location $Service
New-Item -ItemType Directory -Force -Path "loadtest\results" | Out-Null
Start-Transcript -Path "loadtest\results\promote_console.log" -Force | Out-Null
try {
    $line = Get-Content ".env" | Where-Object { $_ -match '^PIPELINE_ADMIN_TOKEN=' } | Select-Object -First 1
    $headers = @{ "X-Admin-Token" = ($line -replace '^PIPELINE_ADMIN_TOKEN=', '').Trim() }
    $served = (Invoke-RestMethod -Uri "$ApiUrl/v1/model" -TimeoutSec 60).result
    Write-Host "served now: detector $($served.detector_version) | similarity $($served.similarity_version)"
    $reason = "bootstrap: model served before the promotion gate existed (approved by the owner $(Get-Date -Format yyyy-MM-dd))"
    foreach ($m in @(@("detection", $served.detector_version), @("similarity", $served.similarity_version))) {
        if (-not $m[1]) { Write-Host "skip $($m[0]): no version served"; continue }
        $body = @{ model = $m[0]; version = $m[1]; reason = $reason } | ConvertTo-Json
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$ApiUrl/v1/pipeline/promote" -Headers $headers `
                 -ContentType "application/json" -Body $body -TimeoutSec 120
            Write-Host "PROMOTED $($m[0]) $($m[1]): $($r | ConvertTo-Json -Compress -Depth 6)"
        } catch {
            $detail = $_.ErrorDetails.Message
            Write-Host "FAILED $($m[0]) $($m[1]): $($_.Exception.Message) $detail" -ForegroundColor Red
        }
    }
    $state = Invoke-RestMethod -Uri "$ApiUrl/v1/pipeline/state" -TimeoutSec 60
    Write-Host "aliases now: $($state.serving.aliases | ConvertTo-Json -Compress -Depth 6)"
    Write-Host "PROMOTE FINISHED"
}
catch { Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red }
finally { Stop-Transcript | Out-Null }
