# Legacy parity verification (local only)

The client reference `Risk analysis 17 feb '25.xlsx` (Resumen: Amarillo 92.2% / Rojo 5.4% / Verde 2.4%
over 17,130 rows) contains real PII and is NOT committed. To confirm `scoreLegacyParity` reproduces it:

1. Place the workbook at `~/Downloads/Risk analysis 17 feb '25.xlsx`.
2. Run the throwaway script below (delete after). Map the `Manifiesto` input columns to `Shipment`
   via the same fields the parser uses, build `monthlyDbNames` from the `Base de datos mensual`
   sheet's `Destinatario (CNNE)` column (normalized), and score.
3. Assert the band split is within ±1pp of 92.2 / 5.4 / 2.4.

This is a manual gate, not CI, because the input cannot be committed.
