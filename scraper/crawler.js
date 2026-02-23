require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'https://normas.gba.gob.ar';
const DELAY_MS = parseInt(process.env.SCRAPER_DELAY_MS || '500');

// Mapa de tipos a query params del sitio
const TIPO_MAP = {
  'ley':              'Law',
  'decreto':          'Decree',
  'decreto_ley':      'DecreeLaw',
  'ordenanza_general':'GeneralOrdinance',
  'resolucion':       'Resolution',
  'disposicion':      'Disposition',
  'resolucion_conjunta': 'JointResolution',
};

/**
 * Espera N milisegundos.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * HTTP GET con retry automático (3 intentos, backoff exponencial).
 */
async function fetchWithRetry(url, intentos = 3) {
  for (let i = 0; i < intentos; i++) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; normas-gba-scraper/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
        },
      });
      return response.data;
    } catch (err) {
      // Don't retry on permanent client errors
      if (err.response && [403, 404, 410].includes(err.response.status)) {
        throw err;
      }
      if (i === intentos - 1) throw err;
      const wait = 1000 * Math.pow(2, i);
      console.warn(`  ⚠ Reintento ${i + 1}/${intentos} para ${url} (espera ${wait}ms)`);
      await delay(wait);
    }
  }
}

/**
 * Obtiene el HTML de una página de listing.
 * Retorna { html, totalResultados, totalPaginas }
 */
async function fetchListingPage(tipo, pagina = 1) {
  const rawType = TIPO_MAP[tipo];
  if (!rawType) throw new Error(`Tipo no soportado: ${tipo}`);

  const url = `${BASE_URL}/resultados?page=${pagina}&q%5Bterms%5D%5Braw_type%5D=${rawType}&q%5Bsort%5D=by_publication_date_desc`;
  const html = await fetchWithRetry(url);

  // Extraer total de resultados del texto de paginación
  // Try multiple patterns since the site might use different formats
  let totalResultados = 0;
  const patterns = [
    /P[aá]gina\s+\d+\s+de\s+([\d.]+)\s+resultados/i,
    /(\d[\d.]*)\s+resultados/i,
    /de\s+([\d.]+)\s+resultado/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      totalResultados = parseInt(match[1].replace(/\./g, ''));
      break;
    }
  }
  const totalPaginas = totalResultados > 0 ? Math.ceil(totalResultados / 10) : 1;

  return { html, totalResultados, totalPaginas };
}

/**
 * Obtiene el HTML de la página de detalle de una norma.
 */
async function fetchDetalle(urlCanonica) {
  const url = `${BASE_URL}${urlCanonica}`;
  return fetchWithRetry(url);
}

/**
 * Obtiene el HTML del texto actualizado.
 */
async function fetchTextoActualizado(urlDocumento) {
  const url = `${BASE_URL}${urlDocumento}`;
  return fetchWithRetry(url);
}

module.exports = { fetchListingPage, fetchDetalle, fetchTextoActualizado, delay, DELAY_MS, BASE_URL };
