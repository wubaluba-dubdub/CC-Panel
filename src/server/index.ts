import { loadEnv } from './env.js';
import { buildServer } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const app = await buildServer({ env });

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
