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
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const GROQ_BASE_URL   = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const DELAY_MS        = parseInt(process.env.CLASSIFY_DELAY_MS   || '2000');
const BATCH_SIZE      = parseInt(process.env.CLASSIFY_BATCH_SIZE || '100');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const CATEGORIAS = [
  'urbanismo', 'medio_ambiente', 'salud', 'educacion', 'tributos',
  'seguridad', 'obras_publicas', 'empleo', 'municipal', 'civil',
  'administrativo', 'transporte', 'vivienda', 'agropecuario',
  'derechos_sociales', 'presupuesto',
  'SIN_CLASIFICAR',
];

// Sinónimos / variantes con acento que el modelo puede devolver → categoría canónica
const ALIAS = {
  'educacion':       'educacion',
  'educación':       'educacion',
  'administracion':  'administrativo',
  'administración':  'administrativo',
  'medio ambiente':  'medio_ambiente',
  'medioambiente':   'medio_ambiente',
  'obras publicas':  'obras_publicas',
  'derechos sociales': 'derechos_sociales',
  'seguridad publica': 'seguridad',
  'seguridad pública': 'seguridad',
  'tributacion':     'tributos',
  'tributación':     'tributos',
  'impuestos':       'tributos',
  'presupuesto':     'presupuesto',
  'vivienda':        'vivienda',
  'transporte':      'transporte',
  'agropecuario':    'agropecuario',
  'municipal':       'municipal',
  'civil':           'civil',
  'empleo':          'empleo',
  'salud':           'salud',
  'urbanismo':       'urbanismo',
};

// Quita acentos: educación → educacion
function sinAcentos(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function parsearCategorias(respuesta) {
  // Intentar split por coma o punto y coma o newline
  const partes = respuesta.split(/[,;\n]+/);
  const resultado = new Set();
  for (const parte of partes) {
    const limpio = sinAcentos(parte.trim().toLowerCase()).replace(/\s+/g, '_');
    const limpio_espacios = sinAcentos(parte.trim().toLowerCase()); // sin reemplazar espacios aún
    // 1. match directo
    if (CATEGORIAS.includes(limpio)) { resultado.add(limpio); continue; }
    // 2. via alias (con espacios, sin acentos)
    const alias = ALIAS[limpio_espacios] || ALIAS[limpio];
    if (alias) { resultado.add(alias); continue; }
    // 3. sin acentos + sin reemplazar espacios por _
    const sinAc = sinAcentos(limpio_espacios).replace(/\s+/g, '_');
    if (CATEGORIAS.includes(sinAc)) { resultado.add(sinAc); }
  }
  return [...resultado];
}

const PROMPT_SISTEMA = `
Eres un experto en clasificación de normativas argentinas de la Provincia de Buenos Aires.

# TAREA
Analiza el siguiente RESUMEN de una norma y clasifícala en una o más de estas 16 categorías temáticas canónicas:
${CATEGORIAS.join(', ')}

# REGLAS DE CLASIFICACIÓN

## 1. Selección de Categorías
- Selecciona 1 a 4 categorías que mejor describan el contenido del resumen
- Usa EXACTAMENTE estos nombres de categoría (sin acentos, sin variaciones)
- Prioriza la clasificación precisa sobre la cantidad de categorías
- Categorías con significados similares pero diferentes (ej: "educación" vs "enseñanza") son distintas

## 2. Formato de Salida
- Devuelve SOLAMENTE las categorías seleccionadas
- Separadas por comas seguidas de espacio
- Sin texto adicional, sin explicaciones, sin prefacios
- Sin formato JSON, sin números, sin viñetas

Ejemplos:
✅ Correcto: administrativo, tributos
❌ Incorrecto: Las categorías son: administrativo y tributos
❌ Incorrecto: "administrativo", "tributos"
❌ Incorrecto: 1. administrativo, 2. tributos
❌ Incorrecto: Categoría: administrativo
❌ Incorrecto: Son normativas de tipo: administrativo

## 3. Manejo de Casos Difíciles
### Si el resumen es muy corto (< 50 caracteres):
- Intenta inferir del tipo de norma (ley, decreto, resolución, etc.)
- Si no hay contexto claro, responde con la categoría más probable basada en palabras clave
- Ejemplo: "modifica el reglamento..." → municipal

### Si el resumen contiene frases indicativas de "sin clasificar":
- DETÉCTALAS ANTES de procesar
- Las siguientes variantes significan que la clasificación anterior falló:
  "sin clasificar", "sin_clasificar", "{sin_clasificar}", "sin categoría"
- Si se detecta alguna de estas, ASIGNA "SIN_CLASIFICAR" (no otra categoría)
- Estas normas deben ser RECLASIFICADAS, no clasificadas con una nueva categoría

### Si el resumen es genérico o ambiguo:
- Selecciona hasta 2 categorías que capturen diferentes aspectos
- Sé lo más específico posible con la información disponible
- Usa "administrativo" como categoría predeterminada si no hay suficiente información

# RESUMEN A CLASIFICAR
${resumen.slice(0, 800)}

# TU RESPUESTA (solo categorías)
`;

let shutdown = false;
process.on('SIGINT',  () => { console.log('\n⏹  SIGINT — terminando...'); shutdown = true; });
process.on('SIGTERM', () => { console.log('\n⏹  SIGTERM — terminando...'); shutdown = true; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ts() {
  return new Date().toTimeString().slice(0, 8);
}

async function clasificarConZhipu(resumen, intento = 1) {
  try {
    const res = await axios.post(
      `${ZHIPU_BASE_URL}/chat/completions`,
      {
        model: 'glm-4-flash',
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user',   content: resumen.slice(0, 800) },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 30000 }
    );

    const respuesta = res.data.choices[0]?.message?.content?.trim() || '';
    const cats = parsearCategorias(respuesta);
    if (cats.length === 0) {
      process.stdout.write(` [raw:"${respuesta.slice(0, 80)}"]`);
      throw new Error('No se obtuvieron categorías válidas de la respuesta');
    }
    return { categorias: cats, proveedor: 'zhipu' };
  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.error?.message || err.response?.data?.message || err.message;

    if (status === 429 && intento <= 5) {
      const wait = Math.min(5000 * intento, 30000);
      process.stdout.write(` [RL ${intento}/5, ${wait/1000}s]`);
      await delay(wait);
      return clasificarConZhipu(resumen, intento + 1);
    }

    throw err;
  }
}

async function clasificarConGroq(resumen, intento = 1) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY no configurada');

  try {
    const res = await axios.post(
      `${GROQ_BASE_URL}/chat/completions`,
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user',   content: resumen.slice(0, 800) },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      { headers: { Authorization: `Bearer ${GROQ_API_KEY}` }, timeout: 30000 }
    );

    const respuesta = res.data.choices[0]?.message?.content?.trim() || '';
    const cats = parsearCategorias(respuesta);
    if (cats.length === 0) {
      process.stdout.write(` [raw:"${respuesta.slice(0, 80)}"]`);
      throw new Error('No se obtuvieron categorías válidas de la respuesta');
    }
    return { categorias: cats, proveedor: 'groq' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && intento <= 3) {
      const wait = Math.min(5000 * intento, 20000);
      await delay(wait);
      return clasificarConGroq(resumen, intento + 1);
    }
    throw err;
  }
}

async function clasificarConOpenAI(resumen, intento = 1) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');

  try {
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: PROMPT_SISTEMA },
          { role: 'user',   content: resumen.slice(0, 800) },
        ],
        temperature: 0,
        max_tokens: 50,
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }, timeout: 30000 }
    );

    const respuesta = res.data.choices[0]?.message?.content?.trim() || '';
    const cats = parsearCategorias(respuesta);
    if (cats.length === 0) {
      process.stdout.write(` [raw:"${respuesta.slice(0, 80)}"]`);
      throw new Error('No se obtuvieron categorías válidas de la respuesta');
    }
    return { categorias: cats, proveedor: 'openai' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 429 && intento <= 3) {
      const wait = Math.min(5000 * intento, 20000);
      await delay(wait);
      return clasificarConOpenAI(resumen, intento + 1);
    }
    throw err;
  }
}

