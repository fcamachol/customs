/**
 * Security regression tests — ensure deleted crypto/seal symbols don't silently return.
 *
 * Background: The legacy "toy seal" (simpleHash, generateVistoBueno, VB- prefix)
 * was deleted in F15. This test ensures no shipped source accidentally reintroduces them.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

describe('Security: Deleted toy-seal regression', () => {
  it('deleted simpleHash does not appear in shipped source', () => {
    const projectRoot = join(__dirname, '..');
    const srcDir = join(projectRoot, 'src');
    const serverSrcDir = join(projectRoot, 'server', 'src');

    const grepCmd = `grep -r "simpleHash" "${srcDir}" "${serverSrcDir}" 2>/dev/null || true`;
    const result = execSync(grepCmd, { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line && !line.includes('.test.') && !line.includes('node_modules'));

    expect(result, 'simpleHash must not exist in shipped source').toEqual([]);
  });

  it('deleted generateVistoBueno does not appear in shipped source', () => {
    const projectRoot = join(__dirname, '..');
    const srcDir = join(projectRoot, 'src');
    const serverSrcDir = join(projectRoot, 'server', 'src');

    const grepCmd = `grep -r "generateVistoBueno" "${srcDir}" "${serverSrcDir}" 2>/dev/null || true`;
    const result = execSync(grepCmd, { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line && !line.includes('.test.') && !line.includes('node_modules'));

    expect(result, 'generateVistoBueno must not exist in shipped source').toEqual([]);
  });

  it('deleted VB- seal prefix does not appear in shipped source', () => {
    const projectRoot = join(__dirname, '..');
    const srcDir = join(projectRoot, 'src');
    const serverSrcDir = join(projectRoot, 'server', 'src');

    const grepCmd = `grep -r "VB-" "${srcDir}" "${serverSrcDir}" 2>/dev/null || true`;
    const result = execSync(grepCmd, { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line && !line.includes('.test.') && !line.includes('node_modules'));

    expect(result, 'VB- seal prefix must not exist in shipped source').toEqual([]);
  });
});
