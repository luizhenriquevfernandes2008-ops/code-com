@echo off
chcp 65001 >nul
title Code com (HTTPS - com voz na rede)
cd /d "%~dp0"

if not exist certificado.pem (
  echo.
  echo   Certificado nao encontrado.
  echo   Rode primeiro o gerar_certificado.bat
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================
echo     CODE COM  ^(HTTPS - voz liberada^)
echo   ============================================
echo.
echo   Abra no navegador:  https://localhost:8000
echo.

for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   Seus amigos na mesma rede:  https://%%b:8000
    goto :fim
)
:fim

echo.
echo   IMPORTANTE: o navegador vai avisar "conexao nao e particular".
echo   Isso e normal: o certificado e seu, feito na sua maquina.
echo   Clique em "Avancado" e depois em "Prosseguir".
echo.
echo   Para parar o servidor: Ctrl+C
echo.

python -m uvicorn server:app --host 0.0.0.0 --port 8000 ^
  --ssl-keyfile chave.pem --ssl-certfile certificado.pem

pause
