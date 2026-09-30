import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = resolve(serviceDirectory, '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-admission-documents-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const environment = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(port), PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory, STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock',
  NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'true',
  RESEND_API_KEY: '', ADMIN_ADMISSION_EMAIL: ''
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
  throw new Error(`Admission-document test service did not start. ${output}`);
}
async function api(path, { method = 'GET', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
function pdf(label = 'proof') { return Buffer.from(`%PDF-1.4\n${label}`).toString('base64'); }
function jpeg(bytes = 3) { return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(Math.max(0, bytes - 3), 1)]).toString('base64'); }
function png() { return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'); }

try {
  const intakePage = await readFile(join(publicDirectory, 'admission-intake.html'), 'utf8');
  const activeWizardPage = await readFile(join(publicDirectory, 'admission-wizard-v2.html'), 'utf8');
  const serverSource = await readFile(join(serviceDirectory, 'server.mjs'), 'utf8');
  assert.match(intakePage, /Required for every application/);
  assert.match(intakePage, /Only if applicable or requested/);
  assert.match(intakePage, /limit=image\?1024\*1024:6\*1024\*1024/);
  assert.match(intakePage, /Images must be 1 MB or smaller/);
  assert.match(intakePage, /optimizeImageForAdmission/);
  assert.match(intakePage, /Image optimized privately in your browser/);
  assert.match(activeWizardPage, /Required for every application/);
  assert.match(activeWizardPage, /Only if applicable or requested/);
  assert.match(activeWizardPage, /limit=image\?1024\*1024:6\*1024\*1024/);
  assert.match(activeWizardPage, /Images must be 1 MB or smaller/);
  assert.match(activeWizardPage, /optimizeImageForAdmission/);
  assert.match(activeWizardPage, /Image optimized privately in your browser/);
  assert.match(serverSource, /'\/admission-intake': '\/admission-wizard-v2\.html'/);
  await waitForService();
  const login = await api('/api/auth/login', { method: 'POST', body: { email: 'aarav@example.com', password: 'student123' } });
  assert.equal(login.response.status, 200);
  const batches = await api('/api/batches', { cookie: login.cookie });
  const application = await api('/api/admission/applications', { method: 'POST', cookie: login.cookie, body: { batchId: batches.data[0].id } });
  assert.equal(application.response.status, 201);

  const firstIntake = await api('/api/admission/intake', { cookie: login.cookie });
  assert.equal(firstIntake.response.status, 200);
  assert.deepEqual(firstIntake.data.requiredDocuments.map(item => item.type), ['IDENTITY', 'DATE_OF_BIRTH', 'EDUCATIONAL_QUALIFICATION', 'RESIDENCE', 'PHOTO', 'SIGNATURE']);
  assert.equal(firstIntake.data.conditionalDocuments.length, 6);
  assert.ok(firstIntake.data.conditionalDocuments.every(item => item.conditional === true));
  assert.equal(firstIntake.data.uploadRules.imageMaximumBytes, 1024 * 1024);
  assert.equal(firstIntake.data.uploadRules.pdfMaximumBytes, 6 * 1024 * 1024);

  const subject = firstIntake.data.subjectOptions[0];
  const saved = await api('/api/admission/intake', { method: 'PUT', cookie: login.cookie, body: {
    subjects: [subject], portalSyncConsent: false, documentProcessingAcknowledgment: true, applicantDateOfBirth: '2000-02-02'
  } });
  assert.equal(saved.response.status, 200);

  const oversizedPhoto = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
    type: 'PHOTO', fileName: 'too-large.jpg', mimeType: 'image/jpeg', base64: jpeg(1024 * 1024 + 1)
  } });
  assert.equal(oversizedPhoto.response.status, 422);
  assert.match(oversizedPhoto.data.error, /1 MB or smaller/i);
  const invalidPhotoType = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
    type: 'PHOTO', fileName: 'photo.pdf', mimeType: 'application/pdf', base64: pdf('not a photo')
  } });
  assert.equal(invalidPhotoType.response.status, 422);
  assert.match(invalidPhotoType.data.error, /JPG, PNG, or WEBP image/i);

  const uploads = [
    ['IDENTITY', 'identity.pdf', 'application/pdf', pdf('identity')],
    ['DATE_OF_BIRTH', 'birth-proof.pdf', 'application/pdf', pdf('birth')],
    ['EDUCATIONAL_QUALIFICATION', 'education.pdf', 'application/pdf', pdf('education')],
    ['RESIDENCE', 'residence.pdf', 'application/pdf', pdf('residence')],
    ['PHOTO', 'photo.jpg', 'image/jpeg', jpeg()],
    ['SIGNATURE', 'signature.png', 'image/png', png()]
  ];
  const uploaded = new Map();
  for (const [type, fileName, mimeType, base64] of uploads) {
    const upload = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: { type, fileName, mimeType, base64 } });
    assert.equal(upload.response.status, 201, `${type} should upload`);
    uploaded.set(type, upload.data);
  }
  const replacement = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
    type: 'IDENTITY', fileName: 'identity-replacement.pdf', mimeType: 'application/pdf', base64: pdf('identity replacement')
  } });
  assert.equal(replacement.response.status, 201, 'a document can be replaced before review');
  assert.notEqual(replacement.data.id, uploaded.get('IDENTITY').id, 'replacement must receive fresh metadata');
  const identityDirectory = join(stateDirectory, 'files', 'admissions', application.data.id, 'IDENTITY');
  const identityFiles = await readdir(identityDirectory);
  assert.equal(identityFiles.length, 1, 'replacement must remove the old local storage object');
  assert.ok(identityFiles[0].endsWith('identity-replacement.pdf'));
  const afterReplacement = await api('/api/admission/intake', { cookie: login.cookie });
  assert.equal(afterReplacement.data.documents.filter(document => document.type === 'IDENTITY').length, 1, 'only the current identity metadata remains');
  assert.equal(afterReplacement.data.documents.find(document => document.type === 'IDENTITY').id, replacement.data.id);
  const requiredOnlyIntake = await api('/api/admission/intake', { cookie: login.cookie });
  assert.equal(requiredOnlyIntake.data.canSubmit, true, 'conditional documents must not be required for submission');
  const conditional = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
    type: 'CATEGORY_CERTIFICATE', fileName: 'category.pdf', mimeType: 'application/pdf', base64: pdf('category')
  } });
  assert.equal(conditional.response.status, 201);
  assert.equal(conditional.data.conditional, true);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const upload = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
      type: 'OTHER_SUPPORTING_DOCUMENT', fileName: `support-${attempt}.pdf`, mimeType: 'application/pdf', base64: pdf(`support ${attempt}`)
    } });
    assert.equal(upload.response.status, 201, 'a bounded number of replacement attempts is allowed');
  }
  const throttledUpload = await api('/api/admission/documents', { method: 'POST', cookie: login.cookie, body: {
    type: 'OTHER_SUPPORTING_DOCUMENT', fileName: 'support-throttled.pdf', mimeType: 'application/pdf', base64: pdf('support throttled')
  } });
  assert.equal(throttledUpload.response.status, 429, 'document replacement churn is rate limited');

  const completeIntake = await api('/api/admission/intake', { cookie: login.cookie });
  assert.equal(completeIntake.data.canSubmit, true, 'conditional uploads must not change submission eligibility');
  const submitted = await api('/api/admission/submit', { method: 'POST', cookie: login.cookie });
  assert.equal(submitted.response.status, 200);
  const persisted = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  const persistedEnrollment = persisted.enrollments.find(item => item.id === application.data.id);
  assert.equal(persistedEnrollment.intakeNotice?.status, 'queued', 'development QA must not send a real intake email');
  assert.equal(persistedEnrollment.intakeNotice?.provider, 'academy-review-queue', 'development QA must not invoke a configured delivery provider');
  console.log('admission-documents.test.mjs: required/conditional checklist and image limits passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
