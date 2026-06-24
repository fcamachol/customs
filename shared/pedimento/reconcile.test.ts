import { describe, it, expect } from 'vitest';
import { buildExpectedFromManifest } from './reconcile';

const ship = (guideId: string, customsValueUsd: number, name: string, rfc: string) =>
  ({ guideId, customsValueUsd, consignee: { name, rfc, curp: null } });

describe('buildExpectedFromManifest', () => {
  it('aggregates multiple product rows of one guía into a single summed line', () => {
    const { expected } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.50, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G2', 12.00, 'ANA LOPEZ', 'LOAA900202BB2'),
    ]);
    expect(expected.lines).toHaveLength(2);
    expect(expected.lines.find((l) => l.guia === 'G1')).toMatchObject({ valueUsd: 12.5, consigneeName: 'JUAN PEREZ', id: 'PEXJ800101AA1' });
    expect(expected.lines.find((l) => l.guia === 'G2')!.valueUsd).toBe(12);
  });
  it('warns when one guía spans differing consignees', () => {
    const { warnings } = buildExpectedFromManifest([
      ship('G1', 6.00, 'JUAN PEREZ', 'PEXJ800101AA1'),
      ship('G1', 6.00, 'OTRO NOMBRE', 'PEXJ800101AA1'),
    ]);
    expect(warnings.some((w) => w.includes('G1'))).toBe(true);
  });
  it('uses curp over rfc for the id when present', () => {
    const { expected } = buildExpectedFromManifest([
      { guideId: 'G3', customsValueUsd: 5, consignee: { name: 'X', rfc: 'RFC010101AAA', curp: 'CURP010101HDFAAA09' } },
    ]);
    expect(expected.lines[0].id).toBe('CURP010101HDFAAA09');
  });
});
