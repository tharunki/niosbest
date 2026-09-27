// One-time, operator-invoked migration helper. It intentionally refuses to
// overwrite an existing Supabase state row and never prints state contents.
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore, resolveStateStoreConfig, StateStoreError } from '../state-store.mjs';

function count(value) { return Array.isArray(value) ? value.length : 0; }
const serviceDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));

async function loadLocalEnv() {
  try {
    const text = await readFile(join(serviceDirectory, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional; deployment environments use their own secrets. */ }
}

await loadLocalEnv();

try {
  if (process.env.IMPORT_PORTAL_STATE !== 'confirm') throw new Error('Set IMPORT_PORTAL_STATE=confirm to run this one-time migration.');
  const sourceValue = String(process.env.PORTAL_STATE_IMPORT_FILE || '').trim();
  if (!sourceValue) throw new Error('Set PORTAL_STATE_IMPORT_FILE to the old local state.json file.');
  const source = resolve(sourceValue);
  const details = await stat(source);
  if (!details.isFile()) throw new Error('PORTAL_STATE_IMPORT_FILE must point to a JSON file.');
  const state = JSON.parse(await readFile(source, 'utf8'));
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('The import file must contain a portal state object.');

  const config = resolveStateStoreConfig({ env: process.env, isProduction: true, localFilePath: source });
  if (config.driver !== 'supabase') throw new Error('Set PORTAL_STATE_DRIVER=supabase before importing.');
  const store = await createStateStore(config);
  try {
    await store.read();
    throw new Error('The Supabase portal_state row already exists. Refusing to overwrite it. Restore from a verified backup only through an explicit recovery procedure.');
  } catch (error) {
    if (!(error instanceof StateStoreError) || error.code !== 'SUPABASE_STATE_NOT_INITIALIZED') throw error;
  }
  await store.ensure(state);
  const migrated = await store.read();
  console.log(JSON.stringify({
    ok: true,
    message: 'Local portal state was copied to an empty Supabase state row.',
    counts: {
      users: count(migrated.users), students: count(migrated.students), enrollments: count(migrated.enrollments),
      payments: count(migrated.payments), admissionDocuments: count(migrated.admissionDocuments), batches: count(migrated.batches)
    }
  }));
} catch (error) {
  console.error(error?.message || 'Portal-state migration failed.');
  process.exitCode = 1;
}
