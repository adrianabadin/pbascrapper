-- =============================================================
-- Normas Provincia de Buenos Aires - Schema
-- PostgreSQL 17 + pgvector 0.8.1
-- Embeddings: vector(2048) - Zhipu embedding-3
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ENUMS
DO $$ BEGIN
  CREATE TYPE tipo_norma AS ENUM (
    'ley', 'decreto', 'decreto_ley', 'resolucion',
    'disposicion', 'ordenanza_general', 'resolucion_conjunta'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE estado_vigencia AS ENUM (
    'vigente', 'derogada', 'derogada_parcialmente',
    'suspendida', 'desconocido'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE estado_procesamiento AS ENUM (
    'pendiente', 'scrapeado', 'texto_extraido', 'embeddings_generados', 'error'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tipo_relacion AS ENUM (
    'modifica', 'deroga', 'deroga_parcialmente', 'reglamenta',
    'complementa', 'prorroga', 'sustituye', 'cita', 'otra'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TABLA PRINCIPAL
CREATE TABLE IF NOT EXISTS normas (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tipo                    tipo_norma NOT NULL,
  numero                  INTEGER NOT NULL,
  anio                    SMALLINT NOT NULL,
  sitio_id                INTEGER NOT NULL,
  url_canonica            TEXT NOT NULL,
  url_texto_original      TEXT,
  url_texto_actualizado   TEXT,
  url_fundamentos         TEXT,
  texto_actualizado_hash  TEXT,
  fecha_promulgacion      DATE,
  fecha_publicacion       DATE,
  ultima_actualizacion    TIMESTAMPTZ,
  boletin_oficial_nro     TEXT,
  tipo_publicacion        TEXT,
  resumen                 TEXT,
  observaciones           TEXT,
  vigencia                estado_vigencia NOT NULL DEFAULT 'desconocido',
  estado                  estado_procesamiento NOT NULL DEFAULT 'pendiente',
  area_tematica           TEXT[],
  texto_completo          TEXT,
  embedding_resumen       VECTOR(2048),
  fts_vector              TSVECTOR,
  ultimo_scrape           TIMESTAMPTZ,
  embeddings_generados_at TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_norma_identidad UNIQUE (tipo, numero, anio),
  CONSTRAINT uq_sitio_id UNIQUE (sitio_id),
  CONSTRAINT chk_anio CHECK (anio BETWEEN 1820 AND 2100)
);

-- ARTICULOS
CREATE TABLE IF NOT EXISTS articulos (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  norma_id        UUID NOT NULL REFERENCES normas(id) ON DELETE CASCADE,
  numero_articulo TEXT NOT NULL,
  orden           SMALLINT NOT NULL,
  titulo          TEXT,
  texto           TEXT NOT NULL,
  embedding       VECTOR(2048),
  fts_vector      TSVECTOR,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_articulo_norma UNIQUE (norma_id, orden)
);

-- RELACIONES NORMATIVAS
CREATE TABLE IF NOT EXISTS relaciones_normativas (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  norma_origen_id     UUID NOT NULL REFERENCES normas(id) ON DELETE CASCADE,
  norma_destino_id    UUID REFERENCES normas(id) ON DELETE SET NULL,
  destino_tipo        tipo_norma,
  destino_numero      INTEGER,
  destino_anio        SMALLINT,
  tipo_relacion       tipo_relacion NOT NULL,
  detalle             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- COLA DE EMBEDDINGS
CREATE TABLE IF NOT EXISTS cola_embeddings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entidad_tipo    TEXT NOT NULL CHECK (entidad_tipo IN ('norma', 'articulo')),
  entidad_id      UUID NOT NULL,
  campo_embedding TEXT NOT NULL,
  prioridad       SMALLINT NOT NULL DEFAULT 5,
  intentos        SMALLINT NOT NULL DEFAULT 0,
  max_intentos    SMALLINT NOT NULL DEFAULT 3,
  ultimo_error    TEXT,
  creado_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  procesado_at    TIMESTAMPTZ,
  CONSTRAINT uq_cola_item UNIQUE (entidad_tipo, entidad_id, campo_embedding)
);

-- HISTORIAL DE CAMBIOS
CREATE TABLE IF NOT EXISTS historial_cambios (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  norma_id      UUID NOT NULL REFERENCES normas(id) ON DELETE CASCADE,
  hash_anterior TEXT,
  hash_nuevo    TEXT NOT NULL,
  detectado_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- INDICES FTS
CREATE INDEX IF NOT EXISTS idx_normas_fts ON normas USING GIN (fts_vector);
CREATE INDEX IF NOT EXISTS idx_articulos_fts ON articulos USING GIN (fts_vector);

-- INDICES DE FILTRADO
CREATE INDEX IF NOT EXISTS idx_normas_tipo_anio ON normas (tipo, anio);
CREATE INDEX IF NOT EXISTS idx_normas_vigencia ON normas (vigencia);
CREATE INDEX IF NOT EXISTS idx_normas_estado ON normas (estado);
CREATE INDEX IF NOT EXISTS idx_articulos_norma ON articulos (norma_id, orden);
CREATE INDEX IF NOT EXISTS idx_relaciones_origen ON relaciones_normativas (norma_origen_id);
CREATE INDEX IF NOT EXISTS idx_relaciones_destino ON relaciones_normativas (norma_destino_id);
CREATE INDEX IF NOT EXISTS idx_cola_pendientes ON cola_embeddings (prioridad, creado_at)
  WHERE procesado_at IS NULL AND intentos < max_intentos;

-- INDICES HNSW PARA VECTORES (2048 dims)
CREATE INDEX IF NOT EXISTS idx_normas_emb_resumen ON normas
  USING hnsw ((embedding_resumen::halfvec(2048)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE INDEX IF NOT EXISTS idx_articulos_embedding ON articulos
  USING hnsw ((embedding::halfvec(2048)) halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- TRIGGER: updated_at automatico
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normas_updated_at ON normas;
CREATE TRIGGER trg_normas_updated_at
  BEFORE UPDATE ON normas FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_articulos_updated_at ON articulos;
CREATE TRIGGER trg_articulos_updated_at
  BEFORE UPDATE ON articulos FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- TRIGGER: FTS automatico en normas (peso A=tipo/numero/anio, B=resumen, C=observaciones, D=texto_completo)
CREATE OR REPLACE FUNCTION trigger_normas_fts() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('spanish',
      COALESCE(NEW.tipo::text, '') || ' ' ||
      COALESCE(NEW.numero::text, '') || ' ' ||
      COALESCE(NEW.anio::text, '')
    ), 'A') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.resumen, '')), 'B') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.observaciones, '')), 'C') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.texto_completo, '')), 'D');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normas_fts ON normas;
