"""
Servidor do app. Tem duas metades:

1) API REST  (/api/...)  -> pedidos pontuais: login, listar canais, carregar
                            historico de mensagens, upload de arquivo.
2) WebSocket (/ws)       -> a conexao que fica aberta. Tudo que precisa chegar
                            "na hora" passa por aqui: mensagens novas, quem
                            esta digitando, quem esta online, e a sinalizacao
                            das chamadas de voz.

Rodar com:  python -m uvicorn server:app --reload --host 0.0.0.0 --port 8000
"""

import os
import re
import json
import secrets
import mimetypes
from typing import Dict, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
TAMANHO_MAX = 25 * 1024 * 1024  # 25 MB por arquivo
ARQUIVO_CONVITE = os.path.join(BASE_DIR, "senha_de_convite.txt")


def senha_de_convite() -> str:
    """Le a senha que libera a criacao de conta.

    Se o arquivo nao existir ou estiver vazio, o cadastro fica aberto
    (bom pra rede de casa). Com algo escrito dentro, so cria conta quem
    souber a senha (bom quando o app esta exposto na internet).

    Lemos o arquivo a cada chamada de proposito: assim voce troca a senha
    sem precisar reiniciar o servidor.
    """
    try:
        with open(ARQUIVO_CONVITE, encoding="utf-8") as f:
            # ignoramos linhas de comentario comecando com #
            linhas = [l.strip() for l in f if l.strip() and not l.startswith("#")]
        return linhas[0] if linhas else ""
    except FileNotFoundError:
        return ""

app = FastAPI(title="Code com")
db.criar_tabelas()
db.migrar()   # adiciona colunas/tabelas novas em bancos antigos, sem apagar nada


# ===========================================================================
# GERENCIADOR DE CONEXOES
# ===========================================================================
class Conexoes:
    """Guarda quem esta conectado agora.

    Um usuario pode ter varias abas abertas ao mesmo tempo, por isso
    cada user_id aponta para um CONJUNTO de websockets, nao para um so.
    """

    def __init__(self):
        self.por_usuario: Dict[int, Set[WebSocket]] = {}
        # canal de voz -> user_ids que estao na chamada
        self.voz: Dict[int, Set[int]] = {}
        # user_id -> em qual canal de voz ele esta (so pode estar em um)
        self.voz_de: Dict[int, int] = {}

    def entrar(self, user_id: int, ws: WebSocket):
        self.por_usuario.setdefault(user_id, set()).add(ws)

    def sair(self, user_id: int, ws: WebSocket):
        conjunto = self.por_usuario.get(user_id)
        if not conjunto:
            return
        conjunto.discard(ws)
        if not conjunto:
            self.por_usuario.pop(user_id, None)

    def esta_online(self, user_id: int) -> bool:
        return user_id in self.por_usuario

    def online_agora(self):
        return list(self.por_usuario.keys())

    async def mandar_para(self, user_ids, payload: dict):
        """Envia um evento para uma lista de usuarios (todas as abas deles)."""
        texto = json.dumps(payload)
        for uid in set(user_ids):
            for ws in list(self.por_usuario.get(uid, ())):
                try:
                    await ws.send_text(texto)
                except Exception:
                    # conexao morreu no meio do envio; limpamos depois
                    self.sair(uid, ws)

    async def avisar_todos(self, payload: dict):
        await self.mandar_para(self.online_agora(), payload)


conexoes = Conexoes()


# ===========================================================================
# HELPERS
# ===========================================================================

def pegar_token(request: Request) -> str:
    """O token vem no cabecalho Authorization: Bearer xxxxx"""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return ""


def usuario_logado(request: Request):
    return db.usuario_do_token(pegar_token(request))


def limpar(u) -> dict:
    """Devolve so os campos publicos do usuario.
    O hash da senha NUNCA pode sair do servidor."""
    return db.perfil_publico(u)


def erro(msg: str, code: int = 400):
    return JSONResponse({"error": msg}, status_code=code)


# ===========================================================================
# AUTENTICACAO
# ===========================================================================

