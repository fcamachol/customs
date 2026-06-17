export type Section = 'registro' | 'seguimiento' | 'reporte' | 'consulta' | 'dashboard' | 'acerca';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'registro', label: 'Realizar Registro' },
  { id: 'seguimiento', label: 'Seguimiento' },
  { id: 'reporte', label: 'Reporte General' },
  { id: 'consulta', label: 'Consulta' },
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'acerca', label: 'Acerca de' },
];

export function AppShell({ role, active, onSelect }: {
  role: string; active: Section; onSelect: (s: Section) => void;
}) {
  return (
    <nav aria-label="Secciones">
      <div className="brand">Capital Centennials</div>
      <ul>
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <button aria-current={active === s.id} onClick={() => onSelect(s.id)}>{s.label}</button>
          </li>
        ))}
      </ul>
      <div className="role">{role}</div>
    </nav>
  );
}
