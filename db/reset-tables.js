/**
 * Limpia todas las tablas del proyecto (TRUNCATE CASCADE).
 * Uso: node db/reset-tables.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('⚠️  Limpiando todas las tablas...\n');

  // TRUNCATE CASCADE limpia en orden correcto respetando FK
  await pool.query(`
    TRUNCATE TABLE
      historial_cambios,
      cola_embeddings,
      relaciones_normativas,
      articulos,
      normas
    RESTART IDENTITY CASCADE
  `);

  // Verificar
  const tablas = ['normas', 'articulos', 'relaciones_normativas', 'cola_embeddings', 'historial_cambios'];
  for (const tabla of tablas) {
    const { rows } = await pool.query(`SELECT COUNT(*) AS cnt FROM ${tabla}`);
    console.log(`  ${tabla}: ${rows[0].cnt} filas`);
  }

  console.log('\n✅ Tablas limpias.');
}

main()
  .catch(e => {
    console.error('❌ ERROR:', e.message);
    process.exit(1);
  })
  .finally(() => pool.end());