@app.get("/api/config")
async def config():
    """O login pergunta isso ao abrir, pra saber se mostra o campo de convite."""
    return {"precisa_convite": bool(senha_de_convite())}


@app.post("/api/register")
async def registrar(request: Request):
    dados = await request.json()
    nome = (dados.get("username") or "").strip()
    senha = dados.get("password") or ""

    # Trava de cadastro. compare_digest em vez de == pra nao vazar a senha
    # pelo tempo que a comparacao leva.
    exigida = senha_de_convite()
    if exigida and not secrets.compare_digest(dados.get("invite") or "", exigida):
        return erro("Senha de convite incorreta", 403)

    if not re.fullmatch(r"[A-Za-z0-9_.-]{3,20}", nome):
        return erro("Nome deve ter 3-20 caracteres (letras, numeros, _ . -)")
    if len(senha) < 4:
        return erro("Senha precisa de pelo menos 4 caracteres")

    uid = db.criar_usuario(nome, senha)
    if uid is None:
        return erro("Esse nome ja esta em uso")

    token = db.criar_sessao(uid)
    u = db.buscar_usuario_por_nome(nome)
    return {"token": token, "user": limpar(u)}


@app.post("/api/login")
async def login(request: Request):
    dados = await request.json()
    u = db.buscar_usuario_por_nome((dados.get("username") or "").strip())
    # Mensagem generica de proposito: nao revelamos se o usuario existe
    if not u or not db.conferir_senha(dados.get("password") or "", u["password_hash"]):
        return erro("Usuario ou senha incorretos", 401)
    return {"token": db.criar_sessao(u["id"]), "user": limpar(u)}


@app.post("/api/logout")
async def logout(request: Request):
    db.apagar_sessao(pegar_token(request))
    return {"ok": True}


# ===========================================================================
# DADOS INICIAIS
# ===========================================================================

@app.get("/api/bootstrap")
async def bootstrap(request: Request):
    """Tudo que o app precisa pra desenhar a tela logo ao abrir.
    Uma chamada so em vez de cinco."""
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    return {
        "user": limpar(u),
        "servers": db.servidores_do_usuario(u["id"]),
        "dms": db.dms_do_usuario(u["id"]),
        "users": db.listar_usuarios(u["id"]),
        "online": conexoes.online_agora(),
    }


