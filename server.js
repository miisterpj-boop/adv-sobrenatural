const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const db = require('./database');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const ExcelJS = require('xlsx');
const archiver = require('archiver');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: 'pinguim_secret_key_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 horas
}));

// Rota raiz (fallback para SPA)
app.get("/", (req, res) => {
  res.sendFile("public/index.html", { root: __dirname });
});

// Middleware de autenticação
const verificarAuth = (req, res, next) => {
  if (req.session.usuario) {
    next();
  } else {
    res.status(401).json({ erro: 'Não autenticado' });
  }
};

// ============ ROTAS DE AUTENTICAÇÃO ============
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM usuarios WHERE username = ?', [username], (err, usuario) => {
    if (!usuario) {
      return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
    }

    bcrypt.compare(password, usuario.password, (err, match) => {
      if (match) {
        req.session.usuario = username;
        res.json({ ok: true });
      } else {
        res.status(401).json({ erro: 'Usuário ou senha incorretos' });
      }
    });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/usuario', (req, res) => {
  if (req.session.usuario) {
    res.json({ usuario: req.session.usuario });
  } else {
    res.status(401).json({ erro: 'Não autenticado' });
  }
});

// ============ FUNÇÃO AUXILIAR PARA RESOLVER CLÃS ============
function resolveClanName(clanInput, callback) {
  if (!clanInput) {
    return callback('Não Cadastrado');
  }

  const input = clanInput.trim();

  // Extrair ID de menção Discord (formato: <@&ID>)
  const mentionMatch = input.match(/<@&(\d+)>/);
  if (mentionMatch) {
    const discordId = mentionMatch[1];
    return db.get(
      `SELECT nome FROM clans WHERE id_cargo_discord = ? AND ativo = 1`,
      [discordId],
      (err, clan) => {
        callback(clan ? clan.nome : input);
      }
    );
  }

  // Buscar por nome exato (case-insensitive)
  db.get(
    `SELECT nome FROM clans WHERE LOWER(nome) = LOWER(?) AND ativo = 1`,
    [input],
    (err, clan) => {
      if (clan) {
        return callback(clan.nome);
      }

      // Buscar por ID Discord direto (sem menção)
      db.get(
        `SELECT nome FROM clans WHERE id_cargo_discord = ? AND ativo = 1`,
        [input],
        (err, clan2) => {
          if (clan2) {
            return callback(clan2.nome);
          }

          // Última tentativa: busca case-insensitive removendo caracteres especiais
          const cleanInput = input.toLowerCase().replace(/[^\w\s]/g, '');
          db.get(
            `SELECT nome FROM clans WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(nome, '@', ''), '🩸', ''), '・', ''), '・', ''), ' ', '')) = ? AND ativo = 1 LIMIT 1`,
            [cleanInput],
            (err, clan3) => {
              callback(clan3 ? clan3.nome : input);
            }
          );
        }
      );
    }
  );
}

// ============ ROTAS DE CLÃS ============
app.post('/api/clans', verificarAuth, (req, res) => {
  const { nome, id_cargo_discord } = req.body;

  if (!nome || !id_cargo_discord) {
    return res.status(400).json({ erro: 'Nome e ID do cargo são obrigatórios' });
  }

  const agora = new Date().toISOString();
  db.run(
    `INSERT INTO clans (nome, id_cargo_discord, criado_em) VALUES (?, ?, ?)`,
    [nome, id_cargo_discord, agora],
    (err) => {
      if (err) {
        return res.status(400).json({ erro: 'Clã já cadastrado' });
      }
      res.json({ ok: true });
    }
  );
});

app.get('/api/clans', verificarAuth, (req, res) => {
  db.all(`SELECT * FROM clans WHERE ativo = 1 ORDER BY nome`, (err, clans) => {
    if (err) return res.status(500).json({ erro: 'Erro ao buscar clãs' });
    res.json(clans || []);
  });
});

