import { LayoutDashboard, FilePlus2, Activity, FileBarChart2, Search, Info, Settings, Gavel, type LucideIcon } from 'lucide-react';

export type Section =
  | 'dashboard' | 'registro' | 'seguimiento' | 'reporte' | 'consulta'
  | 'cfg_motor' | 'cfg_clientes' | 'cfg_rfcs' | 'cfg_empresa' | 'cfg_tasa' | 'cfg_entidades'
  | 'autoridad' | 'acerca';

export type ConfigSection = 'cfg_motor' | 'cfg_clientes' | 'cfg_rfcs' | 'cfg_empresa' | 'cfg_tasa' | 'cfg_entidades';

export const SECTION_META: Record<Section, { title: string; subtitle: string }> = {
  dashboard:    { title: 'Dashboard', subtitle: 'Desempeño operativo y análisis de riesgo en tiempo real.' },
  registro:     { title: 'Realizar Registro', subtitle: 'Carga un manifiesto y ejecuta el análisis de riesgo T1.' },
  seguimiento:  { title: 'Seguimiento', subtitle: 'Captura de pedimento e importación del documento.' },
  reporte:      { title: 'Reporte General', subtitle: 'Datos de remitente y plataforma, y generación del reporte.' },
  consulta:     { title: 'Consulta', subtitle: 'Busca registros previos y descarga sus artefactos.' },
  cfg_motor:    { title: 'Motor de riesgo', subtitle: 'Parámetros de validación y listas de exclusión (V1–V8).' },
  cfg_clientes: { title: 'Clientes', subtitle: 'Datos recurrentes del remitente. Abra un cliente para ver sus datos y administrar sus plataformas.' },
  cfg_rfcs:     { title: 'RFCs validados', subtitle: 'Catálogo de RFC/CURP validados para el reporte T1.' },
  cfg_empresa:  { title: 'Empresa', subtitle: 'Identidad y branding en pantallas y reportes generados.' },
  cfg_tasa:      { title: 'Tasa global', subtitle: 'Vigencias de tasa global · sólo Super Admin.' },
  cfg_entidades: { title: 'Entidades de pedimento', subtitle: 'Importador de registro y agente aduanal · sólo Super Admin.' },
  autoridad:    { title: 'Autoridad', subtitle: 'Bitácora, integridad de la cadena y reporte consolidado.' },
  acerca:       { title: 'Acerca de', subtitle: 'Plataforma de análisis de riesgo y cumplimiento T1.' },
};

// A nav entry is either a plain leaf (a destination) or a collapsible parent whose children are
// destinations. A parent is only rendered as collapsible when ≥2 of its children are visible;
// with a single visible child the Sidebar promotes that child to a plain link ("leave just the
// parent"). Children are trimmed to substantial destinations — trivial single-field settings are
// folded into a sibling pane, never given their own entry.
export interface NavChild { id: Section; label: string; badge?: string }
export interface NavLeaf { id: Section; label: string; icon: LucideIcon }
export interface NavParent { parentId: string; label: string; icon: LucideIcon; children: NavChild[] }
export type NavItem = NavLeaf | NavParent;

export function isParent(item: NavItem): item is NavParent {
  return (item as NavParent).children !== undefined;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  { label: 'Resumen', items: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }] },
  { label: 'Operación', items: [
    { id: 'registro', label: 'Realizar Registro', icon: FilePlus2 },
    { id: 'seguimiento', label: 'Seguimiento', icon: Activity },
    { id: 'reporte', label: 'Reporte General', icon: FileBarChart2 },
  ] },
  { label: 'Consulta', items: [{ id: 'consulta', label: 'Consulta', icon: Search }] },
  { label: 'Sistema', items: [
    {
      parentId: 'configuracion',
      label: 'Configuración',
      icon: Settings,
      children: [
        { id: 'cfg_motor', label: 'Motor de riesgo' },
        { id: 'cfg_clientes', label: 'Clientes' },
        { id: 'cfg_rfcs', label: 'RFCs validados' },
        { id: 'cfg_empresa', label: 'Empresa' },
        { id: 'cfg_tasa', label: 'Tasa global', badge: 'Super' },
        { id: 'cfg_entidades', label: 'Entidades de pedimento', badge: 'Super' },
      ],
    },
    { id: 'autoridad', label: 'Autoridad', icon: Gavel },
    { id: 'acerca', label: 'Acerca de', icon: Info },
  ] },
];

const CONFIG_SECTIONS: Section[] = ['cfg_motor', 'cfg_clientes', 'cfg_rfcs', 'cfg_empresa', 'cfg_tasa', 'cfg_entidades'];

// Role-based visibility:
//  - autoridad is read-only: dashboard, consulta, the Autoridad portal, and Acerca.
//  - admin / super_admin get everything, including all Configuración children.
//  - capturista runs the operative flow but not Configuración nor the Autoridad portal.
export function visibleSectionsFor(role: string): Section[] {
  if (role === 'autoridad') return ['dashboard', 'consulta', 'autoridad', 'acerca'];
  if (role === 'admin' || role === 'super_admin') {
    return ['dashboard', 'registro', 'seguimiento', 'reporte', 'consulta', ...CONFIG_SECTIONS, 'autoridad', 'acerca'];
  }
  return ['dashboard', 'registro', 'seguimiento', 'reporte', 'consulta', 'acerca'];
}
