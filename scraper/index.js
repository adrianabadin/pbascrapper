require('dotenv').config();
const { fetchListingPage, fetchDetalle, fetchTextoActualizado, fetchPdf, delay, DELAY_MS } = require('./crawler');
const { parseListingPage, parseDetallePage, parseTextoActualizado, parseTextoFromPdf } = require('./parser');
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
const MAX_ERRORES_CONSECUTIVOS = 25; // solo errores de red, no HTTP del sitio

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

    // 3. Scrape texto actualizado, con fallback a PDF
    let articulos = [];
    let textoParaHash = null;
    let fuente = null;

    if (detalle.url_texto_actualizado) {
      await delay(DELAY_MS);
      textoParaHash = await fetchTextoActualizado(detalle.url_texto_actualizado);
      articulos = parseTextoActualizado(textoParaHash);
      if (articulos.length > 0) fuente = 'html';
    }

    // Fallback a PDF si HTML no dio artículos
    if (articulos.length === 0 && detalle.url_texto_original) {
      try {
        await delay(DELAY_MS);
        const pdfBuf = await fetchPdf(detalle.url_texto_original);
        articulos = await parseTextoFromPdf(pdfBuf);
        if (articulos.length > 0) {
          textoParaHash = articulos.map(a => `${a.numero_articulo}. ${a.texto}`).join('\n\n');
          fuente = 'pdf';
        }
      } catch (err) {
        console.warn(`  ⚠ PDF fallback: ${err.response?.status || err.message}`);
      }
    }

    if (fuente) {
      const cambio = await upsertTextoActualizado(normaId, textoParaHash, articulos);
      console.log(cambio ? `📝 ${articulos.length} artículos (${fuente})` : `✓ sin cambios`);
    } else {
      console.log(`- sin texto`);
    }

    // 4. Relaciones normativas
    if (detalle.relaciones.length > 0) {
      await upsertRelaciones(normaId, detalle.relaciones);
    }

    erroresConsecutivos = 0;
  } catch (err) {
    const status = err.response?.status;
    console.error(`\n  ❌ Error en ${normaBasica.url_canonica}: ${err.message}`);

    // Errores HTTP del sitio (4xx/5xx): la norma está rota/no disponible en el servidor.
    // No cuentan como error sistémico — el sitio sigue funcionando, solo esa norma falla.
    if (status) return;

    // Errores de red (timeout, ECONNREFUSED, etc.): pueden indicar problema sistémico.
    erroresConsecutivos++;
    if (erroresConsecutivos >= MAX_ERRORES_CONSECUTIVOS) {
      throw new Error(`Abortando: ${MAX_ERRORES_CONSECUTIVOS} errores de red consecutivos. Último: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scraping mes a mes
// ---------------------------------------------------------------------------

/**
 * Semanas fijas del mes: 4 rangos de días que cubren el mes completo.
 * Si el mes supera 200 normas, scrapearMes delega en estas semanas.
 */
function semanasDelMes(anio, mes) {
  const ultimo = ultimoDia(anio, mes);
  return [
    { desde: fmt(1,  mes, anio), hasta: fmt(7,           mes, anio) },
    { desde: fmt(8,  mes, anio), hasta: fmt(14,          mes, anio) },
    { desde: fmt(15, mes, anio), hasta: fmt(21,          mes, anio) },
    { desde: fmt(22, mes, anio), hasta: fmt(ultimo,      mes, anio) },
  ];
}

async function scrapearRango(tipo, fechaDesde, fechaHasta, label) {
  const { html: html1, totalResultados, totalPaginas } =
    await fetchListingPage(tipo, 1, { fechaDesde, fechaHasta });

  if (totalResultados === 0) return 0;

  const paginaMaxima = Math.min(maxPaginas || 20, 20, totalPaginas);

  process.stdout.write(`  📅 ${label}: ${totalResultados} normas`);
  if (totalResultados > 200) {
    process.stdout.write(` ⚠ > 200 (recuperables: ${paginaMaxima * 10})`);
  }
  console.log(` — ${paginaMaxima} pág${paginaMaxima > 1 ? 's' : ''}`);

  async function procesarPagina(normas) {
    for (const norma of normas) {
      process.stdout.write(`    → ${norma.titulo?.slice(0, 60)}... `);
      await procesarNorma(norma);
      await delay(DELAY_MS);
    }
  }

  await procesarPagina(parseListingPage(html1));
  for (let pagina = 2; pagina <= paginaMaxima; pagina++) {
    await delay(DELAY_MS);
    const { html } = await fetchListingPage(tipo, pagina, { fechaDesde, fechaHasta });
    await procesarPagina(parseListingPage(html));
  }

  return totalResultados;
}

async function scrapearMes(tipo, anio, mes) {
  const fechaDesde = fmt(1, mes, anio);
  const fechaHasta = fmt(ultimoDia(anio, mes), mes, anio);
  const label = `${anio}-${String(mes).padStart(2, '0')}`;

  // Verificar total sin traer resultados (solo página 1)
  const { totalResultados } = await fetchListingPage(tipo, 1, { fechaDesde, fechaHasta });
  if (totalResultados === 0) return;

  if (totalResultados <= 200) {
    // Mes normal: scrape directo
    await scrapearRango(tipo, fechaDesde, fechaHasta, label);
  } else {
    // Fallback semanal: dividir el mes en 4 semanas
    console.log(`  📅 ${label}: ${totalResultados} normas → fallback semanal`);
    const semanas = semanasDelMes(anio, mes);
    for (let i = 0; i < semanas.length; i++) {
      const { desde, hasta } = semanas[i];
      await delay(DELAY_MS);
      await scrapearRango(tipo, desde, hasta, `  ${label} sem${i + 1} (${desde}→${hasta})`);
    }
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