app.delete('/api/clans/:id', verificarAuth, (req, res) => {
  db.run(
    `UPDATE clans SET ativo = 0 WHERE id = ?`,
    [req.params.id],
    (err) => {
      if (err) return res.status(500).json({ erro: 'Erro ao deletar clã' });
      res.json({ ok: true });
    }
  );
});

// ============ ROTAS DE ADVERTÊNCIAS ============
app.post('/api/advs', verificarAuth, (req, res) => {
  const { membro, clan, motivo, dataAplicacao } = req.body;

  if (!membro || !clan || !motivo || !dataAplicacao) {
    return res.status(400).json({ erro: 'Campos obrigatórios' });
  }

  // Resolver o nome do clã (ANTES de verificar duplicata)
  resolveClanName(clan, (clanResolvido) => {
    // Verificar se já existe advertência idêntica (mesmo membro + mesmo motivo)
    db.get(
      `SELECT id FROM advs 
       WHERE LOWER(membro) = LOWER(?) 
       AND LOWER(motivo) = LOWER(?)
       AND removido = 0`,
      [membro.trim(), motivo.trim()],
      (err, existente) => {
        if (existente) {
          return res.status(400).json({ 
            erro: 'Esta advertência já existe para este membro' 
          });
        }

        // Converter data do formato YYYY-MM-DD para ISO string com hora 00:00:00
        const dataObj = new Date(dataAplicacao + 'T00:00:00Z');
        const expiracao = new Date(dataObj);
        expiracao.setDate(expiracao.getDate() + 30);

        db.run(
          `INSERT INTO advs (membro, clan, motivo, data_aplicacao, data_expiracao, criado_por)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [membro.trim(), clanResolvido, motivo.trim(), dataObj.toISOString(), expiracao.toISOString(), req.session.usuario],
          (err) => {
            if (err) return res.status(500).json({ erro: 'Erro ao adicionar ADV' });
            res.json({ ok: true });
          }
        );
      }
    );
  });
});

app.get('/api/advs', verificarAuth, (req, res) => {
  const agora = new Date().toISOString();
  
  db.all(
    `SELECT * FROM advs 
     WHERE removido = 0 AND data_expiracao > ?
     ORDER BY data_aplicacao DESC`,
    [agora],
    (err, advs) => {
      if (err) return res.status(500).json({ erro: 'Erro ao buscar ADVs' });
      res.json(advs || []);
    }
  );
});

app.get('/api/advs/historico', verificarAuth, (req, res) => {
  db.all(
    `SELECT * FROM advs ORDER BY data_aplicacao DESC LIMIT 500`,
    (err, advs) => {
      if (err) return res.status(500).json({ erro: 'Erro ao buscar histórico' });
      res.json(advs || []);
    }
  );
});

app.put('/api/advs/:id', verificarAuth, (req, res) => {
  const { membro, clan, motivo, dataAplicacao } = req.body;

  // Resolver o nome do clã
  resolveClanName(clan, (clanResolvido) => {
    // Converter data se fornecida
    let updates = [membro, clanResolvido, motivo];
    let query = `UPDATE advs SET membro = ?, clan = ?, motivo = ?`;
    
    if (dataAplicacao) {
      const dataObj = new Date(dataAplicacao + 'T00:00:00Z');
      const expiracao = new Date(dataObj);
      expiracao.setDate(expiracao.getDate() + 30);
      
      query += `, data_aplicacao = ?, data_expiracao = ?`;
      updates.push(dataObj.toISOString());
      updates.push(expiracao.toISOString());
    }
    
    query += ` WHERE id = ?`;
    updates.push(req.params.id);

    db.run(query, updates, (err) => {
      if (err) return res.status(500).json({ erro: 'Erro ao editar ADV' });
      res.json({ ok: true });
    });
  });
});

app.delete('/api/advs/:id', verificarAuth, (req, res) => {
  db.run(
    `UPDATE advs SET removido = 1, removido_em = ? WHERE id = ?`,
    [new Date().toISOString(), req.params.id],
    (err) => {
      if (err) return res.status(500).json({ erro: 'Erro ao remover ADV' });
      res.json({ ok: true });
    }
  );
});

// ============ IMPORTAÇÃO ============
app.post('/api/importar', verificarAuth, (req, res) => {
  const { texto } = req.body;

  if (!texto) {
    return res.status(400).json({ erro: 'Texto não fornecido' });
  }

  // Dividir o texto em múltiplos blocos (separados por linhas em branco duplas ou numeração)
  const blocos = texto.split(/\n\s*\n+/).filter(b => b.trim());
  const advs = [];
  let sucessos = 0;
  let erros = 0;
  let duplicadas = 0;

  const processarBlocos = (index) => {
    if (index >= blocos.length) {
      // Todas as advertências foram processadas
      return res.json({ ok: true, sucessos, erros, duplicadas, total: blocos.length });
    }

    const bloco = blocos[index];
    const linhas = bloco.split('\n').filter(l => l.trim());
    let membro = 'Desconhecido';
    let clan = 'Não Cadastrado';
    let motivo = 'Sem motivo informado';
    let dataAplicacao = new Date(); // Data padrão é hoje

    // Extrair informações do bloco
    linhas.forEach(linha => {
      if (linha.includes('Nome') || linha.includes('Membro') || linha.includes('User')) {
        membro = linha.split(':')[1]?.trim() || membro;
      }
      if (linha.includes('Clã') || linha.includes('Clan')) {
        clan = linha.split(':')[1]?.trim() || clan;
      }
      if (linha.includes('Motivo') || linha.includes('Razão') || linha.includes('Reason')) {
        motivo = linha.split(':')[1]?.trim() || motivo;
      }
      // Extrair data de aplicação em formatos: DD/MM/YYYY ou YYYY-MM-DD
      if (linha.includes('Data') && !linha.includes('Expira')) {
        const dataStr = linha.split(':')[1]?.trim();
        if (dataStr) {
          // Tentar converter de DD/MM/YYYY ou YYYY-MM-DD
          let dataObj = null;
          if (dataStr.includes('/')) {
            const [dia, mes, ano] = dataStr.split('/');
            dataObj = new Date(ano, mes - 1, dia);
          } else if (dataStr.includes('-')) {
            dataObj = new Date(dataStr);
          }
          if (dataObj && !isNaN(dataObj)) {
            dataAplicacao = dataObj;
          }
        }
      }
    });

    // PRIMEIRO resolver o clan, DEPOIS verificar duplicata
    resolveClanName(clan, (clanResolvido) => {
      // Verificar duplicata (usando clan resolvido)
      db.get(
        `SELECT id FROM advs 
         WHERE LOWER(membro) = LOWER(?) 
         AND LOWER(motivo) = LOWER(?)
         AND removido = 0`,
        [membro.trim(), motivo.trim()],
        (err, existente) => {
          if (existente) {
            duplicadas++;
            return processarBlocos(index + 1);
          }

          // Calcular expiração a partir da data de aplicação
          const expiracao = new Date(dataAplicacao);
          expiracao.setDate(expiracao.getDate() + 30);

          // Inserir a advertência
          db.run(
            `INSERT INTO advs (membro, clan, motivo, data_aplicacao, data_expiracao, criado_por)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [membro.trim(), clanResolvido, motivo.trim(), dataAplicacao.toISOString(), expiracao.toISOString(), req.session.usuario],
            (err) => {
              if (err) {
                erros++;
              } else {
                sucessos++;
                advs.push({ membro, clan: clanResolvido, motivo });
              }

              processarBlocos(index + 1);
            }
          );
        }
      );
    });
  };

  processarBlocos(0);
});

