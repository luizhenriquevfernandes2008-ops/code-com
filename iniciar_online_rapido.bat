@echo off
chcp 65001 >nul
title Code com - LINK TEMPORARIO
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

python online.py --quick

if errorlevel 1 pause
