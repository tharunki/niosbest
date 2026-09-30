import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(serviceDirectory, '..');

function testPort() { return 47000 + Math.floor(Math.random() * 1000); }
async function startService(overrides = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-teacher-zoom-fallback-'));
  const port = testPort();
  const environment = {
    ...process.env,
    NODE_ENV: 'development', PORT: String(port), PORTAL_STATE_DRIVER: 'local',
    PORTAL_STATE_DIR: stateDirectory, STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock',
    NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'true',
    ...overrides
  };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return { child, stateDirectory, baseUrl, output: () => output }; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  child.kill('SIGTERM');
  await rm(stateDirectory, { recursive: true, force: true });
  throw new Error(`Teacher Zoom fallback test service did not start. ${output}`);
}
async function stopService(instance) {
  instance.child.kill('SIGTERM');
  await new Promise(resolvePromise => instance.child.once('exit', resolvePromise));
  await rm(instance.stateDirectory, { recursive: true, force: true });
}
async function api(instance, path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`${instance.baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
function classPayload(liveUrl = '') {
  return {
    batchId: 'batch_class12_stream1', board: 'NIOS', classLevel: '12', stream: 'Science',
    subject: 'Physics', subjectCode: '312', title: 'Fallback-safe Physics class',
    startsAt: new Date(Date.now() + 90 * 60_000).toISOString(), durationMinutes: 60, liveUrl
  };
}

let ordinary, missingHost;
try {
  const [serverSource, teacherPortal] = await Promise.all([
    readFile(join(serviceDirectory, 'server.mjs'), 'utf8'),
    readFile(join(publicDirectory, 'teacher-portal-v2.html'), 'utf8')
  ]);
  assert.match(serverSource, /const zoomManualLinkNextStep = 'Paste a valid HTTPS Zoom or Google Meet link to schedule this class now\./);
  assert.match(serverSource, /function zoomSchedulingError\(summary, status = 503\)/);
  assert.doesNotMatch(serverSource, /Zoom authorization failed\. Check the server-only Zoom credentials and app scopes\./);
  assert.match(teacherPortal, /Recommended: paste a valid HTTPS Zoom or Google Meet link to schedule immediately\./);
  assert.match(teacherPortal, /function schedulingErrorMessage\(error\)/);

  ordinary = await startService();
  const teacher = await api(ordinary, '/api/auth/login', { method: 'POST', body: { email: 'teacher@niosbest.in', password: 'teacher123' } });
  assert.equal(teacher.response.status, 200, ordinary.output());

  const automaticFallback = await api(ordinary, '/api/teacher/live-classes', { method: 'POST', cookie: teacher.cookie, body: classPayload() });
  assert.equal(automaticFallback.response.status, 503);
  assert.match(automaticFallback.data.error, /Paste a valid HTTPS Zoom or Google Meet link/i);
  assert.match(automaticFallback.data.error, /academy administrator.*Zoom host setup/i);

  const manualMeeting = await api(ordinary, '/api/teacher/live-classes', { method: 'POST', cookie: teacher.cookie, body: classPayload('https://meet.google.com/abc-defg-hij') });
  assert.equal(manualMeeting.response.status, 201, JSON.stringify(manualMeeting.data));
  assert.equal(manualMeeting.data.meetingProvider, 'external');
  assert.equal(manualMeeting.data.liveUrl, 'https://meet.google.com/abc-defg-hij');

  missingHost = await startService({
    ALLOW_DEVELOPMENT_OUTBOUND_DELIVERY: 'true',
    ZOOM_ACCOUNT_ID: 'test-account', ZOOM_CLIENT_ID: 'test-client', ZOOM_CLIENT_SECRET: 'test-secret', ZOOM_HOST_USER_ID: ''
  });
  const hostTeacher = await api(missingHost, '/api/auth/login', { method: 'POST', body: { email: 'teacher@niosbest.in', password: 'teacher123' } });
  assert.equal(hostTeacher.response.status, 200, missingHost.output());
  const hostFallback = await api(missingHost, '/api/teacher/live-classes', { method: 'POST', cookie: hostTeacher.cookie, body: classPayload() });
  assert.equal(hostFallback.response.status, 503);
  assert.match(hostFallback.data.error, /licensed Zoom host is not configured/i);
  assert.match(hostFallback.data.error, /Paste a valid HTTPS Zoom or Google Meet link/i);
  console.log('teacher-zoom-fallback.test.mjs: automatic-Zoom fallback and manual scheduling passed');
} finally {
  if (ordinary) await stopService(ordinary);
  if (missingHost) await stopService(missingHost);
}