// ============ DASHBOARD ============
app.get('/api/dashboard', verificarAuth, (req, res) => {
  const agora = new Date().toISOString();

  db.all(
    `SELECT clan, COUNT(*) as total, COUNT(DISTINCT membro) as membros
     FROM advs WHERE removido = 0 AND data_expiracao > ?
     GROUP BY clan ORDER BY total DESC`,
    [agora],
    (err, ranking) => {
      if (err) {
        console.error('Erro ao buscar ranking:', err);
        return res.status(500).json({ erro: 'Erro no dashboard' });
      }

      db.get(
        `SELECT COUNT(*) as total FROM advs WHERE removido = 0 AND data_expiracao > ?`,
        [agora],
        (err, stats) => {
          if (err) {
            console.error('Erro ao buscar stats:', err);
            return res.status(500).json({ erro: 'Erro no dashboard' });
          }

          db.get(
            `SELECT COUNT(*) as total FROM clans WHERE ativo = 1`,
            (err, clansStats) => {
              if (err) {
                console.error('Erro ao buscar clansStats:', err);
                return res.status(500).json({ erro: 'Erro no dashboard' });
              }

              res.json({
                totalAdvs: (stats && stats.total) || 0,
                totalClans: (clansStats && clansStats.total) || 0,
                ranking: ranking || []
              });
            }
          );
        }
      );
    }
  );
});

