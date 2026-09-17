@echo off
chcp 65001 >nul
title Code com - Anfitriao
set "CODECOM_PROJECT=%~dp0.."

if not exist "%CODECOM_PROJECT%\iniciar_online.bat" (
  echo Projeto do Code com nao encontrado ao lado desta pasta.
  echo Esta opcao e para o notebook que hospeda o servidor.
  pause
  exit /b 1
)

start "Code com - Link fixo" "%CODECOM_PROJECT%\iniciar_online.bat"