async function clasificarConFallback(resumen) {
  try {
    return await clasificarConZhipu(resumen);
  } catch (err) {
    console.log(`    [zhipu] ❌ Falló: ${err.message}`);
  }

  try {
    return await clasificarConGroq(resumen);
  } catch (err) {
    console.log(`    [groq] ❌ Falló: ${err.message}`);
  }

  try {
    return await clasificarConOpenAI(resumen);
  } catch (err) {
    console.log(`    [openai] ❌ Falló: ${err.message}`);
  }

  return { categorias: ['NO_CLASIFICADO'], proveedor: 'reclasificación' };
}

async function obtenerPendientes(limite) {
  const { rows } = await pool.query(`
    SELECT id, tipo, numero, anio, resumen
    FROM normas
    WHERE resumen IS NOT NULL
      AND resumen != ''
      AND (area_tematica IS NULL OR array_length(area_tematica, 1) IS NULL)
      AND (area_tematica IS NULL OR EXISTS (
        SELECT 1 FROM unnest(area_tematica) elem 
        WHERE lower(elem) IN ('sin clasificar', 'sin_clasificar', '{sin_clasificar}')
      ))
    ORDER BY anio DESC, tipo
    LIMIT $1
  `, [limite]);
  return rows;
}

async function main() {
  if (!ZHIPU_API_KEY && !GROQ_API_KEY && !OPENAI_API_KEY) {
    console.error('❌ Se requiere al menos una API key configurada en .env (ZHIPU_API_KEY, GROQ_API_KEY u OPENAI_API_KEY)');
    process.exit(1);
  }

  // Total pendientes
  const { rows: [{ total }] } = await pool.query(`
    SELECT COUNT(*) as total FROM normas
    WHERE resumen IS NOT NULL AND resumen != ''
      AND (area_tematica IS NULL OR array_length(area_tematica, 1) IS NULL)
  `);

  console.log('=== CLASIFICADOR DIFERIDO ===');
  console.log(`Zhipu:    ${ZHIPU_API_KEY ? '✓' : '✗'} (glm-4-flash)`);
  console.log(`Groq:      ${GROQ_API_KEY ? '✓' : '✗'} (llama-3.3-70b-versatile)`);
  console.log(`OpenAI:    ${OPENAI_API_KEY ? '✓' : '✗'} (gpt-4o)`);
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

      const { categorias, proveedor } = await clasificarConFallback(norma.resumen);

      if (categorias.length > 0) {
        await pool.query(
          'UPDATE normas SET area_tematica = $1 WHERE id = $2',
          [categorias, norma.id]
        );
        process.stdout.write(`[${categorias.join(', ')}] (${proveedor})\n`);
        clasificados++;
        } else {
          process.stdout.write(`[NO_CLASIFICADO] (reclasificación)\n`);
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
