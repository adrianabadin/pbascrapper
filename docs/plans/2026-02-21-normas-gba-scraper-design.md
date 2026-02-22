# Diseño: Scraper + MCP Server - Normas Provincia de Buenos Aires

## Contexto

Sistema para indexar la normativa pública de la Provincia de Buenos Aires disponible en
[normas.gba.gob.ar](https://normas.gba.gob.ar), exponiendo un servidor MCP que permite a
Claude buscar leyes y decretos por texto, semántica y relaciones normativas.

Basado en el patrón del MCP de ordenanzas-saladillo, adaptado para escala provincial.

---

## Decisiones de diseño

| Dimensión | Decisión |
|-----------|----------|
| Scope | Leyes + Decretos (~25-35K documentos) |
| Actualización | Manual (CLI) — sin cron |
| Infraestructura | Scraper/MCP en Windows local; PostgreSQL en Docker remoto (`thecodersteam.com:5432`) |
| AI / Embeddings | Zhipu GLM-4.7 Flash + embedding-3 (2048 dims) via `https://open.bigmodel.cn/api/paas/v4/` |
| Arquitectura | Enfoque A: CLI scraper separado del MCP server |
| Stack | Node.js v20 + jsdom + axios + pg + @modelcontextprotocol/sdk |
| BD | PostgreSQL 17.2 + pgvector 0.8.1 + pg_trgm — base `pba_normas` |

---

## Arquitectura

```
normas-gba-mcp/
├── scraper/
│   ├── index.js          # CLI: node scraper [--tipo ley|decreto] [--desde 2020]
│   ├── crawler.js        # Paginación + HTTP con rate limiting (axios)
│   ├── parser.js         # jsdom: extrae metadata + artículos del HTML
│   ├── embedder.js       # Zhipu embedding-3 en batches, sessions-aware
│   ├── classifier.js     # GLM-4.7 Flash: infiere area_tematica del resumen
│   └── db.js             # Upsert en PostgreSQL (idempotente)
├── mcp-server/
│   ├── index.js          # Entry point MCP
│   └── tools/
│       ├── search.js
│       ├── get-norma.js
│       ├── get-references.js
│       ├── similar.js
│       └── stats.js
├── db/
│   └── schema.sql
├── .env
└── package.json
```

### Flujo de datos

```
FASE 1 — Scraping (rápido, sin API externa):
  node scraper/index.js --tipo ley
  → Pagina /resultados?q[terms][raw_type]=Law&page=N
  → Por cada norma: GET /ar-b/ley/{anio}/{numero}/{id}
  → GET /documentos/{hash}.html (texto actualizado)
  → jsdom parsea artículos individuales
  → SHA-256(html) → detecta cambios vs scrape anterior
  → Upsert en normas + articulos + relaciones_normativas
  → Estado: pendiente → texto_extraido

FASE 2 — Embeddings (sessions, quota-aware):
  node scraper/index.js --embed --batch 500
  → Lee cola_embeddings ORDER BY prioridad
  → Llama Zhipu embedding-3 en batches de 10
  → Guarda vector(2048) en normas.embedding_resumen / articulos.embedding
  → Estado: texto_extraido → embeddings_generados

FASE 3 — Clasificación temática (opcional):
  node scraper/index.js --classify --batch 100
  → Llama GLM-4.7 Flash con el resumen
  → Guarda array en normas.area_tematica
```

---

## Modelo de datos

### Tabla `normas`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | uuid PK | |
| tipo | enum(ley, decreto, decreto_ley, ...) | |
| numero | integer | Ej: 15610 |
| anio | smallint | Ej: 2026 |
| sitio_id | integer UNIQUE | ID interno del sitio |
| url_canonica | text | `/ar-b/ley/2026/15610/559753` |
| url_texto_actualizado | text | `/documentos/VmeMWQTl.html` |
| texto_actualizado_hash | text | SHA-256 del HTML — detecta cambios |
| fecha_promulgacion | date | |
| fecha_publicacion | date | |
| boletin_oficial_nro | text | |
| resumen | text | Texto del sitio |
| observaciones | text | |
| vigencia | enum | `vigente` / `derogada` / `derogada_parcialmente` / `desconocido` |
| estado | enum | `pendiente→scrapeado→texto_extraido→embeddings_generados` |
| area_tematica | text[] | Clasificado por GLM-4.7 Flash |
| embedding_resumen | vector(2048) | Zhipu embedding-3 del resumen |
| fts_vector | tsvector | Generado por trigger automático |
| texto_completo | text | Articulado completo concatenado |

### Tabla `articulos`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| id | uuid PK | |
| norma_id | uuid FK | |
| numero_articulo | text | "Art. 1°", "Art. 2 bis" |
| orden | smallint | Para ordenamiento secuencial |
| texto | text | Contenido completo |
| embedding | vector(2048) | Zhipu embedding-3 por artículo |
| fts_vector | tsvector | FTS por artículo |

### Tabla `relaciones_normativas`

Grafo dirigido tipado: `norma_origen --[tipo]--> norma_destino`

Tipos: `modifica`, `deroga`, `deroga_parcialmente`, `reglamenta`, `complementa`, `prorroga`, `sustituye`, `cita`

`norma_destino_id` nullable — trigger auto-resuelve referencias huérfanas al insertar la norma faltante.

### Tablas de operación

- **`cola_embeddings`** — queue persistente; permite sesiones múltiples con `--batch N`
- **`historial_cambios`** — SHA-256 anterior vs nuevo; auditoría de actualizaciones

---

## Estrategia de embeddings (2 niveles)

| Nivel | Input | Vector | Uso |
|-------|-------|--------|-----|
| Resumen | Campo resumen (~2-3 oraciones) | 1 por norma | Búsqueda general de qué trata la norma |
| Artículo | Texto de cada artículo | N por norma (~10 prom.) | Búsqueda granular de contenido específico |

**No** se embeddea el texto completo (demasiado largo para el modelo) ni los fundamentos (v1).

**Sesiones**: el scraper puede interrumpirse y continuar. La `cola_embeddings` persiste en PostgreSQL. Cada ejecución con `--embed --batch 500` procesa 500 items y termina.

---

## MCP Server — Tools expuestos

| Tool | Descripción |
|------|-------------|
| `search_normas` | Full-text search en resumen + articulado. Filtros: tipo, año, vigencia |
| `search_articulos` | Búsqueda semántica en artículos individuales — devuelve el artículo exacto |
| `get_norma` | Detalle completo: metadata + artículos + relaciones |
| `get_references` | Árbol de relaciones normativas (qué modifica, qué la modifica) |
| `similar_normas` | Normas semánticamente similares por cosine similarity |
| `search_by_type` | Listar normas filtrando por tipo + año |
| `get_stats` | Estadísticas: total por tipo, por año, estado de embeddings |
| `health_check` | Estado del servidor y la BD |

---

## Diseño del scraper (jsdom)

### URL patterns

```
Listing Leyes:   /resultados?q[terms][raw_type]=Law&page=N&q[sort]=by_publication_date_desc
Listing Decretos:/resultados?q[terms][raw_type]=Decree&page=N&q[sort]=by_publication_date_desc
Detalle:         /ar-b/ley/{anio}/{numero}/{sitio_id}
Texto actualizado: /documentos/{hash}.html
```

### Extracción con jsdom

**Del listing** (10 normas por página, ~1400 páginas para Leyes):
```js
// Título + URL
heading[level=3] > link → título, href → url_canonica
// Resumen
blockquote → resumen
// Fechas
paragraph[0] → fecha_publicacion
paragraph[1] → ultima_actualizacion
```

**Del detalle** de cada norma:
```js
// Metadata
paragraph: "Fecha de promulgación: DD/MM/YYYY"
paragraph: "Número de Boletín Oficial: NNNNN"
// Documentos
link[href*="/documentos/"][text="Ver texto actualizado"] → url_texto_actualizado
// Relaciones normativas
table rows → tipo_relacion + norma_referenciada + fecha + resumen
```

**Del texto actualizado** (HTML plano con artículos):
```js
// Artículos: párrafos con <strong>ARTÍCULO N°.-</strong>
p > strong[text^="ARTÍCULO"] → numero_articulo
p.textContent → texto_articulo
```

### Rate limiting

- Delay de 500ms entre requests al sitio
- Concurrencia máxima: 3 requests paralelos
- Retry automático con backoff exponencial (3 intentos)
- Logging de progreso: página actual / total, normas procesadas

---

## Infraestructura

| Componente | Detalle |
|-----------|---------|
| PostgreSQL | Docker `postgre-db-1` en `thecodersteam.com:5432`, base `pba_normas` |
| pgvector | 0.8.1 instalado ✅ |
| pg_trgm | 1.6 instalado ✅ |
| Node.js | v20.10.0 en Windows local |
| Zhipu API | `https://open.bigmodel.cn/api/paas/v4/` — embedding-3 (2048 dims) + GLM-4.7 Flash |

---

## Consideraciones legales (LegalAdvisor)

- La vigencia es multivalorada: `vigente`, `vigente_con_modificaciones`, `derogada`, `derogada_parcialmente`, `suspendida`
- Jerarquía normativa: Ley (1) > Decreto-ley (2) > Decreto (3) > Resolución (4) > ...
- Las relaciones normativas tipificadas permiten construir el grafo de vigencia
- Chunking por artículo respeta la unidad mínima de significado jurídico

---

## Lo que NO incluye v1

- Fundamentos (exposición de motivos) — se puede agregar en v2
- Anexos con tablas/PDFs — complejidad alta, bajo valor semántico
- Resoluciones, Disposiciones, Ordenanzas generales — extensión futura
- Interfaz web / API REST — solo MCP
- Cron / actualización automática — manual por diseño
