// From Risk analysis 17 feb '25.xlsx — piracy brands (col BL) + prohibited keywords (col BA).
export const PIRACY_BRANDS = [
  'Adidas', 'Nike', 'Bimba y Lola', 'Gucci', 'Samsung',
  'Apple', 'Louis Vuitton', 'Dolce and Gabbana', 'Ray Ban',
];

export const PROHIBITED_KEYWORDS = [
  'maquillaje', 'liquido', 'pastilla', 'capsula', 'cápsula', 'globo',
  'pegamento', 'autoparte', 'pistola', 'droga', 'mariguana',
  'suplemento', 'vitamina', 'medicamento',
];

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function matchesBrand(description: string): string | null {
  const d = norm(description);
  return PIRACY_BRANDS.find((b) => d.includes(norm(b))) ?? null;
}

export function matchesProhibited(description: string): string | null {
  const d = norm(description);
  return PROHIBITED_KEYWORDS.find((k) => d.includes(norm(k))) ?? null;
}
