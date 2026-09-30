import { it, expect } from 'vitest';
process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.ENCRYPTION_KEY = '11'.repeat(32);
process.env.WORKER_TOKEN = 'test-token-'.repeat(4);
const { encrypt, decrypt, hashPassword, verifyPassword, tokenMatches } =
  await import('../apps/api/src/security.js');
it('encrypts secrets with authenticated, randomized encryption', () => {
  const a = encrypt('secret'),
    b = encrypt('secret');
  expect(a).not.toBe(b);
  expect(decrypt(a)).toBe('secret');
  const data = Buffer.from(a, 'base64');
  data[data.length - 1]! ^= 1;
  expect(() => decrypt(data.toString('base64'))).toThrow();
  expect(() => decrypt(a, '22'.repeat(32))).toThrow();
});
it('hashes passwords and compares setup tokens', async () => {
  const hash = await hashPassword('secure-password-123');
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(await verifyPassword(hash, 'secure-password-123')).toBe(true);
  expect(await verifyPassword(hash, 'wrong-password')).toBe(false);
  expect(tokenMatches('same', 'same')).toBe(true);
  expect(tokenMatches('different', 'same')).toBe(false);
});