@app.get("/api/servers/{server_id}")
async def ver_servidor(server_id: int, request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.eh_membro(u["id"], server_id):
        return erro("Voce nao participa desse servidor", 403)
    s = db.servidor_por_id(server_id)
    return {
        "server": s,
        "channels": db.canais_do_servidor(server_id),
        "members": db.membros_do_servidor(server_id),
        "voice": {cid: list(ids) for cid, ids in conexoes.voz.items()},
    }


@app.post("/api/servers")
async def novo_servidor(request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    dados = await request.json()
    nome = (dados.get("name") or "").strip()
    if not 1 <= len(nome) <= 40:
        return erro("Nome do servidor invalido")
    sid = db.criar_servidor(nome, u["id"])
    return {"server": db.servidor_por_id(sid)}


@app.post("/api/join")
async def entrar_servidor(request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    dados = await request.json()
    sid = db.entrar_por_convite((dados.get("code") or "").strip(), u["id"])
    if sid is None:
        return erro("Convite invalido")
    # avisa quem ja esta no servidor que chegou gente nova
    await conexoes.mandar_para(
        [m["id"] for m in db.membros_do_servidor(sid)],
        {"type": "member_joined", "server_id": sid, "user": limpar(u)},
    )
    return {"server": db.servidor_por_id(sid)}


@app.post("/api/servers/{server_id}/channels")
async def novo_canal(server_id: int, request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.eh_membro(u["id"], server_id):
        return erro("Sem permissao", 403)
    dados = await request.json()
    nome = (dados.get("name") or "").strip()
    kind = dados.get("kind") or "text"
    if not 1 <= len(nome) <= 30 or kind not in ("text", "voice"):
        return erro("Dados invalidos")
    cid = db.criar_canal(server_id, nome, kind)
    canal = db.canal_por_id(cid)
    await conexoes.mandar_para(
        [m["id"] for m in db.membros_do_servidor(server_id)],
        {"type": "channel_created", "channel": canal},
    )
    return {"channel": canal}


# ===========================================================================
# MENSAGENS E DMs
# ===========================================================================

@app.get("/api/channels/{channel_id}/messages")
async def historico(channel_id: int, request: Request, q: str = "", pinned: bool = False,
                    before_id: int | None = None):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.usuario_pode_ver_canal(u["id"], channel_id):
        return erro("Sem acesso a esse canal", 403)
    return {"messages": db.mensagens_do_canal(channel_id, busca=q.strip()[:100],
                                                fixadas=pinned, antes_de=before_id)}


@app.post("/api/dm/{outro_id}")
async def abrir_dm(outro_id: int, request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if outro_id == u["id"]:
        return erro("Nao da pra abrir DM com voce mesmo")
    cid = db.abrir_dm(u["id"], outro_id)
    # avisa a outra pessoa pra DM aparecer na lista dela na hora
    await conexoes.mandar_para([outro_id], {"type": "dm_opened"})
    return {"channel_id": cid}


# ===========================================================================
# UPLOAD DE ARQUIVOS
# ===========================================================================

@app.post("/api/upload")
async def upload(request: Request, channel_id: int = Form(...),
                 content: str = Form(""), reply_to: int | None = Form(None),
                 file: UploadFile = File(...)):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.usuario_pode_ver_canal(u["id"], channel_id):
        return erro("Sem acesso a esse canal", 403)

    conteudo = await file.read()
    if len(conteudo) > TAMANHO_MAX:
        return erro("Arquivo maior que 25 MB")
    if not conteudo:
        return erro("Arquivo vazio")

    # NUNCA use o nome que o usuario mandou pra salvar no disco:
    # ele poderia mandar "../../senhas.txt" e escrever fora da pasta.
    # Geramos um nome aleatorio e so aproveitamos a extensao, limpa.
    original = os.path.basename(file.filename or "arquivo")
    ext = os.path.splitext(original)[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", ext or ""):
        ext = ""
    nome_disco = secrets.token_hex(16) + ext

    with open(os.path.join(UPLOAD_DIR, nome_disco), "wb") as f:
        f.write(conteudo)

    tipo = file.content_type or mimetypes.guess_type(original)[0] or "application/octet-stream"
    resposta = db.mensagem_por_id(reply_to) if reply_to else None
    if resposta and resposta["channel_id"] != channel_id:
        resposta = None
    msg = db.criar_mensagem(channel_id, u["id"], content.strip(),
                            f"/uploads/{nome_disco}", original, tipo,
                            resposta["id"] if resposta else None)
    await conexoes.mandar_para(db.quem_recebe(channel_id),
                               {"type": "message", "message": msg})
    return {"ok": True}


@app.get("/uploads/{nome}")
async def servir_upload(nome: str):
    """Servimos os arquivos por uma rota propria pra poder validar o nome."""
    if not re.fullmatch(r"[a-f0-9]{32}(\.[a-z0-9]{1,8})?", nome):
        return erro("Arquivo invalido", 404)
    caminho = os.path.join(UPLOAD_DIR, nome)
    if not os.path.isfile(caminho):
        return erro("Arquivo nao encontrado", 404)
    return FileResponse(caminho)


# ===========================================================================
# WEBSOCKET - o tempo real
# ===========================================================================

@app.websocket("/ws")
async def websocket(ws: WebSocket, token: str = ""):
    u = db.usuario_do_token(token)
    if not u:
        await ws.close(code=4001)  # codigo proprio: "nao autenticado"
        return

    await ws.accept()
    user_id = u["id"]
    ja_estava_online = conexoes.esta_online(user_id)
    conexoes.entrar(user_id, ws)

    await ws.send_text(json.dumps({
        "type": "ready", "user": limpar(u), "online": conexoes.online_agora(),
    }))
    if not ja_estava_online:
        await conexoes.avisar_todos({"type": "presence", "user_id": user_id, "online": True})

    try:
        while True:
            # Fica parado aqui esperando o navegador mandar alguma coisa.
            evento = json.loads(await ws.receive_text())
            await tratar_evento(evento, u, ws)

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        conexoes.sair(user_id, ws)
        if not conexoes.esta_online(user_id):
            await sair_da_voz(user_id)
            await conexoes.avisar_todos({"type": "presence", "user_id": user_id, "online": False})


async def tratar_evento(ev: dict, u, ws: WebSocket):
    tipo = ev.get("type")
    user_id = u["id"]

    # ---- mandar mensagem de texto -------------------------------------
    if tipo == "send":
        cid = ev.get("channel_id")
        texto = (ev.get("content") or "").strip()[:4000]
        if not texto or not db.usuario_pode_ver_canal(user_id, cid):
            return
        resposta = db.mensagem_por_id(ev.get("reply_to")) if isinstance(ev.get("reply_to"), int) else None
        reply_to = resposta["id"] if resposta and resposta["channel_id"] == cid else None
        msg = db.criar_mensagem(cid, user_id, texto, reply_to=reply_to)
        await conexoes.mandar_para(db.quem_recebe(cid),
                                   {"type": "message", "message": msg,
                                    "client_id": ev.get("client_id") if isinstance(ev.get("client_id"), str) else None})

    elif tipo == "edit":
        message_id = ev.get("message_id")
        content = (ev.get("content") or "").strip()[:4000]
        msg = db.editar_mensagem(message_id, user_id, content) if content else None
        if msg and db.usuario_pode_ver_canal(user_id, msg["channel_id"]):
            await conexoes.mandar_para(db.quem_recebe(msg["channel_id"]),
                                       {"type": "message_updated", "message": msg})

    elif tipo == "pin":
        message_id = ev.get("message_id")
        atual = db.mensagem_por_id(message_id) if isinstance(message_id, int) else None
        if atual and db.usuario_pode_ver_canal(user_id, atual["channel_id"]):
            msg = db.fixar_mensagem(message_id, atual["channel_id"], bool(ev.get("pinned")))
            if msg:
                await conexoes.mandar_para(db.quem_recebe(msg["channel_id"]),
                                           {"type": "message_updated", "message": msg})

    elif tipo == "react":
        message_id = ev.get("message_id")
        emoji = ev.get("emoji")
        permitidos = {"👍", "❤️", "😂", "😮", "😢", "🔥"}
        msg = db.mensagem_por_id(message_id) if isinstance(message_id, int) else None
        if msg and isinstance(emoji, str) and emoji in permitidos and db.usuario_pode_ver_canal(user_id, msg["channel_id"]):
            atualizacao = db.alternar_reacao(message_id, user_id, emoji)
            if atualizacao:
                await conexoes.mandar_para(db.quem_recebe(atualizacao["channel_id"]), {
                    "type": "message_reactions", "message_id": message_id,
                    "channel_id": atualizacao["channel_id"],
                    "reactions": atualizacao["reactions"],
                })

    # ---- "fulano esta digitando..." -----------------------------------
    elif tipo == "typing":
        cid = ev.get("channel_id")
        if not db.usuario_pode_ver_canal(user_id, cid):
            return
        outros = [i for i in db.quem_recebe(cid) if i != user_id]
        await conexoes.mandar_para(outros, {
            "type": "typing", "channel_id": cid, "user": limpar(u),
        })

    # ---- apagar mensagem ----------------------------------------------
    elif tipo == "delete":
        cid = db.apagar_mensagem(ev.get("message_id"), user_id)
        if cid:
            await conexoes.mandar_para(db.quem_recebe(cid), {
                "type": "message_deleted",
                "channel_id": cid, "message_id": ev.get("message_id"),
            })

    # ---- VOZ: entrar numa sala ----------------------------------------
    elif tipo == "voice_join":
        cid = ev.get("channel_id")
        if not db.usuario_pode_ver_canal(user_id, cid):
            return
        await sair_da_voz(user_id)  # so pode estar em uma sala por vez

        ja_na_sala = [i for i in conexoes.voz.get(cid, set()) if i != user_id]
        conexoes.voz.setdefault(cid, set()).add(user_id)
        conexoes.voz_de[user_id] = cid

        # Quem chega recebe a lista de quem ja estava e faz as "ligacoes".
        await ws.send_text(json.dumps({
            "type": "voice_peers", "channel_id": cid, "peers": ja_na_sala,
        }))
        await avisar_estado_voz(cid)

    elif tipo == "voice_leave":
        await sair_da_voz(user_id)

    # ---- VOZ: sinalizacao WebRTC --------------------------------------
    elif tipo == "signal":
        # O servidor so entrega o envelope: quem negocia audio sao os dois
        # navegadores entre si (P2P). O audio nem passa por aqui.
        destino = ev.get("to")
        if isinstance(destino, int):
            await conexoes.mandar_para([destino], {
                "type": "signal", "from": user_id, "data": ev.get("data"),
            })

    elif tipo == "voice_mute":
        cid = conexoes.voz_de.get(user_id)
        if cid:
            await conexoes.mandar_para(db.quem_recebe(cid), {
                "type": "voice_mute", "user_id": user_id,
                "muted": bool(ev.get("muted")),
            })

async def sair_da_voz(user_id: int):
    cid = conexoes.voz_de.pop(user_id, None)
    if cid is None:
        return
    sala = conexoes.voz.get(cid)
    if sala:
        sala.discard(user_id)
        if not sala:
            conexoes.voz.pop(cid, None)
    await conexoes.mandar_para(db.quem_recebe(cid),
                               {"type": "voice_left", "channel_id": cid, "user_id": user_id})
    await avisar_estado_voz(cid)


async def avisar_estado_voz(channel_id: int):
    """Manda pra todo mundo do servidor quem esta na sala de voz agora."""
    ids = list(conexoes.voz.get(channel_id, set()))
    await conexoes.mandar_para(db.quem_recebe(channel_id), {
        "type": "voice_state", "channel_id": channel_id, "users": ids,
    })


# ===========================================================================
# PERFIL
# ===========================================================================

CORES_VALIDAS = re.compile(r"^#[0-9a-fA-F]{6}$")


@app.get("/api/users/{outro_id}")
async def ver_perfil(outro_id: int, request: Request):
    """Perfil publico de alguem, com o estado da amizade e servidores em comum."""
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    perfil = db.usuario_por_id(outro_id)
    if not perfil:
        return erro("Usuario nao encontrado", 404)
    return {
        "user": perfil,
        "amizade": db.situacao_amizade(u["id"], outro_id),
        "servidores_em_comum": db.servidores_em_comum(u["id"], outro_id),
        "online": conexoes.esta_online(outro_id),
    }


@app.patch("/api/me")
async def editar_perfil(request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    dados = await request.json()

    nome = dados.get("display_name")
    if nome is not None:
        nome = nome.strip()
        if not 1 <= len(nome) <= 32:
            return erro("O nome de exibicao precisa ter de 1 a 32 caracteres")

    cor = dados.get("avatar_color")
    if cor is not None and not CORES_VALIDAS.match(cor):
        return erro("Cor invalida")

    bio = dados.get("bio")
    if bio is not None:
        bio = bio.strip()[:190]

    status_texto = dados.get("status_texto")
    if status_texto is not None:
        status_texto = status_texto.strip()[:60]

    # So aceitamos LIMPAR a foto por aqui. Deixar o cliente mandar uma URL
    # qualquer permitiria apontar o avatar pra qualquer endereco da internet
    # (ou pra um arquivo interno). Trocar a foto so pelo /api/me/avatar.
    avatar_url = None
    if dados.get("avatar_url") == "":
        avatar_url = ""

    perfil = db.atualizar_perfil(u["id"], display_name=nome, avatar_color=cor,
                                 bio=bio, status_texto=status_texto,
                                 avatar_url=avatar_url)

    # Avisa todo mundo pra foto/nome atualizarem na tela dos outros na hora
    await conexoes.avisar_todos({"type": "profile_updated", "user": perfil})
    return {"user": perfil}


@app.post("/api/me/avatar")
async def trocar_avatar(request: Request, file: UploadFile = File(...)):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)

    conteudo = await file.read()
    if len(conteudo) > 4 * 1024 * 1024:
        return erro("A imagem precisa ter menos de 4 MB")

    tipo = (file.content_type or "").lower()
    if tipo not in ("image/png", "image/jpeg", "image/gif", "image/webp"):
        return erro("Use uma imagem PNG, JPG, GIF ou WEBP")

    ext = {"image/png": ".png", "image/jpeg": ".jpg",
           "image/gif": ".gif", "image/webp": ".webp"}[tipo]
    nome_disco = secrets.token_hex(16) + ext
    with open(os.path.join(UPLOAD_DIR, nome_disco), "wb") as f:
        f.write(conteudo)

    perfil = db.atualizar_perfil(u["id"], avatar_url=f"/uploads/{nome_disco}")
    await conexoes.avisar_todos({"type": "profile_updated", "user": perfil})
    return {"user": perfil}


@app.post("/api/me/senha")
async def mudar_senha(request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    dados = await request.json()
    nova = dados.get("nova") or ""
    if len(nova) < 4:
        return erro("A senha nova precisa de pelo menos 4 caracteres")
    if not db.trocar_senha(u["id"], dados.get("atual") or "", nova):
        return erro("A senha atual esta incorreta", 403)
    # trocar_senha derruba as sessoes antigas; damos uma nova pra esta aba
    return {"token": db.criar_sessao(u["id"])}


# ===========================================================================
# AMIZADES
# ===========================================================================

@app.get("/api/friends")
async def meus_amigos(request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    return db.listar_amizades(u["id"])


@app.post("/api/friends/{outro_id}")
async def pedir_amizade(outro_id: int, request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.usuario_por_id(outro_id):
        return erro("Usuario nao encontrado", 404)

    resultado = db.pedir_amizade(u["id"], outro_id)
    mensagens = {
        "voce_mesmo": "Nao da pra adicionar voce mesmo",
        "ja_amigos": "Voces ja sao amigos",
        "ja_enviado": "Pedido ja enviado, aguarde a resposta",
    }
    if resultado in mensagens:
        return erro(mensagens[resultado])

    # avisa a outra pessoa na hora
    await conexoes.mandar_para([outro_id], {
        "type": "friend_request" if resultado == "enviado" else "friend_accepted",
        "user": limpar(u),
    })
    return {"resultado": resultado, "amizade": db.situacao_amizade(u["id"], outro_id)}


@app.post("/api/friends/{outro_id}/aceitar")
async def aceitar_amizade(outro_id: int, request: Request):
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.aceitar_amizade(u["id"], outro_id):
        return erro("Nao ha pedido pendente dessa pessoa")
    await conexoes.mandar_para([outro_id],
                               {"type": "friend_accepted", "user": limpar(u)})
    return {"amizade": "amigos"}


@app.delete("/api/friends/{outro_id}")
async def remover_amizade(outro_id: int, request: Request):
    """Serve pra recusar pedido, cancelar pedido e desfazer amizade."""
    u = usuario_logado(request)
    if not u:
        return erro("Nao autenticado", 401)
    if not db.desfazer_amizade(u["id"], outro_id):
        return erro("Nao havia nada entre voces")
    await conexoes.mandar_para([outro_id],
                               {"type": "friend_removed", "user_id": u["id"]})
    return {"amizade": "nenhuma"}


# ===========================================================================
# ARQUIVOS DO FRONT-END
# (fica por ultimo: as rotas /api tem que ser checadas antes)
# ===========================================================================

class SemCache(StaticFiles):
    """StaticFiles que pede pro navegador nao guardar nada em cache.

    Sem isso, depois de voce editar o app.js ou o index.html, o navegador
    continua servindo a versao velha do proprio cache - e parece que a
    alteracao "nao funcionou". Como aqui os arquivos vem da sua propria
    maquina, nao ter cache nao custa praticamente nada.
    """

    def is_not_modified(self, response_headers, request_headers) -> bool:
        return False   # nunca responder "304 nao mudou"

    async def get_response(self, path, scope):
        resposta = await super().get_response(path, scope)
        resposta.headers["Cache-Control"] = "no-store, must-revalidate"
        return resposta


app.mount("/", SemCache(directory=os.path.join(BASE_DIR, "static"), html=True),
          name="static")
