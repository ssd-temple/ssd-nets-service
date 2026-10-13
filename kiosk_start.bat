@echo off
cd /d "C:\kiosk\kioskservice"

:: Stop the app
start /b "" pm2 stop runScript.json

:: Wait for the app to stop
timeout /t 5

:: Start the app
start /b "" pm2 start runScript.json