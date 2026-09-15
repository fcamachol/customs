import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
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
