const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('advs.db');

db.serialize(() => {
  // Tabela de usuários
  db.run(`CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )`);

  // Tabela de clãs
  db.run(`CREATE TABLE IF NOT EXISTS clans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT UNIQUE NOT NULL,
    id_cargo_discord TEXT NOT NULL,
    criado_em TEXT NOT NULL,
    ativo INTEGER DEFAULT 1
  )`);

  // Tabela de advertências
  db.run(`CREATE TABLE IF NOT EXISTS advs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    membro TEXT NOT NULL,
    clan TEXT NOT NULL,
    motivo TEXT NOT NULL,
    data_aplicacao TEXT NOT NULL,
    data_expiracao TEXT NOT NULL,
    removido INTEGER DEFAULT 0,
    removido_em TEXT,
    criado_por TEXT
  )`);

  // Inserir usuário padrão (se não existir)
  const bcrypt = require('bcrypt');
  const senhaHash = bcrypt.hashSync('Atlanta22', 10);
  db.run(
    `INSERT OR IGNORE INTO usuarios (username, password) VALUES (?, ?)`,
    ['Pinguim', senhaHash]
  );
});

module.exports = db;
