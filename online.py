"""
Liga o Code com no modo ONLINE.

Faz tres coisas que o .bat sozinho nao fazia bem:
  1. pesca o endereco publico no log do Tailscale Funnel ou Cloudflare
  2. mostra ele limpo, copia pra area de transferencia e abre o navegador
  3. derruba servidor E tunel juntos - no Ctrl+C e tambem quando a
     janela e fechada no X, pra nao sobrar ninguem segurando a porta

Rode pelo iniciar_online.bat (ou "python online.py"). O modo padrao usa
Tailscale Funnel para manter o mesmo endereco HTTPS entre inicializacoes;
use --quick para gerar um link temporario do Cloudflare.
"""

import argparse
import ctypes
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from ctypes import wintypes

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PORTA = 8000

# Enderecos publico do Cloudflare Quick Tunnel e do Tailscale Funnel.
PADRAO_URL = re.compile(
    r"https://[a-z0-9-]+\.(?:trycloudflare\.com|[a-z0-9-]+\.ts\.net)",
    re.IGNORECASE,
)
PADRAO_ATIVACAO = re.compile(r"https://login\.tailscale\.com/f/funnel\?node=[A-Za-z0-9_-]+")

# Onde o cloudflared costuma ficar no Windows
LUGARES_CLOUDFLARED = [
    r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    r"C:\Program Files\cloudflared\cloudflared.exe",
]

# O instalador oficial nem sempre adiciona o executavel ao PATH.
LUGARES_TAILSCALE = [
    r"C:\Program Files\Tailscale\tailscale.exe",
    r"C:\Program Files (x86)\Tailscale\tailscale.exe",
]


# =====================================================================
#  Fazer os filhos morrerem junto com esta janela
# =====================================================================
# Fechar o console no X nao e Ctrl+C: o Windows mata SO este processo e o
# bloco finally nunca roda. O uvicorn filho sobrevive segurando a porta
# 8000 e, na proxima execucao, nao existe "outra janela preta" pra fechar.
#
# O Job Object resolve isso na raiz: tudo que entra no job morre quando o
# ultimo handle dele fecha - e o Windows fecha os handles de um processo
# que termina, nao importa como ele terminou.

_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
# sem declarar o restype, o handle volta cortado em 32 bits e nao serve
_kernel32.CreateJobObjectW.restype = wintypes.HANDLE
_kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
_kernel32.SetInformationJobObject.restype = wintypes.BOOL
_kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
_kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
_kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100

# O handle do job e a funcao do handler precisam continuar vivos ate o fim
# do programa. Se o Python coletar o handle do job antes da hora, os filhos
# morrem na hora errada - no meio da conversa.
JOB = None
_HANDLER = None

# Todo filho que nasce entra aqui, pra limpeza saber quem derrubar
FILHOS = []


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong)]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD)]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


def criar_job():
    """Cria o Job Object marcado como 'mata todo mundo ao fechar'."""
    try:
        job = _kernel32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = _kernel32.SetInformationJobObject(
            job, JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            _kernel32.CloseHandle(job)
            return None
        return job
    except Exception:
        return None


def adotar(job, processo) -> bool:
    """Coloca um filho recem-criado dentro do job."""
    if not job:
        return False
    handle = _kernel32.OpenProcess(
        PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, processo.pid)
    if not handle:
        return False
    try:
        return bool(_kernel32.AssignProcessToJobObject(job, handle))
    finally:
        _kernel32.CloseHandle(handle)


def matar_arvore(pid: int):
    """Mata o processo e os filhos dele.

    /T pega a arvore inteira - o terminate() do Python so alcanca o
    processo de cima - e /F porque quem esta travado nao vai colaborar.
    """
    try:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(pid)],
                       capture_output=True, timeout=15)
    except Exception:
        pass


def limpar_filhos():
    """Rede de seguranca: derruba a arvore de todo filho que sobrou."""
    for p in FILHOS:
        try:
            if p.poll() is None:
                matar_arvore(p.pid)
        except Exception:
            pass


