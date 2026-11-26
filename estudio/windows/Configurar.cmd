@echo off
cd /d "%~dp0"
where rclone >nul 2>&1 || (echo Rode Instalar.cmd e abra esta janela novamente. & pause & exit /b 1)
rclone listremotes | findstr /x "samuka:" >nul || rclone config create samuka drive scope drive
if errorlevel 1 goto fim
py -3 worker.py --setup
:fim
pause
