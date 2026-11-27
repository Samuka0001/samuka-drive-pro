@echo off
setlocal
cd /d "%~dp0"
if not exist worker.py (echo Pasta incompleta. Extraia o zip inteiro e abra este arquivo de dentro de estudio\windows. & pause & exit /b 1)
where winget >nul 2>&1 || (echo Instale o Instalador de Aplicativo da Microsoft Store. & pause & exit /b 1)
for %%P in (Python.Python.3.12 Rclone.Rclone Gyan.FFmpeg yt-dlp.yt-dlp DenoLand.Deno) do (
 winget install --id %%P --exact --accept-package-agreements --accept-source-agreements
)
echo Feche esta janela e abra Configurar.cmd para conectar sua conta.
pause
