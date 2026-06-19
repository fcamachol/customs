import { LayoutDashboard, FilePlus2, Activity, FileBarChart2, Search, Info, type LucideIcon } from 'lucide-react';

export type Section = 'dashboard' | 'registro' | 'seguimiento' | 'reporte' | 'consulta' | 'acerca';

export const SECTION_META: Record<Section, { title: string; subtitle: string }> = {
  dashboard:  { title: 'Dashboard', subtitle: 'Desempeño operativo y análisis de riesgo en tiempo real.' },
  registro:   { title: 'Realizar Registro', subtitle: 'Carga un manifiesto y ejecuta el análisis de riesgo T1.' },
  seguimiento:{ title: 'Seguimiento', subtitle: 'Captura de pedimento e importación del documento.' },
  reporte:    { title: 'Reporte General', subtitle: 'Datos de remitente y plataforma, y generación del reporte.' },
  consulta:   { title: 'Consulta', subtitle: 'Busca registros previos y descarga sus artefactos.' },
  acerca:     { title: 'Acerca de', subtitle: 'Plataforma de análisis de riesgo y cumplimiento T1.' },
};

export const NAV_GROUPS: { label: string; items: { id: Section; label: string; icon: LucideIcon }[] }[] = [
  { label: 'Resumen', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { label: 'Operación', items: [
    { id: 'registro', label: 'Realizar Registro', icon: FilePlus2 },
    { id: 'seguimiento', label: 'Seguimiento', icon: Activity },
    { id: 'reporte', label: 'Reporte General', icon: FileBarChart2 },
  ] },
  { label: 'Consulta', items: [{ id: 'consulta', label: 'Consulta', icon: Search }] },
  { label: 'Sistema', items: [{ id: 'acerca', label: 'Acerca de', icon: Info }] },
];

// autoridad is read-only: hide the write-flows (registro/seguimiento/reporte).
export function visibleSectionsFor(role: string): Section[] {
  if (role === 'autoridad') return ['dashboard', 'consulta', 'acerca'];
  return ['dashboard', 'registro', 'seguimiento', 'reporte', 'consulta', 'acerca'];
}
