-- Migración 001: jerarquía normativa
-- Segura de correr sobre datos existentes (IF NOT EXISTS + DEFAULT).
-- Las normas ya scrapeadas quedan con rango_normativo = 5 (default genérico).
-- Correr después: db/seed-jerarquia.js para ajustar rangos correctos.

ALTER TABLE normas
  ADD COLUMN IF NOT EXISTS rango_normativo smallint NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS nombre_codigo   text;

COMMENT ON COLUMN normas.rango_normativo IS
  '1=constitución provincial, 2=código, 3=ley/decreto_ley, 4=decreto, 5=resolución/disposición/res_conjunta, 6=ordenanza_general';

COMMENT ON COLUMN normas.nombre_codigo IS
  'Nombre del código si la norma es un código provincial (ej: ''Código Fiscal'')';

-- Índice para filtrar/ordenar por jerarquía en queries del MCP
CREATE INDEX IF NOT EXISTS idx_normas_rango ON normas (rango_normativo);
