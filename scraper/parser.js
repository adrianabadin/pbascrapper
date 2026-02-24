const { JSDOM } = require('jsdom');

/**
 * Parsea la página de listing de resultados.
 * Retorna array de { titulo, url_canonica, resumen, fecha_publicacion, ultima_actualizacion }
 */
function parseListingPage(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const resultados = [];

  // Cada resultado tiene un h3 > a con el título y url
  const headings = doc.querySelectorAll('h3 a');
  headings.forEach(link => {
    // Real site wraps each result in .card-content; plain div as fallback for tests
    const container = link.closest('.card-content') || link.closest('div') || link.parentElement.parentElement;
    const blockquote = container.querySelector('blockquote');
    const parrafos = container.querySelectorAll('p');

    resultados.push({
      titulo: link.textContent.trim(),
      url_canonica: link.getAttribute('href'),
      resumen: blockquote ? blockquote.textContent.trim() : null,
      fecha_publicacion: parrafos[0] ? extractDate(parrafos[0].textContent) : null,
      ultima_actualizacion: parrafos[1] ? extractDateTime(parrafos[1].textContent) : null,
    });
  });

  return resultados;
}

/**
 * Parsea la página de detalle de una norma.
 * Retorna metadata + relaciones normativas.
 */
function parseDetallePage(html, urlCanonica) { // urlCanonica reserved for future: resolving relative links
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const data = {
    url_texto_original: null,
    url_texto_actualizado: null,
    url_fundamentos: null,
    fecha_promulgacion: null,
    fecha_publicacion: null,
    boletin_oficial_nro: null,
    tipo_publicacion: null,
    resumen: null,
    observaciones: null,
    organismo: null,
    ultima_actualizacion: null,
    relaciones: [],
  };

  // Extraer campos de párrafos de metadata
  doc.querySelectorAll('p').forEach(p => {
    const text = p.textContent.trim();
    if (text.startsWith('Fecha de promulgación:'))
      data.fecha_promulgacion = extractDate(text);
    else if (text.startsWith('Fecha de publicación:'))
      data.fecha_publicacion = extractDate(text);
    else if (text.startsWith('Número de Boletín Oficial:'))
      data.boletin_oficial_nro = text.replace('Número de Boletín Oficial:', '').trim();
    else if (text.startsWith('Tipo de publicación:'))
      data.tipo_publicacion = text.replace('Tipo de publicación:', '').trim();
    else if (text.startsWith('Última actualizacion:'))
      data.ultima_actualizacion = extractDateTime(text);
    else if (/^(del|de la|de el)\s/i.test(text) && !data.organismo)
      data.organismo = text;
  });

  // Resumen: primer párrafo después de h5 "Resumen"
  doc.querySelectorAll('h5').forEach(h5 => {
    if (h5.textContent.trim() === 'Resumen') {
      const next = h5.nextElementSibling;
      if (next) data.resumen = next.textContent.trim();
    }
    if (h5.textContent.trim() === 'Observaciones') {
      const next = h5.nextElementSibling;
      if (next && !next.textContent.includes('Sin observaciones'))
        data.observaciones = next.textContent.trim();
    }
  });

  // URLs de documentos
  doc.querySelectorAll('a[href*="/documentos/"]').forEach(link => {
    const text = link.textContent.trim();
    const href = link.getAttribute('href');
    if (text.includes('texto original') || href.endsWith('.pdf'))
      data.url_texto_original = href;
    else if (text.includes('texto actualizado'))
      data.url_texto_actualizado = href;
    else if (text.includes('fundamentos'))
      data.url_fundamentos = href;
  });

  // Relaciones normativas: tablas con normas modificadas
  doc.querySelectorAll('table').forEach(table => {
    table.querySelectorAll('tr').forEach(tr => {
      const cells = tr.querySelectorAll('td');
      if (cells.length < 2) return;
      const normaLink = cells[0].querySelector('a');
      if (!normaLink) return;

      const relacionText = cells[0].textContent.trim().toLowerCase();
      const tipo = inferirTipoRelacion(relacionText);
      const destUrl = normaLink.getAttribute('href');
      const destInfo = parseNormaUrl(destUrl);

      if (destInfo) {
        data.relaciones.push({
          tipo_relacion: tipo,
          destino_tipo: destInfo.tipo,
          destino_numero: destInfo.numero,
          destino_anio: destInfo.anio,
          destino_url: destUrl,
          detalle: cells[2] ? cells[2].textContent.trim() : null,
        });
      }
    });
  });

  return data;
}

