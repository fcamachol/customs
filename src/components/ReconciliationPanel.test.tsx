import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReconciliationPanel } from './ReconciliationPanel';
import type { ReconciliationReport } from '../../shared/types/reports';

const report: ReconciliationReport = {
  generatedAt: '2026-06-24T10:00:00Z',
  extractionMethod: 'deterministic',
  usedPositional: true,
  confidence: 0.95,
  header: [],
  totals: [],
  lines: [
    {
      guia: 'GUIA-001',
      status: 'matched',
      diffs: [],
    },
    {
      guia: 'GUIA-002',
      status: 'mismatch',
      diffs: [
        { field: 'valorUsd', expected: 100, actual: 90, ok: false },
        { field: 'nombre', expected: 'Acme Corp', actual: 'Acme Corp', ok: true },
      ],
    },
  ],
  summary: {
    matched: 1,
    mismatched: 1,
    missingInPedimento: 0,
    extraInPedimento: 0,
    color: 'amarillo',
  },
  notes: ['Diferencia de valor detectada en GUIA-002.'],
};

describe('ReconciliationPanel', () => {
  it('renders "Sin cotejo disponible" when report is null', () => {
    render(<ReconciliationPanel report={null} />);
    expect(screen.getByText(/Sin cotejo disponible/i)).toBeTruthy();
  });

  it('renders summary counts with correct labels', () => {
    render(<ReconciliationPanel report={report} />);
    // matched=1 and mismatched=1 both render "1"; expect at least two such elements
    const ones = screen.getAllByText('1');
    expect(ones.length).toBeGreaterThanOrEqual(2);
    // labels for summary buckets
    expect(screen.getByText(/Coinciden/i)).toBeTruthy();
    expect(screen.getByText(/Discrepancias/i)).toBeTruthy();
  });

  it('renders the StatusPill for summary color', () => {
    render(<ReconciliationPanel report={report} />);
    // StatusPill default label for 'amarillo' is 'Amarillo'
    expect(screen.getByText('Amarillo')).toBeTruthy();
  });

  it('renders the mismatch line with guia and status', () => {
    render(<ReconciliationPanel report={report} />);
    // La guía aparece en dos lugares desde que existe el bloque de montos: en el resumen de
    // importes y en el detalle de excepciones. Ambas son intencionales.
    expect(screen.getAllByText('GUIA-002').length).toBeGreaterThan(0);
    // The matched guia should NOT appear as a listed exception row
    // (it shows as a count, not a row)
  });

  it('muestra el estimado de impuesto diciendo que es informativo y sobre qué base', () => {
    const conImpuesto = {
      ...report,
      estimadoImpuesto: {
        totalImpuestoUsd: 33.5, totalValorUsd: 100, sinEstimar: 0,
        tasasUsadas: [{ origen: 'GENERAL' as const, tasaPct: 33.5, desde: '2026-01-01' }],
        tasaPedimentoPct: 33.5,
      },
    };
    render(<ReconciliationPanel report={conImpuesto} />);
    expect(screen.getByText(/Estimado de impuesto/i)).toBeTruthy();
    // Las dos cosas que el bloque tiene que decir en voz alta, por decisión del 15-sep.
    expect(screen.getByText(/el cálculo legal lo determina el agente aduanal/i)).toBeTruthy();
    expect(screen.getByText(/sólo lo que va al pedimento/i)).toBeTruthy();
  });

  // Que el agente aplique una tasa distinta a la vigente es justo lo que este bloque debe delatar.
  it('advierte cuando la tasa del pedimento difiere de la vigente', () => {
    const conDiferencia = {
      ...report,
      estimadoImpuesto: {
        totalImpuestoUsd: 33.5, totalValorUsd: 100, sinEstimar: 0,
        tasasUsadas: [{ origen: 'GENERAL' as const, tasaPct: 33.5, desde: '2026-01-01' }],
        tasaPedimentoPct: 19,
      },
    };
    render(<ReconciliationPanel report={conDiferencia} />);
    expect(screen.getByText(/Verificar cuál corresponde/i)).toBeTruthy();
  });

  // El total responde "cuánto"; el desglose responde "de dónde sale". Sin él, la advertencia de
  // tasa discrepante no se puede verificar contra el pedimento partida por partida.
  it('muestra el desglose por guía con valor, tasa e impuesto de cada una', () => {
    const conDesglose = {
      ...report,
      estimadoImpuesto: {
        totalImpuestoUsd: 33.5, totalValorUsd: 100, sinEstimar: 0,
        tasasUsadas: [{ origen: 'GENERAL' as const, tasaPct: 33.5, desde: '2026-01-01' }],
        tasaPedimentoPct: 33.5,
        partidas: [
          { guia: 'GUIA-001', valorUsd: 60, origen: 'GENERAL' as const, tasaPct: 33.5, impuestoUsd: 20.1 },
          { guia: 'GUIA-002', valorUsd: 40, origen: 'TMEC' as const, tasaPct: 0, impuestoUsd: 0 },
        ],
      },
    };
    render(<ReconciliationPanel report={conDesglose} />);
    fireEvent.click(screen.getByText(/Ver desglose por guía \(2\)/i));
    expect(screen.getByText('TMEC')).toBeTruthy();
    expect(screen.getByText('20.10')).toBeTruthy();
  });

  // Un cero se lee como "no paga". Una partida sin tasa vigente tiene que decir que no se estimó.
  it('marca "sin estimar" en vez de cero cuando la guía no tuvo tasa vigente', () => {
    const sinTasa = {
      ...report,
      estimadoImpuesto: {
        totalImpuestoUsd: 0, totalValorUsd: 50, sinEstimar: 1,
        tasasUsadas: [],
        tasaPedimentoPct: null,
        partidas: [
          { guia: 'GUIA-009', valorUsd: 50, origen: 'GENERAL' as const, tasaPct: null, impuestoUsd: null, motivo: 'sin_vigencia' },
        ],
      },
    };
    render(<ReconciliationPanel report={sinTasa} />);
    fireEvent.click(screen.getByText(/Ver desglose por guía \(1\)/i));
    // El motivo viaja como tooltip de la celda; "sin estimar" a secas también aparece en el aviso
    // agregado, así que el aserto apunta a la celda por su title para no confundir uno con otro.
    expect(screen.getByTitle('sin_vigencia').textContent).toBe('sin estimar');
  });

  it('no muestra el desglose cuando no hay partidas', () => {
    const sinPartidas = {
      ...report,
      estimadoImpuesto: {
        totalImpuestoUsd: 33.5, totalValorUsd: 100, sinEstimar: 0,
        tasasUsadas: [{ origen: 'GENERAL' as const, tasaPct: 33.5, desde: '2026-01-01' }],
        tasaPedimentoPct: 33.5,
      },
    };
    render(<ReconciliationPanel report={sinPartidas} />);
    expect(screen.queryByText(/Ver desglose por guía/i)).toBeNull();
  });

  it('muestra la validación de montos manifiesto vs pedimento', () => {
    render(<ReconciliationPanel report={report} />);
    expect(screen.getByText(/Validación de montos/i)).toBeTruthy();
    // El desfase por guía es lo que el operador necesita ver: 100 declarado como 90 → −10.
    expect(screen.getByText(/guía\(s\) con importe distinto/i)).toBeTruthy();
  });

  it('renders the failing diff (importe esperado vs declarado) for the mismatch line', () => {
    render(<ReconciliationPanel report={report} />);
    // field name
    // El campo se muestra con su nombre legible ('Importe'), no con el identificador interno.
    expect(screen.getAllByText(/importe/i).length).toBeGreaterThan(0);
    // expected value
    expect(screen.getByText('100')).toBeTruthy();
    // actual value
    expect(screen.getByText('90')).toBeTruthy();
  });

  it('does NOT list the matched guia as an exception row', () => {
    render(<ReconciliationPanel report={report} />);
    // GUIA-001 is matched; it should not appear as a line item
    expect(screen.queryByText('GUIA-001')).toBeNull();
  });

  it('renders the notes below the exceptions', () => {
    render(<ReconciliationPanel report={report} />);
    expect(screen.getByText('Diferencia de valor detectada en GUIA-002.')).toBeTruthy();
  });
});
