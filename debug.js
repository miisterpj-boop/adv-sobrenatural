const db = require('./database');

db.all(`SELECT DISTINCT clan FROM advs WHERE removido = 0 ORDER BY clan`, (err, rows) => {
  if (err) {
    console.error('Erro:', err);
    process.exit(1);
  }
  console.log('Clans únicos no banco:');
  rows.forEach(r => console.log(`  "${r.clan}"`));
  
  console.log('\n\nTabela de clans cadastrados:');
  db.all(`SELECT nome, id_cargo_discord FROM clans WHERE ativo = 1 ORDER BY nome`, (err2, clans) => {
    if (err2) {
      console.error('Erro:', err2);
      process.exit(1);
    }
    clans.forEach(c => console.log(`  "${c.nome}" -> ${c.id_cargo_discord}`));
    process.exit(0);
  });
});
