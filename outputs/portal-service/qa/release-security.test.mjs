import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureResourceOrder } from '../resource-store.mjs';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(serviceDirectory, '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-release-security-'));
const port = 44000 + Math.floor(Math.random() * 1000);

function captureResponse(state, capture) {
  return captureResourceOrder(state, capture);
}

const resourceState = {
  audit: [],
  resourceOrders: [{
    id: 'resource_order_safe', provider: 'razorpay', providerOrderId: 'order_safe',
    amount: 24900, currency: 'INR', status: 'CREATED', userId: 'student_safe'
  }]
};
const capture = {
  id: 'pay_safe', status: 'captured', order_id: 'order_safe', amount: 24900,
  currency: 'INR', notes: { academyResourceOrderId: 'resource_order_safe' }
};
assert.equal(captureResponse(resourceState, capture).duplicate, false);
assert.equal(resourceState.resourceOrders[0].status, 'CAPTURED');
assert.equal(captureResponse(resourceState, capture).duplicate, true);
assert.throws(() => captureResponse(resourceState, { ...capture, id: 'pay_other' }), /different payment/i);

const serverSource = await readFile(join(serviceDirectory, 'server.mjs'), 'utf8');
assert.match(serverSource, /ZOOM_HOST_USER_ID/);
assert.match(serverSource, /\/v2\/users\/\$\{encodeURIComponent\(hostUserId\)\}\/meetings/);
assert.match(serverSource, /isProduction \? \{\} : \{ token: session\.token \}/);
assert.match(serverSource, /detectedUploadMime\(bytes\) !== mimeType/);
assert.match(serverSource, /captureResourceOrder\(data, capture\)/);

const environment = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(port), PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory, STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock',
  NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'true'
};
const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function waitForService() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Release-security test service did not start. ${output}`);
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

try {
  await waitForService();

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const failed = await api('/api/auth/login', { method: 'POST', body: { email: 'throttle@example.test', password: 'wrong-password' } });
    assert.equal(failed.response.status, 401);
  }
  const limited = await api('/api/auth/login', { method: 'POST', body: { email: 'throttle@example.test', password: 'wrong-password' } });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);

  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'aarav@example.com', password: 'student123' } });
  assert.equal(login.response.status, 200);
  assert.ok(login.cookie.startsWith('nios_session='));
  assert.equal(login.data.user.role, 'student');
  const counselor = await api('/api/counselor', { method: 'POST', cookie: login.cookie, body: { message: 'What is my admission status?' } });
  assert.equal(counselor.response.status, 200);
  assert.equal(counselor.data.assistantType, 'academic-assistant');
  assert.equal(JSON.stringify(counselor.data).includes('RF-26-0920-184'), false, 'Mira must not receive or return the student reference record');
  const privateMira = await api('/api/counselor', { method: 'POST', cookie: login.cookie, body: { message: 'My enrollment is NIOS12345' } });
  assert.equal(privateMira.response.status, 200);
  assert.equal(privateMira.data.topic, 'privacy');
  assert.equal(JSON.stringify(privateMira.data).includes('NIOS12345'), false, 'Mira must not echo a private identifier submitted directly to its API');
  const batches = await api('/api/batches', { cookie: login.cookie });
  assert.equal(batches.response.status, 200);
  assert.ok(batches.data.length > 0, 'a current admission batch is required for this isolated test');
  const batch = batches.data[0];
  const application = await api('/api/admission/applications', { method: 'POST', cookie: login.cookie, body: { batchId: batch.id } });
  assert.equal(application.response.status, 201);
  const intake = await api(`/api/admission/intake?batchId=${encodeURIComponent(batch.id)}`, { cookie: login.cookie });
  assert.equal(intake.response.status, 200);
  const subject = intake.data.subjectOptions[0];
  const missingConsent = await api('/api/admission/intake', { method: 'PUT', cookie: login.cookie, body: { subjects: [subject], portalSyncConsent: true } });
  assert.equal(missingConsent.response.status, 422);
  const acceptedConsent = await api('/api/admission/intake', { method: 'PUT', cookie: login.cookie, body: { subjects: [subject], portalSyncConsent: true, documentProcessingAcknowledgment: true, applicantDateOfBirth: '2000-02-02' } });
  assert.equal(acceptedConsent.response.status, 200);
  assert.equal(JSON.stringify(acceptedConsent.data).includes('2000-02-02'), false, 'public enrollment data must not expose date of birth');
  const fakeUpload = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: { type: 'IDENTITY', fileName: 'not-a-pdf.pdf', mimeType: 'application/pdf', base64: Buffer.from('not actually a PDF').toString('base64') } });
  assert.equal(fakeUpload.response.status, 422);
  const safeUpload = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: { type: 'IDENTITY', fileName: 'identity.pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4\nrelease QA').toString('base64') } });
  assert.equal(safeUpload.response.status, 201);

  const nonAdminReadiness = await api('/api/admin/health', { cookie: login.cookie });
  assert.equal(nonAdminReadiness.response.status, 401);
  const adminLogin = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@niosbest.in', password: 'admin123' } });
  assert.equal(adminLogin.response.status, 200);
  const readiness = await api('/api/admin/health', { cookie: adminLogin.cookie });
  assert.equal(readiness.response.status, 200);
  assert.deepEqual(Object.keys(readiness.data.readiness.zoom).sort(), ['missing', 'ready']);
  assert.equal(typeof readiness.data.readiness.email.ready, 'boolean');

  console.log('release-security.test.mjs: security, private-context, and counselor-route assertions passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
