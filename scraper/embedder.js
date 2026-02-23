/**
 * Embedder — consume la cola_embeddings, genera vectores con Zhipu embedding-3
 * y clasifica cada norma en categorías temáticas con glm-4-flash.
 *
 * Uso: node scraper/embedder.js
 *
 * Variables de entorno:
 *   ZHIPU_API_KEY        — requerida
 *   ZHIPU_BASE_URL       — default https://open.bigmodel.cn/api/paas/v4
 *   EMBED_BATCH_SIZE     — items por ciclo (default 50)
 *   EMBED_DELAY_MS       — delay entre batches en ms (default 200)
 *   EMBED_POLL_INTERVAL  — ms a esperar con cola vacía (default 30000)
 *   MAX_ITEMS_API        — máx. items por request a Zhipu embeddings (default 16, hard limit 64)
 *   MAX_TEXTO_CHARS      — máx. caracteres por texto antes de truncar (default 3000 ≈ 750 tokens)
 *   CLASIFICAR           — '0' para deshabilitar clasificación (default habilitada)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const axios = require('axios');
const { pool, obtenerBatchEmbeddings, guardarEmbedding, guardarCategorias, marcarError } = require('./db');

const ZHIPU_API_KEY      = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL     = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const BATCH_SIZE         = parseInt(process.env.EMBED_BATCH_SIZE    || '50');
const DELAY_MS           = parseInt(process.env.EMBED_DELAY_MS      || '200');
const POLL_INTERVAL      = parseInt(process.env.EMBED_POLL_INTERVAL || '30000');
const MAX_TOKENS_PER_REQ = parseInt(process.env.MAX_TOKENS_PER_REQ  || '10000');
const CLASIFICAR         = process.env.CLASIFICAR !== '0';
const MAX_TEXTO_CHARS    = parseInt(process.env.MAX_TEXTO_CHARS || '3000'); // ~750 tokens
const MAX_ITEMS_API      = parseInt(process.env.MAX_ITEMS_API   || '16');   // hard cap por request
const MAX_FALLOS         = 5;

// Taxonomía de categorías para legislación bonaerense
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
let batchCount = 0;
let totalProcesados = 0;
let totalTokens = 0;
let totalClasificados = 0;

// SIGINT/SIGTERM: terminar después del batch actual completo (no en medio)
process.on('SIGINT',  () => { console.log('\n⏹  SIGINT — terminando batch actual...'); shutdown = true; });
process.on('SIGTERM', () => { console.log('\n⏹  SIGTERM — terminando batch actual...'); shutdown = true; });

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extrae y trunca el texto a embeddear según el tipo de entidad.
 * Zhipu limita el tamaño total del request — truncamos a MAX_TEXTO_CHARS.
 */
function extraerTexto(row) {
  let texto = null;
  if (row.entidad_tipo === 'norma')    texto = row.resumen;
  if (row.entidad_tipo === 'articulo') texto = row.articulo_texto;
  if (texto && texto.length > MAX_TEXTO_CHARS) texto = texto.slice(0, MAX_TEXTO_CHARS);
  return texto;
}

/**
 * POST a /embeddings con retry en rate limit y error de red.
 */
async function llamarAPIEmbeddings(textos, intento = 1) {
  try {
    const res = await axios.post(
      `${ZHIPU_BASE_URL}/embeddings`,
      { model: 'embedding-3', input: textos },
      { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 60000 }
    );
    return res.data;
  } catch (err) {
    const status = err.response?.status;

    if (status === 429 && intento <= 3) {
      const wait = Math.min(1000 * Math.pow(2, intento) + Math.random() * 500, 30000);
      console.log(`  ⚠️  Rate limit (429). Reintento ${intento}/3 en ${Math.round(wait / 1000)}s...`);
      await delay(wait);
      return llamarAPIEmbeddings(textos, intento + 1);
    }

    if (!status && intento <= 2) {
      console.log(`  ⚠️  Error de red. Reintento ${intento}/2...`);
      await delay(2000);
      return llamarAPIEmbeddings(textos, intento + 1);
    }

    throw err;
  }
}

/**
 * Clasifica una norma en categorías usando glm-4-flash.
 * Retorna array de strings o [] si falla.
 */
async function clasificarNorma(resumen) {
  if (!resumen || !resumen.trim()) return [];

  try {
    const res = await axios.post(
      `${ZHIPU_BASE_URL}/chat/completions`,
      {
        model: 'glm-4-flash',
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user',   content: resumen.slice(0, 1000) }, // límite de contexto
        ],
        temperature: 0,
        max_tokens: 50,
      },
      { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 30000 }
    );

    const respuesta = res.data.choices[0]?.message?.content?.trim() || '';

    // Parsear y validar que las categorías sean del vocabulario controlado
    const candidatas = respuesta.split(',').map(c => c.trim().toLowerCase().replace(/\s+/g, '_'));
    const validas = candidatas.filter(c => CATEGORIAS.includes(c));

    return validas.length > 0 ? validas : [];
  } catch (err) {
    // La clasificación es no-crítica: loguear y continuar
    const msg = err.response?.data?.error?.message || err.message;
    console.log(`    ⚠️  Clasificación fallida: ${msg}`);
    return [];
  }
}

/**
 * Marca un item como error sin propagar excepciones de DB.
 */
async function marcarErrorSafe(colaId, mensaje) {
  try {
    await marcarError(colaId, mensaje);
  } catch (dbErr) {
    console.error(`  ⚠️  No se pudo marcar error en DB (id=${colaId}): ${dbErr.message}`);
  }
}

/**
 * Procesa un sub-batch: genera embeddings y clasifica normas.
 */
