/**
 * MCP Server — Normas Provincia de Buenos Aires
 * 5 herramientas para consulta y redacción legislativa.
 *
 * Uso: node mcp-server/index.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }   = require('zod');
const { Pool } = require('pg');
const axios   = require('axios');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ZHIPU_API_KEY  = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';

// ─── Helper: generar embedding de una query ───────────────────────────────────
async function embedQuery(texto) {
  const res = await axios.post(
    `${ZHIPU_BASE_URL}/embeddings`,
    { model: 'embedding-3', input: [texto] },
    { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 15000 }
  );
  return res.data.data[0].embedding;
}

// ─── Helper: formatear vector para pgvector ───────────────────────────────────
function vecStr(embedding) {
  return `[${embedding.join(',')}]`;
}

// ─── Helper: formatear norma para respuesta ───────────────────────────────────
function formatNorma(r) {
  return {
    id:            r.id,
    tipo:          r.tipo,
    numero:        r.numero,
    anio:          r.anio,
    vigencia:      r.vigencia,
    area_tematica: r.area_tematica || [],
    resumen:       r.resumen,
    url:           r.url_canonica,
    boletin:       r.boletin_oficial_nro,
    promulgacion:  r.fecha_promulgacion,
  };
}

// ─── Helper: respuesta de texto ───────────────────────────────────────────────
function respuesta(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

// ─── Servidor MCP ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name:    'normas-gba',
  version: '1.0.0',
});

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 1: buscar_normas
// Búsqueda semántica de normas por descripción en lenguaje natural.
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'buscar_normas',
  {
    title: 'Buscar normas provinciales',
    description: `Busca normas de la Provincia de Buenos Aires por descripción en lenguaje natural.
Combina búsqueda semántica (embeddings) con filtros opcionales.
Ideal para responder "¿qué leyes regulan X?" o "¿qué normas aplican a esta situación?".`,
    inputSchema: z.object({
      consulta:      z.string().describe('Descripción de la situación o tema a buscar'),
      tipo:          z.enum(['ley','decreto','decreto_ley','resolucion','disposicion','ordenanza_general','resolucion_conjunta']).optional().describe('Filtrar por tipo de norma'),
      anio_desde:    z.number().int().optional().describe('Año mínimo de la norma'),
      anio_hasta:    z.number().int().optional().describe('Año máximo de la norma'),
      categorias:    z.array(z.string()).optional().describe('Filtrar por categorías temáticas (ej: ["urbanismo","medio_ambiente"])'),
      solo_vigentes: z.boolean().optional().default(false).describe('Si true, excluye normas derogadas'),
      limit:         z.number().int().min(1).max(20).optional().default(10).describe('Cantidad máxima de resultados'),
    }),
  },
  async ({ consulta, tipo, anio_desde, anio_hasta, categorias, solo_vigentes, limit }) => {
    const vec = await embedQuery(consulta);

    const conditions = ['n.embedding_resumen IS NOT NULL'];
    const params     = [vecStr(vec)];
    let   p          = 2;

    if (tipo)          { conditions.push(`n.tipo = $${p++}`);         params.push(tipo); }
    if (anio_desde)    { conditions.push(`n.anio >= $${p++}`);        params.push(anio_desde); }
    if (anio_hasta)    { conditions.push(`n.anio <= $${p++}`);        params.push(anio_hasta); }
    if (solo_vigentes) { conditions.push(`n.vigencia = 'vigente'`); }
    if (categorias?.length) {
      conditions.push(`n.area_tematica && $${p++}::text[]`);
      params.push(categorias);
    }

    params.push(limit);
    const sql = `
      SELECT n.id, n.tipo, n.numero, n.anio, n.url_canonica,
             n.resumen, n.area_tematica, n.vigencia,
             n.boletin_oficial_nro, n.fecha_promulgacion,
             (n.embedding_resumen <=> $1::vector) AS distancia
      FROM normas n
      WHERE ${conditions.join(' AND ')}
      ORDER BY distancia ASC
      LIMIT $${p}
    `;

    const { rows } = await pool.query(sql, params);
    const resultados = rows.map(r => ({
      ...formatNorma(r),
      relevancia: parseFloat((1 - r.distancia).toFixed(4)),
    }));

    return respuesta({ total: resultados.length, resultados });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 2: buscar_articulos
// Búsqueda semántica granular dentro de artículos individuales.
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'buscar_articulos',
  {
    title: 'Buscar artículos específicos',
    description: `Busca artículos individuales dentro de las normas provinciales.
Devuelve el texto exacto del artículo más la norma que lo contiene.
Ideal para encontrar el artículo específico que habilita, regula o restringe algo.`,
    inputSchema: z.object({
      consulta:   z.string().describe('Descripción de lo que debe decir el artículo'),
      tipo_norma: z.enum(['ley','decreto','decreto_ley','resolucion','disposicion','ordenanza_general','resolucion_conjunta']).optional().describe('Limitar a un tipo de norma'),
      limit:      z.number().int().min(1).max(20).optional().default(10).describe('Cantidad máxima de resultados'),
    }),
  },
  async ({ consulta, tipo_norma, limit }) => {
    const vec = await embedQuery(consulta);

    const conditions = ['a.embedding IS NOT NULL'];
    const params     = [vecStr(vec)];
    let   p          = 2;

    if (tipo_norma) { conditions.push(`n.tipo = $${p++}`); params.push(tipo_norma); }

    params.push(limit);
    const sql = `
      SELECT a.id, a.numero_articulo, a.texto,
             n.id AS norma_id, n.tipo, n.numero, n.anio,
             n.url_canonica, n.vigencia,
             (a.embedding <=> $1::vector) AS distancia
      FROM articulos a
      JOIN normas n ON a.norma_id = n.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY distancia ASC
      LIMIT $${p}
    `;

    const { rows } = await pool.query(sql, params);
    const resultados = rows.map(r => ({
      articulo_id:     r.id,
      numero_articulo: r.numero_articulo,
      texto:           r.texto,
      relevancia:      parseFloat((1 - r.distancia).toFixed(4)),
      norma: {
        id:      r.norma_id,
        tipo:    r.tipo,
        numero:  r.numero,
        anio:    r.anio,
        url:     r.url_canonica,
        vigencia: r.vigencia,
      },
    }));

    return respuesta({ total: resultados.length, resultados });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 3: encontrar_adhesiones
// Encuentra mecanismos de adhesión municipal en normas provinciales.
// Combina FTS (términos de adhesión) + semántica del tema.
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'encontrar_adhesiones',
  {
    title: 'Encontrar mecanismos de adhesión municipal',
    description: `Busca artículos de normas provinciales que contengan mecanismos de adhesión
o habilitación para que los municipios actúen (ordenanzas de adhesión).
Detecta frases como "los municipios podrán adherir", "el intendente queda facultado",
"mediante ordenanza municipal", "podrán adherirse al presente régimen", etc.
Fundamental para identificar qué leyes provinciales dan base a nuevas ordenanzas.`,
    inputSchema: z.object({
      tema:  z.string().describe('Tema o área sobre la que se busca el mecanismo de adhesión (ej: "eficiencia energética", "residuos sólidos", "violencia de género")'),
      limit: z.number().int().min(1).max(20).optional().default(10).describe('Cantidad máxima de resultados'),
    }),
  },
  async ({ tema, limit }) => {
    const vec = await embedQuery(`adhesión municipal ordenanza ${tema}`);

    // FTS: busca artículos con lenguaje habilitante para municipios
    const ftsQuery = `
      adhesión | adherir | adhesion |
      municipio | municipios |
      intendente |
      ordenanza
    `.replace(/\s+/g, ' ').trim();

    const params_list = [vecStr(vec), ftsQuery, limit];
    const sql = `
      SELECT a.id, a.numero_articulo, a.texto,
             n.id AS norma_id, n.tipo, n.numero, n.anio,
             n.url_canonica, n.vigencia, n.resumen AS norma_resumen,
             (a.embedding <=> $1::vector) AS distancia,
             ts_rank(a.fts_vector, to_tsquery('spanish', $2)) AS fts_rank
      FROM articulos a
      JOIN normas n ON a.norma_id = n.id
      WHERE a.embedding IS NOT NULL
        AND a.fts_vector @@ to_tsquery('spanish', $2)
      ORDER BY (a.embedding <=> $1::vector) ASC
      LIMIT $3
    `;

    const { rows } = await pool.query(sql, params_list);
    const resultados = rows.map(r => ({
      articulo_id:     r.id,
      numero_articulo: r.numero_articulo,
      texto:           r.texto,
      relevancia:      parseFloat((1 - r.distancia).toFixed(4)),
      norma: {
        id:      r.norma_id,
        tipo:    r.tipo,
        numero:  r.numero,
        anio:    r.anio,
        url:     r.url_canonica,
        vigencia: r.vigencia,
        resumen: r.norma_resumen,
      },
    }));

    return respuesta({
      total: resultados.length,
      descripcion: `Artículos con mecanismos de adhesión municipal sobre: ${tema}`,
      resultados,
    });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 4: obtener_norma
// Detalle completo de una norma con todos sus artículos.
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'obtener_norma',
  {
    title: 'Obtener norma completa',
    description: `Obtiene el texto completo de una norma provincial con todos sus artículos.
Usar cuando ya se identificó la norma relevante y se necesita leer su contenido
para redactar una propuesta o analizar qué obliga/permite.`,
    inputSchema: z.object({
      tipo:   z.enum(['ley','decreto','decreto_ley','resolucion','disposicion','ordenanza_general','resolucion_conjunta']).describe('Tipo de la norma'),
      numero: z.number().int().describe('Número de la norma'),
      anio:   z.number().int().describe('Año de sanción'),
    }),
  },
  async ({ tipo, numero, anio }) => {
    const { rows: normas } = await pool.query(
      `SELECT * FROM normas WHERE tipo = $1 AND numero = $2 AND anio = $3`,
      [tipo, numero, anio]
    );

    if (normas.length === 0) {
      return respuesta({ error: `No se encontró ${tipo} ${numero}/${anio}` });
    }

    const norma = normas[0];

    const { rows: articulos } = await pool.query(
      `SELECT numero_articulo, orden, titulo, texto
       FROM articulos WHERE norma_id = $1 ORDER BY orden ASC`,
      [norma.id]
    );

    return respuesta({
      ...formatNorma(norma),
      estado:          norma.estado,
      tipo_publicacion: norma.tipo_publicacion,
      observaciones:   norma.observaciones,
      url_texto_original:    norma.url_texto_original,
      url_texto_actualizado: norma.url_texto_actualizado,
      url_fundamentos:       norma.url_fundamentos,
      total_articulos: articulos.length,
      articulos:       articulos.map(a => ({
        numero:  a.numero_articulo,
        orden:   a.orden,
        titulo:  a.titulo,
        texto:   a.texto,
      })),
    });
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 5: obtener_relaciones
// Árbol de relaciones normativas: qué modifica/deroga/complementa esta norma.
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'obtener_relaciones',
  {
    title: 'Obtener relaciones normativas',
    description: `Devuelve el árbol de relaciones de una norma: qué otras normas modifica,
deroga, reglamenta o complementa; y cuáles la modifican o derogan a ella.
Esencial para verificar si una norma está vigente y cuál es su texto actualizado.`,
    inputSchema: z.object({
      tipo:   z.enum(['ley','decreto','decreto_ley','resolucion','disposicion','ordenanza_general','resolucion_conjunta']).describe('Tipo de la norma'),
      numero: z.number().int().describe('Número de la norma'),
      anio:   z.number().int().describe('Año de sanción'),
    }),
  },
  async ({ tipo, numero, anio }) => {
    const { rows: normas } = await pool.query(
      `SELECT id, tipo, numero, anio, vigencia, resumen FROM normas
       WHERE tipo = $1 AND numero = $2 AND anio = $3`,
      [tipo, numero, anio]
    );

    if (normas.length === 0) {
      return respuesta({ error: `No se encontró ${tipo} ${numero}/${anio}` });
    }

    const norma = normas[0];

    // Relaciones que esta norma tiene sobre otras (lo que ella modifica/deroga)
    const { rows: emite } = await pool.query(`
      SELECT rn.tipo_relacion, rn.detalle,
             rn.destino_tipo, rn.destino_numero, rn.destino_anio,
             n.vigencia AS destino_vigencia, n.resumen AS destino_resumen
      FROM relaciones_normativas rn
      LEFT JOIN normas n ON rn.norma_destino_id = n.id
      WHERE rn.norma_origen_id = $1
      ORDER BY rn.tipo_relacion, rn.destino_anio DESC
    `, [norma.id]);

    // Relaciones que otras normas tienen sobre esta (lo que la modifica/deroga)
    const { rows: recibe } = await pool.query(`
      SELECT rn.tipo_relacion, rn.detalle,
             no2.tipo AS origen_tipo, no2.numero AS origen_numero,
             no2.anio AS origen_anio, no2.vigencia AS origen_vigencia
      FROM relaciones_normativas rn
      JOIN normas no2 ON rn.norma_origen_id = no2.id
      WHERE rn.norma_destino_id = $1
      ORDER BY rn.tipo_relacion, no2.anio DESC
    `, [norma.id]);

    return respuesta({
      norma: {
        tipo:    norma.tipo,
        numero:  norma.numero,
        anio:    norma.anio,
        vigencia: norma.vigencia,
        resumen: norma.resumen,
      },
      esta_norma_afecta_a: emite.map(r => ({
        relacion:  r.tipo_relacion,
        detalle:   r.detalle,
        norma:     `${r.destino_tipo} ${r.destino_numero}/${r.destino_anio}`,
        vigencia:  r.destino_vigencia,
        resumen:   r.destino_resumen,
      })),
      otras_normas_afectan_a_esta: recibe.map(r => ({
        relacion:  r.tipo_relacion,
        detalle:   r.detalle,
        norma:     `${r.origen_tipo} ${r.origen_numero}/${r.origen_anio}`,
        vigencia:  r.origen_vigencia,
      })),
    });
  }
);

// ─── Arranque ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('MCP normas-gba listo\n');
}

main().catch(e => {
  process.stderr.write(`ERROR: ${e.message}\n`);
  process.exit(1);
});
