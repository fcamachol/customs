// Traducción ES de descripciones de mercancía para el Análisis de Riesgo (client request).
// Manifests arrive with English (sometimes Chinese) product names, usually comma-separated
// ("Pants,Protective Case,T-Shirt"). Deterministic glossary lookup per segment — no network
// call, so risk analysis stays offline and reproducible. Unknown terms pass through unchanged.

const GLOSARIO: Record<string, string> = {
  // Ropa
  'pants': 'Pantalones',
  'pant': 'Pantalón',
  'trousers': 'Pantalones',
  'jeans': 'Pantalones de mezclilla',
  'shorts': 'Pantalones cortos',
  't-shirt': 'Camiseta',
  'tshirt': 'Camiseta',
  'shirt': 'Camisa',
  'blouse': 'Blusa',
  'women blouse': 'Blusa de mujer',
  "women's blouse": 'Blusa de mujer',
  'dress': 'Vestido',
  "women's dress": 'Vestido de mujer',
  'women dress': 'Vestido de mujer',
  'girl dress': 'Vestido de niña',
  'skirt': 'Falda',
  'coat': 'Abrigo',
  'jacket': 'Chaqueta',
  "men's jacket": 'Chaqueta de hombre',
  'sweatshirt': 'Sudadera',
  'hoodie': 'Sudadera con capucha',
  'sweater': 'Suéter',
  'jumper': 'Suéter',
  'vest': 'Chaleco',
  'suit': 'Traje',
  'women suit': 'Traje de mujer',
  "women's suit": 'Traje de mujer',
  'girl suit': 'Traje de niña',
  'boy suit': 'Traje de niño',
  'pajamas': 'Pijama',
  'pyjamas': 'Pijama',
  'underwear': 'Ropa interior',
  'underpants': 'Ropa interior',
  'bra': 'Brasier',
  'shapewear': 'Faja',
  'swimsuit': 'Traje de baño',
  'sock': 'Calcetín',
  'socks': 'Calcetines',
  'women sock': 'Calcetines de mujer',
  'belt': 'Cinturón',
  'tie': 'Corbata',
  'scarf': 'Bufanda',
  'gloves': 'Guantes',
  'hat': 'Sombrero',
  'cap': 'Gorra',
  // Calzado
  'shoes': 'Zapatos',
  'sneakers': 'Tenis',
  'boots': 'Botas',
  'sandals': 'Sandalias',
  'slippers': 'Pantuflas',
  // Accesorios
  'bag': 'Bolsa',
  'handbag': 'Bolsa de mano',
  'backpack': 'Mochila',
  'wallet': 'Cartera',
  'storage bag': 'Bolsa de almacenamiento',
  'watch': 'Reloj',
  'necklace': 'Collar',
  'bracelet': 'Pulsera',
  'earrings': 'Aretes',
  'ring': 'Anillo',
  'chain': 'Cadena',
  'the chain': 'Cadena',
  'hair clip': 'Pinza para el cabello',
  'sunglasses': 'Lentes de sol',
  'umbrella': 'Paraguas',
  // Electrónica
  'phone case': 'Funda para teléfono',
  'protective case': 'Funda protectora',
  'case': 'Funda',
  'charger': 'Cargador',
  'phone charger': 'Cargador de teléfono',
  'cable': 'Cable',
  'usb cable': 'Cable USB',
  'headphones': 'Audífonos',
  'earphones': 'Audífonos',
  'speaker': 'Bocina',
  'keyboard': 'Teclado',
  'mouse': 'Ratón',
  'screen protector': 'Mica protectora',
  'smart watch': 'Reloj inteligente',
  // Hogar
  'lamp': 'Lámpara',
  'curtain': 'Cortina',
  'towel': 'Toalla',
  'blanket': 'Cobija',
  'pillow': 'Almohada',
  'pillowcase': 'Funda de almohada',
  'sheet': 'Sábana',
  'seat cushion': 'Cojín de asiento',
  'cushion': 'Cojín',
  'mug': 'Taza',
  'cup': 'Taza',
  'bottle': 'Botella',
  'water bottle': 'Botella de agua',
  'plastic plant': 'Planta de plástico',
  'decorative': 'Decorativo',
  'sticker': 'Calcomanía',
  'stickers': 'Calcomanías',
  'pen': 'Pluma',
  'notebook': 'Cuaderno',
  'toy': 'Juguete',
  'doll': 'Muñeca',
};

/** Normalize a segment for glossary lookup: lowercase, unify apostrophes, collapse whitespace. */
function claveGlosario(segment: string): string {
  return segment.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Translate ONE product-name segment; falls back to the original text when unknown. */
function traducirSegmento(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return trimmed;
  const key = claveGlosario(trimmed);
  const hit = GLOSARIO[key]
    // plural not in the glossary → try the singular ("jackets" → "jacket")
    ?? (key.endsWith('s') ? GLOSARIO[key.slice(0, -1)] : undefined);
  return hit ?? trimmed;
}

/**
 * Translate a merchandise description to Spanish for the risk analysis. Splits comma/semicolon
 * separated product lists and translates each segment via the glossary; unknown segments (and
 * non-English text) pass through unchanged so information is never lost.
 */
export function traducirDescripcion(descripcion: string): string {
  if (!descripcion) return descripcion ?? '';
  return descripcion
    .split(/[,;]+/)
    .map(traducirSegmento)
    .filter(Boolean)
    .join(', ');
}
