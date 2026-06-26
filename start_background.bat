@echo off
echo Starting Upstox Option Chain Fetcher task...
schtasks /run /tn "UpstoxOptionChainFetcher"
echo.
pause
