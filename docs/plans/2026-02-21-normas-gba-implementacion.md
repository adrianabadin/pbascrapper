# Normas GBA — MCP Scraper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scraper CLI + MCP server para indexar Leyes y Decretos de normas.gba.gob.ar con búsqueda full-text y semántica via pgvector + Zhipu embeddings.

**Architecture:** CLI scraper en 3 fases desacopladas (crawl → parse → embed); MCP server separado que sirve tools de búsqueda sobre PostgreSQL. Ambos en Node.js, conectando a PostgreSQL remoto en Docker.

**Tech Stack:** Node.js v20, jsdom, axios, pg, @modelcontextprotocol/sdk, Zhipu API (OpenAI-compatible), PostgreSQL 17 + pgvector 0.8.1

---

## Task 1: Project setup y estructura

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `scraper/index.js` (placeholder)
- Create: `mcp-server/index.js` (placeholder)

**Step 1: Instalar dependencias**

```bash
cd C:\Users\Adria\Documents\code\pba
npm install axios jsdom pg @modelcontextprotocol/sdk dotenv
npm install --save-dev jest
```

**Step 2: Actualizar package.json con scripts**

Reemplazar el `package.json` existente con:

```json
{
  "name": "normas-gba-mcp",
  "version": "1.0.0",
  "description": "Scraper + MCP server para normativa de la Provincia de Buenos Aires",
  "type": "commonjs",
  "scripts": {
    "scrape": "node scraper/index.js",
    "embed": "node scraper/index.js --embed",
    "classify": "node scraper/index.js --classify",
    "mcp": "node mcp-server/index.js",
    "test": "jest --testEnvironment node"
  },
  "dependencies": {
    "axios": "^1.7.0",
    "dotenv": "^16.4.0",
    "jsdom": "^25.0.0",
    "pg": "^8.13.0",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "jest": "^29.0.0"
  }
}
```

```bash
npm install
```

**Step 3: Crear .env.example**

```
DATABASE_URL=postgresql://usuario:password@host:5432/pba_normas
ZHIPU_API_KEY=tu_api_key_aqui
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
SCRAPER_DELAY_MS=500
SCRAPER_CONCURRENCY=3
EMBED_BATCH_SIZE=500
```

**Step 4: Crear .env con valores reales** (no commitear)

```
DATABASE_URL=postgresql://adrian:!DarthHobbit%25@thecodersteam.com:5432/pba_normas
ZHIPU_API_KEY=<api_key>
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4
SCRAPER_DELAY_MS=500
SCRAPER_CONCURRENCY=3
EMBED_BATCH_SIZE=500
```

**Step 5: Crear .gitignore**

```
node_modules/
.env
*.log
```

**Step 6: Crear placeholders**

```bash
mkdir -p scraper mcp-server/tools db tests/scraper tests/mcp
echo "// TODO" > scraper/index.js
echo "// TODO" > mcp-server/index.js
```

**Step 7: Verificar que Jest corre**

```bash
npm test
```
Expected: `No tests found` (sin error fatal)

**Step 8: Commit**

```bash
git init
git add package.json package-lock.json .env.example .gitignore
git commit -m "feat: project setup - Node.js + jest + dependencies"
```

---

## Task 2: Schema de base de datos

**Files:**
- Create: `db/schema.sql`
- Create: `db/apply-schema.js`

**Step 1: Crear db/schema.sql**

