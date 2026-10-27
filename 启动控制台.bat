@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ==========================================================
echo    Web console starting (the QQ bot is NOT running yet).
echo    Open  http://127.0.0.1:7788  and click "Start bot".
echo    Closing this window stops the console and the bot.
echo  ==========================================================
echo.
node src\launcher.js
echo.
echo  Console exited. Press any key to close.
pause >nul
