require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Infiere el tipo de norma desde la URL canónica.
 * /ar-b/ley/... → 'ley', /ar-b/decreto/... → 'decreto'
 */
function inferirTipo(urlCanonica) {
  if (urlCanonica.includes('/ley/')) return 'ley';
  if (urlCanonica.includes('/decreto-ley/')) return 'decreto_ley';
  if (urlCanonica.includes('/decreto/')) return 'decreto';
  if (urlCanonica.includes('/resolucion/')) return 'resolucion';
  if (urlCanonica.includes('/disposicion/')) return 'disposicion';
  return 'ley';
}

/**
 * Infiere número y año de la URL canónica.
 * /ar-b/ley/2026/15610/559753 → { numero: 15610, anio: 2026, sitio_id: 559753 }
 */
function inferirIdentidad(urlCanonica) {
  const match = urlCanonica.match(/\/ar-b\/[\w-]+\/(\d{4})\/(\d+)\/(\d+)/);
  if (!match) throw new Error(`URL inválida: ${urlCanonica}`);
  return {
    anio: parseInt(match[1]),
    numero: parseInt(match[2]),
    sitio_id: parseInt(match[3]),
  };
}

/**
 * Upsert de una norma con su metadata básica (desde el listing).
 * Idempotente: si ya existe, actualiza solo si cambió.
 */
async function upsertNormaBasica(data) {
  const tipo = inferirTipo(data.url_canonica);
  const { anio, numero, sitio_id } = inferirIdentidad(data.url_canonica);

  const sql = `
    INSERT INTO normas (tipo, numero, anio, sitio_id, url_canonica, resumen,
                        fecha_publicacion, ultima_actualizacion)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (sitio_id) DO UPDATE SET
      resumen = EXCLUDED.resumen,
      ultima_actualizacion = EXCLUDED.ultima_actualizacion,
      updated_at = NOW()
    RETURNING id, estado
  `;
  const result = await pool.query(sql, [
    tipo, numero, anio, sitio_id,
    data.url_canonica, data.resumen,
    parseFecha(data.fecha_publicacion),
    parseFechaHora(data.ultima_actualizacion),
  ]);
  return result.rows[0];
}

/**
 * Upsert del detalle completo de una norma.
 */
async function upsertNormaDetalle(sitio_id, detalle) {
  const sql = `
    UPDATE normas SET
      url_texto_original    = $1,
      url_texto_actualizado = $2,
      url_fundamentos       = $3,
      fecha_promulgacion    = $4,
      boletin_oficial_nro   = $5,
      tipo_publicacion      = $6,
      observaciones         = $7,
      estado                = 'scrapeado',
      ultimo_scrape         = NOW()
    WHERE sitio_id = $8
    RETURNING id
  `;
  const result = await pool.query(sql, [
    detalle.url_texto_original,
    detalle.url_texto_actualizado,
    detalle.url_fundamentos,
    parseFecha(detalle.fecha_promulgacion),
    detalle.boletin_oficial_nro,
    detalle.tipo_publicacion,
    detalle.observaciones,
    sitio_id,
  ]);
  return result.rows[0]?.id;
}

/**
 * Upsert del texto actualizado con detección de cambios por SHA-256.
 * Retorna true si hubo cambio (nuevo hash).
 */
async function upsertTextoActualizado(normaId, htmlText, articulos) {
  const hashNuevo = crypto.createHash('sha256').update(htmlText).digest('hex');
  const textoCompleto = articulos.map(a => `${a.numero_articulo}. ${a.texto}`).join('\n\n');

  // Verificar hash anterior
  const { rows } = await pool.query(
    'SELECT texto_actualizado_hash FROM normas WHERE id = $1', [normaId]
  );
  const hashAnterior = rows[0]?.texto_actualizado_hash;

  if (hashAnterior === hashNuevo) return false; // Sin cambios

  // Registrar cambio en historial
  if (hashAnterior) {
    await pool.query(
      'INSERT INTO historial_cambios (norma_id, hash_anterior, hash_nuevo) VALUES ($1, $2, $3)',
      [normaId, hashAnterior, hashNuevo]
    );
  }

  // Actualizar texto en norma
  await pool.query(`
    UPDATE normas SET
      texto_completo = $1,
      texto_actualizado_hash = $2,
      estado = 'texto_extraido',
      ultimo_scrape = NOW()
    WHERE id = $3
  `, [textoCompleto, hashNuevo, normaId]);

  // Reemplazar artículos
  await pool.query('DELETE FROM articulos WHERE norma_id = $1', [normaId]);
  for (const art of articulos) {
    await pool.query(`
      INSERT INTO articulos (norma_id, numero_articulo, orden, titulo, texto)
      VALUES ($1, $2, $3, $4, $5)
    `, [normaId, art.numero_articulo, art.orden, art.titulo || null, art.texto]);
  }

  // Encolar embeddings para la norma
  await pool.query(`
    INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
    VALUES ('norma', $1, 'embedding_resumen', 3)
    ON CONFLICT (entidad_tipo, entidad_id, campo_embedding) DO UPDATE SET
      procesado_at = NULL, intentos = 0, creado_at = NOW()
  `, [normaId]);

  // Encolar embeddings para cada artículo
  const artRows = await pool.query('SELECT id FROM articulos WHERE norma_id = $1', [normaId]);
  for (const art of artRows.rows) {
    await pool.query(`
      INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
      VALUES ('articulo', $1, 'embedding', 5)
      ON CONFLICT DO NOTHING
    `, [art.id]);
  }

  return true; // Hubo cambio
}

