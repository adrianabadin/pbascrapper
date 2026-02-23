/**
 * MCP Server — Normas Provincia de Buenos Aires
 * 5 herramientas para consulta y redacción legislativa.
 * Uso: node mcp-server/index.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }   = require('zod');
const { Pool } = require('pg');
const axios   = require('axios');

// ─── Validación de entorno al arranque ───────────────────────────────────────
if (!process.env.DATABASE_URL) {
  process.stderr.write('ERROR: DATABASE_URL no está definida en .env\n');
  process.exit(1);
}
if (!process.env.ZHIPU_API_KEY) {
  process.stderr.write('ERROR: ZHIPU_API_KEY no está definida en .env\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ZHIPU_API_KEY  = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';

// Esquema de tipos válidos (reutilizado en múltiples herramientas)
const TIPO_NORMA = z.enum([
  'ley','decreto','decreto_ley','resolucion',
  'disposicion','ordenanza_general','resolucion_conjunta',
]);

// ─── Helper: generar embedding de una query ───────────────────────────────────
async function embedQuery(texto) {
  const res = await axios.post(
    `${ZHIPU_BASE_URL}/embeddings`,
    { model: 'embedding-3', input: [texto] },
    { headers: { Authorization: `Bearer ${ZHIPU_API_KEY}` }, timeout: 15000 }
  );
  const embedding = res.data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error(`Zhipu devolvió embedding inválido: ${JSON.stringify(res.data)}`);
  }
  return embedding;
}

// ─── Helper: formatear vector para pgvector halfvec ───────────────────────────
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

// ─── Helper: respuesta de error ───────────────────────────────────────────────
function respuestaError(herramienta, err) {
  process.stderr.write(`[${herramienta}] ERROR: ${err.message}\n`);
  return respuesta({ error: err.message });
}

// ─── Servidor MCP ─────────────────────────────────────────────────────────────
const server = new McpServer({ name: 'normas-gba', version: '1.0.0' });

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 1: buscar_normas
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'buscar_normas',
  {
    title: 'Buscar normas provinciales',
    description: `Busca normas de la Provincia de Buenos Aires por descripción en lenguaje natural.
Combina búsqueda semántica (embeddings) con filtros opcionales.
Ideal para "¿qué leyes regulan X?" o "¿qué normas aplican a esta situación?".`,
    inputSchema: z.object({
      consulta:      z.string().describe('Descripción de la situación o tema a buscar'),
      tipo:          TIPO_NORMA.optional().describe('Filtrar por tipo de norma'),
      anio_desde:    z.number().int().min(1820).max(2100).optional().describe('Año mínimo'),
      anio_hasta:    z.number().int().min(1820).max(2100).optional().describe('Año máximo'),
      categorias:    z.array(z.string()).optional().describe('Filtrar por categorías (ej: ["urbanismo"])'),
      solo_vigentes: z.boolean().optional().default(false).describe('Excluir normas derogadas'),
      limit:         z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  async ({ consulta, tipo, anio_desde, anio_hasta, categorias, solo_vigentes, limit }) => {
    try {
      const vec = await embedQuery(consulta);
      const conditions = ['n.embedding_resumen IS NOT NULL'];
      const params     = [vecStr(vec)];
      let   p          = 2;

      if (tipo != null)        { conditions.push(`n.tipo = $${p++}`);        params.push(tipo); }
      if (anio_desde != null)  { conditions.push(`n.anio >= $${p++}`);       params.push(anio_desde); }
      if (anio_hasta != null)  { conditions.push(`n.anio <= $${p++}`);       params.push(anio_hasta); }
      if (solo_vigentes)       { conditions.push(`n.vigencia = 'vigente'`); }
      if (categorias?.length)  { conditions.push(`n.area_tematica && $${p++}::text[]`); params.push(categorias); }

      params.push(limit);
      const { rows } = await pool.query(`
        SELECT n.id, n.tipo, n.numero, n.anio, n.url_canonica,
               n.resumen, n.area_tematica, n.vigencia,
               n.boletin_oficial_nro, n.fecha_promulgacion,
               (n.embedding_resumen::halfvec(2048) <=> $1::halfvec(2048)) AS distancia
        FROM normas n
        WHERE ${conditions.join(' AND ')}
        ORDER BY distancia ASC
        LIMIT $${p}
      `, params);

      const resultados = rows.map(r => ({
        ...formatNorma(r),
        relevancia: parseFloat((1 - r.distancia).toFixed(4)),
      }));
      return respuesta({ total: resultados.length, resultados });
    } catch (err) {
      return respuestaError('buscar_normas', err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 2: buscar_articulos
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'buscar_articulos',
  {
    title: 'Buscar artículos específicos',
    description: `Busca artículos individuales dentro de las normas provinciales.
Devuelve el texto exacto del artículo y la norma que lo contiene.
Ideal para encontrar el artículo que habilita, regula o restringe algo concreto.`,
    inputSchema: z.object({
      consulta:   z.string().describe('Descripción de lo que debe decir el artículo'),
      tipo_norma: TIPO_NORMA.optional().describe('Limitar a un tipo de norma'),
      limit:      z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  async ({ consulta, tipo_norma, limit }) => {
    try {
      const vec = await embedQuery(consulta);
      const conditions = ['a.embedding IS NOT NULL'];
      const params     = [vecStr(vec)];
      let   p          = 2;

      if (tipo_norma != null) { conditions.push(`n.tipo = $${p++}`); params.push(tipo_norma); }
      params.push(limit);

      const { rows } = await pool.query(`
        SELECT a.id, a.numero_articulo, a.texto,
               n.id AS norma_id, n.tipo, n.numero, n.anio,
               n.url_canonica, n.vigencia,
               (a.embedding::halfvec(2048) <=> $1::halfvec(2048)) AS distancia
        FROM articulos a
        JOIN normas n ON a.norma_id = n.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY distancia ASC
        LIMIT $${p}
      `, params);

      const resultados = rows.map(r => ({
        articulo_id:     r.id,
        numero_articulo: r.numero_articulo,
        texto:           r.texto,
        relevancia:      parseFloat((1 - r.distancia).toFixed(4)),
        norma: {
          id: r.norma_id, tipo: r.tipo, numero: r.numero,
          anio: r.anio, url: r.url_canonica, vigencia: r.vigencia,
        },
      }));
      return respuesta({ total: resultados.length, resultados });
    } catch (err) {
      return respuestaError('buscar_articulos', err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 3: encontrar_adhesiones
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'encontrar_adhesiones',
  {
    title: 'Encontrar mecanismos de adhesión municipal',
    description: `Busca artículos de normas provinciales que contengan mecanismos de adhesión
o habilitación para que los municipios actúen mediante ordenanza.
Detecta frases como "los municipios podrán adherir", "el intendente queda facultado",
"mediante ordenanza municipal", "podrán adherirse al presente régimen".
Fundamental para identificar qué leyes provinciales dan base a nuevas ordenanzas.`,
    inputSchema: z.object({
      tema:  z.string().describe('Tema sobre el que se busca el mecanismo de adhesión (ej: "eficiencia energética", "residuos sólidos")'),
      limit: z.number().int().min(1).max(20).optional().default(10),
    }),
  },
  async ({ tema, limit }) => {
    try {
      const vec = await embedQuery(`adhesion municipal ordenanza ${tema}`);
      // Sin tildes para compatibilidad con todos los diccionarios FTS de PostgreSQL
      const ftsQuery = 'adhesion | adherir | municipio | municipios | intendente | ordenanza';

      const { rows } = await pool.query(`
        SELECT a.id, a.numero_articulo, a.texto,
               n.id AS norma_id, n.tipo, n.numero, n.anio,
               n.url_canonica, n.vigencia, n.resumen AS norma_resumen,
               (a.embedding::halfvec(2048) <=> $1::halfvec(2048)) AS distancia
        FROM articulos a
        JOIN normas n ON a.norma_id = n.id
        WHERE a.embedding IS NOT NULL
          AND a.fts_vector @@ to_tsquery('spanish', $2)
        ORDER BY distancia ASC
        LIMIT $3
      `, [vecStr(vec), ftsQuery, limit]);

      const resultados = rows.map(r => ({
        articulo_id:     r.id,
        numero_articulo: r.numero_articulo,
        texto:           r.texto,
        relevancia:      parseFloat((1 - r.distancia).toFixed(4)),
        norma: {
          id: r.norma_id, tipo: r.tipo, numero: r.numero,
          anio: r.anio, url: r.url_canonica,
          vigencia: r.vigencia, resumen: r.norma_resumen,
        },
      }));
      return respuesta({
        total: resultados.length,
        descripcion: `Artículos con mecanismos de adhesión municipal sobre: ${tema}`,
        resultados,
      });
    } catch (err) {
      return respuestaError('encontrar_adhesiones', err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 4: obtener_norma
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'obtener_norma',
  {
    title: 'Obtener norma completa',
    description: `Obtiene el texto completo de una norma provincial con todos sus artículos.
Usar cuando ya se identificó la norma y se necesita leer su contenido
para redactar una propuesta o analizar qué obliga o permite.`,
    inputSchema: z.object({
      tipo:   TIPO_NORMA.describe('Tipo de la norma'),
      numero: z.number().int().describe('Número de la norma'),
      anio:   z.number().int().min(1820).max(2100).describe('Año de sanción'),
    }),
  },
  async ({ tipo, numero, anio }) => {
    try {
      const { rows: normas } = await pool.query(`
        SELECT id, tipo, numero, anio, url_canonica, resumen,
               area_tematica, vigencia, boletin_oficial_nro, fecha_promulgacion,
               estado, tipo_publicacion, observaciones,
               url_texto_original, url_texto_actualizado, url_fundamentos
        FROM normas
        WHERE tipo = $1 AND numero = $2 AND anio = $3
      `, [tipo, numero, anio]);

      if (normas.length === 0) {
        return respuesta({ error: `No se encontró ${tipo} ${numero}/${anio}` });
      }

      const norma = normas[0];
      const { rows: articulos } = await pool.query(`
        SELECT numero_articulo, orden, titulo, texto
        FROM articulos WHERE norma_id = $1 ORDER BY orden ASC
      `, [norma.id]);

      return respuesta({
        ...formatNorma(norma),
        estado:                norma.estado,
        tipo_publicacion:      norma.tipo_publicacion,
        observaciones:         norma.observaciones,
        url_texto_original:    norma.url_texto_original,
        url_texto_actualizado: norma.url_texto_actualizado,
        url_fundamentos:       norma.url_fundamentos,
        total_articulos:       articulos.length,
        articulos:             articulos.map(a => ({
          numero: a.numero_articulo,
          orden:  a.orden,
          titulo: a.titulo,
          texto:  a.texto,
        })),
      });
    } catch (err) {
      return respuestaError('obtener_norma', err);
    }
  }
);

// ══════════════════════════════════════════════════════════════════════════════
// HERRAMIENTA 5: obtener_relaciones
// ══════════════════════════════════════════════════════════════════════════════
server.registerTool(
  'obtener_relaciones',
  {
    title: 'Obtener relaciones normativas',
    description: `Devuelve el árbol de relaciones de una norma: qué otras normas modifica,
deroga, reglamenta o complementa; y cuáles la modifican o derogan a ella.
Esencial para verificar si una norma está vigente y cuál es su texto actualizado.`,
    inputSchema: z.object({
      tipo:   TIPO_NORMA.describe('Tipo de la norma'),
      numero: z.number().int().describe('Número de la norma'),
      anio:   z.number().int().min(1820).max(2100).describe('Año de sanción'),
    }),
  },
  async ({ tipo, numero, anio }) => {
    try {
      const { rows: normas } = await pool.query(`
        SELECT id, tipo, numero, anio, vigencia, resumen
        FROM normas WHERE tipo = $1 AND numero = $2 AND anio = $3
      `, [tipo, numero, anio]);

      if (normas.length === 0) {
        return respuesta({ error: `No se encontró ${tipo} ${numero}/${anio}` });
      }

      const norma = normas[0];

      const { rows: emite } = await pool.query(`
        SELECT rn.tipo_relacion, rn.detalle,
               rn.destino_tipo, rn.destino_numero, rn.destino_anio,
               n.vigencia AS destino_vigencia, n.resumen AS destino_resumen
        FROM relaciones_normativas rn
        LEFT JOIN normas n ON rn.norma_destino_id = n.id
        WHERE rn.norma_origen_id = $1
        ORDER BY rn.tipo_relacion, rn.destino_anio DESC
      `, [norma.id]);

      const { rows: recibe } = await pool.query(`
        SELECT rn.tipo_relacion, rn.detalle,
               n2.tipo AS origen_tipo, n2.numero AS origen_numero,
               n2.anio AS origen_anio, n2.vigencia AS origen_vigencia
        FROM relaciones_normativas rn
        JOIN normas n2 ON rn.norma_origen_id = n2.id
        WHERE rn.norma_destino_id = $1
        ORDER BY rn.tipo_relacion, n2.anio DESC
      `, [norma.id]);

      return respuesta({
        norma: { tipo: norma.tipo, numero: norma.numero, anio: norma.anio, vigencia: norma.vigencia, resumen: norma.resumen },
        esta_norma_afecta_a: emite.map(r => ({
          relacion: r.tipo_relacion, detalle: r.detalle,
          norma:    `${r.destino_tipo} ${r.destino_numero}/${r.destino_anio}`,
          vigencia: r.destino_vigencia, resumen: r.destino_resumen,
        })),
        otras_normas_afectan_a_esta: recibe.map(r => ({
          relacion: r.tipo_relacion, detalle: r.detalle,
          norma:    `${r.origen_tipo} ${r.origen_numero}/${r.origen_anio}`,
          vigencia: r.origen_vigencia,
        })),
      });
    } catch (err) {
      return respuestaError('obtener_relaciones', err);
    }
  }
);

// ─── Arranque ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('MCP normas-gba listo\n');

  const shutdown = async (signal) => {
    process.stderr.write(`${signal} — cerrando pool...\n`);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(async (e) => {
  process.stderr.write(`ERROR FATAL: ${e.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
