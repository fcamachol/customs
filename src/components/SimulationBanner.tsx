/**
 * SimulationBanner — persistent notice that all documents produced by this system
 * are pre-validation / simulation outputs only.
 *
 * This banner must remain visible until FIEL/e.firma (CSD) signing + SAT/VUCEM
 * transmission are fully implemented (Track 2 of F16, currently externally blocked).
 * See docs/legal/fiel-efirma-integration.md for the full capability-gap description.
 */
export function SimulationBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-6 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
      data-testid="simulation-banner"
    >
      <span className="mt-0.5 shrink-0 text-amber-500" aria-hidden="true">
        {/* Warning triangle (inline SVG — no external dependency) */}
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path
            fillRule="evenodd"
            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
      </span>
      <p>
        <strong className="font-semibold">Modo simulacion / pre-validacion:</strong>{' '}
        Los documentos generados en este sistema son de pre-validacion estructural unicamente y{' '}
        <strong>NO son legalmente presentables ante el SAT/VUCEM</strong>. Para que un pedimento
        tenga validez legal debe ser firmado con FIEL/e.firma (CSD) y transmitido al SAT/VUCEM.
        Esta funcionalidad esta pendiente de implementacion (requiere certificados CSD y contrato
        con VUCEM).
      </p>
    </div>
  );
}