// ============ PENALIDADES ============
app.get('/api/penalidades', verificarAuth, (req, res) => {
  const agora = new Date();
  const trinta_dias_atras = new Date(agora.getTime() - (30 * 24 * 60 * 60 * 1000)).toISOString();

  // Primeiro, buscar todos os clans
  db.all(`SELECT nome, id_cargo_discord FROM clans WHERE ativo = 1`, (err, clans) => {
    if (err) return res.status(500).json({ erro: 'Erro ao buscar clans' });

    // Criar mapas para lookup rápido
    const clanMap = {};
    const clanNameMap = {}; // Mapear ID e menção para nome canônico
    const clanNameLowerMap = {}; // Mapa case-insensitive para nome
    
    clans.forEach(clan => {
      clanMap[clan.nome] = clan.id_cargo_discord;
      clanNameMap[clan.id_cargo_discord] = clan.nome;
      clanNameMap[clan.nome] = clan.nome;
      // Para busca case-insensitive, remover caracteres especiais
      const cleanName = clan.nome.toLowerCase().replace(/[^\w\s]/g, '');
      clanNameLowerMap[cleanName] = { nome: clan.nome, id: clan.id_cargo_discord };
    });

    // Buscar todas as advs (sem GROUP BY ainda) para normalizar clans
    db.all(
      `SELECT membro, clan
       FROM advs 
       WHERE removido = 0 AND data_aplicacao > ?
       ORDER BY clan DESC`,
      [trinta_dias_atras],
      (err, todasAdvs) => {
        if (err) return res.status(500).json({ erro: 'Erro ao calcular penalidades' });

        // Normalizar clans e contar membros únicos por clan normalizado
        const penaclidadesMap = {}; // { clanNormalizado: { membros: Set, discordId: '...' } }

        todasAdvs.forEach(adv => {
          // Normalizar o nome do clan
          let clanNormalizado = adv.clan;
          let discordId = null;

          // Verificar se é menção Discord
          const mentionMatch = adv.clan.match(/<@&(\d+)>/);
          if (mentionMatch) {
            discordId = mentionMatch[1];
            clanNormalizado = clanNameMap[discordId] || adv.clan;
          }
          // Verificar se é um ID Discord direto
          else if (/^\d+$/.test(adv.clan) && clanNameMap[adv.clan]) {
            clanNormalizado = clanNameMap[adv.clan];
            discordId = adv.clan;
          }
          // Verificar se é um nome exato de clan
          else if (clanMap[clanNormalizado]) {
            discordId = clanMap[clanNormalizado];
          }
          // Buscar case-insensitive removendo caracteres especiais
          else {
            const cleanInput = adv.clan.toLowerCase().replace(/[^\w\s]/g, '');
            if (clanNameLowerMap[cleanInput]) {
              const match = clanNameLowerMap[cleanInput];
              clanNormalizado = match.nome;
              discordId = match.id;
            }
          }

          // Adicionar ao mapa de penalidades
          if (!penaclidadesMap[clanNormalizado]) {
            penaclidadesMap[clanNormalizado] = {
              membros: new Set(),
              discordId: discordId
            };
          }
          penaclidadesMap[clanNormalizado].membros.add(adv.membro);
        });

        // Converter mapa para array e ordenar
        const penalidades = Object.entries(penaclidadesMap)
          .map(([clanName, data]) => {
            const membros_unicos = data.membros.size;
            let nivel = 0;
            if (membros_unicos >= 9) nivel = 3;
            else if (membros_unicos >= 7) nivel = 2;
            else if (membros_unicos >= 5) nivel = 1;

            // Formato: CLAN NAME - DISCORD ID
            const clanDisplay = data.discordId 
              ? `${clanName} - ${data.discordId}`
              : clanName;

            return {
              clan: clanDisplay,
              membros_unicos: membros_unicos,
              nivel_penalidade: nivel,
              descricao: nivel === 0 ? 'Nenhuma' : `Nível ${nivel}`
            };
          })
          .sort((a, b) => b.membros_unicos - a.membros_unicos);

        res.json(penalidades);
      }
    );
  });
});