```sql
-- =============================================================
-- Normas Provincia de Buenos Aires - Schema
-- PostgreSQL 17 + pgvector 0.8.1
-- =============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ENUMS
CREATE TYPE tipo_norma AS ENUM (
  'ley', 'decreto', 'decreto_ley', 'resolucion',
  'disposicion', 'ordenanza_general', 'resolucion_conjunta'
);

CREATE TYPE estado_vigencia AS ENUM (
  'vigente', 'derogada', 'derogada_parcialmente',
  'suspendida', 'desconocido'
);

CREATE TYPE estado_procesamiento AS ENUM (
  'pendiente', 'scrapeado', 'texto_extraido', 'embeddings_generados', 'error'
);

CREATE TYPE tipo_relacion AS ENUM (
  'modifica', 'deroga', 'deroga_parcialmente', 'reglamenta',
  'complementa', 'prorroga', 'sustituye', 'cita', 'otra'
);

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

-- ARTÍCULOS
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

-- RELACIONES NORMATIVAS (grafo dirigido)
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

-- ÍNDICES FTS
CREATE INDEX IF NOT EXISTS idx_normas_fts ON normas USING GIN (fts_vector);
CREATE INDEX IF NOT EXISTS idx_articulos_fts ON articulos USING GIN (fts_vector);

-- ÍNDICES DE FILTRADO
CREATE INDEX IF NOT EXISTS idx_normas_tipo_anio ON normas (tipo, anio);
CREATE INDEX IF NOT EXISTS idx_normas_vigencia ON normas (vigencia);
CREATE INDEX IF NOT EXISTS idx_normas_estado ON normas (estado);
CREATE INDEX IF NOT EXISTS idx_articulos_norma ON articulos (norma_id, orden);
CREATE INDEX IF NOT EXISTS idx_relaciones_origen ON relaciones_normativas (norma_origen_id);
CREATE INDEX IF NOT EXISTS idx_relaciones_destino ON relaciones_normativas (norma_destino_id);
CREATE INDEX IF NOT EXISTS idx_cola_pendientes ON cola_embeddings (prioridad, creado_at)
  WHERE procesado_at IS NULL AND intentos < max_intentos;

-- ÍNDICES HNSW PARA VECTORES (2048 dims de Zhipu embedding-3)
CREATE INDEX IF NOT EXISTS idx_normas_emb_resumen ON normas
  USING hnsw (embedding_resumen vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

CREATE INDEX IF NOT EXISTS idx_articulos_embedding ON articulos
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- TRIGGER: updated_at automático
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_normas_updated_at
  BEFORE UPDATE ON normas FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE OR REPLACE TRIGGER trg_articulos_updated_at
  BEFORE UPDATE ON articulos FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- TRIGGER: FTS automático en normas
CREATE OR REPLACE FUNCTION trigger_normas_fts() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('spanish', COALESCE(NEW.resumen, '')), 'A') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.observaciones, '')), 'C') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.texto_completo, '')), 'D');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_normas_fts
  BEFORE INSERT OR UPDATE OF resumen, observaciones, texto_completo ON normas
  FOR EACH ROW EXECUTE FUNCTION trigger_normas_fts();

-- TRIGGER: FTS automático en artículos
CREATE OR REPLACE FUNCTION trigger_articulos_fts() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('spanish', COALESCE(NEW.titulo, '')), 'A') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.texto, '')), 'B');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_articulos_fts
  BEFORE INSERT OR UPDATE OF titulo, texto ON articulos
  FOR EACH ROW EXECUTE FUNCTION trigger_articulos_fts();

-- TRIGGER: auto-resolver relaciones huérfanas
CREATE OR REPLACE FUNCTION resolver_relaciones_huerfanas() RETURNS TRIGGER AS $$
BEGIN
  UPDATE relaciones_normativas SET norma_destino_id = NEW.id
  WHERE norma_destino_id IS NULL
    AND destino_tipo = NEW.tipo
    AND destino_numero = NEW.numero
    AND destino_anio = NEW.anio;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_resolver_relaciones
  AFTER INSERT ON normas FOR EACH ROW EXECUTE FUNCTION resolver_relaciones_huerfanas();
```

**Step 2: Crear db/apply-schema.js**

```js
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function applySchema() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('Conectado a PostgreSQL...');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.query(sql);
  console.log('✅ Schema aplicado correctamente');
  await client.end();
}

applySchema().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
```

**Step 3: Aplicar schema**

```bash
node db/apply-schema.js
```
Expected: `✅ Schema aplicado correctamente`

**Step 4: Verificar tablas creadas**

