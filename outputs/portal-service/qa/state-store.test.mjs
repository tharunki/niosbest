import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStateStore, resolveStateStoreConfig, StateStoreError, supabaseStateDiagnosticNextAction } from '../state-store.mjs';

let passed = 0;
function ok(value, message) { assert.ok(value, message); passed += 1; }

function memorySupabase() {
  let row = null, conflictOnce = true;
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname !== '/rest/v1/portal_state') return new Response('not found', { status: 404 });
    if (options.method === 'POST') {
      if (!row) row = JSON.parse(options.body);
      return new Response(JSON.stringify(row ? [row] : []), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (options.method === 'PATCH') {
      const expected = Number(String(url.searchParams.get('revision') || '').replace(/^eq\./, ''));
      if (conflictOnce) { conflictOnce = false; row = { ...row, revision: row.revision + 1, state: { ...row.state, external: true } }; return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); }
      if (!row || row.revision !== expected) return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      const next = JSON.parse(options.body);
      row = { ...row, ...next };
      return new Response(JSON.stringify([row]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!options.method || options.method === 'GET') return new Response(JSON.stringify(row ? [row] : []), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('method not allowed', { status: 405 });
  };
}

try {
  assert.throws(() => resolveStateStoreConfig({ env: { PORTAL_STATE_DRIVER: 'supabase' }, isProduction: true, localFilePath: 'unused' }), StateStoreError);
  passed += 1;
  assert.throws(() => resolveStateStoreConfig({ env: { PORTAL_STATE_DRIVER: 'supabase', SUPABASE_URL: 'http://example.test', SUPABASE_SERVICE_ROLE_KEY: 'server-only' }, isProduction: true, localFilePath: 'unused' }), StateStoreError);
  passed += 1;
  ok(supabaseStateDiagnosticNextAction({ stateDriver: 'supabase', tableExists: true, bucketExists: true, bucketPrivate: true, stateRowInitialized: true }) === 'Supabase state and private storage are reachable. This deployment is already using durable Supabase state.', 'Supabase-backed deployments are not told to switch their state driver again');
  ok(supabaseStateDiagnosticNextAction({ stateDriver: 'local', tableExists: true, bucketExists: true, bucketPrivate: true, stateRowInitialized: true }).includes('Switch PORTAL_STATE_DRIVER'), 'local deployments still receive the explicit transition instruction');

  const directory = await mkdtemp(join(tmpdir(), 'nios-state-store-'));
  try {
    const local = await createStateStore(resolveStateStoreConfig({ env: { PORTAL_STATE_DRIVER: 'local' }, isProduction: false, localFilePath: join(directory, 'state.json') }));
    await local.ensure({ counter: 0, users: [] });
    await Promise.all([local.update(state => { state.counter += 1; }), local.update(state => { state.counter += 1; })]);
    ok((await local.read()).counter === 2, 'local store serializes concurrent updates');
  } finally { await rm(directory, { recursive: true, force: true }); }

  const config = resolveStateStoreConfig({
    env: { PORTAL_STATE_DRIVER: 'supabase', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'server-only-secret' },
    isProduction: true,
    localFilePath: 'unused'
  });
  const remote = await createStateStore(config, { fetchImpl: memorySupabase() });
  await remote.ensure({ counter: 0, users: [] });
  await remote.update(state => { state.counter += 1; });
  const result = await remote.read();
  ok(result.counter === 1, 'Supabase store retries an optimistic-revision conflict');
  ok(result.external === true, 'Supabase store retains an external concurrent update');
  ok(remote.publicStatus().durable === true && remote.publicStatus().writeReady === true, 'Supabase store reports durable write readiness');

  let observedHeaders = null;
  const modernKeyConfig = resolveStateStoreConfig({
    env: { PORTAL_STATE_DRIVER: 'supabase', SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test_key' },
    isProduction: true,
    localFilePath: 'unused'
  });
  const modernKeyStore = await createStateStore(modernKeyConfig, {
    fetchImpl: async (_input, options = {}) => {
      observedHeaders = options.headers;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await assert.rejects(modernKeyStore.read(), StateStoreError);
  ok(observedHeaders.apikey === 'sb_secret_test_key' && !('authorization' in observedHeaders), 'Supabase sb_secret keys are never sent as invalid Bearer JWTs');
  console.log(`state-store.test.mjs: ${passed} passed`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
