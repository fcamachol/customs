import type { ReportLockState } from '../../../shared/types/reports';

export interface ManifestLockInput {
  prevalidation?: { status?: string } | null;
  /** pedimento PDF file id (manifests.file_id) — present once a pedimento document is attached. */
  file_id?: string | null;
}

/**
 * Single source of truth for whether a manifest's import-data may still be edited.
 *
 * A declaration becomes locked once it is finalized: the pedimento prevalidation is APPROVED, or a
 * pedimento PDF has been attached. (True regulatory immutability is SAT/VUCEM transmission — tracked
 * as a deferred follow-up; this proxy is the explicit, conservative boundary for now.)
 */
export function computeLock(m: ManifestLockInput | null | undefined): ReportLockState {
  if (m?.prevalidation?.status === 'APPROVED') {
    return { editable: false, reason: 'El pedimento ya fue prevalidado (APROBADO); los datos están bloqueados.' };
  }
  if (m?.file_id) {
    return { editable: false, reason: 'Ya se adjuntó el pedimento PDF; los datos están bloqueados.' };
  }
  return { editable: true, reason: null };
}