```bash
node -e "
require('dotenv').config();
const { Client } = require('pg');
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query(\"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\"))
  .then(r => { r.rows.forEach(row => console.log('✓', row.tablename)); })
  .finally(() => c.end());
"
```
Expected: `articulos`, `cola_embeddings`, `historial_cambios`, `normas`, `relaciones_normativas`

**Step 5: Commit**

```bash
git add db/
git commit -m "feat: database schema - normas, articulos, relaciones, cola_embeddings"
```

---

## Task 3: Parser jsdom (con tests)

El parser es la función más pura del sistema: recibe HTML → devuelve datos estructurados. Es la más fácil de testear y la más crítica de tener correcta.

**Files:**
- Create: `scraper/parser.js`
- Create: `tests/scraper/parser.test.js`

**Step 1: Escribir el test con HTML de ejemplo real**

Crear `tests/scraper/parser.test.js`:

```js
const { parseListingPage, parseDetallePage, parseTextoActualizado } = require('../../scraper/parser');

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
```

**Step 2: Correr el test para verificar que falla**

```bash
npm test -- tests/scraper/parser.test.js
```
Expected: FAIL — `Cannot find module '../../scraper/parser'`

**Step 3: Implementar scraper/parser.js**

```js
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
    const container = link.closest('div') || link.parentElement.parentElement;
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
function parseDetallePage(html, urlCanonica) {
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

  // Regex para detectar inicio de artículo
  const ARTICULO_REGEX = /^(ART[IÍ]CULO|ARTICULO)\s+\d+[°º]?\s*(BIS|TER|QUATER)?\s*[.°-]/i;

  const parrafos = doc.querySelectorAll('p, div');
  parrafos.forEach(el => {
    // Buscar strong dentro del elemento que sea un artículo
    const strong = el.querySelector('strong');
    if (strong) {
      const strongText = strong.textContent.trim();
      if (ARTICULO_REGEX.test(strongText)) {
        // Guardar el artículo anterior
        if (articuloActual) {
          articulos.push(articuloActual);
        }
        // Iniciar nuevo artículo
        articuloActual = {
          numero_articulo: strongText.replace(/[.°-]\s*$/, '').trim(),
          texto: el.textContent.trim(),
          orden: orden++,
        };
        return;
      }
    }
    // Continuar agregando texto al artículo actual
    if (articuloActual) {
      const texto = el.textContent.trim();
      if (texto) {
        articuloActual.texto += '\n' + texto;
      }
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
  if (text.includes('prorroga') || text.includes('prorroga')) return 'prorroga';
  if (text.includes('sustituye')) return 'sustituye';
  return 'modifica';
}

function parseNormaUrl(url) {
  if (!url) return null;
  // Pattern: /ar-b/{tipo}/{anio}/{numero}/{sitio_id}
  const match = url.match(/\/ar-b\/(\w+)\/(\d{4})\/(\d+)\/(\d+)/);
  if (!match) return null;
  const tipoMap = { 'ley': 'ley', 'decreto': 'decreto', 'decreto-ley': 'decreto_ley' };
  return {
    tipo: tipoMap[match[1]] || match[1],
    anio: parseInt(match[2]),
    numero: parseInt(match[3]),
    sitio_id: parseInt(match[4]),
  };
}

module.exports = { parseListingPage, parseDetallePage, parseTextoActualizado, parseNormaUrl };
```

**Step 4: Correr los tests**

```bash
npm test -- tests/scraper/parser.test.js
```
Expected: PASS (todos los tests en verde)

**Step 5: Commit**

```bash
git add scraper/parser.js tests/scraper/parser.test.js
git commit -m "feat: jsdom parser for listing, detail and texto-actualizado pages"
```

---

## Task 4: DB layer del scraper

**Files:**
- Create: `scraper/db.js`

**Step 1: Implementar scraper/db.js**