async function procesarSubBatch(items) {
  const textos = items.map(extraerTexto);

  let apiData;
  try {
    apiData = await llamarAPIEmbeddings(textos);
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.log(`  ❌ Error API embeddings: ${msg}`);
    for (const item of items) {
      await marcarErrorSafe(item.id, `API error: ${msg}`);
    }
    return { guardados: 0, errores: items.length, tokens: 0, clasificados: 0 };
  }

  let guardados = 0;
  let errores = 0;
  let clasificados = 0;
  const tokens = apiData.usage?.total_tokens || 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const vector = apiData.data[i]?.embedding;

    if (!vector) {
      await marcarErrorSafe(item.id, 'No se recibió embedding para este item');
      errores++;
      continue;
    }

    try {
      await guardarEmbedding(item.id, item.entidad_tipo, item.entidad_id, item.campo_embedding, vector);
      guardados++;

      // Clasificar solo normas, y solo si la clasificación está habilitada
      if (CLASIFICAR && item.entidad_tipo === 'norma' && item.campo_embedding === 'embedding_resumen') {
        const categorias = await clasificarNorma(extraerTexto(item));
        if (categorias.length > 0) {
          await guardarCategorias(item.entidad_id, categorias);
          clasificados++;
        }
      }
    } catch (err) {
      await marcarErrorSafe(item.id, `DB error: ${err.message}`);
      errores++;
    }
  }

  return { guardados, errores, tokens, clasificados };
}

async function main() {
  if (!ZHIPU_API_KEY) {
    console.error('❌ ZHIPU_API_KEY no configurada en .env');
    await pool.end();
    process.exit(1);
  }

  console.log('=== EMBEDDER NORMAS GBA ===');
  console.log(`Config: batch=${BATCH_SIZE}, delay=${DELAY_MS}ms, poll=${POLL_INTERVAL / 1000}s`);
  console.log(`Clasificación temática: ${CLASIFICAR ? 'habilitada (glm-4-flash)' : 'deshabilitada'}\n`);

  let fallosConsecutivos = 0;

  // shutdown se chequea solo al tope del loop — el batch actual siempre se completa entero
  while (!shutdown) {
    const rows = await obtenerBatchEmbeddings(BATCH_SIZE);

    if (rows.length === 0) {
      console.log(`[${ts()}] Cola vacía. Esperando ${POLL_INTERVAL / 1000}s...`);
      await delay(POLL_INTERVAL);
      continue;
    }

    batchCount++;
    console.log(`\n[${ts()}] Batch #${batchCount}: ${rows.length} items`);

    // --- Separar válidos e inválidos ---
    const validos  = [];
    const sinTexto = [];
    for (const row of rows) {
      const texto = extraerTexto(row);
      if (!texto || !texto.trim()) sinTexto.push(row);
      else validos.push(row);
    }

    if (sinTexto.length > 0) {
      console.log(`  ⚠️  ${sinTexto.length} sin texto → marcando error`);
      for (const item of sinTexto) {
        await marcarErrorSafe(item.id, 'Texto vacío o nulo');
      }
    }

    if (validos.length === 0) {
      fallosConsecutivos++;
      if (fallosConsecutivos >= MAX_FALLOS) {
        console.error(`❌ FATAL: ${MAX_FALLOS} batches consecutivos sin items válidos. Abortando.`);
        break;
      }
      continue;
    }

    // --- Info de composición ---
    const nNormas = validos.filter(r => r.entidad_tipo === 'norma').length;
    const nArts   = validos.filter(r => r.entidad_tipo === 'articulo').length;
    if (nNormas > 0) console.log(`  → Normas (embedding + clasificación): ${nNormas}`);
    if (nArts   > 0) console.log(`  → Artículos (embedding):              ${nArts}`);

    // --- Dividir en sub-batches respetando el hard cap de la API (MAX_ITEMS_API) ---
    const subBatches = [];
    for (let i = 0; i < validos.length; i += MAX_ITEMS_API) {
      subBatches.push(validos.slice(i, i + MAX_ITEMS_API));
    }

    // --- Procesar todos los sub-batches (shutdown se chequea al volver al tope) ---
    let bGuardados    = 0;
    let bErrores      = 0;
    let bTokens       = 0;
    let bClasificados = 0;
    const t0 = Date.now();

    for (const sub of subBatches) {
      const { guardados, errores, tokens, clasificados } = await procesarSubBatch(sub);
      bGuardados    += guardados;
      bErrores      += errores;
      bTokens       += tokens;
      bClasificados += clasificados;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  → Embeddings: ${bGuardados}/${validos.length} guardados, ${bErrores} errores, ${bTokens} tokens, ${elapsed}s`);
    if (CLASIFICAR && nNormas > 0) {
      console.log(`  → Clasificados: ${bClasificados}/${nNormas} normas`);
    }

    totalProcesados   += bGuardados;
    totalTokens       += bTokens;
    totalClasificados += bClasificados;
    console.log(`  Acumulado: ${totalProcesados} embeddings, ${totalClasificados} clasificaciones, ${totalTokens} tokens`);

    if (bGuardados > 0) {
      fallosConsecutivos = 0;
    } else {
      fallosConsecutivos++;
      if (fallosConsecutivos >= MAX_FALLOS) {
        console.error(`❌ FATAL: ${MAX_FALLOS} batches consecutivos fallidos. Abortando.`);
        break;
      }
    }

    if (!shutdown) await delay(DELAY_MS);
  }

  console.log(`\n✅ Embedder terminado.`);
  console.log(`   Embeddings:      ${totalProcesados}`);
  console.log(`   Clasificaciones: ${totalClasificados}`);
  console.log(`   Tokens usados:   ${totalTokens}`);
  await pool.end();
}

main().catch(async e => {
  console.error('\n❌ ERROR FATAL:', e.message);
  await pool.end();
  process.exit(1);
});
