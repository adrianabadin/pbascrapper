require('dotenv').config();
const { fetchListingPage, fetchDetalle, fetchTextoActualizado, delay, DELAY_MS } = require('./crawler');
const { parseListingPage, parseDetallePage, parseTextoActualizado } = require('./parser');
const { pool, upsertNormaBasica, upsertNormaDetalle, upsertTextoActualizado, upsertRelaciones, inferirIdentidad } = require('./db');

// Parsear argumentos CLI
const args = process.argv.slice(2);
const tiposArg = args.includes('--tipo')
  ? [args[args.indexOf('--tipo') + 1]]
  : ['ley', 'decreto'];
const desdeAnio = args.includes('--desde')
  ? parseInt(args[args.indexOf('--desde') + 1])
  : null;
const soloListing = args.includes('--solo-listing');
const maxPaginas = args.includes('--max-paginas')
  ? parseInt(args[args.indexOf('--max-paginas') + 1])
  : null;

async function procesarNorma(normaBasica) {
  try {
    // 1. Upsert básico (desde listing)
    const { id: normaId } = await upsertNormaBasica(normaBasica);

    if (soloListing) return;

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

  } catch (err) {
    console.error(`\n  ❌ Error en ${normaBasica.url_canonica}: ${err.message}`);
  }
}

async function scrapearTipo(tipo) {
  console.log(`\n🔍 Scrapeando ${tipo.toUpperCase()}...`);

  // Primera página para conocer el total
  const { html: html1, totalResultados, totalPaginas } = await fetchListingPage(tipo, 1);
  const paginaMaxima = maxPaginas ? Math.min(maxPaginas, totalPaginas) : totalPaginas;
  console.log(`   Total: ${totalResultados} normas, ${paginaMaxima} páginas a procesar`);

  // Procesar primera página
  const normas1 = parseListingPage(html1);
  for (const norma of normas1) {
    if (desdeAnio) {
      const { anio } = inferirIdentidad(norma.url_canonica);
      if (anio < desdeAnio) continue;
    }
    process.stdout.write(`  → ${norma.titulo}... `);
    await procesarNorma(norma);
    await delay(DELAY_MS);
  }

  // Procesar páginas restantes
  for (let pagina = 2; pagina <= paginaMaxima; pagina++) {
    console.log(`\n📄 Página ${pagina}/${paginaMaxima}...`);
    await delay(DELAY_MS);

    const { html } = await fetchListingPage(tipo, pagina);
    const normas = parseListingPage(html);

    for (const norma of normas) {
      if (desdeAnio) {
        const { anio } = inferirIdentidad(norma.url_canonica);
        if (anio < desdeAnio) continue;
      }
      process.stdout.write(`  → ${norma.titulo}... `);
      await procesarNorma(norma);
      await delay(DELAY_MS);
    }
  }

  console.log(`\n✅ ${tipo.toUpperCase()} completado`);
}

async function main() {
  console.log('🚀 Normas GBA Scraper');
  console.log(`   Tipos: ${tiposArg.join(', ')}`);
  if (desdeAnio) console.log(`   Desde año: ${desdeAnio}`);
  if (maxPaginas) console.log(`   Máx páginas: ${maxPaginas}`);
  if (soloListing) console.log(`   Modo: solo listing (sin detalle)`);

  for (const tipo of tiposArg) {
    await scrapearTipo(tipo);
  }

  await pool.end();
  console.log('\n🎉 Scraping completado');
}

main().catch(e => { console.error('FATAL:', e.message); pool.end(); process.exit(1); });