```js
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
  const match = urlCanonica.match(/\/ar-b\/\w+\/(\d{4})\/(\d+)\/(\d+)/);
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

  // Encolar embeddings
  await pool.query(`
    INSERT INTO cola_embeddings (entidad_tipo, entidad_id, campo_embedding, prioridad)
    VALUES ('norma', $1, 'embedding_resumen', 3)
    ON CONFLICT (entidad_tipo, entidad_id, campo_embedding) DO UPDATE SET
      procesado_at = NULL, intentos = 0, creado_at = NOW()
  `, [normaId]);

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
      `UPDATE articulos SET ${campo} = $1::vector, embeddings_generados_at = NOW() WHERE id = $2`,
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
```

**Step 2: Test rápido de conexión**

```bash
node -e "
require('dotenv').config();
const { pool } = require('./scraper/db');
pool.query('SELECT COUNT(*) FROM normas')
  .then(r => console.log('✅ DB conectada. Normas:', r.rows[0].count))
  .catch(e => console.error('ERROR:', e.message))
  .finally(() => pool.end());
"
```
Expected: `✅ DB conectada. Normas: 0`

**Step 3: Commit**

```bash
git add scraper/db.js
git commit -m "feat: scraper db layer - upsert normas, articulos, cola_embeddings"
```

---

## Task 5: Crawler con rate limiting

**Files:**
- Create: `scraper/crawler.js`

**Step 1: Implementar scraper/crawler.js**

```js
require('dotenv').config();
const axios = require('axios');

const BASE_URL = 'https://normas.gba.gob.ar';
const DELAY_MS = parseInt(process.env.SCRAPER_DELAY_MS || '500');

// Mapa de tipos a query params del sitio
const TIPO_MAP = {
  'ley': 'Law',
  'decreto': 'Decree',
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

  const url = `${BASE_URL}/resultados?page=${pagina}&q%5Bterms%5D%5Braw_type%5D=${rawType}&q%5Bterms%5D%5Bnumber%5D=&q%5Bterms%5D%5Byear%5D=&q%5Bsort%5D=by_publication_date_desc`;
  const html = await fetchWithRetry(url);

  // Extraer total de resultados del texto "Página X de NNNN resultados"
  const match = html.match(/P[aá]gina\s+\d+\s+de\s+([\d.]+)\s+resultados/i);
  const totalResultados = match ? parseInt(match[1].replace('.', '')) : 0;
  const totalPaginas = Math.ceil(totalResultados / 10);

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

module.exports = { fetchListingPage, fetchDetalle, fetchTextoActualizado, delay, DELAY_MS };
```

**Step 2: Test manual rápido**

```bash
node -e "
require('dotenv').config();
const { fetchListingPage } = require('./scraper/crawler');
fetchListingPage('ley', 1).then(r => {
  console.log('Total leyes:', r.totalResultados);
  console.log('Total páginas:', r.totalPaginas);
  console.log('HTML length:', r.html.length);
}).catch(e => console.error('ERROR:', e.message));
"
```
Expected: `Total leyes: ~13942`, `Total páginas: ~1395`

**Step 3: Commit**

```bash
git add scraper/crawler.js
git commit -m "feat: crawler with rate limiting, retry and pagination"
```

---

## Task 6: CLI del scraper (orquestador)

**Files:**
- Modify: `scraper/index.js`

**Step 1: Implementar scraper/index.js**

```js
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
const soloListing = args.includes('--solo-listing'); // Solo listing, no detalle
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
        console.log(`    📝 Texto actualizado (${articulos.length} artículos)`);
      } else {
        console.log(`    ✓ Sin cambios en texto`);
      }
    }

    // 4. Relaciones normativas
    if (detalle.relaciones.length > 0) {
      await upsertRelaciones(normaId, detalle.relaciones);
    }

  } catch (err) {
    console.error(`  ❌ Error procesando ${normaBasica.url_canonica}: ${err.message}`);
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

  for (const tipo of tiposArg) {
    await scrapearTipo(tipo);
  }

  await pool.end();
  console.log('\n🎉 Scraping completado');
}

main().catch(e => { console.error('FATAL:', e.message); pool.end(); process.exit(1); });
```

**Step 2: Test con 1 página de leyes**