/**
 * Parsea el HTML del texto actualizado extrayendo artículos individuales.
 * Retorna array de { numero_articulo, texto, orden }
 */
function parseTextoActualizado(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const articulos = [];
  let articuloActual = null;
  let orden = 0;

  // Regex para detectar inicio de artículo.
  // El separador final (.-  :  °  etc.) puede estar DENTRO o FUERA del <strong>,
  // por eso es opcional — evitamos asumir dónde termina el tag.
  // Se añade ':' porque algunas leyes usan "ARTÍCULO 1º :" como formato.
  const ARTICULO_REGEX = /^(ART[IÍ]CULO|ARTICULO)\s+\d+[°º]?\s*(BIS|TER|QUATER)?(\s*[.°\-:])?/i;

  // Get all p and div elements, but exclude divs that contain other p/div elements
  // (i.e., only process "leaf" elements) to avoid double-processing when p is inside div
  const allEls = Array.from(doc.querySelectorAll('p, div'));
  const parrafos = allEls.filter(el => {
    if (el.tagName === 'DIV' && el.querySelector('p, div')) return false;
    return true;
  });
  parrafos.forEach(el => {
    const strong = el.querySelector('strong');
    const elText = el.textContent.trim();
    let esArticulo = false;
    let numeroArticulo = null;

    // Caso 1: artículo marcado con <strong> (leyes)
    if (strong) {
      const strongText = strong.textContent.trim();
      if (ARTICULO_REGEX.test(strongText) && !elText.match(/^["'"'«]/)) {
        esArticulo = true;
        numeroArticulo = strongText.replace(/[\s°º.\-:]+$/, '').trim();
      }
    }

    // Caso 2: artículo como texto plano sin <strong> (resoluciones, disposiciones)
    if (!esArticulo && ARTICULO_REGEX.test(elText) && !elText.match(/^["'"'«]/)) {
      esArticulo = true;
      const match = elText.match(ARTICULO_REGEX);
      numeroArticulo = match[0].replace(/[\s°º.\-:]+$/, '').trim();
    }

    if (esArticulo) {
      if (articuloActual) articulos.push(articuloActual);
      articuloActual = {
        numero_articulo: numeroArticulo,
        texto: elText,
        orden: orden++,
      };
      return;
    }

    // Continuar agregando texto al artículo actual
    if (articuloActual && elText) {
      articuloActual.texto += '\n' + elText;
    }
  });

  // Guardar el último artículo
  if (articuloActual) {
    articulos.push(articuloActual);
  }

  return articulos;
}

// Helpers
function extractDate(text) {
  const match = text.match(/(\d{2}\/\d{2}\/\d{4})/);
  return match ? match[1] : null;
}

function extractDateTime(text) {
  const match = text.match(/(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/);
  return match ? match[1] : null;
}

function inferirTipoRelacion(text) {
  if (text.includes('deroga')) return 'deroga';
  if (text.includes('modifica')) return 'modifica';
  if (text.includes('reglamenta')) return 'reglamenta';
  if (text.includes('complementa')) return 'complementa';
  if (text.includes('prorroga') || text.includes('prórroga')) return 'prorroga';
  if (text.includes('sustituye')) return 'sustituye';
  return 'otra';  // was 'modifica' — use explicit unknown type
}

function parseNormaUrl(url) {
  if (!url) return null;
  // Pattern: /ar-b/{tipo}/{anio}/{numero}/{sitio_id}
  const match = url.match(/\/ar-b\/([\w-]+)\/(\d{4})\/(\d+)\/(\d+)/);
  if (!match) return null;
  const tipoMap = {
    'ley': 'ley',
    'decreto': 'decreto',
    'decreto-ley': 'decreto_ley',
    'resolucion': 'resolucion',
    'disposicion': 'disposicion',
    'ordenanza-general': 'ordenanza_general',
    'resolucion-conjunta': 'resolucion_conjunta',
  };
  return {
    tipo: tipoMap[match[1]] || match[1],
    anio: parseInt(match[2]),
    numero: parseInt(match[3]),
    sitio_id: parseInt(match[4]),
  };
}

module.exports = { parseListingPage, parseDetallePage, parseTextoActualizado, parseNormaUrl };
