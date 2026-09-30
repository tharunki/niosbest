import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-email-readiness-gate-'));
const authPage = await readFile(resolve(serviceDirectory, '..', 'auth-v2.html'), 'utf8');
assert.match(authPage, /When account creation is available, we send a free six-digit code/i, 'the sign-up copy must not promise a code during an outage');
const portalPort = 46500 + Math.floor(Math.random() * 600);
const providerPort = portalPort + 700;
const providerRequests = [];
const fakeResend = createServer((request, response) => {
  providerRequests.push({ method: request.method, path: request.url, body: '' });
  request.on('data', chunk => { providerRequests.at(-1).body += chunk; });
  request.on('end', () => {
    if (request.method !== 'GET' || request.url !== '/domains') {
      response.writeHead(404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ error: 'unexpected request' }));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({ data: [{ name: 'academy.example', status: 'pending' }] }));
  });
});
await new Promise(resolvePromise => fakeResend.listen(providerPort, '127.0.0.1', resolvePromise));

const environment = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(portalPort), PORTAL_STATE_DRIVER: 'local', PORTAL_STATE_DIR: stateDirectory,
  STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock', NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual',
  ALLOW_DEMO_ACCOUNTS: 'false', APP_ENCRYPTION_KEY: 'a'.repeat(64),
  // This is an isolated QA-only path. It makes development enforce the same
  // verified-sender gate as production, while the fake server prevents email.
  ALLOW_DEVELOPMENT_OUTBOUND_DELIVERY: 'true', EMAIL_VERIFICATION_REQUIRE_PROVIDER_READINESS: 'true',
  RESEND_API_KEY: 'readiness-gate-test-key', EMAIL_VERIFICATION_FROM: 'Accounts <accounts@academy.example>',
  RESEND_API_BASE_URL: `http://127.0.0.1:${providerPort}`
};
const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function waitForService() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${portalPort}/api/health`)).ok) return; } catch { /* startup */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Email readiness gate service did not start. ${output}`);
}
async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${portalPort}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})) };
}
async function stopChild() {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
}

try {
  await waitForService();
  const availability = await api('/api/public/availability');
  assert.equal(availability.response.status, 200);
  assert.equal(availability.data.newAccounts.available, false, 'a pending sender domain must close public account creation');
  assert.match(availability.data.newAccounts.message, /temporarily unavailable/i);
  const publicPayload = JSON.stringify(availability.data);
  assert.equal(publicPayload.includes('academy.example'), false, 'public readiness must not disclose the sender domain');
  assert.equal(publicPayload.toLowerCase().includes('resend'), false, 'public readiness must not disclose the provider');

  const registration = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Blocked Email Student', email: 'blocked-email@example.test', phone: '+919876543210', password: 'safe-test-password' }
  });
  assert.equal(registration.response.status, 503, 'the API must fail closed while the sender domain is pending');
  assert.match(registration.data.error, /temporarily unavailable/i);
  assert.equal(JSON.stringify(registration.data).toLowerCase().includes('resend'), false, 'the blocked registration response must remain provider-neutral');

  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.users.some(user => user.email === 'blocked-email@example.test'), false, 'the gate must run before creating an unverified account');
  assert.deepEqual(providerRequests.map(request => ({ method: request.method, path: request.path, body: request.body })), [{ method: 'GET', path: '/domains', body: '' }], 'the readiness gate must make only the safe domain-list request');
  console.log('email-verification-readiness-gate.test.mjs: pending sender blocks public signup without email delivery or account creation');
} finally {
  await stopChild();
  await new Promise(resolvePromise => fakeResend.close(resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