```bash
node scraper/index.js --tipo ley --max-paginas 1
```
Expected: procesa ~10 leyes, muestra progreso, sin errores fatales

**Step 3: Verificar en la BD**

```bash
node -e "
require('dotenv').config();
const { pool } = require('./scraper/db');
pool.query('SELECT tipo, COUNT(*) as total FROM normas GROUP BY tipo')
  .then(r => { r.rows.forEach(row => console.log(row.tipo, ':', row.total)); })
  .finally(() => pool.end());
"
```

**Step 4: Commit**

```bash
git add scraper/index.js
git commit -m "feat: scraper CLI - crawl + parse + upsert orchestrator"
```

---

## Task 7: Embedder (Zhipu API, sessions)

**Files:**
- Create: `scraper/embedder.js`
- Modify: `scraper/index.js` (agregar rama --embed)

**Step 1: Implementar scraper/embedder.js**

```js
require('dotenv').config();
const axios = require('axios');
const { obtenerBatchEmbeddings, guardarEmbedding, marcarError } = require('./db');

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
const ZHIPU_BASE_URL = process.env.ZHIPU_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || '500');
const EMBED_CONCURRENCY = 5; // requests paralelos a Zhipu
const EMBED_DELAY_MS = 200;  // delay entre batches de requests

/**
 * Genera embedding para un texto usando Zhipu embedding-3 (2048 dims).
 */
async function generarEmbedding(texto) {
  if (!texto || texto.trim().length === 0) return null;

  // Truncar a ~8000 chars para no exceder el límite del modelo
  const textoTruncado = texto.slice(0, 8000);

  const response = await axios.post(
    `${ZHIPU_BASE_URL}/embeddings`,
    { model: 'embedding-3', input: textoTruncado, dimensions: 2048 },
    {
      headers: {
        'Authorization': `Bearer ${ZHIPU_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data.data[0].embedding;
}

/**
 * Procesa un batch de la cola de embeddings.
 * Retorna { procesados, errores }
 */
async function procesarBatch(limite = BATCH_SIZE) {
  console.log(`\n🔢 Obteniendo batch de ${limite} embeddings pendientes...`);
  const items = await obtenerBatchEmbeddings(limite);

  if (items.length === 0) {
    console.log('✅ Cola vacía - todos los embeddings están generados');
    return { procesados: 0, errores: 0 };
  }

  console.log(`   Procesando ${items.length} items...`);
  let procesados = 0;
  let errores = 0;

  // Procesar en chunks de EMBED_CONCURRENCY para no saturar la API
  for (let i = 0; i < items.length; i += EMBED_CONCURRENCY) {
    const chunk = items.slice(i, i + EMBED_CONCURRENCY);

    await Promise.all(chunk.map(async (item) => {
      try {
        const texto = item.entidad_tipo === 'norma'
          ? item.resumen
          : item.articulo_texto;

        if (!texto) {
          await marcarError(item.id, 'Texto vacío');
          errores++;
          return;
        }

        const vector = await generarEmbedding(texto);
        if (!vector) {
          await marcarError(item.id, 'Embedding null retornado');
          errores++;
          return;
        }

        await guardarEmbedding(item.id, item.entidad_tipo, item.entidad_id, item.campo_embedding, vector);
        procesados++;
        process.stdout.write('.');

      } catch (err) {
        await marcarError(item.id, err.message);
        errores++;
        process.stdout.write('✗');
      }
    }));

    // Pequeño delay entre chunks para respetar rate limits
    if (i + EMBED_CONCURRENCY < items.length) {
      await new Promise(r => setTimeout(r, EMBED_DELAY_MS));
    }
  }

  console.log(`\n   ✅ Procesados: ${procesados} | ❌ Errores: ${errores}`);
  return { procesados, errores };
}

