/**
 * Prueba integrada en vivo: fetch real → parse → DB
 * Uso: node test-live.js
 */
require('dotenv').config();
const axios = require('axios');
const { parseListingPage, parseDetallePage, parseTextoActualizado } = require('./scraper/parser');
const { pool, upsertNormaBasica, upsertNormaDetalle, upsertTextoActualizado, inferirIdentidad } = require('./scraper/db');

const BASE_URL = 'https://normas.gba.gob.ar';

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; normas-gba-scraper/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
    },
  });
  return res.data;
}

async function main() {
  console.log('=== PRUEBA INTEGRADA EN VIVO ===\n');

  // 1. LISTING: primeras leyes (URL real del buscador)
  const listingUrl = `${BASE_URL}/resultados?q[terms][raw_type]=Law&q[sort]=by_publication_date_desc`;
  console.log(`📥 Fetching listing: ${listingUrl}`);
  const listingHtml = await fetchHtml(listingUrl);
  const normas = parseListingPage(listingHtml);
  console.log(`✅ Parseadas ${normas.length} normas del listing\n`);
  normas.slice(0, 3).forEach((n, i) => {
    console.log(`  [${i+1}] ${n.titulo}`);
    console.log(`       URL: ${n.url_canonica}`);
    console.log(`       Resumen: ${(n.resumen || '').slice(0, 80)}...`);
    console.log(`       Publicación: ${n.fecha_publicacion}`);
  });

  if (normas.length === 0) {
    console.log('❌ No se encontraron normas en el listing. Verificar selectores.');
    return;
  }

  // 2. Tomar la primera norma
  const primera = normas[0];
  console.log(`\n📋 Procesando: ${primera.titulo}`);

  // 3. UPSERT básico desde listing
  const rowBasica = await upsertNormaBasica(primera);
  console.log(`✅ upsertNormaBasica → id=${rowBasica.id}, estado=${rowBasica.estado}`);

  // 4. DETALLE
  const detalleUrl = `${BASE_URL}${primera.url_canonica}`;
  console.log(`\n📥 Fetching detalle: ${detalleUrl}`);
  const detalleHtml = await fetchHtml(detalleUrl);
  const detalle = parseDetallePage(detalleHtml, primera.url_canonica);

  console.log('\n📊 Datos del detalle:');
  console.log(`  Promulgación:      ${detalle.fecha_promulgacion}`);
  console.log(`  Boletín Oficial:   ${detalle.boletin_oficial_nro}`);
  console.log(`  Tipo publicación:  ${detalle.tipo_publicacion}`);
  console.log(`  URL texto orig:    ${detalle.url_texto_original}`);
  console.log(`  URL texto actual.: ${detalle.url_texto_actualizado}`);
  console.log(`  URL fundamentos:   ${detalle.url_fundamentos}`);
  console.log(`  Resumen:           ${(detalle.resumen || '').slice(0, 100)}`);
  console.log(`  Relaciones:        ${detalle.relaciones.length} encontradas`);

  const { sitio_id } = inferirIdentidad(primera.url_canonica);
  const normaId = await upsertNormaDetalle(sitio_id, detalle);
  console.log(`\n✅ upsertNormaDetalle → normaId=${normaId}`);

  // 5. TEXTO ACTUALIZADO (si existe)
  if (detalle.url_texto_actualizado) {
    const textoUrl = `${BASE_URL}${detalle.url_texto_actualizado}`;
    console.log(`\n📥 Fetching texto actualizado: ${textoUrl}`);
    try {
      const textoHtml = await fetchHtml(textoUrl);
      const articulos = parseTextoActualizado(textoHtml);
      console.log(`✅ Parseados ${articulos.length} artículos`);

      if (articulos.length > 0) {
        console.log('\n  Primeros 3 artículos:');
        articulos.slice(0, 3).forEach((a, i) => {
          console.log(`  [${i}] ${a.numero_articulo} (orden ${a.orden})`);
          console.log(`      ${a.texto.slice(0, 100).replace(/\n/g, ' ')}...`);
        });

        const huboCambio = await upsertTextoActualizado(normaId, textoHtml, articulos);
        console.log(`\n✅ upsertTextoActualizado → cambio=${huboCambio}`);
      }
    } catch (e) {
      console.log(`⚠️  No se pudo obtener texto actualizado: ${e.message}`);
    }
  } else {
    console.log('\n⚠️  Sin URL de texto actualizado en este detalle.');
  }

  // 6. Verificar en DB
  console.log('\n📊 Verificación en PostgreSQL:');
  const { rows: dbRows } = await pool.query(`
    SELECT tipo, numero, anio, sitio_id, estado, url_texto_actualizado,
           boletin_oficial_nro, fecha_promulgacion
    FROM normas WHERE id = $1
  `, [normaId]);

  if (dbRows.length > 0) {
    const r = dbRows[0];
    console.log(`  tipo:              ${r.tipo}`);
    console.log(`  numero:            ${r.numero}`);
    console.log(`  anio:              ${r.anio}`);
    console.log(`  sitio_id:          ${r.sitio_id}`);
    console.log(`  estado:            ${r.estado}`);
    console.log(`  boletin_oficial:   ${r.boletin_oficial_nro}`);
    console.log(`  fecha_promulgacion:${r.fecha_promulgacion}`);
    console.log(`  url_texto_actual.: ${r.url_texto_actualizado}`);
  }

  const { rows: artCount } = await pool.query(
    'SELECT COUNT(*) as cnt FROM articulos WHERE norma_id = $1', [normaId]
  );
  console.log(`  artículos en DB:   ${artCount[0].cnt}`);

  const { rows: colaCount } = await pool.query(
    'SELECT COUNT(*) as cnt FROM cola_embeddings WHERE procesado_at IS NULL'
  );
  console.log(`  cola embeddings:   ${colaCount[0].cnt} pendientes`);

  console.log('\n=== PRUEBA COMPLETADA ✅ ===');
}

main()
  .catch(e => {
    console.error('\n❌ ERROR:', e.message);
    if (e.stack) console.error(e.stack);
  })
  .finally(() => pool.end());
