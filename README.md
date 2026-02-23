# Normas GBA - Scraper + Embedder + MCP Server

Sistema completo para scrapear, procesar y exponer la normativa de la Provincia de Buenos Aires como herramientas MCP (Model Context Protocol), permitiendo que Claude u otros asistentes puedan hacer consultas legislativas en lenguaje natural.

## Descripción general

Este proyecto integra tres componentes principales:

1. **Scraper**: Descarga leyes, decretos, resoluciones y otras normas desde [normas.gba.gob.ar](https://normas.gba.gob.ar)
2. **Embedder**: Genera embeddings semánticos con Zhipu AI y clasifica automáticamente las normas en categorías temáticas
3. **MCP Server**: Expone 5 herramientas para consulta legislativa compatible con Claude y otros asistentes

El sistema está diseñado para asuntos legislativos prácticos: proponer ordenanzas municipales, analizar qué normas provinciales aplican a situaciones concretas, e identificar mecanismos de adhesión municipal en la legislación provincial.

## Requisitos previos

- Node.js 18+
- PostgreSQL 17+ con extensiones `pgvector`, `uuid-ossp` y `pg_trgm`
- API key de Zhipu AI (para embeddings y clasificación automática)
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

# API Zhipu AI
ZHIPU_API_KEY=tu_api_key_aqui
ZHIPU_BASE_URL=https://open.bigmodel.cn/api/paas/v4

# Scraper
SCRAPER_DELAY_MS=500          # Delay entre requests (respetar límites del servidor)

# Embedder
EMBED_BATCH_SIZE=50            # Items procesados por ciclo
EMBED_DELAY_MS=200             # Delay entre batches
EMBED_POLL_INTERVAL=30000      # Espera cuando la cola está vacía (ms)
MAX_ITEMS_API=16               # Máximo items por request a Zhipu (hard limit: 64)
MAX_TEXTO_CHARS=3000           # Caracteres máximos por texto (~750 tokens)
CLASIFICAR=1                   # 0 para deshabilitar clasificación automática
```

## Base de datos

Inicializar PostgreSQL con el schema:

```bash
# Conectar a PostgreSQL y ejecutar el schema
psql -U usuario -d normas_gba -f db/schema.sql
```

El schema incluye:
- Tabla `normas`: Información general de leyes, decretos, resoluciones, etc.
- Tabla `articulos`: Artículos individuales con embeddings
- Tabla `relaciones_normativas`: Relaciones entre normas (modifica, deroga, reglamenta, etc.)
- Tabla `cola_embeddings`: Cola de procesamiento para el embedder
- Índices HNSW para búsqueda semántica y Full-Text Search en Spanish

## Uso

### 1. Scraper - Descargar normas

```bash
# Scraping básico: leyes y decretos (por defecto)
npm run scrape

# Scrapear un tipo específico
npm run scrape -- --tipo ley
npm run scrape -- --tipo decreto
npm run scrape -- --tipo resolucion
npm run scrape -- --tipo disposicion
npm run scrape -- --tipo ordenanza_general
npm run scrape -- --tipo decreto_ley
npm run scrape -- --tipo resolucion_conjunta

# Scrapear desde un año específico (útil para actualizaciones)
npm run scrape -- --desde 2020

# Combinar filtros
npm run scrape -- --tipo ley --desde 2015 --max-paginas 5

# Solo obtener listing (sin scraping de detalle ni texto)
npm run scrape -- --solo-listing
```

Tipos de normas disponibles en el sitio:
- **Leyes**: ~13.942
- **Decreto-leyes**: ~2.479
- **Decretos**: miles
- **Ordenanzas generales**: ~369
- **Resoluciones**: ~83.000
- **Disposiciones**: ~83.000
- **Resoluciones conjuntas**: ~31.481

El scraper realiza tres fases por cada norma:
1. **Upsert básico** desde el listing (título, número, año, URL)
2. **Página de detalle** (resumen, fecha, estado de vigencia)
3. **Texto actualizado** (extrae artículos individuales si existe)
4. **Relaciones normativas** (qué otras normas modifica, deroga, complementa)

### 2. Embedder - Generar embeddings y clasificar

```bash
# Procesar la cola de embeddings
npm run embed
```

El embedder:
- Consume la tabla `cola_embeddings` automáticamente generada por el scraper
- Genera vectores semánticos con modelo `embedding-3` de Zhipu (2048 dimensiones)
- Clasifica automáticamente cada norma en categorías temáticas con `glm-4-flash`
- Implementa reintentos automáticos para rate limiting y errores de red
- Procesa en batches configurables, permitiendo Ctrl+C para terminar limpiamente

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

### 3. MCP Server - Exponer herramientas a Claude

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
¿Qué provincia ley permite que los municipios adhieran a programas de residuos?
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
├── README.md                 # Este archivo
├── package.json
├── .env.example             # Template de variables de entorno
├── db/
│   └── schema.sql          # Schema PostgreSQL con todas las tablas
├── scraper/
│   ├── index.js            # CLI principal del scraper
│   ├── crawler.js          # Funciones HTTP y parsing HTML
│   ├── parser.js           # Parsing de listings y páginas de detalle
│   ├── db.js               # Operaciones sobre la BD
│   └── embedder.js         # Procesador de embeddings y clasificación
├── mcp-server/
│   └── index.js            # Servidor MCP con 5 herramientas
└── tests/
    └── *.test.js           # Tests unitarios con Jest
```

## Desarrollo

### Ejecutar tests

```bash
npm test
```

### Ver logs del scraper

El scraper imprime el progreso en tiempo real:

```
🔍 Scrapeando LEY...
   Total: 13942 normas, 558 páginas a procesar
📄 Página 1/558...
  → Ley 1/1871: Código Civil ... ✓ sin cambios
  → Ley 2/1871: ... 📝 45 artículos
  ...
```

### Ver logs del embedder

El embedder muestra estadísticas por batch:

```
[10:23:45] Batch #1: 50 items
  → Normas (embedding + clasificación): 40
  → Artículos (embedding): 10
  [sub-batch 1] 16 textos, 8234 chars... OK (42567 tokens)
  [sub-batch 2] 16 textos, 7891 chars... OK (39821 tokens)
  → Embeddings: 32/50 guardados, 0 errores, 82388 tokens, 12.3s
  → Clasificados: 40/40 normas
  Acumulado: 15234 embeddings, 12456 clasificaciones, 825392 tokens
```

## Limitaciones y consideraciones

### Alcance de datos

- El scraper descarga solo normas disponibles en normas.gba.gob.ar
- No incluye sentencias judiciales, fallos, o normativa anterior a 1820
- El sitio web puede cambiar su estructura, requiriendo actualización del parser

### Costos de API

- **Zhipu embeddings-3**: ~0.001 USD por 1K tokens
- **Zhipu glm-4-flash** (clasificación): ~0.0001 USD por 1K tokens
- Procesar ~200.000 normas + artículos con clasificación: ~$15-20 USD

### Rate limiting

- El servidor de normas.gba.gob.ar limita a ~500ms entre requests
- Zhipu API tiene límite de rate limiting (handle automáticamente con reintentos)
- Ajustar `SCRAPER_DELAY_MS` si se obtienen errores 429

## Troubleshooting

### "ERROR: DATABASE_URL no está definida"
- Verificar que el archivo `.env` existe en la raíz del proyecto
- Asegurar que la variable `DATABASE_URL` está correctamente formada

### Embedding falla con "429 Rate limit"
- Aumentar `EMBED_DELAY_MS` (ej: de 200 a 500)
- Reducir `EMBED_BATCH_SIZE` (ej: de 50 a 25)

### Scraper se detiene en 10 errores consecutivos
- Esperar 5 minutos (el servidor puede estar temporalmente bloqueando)
- Reanudar desde donde paró usando `--desde ANIO`

### PostgreSQL: "pgvector extension not found"
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### MCP Server no se conecta
- Verificar que `DATABASE_URL` y `ZHIPU_API_KEY` están en el entorno
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
