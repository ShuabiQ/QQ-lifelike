@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  ==========================================================
echo    Starting QQ bot, please keep this window open.
echo    Closing this window = the bot stops running.
echo    (Chinese log lines below come from Node.js)
echo  ==========================================================
echo.
node src\index.js
echo.
echo  ----------------------------------------------------------
echo    Bot has exited. The messages above show why.
echo    Press any key to close this window.
echo  ----------------------------------------------------------
pause >nul
