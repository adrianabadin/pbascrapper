-- Migración 003: restringir uq_norma_identidad a tipos donde el número es realmente único
--
-- Problema: resoluciones y disposiciones son emitidas por múltiples organismos
-- y pueden tener el mismo número en el mismo año (ej: Disposición 31/2019 del
-- Ministerio de Salud y del Ministerio de Educación).
-- La constraint global UNIQUE(tipo, numero, anio) causa fallo al insertar la segunda.
--
-- Solución: convertirla en índice parcial que solo aplique a ley, decreto y decreto_ley
-- donde el número sí es único a nivel provincial.

ALTER TABLE normas DROP CONSTRAINT IF EXISTS uq_norma_identidad;

CREATE UNIQUE INDEX IF NOT EXISTS uq_norma_identidad
  ON normas (tipo, numero, anio)
  WHERE tipo IN ('ley', 'decreto', 'decreto_ley');
