@echo off
chcp 65001 >nul
title Code com - Atalho do Opera

echo Criando um atalho do Code com que abre no Opera...
echo.
set "SCRIPT=%~dp0Instalar Code com.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
echo.
pause
