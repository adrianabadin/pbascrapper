-- Migración 002: titulo y organismo emisor
-- Segura de correr sobre datos existentes (IF NOT EXISTS).
-- Las normas ya scrapeadas quedan con NULL — se completan al re-scrapear.

ALTER TABLE normas
  ADD COLUMN IF NOT EXISTS titulo    TEXT,
  ADD COLUMN IF NOT EXISTS organismo TEXT;

COMMENT ON COLUMN normas.titulo IS
  'Título canónico tal como aparece en el listing (ej: "Resolución 17/2026")';
COMMENT ON COLUMN normas.organismo IS
  'Organismo emisor de resoluciones y disposiciones (ej: "del Ministerio de Salud")';

-- Actualizar el trigger FTS para incluir organismo en peso B
CREATE OR REPLACE FUNCTION trigger_normas_fts() RETURNS TRIGGER AS $$
BEGIN
  NEW.fts_vector :=
    setweight(to_tsvector('spanish',
      COALESCE(NEW.tipo::text, '') || ' ' ||
      COALESCE(NEW.numero::text, '') || ' ' ||
      COALESCE(NEW.anio::text, '')
    ), 'A') ||
    setweight(to_tsvector('spanish',
      COALESCE(NEW.resumen, '') || ' ' ||
      COALESCE(NEW.organismo, '')
    ), 'B') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.observaciones, '')), 'C') ||
    setweight(to_tsvector('spanish', COALESCE(NEW.texto_completo, '')), 'D');
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Reconstruir FTS para normas que ya tienen organismo (cuando se re-scrapeén)
-- No es necesario forzar un UPDATE masivo ahora — el trigger actúa al próximo upsert.
