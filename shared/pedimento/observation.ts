export interface ObservationInput {
  guideId: string;
  valueUsd: number;
  consigneeName: string;
  id: string;               // RFC or CURP
}

export function partidaObservation(i: ObservationInput): string {
  const value = i.valueUsd.toFixed(2);
  return `GUIA ${i.guideId} VALOR ${value} USD NOMBRE ${i.consigneeName.toUpperCase()} RFC-CURP ${i.id}`;
}
