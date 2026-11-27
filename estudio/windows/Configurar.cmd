@echo off
cd /d "%~dp0"
if not exist worker.py (echo Pasta incompleta. Extraia o zip inteiro e abra este arquivo de dentro de estudio\windows. & pause & exit /b 1)
where rclone >nul 2>&1 || (echo Rode Instalar.cmd e abra esta janela novamente. & pause & exit /b 1)
rclone listremotes | findstr /x "samuka:" >nul || rclone config create samuka drive scope drive
if errorlevel 1 goto fim
py -3 worker.py --setup
:fim
pause
