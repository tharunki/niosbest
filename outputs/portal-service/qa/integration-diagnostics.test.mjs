import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-integration-diagnostics-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const environment = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(port), PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory, STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock',
  NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'true',
  RESEND_API_KEY: 'disabled-resend-key', ADMIN_ADMISSION_EMAIL: 'review@example.test', ADMISSION_EMAIL_FROM: 'Academy <admissions@example.test>',
  ZOOM_ACCOUNT_ID: 'disabled-account', ZOOM_CLIENT_ID: 'disabled-client', ZOOM_CLIENT_SECRET: 'disabled-secret', ZOOM_HOST_USER_ID: ' ',
  SUPABASE_URL: 'https://invalid.supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'disabled-supabase-key', SUPABASE_BUCKET: 'student-documents'
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
  throw new Error(`Integration diagnostics test service did not start. ${output}`);
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
  assert.equal((await api('/api/admin/integrations')).response.status, 401, 'diagnostics require an admin session');
  const student = await api('/api/auth/login', { method: 'POST', body: { email: 'aarav@example.com', password: 'student123' } });
  assert.equal(student.response.status, 200);
  assert.equal((await api('/api/admin/integrations', { cookie: student.cookie })).response.status, 401, 'students cannot inspect provider state');
  const admin = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@niosbest.in', password: 'admin123' } });
  assert.equal(admin.response.status, 200);
  const diagnostic = await api('/api/admin/integrations', { cookie: admin.cookie });
  assert.equal(diagnostic.response.status, 200);
  assert.equal(diagnostic.data.remoteChecks, false, 'the initial admin page must not make external provider calls');
  assert.equal(diagnostic.data.checks.resend.senderDomain, 'example.test');
  assert.equal(diagnostic.data.checks.zoom.meetingHostConfigured, false);
  assert.equal(diagnostic.data.checks.supabase.configured, true);
  const serialised = JSON.stringify(diagnostic.data);
  for (const secret of ['disabled-resend-key', 'disabled-secret', 'disabled-supabase-key', 'https://invalid.supabase.example']) assert.equal(serialised.includes(secret), false, 'diagnostics must not reveal secret configuration');
  console.log('integration-diagnostics.test.mjs: 12 safe admin-diagnostic assertions passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