CREATE TRIGGER trg_normas_fts
  BEFORE INSERT OR UPDATE OF tipo, numero, anio, resumen, observaciones, texto_completo ON normas
  FOR EACH ROW EXECUTE FUNCTION trigger_normas_fts();

-- TRIGGER: FTS automatico en articulos (peso A=titulo, B=texto)
CREATE OR REPLACE FUNCTION trigger_articulos_fts() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('spanish', COALESCE(NEW.titulo, '')), 'A') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.texto, '')), 'B');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_articulos_fts ON articulos;
CREATE TRIGGER trg_articulos_fts
  BEFORE INSERT OR UPDATE OF titulo, texto ON articulos
  FOR EACH ROW EXECUTE FUNCTION trigger_articulos_fts();

-- TRIGGER: auto-resolver relaciones huerfanas al insertar una norma
CREATE OR REPLACE FUNCTION resolver_relaciones_huerfanas() RETURNS TRIGGER AS $$
BEGIN
  UPDATE relaciones_normativas SET norma_destino_id = NEW.id
  WHERE norma_destino_id IS NULL
    AND destino_tipo = NEW.tipo
    AND destino_numero = NEW.numero
    AND destino_anio = NEW.anio;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_resolver_relaciones ON normas;
CREATE TRIGGER trg_resolver_relaciones
  AFTER INSERT ON normas FOR EACH ROW EXECUTE FUNCTION resolver_relaciones_huerfanas();

-- Cleanup de cola_embeddings cuando se elimina una norma
CREATE OR REPLACE FUNCTION cleanup_cola_norma() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM cola_embeddings WHERE entidad_tipo = 'norma' AND entidad_id = OLD.id;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_cola_norma ON normas;
CREATE TRIGGER trg_cleanup_cola_norma
  BEFORE DELETE ON normas FOR EACH ROW EXECUTE FUNCTION cleanup_cola_norma();

-- Cleanup de cola_embeddings cuando se elimina un articulo
CREATE OR REPLACE FUNCTION cleanup_cola_articulo() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM cola_embeddings WHERE entidad_tipo = 'articulo' AND entidad_id = OLD.id;
  RETURN OLD;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_cola_articulo ON articulos;
CREATE TRIGGER trg_cleanup_cola_articulo
  BEFORE DELETE ON articulos FOR EACH ROW EXECUTE FUNCTION cleanup_cola_articulo();

-- Index faltante en historial_cambios
CREATE INDEX IF NOT EXISTS idx_historial_norma ON historial_cambios (norma_id, detectado_at DESC);

-- Constraint para relaciones identificables
-- (no modificar tabla existente, solo agregar si no existe via ALTER TABLE)
