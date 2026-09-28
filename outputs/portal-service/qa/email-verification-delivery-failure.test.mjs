import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-email-delivery-failure-'));
const firstPort = 45500 + Math.floor(Math.random() * 400);
const secondPort = firstPort + 401;
const sharedEnvironment = {
  ...process.env,
  NODE_ENV: 'development', PORTAL_STATE_DRIVER: 'local', PORTAL_STATE_DIR: stateDirectory,
  STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock', NOTIFICATION_PROVIDER: 'mock',
  NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'false', APP_ENCRYPTION_KEY: 'a'.repeat(64),
  // This explicit mode is local-test-only and prevents any network email call.
  EMAIL_VERIFICATION_TEST_MODE: 'true'
};

function start(port, deliveryFailure) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: serviceDirectory,
    env: { ...sharedEnvironment, PORT: String(port), EMAIL_VERIFICATION_TEST_DELIVERY_FAILURE: deliveryFailure ? 'true' : 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { child, output: () => output };
}
async function waitForService(port, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Delivery-failure test service did not start. ${output()}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
}
async function post(port, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { response, data: await response.json().catch(() => ({})) };
}

let first = null;
let second = null;
try {
  first = start(firstPort, false);
  await waitForService(firstPort, first.output);
  const email = 'delivery-retry@example.test';
  const registration = await post(firstPort, '/api/auth/register', {
    name: 'Delivery Retry Student', email, phone: '+919876543210', password: 'initial-registration-password'
  });
  assert.equal(registration.response.status, 202);
  assert.match(registration.data.testCode, /^\d{6}$/);
  const before = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  const beforeUser = before.users.find(user => user.email === email);
  assert.ok(beforeUser?.emailVerification?.codeHash);
  const beforeHash = beforeUser.emailVerification.codeHash;

  await stop(first.child);
  first = null;
  second = start(secondPort, true);
  await waitForService(secondPort, second.output);
  const resend = await post(secondPort, '/api/auth/email-verification/resend', { email });
  assert.equal(resend.response.status, 202, 'a provider failure must retain the generic acknowledgement');
  assert.equal(resend.data.accepted, true);
  assert.equal('testCode' in resend.data, false, 'a failed delivery must never expose a code');
  assert.equal(JSON.stringify(resend.data).includes('provider'), false, 'provider details must stay server-side');
  const after = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  const afterUser = after.users.find(user => user.email === email);
  assert.equal(afterUser.emailVerification.codeHash, beforeHash, 'a failed resend must preserve the previously valid code');
  assert.ok(after.audit.some(item => item.action === 'student.email-verification-delivery-failed' && item.studentId === afterUser.studentId), 'delivery failure must be auditable server-side');
  console.log('email-verification-delivery-failure.test.mjs: generic failure response and previous-code preservation passed');
} finally {
  if (first) await stop(first.child);
  if (second) await stop(second.child);
  await rm(stateDirectory, { recursive: true, force: true });
}
