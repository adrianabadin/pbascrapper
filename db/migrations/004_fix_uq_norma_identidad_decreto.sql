-- Migración 004: quitar 'decreto' de uq_norma_identidad
--
-- Problema: decretos como "196B/2003" se parsean con parseInt como numero=196,
-- colisionando con "196/2003" en el índice UNIQUE(tipo, numero, anio).
--
-- Los decretos en PBA pueden tener sufijos alfanuméricos (B, C, etc.) que los
-- hacen distintos aunque compartan numero entero y año. El sitio_id es el
-- identificador real único para decretos.
--
-- Solución: el índice parcial solo aplica a ley y decreto_ley, donde el número
-- es estrictamente entero y único a nivel provincial.

DROP INDEX IF EXISTS uq_norma_identidad;

CREATE UNIQUE INDEX uq_norma_identidad
  ON normas (tipo, numero, anio)
  WHERE tipo IN ('ley', 'decreto_ley');
