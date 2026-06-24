import 'dotenv/config';
import { createApp } from './app';
import { getJWTSecret } from './auth/token';

if (process.env.NODE_ENV === 'production') {
  // Validate JWT_SECRET by calling the shared resolver (fail-closed default).
  getJWTSecret();

  // RNF-05: Validate FIELD_ENCRYPTION_KEY before accepting any traffic.
  const fek = process.env.FIELD_ENCRYPTION_KEY;
  if (!fek) {
    throw new Error(
      'FIELD_ENCRYPTION_KEY must be set in production. Generate with: openssl rand -base64 32',
    );
  }
  const fekBytes = Buffer.from(fek, 'base64');
  if (fekBytes.length !== 32) {
    throw new Error(
      `FIELD_ENCRYPTION_KEY must decode to 32 bytes (got ${fekBytes.length}). Generate with: openssl rand -base64 32`,
    );
  }
}

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`API listening on :${port}`);
});
