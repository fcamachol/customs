import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/auth/password';

describe('password', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(hash).not.toBe('s3cret!');
    expect(await verifyPassword('s3cret!', hash)).toBe(true);
  });
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('s3cret!');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
