import 'dotenv/config';
import { createApp } from './app';

if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production')) {
  throw new Error('JWT_SECRET must be set to a non-default value in production');
}

const port = Number(process.env.PORT ?? 4000);
createApp().listen(port, () => {
  console.log(`API listening on :${port}`);
});
