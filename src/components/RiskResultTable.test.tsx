import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RiskSummary, RiskResultTable } from './RiskResultTable';

describe('RiskSummary', () => {
  it('renders the four buckets with labels and numbers (3-bucket PRD mapping)', () => {
    render(
      <RiskSummary summary={{ analizados: 10, aprobados: 6, noIdentificados: 3, validarEnPrevio: 1 }} />
    );
    expect(screen.getByText('Analizados')).toBeTruthy();
    expect(screen.getByText('Aprobados')).toBeTruthy();
    expect(screen.getByText('No identificados')).toBeTruthy();
    expect(screen.getByText('Validar en previo')).toBeTruthy();
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
      description: 'Pantalones, Funda protectora',
      resultado: 'rojo' as const,
      motivo: 'Sender flagged on watchlist',
    },
    {
      mwb: 'MWB-002',
      guide: 'G-002',
      consignee: 'Beta LLC',
      senderCity: 'Miami',
      senderCountry: 'US',
      description: 'Camiseta',
      resultado: 'verde' as const,
      motivo: 'Sin observaciones',
    },
  ];

  it('renders both rows with descripción de la mercancía and resultado labels', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('Descripción de la mercancía')).toBeTruthy();
    expect(screen.getByText('MWB-001')).toBeTruthy();
    expect(screen.getByText('MWB-002')).toBeTruthy();
    expect(screen.getByText('Acme Corp')).toBeTruthy();
    expect(screen.getByText('Beta LLC')).toBeTruthy();
    expect(screen.getByText('Pantalones, Funda protectora')).toBeTruthy();
    expect(screen.getByText('Camiseta')).toBeTruthy();
    // The País remitente column was replaced by the merchandise description (client observation).
    expect(screen.queryByText('País remitente')).toBeNull();
    expect(screen.getByText('Rojo')).toBeTruthy();
    expect(screen.getByText('Verde')).toBeTruthy();
  });

  it('shows the motivo text for the rojo row', () => {
    render(<RiskResultTable rows={rows} />);
    expect(screen.getByText('Sender flagged on watchlist')).toBeTruthy();
  });
});
