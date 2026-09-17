@echo off
chcp 65001 >nul
title Code com - ONLINE
cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo   ERRO: Python nao encontrado.
  echo   Instale em https://python.org/downloads
  echo   e marque "Add Python to PATH" durante a instalacao.
  echo.
  pause
  exit /b 1
)

python online.py

REM se o online.py fechar sozinho por algum erro inesperado,
REM a janela nao some antes de voce conseguir ler
if errorlevel 1 pause
