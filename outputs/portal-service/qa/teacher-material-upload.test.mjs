import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(serviceDirectory, '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-teacher-material-limit-'));
const port = 46000 + Math.floor(Math.random() * 1000);
const maximumMaterialBytes = 6 * 1024 * 1024;
const maximumRequestBytes = 4 * Math.ceil(maximumMaterialBytes / 3) + 64 * 1024;
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
  throw new Error(`Teacher-material upload test service did not start. ${output}`);
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
function pdf(size) {
  const file = Buffer.alloc(size, 0x20);
  Buffer.from('%PDF-1.4\nteacher material\n').copy(file);
  return file;
}

try {
  const [serverSource, currentPortal, legacyPortal] = await Promise.all([
    readFile(join(serviceDirectory, 'server.mjs'), 'utf8'),
    readFile(join(publicDirectory, 'teacher-portal-v2.html'), 'utf8'),
    readFile(join(publicDirectory, 'teacher-portal.html'), 'utf8')
  ]);
  assert.match(serverSource, /const teacherMaterialMaximumBytes = 6 \* 1024 \* 1024;/);
  assert.match(serverSource, /const teacherMaterialMaximumRequestBytes = 4 \* Math\.ceil\(teacherMaterialMaximumBytes \/ 3\) \+ 64 \* 1024;/);
  assert.match(serverSource, /body\(request, teacherMaterialMaximumRequestBytes\)/);
  assert.match(serverSource, /filePayload\(input, teacherMaterialMaximumBytes\)/);
  for (const source of [currentPortal, legacyPortal]) {
    assert.match(source, /PDF or image \(max 6 MB\)/);
    assert.match(source, /file\.size>6\*1024\*1024/);
    assert.match(source, /Use a file of 6 MB or smaller\./);
    assert.doesNotMatch(source, /max 8 MB|file\.size>8\*1024\*1024/);
  }

  await waitForService();
  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'teacher@niosbest.in', password: 'teacher123' } });
  assert.equal(login.response.status, 200);
  const batches = await api('/api/teacher/batches', { cookie: login.cookie });
  assert.equal(batches.response.status, 200);
  const batch = batches.data.find(item => item.id === 'batch_class12_stream1');
  assert.ok(batch, 'the demo teacher must receive the science batch needed for this isolated check');
  const baseMaterial = {
    batchId: batch.id, subject: 'Physics', subjectCode: '312',
    title: 'Six MiB boundary material', materialType: 'Class note',
    fileName: 'six-mib.pdf', mimeType: 'application/pdf'
  };

  const boundaryPayload = { ...baseMaterial, base64: pdf(maximumMaterialBytes).toString('base64') };
  assert.ok(Buffer.byteLength(JSON.stringify(boundaryPayload)) < maximumRequestBytes, 'a 6 MiB file must fit inside the accepted JSON/base64 envelope');
  const boundaryUpload = await api('/api/teacher/materials', { method: 'POST', cookie: login.cookie, body: boundaryPayload });
  assert.equal(boundaryUpload.response.status, 201, `a file at the 6 MiB storage ceiling must upload successfully: ${JSON.stringify(boundaryUpload.data)} ${output}`);
  assert.equal(boundaryUpload.data.fileName, 'six-mib.pdf');
  assert.equal(boundaryUpload.data.downloadable, true);

  const oversizedPayload = { ...baseMaterial, title: 'Too large material', fileName: 'too-large.pdf', base64: pdf(maximumMaterialBytes + 1).toString('base64') };
  const oversizedUpload = await api('/api/teacher/materials', { method: 'POST', cookie: login.cookie, body: oversizedPayload });
  assert.equal(oversizedUpload.response.status, 422, 'a file larger than the 6 MiB bucket ceiling must be rejected before storage');
  assert.match(oversizedUpload.data.error, /6 MB/i);
  console.log('teacher-material-upload.test.mjs: 6 MiB client/server/storage boundary passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
