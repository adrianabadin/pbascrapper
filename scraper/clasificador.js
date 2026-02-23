/**
 * Clasificador diferido — asigna categorías temáticas a normas que no las tienen.
 * Diseñado para correr después del scraping masivo, con rate limiting conservador.
 *
 * Uso: node scraper/clasificador.js
 *
 * Variables de entorno:
 *   ZHIPU_API_KEY         — requerida
 *   ZHIPU_BASE_URL        — default https://open.bigmodel.cn/api/paas/v4
 *   CLASSIFY_DELAY_MS     — delay entre llamadas en ms (default 2000 = 30 RPM)
 *   CLASSIFY_BATCH_SIZE   — normas por ciclo de log (default 100)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const { Pool } = require('pg');

const ZHIPU_API_KEY   = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL  = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const DELAY_MS        = parseInt(process.env.CLASSIFY_DELAY_MS   || '2000');
const BATCH_SIZE      = parseInt(process.env.CLASSIFY_BATCH_SIZE || '100');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CATEGORIAS = [
  'urbanismo', 'medio_ambiente', 'salud', 'educacion', 'tributos',
  'seguridad', 'obras_publicas', 'empleo', 'municipal', 'civil',
  'administrativo', 'transporte', 'vivienda', 'agropecuario',
  'derechos_sociales', 'presupuesto',
];

const PROMPT_SISTEMA = `Sos un clasificador de normas legales de la Provincia de Buenos Aires.
Dado el resumen de una norma, respondé ÚNICAMENTE con 1 a 3 categorías de esta lista, separadas por coma, sin texto adicional:
${CATEGORIAS.join(', ')}`;

let shutdown = false;
process.on('SIGINT',  () => { console.log('\n⏹  SIGINT — terminando...'); shutdown = true; });
process.on('SIGTERM', () => { console.log('\n⏹  SIGTERM — terminando...'); shutdown = true; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

async function clasificar(resumen, intento = 1) {
  try {
    const res = await axios.post(
      `${ZHIPU_BASE_URL}/chat/completions`,
      {
        model: 'glm-4.7-flash',
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user',   content: resumen.slice(0, 1000) },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 30000 }
    );

    const respuesta = res.data.choices[0]?.message?.content?.trim() || '';
    const candidatas = respuesta.split(',').map(c => c.trim().toLowerCase().replace(/\s+/g, '_'));
    return candidatas.filter(c => CATEGORIAS.includes(c));
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.response?.data?.message || err.message;

    if (status === 429 && intento <= 5) {
      const wait = Math.min(5000 * intento, 30000);
      process.stdout.write(` [RL ${intento}/5, ${wait/1000}s]`);
      await delay(wait);
      return clasificar(resumen, intento + 1);
    }

    console.error(`\n  ❌ HTTP ${status || 'ERR'}: ${msg}`);
    return [];
  }
}

async function obtenerPendientes(limite) {
  const { rows } = await pool.query(`
    SELECT id, tipo, numero, anio, resumen
    FROM normas
    WHERE resumen IS NOT NULL
      AND resumen != ''
      AND (area_tematica IS NULL OR array_length(area_tematica, 1) IS NULL)
    ORDER BY anio DESC, tipo
    LIMIT $1
  `, [limite]);
  return rows;
}

async function main() {
  if (!ZHIPU_API_KEY) {
    console.error('❌ ZHIPU_API_KEY no configurada en .env');
    process.exit(1);
  }

  // Total pendientes
  const { rows: [{ total }] } = await pool.query(`
    SELECT COUNT(*) as total FROM normas
    WHERE resumen IS NOT NULL AND resumen != ''
      AND (area_tematica IS NULL OR array_length(area_tematica, 1) IS NULL)
  `);

  console.log('=== CLASIFICADOR DIFERIDO ===');
  console.log(`Modelo:    glm-4.7-flash`);
  console.log(`Delay:     ${DELAY_MS}ms entre llamadas (~${Math.round(60000/DELAY_MS)} RPM)`);
  console.log(`Pendientes: ${total} normas sin clasificar\n`);

  if (total === 0) {
    console.log('✅ Todas las normas ya están clasificadas.');
    await pool.end();
    return;
  }

  let procesados = 0;
  let clasificados = 0;
  let errores = 0;

  while (!shutdown) {
    const normas = await obtenerPendientes(BATCH_SIZE);
    if (normas.length === 0) {
      console.log('\n✅ No quedan normas sin clasificar.');
      break;
    }

    console.log(`[${ts()}] Procesando ${normas.length} normas...`);

    for (const norma of normas) {
      if (shutdown) break;

      process.stdout.write(`  ${norma.tipo} ${norma.numero}/${norma.anio}... `);

      const categorias = await clasificar(norma.resumen);

      if (categorias.length > 0) {
        await pool.query(
          'UPDATE normas SET area_tematica = $1 WHERE id = $2',
          [categorias, norma.id]
        );
        process.stdout.write(`[${categorias.join(', ')}]\n`);
        clasificados++;
      } else {
        process.stdout.write(`[sin categoría]\n`);
        errores++;
      }

      procesados++;

      // Log de progreso cada 50 normas
      if (procesados % 50 === 0) {
        const restantes = parseInt(total) - procesados;
        const tiempoRestante = Math.round((restantes * DELAY_MS) / 60000);
        console.log(`  → ${procesados}/${total} procesadas | ~${tiempoRestante} min restantes`);
      }

      await delay(DELAY_MS);
    }
  }

  console.log(`\n✅ Clasificador terminado.`);
  console.log(`   Procesadas:  ${procesados}`);
  console.log(`   Clasificadas: ${clasificados}`);
  console.log(`   Sin categoría: ${errores}`);
  await pool.end();
}

main().catch(async e => {
  console.error('\n❌ ERROR FATAL:', e.message);
  await pool.end();
  process.exit(1);
});