// ============ EXPORTAÇÃO ============
app.get('/api/exportar/excel', verificarAuth, (req, res) => {
  const agora = new Date().toISOString();

  db.all(
    `SELECT membro, clan, motivo, data_aplicacao, data_expiracao 
     FROM advs WHERE removido = 0 ORDER BY data_aplicacao DESC`,
    (err, advs) => {
      if (err) return res.status(500).json({ erro: 'Erro ao exportar' });

      const ws = ExcelJS.utils.json_to_sheet(advs.map(a => ({
        Membro: a.membro,
        'Clã': a.clan,
        Motivo: a.motivo,
        'Data Aplicação': new Date(a.data_aplicacao).toLocaleDateString('pt-BR'),
        'Data Expiração': new Date(a.data_expiracao).toLocaleDateString('pt-BR')
      })));

      const wb = ExcelJS.utils.book_new();
      ExcelJS.utils.book_append_sheet(wb, ws, 'Advertências');

      const buffer = ExcelJS.write(wb, { bookType: 'xlsx', type: 'buffer' });
      
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', 'attachment; filename="advertencias.xlsx"');
      res.send(buffer);
    }
  );
});

app.get('/api/exportar/pdf', verificarAuth, (req, res) => {
  db.all(
    `SELECT membro, clan, motivo, data_aplicacao, data_expiracao 
     FROM advs WHERE removido = 0 ORDER BY data_aplicacao DESC`,
    (err, advs) => {
      if (err) return res.status(500).json({ erro: 'Erro ao exportar' });

      const doc = new PDFDocument();
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', 'attachment; filename="advertencias.pdf"');
      
      doc.pipe(res);
      
      doc.fontSize(20).text('Relatório de Advertências', { align: 'center' });
      doc.moveDown();
      doc.fontSize(10).text(`Data: ${new Date().toLocaleDateString('pt-BR')}`, { align: 'center' });
      doc.moveDown();

      advs.forEach((adv, idx) => {
        doc.fontSize(11).text(`${idx + 1}. ${adv.membro}`, { underline: true });
        doc.fontSize(10).text(`   Clã: ${adv.clan}`);
        doc.text(`   Motivo: ${adv.motivo}`);
        doc.text(`   Data: ${new Date(adv.data_aplicacao).toLocaleDateString('pt-BR')}`);
        doc.moveDown(0.5);
      });

      doc.end();
    }
  );
});

// ============ FALLBACK SPA ============
// Se a rota não é API, redireciona para index.html
app.use((req, res) => {
  if (!req.path.startsWith('/api')) {
