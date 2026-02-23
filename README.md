# Normas GBA - Scraper + Embedder + MCP Server

Sistema completo para scrapear, procesar y exponer la normativa de la Provincia de Buenos Aires como herramientas MCP (Model Context Protocol), permitiendo que Claude u otros asistentes puedan hacer consultas legislativas en lenguaje natural.

## Descripción general

Este proyecto integra tres componentes principales:

1. **Scraper**: Descarga leyes, decretos, resoluciones y otras normas desde [normas.gba.gob.ar](https://normas.gba.gob.ar) con paginación mes a mes para superar límites de 200 resultados por query
2. **Embedder**: Genera embeddings semánticos con OpenAI `text-embedding-3-large` (2048 dimensiones) y clasifica automáticamente las normas en categorías temáticas con Zhipu
3. **MCP Server**: Expone 5 herramientas para consulta legislativa compatible con Claude y otros asistentes

El sistema está diseñado para asuntos legislativos prácticos: proponer ordenanzas municipales, analizar qué normas provinciales aplican a situaciones concretas, e identificar mecanismos de adhesión municipal en la legislación provincial.

Cobertura completa: **~568.426 normas** procesadas (leyes, decretos, resoluciones, disposiciones, ordenanzas generales, decreto-leyes y resoluciones conjuntas).

## Requisitos previos

- Node.js 18+
- PostgreSQL 17+ con extensiones `pgvector`, `uuid-ossp` y `pg_trgm`
- API key de OpenAI (para embeddings con `text-embedding-3-large`)
- API key de Zhipu AI (para clasificación automática y fallback)
- Acceso de lectura a https://normas.gba.gob.ar

## Instalación

```bash
# Clonar o descargar el proyecto
cd /ruta/a/pba

# Instalar dependencias
npm install

# Crear archivo .env (ver sección de Configuración)
cp .env.example .env
# Editar .env con tus credenciales reales
```

## Configuración

Crear un archivo `.env` en la raíz del proyecto con las variables requeridas:

```bash
# Base de datos PostgreSQL
DATABASE_URL=postgresql://usuario:contraseña@localhost:5432/normas_gba

# API OpenAI (para embeddings)
OPENAI_API_KEY=sk-proj-...

# API Zhipu AI (para clasificación automática)
ZHIPU_API_KEY=tu_api_key_aqui
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# Scraper - Paginación y delays
SCRAPER_DELAY_MS=500                    # Delay entre requests (respetar límites del servidor)

# Embedder
EMBED_BATCH_SIZE=50                     # Items procesados por ciclo
EMBED_DELAY_MS=200                      # Delay entre batches
EMBED_POLL_INTERVAL=30000               # Espera cuando la cola está vacía (ms)
MAX_ITEMS_API=100                       # Máximo items por request a OpenAI
MAX_TEXTO_CHARS=6000                    # Caracteres máximos por texto (~2000 tokens)
CLASIFICAR=1                            # 0 para deshabilitar clasificación automática durante scraping masivo

# Clasificador diferido
CLASSIFY_DELAY_MS=2000                  # Delay entre llamadas (~30 RPM)
CLASSIFY_BATCH_SIZE=100                 # Items procesados por ciclo
```

## Base de datos

Inicializar PostgreSQL con el schema:

```bash
# Conectar a PostgreSQL y ejecutar el schema
psql -U usuario -d normas_gba -f db/schema.sql

# (Opcional) Si ya existe la BD, aplicar migraciones de jerarquía normativa
node db/apply-schema.js
```

El schema incluye:
- Tabla `normas`: Información general con campos nuevos: `titulo`, `organismo`, `rango_normativo`, `nombre_codigo`
- Tabla `articulos`: Artículos individuales con embeddings
- Tabla `relaciones_normativas`: Relaciones entre normas (modifica, deroga, reglamenta, etc.)
- Tabla `cola_embeddings`: Cola de procesamiento para el embedder (generada automáticamente por triggers)
- Índices HNSW para búsqueda semántica y Full-Text Search en Spanish

### Nuevas columnas

- **`titulo`** (TEXT): Nombre canónico de la norma
- **`organismo`** (TEXT): Ministerio/organismo emisor para resoluciones y disposiciones (ej: "del Ministerio de Hábitat y Desarrollo Urbano")
- **`rango_normativo`** (smallint, default 5): Jerarquía normativa
  - 1 = Constitución Provincial
  - 2 = Código provincial
  - 3 = Ley / Decreto-Ley
  - 4 = Decreto
  - 5 = Resolución / Disposición / Resolución Conjunta
  - 6 = Ordenanza General
- **`nombre_codigo`** (TEXT): Nombre del código si es un código provincial (ej: "Código Fiscal")

### Migraciones incluidas

- `db/migrations/001_jerarquia_normativa.sql`: Agrega rango_normativo y nombre_codigo
- `db/migrations/002_titulo_organismo.sql`: Agrega titulo y organismo

### Scripts de utilidad

```bash
# Asignar rangos normativos a todas las normas
node db/seed-jerarquia.js

# Resetear todos los embeddings (para regenerar con nuevo modelo)
node db/reset-embeddings.js

# Truncate de todas las tablas (cuidado!)
node db/reset-tables.js
```

## Uso

### 1. Scraper - Descargar normas

```bash
# Scraping básico: todos los 7 tipos (ley, decreto, decreto_ley, ordenanza_general, resolucion, disposicion, resolucion_conjunta)
npm run scrape

# Scrapear un tipo específico
npm run scrape -- --tipo ley
npm run scrape -- --tipo decreto
npm run scrape -- --tipo resolucion
npm run scrape -- --tipo disposicion
npm run scrape -- --tipo ordenanza_general
npm run scrape -- --tipo decreto_ley
npm run scrape -- --tipo resolucion_conjunta

# Scrapear desde un mes específico (paginación mes a mes)
npm run scrape -- --desde-fecha 2020-01
npm run scrape -- --desde-fecha 2020-01 --hasta-fecha 2020-06

# Combinar filtros
npm run scrape -- --tipo ley --desde-fecha 2015-01 --max-paginas 5

# Solo obtener listing (sin scraping de detalle ni texto)
npm run scrape -- --solo-listing

# Scraping masivo sin clasificación automática (recomendado para volumen alto)
CLASIFICAR=0 npm run scrape
# Luego, ejecutar clasificador diferido después:
npm run classify
```

**Tipos de normas disponibles y cobertura total:**
- **Leyes**: ~13.942
- **Decreto-leyes**: ~2.479
- **Decretos**: ~185.905
- **Ordenanzas generales**: ~369
- **Resoluciones**: ~251.001
- **Disposiciones**: ~83.249
- **Resoluciones conjuntas**: ~31.481
- **TOTAL: ~568.426 normas**

**Argumentos CLI:**
- `--tipo`: Especificar un tipo (ley, decreto, etc.). Por defecto corre los 7 tipos en orden.
- `--desde-fecha YYYY-MM`: Mes desde el cual comenzar (default: 2000-01). Reemplaza antiguo `--desde YYYY`.
- `--hasta-fecha YYYY-MM`: Mes hasta el cual scrapear (default: mes actual).
- `--solo-listing`: Solo obtener listing sin scraping de detalle.
- `--max-paginas N`: Máximo número de páginas a procesar (para pruebas rápidas).

**Cómo funciona la paginación:**

El sitio normas.gba.gob.ar limita a 20 páginas (200 resultados) por query. El scraper implementa:
1. **Paginación mes a mes**: Divide automáticamente por rango de fechas mes a mes usando `q[date_ranges][publication_date][gte/lte]`
2. **Fallback semanal**: Si un mes supera 200 normas, divide automáticamente en 4 semanas (01-07, 08-14, 15-21, 22-fin), recuperando hasta 800 normas/mes
3. Cada norma pasa por tres fases: upsert básico → página de detalle → extracción de artículos y relaciones normativas

**Campos guardados nuevos:**
- `titulo`: Nombre canónico de la norma
- `organismo`: Ministerio emisor (solo para resoluciones/disposiciones)
- `rango_normativo`: Jerarquía normativa (asignado por seed-jerarquia.js)

### 2. Embedder - Generar embeddings y clasificar

```bash
# Procesar la cola de embeddings (embeddings + clasificación automática)
npm run embed
```

El embedder:
- Consume la tabla `cola_embeddings` (generada automáticamente por triggers del scraper)
- Genera vectores semánticos con modelo **OpenAI `text-embedding-3-large`** (2048 dimensiones)
- Clasifica automáticamente cada norma en categorías temáticas con Zhipu `glm-4.7-flash`
- Implementa reintentos automáticos para rate limiting (429) y errores de red
- Procesa en batches configurables (50 items por defecto), permitiendo Ctrl+C para terminar limpiamente
- Soporta pausar/resumir automáticamente cuando la cola está vacía

**Categorías temáticas** (clasificación automática):
- urbanismo
- medio_ambiente
- salud
- educacion
- tributos
- seguridad
- obras_publicas
- empleo
- municipal
- civil
- administrativo
- transporte
- vivienda
- agropecuario
- derechos_sociales
- presupuesto

**Para scraping masivo (recomendado):**
1. Scrapear con `CLASIFICAR=0` (desabilita clasificación automática)
2. Regenerar embeddings: `node db/reset-embeddings.js`
3. Ejecutar embedder: `npm run embed`
4. Ejecutar clasificador diferido: `npm run classify`

### 3. Clasificador diferido

```bash
# Clasificar normas sin area_tematica (después de scraping masivo)
npm run classify
```

El clasificador diferido:
- Procesa normas que aún no tienen `area_tematica` asignada
- Rate limiting conservador: 2000ms entre llamadas (~30 RPM)
- Reanudable: saltea normas ya clasificadas
- Muestra progreso y tiempo estimado restante
- Variables configurables: `CLASSIFY_DELAY_MS`, `CLASSIFY_BATCH_SIZE`

### 4. MCP Server - Exponer herramientas a Claude

```bash
# Iniciar el servidor MCP
npm run mcp
```

El servidor MCP se comunica por stdin/stdout y expone 5 herramientas que Claude puede usar automáticamente.

#### Configurar en editores (VSCode, Cursor, etc.)

En `.claude/config.json` o similar:

```json
{
  "mcpServers": {
    "normas-gba": {
      "command": "node",
      "args": ["/ruta/completa/a/pba/mcp-server/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://...",
        "OPENAI_API_KEY": "...",
        "ZHIPU_API_KEY": "..."
      }
    }
  }
}
```

En Cursor, usar la pestaña "MCP" en la sidebar.

## Herramientas MCP

El servidor expone 5 herramientas para Claude:

### 1. `buscar_normas` - Búsqueda semántica de normas

Busca normas por descripción en lenguaje natural, combinando embeddings con filtros opcionales.

**Parámetros:**
- `consulta` (string, requerido): Descripción de la situación o tema
- `tipo` (enum): `ley` | `decreto` | `decreto_ley` | `resolucion` | `disposicion` | `ordenanza_general` | `resolucion_conjunta`
- `anio_desde` (number): Año mínimo (1820-2100)
- `anio_hasta` (number): Año máximo
- `categorias` (array): Filtrar por categorías (ej: `["urbanismo", "medio_ambiente"]`)
- `solo_vigentes` (boolean): Excluir normas derogadas
- `limit` (number): 1-20 (default: 10)

**Ejemplo de uso en Claude:**
```
¿Qué leyes regulan la construcción de viviendas multifamiliares?
¿Hay normas sobre eficiencia energética en edificios?
¿Cuáles son las normas de seguridad en works públicas desde 2010?
```

### 2. `buscar_articulos` - Búsqueda de artículos específicos

Busca artículos individuales dentro de normas, devolviendo el texto exacto del artículo y la norma que lo contiene.

**Parámetros:**
- `consulta` (string, requerido): Descripción de lo que debe decir el artículo
- `tipo_norma` (enum, opcional): Limitar a un tipo específico
- `limit` (number): 1-20 (default: 10)

**Ejemplo de uso en Claude:**
```
¿Qué artículo habla sobre los plazos de respuesta para reclamos?
¿Cuál es el artículo que establece multas por incumplimiento?
¿Qué norma dice que los municipios pueden adherir?
```

### 3. `encontrar_adhesiones` - Mecanismos de adhesión municipal

Busca artículos con mecanismos que permitan a los municipios adherir o actuar mediante ordenanza local.

**Parámetros:**
- `tema` (string, requerido): Tema sobre el que se busca adhesión (ej: "eficiencia energética")
- `limit` (number): 1-20 (default: 10)

**Ejemplo de uso en Claude:**
```
¿Qué ley provincial permite que los municipios adhieran a programas de residuos?
¿Hay mecanismos de adhesión para normativas de agua potable?
¿Qué leyes habilitan a los intendentes a dictar ordenanzas sobre urbanismo?
```

Busca frases como:
- "los municipios podrán adherir"
- "el intendente queda facultado"
- "mediante ordenanza municipal"
- "podrán adherirse al presente régimen"

### 4. `obtener_norma` - Obtener norma completa

Devuelve el texto completo de una norma con todos sus artículos.

**Parámetros:**
- `tipo` (enum, requerido): Tipo de la norma
- `numero` (number, requerido): Número de la norma
- `anio` (number, requerido): Año de sanción (1820-2100)

**Ejemplo de respuesta:**
```json
{
  "id": "uuid",
  "tipo": "ley",
  "numero": 11723,
  "anio": 1995,
  "vigencia": "vigente",
  "area_tematica": ["urbanismo", "medio_ambiente"],
  "resumen": "...",
  "total_articulos": 45,
  "articulos": [
    {
      "numero": "1",
      "titulo": "Objeto",
      "texto": "..."
    }
  ]
}
```

### 5. `obtener_relaciones` - Árbol de relaciones normativas

Devuelve qué normas modifica/deroga esta norma, y cuáles la modifican/derogan a ella.

**Parámetros:**
- `tipo` (enum, requerido)
- `numero` (number, requerido)
- `anio` (number, requerido)

**Tipos de relaciones:**
- `modifica`: La norma A modifica artículos específicos de la norma B
- `deroga`: La norma A deroga completamente la norma B
- `deroga_parcialmente`: Deroga solo algunos artículos
- `reglamenta`: La norma A reglamento la implementación de la norma B
- `complementa`: Complementa o amplía la norma B
- `prorroga`: Prórroga plazos de la norma B
- `sustituye`: Sustituye completamente a la norma B
- `cita`: Hace referencia a la norma B
- `otra`: Otra relación no clasificada

## Flujo de trabajo legislativo

### Caso de uso: Proponer una ordenanza municipal

1. **Identificar el tema** ("gestión de residuos sólidos", "eficiencia energética", etc.)

2. **Buscar normas provinciales aplicables**:
   - Usar `buscar_normas` para encontrar leyes y decretos relacionados
   - Leer el resumen y categoría temática de cada resultado

3. **Encontrar mecanismo de adhesión**:
   - Usar `encontrar_adhesiones` con el tema
   - Identificar qué ley provincial permite que el municipio actúe mediante ordenanza

4. **Obtener texto completo de la norma base**:
   - Usar `obtener_norma` para obtener todos los artículos
   - Analizar qué requisitos impone la ley provincial

5. **Verificar vigencia y modificaciones**:
   - Usar `obtener_relaciones` para asegurar que la norma no está derogada
   - Identificar si hay normas más recientes que la completen

6. **Redactar la ordenanza municipal**:
   - Basarse en el texto provincial
   - Adaptar a la realidad local
   - Asegurar coherencia con la normativa superior
   - Usar Claude + ambos MCPs (GBA y Saladillo) para validar propuesta

### Workflow para producción (scraping masivo)

Cuando se requiere procesar todas las ~568.426 normas o una porción significativa:

```bash
# 1. Scraping masivo sin clasificación automática
CLASIFICAR=0 npm run scrape

# 2. Resetear embeddings para regenerar con nuevo modelo OpenAI
node db/reset-embeddings.js

# 3. Generar embeddings con OpenAI text-embedding-3-large
npm run embed

# 4. Clasificar normas diferidamente (después de embeddings)
npm run classify

# 5. Opcionalmente, asignar rangos normativos si es primera vez
node db/seed-jerarquia.js
```

Este flujo optimiza costos evitando clasificaciones fallidas durante el scraping inicial.

### Ejemplo concreto

Proponer una ordenanza municipal sobre "paneles solares en viviendas":

```
Claude + MCP GBA:
1. Buscar: "regulación de energía renovable paneles solares"
2. Encontrar adhesiones: "energía renovable"
3. Obtener texto completo: ley 14.146/2010 (ley de energías renovables)
4. Verificar vigencia: obtener_relaciones

Claude + MCP Saladillo (ordenanzas locales):
5. Buscar ordenanzas anteriores sobre construcción, licencias
6. Validar que no entren en conflicto

Resultado:
→ Redactar nueva ordenanza municipal sobre paneles solares,
  respaldada por la ley provincial y sin conflictos con ordenanzas locales
```

## Estructura del proyecto

```
pba/
├── README.md                        # Este archivo
├── package.json
├── .env.example                     # Template de variables de entorno
├── db/
│   ├── schema.sql                   # Schema PostgreSQL con todas las tablas
│   ├── apply-schema.js              # Aplicar schema a BD existente
│   ├── reset-tables.js              # Truncate CASCADE de todas las tablas
│   ├── reset-embeddings.js          # NUEVO: resetear embeddings
│   ├── seed-jerarquia.js            # NUEVO: asignar rango_normativo
│   └── migrations/
│       ├── 001_jerarquia_normativa.sql    # NUEVO
│       └── 002_titulo_organismo.sql       # NUEVO
├── scraper/
│   ├── index.js                     # CLI principal del scraper
│   ├── crawler.js                   # Funciones HTTP y parsing HTML
│   ├── parser.js                    # Parsing de listings y páginas de detalle
│   ├── db.js                        # Operaciones sobre la BD
│   ├── embedder.js                  # Procesador de embeddings y clasificación
│   └── clasificador.js              # NUEVO: clasificador diferido
├── mcp-server/
│   └── index.js                     # Servidor MCP con 5 herramientas
└── tests/
    └── *.test.js                    # Tests unitarios con Jest
```

## Desarrollo

### Ejecutar tests

```bash
npm test
```

### Ver logs del scraper

El scraper imprime el progreso en tiempo real:

```
🔍 Scrapeando LEY (desde 2024-01)...
   Total: 13942 normas, paginación mes a mes + fallback semanal
📄 Mes 2024-01...
  → Semana 01-07: 25 normas procesadas
  → Semana 08-14: 18 normas procesadas
  → Semana 15-21: 22 normas procesadas
  → Semana 22-31: 35 normas procesadas
  [Total mes 2024-01: 100 normas ✓]
```

### Ver logs del embedder

El embedder muestra estadísticas por batch:

```
[10:23:45] Batch #1: 50 items
  → Normas (embedding + clasificación): 40
  → Artículos (embedding): 10
  [sub-batch 1] 16 textos, 8234 chars... OK (2456 tokens OpenAI)
  [sub-batch 2] 16 textos, 7891 chars... OK (2187 tokens OpenAI)
  → Embeddings: 50/50 guardados, 0 errores, 4643 tokens, 3.2s
  → Clasificados: 40/40 normas, 12.5s
  Acumulado: 15234 embeddings, 12456 clasificaciones, 125432 tokens OpenAI
```

## Limitaciones y consideraciones

### Alcance de datos

- El scraper descarga solo normas disponibles en normas.gba.gob.ar
- No incluye sentencias judiciales, fallos, o normativa anterior a 1820
- El sitio web puede cambiar su estructura, requiriendo actualización del parser
- La paginación mes a mes y fallback semanal garantizan cobertura completa

### Costos de API

**Embeddings:**
- OpenAI `text-embedding-3-large`: ~$0.13 USD por 1M tokens (2048 dimensiones)
- Procesamiento de ~568.426 normas + 2M artículos: estimado ~$15-25 USD

**Clasificación:**
- Zhipu `glm-4.7-flash`: ~$0.001 USD por 1K tokens (gratuito para muchos niveles)
- Clasificar ~568.426 normas: estimado ~$1-3 USD

**Total estimado para volumen completo: ~$20-30 USD**

### Rate limiting

- El servidor de normas.gba.gob.ar limita a ~500ms entre requests
- OpenAI API: sin límite específico de rate limiting en text-embedding (muy rápido)
- Zhipu API: rate limiting manejado automáticamente con reintentos exponenciales
- Ajustar `SCRAPER_DELAY_MS` si se obtienen errores 429 del sitio

## Troubleshooting

### "ERROR: DATABASE_URL no está definida"
- Verificar que el archivo `.env` existe en la raíz del proyecto
- Asegurar que la variable `DATABASE_URL` está correctamente formada

### "ERROR: OPENAI_API_KEY no está definida"
- Verificar que la variable `OPENAI_API_KEY` está en `.env`
- Confirmar que es una clave válida de OpenAI (sk-proj-...)

### Embedding falla con "429 Rate limit"
- Aumentar `EMBED_DELAY_MS` (ej: de 200 a 500)
- Reducir `EMBED_BATCH_SIZE` (ej: de 50 a 25)
- Para OpenAI generalmente no hay problemas de rate limiting, verificar cota de tokens

### Clasificación diferida falla repetidamente
- Aumentar `CLASSIFY_DELAY_MS` (ej: de 2000 a 5000)
- Verificar que `ZHIPU_API_KEY` es válida
- Revisar logs para mensajes de error específicos de Zhipu

### Scraper se detiene en 10 errores consecutivos
- Esperar 5 minutos (el servidor puede estar temporalmente bloqueando)
- Reanudar desde donde paró usando `--desde-fecha YYYY-MM`

### PostgreSQL: "pgvector extension not found"
```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS uuid-ossp;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### MCP Server no se conecta
- Verificar que `DATABASE_URL`, `OPENAI_API_KEY` y `ZHIPU_API_KEY` están en el entorno
- Revisar permisos de conexión a PostgreSQL
- Consultar stderr para mensajes de error del servidor

## Integración con otros MCPs

Este proyecto se complementa con:
- **MCP Saladillo**: Ordenanzas municipales de Saladillo (https://github.com/ejemplo/saladillo-mcp)

Ambos MCPs se pueden usar simultáneamente en Claude para validar que una nueva ordenanza municipal:
1. Se basa en norma provincial válida (MCP GBA)
2. No entra en conflicto con ordenanzas locales existentes (MCP Saladillo)

## Licencia

Este proyecto está bajo licencia MIT.

## Contribuciones

Las contribuciones son bienvenidas. Por favor:
1. Fork el proyecto
2. Crear una rama para tu feature (`git checkout -b feature/AmazingFeature`)
3. Commit tus cambios (`git commit -m 'Add AmazingFeature'`)
4. Push a la rama (`git push origin feature/AmazingFeature`)
5. Abrir un Pull Request

## Contacto

Para preguntas o sugerencias sobre este proyecto, abrir un issue en el repositorio.
