import type { ExtractedPedimentoHeader } from '../types/reports';

export interface EntityCrossCheck {
  importerRfcMismatch: boolean;
  agentRfcMismatch: boolean;
  agencyRfcMismatch: boolean;
  patenteMismatch: boolean;
}

type ExtractedIds = Pick<ExtractedPedimentoHeader, 'importerRfc' | 'agentRfc' | 'agencyRfc' | 'patente'>;

// Mismatch only when BOTH sides are present and differ (case-insensitive). A null on either side
// makes no claim — extraction may not have captured the field, or the entity may be unconfigured.
function differs(a: string | null | undefined, b: string | null | undefined): boolean {
  return a != null && b != null && a.toUpperCase() !== b.toUpperCase();
}

export function crossCheckEntities(
  extracted: ExtractedIds,
  importer: { rfc: string } | null,
  agent: { patente: string; agentRfc: string; agencyRfc: string } | null,
): EntityCrossCheck {
  return {
    importerRfcMismatch: differs(extracted.importerRfc, importer?.rfc),
    agentRfcMismatch: differs(extracted.agentRfc, agent?.agentRfc),
    agencyRfcMismatch: differs(extracted.agencyRfc, agent?.agencyRfc),
    patenteMismatch: differs(extracted.patente, agent?.patente),
  };
}
