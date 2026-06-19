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

/** Returns the matched brand name or null. Accepts an optional override list; falls back to PIRACY_BRANDS. */
export function matchesBrand(description: string, brands?: string[]): string | null {
  const list = brands && brands.length > 0 ? brands : PIRACY_BRANDS;
  const d = norm(description);
  return list.find((b) => d.includes(norm(b))) ?? null;
}

/** Returns the matched keyword or null. Accepts an optional override list; falls back to PROHIBITED_KEYWORDS. */
export function matchesProhibited(description: string, keywords?: string[]): string | null {
  const list = keywords && keywords.length > 0 ? keywords : PROHIBITED_KEYWORDS;
  const d = norm(description);
  return list.find((k) => d.includes(norm(k))) ?? null;
}
