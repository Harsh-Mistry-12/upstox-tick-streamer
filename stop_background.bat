@echo off
echo Stopping Upstox Option Chain Fetcher task...
schtasks /end /tn "UpstoxOptionChainFetcher"
echo.
pause
