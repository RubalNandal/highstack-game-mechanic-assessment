/**
 * Start the casino/operator: prepare Postgres, preserve or create the demo wallet, and serve the API/client.
 * Only this application constructs Store; the engine reaches it through the private operator API.
 */
import { readFile } from 'node:fs/promises';
import { Store } from '@highstack/storage';
import { parseConfig } from '@highstack/bonus';
import { createApp } from './app.js';

const store = new Store(
  process.env.DATABASE_URL ?? 'postgres://operator:operator@localhost:5432/operator',
);
await store.migrate();
await store.seedPlayer();
/**
 * Read and validate the JSON file at startup and for each new round.
 * Invalid JSON/settings throw; existing rounds retain their saved snapshots.
 */
async function loadConfig() {
  return parseConfig(
    JSON.parse(await readFile(process.env.BONUS_CONFIG_PATH ?? 'configs/bonus.json', 'utf8')),
  );
}
const config = await loadConfig();
await store.saveConfig(config);
const app = await createApp(store, {
  engineUrl: process.env.ENGINE_URL ?? 'http://localhost:4000',
  operatorKey: process.env.OPERATOR_KEY ?? 'dev-operator-key',
  webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
  config,
  loadConfig,
  staticRoot: 'client/dist',
});
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await store.close();
    process.exit(0);
  });
