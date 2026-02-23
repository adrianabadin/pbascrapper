/**
 * Ajusta rango_normativo de todas las normas según su tipo,
 * y marca los códigos provinciales conocidos de Buenos Aires.
 *
 * Uso: node db/seed-jerarquia.js
 *
 * Seguro de correr múltiples veces (idempotente).
 * Requiere haber corrido antes: db/migrations/001_jerarquia_normativa.sql
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Jerarquía
// ---------------------------------------------------------------------------
// 1 = Constitución Provincial
// 2 = Códigos provinciales
// 3 = Ley ordinaria / Decreto-Ley (misma fuerza legal)
// 4 = Decreto del Poder Ejecutivo
// 5 = Resolución / Disposición / Resolución Conjunta
// 6 = Ordenanza General

const RANGOS_POR_TIPO = [
  { tipos: ['ley', 'decreto_ley'],                             rango: 3 },
  { tipos: ['decreto'],                                        rango: 4 },
  { tipos: ['resolucion', 'disposicion', 'resolucion_conjunta'], rango: 5 },
  { tipos: ['ordenanza_general'],                              rango: 6 },
];

// ---------------------------------------------------------------------------
// Códigos provinciales conocidos de Buenos Aires
// Fuente: textos oficiales publicados en normas.gba.gob.ar
// Si el número no está en la DB todavía, el UPDATE afecta 0 filas (sin error).
// ---------------------------------------------------------------------------
const CODIGOS = [
  // Código Fiscal (texto ordenado por Decreto 39/11, ley base 10397)
  { tipo: 'ley',        numero: 10397, nombre: 'Código Fiscal' },

  // Código de Procedimiento Civil y Comercial
  { tipo: 'decreto_ley', numero: 7425,  nombre: 'Código Procesal Civil y Comercial' },

  // Código Contencioso Administrativo
  { tipo: 'ley',        numero: 12008, nombre: 'Código Contencioso Administrativo' },

  // Código Rural
  { tipo: 'decreto_ley', numero: 7616,  nombre: 'Código Rural' },

  // Código de Faltas (Decreto-Ley 8031/73)
  { tipo: 'decreto_ley', numero: 8031,  nombre: 'Código de Faltas' },

  // Código Procesal Penal
  { tipo: 'ley',        numero: 11922, nombre: 'Código Procesal Penal' },

  // Código Procesal del Trabajo
  { tipo: 'ley',        numero: 11653, nombre: 'Código Procesal del Trabajo' },

  // Ley Orgánica de Municipalidades
  { tipo: 'decreto_ley', numero: 6769,  nombre: 'Ley Orgánica de Municipalidades' },

  // Ley Orgánica del Poder Judicial
  { tipo: 'ley',        numero: 5827,  nombre: 'Ley Orgánica del Poder Judicial' },

  // Ley Orgánica de la Policía Bonaerense
  { tipo: 'ley',        numero: 13482, nombre: 'Ley Orgánica de la Policía Bonaerense' },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Seed jerarquía normativa ===\n');

  // 1. Rangos por tipo
  console.log('1. Ajustando rangos por tipo...');
  for (const { tipos, rango } of RANGOS_POR_TIPO) {
    const { rowCount } = await pool.query(
      `UPDATE normas SET rango_normativo = $1 WHERE tipo = ANY($2::text[])`,
      [rango, tipos]
    );
    console.log(`   rango ${rango} → ${tipos.join(', ')}: ${rowCount} normas`);
  }

  // 2. Códigos conocidos
  console.log('\n2. Marcando códigos provinciales conocidos...');
  for (const { tipo, numero, nombre } of CODIGOS) {
    const { rowCount } = await pool.query(
      `UPDATE normas SET rango_normativo = 2, nombre_codigo = $1
       WHERE tipo = $2 AND numero = $3`,
      [nombre, tipo, numero]
    );
    const estado = rowCount > 0 ? '✓' : '- (no scrapeada aún)';
    console.log(`   ${estado} ${nombre} (${tipo} ${numero})`);
  }

  // 3. Resumen
  console.log('\n3. Distribución final:');
  const { rows } = await pool.query(`
    SELECT rango_normativo, COUNT(*) as total
    FROM normas
    GROUP BY rango_normativo
    ORDER BY rango_normativo
  `);
  const labels = { 1:'constitución', 2:'código', 3:'ley/decreto_ley', 4:'decreto', 5:'resolución/disposición', 6:'ordenanza_general' };
  for (const row of rows) {
    console.log(`   rango ${row.rango_normativo} (${labels[row.rango_normativo] || '?'}): ${row.total} normas`);
  }

  console.log('\n✅ Listo.');
  console.log('\nNota: la Constitución Provincial (rango 1) se carga manualmente.');
  console.log('      Ver instrucciones en docs/constitucion.md cuando estés listo.');
}

main()
  .catch(e => { console.error('❌ ERROR:', e.message); process.exit(1); })
  .finally(() => pool.end());
