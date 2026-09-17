@echo off
chcp 65001 >nul
echo.
echo  === Gerando certificado para liberar o microfone na rede ===
echo.

REM Descobre o IP da sua maquina na rede local
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do set IP=%%b
    goto :achou
)
:achou

echo  Seu IP na rede: %IP%
echo.

REM Certificado auto-assinado, valido por 1 ano, valendo pro seu IP e pra localhost
openssl req -x509 -newkey rsa:2048 -nodes -days 365 ^
  -keyout chave.pem -out certificado.pem ^
  -subj "/CN=%IP%" ^
  -addext "subjectAltName=IP:%IP%,IP:127.0.0.1,DNS:localhost"

if errorlevel 1 (
  echo.
  echo  ERRO: o openssl nao foi encontrado.
  echo  Ele vem junto com o Git para Windows ^(em C:\Program Files\Git\mingw64\bin^).
  echo  Adicione essa pasta ao PATH ou rode este script pelo Git Bash.
  pause
  exit /b 1
)

echo.
echo  Pronto! Foram criados: certificado.pem e chave.pem
echo  Agora use o iniciar_com_voz.bat
echo.
pause
