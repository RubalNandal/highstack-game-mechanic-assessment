import { readFile } from 'node:fs/promises';
import { Store } from '@highstack/storage';
import { parseConfig } from '@highstack/bonus';

export const store = new Store(process.env.DATABASE_URL ?? 'postgres://operator:operator@localhost:5432/operator');

export async function loadBonusConfig() {
  const input = JSON.parse(await readFile(process.env.BONUS_CONFIG_PATH ?? 'configs/bonus.json', 'utf8'));
  return store.saveConfig(parseConfig(input));
}
