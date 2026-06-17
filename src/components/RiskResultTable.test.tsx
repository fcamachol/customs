import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RiskSummary, RiskResultTable } from './RiskResultTable';

describe('RiskSummary', () => {
  it('renders the four buckets with labels and numbers', () => {
    render(
      <RiskSummary summary={{ analizados: 10, aprobados: 6, validarEnPrevio: 3, rojos: 1 }} />
    );
    expect(screen.getByText('Analizados')).toBeTruthy();
    expect(screen.getByText('Aprobados')).toBeTruthy();
    expect(screen.getByText('Validar en previo')).toBeTruthy();
    expect(screen.getByText('Rojos')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(screen.getByText('6')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy();
  });
});

describe('RiskResultTable', () => {
  const rows = [
    {
      mwb: 'MWB-001',
      guide: 'G-001',
      consignee: 'Acme Corp',
      senderCity: 'Shenzhen',
      senderCountry: 'CN',
      resultado: 'rojo' as const,
      motivo: 'Sender flagged on watchlist',
    },
    {
      mwb: 'MWB-002',
      guide: 'G-002',
      consignee: 'Beta LLC',
      senderCity: 'Miami',
      senderCountry: 'US',
      resultado: 'verde' as const,
      motivo: 'Sin observaciones',
    },
  ];

  it('renders both rows with sender country and resultado labels', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('MWB-001')).toBeTruthy();
    expect(screen.getByText('MWB-002')).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    expect(screen.getByText('CN')).toBeTruthy();
    expect(screen.getByText('US')).toBeTruthy();
    expect(screen.getByText('rojo')).toBeTruthy();
    expect(screen.getByText('verde')).toBeTruthy();
  });

  it('shows the motivo text for the rojo row', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('Sender flagged on watchlist')).toBeTruthy();
  });
});
