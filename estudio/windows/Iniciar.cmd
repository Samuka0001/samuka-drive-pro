@echo off
cd /d "%~dp0"
if not exist worker.py (echo Pasta incompleta. Extraia o zip inteiro e abra este arquivo de dentro de estudio\windows. & pause & exit /b 1)
py -3 worker.py
pause
