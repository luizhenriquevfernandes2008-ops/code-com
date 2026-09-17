"""
Camada de banco de dados do app.
Usa SQLite: um banco inteiro dentro de um unico arquivo (discord.db).
Nao precisa instalar nada, ja vem com o Python.
"""

import sqlite3
import secrets
import hashlib
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "discord.db")


def conectar():
    """Abre uma conexao com o banco.

    row_factory = sqlite3.Row faz o resultado vir como dicionario
    (linha["username"]) em vez de tupla (linha[1]), bem mais legivel.
    """
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    return con


def agora():
    """Horario atual em UTC, formato ISO. Sempre guarde datas em UTC:
    quem converte pro fuso do usuario e o navegador."""
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Criacao das tabelas
# ---------------------------------------------------------------------------

def criar_tabelas():
    con = conectar()
    con.executescript("""
    -- Usuarios do app
    CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        avatar_color  TEXT    NOT NULL,
        created_at    TEXT    NOT NULL
    );

    -- Tokens de login. Cada vez que voce loga nasce um token novo.
    CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT    NOT NULL
    );

    -- "Servidores" (o Discord chama de guild)
    CREATE TABLE IF NOT EXISTS servers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        invite_code TEXT    NOT NULL UNIQUE,
        icon_color  TEXT    NOT NULL,
        created_at  TEXT    NOT NULL
    );

    -- Quem participa de qual servidor (relacao N-para-N)
    CREATE TABLE IF NOT EXISTS memberships (
        server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
        joined_at TEXT    NOT NULL,
        PRIMARY KEY (server_id, user_id)
    );

    -- Canais. server_id NULL = e uma DM (conversa privada).
    -- kind: 'text' | 'voice' | 'dm'
    CREATE TABLE IF NOT EXISTS channels (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id  INTEGER REFERENCES servers(id) ON DELETE CASCADE,
        name       TEXT    NOT NULL,
        kind       TEXT    NOT NULL DEFAULT 'text',
        position   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT    NOT NULL
    );

    -- As duas pessoas de uma DM
    CREATE TABLE IF NOT EXISTS dm_participants (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        PRIMARY KEY (channel_id, user_id)
    );

    -- As mensagens
    CREATE TABLE IF NOT EXISTS messages (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        content     TEXT    NOT NULL DEFAULT '',
        file_url    TEXT,
        file_name   TEXT,
        file_type   TEXT,
        reply_to    INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        edited_at   TEXT,
        pinned      INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL
    );

    -- Indice: deixa "buscar mensagens de um canal" muito mais rapido
    CREATE INDEX IF NOT EXISTS idx_msg_channel ON messages(channel_id, id);
    """)
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Senhas
# ---------------------------------------------------------------------------

def hash_senha(senha: str, salt: str | None = None) -> str:
    """Nunca guarde senha em texto puro no banco.

    PBKDF2 embaralha a senha 200 mil vezes. Se alguem roubar o banco,
    nao consegue voltar do hash pra senha original.
    O 'salt' e um valor aleatorio por usuario: impede que duas pessoas
    com a mesma senha tenham o mesmo hash.
    """
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", senha.encode(), salt.encode(), 200_000)
    return f"{salt}${dk.hex()}"


def conferir_senha(senha: str, hash_guardado: str) -> bool:
    try:
        salt, _ = hash_guardado.split("$", 1)
    except ValueError:
        return False
    # compare_digest evita "timing attack" (descobrir a senha medindo
    # quanto tempo a comparacao demora)
    return secrets.compare_digest(hash_senha(senha, salt), hash_guardado)


# ---------------------------------------------------------------------------
# Usuarios e sessoes
# ---------------------------------------------------------------------------

CORES = ["#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245",
         "#3BA55D", "#FAA81A", "#9B59B6", "#1ABC9C", "#E91E63"]


def criar_usuario(username: str, senha: str):
    con = conectar()
    cor = secrets.choice(CORES)
    try:
        cur = con.execute(
            "INSERT INTO users (username, display_name, password_hash, avatar_color, created_at)"
            " VALUES (?,?,?,?,?)",
            (username, username, hash_senha(senha), cor, agora()),
        )
        con.commit()
        return cur.lastrowid
    except sqlite3.IntegrityError:
        return None  # username ja existe
    finally:
        con.close()


