# Run this script to register the Windows Scheduled Task for the Upstox Option Chain Fetcher.
# It is recommended to run this in an Administrator PowerShell console to ensure permissions are granted.

$ScriptDir = Split-Path -Parent -Path $MyInvocation.MyCommand.Definition
if ([string]::IsNullOrEmpty($ScriptDir)) {
    $ScriptDir = Get-Location
}

$TaskName = "UpstoxOptionChainFetcher"
$PythonPath = Join-Path $ScriptDir ".venv\Scripts\pythonw.exe"
$ScriptPath = Join-Path $ScriptDir "upstox_option_chain_merged.py"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Registering Windows Scheduled Task for Upstox Option Chain" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Project Directory: $ScriptDir"
Write-Host "Python Path:       $PythonPath"
Write-Host "Script Path:       $ScriptPath"

# Verify path existence
if (-not (Test-Path $PythonPath)) {
    Write-Host "[ERROR] Could not find pythonw.exe in .venv\Scripts." -ForegroundColor Red
    Write-Host "Please ensure your virtual environment is created at .venv and requirements are installed." -ForegroundColor Red
    exit 1
}

# Define the action
$Action = New-ScheduledTaskAction -Execute $PythonPath -Argument "`"$ScriptPath`"" -WorkingDirectory $ScriptDir

# Define the trigger (At logon of the current user)
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser

# Define settings:
# - Allow start on batteries
# - Do not stop when going on battery
# - Zero execution time limit (runs infinitely)
# - Restart 3 times on failure, every 1 minute
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([System.TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

# Register the task
$Task = New-ScheduledTask -Action $Action -Trigger $Trigger -Settings $Settings
try {
    Register-ScheduledTask -TaskName $TaskName -InputObject $Task -Force -ErrorAction Stop
    Write-Host "`n[SUCCESS] Task '$TaskName' registered successfully!" -ForegroundColor Green
    Write-Host "The task will run automatically when you log in." -ForegroundColor Green
    Write-Host "You can also control it manually using the provided batch files:" -ForegroundColor Green
    Write-Host "  - start_background.bat  (Starts the task)" -ForegroundColor Green
    Write-Host "  - stop_background.bat   (Stops the task)" -ForegroundColor Green
    Write-Host "  - check_status.bat      (Queries the task status)" -ForegroundColor Green
} catch {
    Write-Host "`n[ERROR] Failed to register the scheduled task: $_" -ForegroundColor Red
    Write-Host "Please run this script in an Administrator PowerShell console." -ForegroundColor Yellow
}