def registrar_fechar_janela():
    """Plano B de quando o Job Object nao pode ser criado.

    Aqui a gente escuta o evento de fechar a janela, que e justamente o
    caso que o try/finally nao cobre. E plano B mesmo: um encerramento
    forcado pelo Gerenciador de Tarefas passa por cima disso.
    """
    global _HANDLER
    CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT = 2, 5, 6

    def handler(evento):
        if evento in (CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT):
            # o Windows da poucos segundos aqui, por isso e taskkill direto
            limpar_filhos()
        # False = "nao tratei"; o Windows segue encerrando o programa e o
        # Ctrl+C continua caindo no tratamento normal do Python
        return False

    try:
        _HANDLER = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)(handler)
        _kernel32.SetConsoleCtrlHandler(_HANDLER, True)
    except Exception:
        pass


def achar_cloudflared():
    caminho = shutil.which("cloudflared")
    if caminho:
        return caminho
    for c in LUGARES_CLOUDFLARED:
        if os.path.isfile(c):
            return c
    return None


def achar_tailscale():
    caminho = shutil.which("tailscale")
    if caminho:
        return caminho
    for c in LUGARES_TAILSCALE:
        if os.path.isfile(c):
            return c
    return None


def obter_endereco_tailscale(caminho):
    """Retorna o DNS HTTPS estavel desta maquina, se o Tailscale estiver logado."""
    try:
        resultado = subprocess.run(
            [caminho, "status", "--json"], capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=20,
        )
        dados = json.loads(resultado.stdout)
        dns = dados.get("Self", {}).get("DNSName", "").rstrip(".")
        if resultado.returncode == 0 and dns.lower().endswith(".ts.net"):
            return "https://" + dns
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        pass
    return None


def porta_ocupada(porta: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", porta)) == 0


def dono_da_porta(porta: int):
    """PID de quem esta escutando na porta, ou None.

    netstat -ano e o jeito de saber isso sem instalar biblioteca nenhuma:
    a ultima coluna e o PID dono do socket. A linha de escuta a gente
    identifica pelo endereco remoto zerado, e nao pela palavra LISTENING,
    porque essa palavra muda conforme o idioma do Windows.
    """
    try:
        saida = subprocess.run(["netstat", "-ano", "-p", "TCP"],
                               capture_output=True, text=True,
                               errors="replace", timeout=20).stdout
    except Exception:
        return None

    for linha in saida.splitlines():
        partes = linha.split()
        if len(partes) < 5 or partes[0].upper() != "TCP":
            continue
        if not partes[1].endswith(":%d" % porta):
            continue
        if partes[2] not in ("0.0.0.0:0", "[::]:0", "*:*"):
            continue
        try:
            return int(partes[-1])
        except ValueError:
            continue
    return None


def info_do_processo(pid: int):
    """Nome e linha de comando de um PID.

    Precisa do PowerShell porque o tasklist so devolve o nome do .exe - e
    aqui esse nome e sempre python.exe, o que nao diz nada. Quem separa o
    nosso servidor de qualquer outro python e a linha de comando.
    """
    consulta = ("$p = Get-CimInstance Win32_Process -Filter 'ProcessId=%d'; "
                "if ($p) { $p.Name + '|' + $p.CommandLine }" % pid)
    try:
        saida = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", consulta],
            capture_output=True, text=True, errors="replace", timeout=30,
        ).stdout.strip()
    except Exception:
        return None, None
    nome, _, cmd = saida.partition("|")
    return (nome.strip() or None), cmd.strip()


def eh_nosso_servidor(nome, cmd) -> bool:
    """So oferecemos encerrar o que e claramente nosso: um python rodando
    'uvicorn server:app'. Em qualquer outro programa a gente nem toca."""
    if not nome or "python" not in nome.lower() or not cmd:
        return False
    minusculo = cmd.lower()
    return "uvicorn" in minusculo and "server:app" in minusculo