def buscar_usuario_por_nome(username: str):
    con = conectar()
    u = con.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    con.close()
    return u


def criar_sessao(user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    con = conectar()
    con.execute("INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)",
                (token, user_id, agora()))
    con.commit()
    con.close()
    return token


def usuario_do_token(token: str):
    if not token:
        return None
    con = conectar()
    u = con.execute(
        "SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?",
        (token,),
    ).fetchone()
    con.close()
    return u


def apagar_sessao(token: str):
    con = conectar()
    con.execute("DELETE FROM sessions WHERE token = ?", (token,))
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Servidores e canais
# ---------------------------------------------------------------------------

def criar_servidor(nome: str, owner_id: int):
    con = conectar()
    convite = secrets.token_urlsafe(6)
    cur = con.execute(
        "INSERT INTO servers (name, owner_id, invite_code, icon_color, created_at)"
        " VALUES (?,?,?,?,?)",
        (nome, owner_id, convite, secrets.choice(CORES), agora()),
    )
    sid = cur.lastrowid
    # Todo servidor novo ja nasce com um canal de texto e um de voz
    con.execute("INSERT INTO channels (server_id, name, kind, position, created_at)"
                " VALUES (?,?,?,?,?)", (sid, "geral", "text", 0, agora()))
    con.execute("INSERT INTO channels (server_id, name, kind, position, created_at)"
                " VALUES (?,?,?,?,?)", (sid, "Sala de voz", "voice", 1, agora()))
    con.execute("INSERT INTO memberships (server_id, user_id, joined_at) VALUES (?,?,?)",
                (sid, owner_id, agora()))
    con.commit()
    con.close()
    return sid


def entrar_por_convite(codigo: str, user_id: int):
    con = conectar()
    s = con.execute("SELECT * FROM servers WHERE invite_code = ?", (codigo,)).fetchone()
    if not s:
        con.close()
        return None
    con.execute("INSERT OR IGNORE INTO memberships (server_id, user_id, joined_at)"
                " VALUES (?,?,?)", (s["id"], user_id, agora()))
    con.commit()
    con.close()
    return s["id"]


def servidores_do_usuario(user_id: int):
    con = conectar()
    rows = con.execute(
        "SELECT s.* FROM servers s JOIN memberships m ON m.server_id = s.id"
        " WHERE m.user_id = ? ORDER BY s.id", (user_id,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def servidor_por_id(server_id: int):
    con = conectar()
    s = con.execute("SELECT * FROM servers WHERE id = ?", (server_id,)).fetchone()
    con.close()
    return dict(s) if s else None


def canais_do_servidor(server_id: int):
    con = conectar()
    rows = con.execute(
        "SELECT * FROM channels WHERE server_id = ? ORDER BY position, id",
        (server_id,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def membros_do_servidor(server_id: int):
    con = conectar()
    rows = con.execute(
        "SELECT u.id, u.username, u.display_name, u.avatar_color,"
        " u.avatar_url, u.status_texto"
        " FROM users u JOIN memberships m ON m.user_id = u.id"
        " WHERE m.server_id = ? ORDER BY u.username", (server_id,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def eh_membro(user_id: int, server_id: int) -> bool:
    con = conectar()
    ok = con.execute("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?",
                     (server_id, user_id)).fetchone() is not None
    con.close()
    return ok


def criar_canal(server_id: int, nome: str, kind: str = "text"):
    con = conectar()
    cur = con.execute("INSERT INTO channels (server_id, name, kind, position, created_at)"
                      " VALUES (?,?,?,?,?)", (server_id, nome, kind, 99, agora()))
    con.commit()
    cid = cur.lastrowid
    con.close()
    return cid


def canal_por_id(channel_id: int):
    con = conectar()
    c = con.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
    con.close()
    return dict(c) if c else None


def usuario_pode_ver_canal(user_id: int, channel_id: int) -> bool:
    """Checagem de permissao. NUNCA confie no front-end: mesmo que a tela
    nao mostre o canal, alguem pode chamar a API na mao."""
    con = conectar()
    ch = con.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
    if not ch:
        con.close()
        return False
    if ch["server_id"] is None:  # e uma DM
        ok = con.execute("SELECT 1 FROM dm_participants WHERE channel_id=? AND user_id=?",
                         (channel_id, user_id)).fetchone() is not None
    else:
        ok = con.execute("SELECT 1 FROM memberships WHERE server_id=? AND user_id=?",
                         (ch["server_id"], user_id)).fetchone() is not None
    con.close()
    return ok


def quem_recebe(channel_id: int):
    """Lista de user_ids que devem receber os eventos desse canal."""
    con = conectar()
    ch = con.execute("SELECT server_id FROM channels WHERE id = ?", (channel_id,)).fetchone()
    if not ch:
        con.close()
        return []
    if ch["server_id"] is None:
        rows = con.execute("SELECT user_id FROM dm_participants WHERE channel_id=?",
                           (channel_id,)).fetchall()
    else:
        rows = con.execute("SELECT user_id FROM memberships WHERE server_id=?",
                           (ch["server_id"],)).fetchall()
    con.close()
    return [r["user_id"] for r in rows]


# ---------------------------------------------------------------------------
# DMs (conversas privadas)
# ---------------------------------------------------------------------------

def abrir_dm(user_a: int, user_b: int) -> int:
    """Acha a DM entre duas pessoas; se nao existir, cria.
    O HAVING COUNT(DISTINCT ...) = 2 garante que achamos o canal que tem
    exatamente essas duas pessoas dentro."""
    con = conectar()
    r = con.execute("""
        SELECT p.channel_id FROM dm_participants p
        JOIN channels c ON c.id = p.channel_id AND c.server_id IS NULL
        WHERE p.user_id IN (?,?)
        GROUP BY p.channel_id HAVING COUNT(DISTINCT p.user_id) = 2
    """, (user_a, user_b)).fetchone()
    if r:
        con.close()
        return r["channel_id"]
    cur = con.execute("INSERT INTO channels (server_id, name, kind, created_at)"
                      " VALUES (NULL, 'dm', 'dm', ?)", (agora(),))
    cid = cur.lastrowid
    con.executemany("INSERT INTO dm_participants (channel_id, user_id) VALUES (?,?)",
                    [(cid, user_a), (cid, user_b)])
    con.commit()
    con.close()
    return cid


def dms_do_usuario(user_id: int):
    """Minhas DMs, ja com os dados da outra pessoa da conversa."""
    con = conectar()
    rows = con.execute("""
        SELECT c.id AS channel_id, u.id AS user_id, u.username,
               u.display_name, u.avatar_color, u.avatar_url, u.status_texto
        FROM dm_participants meu
        JOIN channels c        ON c.id = meu.channel_id
        JOIN dm_participants o ON o.channel_id = c.id AND o.user_id != meu.user_id
        JOIN users u           ON u.id = o.user_id
        WHERE meu.user_id = ?
        ORDER BY c.id DESC
    """, (user_id,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


def listar_usuarios(exceto_id: int):
    con = conectar()
    rows = con.execute(
        "SELECT id, username, display_name, avatar_color, avatar_url, status_texto"
        " FROM users"
        " WHERE id != ? ORDER BY username", (exceto_id,)).fetchall()
    con.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Mensagens
# ---------------------------------------------------------------------------

def criar_mensagem(channel_id, user_id, content, file_url=None,
                   file_name=None, file_type=None, reply_to=None):
    con = conectar()
    cur = con.execute(
        "INSERT INTO messages (channel_id, user_id, content, file_url, file_name,"
        " file_type, reply_to, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (channel_id, user_id, content, file_url, file_name, file_type, reply_to, agora()))
    mid = cur.lastrowid
    con.commit()
    m = _mensagens_enriquecidas(con, con.execute(_SQL_MENSAGENS + " WHERE m.id = ?", (mid,)).fetchall())[0]
    con.close()
    return m


_SQL_MENSAGENS = """
    SELECT m.*, u.username, u.display_name, u.avatar_color, u.avatar_url,
           rp.content AS reply_content, ru.display_name AS reply_author
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN messages rp ON rp.id = m.reply_to
    LEFT JOIN users ru ON ru.id = rp.user_id
"""


def _mensagens_enriquecidas(con, rows):
    mensagens = [dict(r) for r in rows]
    if not mensagens:
        return mensagens
    ids = [m["id"] for m in mensagens]
    marcas = ",".join("?" for _ in ids)
    reacoes = con.execute(
        f"SELECT message_id, emoji, user_id FROM message_reactions WHERE message_id IN ({marcas}) ORDER BY emoji, user_id",
        ids,
    ).fetchall()
    por_mensagem = {}
    for r in reacoes:
        grupo = por_mensagem.setdefault(r["message_id"], {})
        grupo.setdefault(r["emoji"], []).append(r["user_id"])
    for m in mensagens:
        m["reactions"] = [
            {"emoji": emoji, "count": len(users), "user_ids": users}
            for emoji, users in por_mensagem.get(m["id"], {}).items()
        ]
        m["pinned"] = bool(m["pinned"])
        m["reply"] = ({"content": m["reply_content"], "author": m["reply_author"]}
                      if m.get("reply_to") and m.get("reply_content") is not None else None)
        m.pop("reply_content", None)
        m.pop("reply_author", None)
    return mensagens


def mensagem_por_id(message_id: int):
    con = conectar()
    rows = con.execute(_SQL_MENSAGENS + " WHERE m.id = ?", (message_id,)).fetchall()
    mensagens = _mensagens_enriquecidas(con, rows)
    con.close()
    return mensagens[0] if mensagens else None


def mensagens_do_canal(channel_id: int, limite: int = 50, busca: str = "", fixadas: bool = False,
                       antes_de: int | None = None):
    con = conectar()
    condicoes = ["m.channel_id = ?"]
    args = [channel_id]
    if busca:
        condicoes.append("(m.content LIKE ? ESCAPE '\\' OR m.file_name LIKE ? ESCAPE '\\')")
        termo = busca.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        args.extend([f"%{termo}%", f"%{termo}%"])
    if fixadas:
        condicoes.append("m.pinned = 1")
    if antes_de:
        condicoes.append("m.id < ?")
        args.append(antes_de)
    rows = con.execute(
        _SQL_MENSAGENS + " WHERE " + " AND ".join(condicoes) +
        " ORDER BY m.id DESC LIMIT ?", (*args, max(1, min(int(limite), 100))),
    ).fetchall()
    mensagens = _mensagens_enriquecidas(con, list(reversed(rows)))
    con.close()
    return mensagens


def editar_mensagem(msg_id: int, user_id: int, content: str):
    con = conectar()
    cur = con.execute("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND user_id = ?",
                      (content, agora(), msg_id, user_id))
    con.commit()
    con.close()
    return mensagem_por_id(msg_id) if cur.rowcount else None


def fixar_mensagem(msg_id: int, channel_id: int, pinned: bool):
    con = conectar()
    cur = con.execute("UPDATE messages SET pinned = ? WHERE id = ? AND channel_id = ?",
                      (int(pinned), msg_id, channel_id))
    con.commit()
    con.close()
    return mensagem_por_id(msg_id) if cur.rowcount else None


def alternar_reacao(msg_id: int, user_id: int, emoji: str):
    con = conectar()
    m = con.execute("SELECT channel_id FROM messages WHERE id = ?", (msg_id,)).fetchone()
    if not m:
        con.close()
        return None
    existe = con.execute("SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?",
                         (msg_id, user_id, emoji)).fetchone()
    if existe:
        con.execute("DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?",
                    (msg_id, user_id, emoji))
    else:
        con.execute("INSERT INTO message_reactions (message_id,user_id,emoji,created_at) VALUES (?,?,?,?)",
                    (msg_id, user_id, emoji, agora()))
    con.commit()
    reacoes = con.execute(
        "SELECT emoji, user_id FROM message_reactions WHERE message_id=? ORDER BY emoji,user_id", (msg_id,)
    ).fetchall()
    por_emoji = {}
    for r in reacoes:
        por_emoji.setdefault(r["emoji"], []).append(r["user_id"])
    con.close()
    return {"channel_id": m["channel_id"], "reactions": [
        {"emoji": emoji, "count": len(users), "user_ids": users}
        for emoji, users in por_emoji.items()
    ]}


def apagar_mensagem(msg_id: int, user_id: int):
    """So o autor pode apagar. O "AND user_id = ?" ja aplica a permissao
    dentro da propria query."""
    con = conectar()
    m = con.execute("SELECT channel_id FROM messages WHERE id = ? AND user_id = ?",
                    (msg_id, user_id)).fetchone()
    if not m:
        con.close()
        return None
    cid = m["channel_id"]
    con.execute("DELETE FROM messages WHERE id = ?", (msg_id,))
    con.commit()
    con.close()
    return cid


# ---------------------------------------------------------------------------
# MIGRACAO
# Quando o app ganha campos novos, o banco de quem ja usava continua velho.
# Em vez de apagar tudo, adicionamos as colunas que faltam.
# ---------------------------------------------------------------------------

def migrar():
    con = conectar()

    colunas = {r["name"] for r in con.execute("PRAGMA table_info(users)")}
    novas = {
        "bio": "TEXT NOT NULL DEFAULT ''",
        "status_texto": "TEXT NOT NULL DEFAULT ''",
        "avatar_url": "TEXT",
    }
    for nome, tipo in novas.items():
        if nome not in colunas:
            con.execute(f"ALTER TABLE users ADD COLUMN {nome} {tipo}")

    colunas_msg = {r["name"] for r in con.execute("PRAGMA table_info(messages)")}
    novas_msg = {
        "reply_to": "INTEGER REFERENCES messages(id) ON DELETE SET NULL",
        "edited_at": "TEXT",
        "pinned": "INTEGER NOT NULL DEFAULT 0",
    }
    for nome, tipo in novas_msg.items():
        if nome not in colunas_msg:
            con.execute(f"ALTER TABLE messages ADD COLUMN {nome} {tipo}")

    con.executescript("""
    CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
    -- Amizades. Uma linha por pedido, com quem pediu e quem recebeu.
    CREATE TABLE IF NOT EXISTS friendships (
        requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status       TEXT    NOT NULL,   -- 'pendente' | 'aceito'
        created_at   TEXT    NOT NULL,
        PRIMARY KEY (requester_id, addressee_id)
    );
    """)
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# PERFIL
# ---------------------------------------------------------------------------

CAMPOS_PUBLICOS = ("id", "username", "display_name", "avatar_color",
                   "avatar_url", "bio", "status_texto", "created_at")


def perfil_publico(linha) -> dict:
    """Só os campos que podem sair do servidor (nunca o hash da senha)."""
    d = dict(linha)
    return {k: d.get(k) for k in CAMPOS_PUBLICOS}


def usuario_por_id(user_id: int):
    con = conectar()
    u = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    con.close()
    return perfil_publico(u) if u else None


def atualizar_perfil(user_id: int, display_name=None, avatar_color=None,
                     bio=None, status_texto=None, avatar_url=None):
    """Monta o UPDATE só com os campos que vieram preenchidos."""
    partes, valores = [], []
    for coluna, valor in (
        ("display_name", display_name), ("avatar_color", avatar_color),
        ("bio", bio), ("status_texto", status_texto), ("avatar_url", avatar_url),
    ):
        if valor is not None:
            partes.append(f"{coluna} = ?")
            valores.append(valor)
    if not partes:
        return usuario_por_id(user_id)

    con = conectar()
    valores.append(user_id)
    con.execute(f"UPDATE users SET {', '.join(partes)} WHERE id = ?", valores)
    con.commit()
    con.close()
    return usuario_por_id(user_id)


def trocar_senha(user_id: int, senha_atual: str, senha_nova: str) -> bool:
    con = conectar()
    u = con.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
    if not u or not conferir_senha(senha_atual, u["password_hash"]):
        con.close()
        return False
    con.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                (hash_senha(senha_nova), user_id))
    con.commit()
    # Derruba as outras sessoes: trocou a senha, os logins antigos caem.
    con.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    con.commit()
    con.close()
    return True


def servidores_em_comum(user_a: int, user_b: int):
    con = conectar()
    rows = con.execute("""
        SELECT s.id, s.name, s.icon_color FROM servers s
        JOIN memberships ma ON ma.server_id = s.id AND ma.user_id = ?
        JOIN memberships mb ON mb.server_id = s.id AND mb.user_id = ?
    """, (user_a, user_b)).fetchall()
    con.close()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# AMIZADES
# ---------------------------------------------------------------------------

def _par(a: int, b: int):
    """Busca a linha de amizade entre duas pessoas, em qualquer direcao."""
    con = conectar()
    r = con.execute("""
        SELECT * FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?)
           OR (requester_id = ? AND addressee_id = ?)
    """, (a, b, b, a)).fetchone()
    con.close()
    return dict(r) if r else None


def situacao_amizade(eu: int, outro: int) -> str:
    """Devolve: 'nenhuma' | 'amigos' | 'enviei' | 'recebi'."""
    r = _par(eu, outro)
    if not r:
        return "nenhuma"
    if r["status"] == "aceito":
        return "amigos"
    return "enviei" if r["requester_id"] == eu else "recebi"


def pedir_amizade(eu: int, outro: int) -> str:
    if eu == outro:
        return "voce_mesmo"
    existente = _par(eu, outro)
    if existente:
        if existente["status"] == "aceito":
            return "ja_amigos"
        # Se a outra pessoa ja tinha me convidado, aceitar e o certo aqui:
        # os dois querem, entao viram amigos direto.
        if existente["requester_id"] == outro:
            aceitar_amizade(eu, outro)
            return "aceito"
        return "ja_enviado"

    con = conectar()
    con.execute("INSERT INTO friendships (requester_id, addressee_id, status, created_at)"
                " VALUES (?,?,?,?)", (eu, outro, "pendente", agora()))
    con.commit()
    con.close()
    return "enviado"


def aceitar_amizade(eu: int, outro: int) -> bool:
    """Só quem RECEBEU o pedido pode aceitar."""
    con = conectar()
    cur = con.execute("""
        UPDATE friendships SET status = 'aceito'
        WHERE requester_id = ? AND addressee_id = ? AND status = 'pendente'
    """, (outro, eu))
    con.commit()
    ok = cur.rowcount > 0
    con.close()
    return ok


def desfazer_amizade(eu: int, outro: int) -> bool:
    """Serve pra recusar pedido, cancelar pedido e desfazer amizade."""
    con = conectar()
    cur = con.execute("""
        DELETE FROM friendships
        WHERE (requester_id = ? AND addressee_id = ?)
           OR (requester_id = ? AND addressee_id = ?)
    """, (eu, outro, outro, eu))
    con.commit()
    ok = cur.rowcount > 0
    con.close()
    return ok


def listar_amizades(user_id: int):
    """Devolve amigos, pedidos recebidos e pedidos enviados, de uma vez."""
    con = conectar()
    rows = con.execute("""
        SELECT f.*, u.id AS outro_id, u.username, u.display_name,
               u.avatar_color, u.avatar_url, u.status_texto
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.requester_id = ?
                                    THEN f.addressee_id ELSE f.requester_id END
        WHERE f.requester_id = ? OR f.addressee_id = ?
        ORDER BY u.display_name
    """, (user_id, user_id, user_id)).fetchall()
    con.close()

    amigos, recebidos, enviados = [], [], []
    for r in rows:
        pessoa = {
            "id": r["outro_id"], "username": r["username"],
            "display_name": r["display_name"], "avatar_color": r["avatar_color"],
            "avatar_url": r["avatar_url"], "status_texto": r["status_texto"],
        }
        if r["status"] == "aceito":
            amigos.append(pessoa)
        elif r["requester_id"] == user_id:
            enviados.append(pessoa)
        else:
            recebidos.append(pessoa)
    return {"amigos": amigos, "recebidos": recebidos, "enviados": enviados}
