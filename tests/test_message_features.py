import os
import tempfile
import unittest

import db


class MessageFeaturesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database_original = db.DB_PATH
        db.DB_PATH = os.path.join(self.temp.name, "codecom-test.db")
        db.criar_tabelas()
        db.migrar()
        con = db.conectar()
        for username in ("ana", "bia"):
            con.execute(
                "INSERT INTO users (username, display_name, password_hash, avatar_color, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (username, username.title(), "test", "#55dfb2", db.agora()),
            )
        con.execute(
            "INSERT INTO channels (server_id, name, kind, created_at) VALUES (NULL, 'dm', 'dm', ?)",
            (db.agora(),),
        )
        con.commit()
        con.close()

    def tearDown(self):
        db.DB_PATH = self.database_original
        self.temp.cleanup()

    def test_reply_edit_pin_reactions_and_search_survive_history_reads(self):
        original = db.criar_mensagem(1, 1, "reunião amanhã")
        reply = db.criar_mensagem(1, 2, "combinado", reply_to=original["id"])
        self.assertEqual(reply["reply"]["author"], "Ana")

        edited = db.editar_mensagem(reply["id"], 2, "fechado")
        self.assertEqual(edited["content"], "fechado")
        self.assertTrue(edited["edited_at"])
        self.assertIsNone(db.editar_mensagem(reply["id"], 1, "não sou a autora"))

        db.fixar_mensagem(original["id"], 1, True)
        self.assertEqual(db.mensagens_do_canal(1, busca="reunião")[0]["id"], original["id"])
        self.assertTrue(db.mensagens_do_canal(1, fixadas=True)[0]["pinned"])

        reacoes = db.alternar_reacao(original["id"], 2, "👍")["reactions"]
        self.assertEqual(reacoes, [{"emoji": "👍", "count": 1, "user_ids": [2]}])
        self.assertEqual(db.mensagens_do_canal(1)[0]["reactions"], reacoes)
        self.assertEqual(db.alternar_reacao(original["id"], 2, "👍")["reactions"], [])


if __name__ == "__main__":
    unittest.main()
