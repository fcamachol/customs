import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { extractFromText } from './index';

// Golden-fixture regression corpus for extractFromText(). Each <name>.txt is a pdf-parse TEXT
// output (not a PDF — the text layer is what the parsers actually consume, and what layout drift
// affects) paired with a <name>.expected.json pinning the CURRENT parser output. This is the
// pedimento-text equivalent of shared/parsing/manifestGolden.test.ts.
//
// The parser's git history is a series of per-layout regex patches, each risking a silent
// regression of the OTHER layout (see the extensive comments in shared/pedimento/parsePedimentoText.ts
// documenting exactly how the subdivision and consolidado layouts scatter tokens differently). This
// corpus exists to catch that: any regex change that shifts an anchor, a window size, or a capture
// group will show up here as a diff against a fixture that previously matched.
//
// IMPORTANT: expected JSONs pin *current* behavior, not necessarily *correct* behavior — some
// fields are honestly null because the parser has no anchor for that layout variant yet. A failing
// assertion here means "extraction changed," not automatically "extraction broke" — check whether
// the new value is more correct before updating the expected JSON. (subdivision-guia-valor's
// agentRfc used to be a documented known-wrong pin; see the fixtures README for the fix.)

const FIXTURES_DIR = join(__dirname, '__fixtures__');
const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter((f) => extname(f) === '.txt')
  .map((f) => f.slice(0, -'.txt'.length))
  .sort();

// Recursively asserts that `actual` matches `expected` at every key `expected` defines, but
// tolerates extra keys `actual` carries that `expected` doesn't mention — additive optional
// fields (e.g. a concurrent change adding ExtractedPedimentoLine.fraccion) must not break this
// corpus. Arrays are compared element-by-element at matching length (order and count are part of
// the pinned behavior for coveredGuias/lines/warnings/siblings).
function assertMatchesSubset(actual: unknown, expected: unknown, path = '$'): void {
  if (expected === null || typeof expected !== 'object') {
    expect(actual, `${path}`).toEqual(expected);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${path} should be an array`).toBe(true);
    const actualArr = actual as unknown[];
    expect(actualArr.length, `${path}.length`).toBe(expected.length);
    expected.forEach((item, i) => assertMatchesSubset(actualArr[i], item, `${path}[${i}]`));
    return;
  }
  expect(typeof actual === 'object' && actual !== null, `${path} should be an object`).toBe(true);
  const actualObj = actual as Record<string, unknown>;
  const expectedObj = expected as Record<string, unknown>;
  for (const key of Object.keys(expectedObj)) {
    assertMatchesSubset(actualObj[key], expectedObj[key], `${path}.${key}`);
  }
}

describe('golden: pedimento text extraction corpus', () => {
  it('found at least the seeded fixture cases', () => {
    // Guards against a typo silently shrinking the corpus to zero.
    expect(fixtureNames.length).toBeGreaterThanOrEqual(6);
  });

  for (const name of fixtureNames) {
    it(`extractFromText(${name}.txt) matches the pinned expected.json`, () => {
      const text = readFileSync(join(FIXTURES_DIR, `${name}.txt`), 'utf8');
      const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.expected.json`), 'utf8'));
      const actual = extractFromText(text);
      assertMatchesSubset(actual, expected);
    });
  }
});

describe('golden: known open question — consolidado FECHAS block lists PAGO before ENTRADA', () => {
  // parsePedimentoText.ts assumes the first dd/mm/yyyy after the FECHAS anchor is ENTRADA and the
  // second is PAGO. In every known consolidado sample (including consolidado-consignatario.txt,
  // modeled on a real capture) PAGO and ENTRADA carry the SAME date, so this assumption is
  // currently unobservable — there is no fixture where getting it backwards would show up as a
  // wrong value instead of a coincidentally-right one.
  //
  // If a real consolidado surfaces with PAGO != ENTRADA, add it as a new fixture: this is the test
  // that will start failing (because the pinned entryDate/paymentDate below would need a decision
  // about which is which), and that failure is the trigger to actually fix the assumption in
  // parsePedimentoText.ts rather than silently mis-labeling one of the two dates forever.
  it('pins entryDate === paymentDate for the consolidado fixture (dates are identical, so first-date=entrada is unverified)', () => {
    const text = readFileSync(join(FIXTURES_DIR, 'consolidado-consignatario.txt'), 'utf8');
    const out = extractFromText(text);
    expect(out.header.entryDate).toBe('2026-02-22');
    expect(out.header.paymentDate).toBe('2026-02-22');
    expect(out.header.entryDate).toBe(out.header.paymentDate); // documents the ambiguity, not a real invariant
  });
});
