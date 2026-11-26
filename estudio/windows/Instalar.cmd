@echo off
setlocal
where winget >nul 2>&1 || (echo Instale o Instalador de Aplicativo da Microsoft Store. & pause & exit /b 1)
for %%P in (Python.Python.3.12 Rclone.Rclone Gyan.FFmpeg yt-dlp.yt-dlp DenoLand.Deno) do (
 winget install --id %%P --exact --accept-package-agreements --accept-source-agreements
)
echo Feche esta janela e abra Configurar.cmd para conectar sua conta.
pause
