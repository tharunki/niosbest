import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-production-state-gate-'));
const port = 43000 + Math.floor(Math.random() * 1000);
const environment = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(port),
  PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory,
  // Mixed-case input must normalize, but a driver name alone must never make
  // production writes ready without all private storage credentials.
  STORAGE_DRIVER: 'SuPaBaSe',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_BUCKET: 'student-documents',
  SUPABASE_SERVICE_ROLE_KEY: ' ',
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
  ADMIN_API_TOKEN: 'b'.repeat(40),
  BOOTSTRAP_ADMIN_EMAIL: 'niosbest.tvl@gmail.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'a-production-only-test-password',
  ALLOW_DEMO_ACCOUNTS: 'false'
};
const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function waitForService() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return response;
    } catch { /* startup is still in progress */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Production gate server did not start. ${output}`);
}

try {
  const healthResponse = await waitForService();
  const health = await healthResponse.json();
  assert.equal(health.readyForWrites, false, 'local state is never write-ready in production');
  assert.equal(health.stateStore.driver, 'local');
  assert.equal(health.storage, 'supabase', 'storage driver is normalized once for health and runtime operations');
  assert.equal(health.durableFileStorage, false, 'incomplete remote-storage configuration must not unlock production writes');
  assert.equal(health.stateStore.writeReady, false, 'health does not advertise unsafe local production writes as ready');
  assert.equal(health.availability.applications.available, false, 'public status must warn that admissions are paused when durable writes are locked');
  assert.equal(health.availability.signIn.available, true, 'an operational pause must not hide existing account sign-in');
  const publicAvailability = await (await fetch(`http://127.0.0.1:${port}/api/public/availability`)).json();
  assert.equal(publicAvailability.applications.available, false, 'the public status endpoint mirrors the safe write gate without exposing credentials');
  assert.match(publicAvailability.applications.message, /temporarily paused/i);
  const registration = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Blocked Student', email: 'blocked@example.test', phone: '+919999999999', password: 'safe-test-password' })
  });
  const body = await registration.json();
  assert.equal(registration.status, 503, 'production registration is blocked without durable state');
  assert.equal(body.code, 'DURABLE_STATE_REQUIRED');
  assert.equal(body.availability.applications.available, false, 'blocked write responses include a safe recovery state for the interface');

  const invalidOwnerStateDirectory = await mkdtemp(join(tmpdir(), 'nios-production-owner-gate-'));
  const invalidOwner = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceDirectory,
    env: { ...environment, PORT: String(port + 1), PORTAL_STATE_DIR: invalidOwnerStateDirectory, BOOTSTRAP_ADMIN_EMAIL: 'unapproved-owner@example.test' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let invalidOwnerOutput = '';
  invalidOwner.stdout.on('data', chunk => { invalidOwnerOutput += chunk; });
  invalidOwner.stderr.on('data', chunk => { invalidOwnerOutput += chunk; });
  const invalidOwnerExitCode = await new Promise(resolvePromise => invalidOwner.once('exit', resolvePromise));
  await rm(invalidOwnerStateDirectory, { recursive: true, force: true });
  assert.notEqual(invalidOwnerExitCode, 0, 'an unapproved bootstrap owner must not start a production service');
  assert.match(invalidOwnerOutput, /protected academy owner address/i);
  console.log('production-durable-state-gate.test.mjs: 14 passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
