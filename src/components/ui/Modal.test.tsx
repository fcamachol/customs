import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Modal open={false} onClose={() => {}} title="Nuevo">body</Modal>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders title and content when open', () => {
    render(<Modal open onClose={() => {}} title="Nuevo cliente">contenido</Modal>);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Nuevo cliente')).toBeTruthy();
    expect(screen.getByText('contenido')).toBeTruthy();
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    render(<Modal open onClose={onClose} title="X">y</Modal>);
    fireEvent.click(screen.getByLabelText('Cerrar'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('defaults to the standard (md) width', () => {
    render(<Modal open onClose={() => {}} title="X">y</Modal>);
    expect(screen.getByRole('dialog').className).toContain('max-w-lg');
  });

  it('widens for size="xl"', () => {
    render(<Modal open onClose={() => {}} title="X" size="xl">y</Modal>);
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');
  });
});
