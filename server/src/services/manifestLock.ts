import type { ReportLockState } from '../../../shared/types/reports';

export interface ManifestLockInput {
  prevalidation?: { status?: string } | null;
  /** pedimento PDF file id (manifests.file_id) — present once a pedimento document is attached. */
  file_id?: string | null;
}

/**
 * Single source of truth for whether a manifest's import-data may still be edited.
 *
 * IMPORTANT — this lock is a LOCAL STRUCTURAL PROXY only. It prevents accidental edits after a
 * pedimento passes structural pre-validation or a PDF is attached.
 *
 * It is NOT a legal seal. Documents produced by this system are simulation/pre-validation outputs
 * and are NOT legally submittable until FIEL/e.firma (CSD) signing and SAT/VUCEM transmission are
 * implemented (Track 2 of F16, externally blocked on SAT certificates and the VUCEM web-service
 * contract). See docs/legal/fiel-efirma-integration.md for the full capability-gap description.
 *
 * When Track 2 ships, this function should gate the immutable lock on the presence of a real sello
 * (RSA-SHA256 CSD signature) and/or an acuse de recibo from VUCEM — NOT on structural APPROVED.
 */
export function computeLock(m: ManifestLockInput | null | undefined): ReportLockState {
  // Structural lock — NOT a legal seal (see jsdoc above)
  if (m?.prevalidation?.status === 'APPROVED') {
    return {
      editable: false,
      reason:
        'El pedimento ya fue prevalidado estructuralmente (APROBADO); los datos están bloqueados. ' +
        'NOTA: esta es una pre-validación local, no una firma legal. El documento no ha sido transmitido al SAT/VUCEM.',
    };
  }
  if (m?.file_id) {
    return {
      editable: false,
      reason:
        'Ya se adjuntó el pedimento PDF; los datos están bloqueados. ' +
        'NOTA: la adjunción de un PDF no equivale a firma legal ni transmisión al SAT/VUCEM.',
    };
  }
  return { editable: true, reason: null };
}