module.exports = { procesarBatch, generarEmbedding };
```

**Step 2: Agregar rama --embed al CLI**

En `scraper/index.js`, antes de `async function main()`, agregar:

```js
const { procesarBatch } = require('./embedder');
```

Y reemplazar la función `main()`:

```js
async function main() {
  const modoEmbed = args.includes('--embed');
  const batchSize = args.includes('--batch')
    ? parseInt(args[args.indexOf('--batch') + 1])
    : undefined;

  if (modoEmbed) {
    console.log('🔢 Modo: generación de embeddings');
    const { procesados } = await procesarBatch(batchSize);
    console.log(`\n🎉 Sesión de embeddings completada. Procesados: ${procesados}`);
    await pool.end();
    return;
  }

  // Modo scraping (comportamiento anterior)
  console.log('🚀 Normas GBA Scraper');
  console.log(`   Tipos: ${tiposArg.join(', ')}`);
  if (desdeAnio) console.log(`   Desde año: ${desdeAnio}`);
  if (maxPaginas) console.log(`   Máx páginas: ${maxPaginas}`);

  for (const tipo of tiposArg) {
    await scrapearTipo(tipo);
  }

  await pool.end();
  console.log('\n🎉 Scraping completado');
}
```

**Step 3: Test de embedding (una norma)**

Primero verificar que haya items en la cola:
```bash
node -e "
require('dotenv').config();
const { pool } = require('./scraper/db');
pool.query('SELECT COUNT(*) FROM cola_embeddings WHERE procesado_at IS NULL')
  .then(r => console.log('Pendientes:', r.rows[0].count))
  .finally(() => pool.end());