def resolver_porta_ocupada(porta: int) -> bool:
    """Diz quem esta segurando a porta e, se for um servidor orfao nosso,
    oferece encerrar. Devolve True se a porta ficou livre.

    Nunca mata nada sem o usuario responder 's': a porta pode estar com um
    programa dele que nao tem nada a ver com isso aqui.
    """
    print(f"  A porta {porta} ja esta em uso.")

    pid = dono_da_porta(porta)
    if pid is None:
        print("  Nao consegui descobrir qual programa esta usando ela.")
        print("  Provavelmente o Code com ja esta aberto em outra janela.")
        print("  Feche a outra janela preta e rode de novo.")
        return False

    nome, cmd = info_do_processo(pid)
    if not eh_nosso_servidor(nome, cmd):
        print(f"  Quem esta usando ela e: {nome or 'programa desconhecido'}"
              f" (PID {pid})")
        print("  Feche esse programa e rode de novo.")
        return False

    print("  E um servidor do Code com que ficou aberto sozinho, sem")
    print("  janela - deve ter sobrado de uma vez em que a janela preta")
    print(f"  foi fechada no X. ({nome}, PID {pid})")
    print()
    resposta = input("  Posso encerrar esse servidor esquecido? (s/n): ")
    if resposta.strip().lower() not in ("s", "sim"):
        print("  Ok, nao mexi em nada.")
        return False

    matar_arvore(pid)

    # o socket nao e devolvido no mesmo instante em que o processo morre
    for _ in range(20):
        if not porta_ocupada(porta):
            print("  Pronto, porta liberada. Seguindo...")
            print()
            return True
        time.sleep(0.25)

    print("  Nao consegui liberar a porta. Tente reiniciar o computador.")
    return False


def copiar(texto: str) -> bool:
    """Coloca o texto na area de transferencia usando o 'clip' do Windows."""
    try:
        subprocess.run("clip", input=texto.encode("utf-16-le"), check=True)
        return True
    except Exception:
        return False


def dns_enxerga(host: str) -> bool:
    """O DNS desta maquina consegue resolver o endereco do tunel?

    Roteador de internet movel costuma demorar (ou nunca) pegar nomes
    recem-criados. Isso afeta SO voce: quem esta fora resolve normalmente.
    """
    try:
        socket.getaddrinfo(host, 443)
        return True
    except socket.gaierror:
        return False


def senha_convite():
    caminho = os.path.join(BASE_DIR, "senha_de_convite.txt")
    try:
        with open(caminho, encoding="utf-8") as f:
            linhas = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        return linhas[0] if linhas else None
    except FileNotFoundError:
        return None


def caixa(linhas):
    """Desenha um quadro em volta do texto, pra nao sumir no meio do log."""
    largura = max(len(l) for l in linhas) + 4
    print()
    print("  +" + "-" * largura + "+")
    for l in linhas:
        print("  |  " + l.ljust(largura - 4) + "  |")
    print("  +" + "-" * largura + "+")
    print()


