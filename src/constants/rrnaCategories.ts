/**
 * RRNA — Regulaciones y Restricciones No Arancelarias
 * Prohibited goods categories for T1 Pedimento (RGCE Rule 3.7.5-E)
 *
 * These goods MUST be cleared via standard commercial pedimento (A1)
 * with a licensed customs broker, Padrón de Importadores registration,
 * and applicable federal permits.
 */

import { RRNACategory } from '../types/t1';

export const RRNA_PATTERNS: Record<RRNACategory, string[]> = {
  // --------------------------------------------------------------------------
  // COFEPRIS — Comisión Federal para la Protección contra Riesgos Sanitarios
  // --------------------------------------------------------------------------
  COFEPRIS_FOOD: [
    'food', 'comida', 'alimento', 'snack', 'chocolate', 'candy', 'dulce',
    'supplement', 'suplemento', 'vitamin', 'vitamina', 'protein', 'proteina',
    'nutrition', 'nutricion', 'energy bar', 'barra energetica', 'cereal',
    'cookie', 'galleta', 'cracker', 'pan', 'bread', 'coffee', 'cafe',
    'tea', 'te ', 'honey', 'miel', 'sauce', 'salsa', 'oil', 'aceite',
    'spice', 'especia', 'condiment', 'condimento', 'jam', 'mermelada',
  ],

  COFEPRIS_COSMETICS: [
    'cosmetic', 'cosmetico', 'cosmetics', 'perfume', 'fragrance', 'fragancia',
    'lotion', 'locion', 'loción', 'cream', 'crema', 'makeup', 'maquillaje',
    'lipstick', 'labial', 'mascara', 'eyeliner', 'shampoo', 'acondicionador',
    'conditioner', 'soap', 'jabon', 'jebón', 'gel', 'spray', 'sunscreen',
    'protector solar', 'skincare', 'cuidado de la piel', 'nail polish',
    'esmalte', 'deodorant', 'desodorante', 'aftershave', 'afeitado',
  ],

  COFEPRIS_MEDICAL: [
    'medical device', 'dispositivo medico', 'dispositivo médico',
    'orthopedic', 'ortopedico', 'ortopédico', 'prosthetic', 'prótesis',
    'wheelchair', 'silla de ruedas', 'crutches', 'muletas', 'walker',
    'andador', 'braces', 'férula', 'ferula', 'splint', 'espinillera',
    'contact lens', 'lentes de contacto', 'hearing aid', 'audifono',
    'surgical', 'quirurgico', 'quirúrgico', 'syringe', 'jeringa',
    'bandage', 'venda', 'first aid', 'primeros auxilios',
  ],

  // --------------------------------------------------------------------------
  // SENASICA — Servicio Nacional de Sanidad, Inocuidad y Calidad Agroalimentaria
  // --------------------------------------------------------------------------
  SENASICA_AGRICULTURAL: [
    'seed', 'semilla', 'plant', 'planta', 'flower', 'flor', 'bulb', 'bulbo',
    'fruit', 'fruta', 'vegetable', 'verdura', 'legume', 'legumbre', 'grain',
    'cereal crop', 'wheat', 'trigo', 'corn', 'maiz', 'maíz', 'rice', 'arroz',
    'soy', 'soya', 'bean', 'frijol', 'lentil', 'lenteja', 'nut', 'nuez',
    'almond', 'almendra', 'spore', 'espora', 'sapling', 'plantula',
    'cutting', 'esqueje', 'root', 'raiz', 'raíz', 'tuber', 'tuberculo',
  ],

  // --------------------------------------------------------------------------
  // SEMARNAT — Secretaría de Medio Ambiente y Recursos Naturales
  // --------------------------------------------------------------------------
  SEMARNAT_ENVIRONMENTAL: [
    'timber', 'madera', 'wood', 'lumber', 'madera aserrada', 'log', 'tronco',
    'bamboo', 'bambu', 'cork', 'corcho', 'hazardous', 'peligroso', 'toxic',
    'toxico', 'tóxico', 'chemical waste', 'residuo quimico', 'residuo químico',
    'battery', 'bateria', 'batería', 'pesticide', 'pesticida', 'herbicide',
    'herbicida', 'fungicide', 'fungicida', 'asbestos', 'asbesto', 'mercury',
    'mercurio', 'lead', 'plomo', 'oil waste', 'aceite usado',
  ],

  // --------------------------------------------------------------------------
  // CITES — Convención sobre el Comercio Internacional de Especies Amenazadas
  // --------------------------------------------------------------------------
  CITES_WILDLIFE: [
    'ivory', 'marfil', 'tortoise shell', 'carey', 'coral', 'coral reef',
    'crocodile', 'cocodrilo', 'python', 'piton', 'píton', 'lizard skin',
    'piel de lagarto', 'snake skin', 'piel de serpiente', 'shark fin',
    'aleta de tiburon', 'aleta de tiburón', 'rosewood', 'palisandro',
    'mahogany', 'caoba', 'ebony', 'ebano', 'ébano', 'parrot', 'perico',
    'macaw', 'guacamaya', 'orchid', 'orquidea', 'orquídea', 'cactus',
  ],

  // --------------------------------------------------------------------------
  // SEDENA — Secretaría de la Defensa Nacional
  // --------------------------------------------------------------------------
  SEDENA_WEAPONS: [
    'weapon', 'arma', 'gun', 'pistola', 'rifle', 'escopeta', 'shotgun',
    'ammunition', 'municion', 'munición', 'bullet', 'bala', 'cartridge',
    'cartucho', 'explosive', 'explosivo', 'dynamite', 'dinamita', 'grenade',
    'granada', 'tactical', 'tactico', 'táctico', 'armor', 'armadura',
    'ballistic', 'balistico', 'balístico', 'night vision', 'vision nocturna',
    'scope', 'mira', 'suppressor', 'silenciador', 'body armor', 'chaleco',
    'crossbow', 'ballesta', 'taser', 'pepper spray', 'gas pimienta',
    'knife', 'cuchillo', 'machete', 'sword', 'espada', 'bayonet', 'bayoneta',
    'dual use', 'uso dual', 'military', 'militar', 'paramilitary',
  ],

  // --------------------------------------------------------------------------
  // DIFFICULT IDENTIFICATION — Rule 3.7.3 explicit prohibition
  // Powders, liquids, pharmaceutical forms (fentanyl precursor risk)
  // --------------------------------------------------------------------------
  DIFFICULT_IDENTIFICATION: [
    'powder', 'polvo', 'dust', 'polvillo', 'liquid', 'liquido', 'líquido',
    'fluid', 'fluido', 'pill', 'pildora', 'píldora', 'pastilla', 'tablet',
    'tableta', 'capsule', 'capsula', 'cápsula', 'granule', 'gránulo',
    'granules', 'gragea', 'dragee', 'troche', 'lozenge', 'suppository',
    'supositorio', 'injection', 'inyeccion', 'inyección', 'ampoule', 'ampolla',
    'syrup', 'jarabe', 'suspension', 'suspensión', 'solution', 'solucion',
    'solución', 'ointment', 'ungüento', 'unguento', 'cream medicated',
    'crema medicamentosa', 'essential oil', 'aceite esencial', 'serum',
  ],

  // --------------------------------------------------------------------------
  // ZERO_VALUE — Rule 3.7.3: Zero value declarations are prohibited
  // --------------------------------------------------------------------------
  ZERO_VALUE: [], // Detected via numeric check, not keyword

  // --------------------------------------------------------------------------
  // GENERIC_DESCRIPTION — Rule 3.7.3: Overly generic descriptions prohibited
  // --------------------------------------------------------------------------
  GENERIC_DESCRIPTION: [
    'artículos diversos', 'articulos diversos', 'various items',
    'regalo', 'gift', 'cortesía', 'cortesia', 'courtesy', 'muestra gratis',
    'free sample', 'sample free', 'promotional', 'promocional', 'misc',
    'miscellaneous', 'sundries', 'surtido', 'assorted', 'mixed items',
    'personal belongings', 'pertenencias personales', 'household goods',
    'efectos personales', 'personal effects', 'varios', 'miscelaneos',
    'misceláneos', 'general merchandise', 'mercancia general',
    'mercancía general', 'unknown', 'desconocido', 'not specified',
    'no especificado',
  ],
};

