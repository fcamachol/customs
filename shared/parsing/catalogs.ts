// Static país / ISO-4217 / weight-unit catalogs for ingestion normalization.
// País list follows the ANAM aduana catalog (Anexo 22, Apéndice 4): 2-letter "clave de
// país", aligned with ISO 3166-1 alpha-2. Code-with-name-fallback: prefer a clave, else
// map a Spanish/English name. `aliases` carry alternate spellings seen in real feeds.

const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

interface CountryEntry { code: string; name: string; aliases?: string[]; }

// ANAM país catalog (clave alpha-2 + canonical Spanish name). Sorted alphabetically by name.
// Extend `aliases` as real manifests surface new spellings; add ANAM special claves here.
const COUNTRIES: CountryEntry[] = [
  { code: 'AF', name: 'Afganistán', aliases: ['afghanistan'] },
  { code: 'AL', name: 'Albania' },
  { code: 'DE', name: 'Alemania', aliases: ['germany'] },
  { code: 'AD', name: 'Andorra' },
  { code: 'AO', name: 'Angola' },
  { code: 'AI', name: 'Anguila', aliases: ['anguilla'] },
  { code: 'AQ', name: 'Antártida', aliases: ['antarctica'] },
  { code: 'AG', name: 'Antigua y Barbuda' },
  { code: 'SA', name: 'Arabia Saudita', aliases: ['saudi arabia'] },
  { code: 'DZ', name: 'Argelia', aliases: ['algeria'] },
  { code: 'AR', name: 'Argentina' },
  { code: 'AM', name: 'Armenia' },
  { code: 'AW', name: 'Aruba' },
  { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' },
  { code: 'AZ', name: 'Azerbaiyán', aliases: ['azerbaijan'] },
  { code: 'BS', name: 'Bahamas' },
  { code: 'BD', name: 'Bangladés', aliases: ['bangladesh'] },
  { code: 'BB', name: 'Barbados' },
  { code: 'BH', name: 'Baréin', aliases: ['bahrein', 'bahrain'] },
  { code: 'BE', name: 'Bélgica', aliases: ['belgium'] },
  { code: 'BZ', name: 'Belice', aliases: ['belize'] },
  { code: 'BJ', name: 'Benín', aliases: ['benin'] },
  { code: 'BM', name: 'Bermudas', aliases: ['bermuda'] },
  { code: 'BY', name: 'Bielorrusia', aliases: ['belarus'] },
  { code: 'BO', name: 'Bolivia' },
  { code: 'BA', name: 'Bosnia y Herzegovina', aliases: ['bosnia'] },
  { code: 'BW', name: 'Botsuana', aliases: ['botswana'] },
  { code: 'BR', name: 'Brasil', aliases: ['brazil'] },
  { code: 'BN', name: 'Brunéi', aliases: ['brunei'] },
  { code: 'BG', name: 'Bulgaria' },
  { code: 'BF', name: 'Burkina Faso' },
  { code: 'BI', name: 'Burundi' },
  { code: 'BT', name: 'Bután', aliases: ['bhutan'] },
  { code: 'CV', name: 'Cabo Verde', aliases: ['cape verde'] },
  { code: 'KH', name: 'Camboya', aliases: ['cambodia'] },
  { code: 'CM', name: 'Camerún', aliases: ['cameroon'] },
  { code: 'CA', name: 'Canadá', aliases: ['canada'] },
  { code: 'QA', name: 'Catar', aliases: ['qatar'] },
  { code: 'TD', name: 'Chad' },
  { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China', aliases: ['porcelana', 'china continental', "people's republic of china"] },
  { code: 'CY', name: 'Chipre', aliases: ['cyprus'] },
  { code: 'CO', name: 'Colombia' },
  { code: 'KM', name: 'Comoras', aliases: ['comoros'] },
  { code: 'CG', name: 'Congo', aliases: ['republic of the congo'] },
  { code: 'CD', name: 'Congo (República Democrática)', aliases: ['rd congo', 'democratic republic of the congo'] },
  { code: 'KP', name: 'Corea del Norte', aliases: ['north korea'] },
  { code: 'KR', name: 'Corea del Sur', aliases: ['corea', 'south korea', 'korea'] },
  { code: 'CI', name: 'Costa de Marfil', aliases: ['cote divoire', 'ivory coast'] },
  { code: 'CR', name: 'Costa Rica' },
  { code: 'HR', name: 'Croacia', aliases: ['croatia'] },
  { code: 'CU', name: 'Cuba' },
  { code: 'CW', name: 'Curazao', aliases: ['curacao'] },
  { code: 'DK', name: 'Dinamarca', aliases: ['denmark'] },
  { code: 'DM', name: 'Dominica' },
  { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egipto', aliases: ['egypt'] },
  { code: 'SV', name: 'El Salvador' },
  { code: 'AE', name: 'Emiratos Árabes Unidos', aliases: ['united arab emirates', 'uae'] },
  { code: 'ER', name: 'Eritrea' },
  { code: 'SK', name: 'Eslovaquia', aliases: ['slovakia'] },
  { code: 'SI', name: 'Eslovenia', aliases: ['slovenia'] },
  { code: 'ES', name: 'España', aliases: ['spain'] },
  { code: 'US', name: 'Estados Unidos', aliases: ['estados unidos de america', 'eua', 'ee uu', 'usa', 'united states', 'united states of america'] },
  { code: 'EE', name: 'Estonia' },
  { code: 'ET', name: 'Etiopía', aliases: ['ethiopia'] },
  { code: 'PH', name: 'Filipinas', aliases: ['philippines'] },
  { code: 'FI', name: 'Finlandia', aliases: ['finland'] },
  { code: 'FJ', name: 'Fiyi', aliases: ['fiji'] },
  { code: 'FR', name: 'Francia', aliases: ['france'] },
  { code: 'GA', name: 'Gabón', aliases: ['gabon'] },
  { code: 'GM', name: 'Gambia' },
  { code: 'GE', name: 'Georgia' },
  { code: 'GH', name: 'Ghana' },
  { code: 'GI', name: 'Gibraltar' },
  { code: 'GD', name: 'Granada', aliases: ['grenada'] },
  { code: 'GR', name: 'Grecia', aliases: ['greece'] },
  { code: 'GL', name: 'Groenlandia', aliases: ['greenland'] },
  { code: 'GP', name: 'Guadalupe', aliases: ['guadeloupe'] },
  { code: 'GU', name: 'Guam' },
  { code: 'GT', name: 'Guatemala' },
  { code: 'GF', name: 'Guayana Francesa', aliases: ['french guiana'] },
  { code: 'GG', name: 'Guernsey' },
  { code: 'GN', name: 'Guinea' },
  { code: 'GQ', name: 'Guinea Ecuatorial', aliases: ['equatorial guinea'] },
  { code: 'GW', name: 'Guinea-Bisáu', aliases: ['guinea bissau'] },
  { code: 'GY', name: 'Guyana' },
  { code: 'HT', name: 'Haití', aliases: ['haiti'] },
  { code: 'HN', name: 'Honduras' },
  { code: 'HK', name: 'Hong Kong' },
  { code: 'HU', name: 'Hungría', aliases: ['hungary'] },
  { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'IQ', name: 'Irak', aliases: ['iraq'] },
  { code: 'IR', name: 'Irán', aliases: ['iran'] },
  { code: 'IE', name: 'Irlanda', aliases: ['ireland'] },
  { code: 'BV', name: 'Isla Bouvet', aliases: ['bouvet island'] },
  { code: 'IM', name: 'Isla de Man', aliases: ['isle of man'] },
  { code: 'CX', name: 'Isla de Navidad', aliases: ['christmas island'] },
  { code: 'NF', name: 'Isla Norfolk', aliases: ['norfolk island'] },
  { code: 'IS', name: 'Islandia', aliases: ['iceland'] },
  { code: 'KY', name: 'Islas Caimán', aliases: ['cayman islands'] },
  { code: 'CC', name: 'Islas Cocos', aliases: ['cocos islands', 'keeling islands'] },
  { code: 'CK', name: 'Islas Cook', aliases: ['cook islands'] },
  { code: 'FO', name: 'Islas Feroe', aliases: ['faroe islands'] },
  { code: 'GS', name: 'Islas Georgias del Sur y Sandwich del Sur', aliases: ['south georgia'] },
  { code: 'FK', name: 'Islas Malvinas', aliases: ['falkland islands'] },
  { code: 'MP', name: 'Islas Marianas del Norte', aliases: ['northern mariana islands'] },
  { code: 'MH', name: 'Islas Marshall', aliases: ['marshall islands'] },
  { code: 'PN', name: 'Islas Pitcairn', aliases: ['pitcairn'] },
  { code: 'SB', name: 'Islas Salomón', aliases: ['solomon islands'] },
  { code: 'TC', name: 'Islas Turcas y Caicos', aliases: ['turks and caicos'] },
  { code: 'VG', name: 'Islas Vírgenes Británicas', aliases: ['british virgin islands'] },
  { code: 'VI', name: 'Islas Vírgenes de los Estados Unidos', aliases: ['us virgin islands'] },
  { code: 'IL', name: 'Israel' },
  { code: 'IT', name: 'Italia', aliases: ['italy'] },
  { code: 'JM', name: 'Jamaica' },
  { code: 'JP', name: 'Japón', aliases: ['japan'] },
  { code: 'JE', name: 'Jersey' },
  { code: 'JO', name: 'Jordania', aliases: ['jordan'] },
  { code: 'KZ', name: 'Kazajistán', aliases: ['kazakhstan'] },
  { code: 'KE', name: 'Kenia', aliases: ['kenya'] },
  { code: 'KG', name: 'Kirguistán', aliases: ['kyrgyzstan'] },
  { code: 'KI', name: 'Kiribati' },
  { code: 'KW', name: 'Kuwait' },
  { code: 'LA', name: 'Laos' },
  { code: 'LS', name: 'Lesoto', aliases: ['lesotho'] },
  { code: 'LV', name: 'Letonia', aliases: ['latvia'] },
  { code: 'LB', name: 'Líbano', aliases: ['lebanon'] },
  { code: 'LR', name: 'Liberia' },
  { code: 'LY', name: 'Libia', aliases: ['libya'] },
  { code: 'LI', name: 'Liechtenstein' },
  { code: 'LT', name: 'Lituania', aliases: ['lithuania'] },
  { code: 'LU', name: 'Luxemburgo', aliases: ['luxembourg'] },
  { code: 'MO', name: 'Macao', aliases: ['macau'] },
  { code: 'MK', name: 'Macedonia del Norte', aliases: ['north macedonia', 'macedonia'] },
  { code: 'MG', name: 'Madagascar' },
  { code: 'MY', name: 'Malasia', aliases: ['malaysia'] },
  { code: 'MW', name: 'Malaui', aliases: ['malawi'] },
  { code: 'MV', name: 'Maldivas', aliases: ['maldives'] },
  { code: 'ML', name: 'Malí', aliases: ['mali'] },
  { code: 'MT', name: 'Malta' },
  { code: 'MA', name: 'Marruecos', aliases: ['morocco'] },
  { code: 'MQ', name: 'Martinica', aliases: ['martinique'] },
  { code: 'MU', name: 'Mauricio', aliases: ['mauritius'] },
  { code: 'MR', name: 'Mauritania' },
  { code: 'YT', name: 'Mayotte' },
  { code: 'MX', name: 'México', aliases: ['estados unidos mexicanos'] },
  { code: 'FM', name: 'Micronesia' },
  { code: 'MD', name: 'Moldavia', aliases: ['moldova'] },
  { code: 'MC', name: 'Mónaco', aliases: ['monaco'] },
  { code: 'MN', name: 'Mongolia' },
  { code: 'ME', name: 'Montenegro' },
  { code: 'MS', name: 'Montserrat' },
  { code: 'MZ', name: 'Mozambique' },
  { code: 'MM', name: 'Myanmar', aliases: ['birmania', 'burma'] },
  { code: 'NA', name: 'Namibia' },
  { code: 'NR', name: 'Nauru' },
  { code: 'NP', name: 'Nepal' },
  { code: 'NI', name: 'Nicaragua' },
  { code: 'NE', name: 'Níger', aliases: ['niger'] },
  { code: 'NG', name: 'Nigeria' },
  { code: 'NU', name: 'Niue' },
  { code: 'NO', name: 'Noruega', aliases: ['norway'] },
  { code: 'NC', name: 'Nueva Caledonia', aliases: ['new caledonia'] },
  { code: 'NZ', name: 'Nueva Zelanda', aliases: ['new zealand'] },
  { code: 'OM', name: 'Omán', aliases: ['oman'] },
  { code: 'NL', name: 'Países Bajos', aliases: ['holanda', 'netherlands', 'holland'] },
  { code: 'PK', name: 'Pakistán', aliases: ['pakistan'] },
  { code: 'PW', name: 'Palaos', aliases: ['palau'] },
  { code: 'PS', name: 'Palestina', aliases: ['palestine'] },
  { code: 'PA', name: 'Panamá', aliases: ['panama'] },
  { code: 'PG', name: 'Papúa Nueva Guinea', aliases: ['papua new guinea'] },
  { code: 'PY', name: 'Paraguay' },
  { code: 'PE', name: 'Perú', aliases: ['peru'] },
  { code: 'PF', name: 'Polinesia Francesa', aliases: ['french polynesia'] },
  { code: 'PL', name: 'Polonia', aliases: ['poland'] },
  { code: 'PT', name: 'Portugal' },
  { code: 'PR', name: 'Puerto Rico' },
  { code: 'GB', name: 'Reino Unido', aliases: ['united kingdom', 'inglaterra', 'gran bretaña', 'great britain', 'uk', 'england'] },
  { code: 'CF', name: 'República Centroafricana', aliases: ['central african republic'] },
  { code: 'CZ', name: 'República Checa', aliases: ['chequia', 'czech republic', 'czechia'] },
  { code: 'DO', name: 'República Dominicana', aliases: ['dominican republic'] },
  { code: 'RE', name: 'Reunión', aliases: ['reunion'] },
  { code: 'RW', name: 'Ruanda', aliases: ['rwanda'] },
  { code: 'RO', name: 'Rumanía', aliases: ['rumania', 'romania'] },
  { code: 'RU', name: 'Rusia', aliases: ['russia', 'federacion rusa'] },
  { code: 'EH', name: 'Sáhara Occidental', aliases: ['western sahara'] },
  { code: 'WS', name: 'Samoa' },
  { code: 'AS', name: 'Samoa Americana', aliases: ['american samoa'] },
  { code: 'BL', name: 'San Bartolomé', aliases: ['saint barthelemy'] },
  { code: 'KN', name: 'San Cristóbal y Nieves', aliases: ['saint kitts and nevis'] },
  { code: 'SM', name: 'San Marino' },
  { code: 'MF', name: 'San Martín', aliases: ['saint martin'] },
  { code: 'PM', name: 'San Pedro y Miquelón', aliases: ['saint pierre and miquelon'] },
  { code: 'VC', name: 'San Vicente y las Granadinas', aliases: ['saint vincent and the grenadines'] },
  { code: 'SH', name: 'Santa Elena', aliases: ['saint helena'] },
  { code: 'LC', name: 'Santa Lucía', aliases: ['saint lucia'] },
  { code: 'ST', name: 'Santo Tomé y Príncipe', aliases: ['sao tome and principe'] },
  { code: 'SN', name: 'Senegal' },
  { code: 'RS', name: 'Serbia' },
  { code: 'SC', name: 'Seychelles' },
  { code: 'SL', name: 'Sierra Leona', aliases: ['sierra leone'] },
  { code: 'SG', name: 'Singapur', aliases: ['singapore'] },
  { code: 'SX', name: 'Sint Maarten' },
  { code: 'SY', name: 'Siria', aliases: ['syria'] },
  { code: 'SO', name: 'Somalia' },
  { code: 'LK', name: 'Sri Lanka' },
  { code: 'ZA', name: 'Sudáfrica', aliases: ['south africa'] },
  { code: 'SD', name: 'Sudán', aliases: ['sudan'] },
  { code: 'SS', name: 'Sudán del Sur', aliases: ['south sudan'] },
  { code: 'SE', name: 'Suecia', aliases: ['sweden'] },
  { code: 'CH', name: 'Suiza', aliases: ['switzerland'] },
  { code: 'SR', name: 'Surinam', aliases: ['suriname'] },
  { code: 'SJ', name: 'Svalbard y Jan Mayen' },
  { code: 'SZ', name: 'Esuatini', aliases: ['suazilandia', 'eswatini', 'swaziland'] },
  { code: 'TH', name: 'Tailandia', aliases: ['thailand'] },
  { code: 'TW', name: 'Taiwán', aliases: ['taiwan'] },
  { code: 'TZ', name: 'Tanzania' },
  { code: 'TJ', name: 'Tayikistán', aliases: ['tajikistan'] },
  { code: 'IO', name: 'Territorio Británico del Océano Índico', aliases: ['british indian ocean territory'] },
  { code: 'TF', name: 'Territorios Australes Franceses', aliases: ['french southern territories'] },
  { code: 'TL', name: 'Timor-Leste', aliases: ['timor oriental', 'east timor'] },
  { code: 'TG', name: 'Togo' },
  { code: 'TK', name: 'Tokelau' },
  { code: 'TO', name: 'Tonga' },
  { code: 'TT', name: 'Trinidad y Tobago', aliases: ['trinidad and tobago'] },
  { code: 'TN', name: 'Túnez', aliases: ['tunisia'] },
  { code: 'TM', name: 'Turkmenistán', aliases: ['turkmenistan'] },
  { code: 'TR', name: 'Turquía', aliases: ['turkey', 'türkiye'] },
  { code: 'TV', name: 'Tuvalu' },
  { code: 'UA', name: 'Ucrania', aliases: ['ukraine'] },
  { code: 'UG', name: 'Uganda' },
  { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistán', aliases: ['uzbekistan'] },
  { code: 'VU', name: 'Vanuatu' },
  { code: 'VA', name: 'Ciudad del Vaticano', aliases: ['vaticano', 'vatican'] },
  { code: 'VE', name: 'Venezuela' },
  { code: 'VN', name: 'Vietnam' },
  { code: 'WF', name: 'Wallis y Futuna', aliases: ['wallis and futuna'] },
  { code: 'YE', name: 'Yemen' },
  { code: 'DJ', name: 'Yibuti', aliases: ['djibouti'] },
  { code: 'ZM', name: 'Zambia' },
  { code: 'ZW', name: 'Zimbabue', aliases: ['zimbabwe'] },
  { code: 'AX', name: 'Islas Åland', aliases: ['aland islands'] },
];

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
const COUNTRY_DISPLAY: Record<string, string> = {};
const COUNTRY_BY_NAME: Record<string, string> = {};
for (const { code, name, aliases } of COUNTRIES) {
  COUNTRY_DISPLAY[code] = name;
  COUNTRY_BY_NAME[norm(name)] = code;
  for (const a of aliases ?? []) COUNTRY_BY_NAME[norm(a)] = code;
}

/** SearchSelect options for the ANAM país catalog, sorted by Spanish name. */
export const ANAM_COUNTRY_OPTIONS: { value: string; label: string }[] = COUNTRIES
  .slice()
  .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  .map((c) => ({ value: c.code, label: `${c.name} (${c.code})` }));

/** Clave → canonical Spanish name. Falls back to the raw code so legacy free-text still renders. */
export function countryDisplayName(code: string): string {
  const raw = (code ?? '').trim();
  if (!raw) return '';
  return COUNTRY_DISPLAY[raw.toUpperCase()] ?? raw;
}

export function resolveCountry(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 2 && COUNTRY_CODES.has(upper)) return upper;
  return COUNTRY_BY_NAME[norm(raw)] ?? null;
}

const CURRENCY_NAMES: Record<string, string[]> = {
  USD: ['dolar estadounidense', 'dolar', 'us dollar', 'dolares'],
  MXN: ['peso mexicano', 'pesos'],
  EUR: ['euro'],
  CAD: ['dolar canadiense'],
};
const CURRENCY_CODES = new Set(Object.keys(CURRENCY_NAMES));
const CURRENCY_BY_NAME: Record<string, string> = {};
for (const [code, names] of Object.entries(CURRENCY_NAMES)) for (const n of names) CURRENCY_BY_NAME[norm(n)] = code;

export function resolveCurrency(codeOrName: string): string | null {
  const raw = (codeOrName ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.length === 3 && CURRENCY_CODES.has(upper)) return upper;
  return CURRENCY_BY_NAME[norm(raw)] ?? null;
}

// unit token → kg multiplier.
const WEIGHT_FACTORS: Record<string, number> = {
  mg: 0.000001,
  g: 0.001, gr: 0.001, gram: 0.001, grams: 0.001, gramo: 0.001, gramos: 0.001,
  kg: 1, kgs: 1, kilogramo: 1, kilogramos: 1, kilo: 1, kilos: 1,
  t: 1000, ton: 1000, tonelada: 1000, toneladas: 1000,
  lb: 0.453592, lbs: 0.453592, libra: 0.453592, libras: 0.453592, pound: 0.453592,
  oz: 0.0283495, onza: 0.0283495, onzas: 0.0283495, ounce: 0.0283495,
};

export function weightFactorToKg(unit: string): number | null {
  const u = norm(unit);
  if (!u) return null;
  return WEIGHT_FACTORS[u] ?? null;
}
