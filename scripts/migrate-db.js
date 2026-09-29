/* Copia o banco de uma campanha inteira de um Postgres pra outro (ex.: Render → Neon).
   Não precisa de pg_dump: usa o `pg` que o projeto já tem.

   As tabelas do destino são criadas pelo próprio app — rode uma vez, antes disso:
     DATABASE_URL=<url do destino> npm start     (espere "Storage: PostgreSQL", depois Ctrl+C)

   Depois:
     FROM_URL=<origem> TO_URL=<destino> node scripts/migrate-db.js --check   (só olha, não escreve)
     FROM_URL=<origem> TO_URL=<destino> node scripts/migrate-db.js

   Destino no Aiven (ou outro que assina o certificado com autoridade própria): baixe o "CA certificate"
   do painel e passe junto — DATABASE_CA=./ca.pem no primeiro passo e TO_CA=./ca.pem aqui.

   As URLs ficam no seu terminal, nunca no repositório. Copiar duas vezes não duplica nada
   (ON CONFLICT DO NOTHING), então dá pra rodar de novo se cair a conexão no meio. */
const { Pool } = require('pg');

const FROM_URL = process.env.FROM_URL;
const TO_URL = process.env.TO_URL;
const CHECK = process.argv.includes('--check');

if (!FROM_URL || !TO_URL) {
  console.error('Faltou FROM_URL e/ou TO_URL. Veja o comentário no topo deste arquivo.');
  process.exit(1);
}

// pais antes de filhos: o que tem chave estrangeira entra depois de quem ele aponta
const TABLES = ['users', 'user_sessions', 'rooms', 'members', 'npcs', 'pokemon', 'teams', 'battles', 'media'];
const BATCH = { media: 5, battles: 50 };   // linhas grandes vão de pouco em pouco
// FROM_CA / TO_CA: o certificado do provedor (o ca.pem do Aiven, texto ou caminho do arquivo); veja db-config.js
const { pgOptions } = require('../db-config');
const connect = (url, ca) => new Pool(pgOptions(url, ca));

async function columnsOf(pool, table) {
  const r = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2', ['public', table]);
  return r.rows.map(x => x.column_name);
}
async function countOf(pool, table) {
  try { return (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n; }
  catch (e) { return null; }   // a tabela pode não existir ainda
}

async function copyTable(from, to, table) {
  const [src, dst] = [await columnsOf(from, table), await columnsOf(to, table)];
  if (!dst.length) { console.log(`  ${table}: a tabela não existe no destino — rode o app apontando pra ele antes`); return 0; }
  // só o que existe dos dois lados: assim um banco mais antigo ou mais novo de um lado não quebra a cópia
  const cols = src.filter(c => dst.includes(c));
  const faltando = src.filter(c => !dst.includes(c));
  if (faltando.length) console.log(`  ${table}: ignorando coluna que não existe no destino: ${faltando.join(', ')}`);
  if (!cols.length) return 0;

  const rows = (await from.query(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM ${table}`)).rows;
  if (!rows.length) { console.log(`  ${table}: vazia`); return 0; }

  const size = BATCH[table] || 200;
  let done = 0;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const params = [];
    const values = slice.map(row => {
      const marks = cols.map(c => { params.push(row[c]); return '$' + params.length; });
      return '(' + marks.join(', ') + ')';
    });
    await to.query(
      `INSERT INTO ${table} (${cols.map(c => `"${c}"`).join(', ')}) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params);
    done += slice.length;
    if (rows.length > size) process.stdout.write(`\r  ${table}: ${done}/${rows.length}`);
  }
  console.log(`\r  ${table}: ${done} linha${done === 1 ? '' : 's'}                `);
  return done;
}

(async () => {
  const from = connect(FROM_URL, process.env.FROM_CA), to = connect(TO_URL, process.env.TO_CA);
  try {
    console.log('Origem  →', FROM_URL.replace(/:[^:@/]+@/, ':***@'));
    console.log('Destino →', TO_URL.replace(/:[^:@/]+@/, ':***@'));

    // tamanho dos arquivos enviados (música e imagens): é o que mais pesa, e o plano free tem limite
    const media = await from.query('SELECT count(*)::int AS n, coalesce(sum(length(data)), 0)::bigint AS bytes FROM media')
      .catch(() => ({ rows: [{ n: 0, bytes: 0 }] }));
    const mb = (Number(media.rows[0].bytes) / 1048576).toFixed(1);
    console.log(`\nArquivos enviados (tabela media): ${media.rows[0].n} — ${mb} MB\n`);

    console.log('Linhas hoje:');
    for (const t of TABLES) {
      console.log(`  ${t.padEnd(14)} origem: ${String(await countOf(from, t)).padStart(6)}   destino: ${String(await countOf(to, t)).padStart(6)}`);
    }
    if (CHECK) { console.log('\n--check: nada foi escrito.'); return; }

    console.log('\nCopiando...');
    for (const t of TABLES) await copyTable(from, to, t);

    console.log('\nConferindo:');
    let ok = true;
    for (const t of TABLES) {
      const [a, b] = [await countOf(from, t), await countOf(to, t)];
      const igual = a === b;
      if (!igual) ok = false;
      console.log(`  ${igual ? '✓' : '✗'} ${t.padEnd(14)} origem: ${String(a).padStart(6)}   destino: ${String(b).padStart(6)}`);
    }
    console.log(ok
      ? '\nTudo batendo. Agora troque a DATABASE_URL do serviço no Render pela do destino.'
      : '\nAlgo não bateu. Rode de novo (copiar duas vezes não duplica) e veja o que sobrou diferente.');
  } catch (e) {
    console.error('\nDeu erro:', e.message);
    process.exitCode = 1;
  } finally {
    await from.end(); await to.end();
  }
})();
