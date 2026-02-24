/**
 * repair-articulos.js — Re-parsea texto de normas sin artículos.
 *
 * Recorre normas que tienen url_texto_actualizado pero 0 artículos en la tabla
 * articulos, las re-fetchea del sitio, aplica el parser actualizado y guarda.
 * Reanudable: si se interrumpe, retoma desde donde quedó (filtra siempre por
 * normas SIN artículos).
 *
 * Uso:
 *   node db/repair-articulos.js
 *   node db/repair-articulos.js --tipo resolucion
 *   node db/repair-articulos.js --tipo disposicion --desde-anio 2010
 *
 * Variables de entorno:
 *   SCRAPER_DELAY_MS  — delay entre requests HTTP (default 500)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const crypto  = require('crypto');
const { Pool } = require('pg');
const { fetchTextoActualizado, delay, DELAY_MS: DELAY_DEFAULT } = require('../scraper/crawler');
const { parseTextoActualizado } = require('../scraper/parser');

const pool    = new Pool({ connectionString: process.env.DATABASE_URL });
const DELAY   = parseInt(process.env.SCRAPER_DELAY_MS || DELAY_DEFAULT || '500');
const BATCH   = 200;

// Args
const args       = process.argv.slice(2);
const TIPO       = args[args.indexOf('--tipo')       + 1] || null;
const DESDE_ANIO = args[args.indexOf('--desde-anio') + 1] || null;

let shutdown = false;
process.on('SIGINT',  () => { console.log('\n⏹  SIGINT — terminando...'); shutdown = true; });
process.on('SIGTERM', () => { console.log('\n⏹  SIGTERM — terminando...'); shutdown = true; });

function ts() { return new Date().toTimeString().slice(0, 8); }

async function obtenerPendientes() {
  const filtros = [];
  const params  = [BATCH];

  if (TIPO)       { filtros.push(`n.tipo = $${params.length + 1}`);  params.push(TIPO); }
  if (DESDE_ANIO) { filtros.push(`n.anio >= $${params.length + 1}`); params.push(parseInt(DESDE_ANIO)); }

  const where = filtros.length ? 'AND ' + filtros.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT n.id, n.tipo, n.numero, n.anio, n.url_texto_actualizado
    FROM normas n
    WHERE n.url_texto_actualizado IS NOT NULL
      ${where}
      AND NOT EXISTS (SELECT 1 FROM articulos a WHERE a.norma_id = n.id)
    ORDER BY n.tipo, n.anio DESC, n.numero
    LIMIT $1
  `, params);
  return rows;
}

async function contarPendientes() {
  const filtros = [];
  const params  = [];

  if (TIPO)       { filtros.push(`n.tipo = $${params.length + 1}`);  params.push(TIPO); }
  if (DESDE_ANIO) { filtros.push(`n.anio >= $${params.length + 1}`); params.push(parseInt(DESDE_ANIO)); }

  const where = filtros.length ? 'AND ' + filtros.join(' AND ') : '';

  const { rows } = await pool.query(`
    SELECT COUNT(*) AS total FROM normas n
    WHERE n.url_texto_actualizado IS NOT NULL
      ${where}
      AND NOT EXISTS (SELECT 1 FROM articulos a WHERE a.norma_id = n.id)
  `, params);
  return parseInt(rows[0].total);
}

/**
 * Guarda artículos y actualiza texto_completo, estado y embeddings.
 * Fuerza la actualización aunque el hash HTML no haya cambiado
 * (el parser anterior no encontraba artículos con el mismo HTML).
 */
async function guardarArticulos(normaId, html, articulos) {
  const hash         = crypto.createHash('sha256').update(html).digest('hex');
  const textoCompleto = articulos.map(a => `${a.numero_articulo}. ${a.texto}`).join('\n\n');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE normas SET
        texto_completo        = $1,
        texto_actualizado_hash = $2,
        estado                = 'texto_extraido',
        ultimo_scrape         = NOW()
      WHERE id = $3
    `, [textoCompleto, hash, normaId]);

    await client.query('DELETE FROM articulos WHERE norma_id = $1', [normaId]);
    for (const art of articulos) {
      await client.query(`
        INSERT INTO articulos (norma_id, numero_articulo, orden, texto)
        VALUES ($1, $2, $3, $4)
      `, [normaId, art.numero_articulo, art.orden, art.texto]);
    }

    // Re-encolar embedding de la norma
    await client.query(`
      INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
      VALUES ('norma', $1, 'embedding_resumen', 3)
      ON CONFLICT (entidad_tipo, entidad_id, campo_embedding) DO UPDATE SET
        procesado_at = NULL, intentos = 0, creado_at = NOW()
    `, [normaId]);

    // Encolar embeddings para artículos nuevos
    const { rows: artRows } = await client.query(
      'SELECT id FROM articulos WHERE norma_id = $1', [normaId]
    );
    for (const { id } of artRows) {
      await client.query(`
        INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
        VALUES ('articulo', $1, 'embedding', 5)
        ON CONFLICT DO NOTHING
      `, [id]);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const total = await contarPendientes();

  console.log('=== REPAIR ARTICULOS ===');
  console.log(`Tipo:       ${TIPO || 'todos'}`);
  console.log(`Desde año:  ${DESDE_ANIO || 'todos'}`);
  console.log(`Delay:      ${DELAY}ms`);
  console.log(`Pendientes: ${total} normas sin artículos\n`);

  if (total === 0) {
    console.log('✅ No hay normas sin artículos.');
    await pool.end();
    return;
  }

  let procesadas  = 0;
  let reparadas   = 0;
  let sinArts     = 0;
  let errores     = 0;

  while (!shutdown) {
    const normas = await obtenerPendientes();
    if (normas.length === 0) break;

    console.log(`[${ts()}] Procesando batch de ${normas.length}...`);

    for (const norma of normas) {
      if (shutdown) break;

      const label = `${norma.tipo} ${norma.numero}/${norma.anio}`;
      process.stdout.write(`  ${label}... `);

      try {
        const html      = await fetchTextoActualizado(norma.url_texto_actualizado);
        const articulos = parseTextoActualizado(html);

        if (articulos.length > 0) {
          await guardarArticulos(norma.id, html, articulos);
          process.stdout.write(`✅ ${articulos.length} arts\n`);
          reparadas++;
        } else {
          process.stdout.write(`— sin arts\n`);
          sinArts++;
        }
      } catch (err) {
        const status = err.response?.status;
        process.stdout.write(`❌ ${status ? `HTTP ${status}` : err.message}\n`);
        errores++;
      }

      procesadas++;
      if (procesadas % 50 === 0) {
        const pct = ((procesadas / total) * 100).toFixed(1);
        console.log(`  → ${procesadas}/${total} (${pct}%) | reparadas: ${reparadas} | sin arts: ${sinArts} | errores: ${errores}`);
      }

      await delay(DELAY);
    }
  }

  console.log(`\n✅ Reparación terminada.`);
  console.log(`   Procesadas:    ${procesadas}`);
  console.log(`   Reparadas:     ${reparadas}`);
  console.log(`   Sin artículos: ${sinArts}`);
  console.log(`   Errores:       ${errores}`);
  await pool.end();
}

main().catch(async e => {
  console.error('\n❌ ERROR FATAL:', e.message);
  await pool.end();
  process.exit(1);
});