/**
 * Human-readable labels for RRNA categories.
 */
export const RRNA_LABELS: Record<RRNACategory, { label: string; authority: string; description: string }> = {
  COFEPRIS_FOOD: {
    label: 'Alimento / Suplemento',
    authority: 'COFEPRIS',
    description: 'Requiere registro sanitario. Prohibido vía T1.',
  },
  COFEPRIS_COSMETICS: {
    label: 'Cosmético / Higiene',
    authority: 'COFEPRIS',
    description: 'Requiere registro sanitario. Prohibido vía T1.',
  },
  COFEPRIS_MEDICAL: {
    label: 'Dispositivo Médico',
    authority: 'COFEPRIS',
    description: 'Requiere autorización sanitaria. Prohibido vía T1.',
  },
  SENASICA_AGRICULTURAL: {
    label: 'Producto Agrícola',
    authority: 'SENASICA',
    description: 'Requiere permiso fitosanitario. Prohibido vía T1.',
  },
  SEMARNAT_ENVIRONMENTAL: {
    label: 'Materia Ambiental',
    authority: 'SEMARNAT',
    description: 'Requiere permiso ambiental. Prohibido vía T1.',
  },
  CITES_WILDLIFE: {
    label: 'Especie Protegida (CITES)',
    authority: 'SEMARNAT / CITES',
    description: 'Requiere permiso CITES. Prohibido vía T1.',
  },
  SEDENA_WEAPONS: {
    label: 'Arma / Material Bélico',
    authority: 'SEDENA',
    description: 'Requiere autorización de la Defensa. Prohibido vía T1.',
  },
  DIFFICULT_IDENTIFICATION: {
    label: 'Identificación Difícil',
    authority: 'ANAM / SAT',
    description: 'Polvos, líquidos, formas farmacéuticas. Prohibido vía T1 por riesgo de precursores.',
  },
  ZERO_VALUE: {
    label: 'Valor Cero',
    authority: 'ANAM / SAT',
    description: 'Declaración de valor cero prohibida por RGCE 3.7.3.',
  },
  GENERIC_DESCRIPTION: {
    label: 'Descripción Genérica',
    authority: 'ANAM / SAT',
    description: 'Descripciones como "artículos diversos" o "regalo" están prohibidas por RGCE 3.7.3.',
  },
};
