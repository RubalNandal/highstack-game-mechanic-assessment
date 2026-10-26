import { readFile } from 'node:fs/promises';
import { Store } from '@highstack/storage';
import { parseConfig } from '@highstack/bonus';
import { createApp } from './app.js';

const store = new Store(process.env.DATABASE_URL ?? 'postgres://operator:operator@localhost:5432/operator');
await store.migrate();
await store.seedPlayer();
const config = parseConfig(JSON.parse(await readFile(process.env.BONUS_CONFIG_PATH ?? 'configs/bonus.json', 'utf8')));
await store.saveConfig(config);
const app = await createApp(store, { engineUrl: process.env.ENGINE_URL ?? 'http://localhost:4000',
  operatorKey: process.env.OPERATOR_KEY ?? 'dev-operator-key', webhookSecret: process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
  config, staticRoot: 'client/dist' });
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); await store.close(); process.exit(0); });
