require('dotenv').config();
const { fetchListingPage, fetchDetalle, fetchTextoActualizado, delay, DELAY_MS } = require('./crawler');
const { parseListingPage, parseDetallePage, parseTextoActualizado } = require('./parser');
const { pool, upsertNormaBasica, upsertNormaDetalle, upsertTextoActualizado, upsertRelaciones, inferirIdentidad } = require('./db');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function argVal(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const TODOS_LOS_TIPOS = ['ley', 'decreto', 'decreto_ley', 'ordenanza_general', 'resolucion', 'disposicion', 'resolucion_conjunta'];

const tiposArg    = argVal('--tipo') ? [argVal('--tipo')] : TODOS_LOS_TIPOS;
const soloListing = args.includes('--solo-listing');
const maxPaginas  = argVal('--max-paginas') ? parseInt(argVal('--max-paginas')) : null;

// --desde-fecha YYYY-MM  (inicio del rango a scrapear)
// --hasta-fecha YYYY-MM  (fin del rango, default: mes actual)
const desdeFecha = argVal('--desde-fecha') || '2000-01';
const hastaFecha = (() => {
  const v = argVal('--hasta-fecha');
  if (v) return v;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
})();

// ---------------------------------------------------------------------------
// Helpers de fecha
// ---------------------------------------------------------------------------

/** Último día del mes (ej. ultimoDia(2024, 2) → 29) */
function ultimoDia(anio, mes) {
  return new Date(anio, mes, 0).getDate();
}

/** Formatea como DD/MM/YYYY */
function fmt(dia, mes, anio) {
  return `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${anio}`;
}

/** Parsea 'YYYY-MM' → { anio, mes } */
function parsearFecha(str) {
  const [anio, mes] = str.split('-').map(Number);
  return { anio, mes };
}

// ---------------------------------------------------------------------------
// Procesamiento de normas individuales
// ---------------------------------------------------------------------------

let erroresConsecutivos = 0;
const MAX_ERRORES_CONSECUTIVOS = 10;

async function procesarNorma(normaBasica) {
  try {
    // 1. Upsert básico (desde listing)
    const { id: normaId } = await upsertNormaBasica(normaBasica);

    if (soloListing) {
      erroresConsecutivos = 0;
      return;
    }

    // 2. Scrape página de detalle
    await delay(DELAY_MS);
    const detalleHtml = await fetchDetalle(normaBasica.url_canonica);
    const detalle = parseDetallePage(detalleHtml, normaBasica.url_canonica);
    const { sitio_id } = inferirIdentidad(normaBasica.url_canonica);
    await upsertNormaDetalle(sitio_id, detalle);

    // 3. Scrape texto actualizado (si existe)
    if (detalle.url_texto_actualizado) {
      await delay(DELAY_MS);
      const textoHtml = await fetchTextoActualizado(detalle.url_texto_actualizado);
      const articulos = parseTextoActualizado(textoHtml);
      const cambio = await upsertTextoActualizado(normaId, textoHtml, articulos);
      if (cambio) {
        console.log(`📝 ${articulos.length} artículos`);
      } else {
        console.log(`✓ sin cambios`);
      }
    } else {
      console.log(`- sin texto`);
    }

    // 4. Relaciones normativas
    if (detalle.relaciones.length > 0) {
      await upsertRelaciones(normaId, detalle.relaciones);
    }

    erroresConsecutivos = 0;
  } catch (err) {
    erroresConsecutivos++;
    console.error(`\n  ❌ Error en ${normaBasica.url_canonica}: ${err.message}`);
    if (erroresConsecutivos >= MAX_ERRORES_CONSECUTIVOS) {
      throw new Error(`Abortando: ${MAX_ERRORES_CONSECUTIVOS} errores consecutivos. Último: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scraping mes a mes
// ---------------------------------------------------------------------------

async function scrapearMes(tipo, anio, mes) {
  const fechaDesde = fmt(1, mes, anio);
  const fechaHasta = fmt(ultimoDia(anio, mes), mes, anio);
  const label = `${anio}-${String(mes).padStart(2, '0')}`;

  const { html: html1, totalResultados, totalPaginas } =
    await fetchListingPage(tipo, 1, { fechaDesde, fechaHasta });

  if (totalResultados === 0) return; // mes vacío, skip silencioso

  const paginaMaxima = Math.min(maxPaginas || 20, 20, totalPaginas);

  process.stdout.write(`  📅 ${label}: ${totalResultados} normas`);
  if (totalResultados > 200) {
    process.stdout.write(` ⚠ > 200 (solo recuperables ${paginaMaxima * 10})`);
  }
  console.log(` — ${paginaMaxima} pág${paginaMaxima > 1 ? 's' : ''}`);

  async function procesarPagina(normas) {
    for (const norma of normas) {
      process.stdout.write(`    → ${norma.titulo?.slice(0, 60)}... `);
      await procesarNorma(norma);
      await delay(DELAY_MS);
    }
  }

  // Página 1 (HTML ya disponible)
  await procesarPagina(parseListingPage(html1));

  // Páginas 2..N
  for (let pagina = 2; pagina <= paginaMaxima; pagina++) {
    await delay(DELAY_MS);
    const { html } = await fetchListingPage(tipo, pagina, { fechaDesde, fechaHasta });
    await procesarPagina(parseListingPage(html));
  }
}

async function scrapearTipo(tipo) {
  const { anio: desdeAnio, mes: desdeMes } = parsearFecha(desdeFecha);
  const { anio: hastaAnio, mes: hastaMes } = parsearFecha(hastaFecha);

  console.log(`\n🔍 ${tipo.toUpperCase()} — ${desdeFecha} → ${hastaFecha}`);

  let totalNormasTipo = 0;

  for (let anio = desdeAnio; anio <= hastaAnio; anio++) {
    const mesInicio = (anio === desdeAnio) ? desdeMes : 1;
    const mesFin    = (anio === hastaAnio) ? hastaMes  : 12;

    for (let mes = mesInicio; mes <= mesFin; mes++) {
      await scrapearMes(tipo, anio, mes);
      totalNormasTipo++;
    }
  }

  console.log(`✅ ${tipo.toUpperCase()} completado`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 Normas GBA Scraper — modo mes a mes');
  console.log(`   Tipos:         ${tiposArg.join(', ')}`);
  console.log(`   Rango:         ${desdeFecha} → ${hastaFecha}`);
  if (maxPaginas) console.log(`   Máx pág/mes:   ${maxPaginas}`);
  if (soloListing) console.log(`   Modo:          solo listing (sin detalle)`);
  console.log('');

  for (const tipo of tiposArg) {
    await scrapearTipo(tipo);
  }

  await pool.end();
  console.log('\n🎉 Scraping completado');
}

main().catch(async (e) => {
  console.error('FATAL:', e.message);
  await pool.end();
  process.exit(1);
});