/**
 * Upsert de relaciones normativas.
 */
async function upsertRelaciones(normaOrigenId, relaciones) {
  for (const rel of relaciones) {
    // Buscar si la norma destino ya existe
    const { rows } = await pool.query(
      'SELECT id FROM normas WHERE tipo = $1 AND numero = $2 AND anio = $3',
      [rel.destino_tipo, rel.destino_numero, rel.destino_anio]
    );
    const destinoId = rows[0]?.id || null;

    await pool.query(`
      INSERT INTO relaciones_normativas
        (norma_origen_id, norma_destino_id, destino_tipo, destino_numero, destino_anio,
         tipo_relacion, detalle)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [normaOrigenId, destinoId, rel.destino_tipo, rel.destino_numero, rel.destino_anio,
        rel.tipo_relacion, rel.detalle]);
  }
}

/**
 * Obtiene el próximo batch de embeddings pendientes.
 */
async function obtenerBatchEmbeddings(limite = 500) {
  const { rows } = await pool.query(`
    SELECT ce.id, ce.entidad_tipo, ce.entidad_id, ce.campo_embedding,
           n.resumen, n.embedding_resumen,
           a.texto as articulo_texto
    FROM cola_embeddings ce
    LEFT JOIN normas n ON ce.entidad_tipo = 'norma' AND n.id = ce.entidad_id
    LEFT JOIN articulos a ON ce.entidad_tipo = 'articulo' AND a.id = ce.entidad_id
    WHERE ce.procesado_at IS NULL AND ce.intentos < ce.max_intentos
    ORDER BY ce.prioridad ASC, ce.creado_at ASC
    LIMIT $1
  `, [limite]);
  return rows;
}

/**
 * Guarda un embedding en la entidad correspondiente.
 */
async function guardarEmbedding(colaId, entidadTipo, entidadId, campo, vector) {
  const vectorStr = `[${vector.join(',')}]`;

  if (entidadTipo === 'norma') {
    await pool.query(
      `UPDATE normas SET ${campo} = $1::vector, embeddings_generados_at = NOW() WHERE id = $2`,
      [vectorStr, entidadId]
    );
    // Verificar si todos los artículos también tienen embedding
    const { rows } = await pool.query(
      `SELECT COUNT(*) as pendientes FROM cola_embeddings
       WHERE entidad_id IN (SELECT id FROM articulos WHERE norma_id = $1)
       AND procesado_at IS NULL`, [entidadId]
    );
    if (parseInt(rows[0].pendientes) === 0) {
      await pool.query(
        `UPDATE normas SET estado = 'embeddings_generados' WHERE id = $1`,
        [entidadId]
      );
    }
  } else {
    await pool.query(
      `UPDATE articulos SET ${campo} = $1::vector WHERE id = $2`,
      [vectorStr, entidadId]
    );
  }

  await pool.query(
    `UPDATE cola_embeddings SET procesado_at = NOW() WHERE id = $1`,
    [colaId]
  );
}

/**
 * Marca un item de la cola con error.
 */
async function marcarError(colaId, error) {
  await pool.query(
    `UPDATE cola_embeddings SET intentos = intentos + 1, ultimo_error = $1 WHERE id = $2`,
    [error, colaId]
  );
}

// Helpers de fecha
function parseFecha(str) {
  if (!str) return null;
  const match = str.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseFechaHora(str) {
  if (!str) return null;
  const match = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00`;
}

module.exports = {
  pool,
  upsertNormaBasica, upsertNormaDetalle, upsertTextoActualizado,
  upsertRelaciones, obtenerBatchEmbeddings, guardarEmbedding, marcarError,
  inferirTipo, inferirIdentidad,
};