def main():
    parser = argparse.ArgumentParser(description="Inicia o Code com para acesso pela internet.")
    parser.add_argument(
        "--quick", action="store_true",
        help="usa o Cloudflare Quick Tunnel (link temporario) em vez do Tailscale",
    )
    argumentos = parser.parse_args()
    modo_rapido = argumentos.quick
    os.chdir(BASE_DIR)

    print()
    print("  ============================================")
    print("    CODE COM - MODO ONLINE")
    print("  ============================================")
    print()

    if modo_rapido:
        executavel_tunel = achar_cloudflared()
        if not executavel_tunel:
            print("  ERRO: nao achei o cloudflared.")
            print("  Instale com: winget install Cloudflare.cloudflared")
            input("  Aperte Enter pra fechar...")
            return 1
        endereco_fixo = None
    else:
        executavel_tunel = achar_tailscale()
        if not executavel_tunel:
            print("  ERRO: nao achei o Tailscale neste notebook.")
            print("  Instale gratuitamente em https://tailscale.com/download/windows")
            input("  Aperte Enter pra fechar...")
            return 1
        endereco_fixo = obter_endereco_tailscale(executavel_tunel)
        if not endereco_fixo:
            print("  ERRO: abra o Tailscale e conecte este notebook a sua conta.")
            input("  Aperte Enter pra fechar...")
            return 1

    if porta_ocupada(PORTA) and not resolver_porta_ocupada(PORTA):
        print()
        input("  Aperte Enter pra fechar...")
        return 1

    global JOB
    JOB = criar_job()
    if JOB is None:
        registrar_fechar_janela()

    # ---- 1) o servidor ------------------------------------------------
    print("  [1/2] Ligando o servidor...")
    servidor = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server:app",
         "--host", "127.0.0.1", "--port", str(PORTA)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    FILHOS.append(servidor)
    adotar(JOB, servidor)

    for _ in range(40):
        if porta_ocupada(PORTA):
            break
        if servidor.poll() is not None:
            print("  ERRO: o servidor morreu ao iniciar.")
            print("  Rode 'python -m uvicorn server:app' pra ver a mensagem de erro.")
            input("  Aperte Enter pra fechar...")
            return 1
        time.sleep(0.25)
    else:
        print("  ERRO: o servidor demorou demais pra responder.")
        servidor.terminate()
        input("  Aperte Enter pra fechar...")
        return 1

    # ---- 2) o tunel ---------------------------------------------------
    if modo_rapido:
        print("  [2/2] Abrindo o link temporario do Cloudflare...")
        comando_tunel = [
            executavel_tunel, "tunnel", "--url", f"http://127.0.0.1:{PORTA}"
        ]
    else:
        print("  [2/2] Abrindo seu link HTTPS fixo do Tailscale...")
        comando_tunel = [executavel_tunel, "funnel", str(PORTA)]
    print("        (a primeira ativacao do Funnel pode pedir aprovacao unica)")

    tunel = subprocess.Popen(
        comando_tunel, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    FILHOS.append(tunel)
    adotar(JOB, tunel)

    estado = {"url": None, "aprovacao": None}

    def mostrar(url):
        legenda = "SEU ENDERECO TEMPORARIO:" if modo_rapido else "SEU ENDERECO FIXO (manda pros amigos):"
        linhas = [legenda, "", url]
        senha = senha_convite()
        if senha:
            linhas += ["", "Senha pra eles criarem conta:", "", senha]
        caixa(linhas)

        if copiar(url):
            print("  >> endereco copiado! e so colar (Ctrl+V) no WhatsApp/Discord")
        print(f"  >> abrindo pra voce em http://localhost:{PORTA}")
        webbrowser.open(f"http://localhost:{PORTA}")

        if modo_rapido and not dns_enxerga(url.replace("https://", "")):
            print("  AVISO: o DNS desta internet ainda nao reconhece o link.")
            print("  Seus amigos normalmente conseguem abrir mesmo assim.")

        print()
        print("  DEIXE ESTA JANELA ABERTA - ela e o servidor.")
        print("  Para desligar tudo: Ctrl+C ou feche a janela.")
        print()

    def ler_saida():
        for linha in tunel.stdout:
            achou = PADRAO_URL.search(linha)
            if achou and not estado["url"]:
                estado["url"] = achou.group(0)
                mostrar(estado["url"])
                continue
            aprovacao = PADRAO_ATIVACAO.search(linha)
            if aprovacao:
                estado["aprovacao"] = aprovacao.group(0)
                caixa([
                    "ATIVACAO UNICA NECESSARIA:", "",
                    "Abra este endereco e habilite o Funnel para sua rede:", "",
                    estado["aprovacao"], "",
                    "Depois, rode iniciar_online.bat novamente.",
                ])
            elif "ERR" in linha or "not enabled on your tailnet" in linha.lower():
                print("  [tunel] " + linha.rstrip()[:180])

    leitor_tunel = threading.Thread(target=ler_saida, daemon=True)
    leitor_tunel.start()

    try:
        while True:
            if tunel.poll() is not None:
                leitor_tunel.join(timeout=2)
                if estado["aprovacao"]:
                    print("\n  Ative o Funnel no link acima e abra iniciar_online.bat de novo.")
                else:
                    print("\n  O tunel encerrou. Verifique o Tailscale e tente novamente.")
                break
            if servidor.poll() is not None:
                print("\n  O servidor caiu.")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n  Desligando...")
    finally:
        for p in (tunel, servidor):
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                pass
        limpar_filhos()
        print("  Tudo desligado.")

    return 0 if estado["url"] else 1


if __name__ == "__main__":
    sys.exit(main())
