@echo off
chcp 65001 >nul
title Code com
cd /d "%~dp0"

echo.
echo   ============================================
echo     CODE COM
echo   ============================================
echo.

REM ---- 1) O Python esta instalado? ----------------------------------
python --version >nul 2>&1
if errorlevel 1 (
  echo   ERRO: nao encontrei o Python nesta maquina.
  echo.
  echo   Instale em https://python.org/downloads
  echo   e marque a caixinha "Add Python to PATH" durante a instalacao.
  echo.
  pause
  exit /b 1
)

REM ---- 2) A porta 8000 ja esta ocupada? -----------------------------
netstat -ano | findstr ":8000" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo   A porta 8000 ja esta em uso - o servidor talvez ja esteja aberto.
  echo.
  echo   Tente abrir http://localhost:8000 no navegador.
  echo   Se nao for isso, feche a outra janela preta do Code com
  echo   e rode este arquivo de novo.
  echo.
  pause
  exit /b 1
)

REM ---- 3) As bibliotecas estao instaladas? --------------------------
python -c "import fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
  echo   Faltam bibliotecas. Instalando ^(so na primeira vez^)...
  echo.
  python -m pip install fastapi "uvicorn[standard]" python-multipart
  echo.
)

echo   Abrindo o navegador em http://localhost:8000
echo.

REM Mostra o endereco pros amigos da mesma rede (wifi/casa)
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    for /f "tokens=1" %%b in ("%%a") do echo   Seus amigos na mesma rede:  http://%%b:8000
    goto :fim
)
:fim

echo.
echo   (a voz so funciona em localhost ou com HTTPS:
echo    para voz na rede, use o iniciar_com_voz.bat)
echo.
echo   Para parar o servidor: feche esta janela ou aperte Ctrl+C
echo   ============================================
echo.

REM Abre o navegador sozinho depois de 3s, ja com o servidor no ar.
REM Precisa ser em paralelo porque a linha de baixo trava esta janela.
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:8000"

python -m uvicorn server:app --host 0.0.0.0 --port 8000

echo.
echo   O servidor parou.
pause
