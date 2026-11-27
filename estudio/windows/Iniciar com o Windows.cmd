@echo off
cd /d "%~dp0"
if not exist worker.py (echo Pasta incompleta. & pause & exit /b 1)
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Samuka Estudio.lnk');$s.TargetPath='%~dp0Iniciar.cmd';$s.WorkingDirectory='%~dp0';$s.WindowStyle=7;$s.Save()"
echo Pronto. O Estudio vai iniciar junto com o Windows.
pause
