jest.mock('pdf-parse', () => jest.fn());

const { parseListingPage, parseDetallePage, parseTextoActualizado, parseTextoFromPdf } = require('../../scraper/parser');
const pdfParse = require('pdf-parse');

// HTML mínimo del listing basado en la estructura real del sitio
const LISTING_HTML = `
<div>
  <h3><a href="/ar-b/ley/2026/15610/559753">Ley 15610</a></h3>
  <h6></h6>
  <h6>Resumen</h6>
  <blockquote>MODIFICA LA LEY 14.528 PROCEDIMIENTO DE ADOPCION.</blockquote>
  <p>Fecha de publicación: 13/01/2026</p>
  <p>Última actualizacion: 13/01/2026 09:01</p>
</div>
<div>
  <h3><a href="/ar-b/decreto/2025/123/456789">Decreto 123</a></h3>
  <h6></h6>
  <h6>Resumen</h6>
  <blockquote>REGLAMENTA LA LEY 15000.</blockquote>
  <p>Fecha de publicación: 01/12/2025</p>
  <p>Última actualizacion: 02/12/2025 10:00</p>
</div>
`;

const DETALLE_HTML = `
<div>
  <h1>Ley 15610</h1>
  <p>Fecha de promulgación: 13/01/2026</p>
  <p>Fecha de publicación: 13/01/2026</p>
  <p>Número de Boletín Oficial: 30158</p>
  <p>Tipo de publicación: Integra</p>
  <h5>Resumen</h5>
  <p>MODIFICA LA LEY 14.528.</p>
  <h5>Observaciones</h5>
  <em>Sin observaciones.</em>
  <h5>Documentos</h5>
  <a href="/documentos/BeRez6Fj.pdf">Ver copia texto original</a>
  <a href="/documentos/VmeMWQTl.html">Ver texto actualizado</a>
  <a href="/documentos/0Ynzm3S7.html">Ver fundamentos</a>
  <table>
    <tr><th>Norma</th><th>Fecha</th><th>Resumen</th></tr>
    <tr>
      <td>Modifica a <a href="/ar-b/ley/2013/14528/11307">Ley 14528</a></td>
      <td>30/08/2013</td>
      <td>ESTABLECE EL PROCEDIMIENTO DE ADOPCION.</td>
    </tr>
  </table>
  <p>Última actualizacion: 13/01/2026 09:01</p>
</div>
`;

const TEXTO_ACTUALIZADO_HTML = `
<body>
  <p><strong>LEY 15610</strong></p>
  <p><strong>EL SENADO Y CAMARA DE DIPUTADOS...</strong></p>
  <p><span><strong>ARTÍCULO 1°.-</strong> Sustitúyese el artículo 2°...</span></p>
  <p>Texto del artículo 1 continuado.</p>
  <p><span><strong>ARTICULO 2°.-</strong> Sustitúyese el artículo 6°...</span></p>
  <p>Texto del artículo 2 continuado.</p>
  <p><span><strong>ARTÍCULO 3º.-</strong> Incorpórase al Libro I...</span></p>
</body>
`;

describe('parseListingPage', () => {
  test('extrae normas del HTML de listing', () => {
    const normas = parseListingPage(LISTING_HTML);
    expect(normas).toHaveLength(2);
    expect(normas[0]).toMatchObject({
      titulo: 'Ley 15610',
      url_canonica: '/ar-b/ley/2026/15610/559753',
      resumen: 'MODIFICA LA LEY 14.528 PROCEDIMIENTO DE ADOPCION.',
      fecha_publicacion: '13/01/2026',
    });
    expect(normas[1].titulo).toBe('Decreto 123');
  });
});

describe('parseDetallePage', () => {
  test('extrae metadata de la página de detalle', () => {
    const data = parseDetallePage(DETALLE_HTML, '/ar-b/ley/2026/15610/559753');
    expect(data.fecha_promulgacion).toBe('13/01/2026');
    expect(data.boletin_oficial_nro).toBe('30158');
    expect(data.url_texto_actualizado).toBe('/documentos/VmeMWQTl.html');
    expect(data.url_texto_original).toBe('/documentos/BeRez6Fj.pdf');
    expect(data.relaciones).toHaveLength(1);
    expect(data.relaciones[0]).toMatchObject({
      tipo_relacion: 'modifica',
      destino_numero: 14528,
      destino_anio: 2013,
    });
  });
});

describe('parseTextoFromPdf', () => {
  beforeEach(() => pdfParse.mockReset());

  test('extrae artículos de texto PDF simulado', async () => {
    pdfParse.mockResolvedValue({
      text: 'ARTÍCULO 1°.- El objeto de la presente ley.\nTexto adicional.\nARTÍCULO 2°.- Derogase toda norma contraria.',
    });
    const articulos = await parseTextoFromPdf(Buffer.from('fake'));
    expect(articulos.length).toBe(2);
    expect(articulos[0].numero_articulo).toMatch(/ARTÍCULO 1/i);
    expect(articulos[0].texto).toContain('El objeto de la presente ley');
    expect(articulos[1].numero_articulo).toMatch(/ARTÍCULO 2/i);
  });

  test('retorna [] para PDF escaneado (texto vacío)', async () => {
    pdfParse.mockResolvedValue({ text: '   ' });
    const articulos = await parseTextoFromPdf(Buffer.from('fake'));
    expect(articulos).toEqual([]);
  });

  test('retorna [] en error de pdf-parse', async () => {
    pdfParse.mockRejectedValue(new Error('Invalid PDF'));
    const articulos = await parseTextoFromPdf(Buffer.from('bad'));
    expect(articulos).toEqual([]);
  });

  test('formato Art. N° funciona en texto plano', async () => {
    pdfParse.mockResolvedValue({
      text: 'Art. 1° - Objeto.\nArt. 2° - Vigencia.',
    });
    const articulos = await parseTextoFromPdf(Buffer.from('fake'));
    expect(articulos.length).toBe(2);
    expect(articulos[0].numero_articulo).toMatch(/Art\. 1/i);
  });
});

describe('parseTextoActualizado', () => {
  test('extrae artículos individualmente', () => {
    const articulos = parseTextoActualizado(TEXTO_ACTUALIZADO_HTML);
    expect(articulos.length).toBeGreaterThanOrEqual(3);
    expect(articulos[0].numero_articulo).toMatch(/ARTÍCULO 1/i);
    expect(articulos[0].texto).toContain('Sustitúyese el artículo 2°');
    expect(articulos[0].orden).toBe(0);
  });

  test('ignora el encabezado (LEY NNNN, EL SENADO...)', () => {
    const articulos = parseTextoActualizado(TEXTO_ACTUALIZADO_HTML);
    const tieneEncabezado = articulos.some(a => a.numero_articulo.match(/^LEY|SENADO/i));
    expect(tieneEncabezado).toBe(false);
  });
});
