/**
 * Resetea todos los embeddings para re-generarlos con un nuevo modelo.
 * Uso: node db/reset-embeddings.js
 *
 * - Limpia embedding_resumen en normas
 * - Limpia embedding en articulos
 * - Resetea la cola_embeddings (marca todo como pendiente)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('⚠️  Reseteando embeddings para re-generación con nuevo modelo...\n');

  const { rowCount: n1 } = await pool.query(
    `UPDATE normas SET embedding_resumen = NULL, embeddings_generados_at = NULL,
     estado = CASE WHEN estado = 'embeddings_generados' THEN 'texto_extraido' ELSE estado END`
  );
  console.log(`  normas reseteadas:    ${n1}`);

  const { rowCount: n2 } = await pool.query(
    `UPDATE articulos SET embedding = NULL`
  );
  console.log(`  artículos reseteados: ${n2}`);

  // Resetear cola: marcar todo como pendiente de nuevo
  const { rowCount: n3 } = await pool.query(
    `UPDATE cola_embeddings SET procesado_at = NULL, intentos = 0, ultimo_error = NULL`
  );
  console.log(`  cola reseteada:       ${n3} items`);

  // Re-encolar normas con texto que no estén en la cola todavía
  const { rowCount: n4 } = await pool.query(`
    INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
    SELECT 'norma', id, 'embedding_resumen', 3
    FROM normas
    WHERE resumen IS NOT NULL
    ON CONFLICT (entidad_tipo, entidad_id, campo_embedding) DO NOTHING
  `);
  console.log(`  normas re-encoladas:  ${n4}`);

  const { rowCount: n5 } = await pool.query(`
    INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
    SELECT 'articulo', id, 'embedding', 5
    FROM articulos
    ON CONFLICT (entidad_tipo, entidad_id, campo_embedding) DO NOTHING
  `);
  console.log(`  artículos re-encolados: ${n5}`);

  const { rows } = await pool.query(
    `SELECT COUNT(*) as pendientes FROM cola_embeddings WHERE procesado_at IS NULL`
  );
  console.log(`\n  Total pendientes en cola: ${rows[0].pendientes}`);
  console.log('\n✅ Listo. Podés reiniciar el embedder.');
}

main()
  .catch(e => { console.error('❌ ERROR:', e.message); process.exit(1); })
  .finally(() => pool.end());
