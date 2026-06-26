@echo off
schtasks /query /tn "UpstoxOptionChainFetcher" /fo LIST
echo.
pause