"
```

Procesar batch pequeño de prueba:
```bash
node scraper/index.js --embed --batch 5
```
Expected: procesa 5 embeddings, muestra puntos de progreso

**Step 4: Commit**

```bash
git add scraper/embedder.js scraper/index.js
git commit -m "feat: Zhipu embedder with batch sessions and queue-based processing"
```

---

## Task 8: MCP Server — setup base

**Files:**
- Modify: `mcp-server/index.js`
- Create: `mcp-server/db.js`

**Step 1: Implementar mcp-server/db.js (queries de lectura)**

```js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function buscarNormas({ query, tipo, anioDesde, anioHasta, vigencia, limit = 20 }) {
  const conditions = [];
  const params = [];
  let p = 1;

  if (query) {
    conditions.push(`fts_vector @@ websearch_to_tsquery('spanish', $${p++})`);
    params.push(query);
  }
  if (tipo) { conditions.push(`tipo = $${p++}`); params.push(tipo); }
  if (anioDesde) { conditions.push(`anio >= $${p++}`); params.push(anioDesde); }
  if (anioHasta) { conditions.push(`anio <= $${p++}`); params.push(anioHasta); }
  if (vigencia) { conditions.push(`vigencia = $${p++}`); params.push(vigencia); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const orderBy = query
    ? `ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('spanish', $1), 32) DESC`
    : 'ORDER BY anio DESC, numero DESC';

  params.push(limit);
  const sql = `
    SELECT id, tipo, numero, anio, resumen, vigencia, url_canonica,
           fecha_publicacion, area_tematica
    FROM normas ${where} ${orderBy} LIMIT $${p}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function buscarArticulos({ query, embedding, limit = 10 }) {
  if (embedding) {
    const vectorStr = `[${embedding.join(',')}]`;
    const { rows } = await pool.query(`
      SELECT a.id, a.numero_articulo, a.texto,
             n.tipo, n.numero as norma_numero, n.anio, n.url_canonica,
             1 - (a.embedding <=> $1::vector) as similaridad
      FROM articulos a
      JOIN normas n ON n.id = a.norma_id
      WHERE a.embedding IS NOT NULL
        AND (1 - (a.embedding <=> $1::vector)) > 0.6
      ORDER BY a.embedding <=> $1::vector
      LIMIT $2
    `, [vectorStr, limit]);
    return rows;
  }

  const { rows } = await pool.query(`
    SELECT a.id, a.numero_articulo, a.texto,
           n.tipo, n.numero as norma_numero, n.anio, n.url_canonica,
           ts_rank_cd(a.fts_vector, websearch_to_tsquery('spanish', $1)) as rank
    FROM articulos a
    JOIN normas n ON n.id = a.norma_id
    WHERE a.fts_vector @@ websearch_to_tsquery('spanish', $1)
    ORDER BY rank DESC
    LIMIT $2
  `, [query, limit]);
  return rows;
}

async function getNorma(id) {
  const { rows: normaRows } = await pool.query(
    `SELECT * FROM normas WHERE id = $1 OR (tipo::text || ' ' || numero::text) = $1`,
    [id]
  );
  if (!normaRows.length) return null;
  const norma = normaRows[0];

  const { rows: articulos } = await pool.query(
    'SELECT numero_articulo, orden, titulo, texto FROM articulos WHERE norma_id = $1 ORDER BY orden',
    [norma.id]
  );
  norma.articulos = articulos;
  return norma;
}

async function getRelaciones(normaId) {
  const { rows } = await pool.query(`
    SELECT
      'saliente' as direccion, r.tipo_relacion,
      COALESCE(nd.tipo::text, r.destino_tipo::text) as norma_tipo,
      COALESCE(nd.numero, r.destino_numero) as norma_numero,
      COALESCE(nd.anio, r.destino_anio) as norma_anio,
      nd.resumen, r.detalle
    FROM relaciones_normativas r
    LEFT JOIN normas nd ON nd.id = r.norma_destino_id
    WHERE r.norma_origen_id = $1
    UNION ALL
    SELECT
      'entrante' as direccion, r.tipo_relacion,
      no2.tipo::text, no2.numero, no2.anio, no2.resumen, r.detalle
    FROM relaciones_normativas r
    JOIN normas no2 ON no2.id = r.norma_origen_id
    WHERE r.norma_destino_id = $1
  `, [normaId]);
  return rows;
}

async function similarNormas({ embedding, limit = 10 }) {
  const vectorStr = `[${embedding.join(',')}]`;
  const { rows } = await pool.query(`
    SELECT id, tipo, numero, anio, resumen, url_canonica,
           1 - (embedding_resumen <=> $1::vector) as similaridad
    FROM normas
    WHERE embedding_resumen IS NOT NULL
      AND (1 - (embedding_resumen <=> $1::vector)) > 0.6
    ORDER BY embedding_resumen <=> $1::vector
    LIMIT $2
  `, [vectorStr, limit]);
  return rows;
}

async function getStats() {
  const { rows: porTipo } = await pool.query(
    'SELECT tipo, COUNT(*) as total FROM normas GROUP BY tipo ORDER BY total DESC'
  );
  const { rows: porEstado } = await pool.query(
    'SELECT estado, COUNT(*) as total FROM normas GROUP BY estado'
  );
  const { rows: pendientes } = await pool.query(
    'SELECT COUNT(*) as total FROM cola_embeddings WHERE procesado_at IS NULL'
  );
  return { por_tipo: porTipo, por_estado: porEstado, embeddings_pendientes: pendientes[0].total };
}

module.exports = { buscarNormas, buscarArticulos, getNorma, getRelaciones, similarNormas, getStats, pool };
```

**Step 2: Implementar mcp-server/index.js**

```js
require('dotenv').config();
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const db = require('./db');

const server = new McpServer({
  name: 'normas-gba',
  version: '1.0.0',
});

// Tool: search_normas
server.tool('search_normas', {
  query: z.string().describe('Términos de búsqueda en español'),
  tipo: z.enum(['ley', 'decreto', 'decreto_ley']).optional().describe('Filtrar por tipo de norma'),
  anio_desde: z.number().optional().describe('Año mínimo de publicación'),
  anio_hasta: z.number().optional().describe('Año máximo de publicación'),
  vigencia: z.enum(['vigente', 'derogada', 'derogada_parcialmente', 'desconocido']).optional(),
  limit: z.number().default(20).describe('Cantidad máxima de resultados'),
}, async ({ query, tipo, anio_desde, anio_hasta, vigencia, limit }) => {
  const normas = await db.buscarNormas({ query, tipo, anioDesde: anio_desde, anioHasta: anio_hasta, vigencia, limit });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ total: normas.length, normas }, null, 2),
    }],
  };
});

// Tool: search_articulos
server.tool('search_articulos', {
  query: z.string().describe('Consulta para buscar en el articulado de las normas'),
  limit: z.number().default(10),
}, async ({ query, limit }) => {
  const articulos = await db.buscarArticulos({ query, limit });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ total: articulos.length, articulos }, null, 2),
    }],
  };
});

// Tool: get_norma
server.tool('get_norma', {
  id: z.string().describe('UUID o identificador de la norma (ej: "ley 15610")'),
}, async ({ id }) => {
  const norma = await db.getNorma(id);
  if (!norma) return { content: [{ type: 'text', text: 'Norma no encontrada' }] };
  return {
    content: [{ type: 'text', text: JSON.stringify(norma, null, 2) }],
  };
});

// Tool: get_references
server.tool('get_references', {
  norma_id: z.string().describe('UUID de la norma'),
}, async ({ norma_id }) => {
  const relaciones = await db.getRelaciones(norma_id);
  return {
    content: [{ type: 'text', text: JSON.stringify({ relaciones }, null, 2) }],
  };
});

// Tool: get_stats
server.tool('get_stats', {}, async () => {
  const stats = await db.getStats();
  return {
    content: [{ type: 'text', text: JSON.stringify(stats, null, 2) }],
  };
});

// Tool: health_check
server.tool('health_check', {}, async () => {
  try {
    await db.pool.query('SELECT 1');
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'ok', db: 'connected' }) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'error', error: e.message }) }] };
  }
});

// Iniciar servidor
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ MCP Server normas-gba iniciado');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
```

**Step 3: Instalar zod (requerido por MCP SDK)**

```bash
npm install zod
```

**Step 4: Verificar que el servidor inicia**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node mcp-server/index.js
```
Expected: respuesta JSON con lista de 5 tools

**Step 5: Commit**

```bash
git add mcp-server/
git commit -m "feat: MCP server with search_normas, search_articulos, get_norma, get_references, get_stats tools"
```

---

## Task 9: Configurar MCP en Claude Desktop

**Files:**
- Modify: `%APPDATA%\Claude\claude_desktop_config.json`

**Step 1: Obtener ruta absoluta del proyecto**

```bash
pwd
```
Anota la ruta completa (ej: `C:/Users/Adria/Documents/code/pba`)

**Step 2: Editar claude_desktop_config.json**

Agregar a la sección `mcpServers`:

```json
{
  "mcpServers": {
    "normas-gba": {
      "command": "node",
      "args": ["C:/Users/Adria/Documents/code/pba/mcp-server/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://adrian:!DarthHobbit%25@thecodersteam.com:5432/pba_normas",
        "ZHIPU_API_KEY": "<api_key_aqui>"
      }
    }
  }
}
```

**Step 3: Reiniciar Claude Desktop**

Cerrar y volver a abrir Claude Desktop.

**Step 4: Verificar en Claude Desktop**

En una conversación con Claude, probar:
> "Usá el tool health_check del MCP normas-gba"

Expected: `{ status: 'ok', db: 'connected' }`

**Step 5: Commit final**

```bash
git add .
git commit -m "chore: project complete - scraper + MCP server for normas GBA"
```

---

## Resumen de comandos de operación

```bash
# Scrape completo (Leyes + Decretos, todas las páginas)
node scraper/index.js

# Scrape solo leyes desde 2020
node scraper/index.js --tipo ley --desde 2020

# Scrape rápido (solo listing, sin detalle)
node scraper/index.js --max-paginas 5 --solo-listing

# Generar embeddings (sesión de 500)
node scraper/index.js --embed --batch 500

# Ver estadísticas de la BD
node -e "require('dotenv').config(); const {pool,getStats} = require('./mcp-server/db'); getStats().then(s => { console.log(JSON.stringify(s,null,2)); pool.end(); });"

# Iniciar MCP server manualmente
node mcp-server/index.js
```
