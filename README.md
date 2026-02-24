# normas-gba

Scraper, embedder y servidor MCP para el Sistema de Información Normativa de la Provincia de Buenos Aires ([normas.gba.gob.ar](https://normas.gba.gob.ar)).

Descarga leyes, decretos y demás normas bonaerenses, genera embeddings vectoriales y los expone vía protocolo MCP para uso en editores de código con IA.

---

## Requisitos

- Node.js v18+
- PostgreSQL 17 con extensión `pgvector` (halfvec)
- Claves de API: OpenAI (embeddings) y Zhipu (clasificación temática)

---

## Variables de entorno (`.env`)

```env
DATABASE_URL=postgresql://usuario:contraseña@host:5432/pba_normas
OPENAI_API_KEY=sk-...
ZHIPU_API_KEY=...
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4   # opcional

SCRAPER_DELAY_MS=500        # delay entre requests HTTP (default: 500)
EMBED_BATCH_SIZE=50         # items por ciclo del embedder (default: 50)
EMBED_DELAY_MS=200          # delay entre batches (default: 200)
EMBED_POLL_INTERVAL=30000   # espera con cola vacía en ms (default: 30000)
CLASIFICAR=0                # '0' deshabilita clasificación en el embedder
CLASSIFY_DELAY_MS=2000      # delay entre llamadas del clasificador (default: 2000)
```

---

## Flujo general

```
scraper/index.js  →  scraper/crawler.js  →  scraper/parser.js  →  scraper/db.js
                                                                        ↓
                                                               cola_embeddings
                                                                        ↓
                                                           scraper/embedder.js  →  OpenAI
                                                                        ↓
                                                         scraper/clasificador.js  →  Zhipu
                                                                        ↓
                                                           mcp-server/index.js
```

---

## Archivos del proyecto

### `scraper/index.js` — Orquestador principal

Scrapa el sitio mes a mes desde el año 2000 hasta hoy. Si un mes tiene más de 200 normas (tope del sitio), divide automáticamente en semanas. Procesa listings, detalles, textos actualizados y relaciones normativas.

**Argumentos:**

| Argumento | Descripción | Default |
|---|---|---|
| `--tipo TYPE` | Tipo de norma a scrapear | todos los tipos |
| `--desde-fecha YYYY-MM` | Mes de inicio | `2000-01` |
| `--hasta-fecha YYYY-MM` | Mes de fin | mes actual |

**Tipos válidos:** `ley`, `decreto`, `decreto_ley`, `ordenanza_general`, `resolucion`, `disposicion`, `resolucion_conjunta`

```bash
# Scrapear todo desde 2000
node scraper/index.js

# Solo leyes del año 2024
node scraper/index.js --tipo ley --desde-fecha 2024-01 --hasta-fecha 2024-12

# Solo decretos desde julio 2002
node scraper/index.js --tipo decreto --desde-fecha 2002-07

# Con PM2 en VPS (no reiniciar al terminar)
pm2 start scraper/index.js --name decreto --no-autorestart -- --tipo decreto --desde-fecha 2000-01
```

---

### `scraper/embedder.js` — Generador de embeddings

Loop continuo que consume la cola `cola_embeddings`. Por cada item genera un vector con OpenAI `text-embedding-3-large` (2048 dims). Si `CLASIFICAR=1`, también clasifica normas temáticamente con Zhipu `glm-4-flash`. Maneja rate limits con retry y backoff exponencial. Se apaga gracefully con SIGINT/SIGTERM (termina el batch actual antes de salir).

**Sin argumentos CLI.** Toda la configuración es por variables de entorno.

```bash
# Iniciar embedder (loop indefinido)
node scraper/embedder.js

# Sin clasificación (más rápido durante scraping masivo)
CLASIFICAR=0 node scraper/embedder.js

# Con PM2
pm2 start scraper/embedder.js --name embedder
```

**Variables relevantes:**

| Variable | Default | Descripción |
|---|---|---|
| `EMBED_BATCH_SIZE` | `50` | Items por ciclo de la cola |
| `MAX_ITEMS_API` | `100` | Máx. textos por request a OpenAI |
| `MAX_TEXTO_CHARS` | `6000` | Truncado de texto antes de embeddear |
| `CLASIFICAR` | `1` | `0` para deshabilitar clasificación |

---

### `scraper/clasificador.js` — Clasificador diferido

Asigna categorías temáticas a normas que ya tienen resumen pero no tienen `area_tematica`. Diseñado para correr por separado del embedder, con rate limiting conservador (~30 RPM por defecto). **Reanudable:** si se interrumpe, retoma desde donde quedó.

**Sin argumentos CLI.**

```bash
# Iniciar clasificador
node scraper/clasificador.js

# Más agresivo (1s entre calls ≈ 60 RPM)
CLASSIFY_DELAY_MS=1000 node scraper/clasificador.js

# Con PM2
pm2 start scraper/clasificador.js --name clasificador
```

**Categorías temáticas disponibles:**
`administrativo`, `agropecuario`, `civil`, `derechos_sociales`, `educacion`, `empleo`, `medio_ambiente`, `municipal`, `obras_publicas`, `presupuesto`, `salud`, `seguridad`, `transporte`, `tributos`, `urbanismo`, `vivienda`

---

### `scraper/crawler.js` — Cliente HTTP (módulo interno)

Obtiene HTML del sitio con retry automático (3 intentos, backoff exponencial). No se ejecuta directamente.

**Exporta:**

| Función | Descripción |
|---|---|
| `fetchListingPage(tipo, pagina, { fechaDesde, fechaHasta })` | Listing paginado con filtros de fecha opcionales (formato `DD/MM/YYYY`) |
| `fetchDetalle(urlCanonica)` | Página de detalle de una norma |
| `fetchTextoActualizado(urlDocumento)` | Texto vigente de una norma |
| `delay(ms)` | Promesa de espera |
| `DELAY_MS` | Valor de delay configurado |
| `BASE_URL` | URL base del sitio |

---

### `scraper/parser.js` — Parser HTML (módulo interno)

Parsea HTML con jsdom. No se ejecuta directamente.

**Exporta:**

| Función | Retorna |
|---|---|
| `parseListingPage(html)` | Array de normas básicas del listing |
| `parseDetallePage(html, urlCanonica)` | Metadata + relaciones normativas |
| `parseTextoActualizado(html)` | Array de artículos con numeración y orden |
| `parseNormaUrl(url)` | `{ tipo, anio, numero, sitio_id }` |

---

### `scraper/db.js` — Capa de datos (módulo interno)

Upserts idempotentes con detección de cambios por SHA-256. No se ejecuta directamente.

**Exporta:**

| Función | Descripción |
|---|---|
| `pool` | Pool de conexiones PostgreSQL |
| `upsertNormaBasica(data)` | Inserta/actualiza norma desde listing |
| `upsertNormaDetalle(sitio_id, detalle)` | Completa metadata de norma |
| `upsertTextoActualizado(normaId, html, articulos)` | Actualiza texto y artículos |
| `upsertRelaciones(normaId, relaciones)` | Guarda relaciones normativas |
| `obtenerBatchEmbeddings(limite)` | Items pendientes de la cola |
| `guardarEmbedding(colaId, tipo, id, campo, vector)` | Guarda vector en DB |
| `guardarCategorias(normaId, categorias)` | Guarda `area_tematica` |
| `marcarError(colaId, mensaje)` | Incrementa contador de intentos fallidos |

---

### `mcp-server/index.js` — Servidor MCP

Servidor MCP (Model Context Protocol) vía stdio. Expone herramientas para consulta legislativa desde editores de código con IA (Cursor, VS Code con extensiones MCP, etc.).

**Sin argumentos CLI.**

```bash
node mcp-server/index.js
```

**Configuración en `.mcp.json` del proyecto:**
```json
{
  "mcpServers": {
    "normas-gba": {
      "command": "node",
      "args": ["/ruta/al/proyecto/mcp-server/index.js"]
    }
  }
}
```

**Herramientas disponibles:**

| Herramienta | Parámetros | Descripción |
|---|---|---|
| `buscar_normas_semantico` | `consulta`, `limit`, `anio_desde`, `anio_hasta` | Búsqueda vectorial por significado |
| `buscar_normas_texto` | `terminos`, `limit`, `tipo`, `anio_desde`, `anio_hasta` | Full-text search |
| `obtener_norma` | `id` | Detalle completo de una norma |
| `buscar_articulos` | `consulta`, `norma_id`, `limit` | Búsqueda vectorial en artículos |
| `encontrar_adhesiones` | `tema`, `limit` | Normas municipales que adhieren a una ley provincial |

---

## Scripts de base de datos (`db/`)

### `db/apply-schema.js` — Crear tablas

Aplica `db/schema.sql` en una transacción. Crea todas las tablas, extensiones pgvector e índices HNSW. Idempotente (`IF NOT EXISTS`).

```bash
node db/apply-schema.js
```

---

### `db/reset-tables.js` — Limpiar todo

`TRUNCATE CASCADE` de todas las tablas en orden correcto respetando foreign keys. Usar solo para resetear la base de datos completa.

```bash
node db/reset-tables.js
```

---

### `db/reset-embeddings.js` — Resetear vectores

Limpia todos los embeddings (`embedding_resumen`, `embedding`) y resetea `cola_embeddings` para regenerar con un nuevo modelo. No borra normas ni artículos.

```bash
node db/reset-embeddings.js
```

---

### `db/seed-jerarquia.js` — Asignar jerarquía normativa

Asigna `rango_normativo` según tipo de norma e identifica los 10 códigos provinciales conocidos (Código Fiscal, Código Rural, LOM, etc.). Idempotente.

```bash
node db/seed-jerarquia.js
```

**Jerarquía normativa:**

| Rango | Tipos |
|---|---|
| 1 | Constitución Provincial |
| 2 | Códigos Provinciales |
| 3 | Ley, Decreto-Ley |
| 4 | Decreto |
| 5 | Resolución, Disposición, Resolución Conjunta |
| 6 | Ordenanza General |

---

## Tests

```bash
npm test
```

Corre Jest sobre `tests/scraper/parser.test.js` — 6 tests unitarios que verifican el parsing HTML de listings, detalles y artículos.

---

## Estado de cobertura

Usar `/normasporcentaje` en Claude Code para ver en tiempo real el porcentaje scrapeado y de embeddings por tipo de norma.
