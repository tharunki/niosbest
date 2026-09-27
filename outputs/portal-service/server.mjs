import { createServer } from 'node:http';
import { counselorReply } from './counselor.mjs';
import { captureResourceOrder, resourceStore } from './resource-store.mjs';
import { createStateStore, resolveStateStoreConfig } from './state-store.mjs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual, scryptSync } from 'node:crypto';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

async function loadEnv() {
  try {
    const text = await readFile(join(here, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* .env is optional; environment variables still take precedence. */ }
}
await loadEnv();

const stateDir = resolve(process.env.PORTAL_STATE_DIR || join(here, '.portal-data'));
const filesDir = join(stateDir, 'files');
const stateFile = join(stateDir, 'state.json');

const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const demosEnabled = !isProduction && process.env.ALLOW_DEMO_ACCOUNTS !== 'false';
function configuredPublicOrigin(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  try {
    const url = new URL(source);
    // A hosting-provider preview URL is never the academy's public canonical
    // origin. Reject it even if an old Render environment value still exists.
    if (url.protocol !== 'https:' || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.hostname.toLowerCase().endsWith('.onrender.com')) return null;
    return url;
  } catch { return null; }
}
const publicOrigin = configuredPublicOrigin(process.env.APP_PUBLIC_URL);
if (isProduction && !publicOrigin) console.warn('APP_PUBLIC_URL must be a valid HTTPS public origin; public pages remain noindex until it is configured.');
function requestHost(request) {
  const raw = String(request.headers.host || '').trim();
  try { return new URL(`http://${raw}`).host.toLowerCase(); }
  catch { return ''; }
}
function searchIndexingAllowed(request) {
  // Local development is never crawled. In production, only the owner-set
  // HTTPS public hostname may be indexed; Render and preview hostnames cannot.
  return !isProduction || Boolean(publicOrigin && requestHost(request) === publicOrigin.host.toLowerCase());
}
function isPrivateSearchPath(pathname) {
  return /^\/(?:api|admin|dashboard|student-app|student-desk|active-student-dashboard|pending-admission-dashboard|batch-hub|teacher-portal|login|auth|checkout|payment-pending|admission-intake|admission-wizard|application-wizard|accept-invite|live-classes|homework|resource-checkout)(?:[/.]|$)/.test(pathname);
}
const stateStoreConfig = resolveStateStoreConfig({ isProduction, localFilePath: stateFile });
const stateStore = await createStateStore(stateStoreConfig);
// A Render or similar ephemeral filesystem must never become the source of
// truth for admissions, credentials, payments, or document metadata. Public
// pages can remain readable while the operator completes the database setup.
const durableStateRequired = isProduction;
const durableFileStorage = ['supabase', 's3'].includes(String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase());
const productionWritesReady = !durableStateRequired || (stateStore.durable && durableFileStorage);
const devKey = createHash('sha256').update('nios-best-academy-development-key-only').digest('hex');
const encryptionKeyHex = process.env.APP_ENCRYPTION_KEY || (isProduction ? '' : devKey);
if (!/^[a-f0-9]{64}$/i.test(encryptionKeyHex)) throw new Error('APP_ENCRYPTION_KEY must be 64 hexadecimal characters in production.');
const encryptionKey = Buffer.from(encryptionKeyHex, 'hex');
const adminToken = String(process.env.ADMIN_API_TOKEN || (isProduction ? '' : 'development-admin-token-only'));
if (isProduction && adminToken.length < 32) throw new Error('Set a high-entropy ADMIN_API_TOKEN (32+ characters) before starting production.');
const bootstrapAdminEmail = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const bootstrapAdminPassword = String(process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
const permanentSuperAdminEmails = new Set(['niosbest.tvl@gmail.com', 'tkcrackjee@gmail.com']);
// An empty allow-list means a new teacher has no batch access until a super-admin assigns one.
const defaultTeacherPermissions = () => ({ manageLiveClasses: false, manageHomework: false, manageMaterials: false, gradeSubmissions: false, allowedBatchIds: [] });

function now() { return new Date().toISOString(); }
function uid(prefix) { return `${prefix}_${randomBytes(9).toString('hex')}`; }
function isSafeString(value, max = 160) { return typeof value === 'string' && value.trim().length > 0 && value.length <= max; }
function indianDateParts(value = new Date()) { const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }); return Object.fromEntries(formatter.formatToParts(value).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])); }
function localDate(year, month, day) { return new Date(Date.UTC(year, month - 1, day, 12, 0, 0)); }
function admissionCycle(route = 'stream1', value = new Date()) {
  const { year, month, day } = indianDateParts(value), stamp = month * 100 + day, s1Block1 = stamp >= 316 && stamp <= 915, s1Block2 = stamp >= 916 || stamp <= 315;
  if (route === 'stream1') {
    const block = s1Block1 ? 'B1' : 'B2', targetYear = block === 'B1' ? year + 1 : year, closeAt = block === 'B1' ? localDate(year, 9, 15) : localDate(month >= 9 ? year + 1 : year, 3, 15), lateFeeStartsAt = new Date(closeAt.getTime() - 14 * 86400_000);
    return { route: 'stream1', stream: 'Stream 1', block, target: block === 'B1' ? `April/May ${targetYear}` : `October/November ${targetYear}`, targetCode: block === 'B1' ? `APR${targetYear}` : `OCT${targetYear}`, isOpen: s1Block1 || s1Block2, opensAt: block === 'B1' ? localDate(year, 3, 16).toISOString() : localDate(month >= 9 ? year : year - 1, 9, 16).toISOString(), closesAt: closeAt.toISOString(), lateFeeStartsAt: lateFeeStartsAt.toISOString(), lateFee: Date.now() >= lateFeeStartsAt.getTime(), countdownMs: Math.max(0, closeAt.getTime() - Date.now()) };
  }
  if (route === 'stream2') {
    const opensAt = localDate(year, 5, 1), closesAt = localDate(year, 7, 15), lateFeeStartsAt = new Date(closesAt.getTime() - 10 * 86400_000), isOpen = stamp >= 501 && stamp <= 715;
    return { route: 'stream2', stream: 'Stream 2', block: 'COMPARTMENT', target: `October ${year}`, targetCode: `OCT${year}`, isOpen, opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString(), lateFeeStartsAt: lateFeeStartsAt.toISOString(), lateFee: isOpen && Date.now() >= lateFeeStartsAt.getTime(), countdownMs: isOpen ? Math.max(0, closesAt.getTime() - Date.now()) : 0 };
  }
  if (route === 'ode') {
    const isClosedForPublicExams = [4, 5, 10, 11].includes(month);
    return { route: 'ode', stream: 'Stream 3 / 4', block: 'ODE', target: 'On-Demand Examination', targetCode: `ODE${year}`, isOpen: !isClosedForPublicExams, opensAt: null, closesAt: null, lateFeeStartsAt: null, lateFee: false, countdownMs: 0, message: isClosedForPublicExams ? 'On-Demand admission pauses during the April–May and October–November public-exam periods.' : 'On-Demand admission is currently open.' };
  }
  return { route, isOpen: false, message: 'This admission route is not configured.' };
}
function batchAdmissionRoute(batch) { return batch.admissionRoute || (String(batch.id).includes('ondemand') ? 'ode' : 'stream1'); }
function streamCode(stream) { return String(stream || 'GENERAL').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'GENERAL'; }
function assignedBatchCode(batch, cycle) { const route = cycle.route === 'stream1' ? `S1${cycle.block}` : cycle.route === 'stream2' ? 'S2' : 'S34'; return `BATCH-${route}-${cycle.targetCode}-${streamCode(batch.stream)}`; }
function seedBatches() {
  return [
    { id: 'batch_class10_stream1', class: '10', badge: 'Most popular', name: 'Class 10 Stream 1 Excellence Batch', level: 'NIOS Secondary', mode: '▣ Live interactive', duration: '◴ 6 months', starts: '16d 6h 40m', date: '2026-10-15', seats: '8 left', fill: '83%', features: ['Live classes 5 days/week', 'All 5 subject TMA solved PDFs', 'Science lab manual included', 'PYQ bank 2018–2025'], price: '₹12,500', old: '₹18,000', off: '31% off', popular: true, published: true },
    { id: 'batch_class12_stream1', class: '12', badge: 'Live interactive', name: 'Class 12 Stream 1 Premier Batch', level: 'NIOS Senior Secondary', mode: '▣ Live + recorded', duration: '◴ 8 months', starts: '21d 6h 40m', date: '2026-10-20', seats: '12 left', fill: '70%', features: ['Live + recorded classes', 'All 5 subject TMA solved PDFs', 'Practical file support', 'Doubt sessions 3×/week'], price: '₹16,500', old: '₹24,000', off: '31% off', tone: 'aqua', published: true },
    { id: 'batch_class10_ondemand', class: '10', badge: 'Self-paced', name: 'Class 10 On-Demand Crash Course', level: 'NIOS Secondary', mode: '▣ Self-paced', duration: '◴ 3–4 months', starts: 'Available now', date: '', seats: '50 left', fill: '42%', features: ['On-demand recorded lectures', 'All 5 subject TMA solved PDFs', 'On-demand exam registration', 'PYQ bank 2018–2025'], price: '₹8,500', old: '₹12,000', off: '29% off', tone: 'pink', published: true },
    { id: 'batch_bosse_class12', class: '12', badge: 'New batch', name: 'BOSSE Class 12 Complete Package', level: 'BOSSE', mode: '▣ Live interactive', duration: '◴ 7 months', starts: '31d 6h 40m', date: '2026-11-01', seats: '18 left', fill: '62%', features: ['Live BOSSE-specific classes', 'BOSSE TMA & Lab Manuals', 'Admission assistance', 'PYQ bank'], price: '₹11,000', old: '₹16,000', off: '31% off', published: true }
  ];
}
function defaultBatchSubjects(classLevel, stream = '') {
  const class10 = [{ code: '201', name: 'Hindi' }, { code: '202', name: 'English' }, { code: '211', name: 'Mathematics' }, { code: '212', name: 'Science' }, { code: '213', name: 'Social Science' }, { code: '229', name: 'Data Entry Operations' }];
  const science = [{ code: '302', name: 'English' }, { code: '311', name: 'Mathematics' }, { code: '312', name: 'Physics' }, { code: '313', name: 'Chemistry' }, { code: '314', name: 'Biology' }, { code: '336', name: 'Data Entry Operations' }];
  const commerce = [{ code: '302', name: 'English' }, { code: '318', name: 'Economics' }, { code: '319', name: 'Business Studies' }, { code: '320', name: 'Accountancy' }, { code: '336', name: 'Data Entry Operations' }];
  const humanities = [{ code: '302', name: 'English' }, { code: '317', name: 'Political Science' }, { code: '318', name: 'Economics' }, { code: '328', name: 'Psychology' }, { code: '331', name: 'Sociology' }, { code: '336', name: 'Data Entry Operations' }];
  if (String(classLevel) === '10') return class10;
  if (/science/.test(String(stream).toLowerCase())) return science;
  if (/commerce|business/.test(String(stream).toLowerCase())) return commerce;
  if (/art|humanit|social/.test(String(stream).toLowerCase())) return humanities;
  return [...science, ...commerce, ...humanities].filter((subject, index, list) => list.findIndex(item => item.code === subject.code) === index);
}
function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decrypt(record) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(record.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
function tryDecrypt(record) {
  try { return decrypt(record); }
  catch { return null; }
}
function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function matchesPassword(password, stored) { const [salt, expected] = String(stored).split(':'); if (!salt || !expected) return false; const actual = scryptSync(password, salt, 64).toString('hex'); return actual.length === expected.length && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function b64(value) { return Buffer.from(value).toString('base64url'); }
function issueSession(user) { const payload = b64(JSON.stringify({ sub: user.id, studentId: user.studentId || null, role: user.role, exp: Date.now() + 1000 * 60 * 60 * 12 })); const signature = createHmac('sha256', encryptionKey).update(payload).digest('base64url'); return `${payload}.${signature}`; }
function cookieValue(request, name) { const match = String(request.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`)); return match ? decodeURIComponent(match.slice(name.length + 1)) : ''; }
function readSession(request) { const bearer = isProduction ? '' : String(request.headers.authorization || '').replace(/^Bearer\s+/i, ''); const token = cookieValue(request, 'nios_session') || bearer; const [payload, signature] = token.split('.'); if (!payload || !signature) return null; const expected = createHmac('sha256', encryptionKey).update(payload).digest('base64url'); if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return claims.exp > Date.now() ? claims : null; } catch { return null; } }

function initialState() {
  return {
      users: demosEnabled ? [{ id: 'user_demo_aarav', studentId: 'demo-aarav', name: 'Aarav Patel', email: 'aarav@example.com', passwordHash: hashPassword('student123'), role: 'student', createdAt: now() }, { id: 'user_admin', name: 'Academy Admin', email: 'admin@niosbest.in', passwordHash: hashPassword('admin123'), role: 'admin', createdAt: now() }, { id: 'user_teacher_science', name: 'Dr. Meera Iyer', email: 'teacher@niosbest.in', passwordHash: hashPassword('teacher123'), role: 'teacher', createdAt: now() }] : [],
      students: demosEnabled ? [{ id: 'demo-aarav', name: 'Aarav Patel', email: 'aarav@example.com', phone: '+919999999999', board: 'NIOS', boardCode: 'NIOS', classLevel: '12', referenceNumber: 'RF-26-0920-184', subjects: [{ code: '302', name: 'English', tmaStatus: 'Submitted', practicalGuide: false, progress: 78 }, { code: '311', name: 'Mathematics', tmaStatus: 'In progress', practicalGuide: false, progress: 62 }, { code: '312', name: 'Physics', tmaStatus: 'Draft due', practicalGuide: true, progress: 54 }, { code: '313', name: 'Chemistry', tmaStatus: 'Pending', practicalGuide: true, progress: 41 }, { code: '314', name: 'Biology', tmaStatus: 'Pending', practicalGuide: true, progress: 36 }], createdAt: now() }] : [],
      vault: demosEnabled ? { 'demo-aarav': encrypt({ enrollmentNumber: '123456789012', referenceNumber: 'RF-26-0920-184', dateOfBirth: '2007-08-14', boardCode: 'NIOS', consent: true, consentedAt: now() }) } : {}, vaultRecovery: {},
      documents: demosEnabled ? [
        { id: 'doc_theory_demo', studentId: 'demo-aarav', type: 'theoryHallTicket', title: 'Theory hall ticket', status: 'Issued', source: 'mock', fileName: 'theory-hall-ticket-demo.txt', storageKey: null, issuedAt: now(), updatedAt: now() },
        { id: 'doc_practical_demo', studentId: 'demo-aarav', type: 'practicalHallTicket', title: 'Practical hall ticket', status: 'Processing', source: 'mock', fileName: null, storageKey: null, issuedAt: null, updatedAt: now() },
        { id: 'doc_tma_demo', studentId: 'demo-aarav', type: 'tmaReceipt', title: 'TMA receipt', status: 'Pending', source: 'mock', fileName: null, storageKey: null, issuedAt: null, updatedAt: now() }
      ] : [],
      jobs: [], syncLogs: [], audit: [], resources: [], notifications: [], enquiries: [], batches: seedBatches(), payments: [], enrollments: demosEnabled ? [{ id: 'enrol_demo_science', studentId: 'demo-aarav', batchId: 'batch_class12_stream1', streamId: 'science', board: 'NIOS', classLevel: '12', stream: 'Science', selectedSubjects: [{ code: '302', name: 'English' }, { code: '311', name: 'Mathematics' }, { code: '312', name: 'Physics' }, { code: '313', name: 'Chemistry' }, { code: '314', name: 'Biology' }], status: 'ACTIVE', activatedAt: now() }] : [], liveClasses: [], attendance: [], homework: [], submissions: [], materials: [], admissionDocuments: []
  };
}
async function ensureState() {
  // The directory is used only by the local document-storage adapter. It is
  // harmless in Supabase mode and avoids a surprising local-development break.
  await mkdir(filesDir, { recursive: true });
  await stateStore.ensure(initialState());
}
await ensureState();
await updateState(state => {
  if (!Array.isArray(state.users)) state.users = [];
  if (!Array.isArray(state.students)) state.students = [];
  if (!Array.isArray(state.audit)) state.audit = [];
  if (!state.vault || typeof state.vault !== 'object') state.vault = {};
  if (!state.vaultRecovery || typeof state.vaultRecovery !== 'object') state.vaultRecovery = {};
  for (const [studentId, record] of Object.entries(state.vault)) {
    if (!tryDecrypt(record)) {
      // Retain unreadable ciphertext for an audited recovery path, but remove it
      // from active use so a legacy key mismatch cannot take the Student Desk down.
      state.vaultRecovery[studentId] = { record, detectedAt: now(), reason: 'unreadable-key-or-corrupt-record' };
      delete state.vault[studentId];
      state.audit.push({ id: uid('audit'), at: now(), action: 'vault.recovery-required', studentId });
    }
  }
  if (isProduction && state.users.some(user => ['aarav@example.com', 'admin@niosbest.in', 'teacher@niosbest.in'].includes(String(user.email || '').toLowerCase()))) throw new Error('Production state contains demo accounts. Start with a fresh production state directory or remove the demo accounts before deployment.');
  if (isProduction && !state.users.some(user => user.role === 'admin')) {
    if (!/^\S+@\S+\.\S+$/.test(bootstrapAdminEmail) || bootstrapAdminPassword.length < 12) throw new Error('Set BOOTSTRAP_ADMIN_EMAIL and a 12+ character BOOTSTRAP_ADMIN_PASSWORD before the first production start.');
    state.users.push({ id: uid('user'), name: 'Academy Administrator', email: bootstrapAdminEmail, passwordHash: hashPassword(bootstrapAdminPassword), role: 'admin', createdAt: now(), bootstrap: true });
  }
  if (demosEnabled) {
    if (!state.users.some(user => user.email === 'aarav@example.com')) state.users.push({ id: 'user_demo_aarav', studentId: 'demo-aarav', name: 'Aarav Patel', email: 'aarav@example.com', passwordHash: hashPassword('student123'), role: 'student', createdAt: now() });
    if (!state.users.some(user => user.email === 'admin@niosbest.in')) state.users.push({ id: 'user_admin', name: 'Academy Admin', email: 'admin@niosbest.in', passwordHash: hashPassword('admin123'), role: 'admin', createdAt: now() });
    if (!state.users.some(user => user.email === 'teacher@niosbest.in')) state.users.push({ id: 'user_teacher_science', name: 'Dr. Meera Iyer', email: 'teacher@niosbest.in', passwordHash: hashPassword('teacher123'), role: 'teacher', permissions: { manageLiveClasses: true, manageHomework: true, manageMaterials: true, gradeSubmissions: true, allowedBatchIds: ['batch_class12_stream1'] }, createdAt: now() });
  }
  for (const email of permanentSuperAdminEmails) {
    let owner = state.users.find(user => String(user.email || '').toLowerCase() === email);
    if (!owner) { owner = { id: uid('user'), name: 'Academy Owner', email, passwordHash: hashPassword(randomBytes(32).toString('hex')), role: 'admin', superAdmin: true, protectedAccount: true, requiresPasswordSetup: true, createdAt: now() }; state.users.push(owner); }
    owner.role = 'admin'; owner.superAdmin = true; owner.protectedAccount = true;
  }
  for (const user of state.users) { if (user.role === 'teacher' && !user.permissions) user.permissions = defaultTeacherPermissions(); if (!isProduction && user.email === 'admin@niosbest.in') user.superAdmin = true; }
  if (!Array.isArray(state.batches)) state.batches = seedBatches();
  if (!Array.isArray(state.syncLogs)) state.syncLogs = [];
  for (const key of ['payments', 'enrollments', 'liveClasses', 'attendance', 'homework', 'submissions', 'materials', 'admissionDocuments', 'enquiries']) if (!Array.isArray(state[key])) state[key] = [];
  for (const batch of state.batches) { if (!batch.board) batch.board = batch.id === 'batch_bosse_class12' ? 'BOSSE' : 'NIOS'; if (!batch.stream) batch.stream = batch.id === 'batch_class12_stream1' ? 'Science' : 'General'; if (!batch.streamId) batch.streamId = `${batch.stream.toLowerCase().replace(/\s+/g, '-')}-${batch.date || 'open'}`; if (!batch.admissionRoute) batch.admissionRoute = batch.board === 'NIOS' ? batchAdmissionRoute(batch) : 'always'; }
  for (const batch of state.batches) if (!Array.isArray(batch.subjects) || !batch.subjects.length) batch.subjects = defaultBatchSubjects(batch.class, batch.stream);
  for (const enrollment of state.enrollments) {
    if (enrollment.status !== 'ACTIVE' || (Array.isArray(enrollment.selectedSubjects) && enrollment.selectedSubjects.length)) continue;
    const batch = state.batches.find(item => item.id === enrollment.batchId), student = state.students.find(item => item.id === enrollment.studentId);
    const allowed = new Map((batch?.subjects || []).map(subject => [String(subject.code), String(subject.name)]));
    const recovered = (student?.subjects || []).filter(subject => allowed.get(String(subject.code)) === String(subject.name)).map(subject => ({ code: String(subject.code), name: String(subject.name) }));
    enrollment.selectedSubjects = recovered;
    enrollment.subjectSelectionRecoveredAt = now();
    state.audit.push({ id: uid('audit'), at: now(), action: 'enrollment.subject-access-recovered', enrollmentId: enrollment.id, studentId: enrollment.studentId, subjectCount: recovered.length });
  }
  if (demosEnabled) {
    if (!state.enrollments.some(enrollment => enrollment.studentId === 'demo-aarav' && enrollment.status === 'ACTIVE')) state.enrollments.push({ id: 'enrol_demo_science', studentId: 'demo-aarav', batchId: 'batch_class12_stream1', streamId: 'science-oct-2026', board: 'NIOS', classLevel: '12', stream: 'Science', selectedSubjects: defaultBatchSubjects('12', 'Science').filter(subject => ['302', '311', '312', '313', '314'].includes(subject.code)), status: 'ACTIVE', activatedAt: now() });
    if (!state.liveClasses.length) state.liveClasses.push({ id: 'class_demo_science', batchId: 'batch_class12_stream1', board: 'NIOS', classLevel: '12', stream: 'Science', subjectCode: '312', subject: 'Physics', title: 'Motion and force — live problem solving', startsAt: new Date(Date.now() + 8 * 60_000).toISOString(), durationMinutes: 60, liveUrl: 'https://meet.google.com/', recordingUrl: null, createdBy: 'user_teacher_science', createdAt: now() });
    if (!state.homework.length) state.homework.push({ id: 'homework_demo_physics', batchId: 'batch_class12_stream1', board: 'NIOS', classLevel: '12', stream: 'Science', subjectCode: '312', subject: 'Physics', title: 'Numericals: force and acceleration', instructions: 'Solve questions 1–8 and upload one clear PDF or image.', dueAt: new Date(Date.now() + 2 * 86400000).toISOString(), createdBy: 'user_teacher_science', createdAt: now() });
  }
  for (const student of state.students) { if (!student.boardCode) student.boardCode = student.board || 'NIOS'; if (!Array.isArray(student.subjects)) student.subjects = []; }
});
async function readState() { return stateStore.read(); }
async function writeState(data) { return stateStore.write(data); }
async function updateState(mutator) { return stateStore.update(mutator); }

const sseClients = new Map();
async function forwardWebhook(event) {
  if (!process.env.WEBHOOK_URL) return;
  try { await fetch(process.env.WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(8_000) }); }
  catch (error) { console.warn('Webhook delivery failed:', error.message); }
}
function emit(studentId, type, payload) {
  const event = { id: uid('evt'), type, studentId, at: now(), payload };
  for (const response of sseClients.get(studentId) || []) response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  void forwardWebhook(event);
  return event;
}
const requiredAdmissionDocuments = [
  { type: 'IDENTITY', label: 'Identity proof' },
  { type: 'PHOTO', label: 'Recent passport photograph' },
  { type: 'SIGNATURE', label: 'Signature image' },
  { type: 'PREVIOUS_ACADEMIC', label: 'Previous marksheet or transfer certificate' }
];
function validDateOfBirth(value) {
  const source = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source)) return null;
  const [year, month, day] = source.split('-').map(Number), candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) return null;
  const today = indianDateParts();
  if (Date.UTC(year, month - 1, day) > Date.UTC(today.year, today.month - 1, today.day) || year < 1900) return null;
  const age = today.year - year - (today.month < month || (today.month === month && today.day < day) ? 1 : 0);
  return age >= 0 && age <= 120 ? { value: source, age } : null;
}
function validGuardianPhone(value) {
  const source = String(value || '').trim(), normalized = source.replace(/[\s().-]/g, '');
  return /^\+?\d{7,20}$/.test(normalized) ? source : '';
}
function admissionIntakeSafeguards(enrollment) {
  const dateOfBirth = validDateOfBirth(enrollment?.applicantDateOfBirth), under18 = Boolean(dateOfBirth && dateOfBirth.age < 18);
  const acknowledged = Boolean(enrollment?.documentProcessingAcknowledgment);
  const guardianName = String(enrollment?.guardianName || '').trim(), guardianEmail = String(enrollment?.guardianEmail || '').trim().toLowerCase(), guardianPhone = validGuardianPhone(enrollment?.guardianPhone);
  const guardianContactProvided = /^\S+@\S+\.\S+$/.test(guardianEmail) || Boolean(guardianPhone);
  const guardianReady = !under18 || (Boolean(enrollment?.guardianConfirmation) && isSafeString(guardianName, 80) && guardianContactProvided);
  return {
    ready: Boolean(dateOfBirth && acknowledged && guardianReady),
    applicantDateOfBirth: dateOfBirth?.value || '',
    applicantIsUnder18: under18,
    documentProcessingAcknowledgment: acknowledged,
    guardianConfirmation: under18 ? Boolean(enrollment?.guardianConfirmation) : false,
    guardianName: under18 ? guardianName : '',
    guardianEmail: under18 ? guardianEmail : '',
    guardianPhone: under18 ? guardianPhone : '',
    guardianContactProvided: under18 ? guardianContactProvided : false
  };
}
function validateAdmissionIntakeSafeguards(input, existing = {}) {
  const acknowledgement = input.documentProcessingAcknowledgment === undefined ? Boolean(existing.documentProcessingAcknowledgment) : input.documentProcessingAcknowledgment === true;
  if (!acknowledgement) throw Object.assign(new Error('Confirm the document-processing acknowledgement before continuing.'), { status: 422 });
  const birthValue = input.applicantDateOfBirth === undefined ? existing.applicantDateOfBirth : input.applicantDateOfBirth, dateOfBirth = validDateOfBirth(birthValue);
  if (!dateOfBirth) throw Object.assign(new Error('Enter the applicant’s valid date of birth before continuing.'), { status: 422 });
  const applicantIsUnder18 = dateOfBirth.age < 18;
  const guardianName = String(input.guardianName === undefined ? existing.guardianName || '' : input.guardianName || '').trim();
  const guardianEmail = String(input.guardianEmail === undefined ? existing.guardianEmail || '' : input.guardianEmail || '').trim().toLowerCase();
  const guardianPhone = validGuardianPhone(input.guardianPhone === undefined ? existing.guardianPhone || '' : input.guardianPhone || '');
  const guardianConfirmation = input.guardianConfirmation === undefined ? Boolean(existing.guardianConfirmation) : input.guardianConfirmation === true;
  if (applicantIsUnder18) {
    if (!guardianConfirmation) throw Object.assign(new Error('A parent or guardian must confirm this application for an applicant under 18.'), { status: 422 });
    if (!isSafeString(guardianName, 80)) throw Object.assign(new Error('Enter the parent or guardian’s full name.'), { status: 422 });
    if (!/^\S+@\S+\.\S+$/.test(guardianEmail) && !guardianPhone) throw Object.assign(new Error('Enter a valid parent or guardian email address or mobile number.'), { status: 422 });
  }
  return {
    documentProcessingAcknowledgment: true,
    documentProcessingAcknowledgedAt: existing.documentProcessingAcknowledgedAt || now(),
    applicantDateOfBirth: dateOfBirth.value,
    guardianConfirmation: applicantIsUnder18 ? true : false,
    guardianConfirmedAt: applicantIsUnder18 ? (existing.guardianConfirmedAt || now()) : null,
    guardianName: applicantIsUnder18 ? guardianName : null,
    guardianEmail: applicantIsUnder18 && /^\S+@\S+\.\S+$/.test(guardianEmail) ? guardianEmail : null,
    guardianPhone: applicantIsUnder18 ? guardianPhone || null : null
  };
}
function publicAdmissionDocument(document) { const { storageKey, ...safe } = document; return safe; }
async function sendAdmissionIntakeNotice(state, enrollment) {
  const student = state.students.find(item => item.id === enrollment.studentId), application = { enrollmentId: enrollment.id, assignedBatchCode: enrollment.assignedBatchCode, status: enrollment.status, student: student ? { id: student.id, name: student.name, email: student.email, phone: student.phone } : null, selectedSubjects: enrollment.selectedSubjects || [], documentTypes: state.admissionDocuments.filter(item => item.enrollmentId === enrollment.id).map(item => item.type) };
  const publicUrl = String(process.env.APP_PUBLIC_URL || '').replace(/\/$/, ''), documentLinks = state.admissionDocuments.filter(item => item.enrollmentId === enrollment.id).map(item => `${item.label}: ${publicUrl ? `${publicUrl}/api/admin/admission-documents/${item.id}/download` : `Admin portal → application ${enrollment.id}`}`).join('\n'), text = `New paid-gated admission application\n\nStudent: ${student?.name || 'Student'}\nEmail: ${student?.email || '—'}\nPhone: ${student?.phone || '—'}\nBatch: ${application.assignedBatchCode}\nSubjects: ${(application.selectedSubjects || []).map(item => `${item.code} ${item.name}`).join(', ')}\n\nProtected documents:\n${documentLinks}\n\nOpen the authenticated admin portal to review/download files.`;
  const attemptedAt = now(), provider = process.env.RESEND_API_KEY && process.env.ADMIN_ADMISSION_EMAIL ? 'resend' : process.env.ADMISSION_INTAKE_WEBHOOK_URL ? 'webhook' : 'academy-review-queue';
  try {
    if (provider === 'resend') { const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.ADMISSION_EMAIL_FROM || 'Admissions <onboarding@resend.dev>', to: [process.env.ADMIN_ADMISSION_EMAIL], subject: `New NIOS application — ${student?.name || enrollment.id}`, text }), signal: AbortSignal.timeout(12_000) }); if (!response.ok) throw new Error(`Admin email delivery failed: ${response.status}`); return { status: 'sent', provider, attemptedAt, error: null }; }
    if (provider === 'webhook') { const response = await fetch(process.env.ADMISSION_INTAKE_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'admission.submitted', at: attemptedAt, application, text }), signal: AbortSignal.timeout(8_000) }); if (!response.ok) throw new Error(`Intake webhook delivery failed: ${response.status}`); return { status: 'sent', provider, attemptedAt, error: null }; }
    return { status: 'queued', provider, attemptedAt, error: null };
  } catch (error) { const message = String(error.message || 'Notification delivery failed.').slice(0, 300); console.warn('Admission intake notification failed:', message); return { status: 'failed', provider, attemptedAt, error: message }; }
}
async function sendEnquiryNotice(enquiry) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_ADMISSION_EMAIL) return 'queued';
  const text = `New website enquiry\n\nName: ${enquiry.name}\nEmail: ${enquiry.email}\nMobile: ${enquiry.phone}\nTopic: ${enquiry.topic}\n\nMessage:\n${enquiry.message}${enquiry.attachmentName ? `\n\nAttachment stored securely: ${enquiry.attachmentName}` : ''}`;
  try {
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.ADMISSION_EMAIL_FROM || 'Admissions <onboarding@resend.dev>', to: [process.env.ADMIN_ADMISSION_EMAIL], subject: `Website enquiry — ${enquiry.topic}`, text }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Resend returned ${response.status}`);
    return 'sent';
  } catch (error) { console.warn('Enquiry email delivery failed:', error.message); return 'queued'; }
}
async function sendStaffInvite(email, token, role = 'teacher') {
  const publicUrl = String(process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
  const setupUrl = `${publicUrl}/accept-invite?token=${encodeURIComponent(token)}`;
  if (!process.env.RESEND_API_KEY) return { delivered: false, setupUrl: isProduction ? null : setupUrl };
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.ADMISSION_EMAIL_FROM || 'NIOS Best Academy <onboarding@resend.dev>', to: [email], subject: `Set up your ${role === 'admin' ? 'administrator' : 'teacher'} account`, text: `You have been invited to NIOS Best Academy. Create your password using this single-use link (valid for 24 hours):\n\n${setupUrl}\n\nIf you did not expect this invitation, ignore this email.` }), signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw Object.assign(new Error(`Invitation email delivery failed with HTTP ${response.status}.`), { status: 502 });
  return { delivered: true, setupUrl: null };
}

function awsKey(dateStamp, region, service, secret) {
  const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), 'aws4_request');
}
function awsDate(date = new Date()) { return date.toISOString().replace(/[:-]|\.\d{3}/g, ''); }
function encodeObjectKey(key) { return key.split('/').map(encodeURIComponent).join('/'); }
async function s3Request(method, key, body, contentType = 'application/octet-stream') {
  const bucket = process.env.S3_BUCKET, region = process.env.S3_REGION || 'ap-south-1', accessKey = process.env.S3_ACCESS_KEY_ID, secret = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKey || !secret) throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY are required for S3 storage.');
  const host = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT).host : `${bucket}.s3.${region}.amazonaws.com`;
  const scheme = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT).protocol : 'https:';
  const uri = `/${encodeObjectKey(key)}`;
  const amz = awsDate(), date = amz.slice(0, 8), payloadHash = createHash('sha256').update(body || '').digest('hex');
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amz}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `${method}\n${uri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/s3/aws4_request`;
  const signature = createHmac('sha256', awsKey(date, region, 's3', secret)).update(`AWS4-HMAC-SHA256\n${amz}\n${scope}\n${createHash('sha256').update(canonicalRequest).digest('hex')}`).digest('hex');
  const response = await fetch(`${scheme}//${host}${uri}`, { method, headers: { 'content-type': contentType, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, body: body?.length ? body : undefined, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`S3 ${method} failed: ${response.status}`);
  return response;
}
async function supabaseRequest(method, key, body, contentType = 'application/octet-stream') {
  const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), bucket = process.env.SUPABASE_BUCKET, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !bucket || !serviceKey) throw new Error('SUPABASE_URL, SUPABASE_BUCKET, and SUPABASE_SERVICE_ROLE_KEY are required for Supabase Storage.');
  // New sb_secret_ keys are API keys, not JWTs. Storage rejects them when they
  // are incorrectly sent as a Bearer token ("Invalid Compact JWS"). Keep the
  // Authorization header only for legacy service_role JWTs during migration.
  const legacyJwt = String(serviceKey).startsWith('eyJ');
  const response = await fetch(`${baseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${encodeObjectKey(key)}`, { method, headers: { apikey: serviceKey, ...(legacyJwt ? { authorization: `Bearer ${serviceKey}` } : {}), 'content-type': contentType, ...(method === 'POST' ? { 'x-upsert': 'true' } : {}) }, body: body?.length ? body : undefined, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 360);
    throw new Error(`Supabase Storage ${method} failed: ${response.status}${detail ? ` — ${detail}` : ''}`);
  }
  return response;
}
const storage = {
  async put(key, bytes, contentType) {
    if (process.env.STORAGE_DRIVER === 's3') { await s3Request('PUT', key, bytes, contentType); return { key, provider: 's3' }; }
    if (process.env.STORAGE_DRIVER === 'supabase') { await supabaseRequest('POST', key, bytes, contentType); return { key, provider: 'supabase' }; }
    const destination = join(filesDir, normalize(key).replace(/^([.][.][\\/])+/, ''));
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes); return { key, provider: 'local' };
  },
  async get(key) {
    if (process.env.STORAGE_DRIVER === 's3') {
      const response = await s3Request('GET', key, null);
      return { bytes: Buffer.from(await response.arrayBuffer()), provider: 's3' };
    }
    if (process.env.STORAGE_DRIVER === 'supabase') {
      const response = await supabaseRequest('GET', key, null);
      return { bytes: Buffer.from(await response.arrayBuffer()), provider: 'supabase' };
    }
    return { bytes: await readFile(join(filesDir, normalize(key).replace(/^([.][.][\\/])+/, ''))), provider: 'local' };
  }
};

let zoomToken = null;
async function zoomAccessToken() {
  const accountId = String(process.env.ZOOM_ACCOUNT_ID || '').trim(), clientId = String(process.env.ZOOM_CLIENT_ID || '').trim(), clientSecret = String(process.env.ZOOM_CLIENT_SECRET || '').trim();
  if (!accountId || !clientId || !clientSecret) throw Object.assign(new Error('Zoom is not configured. Paste an HTTPS meeting link or configure the server-only Zoom OAuth variables.'), { status: 503 });
  if (zoomToken?.expiresAt > Date.now() + 60_000) return zoomToken.value;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, { method: 'POST', headers: { authorization: `Basic ${basic}` }, signal: AbortSignal.timeout(12_000) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw Object.assign(new Error('Zoom authorization failed. Check the server-only Zoom credentials and app scopes.'), { status: 502 });
  zoomToken = { value: payload.access_token, expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 60) * 1000 };
  return zoomToken.value;
}
async function createZoomMeeting({ title, startsAt, durationMinutes }) {
  const hostUserId = String(process.env.ZOOM_HOST_USER_ID || '').trim();
  if (!isSafeString(hostUserId, 254)) throw Object.assign(new Error('Zoom is connected, but the server-only ZOOM_HOST_USER_ID (the licensed host email or user ID) is missing. Paste an HTTPS meeting link or ask an administrator to finish Zoom setup.'), { status: 503 });
  const token = await zoomAccessToken();
  const response = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(hostUserId)}/meetings`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ topic: title, type: 2, start_time: startsAt, duration: durationMinutes, timezone: process.env.ZOOM_TIMEZONE || 'Asia/Kolkata', settings: { waiting_room: true, join_before_host: false } }), signal: AbortSignal.timeout(15_000) });
  const meeting = await response.json().catch(() => ({}));
  if (!response.ok || !/^https:\/\//.test(meeting.join_url || '')) throw Object.assign(new Error('Zoom could not create this meeting. Use a valid HTTPS meeting link or verify Zoom app permissions.'), { status: 502 });
  return { liveUrl: meeting.join_url, hostUrl: /^https:\/\//.test(meeting.start_url || '') ? meeting.start_url : null, meetingProvider: 'zoom' };
}

async function sendNotification(student, message, options = {}) {
  const provider = process.env.NOTIFICATION_PROVIDER || 'mock';
  const subject = isSafeString(String(options.subject || ''), 140) ? String(options.subject).trim() : 'Update from NIOS Best Academy';
  const kind = isSafeString(String(options.kind || ''), 60) ? String(options.kind).trim() : 'general';
  const payload = { studentId: student.id, channel: provider, kind, message, at: now() };
  if (provider === 'twilio-sms' || provider === 'twilio-whatsapp') {
    const sid = process.env.TWILIO_ACCOUNT_SID, token = process.env.TWILIO_AUTH_TOKEN, from = process.env.TWILIO_FROM;
    if (!sid || !token || !from) throw new Error('Twilio credentials are not configured.');
    const to = provider === 'twilio-whatsapp' ? `whatsapp:${student.phone}` : student.phone;
    const fromValue = provider === 'twilio-whatsapp' && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from;
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: to, From: fromValue, Body: message }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Twilio delivery failed: ${response.status}`);
  } else if (provider === 'wati') {
    if (!process.env.WATI_SEND_URL || !process.env.WATI_TOKEN) throw new Error('WATI_SEND_URL and WATI_TOKEN are required.');
    const response = await fetch(process.env.WATI_SEND_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.WATI_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ whatsappNumber: student.phone.replace(/\D/g, ''), text: message }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`WATI delivery failed: ${response.status}`);
  } else if (provider === 'resend-email') {
    if (!process.env.RESEND_API_KEY || !process.env.ADMISSION_EMAIL_FROM) throw new Error('RESEND_API_KEY and ADMISSION_EMAIL_FROM are required for student email notifications.');
    if (!/^\S+@\S+\.\S+$/.test(String(student.email || ''))) throw new Error('The student does not have a valid email address for notifications.');
    const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: process.env.ADMISSION_EMAIL_FROM, to: [student.email], subject, text: `${message}\n\nSign in to your Student Desk for details.` }), signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Student email delivery failed: ${response.status}`);
  } else if (provider === 'webhook') {
    if (!process.env.WEBHOOK_URL) throw new Error('WEBHOOK_URL is required.');
    await forwardWebhook({ type: 'notification.requested', ...payload });
  }
  await updateState(state => { state.notifications.push({ ...payload, status: 'sent' }); state.audit.push({ action: 'notification.sent', ...payload }); });
  emit(student.id, 'notification.sent', payload);
}

const mockProvider = {
  async check(student) {
    return { admissionConfirmed: true, documents: [
      { type: 'theoryHallTicket', title: 'Theory hall ticket', status: 'Issued', fileName: `theory-hall-ticket-${student.id}.txt`, content: Buffer.from(`Development mock document\nLearner: ${student.name}\nThis is not an official NIOS document.\n`) },
      { type: 'practicalHallTicket', title: 'Practical hall ticket', status: 'Processing' },
      { type: 'tmaReceipt', title: 'TMA receipt', status: 'Pending' }
    ] };
  }
};
const manualReviewProvider = {
  async check() {
    // Production-safe fallback when the academy reviews the official record itself.
    // Never manufacture an official document or unlock a student from a sync action.
    return { admissionConfirmed: false, documents: [] };
  }
};
const approvedConnectorProvider = {
  async check(student, vault) {
    if (!process.env.OFFICIAL_NIOS_CONNECTOR_URL || !process.env.OFFICIAL_NIOS_CONNECTOR_TOKEN) throw new Error('Approved official connector is not configured. Do not automate portal login or bypass CAPTCHA/OTP directly.');
    const response = await fetch(process.env.OFFICIAL_NIOS_CONNECTOR_URL, { method: 'POST', headers: { authorization: `Bearer ${process.env.OFFICIAL_NIOS_CONNECTOR_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ studentId: student.id, vault }), signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`Approved connector failed: ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.documents)) throw new Error('Approved connector returned an invalid documents payload.');
    return { admissionConfirmed: result.admissionConfirmed === true, documents: result.documents };
  }
};
function provider() {
  if (process.env.NIOS_SYNC_MODE === 'official') return approvedConnectorProvider;
  if (process.env.NIOS_SYNC_MODE === 'manual') return manualReviewProvider;
  return mockProvider;
}
const running = new Set();
async function performSync(studentId, jobId) {
  if (running.has(studentId)) return;
  running.add(studentId);
  try {
    const state = await readState(), student = state.students.find(item => item.id === studentId), vaultRecord = state.vault[studentId];
    if (!student || !vaultRecord) throw new Error('Student record or consented vault record not found.');
    const vault = decrypt(vaultRecord);
    if (!vault.consent) throw new Error('Student consent is required before a portal sync.');
    await updateState(data => { const job = data.jobs.find(item => item.id === jobId); if (job) { job.status = 'processing'; job.syncState = 'PENDING'; job.updatedAt = now(); } data.syncLogs.push({ id: uid('sync-log'), at: now(), studentId, jobId, status: 'PENDING', phase: 'processing' }); }); emit(studentId, 'sync.processing', { jobId, status: 'PENDING' });
    const syncResult = await provider().check(student, vault), records = Array.isArray(syncResult) ? syncResult : syncResult.documents;
    const created = [];
    for (const item of records) {
      let storageKey = null;
      if (item.content) { storageKey = `${studentId}/${Date.now()}-${item.fileName || `${item.type}.bin`}`; await storage.put(storageKey, item.content, item.contentType || 'text/plain'); }
      const result = await updateState(data => {
        let document = data.documents.find(entry => entry.studentId === studentId && entry.type === item.type);
        const previouslyIssued = document?.status === 'Issued';
        if (!document) { document = { id: uid('doc'), studentId, type: item.type }; data.documents.push(document); }
        Object.assign(document, { title: item.title || item.type, status: item.status, fileName: item.fileName || document.fileName || null, storageKey: storageKey || document.storageKey || null, source: process.env.NIOS_SYNC_MODE || 'mock', issuedAt: item.status === 'Issued' ? (document.issuedAt || now()) : null, updatedAt: now() });
        data.audit.push({ id: uid('audit'), at: now(), action: 'sync.document-updated', studentId, documentId: document.id, status: document.status });
        if (document.status === 'Issued' && !previouslyIssued) created.push(document);
        return document;
      });
      emit(studentId, 'document.updated', result);
    }
    for (const document of created) await sendNotification(student, `Your ${document.title} is now available in the NIOS Best Academy Student Desk.`);
    const completed = await updateState(data => { const job = data.jobs.find(item => item.id === jobId); if (job) { job.status = 'completed'; job.syncState = 'SUCCESS'; job.updatedAt = now(); } const enrollment = data.enrollments.find(item => item.studentId === studentId && item.status === 'VERIFICATION_IN_PROGRESS'); const confirmed = Boolean(syncResult?.admissionConfirmed); if (enrollment && confirmed) { enrollment.status = 'ACTIVE'; enrollment.officialVerificationConfirmedAt = now(); enrollment.activatedAt = now(); enrollment.updatedAt = now(); const learner = data.students.find(item => item.id === studentId); if (learner) learner.accountStatus = 'ACTIVE_STUDENT'; data.audit.push({ id: uid('audit'), at: now(), action: 'admission.official-confirmed', enrollmentId: enrollment.id, studentId }); } data.syncLogs.push({ id: uid('sync-log'), at: now(), studentId, jobId, status: 'SUCCESS', phase: confirmed ? 'admission-confirmed' : 'verification-pending' }); data.audit.push({ id: uid('audit'), at: now(), action: 'sync.completed', studentId, jobId }); return { confirmed, enrollmentId: enrollment?.id || null }; });
    emit(studentId, completed.confirmed ? 'admission.confirmed' : 'sync.completed', { jobId, status: 'SUCCESS', admissionConfirmed: completed.confirmed, enrollmentId: completed.enrollmentId });
  } catch (error) {
    const syncState = /offline|timeout|network|fetch failed|\b50[234]\b/i.test(error.message) ? 'PORTAL_OFFLINE' : 'FAILED';
    await updateState(data => { const job = data.jobs.find(item => item.id === jobId); if (job) { job.status = syncState === 'PORTAL_OFFLINE' ? 'portal_offline' : 'failed'; job.syncState = syncState; job.error = error.message; job.updatedAt = now(); } data.syncLogs.push({ id: uid('sync-log'), at: now(), studentId, jobId, status: syncState, phase: 'failed', error: error.message }); data.audit.push({ id: uid('audit'), at: now(), action: 'sync.failed', studentId, jobId, error: error.message }); });
    emit(studentId, 'sync.failed', { jobId, status: syncState, error: error.message });
  } finally { running.delete(studentId); }
}
async function queueSync(studentId, trigger = 'manual') {
  const job = await updateState(data => { const created = { id: uid('job'), studentId, trigger, status: 'queued', syncState: 'PENDING', createdAt: now(), updatedAt: now() }; data.jobs.push(created); data.syncLogs.push({ id: uid('sync-log'), at: now(), studentId, jobId: created.id, status: 'PENDING', phase: 'queued', trigger }); data.audit.push({ id: uid('audit'), at: now(), action: 'sync.queued', studentId, jobId: created.id, trigger }); return created; });
  setTimeout(() => void performSync(studentId, job.id), 50); return job;
}
const minutes = Math.max(5, Number(process.env.SYNC_INTERVAL_MINUTES || 15));
if (process.env.NIOS_SYNC_MODE === 'official') setInterval(async () => { const state = await readState(); for (const student of state.students) if (state.vault[student.id]) await queueSync(student.id, 'scheduled'); }, minutes * 60_000).unref();

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); response.end(JSON.stringify(body));
}
async function rawBody(request, maxBytes = 9_000_000) {
  const chunks = []; let size = 0; for await (const chunk of request) { chunks.push(chunk); size += chunk.length; if (size > maxBytes) throw new Error('Request body is too large.'); }
  return Buffer.concat(chunks);
}
async function body(request) {
  const raw = await rawBody(request);
  if (!raw.length) return {}; try { return JSON.parse(raw.toString('utf8')); } catch { throw new Error('Invalid JSON request body.'); }
}
// A small process-local throttle is deliberately conservative: it protects
// password hashing from basic brute force without making a durable lockout
// decision. A dedicated edge rate limiter should supplement this in production.
const authAttempts = new Map();
const authThrottleWindowMs = 15 * 60_000;
function throttleFingerprint(value) { return createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex').slice(0, 24); }
function authThrottleKey(request, scope, identity) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = forwarded || request.socket.remoteAddress || 'unknown';
  return `${scope}:${throttleFingerprint(remote)}:${throttleFingerprint(identity)}`;
}
function enforceAuthThrottle(request, scope, identity, limit) {
  const timestamp = Date.now();
  for (const [key, entry] of authAttempts) if (timestamp - entry.startedAt > authThrottleWindowMs) authAttempts.delete(key);
  const key = authThrottleKey(request, scope, identity), entry = authAttempts.get(key) || { startedAt: timestamp, attempts: 0 };
  if (entry.attempts >= limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.startedAt + authThrottleWindowMs - timestamp) / 1000));
    throw Object.assign(new Error('Too many attempts. Please wait before trying again.'), { status: 429, retryAfter });
  }
  entry.attempts += 1;
  authAttempts.set(key, entry);
  return key;
}
function clearAuthThrottle(key) { if (key) authAttempts.delete(key); }
function detectedUploadMime(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}
function integrationReadiness(state) {
  const storageDriver = String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
  const paymentProvider = String(process.env.PAYMENT_PROVIDER || 'mock').trim().toLowerCase();
  const notificationProvider = String(process.env.NOTIFICATION_PROVIDER || 'mock').trim().toLowerCase();
  const configured = names => names.filter(name => !String(process.env[name] || '').trim());
  const latestDelivery = [...(state.enrollments || [])].filter(item => item.intakeNotice?.attemptedAt).sort((a, b) => String(b.intakeNotice.attemptedAt).localeCompare(String(a.intakeNotice.attemptedAt)))[0]?.intakeNotice || null;
  const storageRequirements = storageDriver === 'supabase' ? ['SUPABASE_URL', 'SUPABASE_BUCKET', 'SUPABASE_SERVICE_ROLE_KEY'] : storageDriver === 's3' ? ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] : [];
  const paymentRequirements = paymentProvider === 'razorpay' ? ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] : [];
  const emailRequirements = notificationProvider === 'resend-email' ? ['RESEND_API_KEY', 'ADMISSION_EMAIL_FROM'] : [];
  const niosMode = String(process.env.NIOS_SYNC_MODE || 'manual').trim().toLowerCase();
  const niosRequirements = niosMode === 'official' ? ['OFFICIAL_NIOS_CONNECTOR_URL', 'OFFICIAL_NIOS_CONNECTOR_TOKEN'] : [];
  return {
    persistence: { ready: stateStore.durable && ['supabase', 's3'].includes(storageDriver), store: stateStore.publicStatus(), storageDriver },
    payments: { provider: paymentProvider, ready: paymentProvider === 'razorpay' && configured(paymentRequirements).length === 0, missing: configured(paymentRequirements) },
    email: { provider: notificationProvider, ready: notificationProvider === 'resend-email' && configured(emailRequirements).length === 0, missing: configured(emailRequirements), latestIntakeDelivery: latestDelivery ? { status: latestDelivery.status, provider: latestDelivery.provider, attemptedAt: latestDelivery.attemptedAt, error: latestDelivery.error || null } : null },
    zoom: { ready: configured(['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID']).length === 0, missing: configured(['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_HOST_USER_ID']) },
    nios: { mode: niosMode, ready: niosMode === 'manual' || configured(niosRequirements).length === 0, missing: configured(niosRequirements) }
  };
}
function requireAdmin(request) {
  const session = readSession(request);
  if (session?.role === 'admin') return session;
  const supplied = request.headers['x-admin-token'];
  if (supplied && supplied.length === adminToken.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(adminToken))) return { role: 'admin', sub: 'service-token' };
  throw Object.assign(new Error('Admin authorization is required.'), { status: 401 });
}
function requireStudent(request, studentId) {
  const session = readSession(request);
  if (!session) throw Object.assign(new Error('Student authorization is required.'), { status: 401 });
  if (session.role === 'admin' || session.studentId === studentId) return session;
  throw Object.assign(new Error('This account cannot access that student record.'), { status: 403 });
}
function requireTeacher(request) {
  const session = readSession(request);
  if (session?.role === 'teacher' || session?.role === 'admin') return session;
  throw Object.assign(new Error('Teacher or administrator authorization is required.'), { status: 401 });
}
function requireSuperAdmin(request, state) {
  const session = readSession(request), user = session && state.users.find(item => item.id === session.sub);
  if (session?.role === 'admin' && user && (user.superAdmin || permanentSuperAdminEmails.has(String(user.email || '').toLowerCase()))) return { session, user };
  throw Object.assign(new Error('Super-admin authorization is required.'), { status: 403 });
}
function teacherAllowedBatchIds(session, state) {
  if (session.role === 'admin') return null;
  const user = state.users.find(item => item.id === session.sub && item.role === 'teacher');
  if (!user || user.suspended) throw Object.assign(new Error('Your teacher account is suspended or unavailable.'), { status: 403 });
  return Array.isArray(user.permissions?.allowedBatchIds) ? user.permissions.allowedBatchIds.map(String) : [];
}
function requireTeacherPermission(request, state, permission, batchId = '') {
  const session = requireTeacher(request);
  if (session.role === 'admin') return session;
  const user = state.users.find(item => item.id === session.sub && item.role === 'teacher');
  if (!user || user.suspended || !user.permissions?.[permission]) throw Object.assign(new Error('Your teacher account does not have permission for this action.'), { status: 403 });
  const allowed = teacherAllowedBatchIds(session, state);
  if (batchId && !allowed.includes(batchId)) throw Object.assign(new Error('This batch is outside your teaching assignment.'), { status: 403 });
  return session;
}
function activeEnrollment(state, studentId) { return state.enrollments.find(enrollment => enrollment.studentId === studentId && enrollment.status === 'ACTIVE'); }
function applicationEnrollment(state, studentId, batchId = '') { return state.enrollments.filter(enrollment => enrollment.studentId === studentId && (!batchId || enrollment.batchId === batchId)).sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))[0]; }
function paidEnrollment(state, studentId) { return state.enrollments.filter(enrollment => enrollment.studentId === studentId && ['PAYMENT_CONFIRMED', 'NEEDS_ACTION', 'VERIFICATION_IN_PROGRESS', 'ACTIVE'].includes(enrollment.status)).sort((a, b) => String(b.updatedAt || b.activatedAt || '').localeCompare(String(a.updatedAt || a.activatedAt || '')))[0]; }
function requireActiveEnrollment(request, state) {
  const session = readSession(request);
  if (!session?.studentId) throw Object.assign(new Error('Student authorization is required.'), { status: 401 });
  const enrollment = activeEnrollment(state, session.studentId);
  if (!enrollment) throw Object.assign(new Error('An active batch enrollment is required to access learning materials.'), { status: 403 });
  return { session, enrollment };
}
function requirePaidEnrollment(request, state) {
  const session = readSession(request);
  if (!session?.studentId) throw Object.assign(new Error('Student authorization is required.'), { status: 401 });
  const enrollment = paidEnrollment(state, session.studentId);
  if (!enrollment) throw Object.assign(new Error('Payment confirmation is required before opening the admission desk.'), { status: 403 });
  return { session, enrollment };
}
function requireApplicationEnrollment(request, state, batchId = '') {
  const session = readSession(request);
  if (!session?.studentId) throw Object.assign(new Error('Student authorization is required.'), { status: 401 });
  const enrollment = applicationEnrollment(state, session.studentId, batchId);
  if (!enrollment) throw Object.assign(new Error('Choose a batch before starting your admission application.'), { status: 404 });
  return { session, enrollment };
}
function studentSubjectsForEnrollment(student, enrollment, state) {
  const batch = state?.batches?.find(item => item.id === enrollment?.batchId);
  const offered = batch ? new Map((batch.subjects || []).map(subject => [String(subject.code), String(subject.name)])) : null;
  const selected = (Array.isArray(enrollment?.selectedSubjects) ? enrollment.selectedSubjects : []).filter(subject => !offered || offered.get(String(subject.code)) === String(subject.name));
  const currentByCode = new Map((student?.subjects || []).map(item => [String(item.code), item]));
  return selected.map(subject => {
    const current = currentByCode.get(String(subject.code));
    return { code: String(subject.code), name: String(subject.name), tmaStatus: current?.tmaStatus || 'Pending', practicalGuide: Boolean(current?.practicalGuide), progress: Number.isFinite(Number(current?.progress)) ? Math.max(0, Math.min(100, Math.round(Number(current.progress)))) : 0 };
  });
}
function forEnrollment(item, enrollment, state) { const batch = state?.batches?.find(record => record.id === enrollment.batchId); const inBatch = batch && item.batchId === enrollment.batchId && item.board === enrollment.board && item.classLevel === enrollment.classLevel && item.stream === enrollment.stream; const selected = Array.isArray(enrollment.selectedSubjects) ? enrollment.selectedSubjects : []; const batchAllowsSubject = Boolean(batch?.subjects?.some(subject => String(subject.code) === String(item.subjectCode) && String(subject.name) === String(item.subject))); return !item.restricted && inBatch && batchAllowsSubject && selected.some(subject => String(subject.code) === String(item.subjectCode) && String(subject.name) === String(item.subject)); }
function publicEnrollment(enrollment, state) { const { applicantDateOfBirth, guardianConfirmation, guardianConfirmedAt, guardianName, guardianEmail, guardianPhone, intakeNotice, ...safe } = enrollment; const batch = state.batches.find(item => item.id === enrollment.batchId); return { ...safe, batch: batch ? { id: batch.id, name: batch.name, stream: batch.stream, streamId: batch.streamId } : null, contentAccess: enrollment.status === 'ACTIVE' }; }
function filePayload(input, maxBytes = 6 * 1024 * 1024) {
  const fileName = String(input.fileName || '').trim(), mimeType = String(input.mimeType || '').trim(), base64 = String(input.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!isSafeString(fileName, 140) || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw Object.assign(new Error('Provide a PDF, JPG, PNG, or WEBP file.'), { status: 422 });
  const bytes = Buffer.from(base64, 'base64'); if (!bytes.length || bytes.length > maxBytes) throw Object.assign(new Error(`File must be smaller than ${Math.floor(maxBytes / 1024 / 1024)} MB.`), { status: 422 });
  if (detectedUploadMime(bytes) !== mimeType) throw Object.assign(new Error('The file contents do not match the selected file type.'), { status: 422 });
  return { fileName: fileName.replace(/[^a-zA-Z0-9._ -]/g, '_'), mimeType, bytes };
}
function publicUser(user) { return { id: user.id, studentId: user.studentId || null, name: user.name, email: user.email, role: user.role, superAdmin: Boolean(user.superAdmin), permissions: user.role === 'teacher' ? user.permissions || defaultTeacherPermissions() : undefined }; }
function sessionHeaders(user) {
  const token = issueSession(user);
  return {
    token,
    headers: { 'set-cookie': `nios_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${isProduction ? '; Secure' : ''}` }
  };
}
function batchFrom(input, existing = {}) {
  const classLevel = String(input.class ?? existing.class ?? '');
  const name = String(input.name ?? existing.name ?? '').trim();
  const badge = String(input.badge ?? existing.badge ?? '').trim();
  const date = String(input.date ?? existing.date ?? '').trim();
  const seats = String(input.seats ?? existing.seats ?? '').trim();
  const price = String(input.price ?? existing.price ?? '').trim();
  const board = String(input.board ?? existing.board ?? 'NIOS').trim();
  const stream = String(input.stream ?? existing.stream ?? 'General').trim();
  const streamId = String(input.streamId ?? existing.streamId ?? `${stream.toLowerCase().replace(/\s+/g, '-')}-${date || 'open'}`).trim();
  const admissionRoute = String(input.admissionRoute ?? existing.admissionRoute ?? (String(input.id || existing.id || '').includes('ondemand') ? 'ode' : 'stream1')).trim();
  const features = Array.isArray(input.features) ? input.features.map(item => String(item).trim()).filter(Boolean).slice(0, 8) : (existing.features || []);
  const sourceSubjects = Array.isArray(input.subjects) ? input.subjects : (existing.subjects || defaultBatchSubjects(classLevel, stream));
  const subjects = sourceSubjects.map(subject => ({ code: String(subject.code || '').trim(), name: String(subject.name || '').trim() }));
  const codes = new Set();
  if (!['10', '12'].includes(classLevel) || !isSafeString(name, 120) || !isSafeString(badge, 40) || !isSafeString(seats, 30) || !isSafeString(price, 30) || features.length === 0 || !subjects.length || subjects.length > 12 || subjects.some(subject => !isSafeString(subject.code, 24) || !isSafeString(subject.name, 80) || codes.has(subject.code) || !codes.add(subject.code))) throw Object.assign(new Error('A valid class, title, badge, seats, price, feature, and unique batch subject list are required.'), { status: 422 });
  return {
    id: existing.id || uid('batch'), class: classLevel, name, badge, features, subjects,
    level: String(input.level ?? existing.level ?? (board === 'NIOS' ? (classLevel === '10' ? 'NIOS Secondary' : 'NIOS Senior Secondary') : board)).slice(0, 80),
    mode: String(input.mode ?? existing.mode ?? '▣ Live interactive').slice(0, 80), duration: String(input.duration ?? existing.duration ?? '◴ 6 months').slice(0, 50),
    starts: String(input.starts ?? existing.starts ?? date).slice(0, 60), date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', seats, fill: String(input.fill ?? existing.fill ?? '18%').slice(0, 10),
    price, old: String(input.old ?? existing.old ?? '').slice(0, 30), off: String(input.off ?? existing.off ?? '').slice(0, 30),
    popular: Boolean(input.popular ?? existing.popular), tone: ['aqua', 'pink'].includes(input.tone ?? existing.tone) ? (input.tone ?? existing.tone) : undefined,
    board: ['NIOS', 'BOSSE', 'IGNOU', 'CBSE Private', 'DU SOL'].includes(board) ? board : 'NIOS', stream: isSafeString(stream, 60) ? stream : 'General', streamId: isSafeString(streamId, 90) ? streamId : 'general-open', admissionRoute: ['stream1', 'stream2', 'ode', 'always'].includes(admissionRoute) ? admissionRoute : 'stream1',
    published: Boolean(input.published ?? existing.published ?? false), updatedAt: now()
  };
}
function subjectMappings(value) {
  if (!Array.isArray(value) || value.length > 12) throw Object.assign(new Error('Provide up to 12 subject mappings.'), { status: 422 });
  return value.map(subject => {
    const code = String(subject.code || '').trim(), name = String(subject.name || '').trim(), tmaStatus = String(subject.tmaStatus || 'Pending').trim();
    const progress = Number(subject.progress ?? 0);
    if (!isSafeString(code, 24) || !isSafeString(name, 80) || !['Pending', 'In progress', 'Submitted', 'Draft due'].includes(tmaStatus) || !Number.isFinite(progress) || progress < 0 || progress > 100) throw Object.assign(new Error('Each subject needs a code, name, valid TMA state, and 0–100 progress.'), { status: 422 });
    return { code, name, tmaStatus, practicalGuide: Boolean(subject.practicalGuide), progress: Math.round(progress) };
  });
}
const admissionSubjectCatalog = {
  '10': [
    { code: '201', name: 'Hindi' }, { code: '202', name: 'English' }, { code: '211', name: 'Mathematics' },
    { code: '212', name: 'Science' }, { code: '213', name: 'Social Science' }, { code: '229', name: 'Data Entry Operations' }
  ],
  science: [
    { code: '302', name: 'English' }, { code: '311', name: 'Mathematics' }, { code: '312', name: 'Physics' },
    { code: '313', name: 'Chemistry' }, { code: '314', name: 'Biology' }, { code: '336', name: 'Data Entry Operations' }
  ],
  commerce: [
    { code: '302', name: 'English' }, { code: '318', name: 'Economics' }, { code: '319', name: 'Business Studies' },
    { code: '320', name: 'Accountancy' }, { code: '336', name: 'Data Entry Operations' }
  ],
  humanities: [
    { code: '302', name: 'English' }, { code: '317', name: 'Political Science' }, { code: '318', name: 'Economics' },
    { code: '328', name: 'Psychology' }, { code: '331', name: 'Sociology' }, { code: '336', name: 'Data Entry Operations' }
  ]
};
function admissionSubjectOptions(batch) {
  if (Array.isArray(batch?.subjects) && batch.subjects.length) return batch.subjects.map(subject => ({ code: String(subject.code), name: String(subject.name) }));
  if (String(batch?.class) === '10') return admissionSubjectCatalog['10'];
  const stream = String(batch?.stream || '').toLowerCase();
  if (/science/.test(stream)) return admissionSubjectCatalog.science;
  if (/commerce|business/.test(stream)) return admissionSubjectCatalog.commerce;
  if (/art|humanit|social/.test(stream)) return admissionSubjectCatalog.humanities;
  return [...admissionSubjectCatalog.science, ...admissionSubjectCatalog.commerce, ...admissionSubjectCatalog.humanities]
    .filter((subject, index, list) => list.findIndex(item => item.code === subject.code) === index);
}
function admissionSubjects(value, options = []) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw Object.assign(new Error('Choose between 1 and 8 subjects for admission.'), { status: 422 });
  const seen = new Set();
  const allowedByCode = new Map(options.map(subject => [subject.code, subject.name]));
  return value.map(item => { const code = String(item.code || '').trim(), name = String(item.name || '').trim(); if (!isSafeString(code, 24) || !isSafeString(name, 80) || seen.has(code)) throw Object.assign(new Error('Each selected subject needs a unique code and name.'), { status: 422 }); if (allowedByCode.size && allowedByCode.get(code) !== name) throw Object.assign(new Error('Choose subjects offered by your selected batch and stream.'), { status: 422 }); seen.add(code); return { code, name }; });
}
function targetForBatch(input, state) {
  const batch = state.batches.find(item => item.id === String(input.batchId || '').trim());
  if (!batch) throw Object.assign(new Error('Choose a valid target batch.'), { status: 422 });
  const subjectCode = String(input.subjectCode || '').trim(), subject = String(input.subject || '').trim();
  const allowed = admissionSubjectOptions(batch);
  if (!isSafeString(subjectCode, 24) || !isSafeString(subject, 80) || !allowed.some(item => item.code === subjectCode && item.name === subject)) throw Object.assign(new Error('Choose a subject configured for the target batch.'), { status: 422 });
  return { batchId: batch.id, board: batch.board, classLevel: batch.class, stream: batch.stream, subjectCode, subject };
}
function classroomView(item) {
  const start = new Date(item.startsAt).getTime(), end = start + Number(item.durationMinutes || 60) * 60_000, current = Date.now();
  const { hostUrl, ...safe } = item, joinEnabled = !item.restricted && current >= start - 10 * 60_000 && current < end;
  return { ...safe, liveUrl: joinEnabled ? safe.liveUrl : null, joinEnabled, isPast: current >= end, recordingAvailable: !item.restricted && Boolean(item.recordingUrl) && current >= end };
}
function teacherClassroomView(item) { const studentView = classroomView(item); return { ...studentView, liveUrl: item.liveUrl || null, hostUrl: item.hostUrl || null }; }
const attendanceStatuses = new Set(['Present', 'Late', 'Excused', 'Absent']);
function liveClassHasEnded(item) {
  const start = Date.parse(item.startsAt);
  return Number.isFinite(start) && Date.now() >= start + Number(item.durationMinutes || 60) * 60_000;
}
function attendanceEligibleStudents(state, liveClass) {
  const byStudent = new Map();
  for (const enrollment of state.enrollments.filter(item => item.status === 'ACTIVE' && forEnrollment(liveClass, item, state))) {
    const student = state.students.find(item => item.id === enrollment.studentId);
    if (student) byStudent.set(student.id, { student, enrollment });
  }
  return [...byStudent.values()];
}
function attendanceRoster(state, liveClass) {
  const eligible = attendanceEligibleStudents(state, liveClass);
  const eligibleIds = new Set(eligible.map(item => item.student.id));
  const records = state.attendance.filter(item => item.liveClassId === liveClass.id && eligibleIds.has(item.studentId));
  const byStudent = new Map(records.map(item => [item.studentId, item]));
  const count = status => records.filter(item => item.status === status).length;
  const present = count('Present'), late = count('Late'), excused = count('Excused'), absent = count('Absent'), marked = present + late + excused + absent;
  return {
    liveClass: teacherClassroomView(liveClass),
    summary: {
      eligible: eligible.length, marked, present, late, excused, absent,
      pending: Math.max(0, eligible.length - marked), attended: present + late,
      attendanceRate: eligible.length ? Math.round(((present + late) / eligible.length) * 100) : null,
      finalizedAt: liveClass.attendanceFinalizedAt || null
    },
    students: eligible.map(({ student }) => {
      const record = byStudent.get(student.id);
      return {
        id: student.id, name: student.name, status: record?.status || 'Unmarked',
        minutesAttended: Number.isFinite(record?.minutesAttended) ? record.minutesAttended : null,
        note: record?.note || '', markedAt: record?.markedAt || null,
        absenceNotifiedAt: record?.absenceNotifiedAt || null
      };
    })
  };
}
function attendanceClassAccess(request, state, classId) {
  const liveClass = state.liveClasses.find(item => item.id === classId);
  if (!liveClass) throw Object.assign(new Error('Live class not found.'), { status: 404 });
  const staff = requireTeacherPermission(request, state, 'manageLiveClasses', liveClass.batchId);
  return { liveClass, staff };
}
function activateEnrollment(state, payment, providerReference) {
  const batch = state.batches.find(item => item.id === payment.batchId); if (!batch) throw Object.assign(new Error('The purchased batch no longer exists.'), { status: 404 });
  payment.status = 'CAPTURED'; payment.providerReference = providerReference || payment.providerReference || payment.id; payment.capturedAt = now();
  let enrollment = state.enrollments.find(item => item.studentId === payment.studentId && item.batchId === payment.batchId && item.status !== 'ACTIVE');
  if (!enrollment) { enrollment = { id: uid('enrol'), studentId: payment.studentId, batchId: batch.id, assignedBatchCode: payment.assignedBatchCode, streamId: batch.streamId, board: batch.board, classLevel: batch.class, stream: batch.stream, cycle: payment.cycle, selectedSubjects: payment.selectedSubjects || [], status: 'PAYMENT_CONFIRMED', paymentConfirmedAt: now(), updatedAt: now() }; state.enrollments.push(enrollment); }
  else { Object.assign(enrollment, { assignedBatchCode: payment.assignedBatchCode || enrollment.assignedBatchCode, cycle: payment.cycle || enrollment.cycle, selectedSubjects: payment.selectedSubjects || enrollment.selectedSubjects || [], status: 'PAYMENT_CONFIRMED', paymentConfirmedAt: now(), updatedAt: now() }); }
  const student = state.students.find(item => item.id === payment.studentId); if (student) student.accountStatus = 'PAID_ADMISSION_PENDING';
  state.audit.push({ id: uid('audit'), at: now(), action: 'payment.captured', studentId: payment.studentId, paymentId: payment.id, batchId: batch.id });
  return enrollment;
}
function publicStudent(student, state) {
  const syncLogs = (state.syncLogs || []).filter(item => item.studentId === student.id).slice(-20).reverse();
  const enrollment = paidEnrollment(state, student.id) || applicationEnrollment(state, student.id) || activeEnrollment(state, student.id);
  const vault = state.vault[student.id] ? tryDecrypt(state.vault[student.id]) : null;
  const vaultNeedsReview = !vault && Boolean(state.vault[student.id] || state.vaultRecovery?.[student.id]);
  return { id: student.id, name: student.name, board: student.board, boardCode: student.boardCode || student.board, classLevel: student.classLevel, referenceNumber: student.referenceNumber, accountStatus: student.accountStatus || (enrollment?.status === 'ACTIVE' ? 'ACTIVE_STUDENT' : paidEnrollment(state, student.id) ? 'PAID_ADMISSION_PENDING' : enrollment ? 'APPLICATION_PENDING_PAYMENT' : 'LEAD'), enrollment: enrollment ? publicEnrollment(enrollment, state) : null, subjects: enrollment ? studentSubjectsForEnrollment(student, enrollment, state) : (student.subjects || []), vault: vault ? { configured: true, consented: Boolean(vault.consent) } : { configured: false, needsReview: vaultNeedsReview }, documents: state.documents.filter(item => item.studentId === student.id).map(({ id, type, title, status, fileName, issuedAt, updatedAt, storageKey }) => ({ id, type, title, status, fileName, issuedAt, updatedAt, downloadable: Boolean(storageKey) })), syncLogs };
}
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };
async function serveStatic(pathname, response, request) {
  // Never expose backend configuration, state, credentials or QA artifacts.
  if (pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.')) || pathname.startsWith('/portal-service/')) return send(response, 404, { error: 'Not found' });
  // Do not let the Render service hostname publish a competing sitemap or
  // invite crawlers before the real HTTPS domain is connected and configured.
  if (!searchIndexingAllowed(request) && pathname === '/robots.txt') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive' });
    return response.end('User-agent: *\nDisallow: /\n');
  }
  if (!searchIndexingAllowed(request) && pathname === '/sitemap.xml') return send(response, 404, { error: 'Not found' });
  // Keep the legacy direct URL on the same clear owner-only staff experience.
  if (pathname === '/admin/staff' || pathname === '/admin-staff.html') pathname = '/admin-staff-v2.html';
  const aliases = { '/dashboard': '/active-student-dashboard.html', '/student-desk.html': '/active-student-dashboard.html', '/student-app': '/student-app.html', '/admission-intake': '/admission-wizard-v2.html', '/admission-intake.html': '/admission-wizard-v2.html', '/application-wizard.html': '/admission-wizard-v2.html', '/admin': '/admission-admin.html', '/admin/admissions': '/admission-admin.html', '/admin-dashboard.html': '/admission-admin.html', '/admin/batches': '/admin-batches.html', '/admin/materials': '/admin-materials.html', '/admin-resources.html': '/admin-materials.html', '/admin/staff': '/admin-staff.html', '/admin/student-access': '/admin-student-access.html', '/admin/operations': '/admin-health.html', '/admin-operations.html': '/admin-health.html', '/teacher-portal': '/teacher-portal-v2.html', '/teacher-portal.html': '/teacher-portal-v2.html', '/live-classes': '/batch-hub.html', '/homework': '/batch-hub.html', '/checkout': '/checkout-v2.html', '/checkout.html': '/checkout-v2.html', '/login': '/auth-v2.html', '/auth.html': '/auth-v2.html', '/accept-invite': '/accept-invite.html' };
  let requested = pathname === '/' ? '/index.html' : (aliases[pathname] || pathname);
  if (!extname(requested)) requested += '.html';
  const protectedDesk = ['/dashboard', '/student-app', '/student-app.html', '/student-desk.html', '/active-student-dashboard.html', '/pending-admission-dashboard.html', '/payment-pending.html', '/batch-hub.html', '/live-classes', '/homework', '/checkout', '/checkout.html', '/checkout-v2.html', '/admission-intake', '/admission-intake.html', '/application-wizard.html', '/admission-wizard-v2.html'].includes(pathname);
  const protectedAdmin = /^\/admin(?:[./-]|$)/.test(pathname) || pathname === '/admission-admin.html';
  const protectedTeacher = ['/teacher-portal', '/teacher-portal.html', '/teacher-portal-v2.html'].includes(pathname);
  let sessionBootstrapRole = '';
  // A stale browser-side course draft must not take a paid learner back into
  // admission intake. Keep the server-authorized desk as the routing source.
  if (pathname === '/admission-intake' || pathname === '/admission-intake.html') {
    const session = readSession(request);
    if (session?.studentId) {
      const state = await readState();
      if (paidEnrollment(state, session.studentId)) {
        response.writeHead(302, { location: '/dashboard', 'cache-control': 'no-store', vary: 'Cookie' });
        return response.end();
      }
    }
  }
  if (protectedAdmin) {
    const session = readSession(request);
    if (session?.role !== 'admin') requested = '/auth-v2.html';
    else sessionBootstrapRole = 'admin';
  } else if (protectedTeacher) {
    const session = readSession(request);
    if (!['teacher', 'admin'].includes(session?.role)) requested = '/auth-v2.html';
    else sessionBootstrapRole = session.role;
  } else if (protectedDesk) { const session = readSession(request); if (!session?.studentId) requested = '/auth-v2.html'; else { sessionBootstrapRole = 'student'; const state = await readState(), paid = paidEnrollment(state, session.studentId), application = applicationEnrollment(state, session.studentId), wantsStudentApp = pathname === '/student-app' || pathname === '/student-app.html'; if (wantsStudentApp && paid) requested = '/student-app.html'; else if (paid?.status === 'ACTIVE') requested = pathname === '/dashboard' || pathname === '/student-desk.html' || pathname === '/active-student-dashboard.html' ? '/active-student-dashboard.html' : '/batch-hub.html'; else requested = paid ? '/pending-admission-dashboard.html' : application ? '/payment-pending.html' : '/auth-v2.html'; } }
  const file = resolve(root, `.${requested}`);
  if (!file.startsWith(root)) return send(response, 403, { error: 'Forbidden' });
  try {
    const details = await stat(file); if (!details.isFile()) throw new Error('Not a file');
    // Assets use readable, non-hashed filenames. Revalidate app code on every
    // visit so a deployed UI/security fix is not hidden behind a one-hour cache.
    const extension = extname(file).toLowerCase(), isAppShell = ['.html', '.webmanifest', '.js', '.css'].includes(extension) || requested.endsWith('-sw.js');
    const seoDocument = extension === '.html' || requested === '/robots.txt' || requested === '/sitemap.xml' || requested === '/seo-site.js';
    const publicOriginTag = publicOrigin?.origin || 'unconfigured-public-origin';
    const etag = `W/"${details.size}-${Math.trunc(details.mtimeMs)}-${createHash('sha256').update(publicOriginTag).digest('hex').slice(0, 12)}"`;
    const headers = {
      'content-type': mime[extension] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      etag,
      'cache-control': (protectedDesk || protectedAdmin || protectedTeacher) ? 'private, no-store' : ((isAppShell || seoDocument) ? 'no-cache' : 'public, max-age=3600, stale-while-revalidate=86400'),
      ...((protectedDesk || protectedAdmin || protectedTeacher) ? { vary: 'Cookie' } : {})
    };
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); return response.end(); }
    let content = await readFile(file);
    if (publicOrigin && ['.html', '.xml', '.txt', '.js'].includes(extension)) {
      content = Buffer.from(content.toString('utf8').replaceAll('https://niosbest.in', publicOrigin.origin), 'utf8');
    }
    if (sessionBootstrapRole && extension === '.html') {
      const bootstrap = `<script>try{if(!sessionStorage.getItem('niosSession'))sessionStorage.setItem('niosSession',JSON.stringify({id:'cookie-session',role:'${sessionBootstrapRole}'}));}catch{}</script>`;
      content = Buffer.from(content.toString('utf8').replace('</head>', `${bootstrap}</head>`), 'utf8');
    }
    response.writeHead(200, headers); response.end(content);
  }
  catch { send(response, 404, { error: 'Not found' }); }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`), path = url.pathname, method = request.method || 'GET';
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(self)');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('content-security-policy', "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://api.razorpay.com; script-src 'self' 'unsafe-inline' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; upgrade-insecure-requests");
    if (isProduction) response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains; preload');
    if (isPrivateSearchPath(path) || !searchIndexingAllowed(request)) response.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
    // Do not let an ephemeral filesystem collect student identities, files,
    // payment state, or staff changes in production. Read-only public pages
    // remain available with an actionable response while Supabase is set up.
    const mutatingApiRequest = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && path.startsWith('/api/');
    const safeWithoutDurableState = new Set(['/api/auth/login', '/api/auth/logout', '/api/counselor']);
    if (mutatingApiRequest && !productionWritesReady && !safeWithoutDurableState.has(path)) {
      return send(response, 503, {
        error: 'Admissions, document uploads, payments, and portal changes are temporarily unavailable while durable database storage is configured.',
        code: 'DURABLE_STATE_REQUIRED',
        stateStore: stateStore.publicStatus(),
        storageDriver: String(process.env.STORAGE_DRIVER || 'local'),
        setup: 'Apply the portal-state migration and set PORTAL_STATE_DRIVER=supabase with the server-only Supabase variables.'
      });
    }
    if (path === '/api/counselor' && method === 'POST') {
      const session = readSession(request);
      if (!session?.studentId) return send(response, 401, {error:'Sign in with your student account to use the assistant.'});
      const input = await body(request), state = await readState();
      const student = state.students.find(item => item.id === session.studentId);
      if (!student) return send(response, 403, {error:'Student profile unavailable.'});
      const enrollment = applicationEnrollment(state, session.studentId);
      student.subjects = studentSubjectsForEnrollment(student, enrollment, state);
      return send(response, 200, counselorReply(input.message, {enrollment,subjects:student.subjects||[]}, String(input.topic||'')));
    }
    if (await resourceStore(request,response,url,{readState,updateState,readSession,requireAdmin,body,send,storage,filePayload,uid,isProduction})) return;
    if (method === 'GET' && path === '/api/health') return send(response, 200, {
      ok: true,
      readyForWrites: productionWritesReady,
      mode: process.env.NIOS_SYNC_MODE || 'mock',
      storage: process.env.STORAGE_DRIVER || 'local',
      notificationProvider: process.env.NOTIFICATION_PROVIDER || 'mock',
      stateStore: stateStore.publicStatus(),
      durableFileStorage,
      at: now()
    });
    if (method === 'GET' && path === '/api/admission-cycle') { const route = String(url.searchParams.get('route') || 'stream1'); return send(response, 200, admissionCycle(route)); }
    if (method === 'GET' && path === '/api/batches') { const state = await readState(); return send(response, 200, state.batches.filter(batch => { const cycle = batch.board === 'NIOS' ? admissionCycle(batchAdmissionRoute(batch)) : { isOpen: true, route: 'always' }; return batch.published !== false && cycle.isOpen; }).map(batch => { const cycle = batch.board === 'NIOS' ? admissionCycle(batchAdmissionRoute(batch)) : { isOpen: true, route: 'always', lateFee: false }; return { ...batch, admission: cycle, assignedBatchCode: batch.board === 'NIOS' ? assignedBatchCode(batch, cycle) : `BATCH-${batch.id.toUpperCase()}` }; })); }
    if (method === 'POST' && path === '/api/auth/register') {
      const input = await body(request), name = String(input.name || '').trim(), email = String(input.email || '').trim().toLowerCase(), password = String(input.password || ''), phone = String(input.phone || '').trim();
      const throttleKey = enforceAuthThrottle(request, 'register', email || phone || 'unknown', 6);
      if (!isSafeString(name, 80) || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8 || !isSafeString(phone, 30)) return send(response, 422, { error: 'Name, valid email, mobile number, and an 8-character password are required.' });
      const user = await updateState(state => {
        if (state.users.some(item => item.email === email)) throw Object.assign(new Error('An account with this email already exists.'), { status: 409 });
        const studentId = uid('student');
        const created = { id: uid('user'), studentId, name, email, passwordHash: hashPassword(password), role: 'student', createdAt: now() };
        state.users.push(created);
        state.students.push({ id: studentId, name, email, phone, board: 'NIOS', boardCode: 'NIOS', classLevel: 'Unselected', referenceNumber: `RF-${new Date().getFullYear()}-${randomBytes(4).toString('hex').toUpperCase()}`, subjects: [], createdAt: now() });
        state.audit.push({ id: uid('audit'), at: now(), action: 'student.registered', studentId });
        return created;
      });
      const session = sessionHeaders(user);
      clearAuthThrottle(throttleKey);
      return send(response, 201, { user: publicUser(user), ...(isProduction ? {} : { token: session.token }) }, session.headers);
    }
    if (method === 'POST' && path === '/api/auth/login') {
      const input = await body(request), email = String(input.email || '').trim().toLowerCase(), password = String(input.password || '');
      const throttleKey = enforceAuthThrottle(request, 'login', email || 'unknown', 8);
      const state = await readState(), user = state.users.find(item => item.email === email);
      if (!user || !matchesPassword(password, user.passwordHash)) return send(response, 401, { error: 'We could not match those sign-in details.' });
      const session = sessionHeaders(user);
      clearAuthThrottle(throttleKey);
      return send(response, 200, { user: publicUser(user), ...(isProduction ? {} : { token: session.token }) }, session.headers);
    }
    if (method === 'POST' && path === '/api/auth/logout') return send(response, 200, { ok: true }, { 'set-cookie': `nios_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isProduction ? '; Secure' : ''}` });
    if (method === 'POST' && path === '/api/auth/accept-invite') { const input = await body(request), token = String(input.token || ''), password = String(input.password || ''), throttleKey = enforceAuthThrottle(request, 'accept-invite', token || 'unknown', 8); if (token.length < 32 || password.length < 12) return send(response, 422, { error: 'Use a valid invitation and a password of at least 12 characters.' }); const tokenHash = createHash('sha256').update(token).digest('hex'); const accepted = await updateState(state => { const user = state.users.find(item => item.inviteTokenHash === tokenHash && Date.parse(item.inviteExpiresAt || '') > Date.now()); if (!user) throw Object.assign(new Error('This invitation is invalid or expired.'), { status: 410 }); user.passwordHash = hashPassword(password); user.requiresPasswordSetup = false; delete user.inviteTokenHash; delete user.inviteExpiresAt; user.passwordSetAt = now(); state.audit.push({ id: uid('audit'), at: now(), action: 'staff.invite-accepted', staffId: user.id, role: user.role }); return user; }); clearAuthThrottle(throttleKey); return send(response, 200, { user: publicUser(accepted) }); }
    if (method === 'GET' && path === '/api/auth/me') { const session = readSession(request); if (!session) return send(response, 401, { error: 'Sign-in is required.' }); const state = await readState(), user = state.users.find(item => item.id === session.sub); if (!user) return send(response, 401, { error: 'Account not found.' }); const student = user.studentId ? state.students.find(item => item.id === user.studentId) : null; return send(response, 200, { user: publicUser(user), profile: student ? publicStudent(student, state) : null }); }
    if (method === 'POST' && path === '/api/enquiries') {
      const input = await body(request), name = String(input.name || '').trim(), email = String(input.email || '').trim().toLowerCase(), phone = String(input.phone || '').trim(), topic = String(input.topic || '').trim(), message = String(input.message || '').trim();
      if (!isSafeString(name, 80) || !/^\S+@\S+\.\S+$/.test(email) || !isSafeString(phone, 30) || !isSafeString(topic, 100) || !isSafeString(message, 2000)) return send(response, 422, { error: 'Name, email, mobile number, topic and a clear message are required.' });
      let attachment = null;
      if (input.base64) { const file = filePayload(input, 2 * 1024 * 1024); if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimeType)) return send(response, 422, { error: 'Attachments must be a PDF, JPG or PNG under 2 MB.' }); const storageKey = `enquiries/${Date.now()}-${file.fileName}`; await storage.put(storageKey, file.bytes, file.mimeType); attachment = { fileName: file.fileName, mimeType: file.mimeType, storageKey }; }
      const enquiry = await updateState(state => { const created = { id: uid('enquiry'), name, email, phone, topic, message, attachmentName: attachment?.fileName || null, attachmentKey: attachment?.storageKey || null, status: 'NEW', createdAt: now() }; state.enquiries.push(created); state.audit.push({ id: uid('audit'), at: now(), action: 'website.enquiry-created', enquiryId: created.id }); return created; });
      const delivery = await sendEnquiryNotice(enquiry); return send(response, 201, { id: enquiry.id, delivery });
    }
    if (method === 'POST' && path === '/api/payments/razorpay/webhook') {
      const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
      if (!webhookSecret) return send(response, 503, { error: 'Razorpay webhook verification is not configured.' });
      const raw = await rawBody(request), supplied = String(request.headers['x-razorpay-signature'] || ''), expected = createHmac('sha256', webhookSecret).update(raw).digest('hex');
      if (!supplied || supplied.length !== expected.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return send(response, 401, { error: 'Invalid Razorpay webhook signature.' });
      let event; try { event = JSON.parse(raw.toString('utf8')); } catch { return send(response, 400, { error: 'Invalid Razorpay webhook payload.' }); }
      if (event.event !== 'payment.captured') return send(response, 200, { ok: true, ignored: event.event || 'unknown' });
      const capture = event.payload?.payment?.entity || {}, resourceOrderId = String(capture.notes?.academyResourceOrderId || '');
      // Resource purchases share the signed Razorpay webhook with batch purchases.
      // The local resource order remains the source of truth for product, amount,
      // currency and owner; the Razorpay note is only an opaque correlation ID.
      if (resourceOrderId) {
        const captured = await updateState(data => captureResourceOrder(data, capture));
        return send(response, 200, { ok: true, resourceOrderId: captured.order.id, activated: !captured.duplicate });
      }
      const paymentId = String(capture.notes?.academyPaymentId || '');
      if (!paymentId) return send(response, 422, { error: 'The payment is missing its academy payment reference.' });
      const activated = await updateState(data => {
        const payment = data.payments.find(item => item.id === paymentId && item.provider === 'razorpay');
        if (!payment) throw Object.assign(new Error('Payment order not found.'), { status: 404 });
        if (!payment.providerOrderId || capture.order_id !== payment.providerOrderId) throw Object.assign(new Error('Payment order mismatch.'), { status: 409 });
        if (capture.status !== 'captured' || Number(capture.amount) !== Number(payment.amount) || String(capture.currency || '').toUpperCase() !== String(payment.currency || '').toUpperCase()) throw Object.assign(new Error('Captured payment amount or currency does not match this order.'), { status: 409 });
        if (!capture.id) throw Object.assign(new Error('The capture is missing its Razorpay payment reference.'), { status: 422 });
        if (payment.status === 'CAPTURED') {
          if (payment.providerReference && payment.providerReference !== capture.id) throw Object.assign(new Error('A different Razorpay payment was already recorded for this order.'), { status: 409 });
          return { payment, enrollment: paidEnrollment(data, payment.studentId), duplicate: true };
        }
        return { payment, enrollment: activateEnrollment(data, payment, capture.id), duplicate: false };
      });
      const state = await readState(), student = state.students.find(item => item.id === activated.payment.studentId);
      if (!activated.duplicate) { emit(activated.payment.studentId, 'payment.captured', { paymentId: activated.payment.id, enrollment: publicEnrollment(activated.enrollment, state) }); if (student) await sendNotification(student, `Payment received. Your ${activated.enrollment.stream} batch is active in the Student Desk.`); }
      return send(response, 200, { ok: true, activated: !activated.duplicate });
    }
    if (method === 'GET' && path === '/api/dashboard') {
      const state = await readState(), access = requirePaidEnrollment(request, state), student = state.students.find(item => item.id === access.session.studentId), hasContentAccess = access.enrollment.status === 'ACTIVE';
      const submissions = state.submissions.filter(item => item.studentId === student.id), homework = hasContentAccess ? state.homework.filter(item => forEnrollment(item, access.enrollment, state)).map(item => ({ ...item, submission: submissions.find(submission => submission.homeworkId === item.id) || null })) : [];
      student.subjects = studentSubjectsForEnrollment(student, access.enrollment, state);
      return send(response, 200, { syncMode: process.env.NIOS_SYNC_MODE || 'mock', profile: publicStudent(student, state), enrollment: publicEnrollment(access.enrollment, state), admission: { status: access.enrollment.status, documents: state.admissionDocuments.filter(item => item.enrollmentId === access.enrollment.id).map(({ storageKey, ...document }) => document), requiredDocuments: requiredAdmissionDocuments.map(item => item.label) }, materials: hasContentAccess ? state.materials.filter(item => forEnrollment(item, access.enrollment, state)).map(({ storageKey, ...item }) => ({ ...item, downloadable: Boolean(storageKey) })) : [], liveClasses: hasContentAccess ? state.liveClasses.filter(item => forEnrollment(item, access.enrollment, state)).map(classroomView) : [], homework });
    }
    if (method === 'POST' && path === '/api/admission/applications') {
      const session = readSession(request), input = await body(request); if (!session?.studentId) return send(response, 401, { error: 'Student sign-in is required.' });
      const state = await readState(), batch = state.batches.find(item => item.id === String(input.batchId || '') && item.published !== false); if (!batch) return send(response, 404, { error: 'The selected batch is not available.' }); const cycle = batch.board === 'NIOS' ? admissionCycle(batchAdmissionRoute(batch)) : { route: 'always', isOpen: true, target: 'Current admission', targetCode: 'CURRENT', lateFee: false }; if (!cycle.isOpen) return send(response, 409, { error: cycle.message || 'This batch is not accepting applications in the current admission window.' });
      const application = await updateState(data => { const existing = data.enrollments.find(item => item.studentId === session.studentId && item.batchId === batch.id && item.status !== 'ACTIVE'); if (existing) return existing; const created = { id: uid('enrol'), studentId: session.studentId, batchId: batch.id, assignedBatchCode: batch.board === 'NIOS' ? assignedBatchCode(batch, cycle) : `BATCH-${batch.id.toUpperCase()}`, streamId: batch.streamId, board: batch.board, classLevel: batch.class, stream: batch.stream, cycle, selectedSubjects: [], portalSyncConsent: false, status: 'APPLICATION_IN_PROGRESS', createdAt: now(), updatedAt: now() }; data.enrollments.push(created); data.audit.push({ id: uid('audit'), at: now(), action: 'admission.application-created', studentId: session.studentId, enrollmentId: created.id, batchId: batch.id }); return created; });
      return send(response, 201, publicEnrollment(application, await readState()));
    }
    if (method === 'GET' && path === '/api/admission/intake') {
      const state = await readState(), access = requireApplicationEnrollment(request, state, String(url.searchParams.get('batchId') || '')), student = state.students.find(item => item.id === access.session.studentId);
      const batch = state.batches.find(item => item.id === access.enrollment.batchId);
      const safeguards = admissionIntakeSafeguards(access.enrollment);
      return send(response, 200, { profile: publicStudent(student, state), enrollment: publicEnrollment(access.enrollment, state), safeguards, subjectOptions: admissionSubjectOptions(batch), requiredDocuments: requiredAdmissionDocuments, documents: state.admissionDocuments.filter(item => item.enrollmentId === access.enrollment.id).map(publicAdmissionDocument), syncMode: process.env.NIOS_SYNC_MODE || 'manual', canSubmit: safeguards.ready && (access.enrollment.selectedSubjects || []).length > 0 && requiredAdmissionDocuments.every(requirement => state.admissionDocuments.some(document => document.enrollmentId === access.enrollment.id && document.type === requirement.type)) });
    }
    if (method === 'PUT' && path === '/api/admission/intake') {
      const state = await readState(), access = requireApplicationEnrollment(request, state), input = await body(request), batch = state.batches.find(item => item.id === access.enrollment.batchId), selectedSubjects = admissionSubjects(input.subjects, admissionSubjectOptions(batch));
      const updated = await updateState(data => { const enrollment = data.enrollments.find(item => item.id === access.enrollment.id); if (!enrollment || ['DOCUMENTS_SUBMITTED_PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'VERIFICATION_IN_PROGRESS', 'ACTIVE'].includes(enrollment.status)) throw Object.assign(new Error('This admission application can no longer be changed.'), { status: 409 }); const safeguards = validateAdmissionIntakeSafeguards(input, enrollment); Object.assign(enrollment, { selectedSubjects, portalSyncConsent: Boolean(input.portalSyncConsent ?? enrollment.portalSyncConsent), ...safeguards, status: data.admissionDocuments.some(item => item.enrollmentId === enrollment.id) ? 'DOCUMENTS_IN_PROGRESS' : 'SUBJECTS_SELECTED', updatedAt: now() }); const student = data.students.find(item => item.id === access.session.studentId); if (student) student.subjects = selectedSubjects.map(item => ({ ...item, tmaStatus: 'Pending', practicalGuide: false, progress: 0 })); data.audit.push({ id: uid('audit'), at: now(), action: 'admission.subjects-selected', enrollmentId: enrollment.id, studentId: access.session.studentId, portalSyncConsent: enrollment.portalSyncConsent, applicantIsUnder18: Boolean(validDateOfBirth(enrollment.applicantDateOfBirth)?.age < 18) }); return enrollment; });
      emit(access.session.studentId, 'admission.subjects-selected', { enrollmentId: updated.id }); return send(response, 200, publicEnrollment(updated, await readState()));
    }
    if (method === 'POST' && path === '/api/admission/documents') {
      const state = await readState(), access = requireApplicationEnrollment(request, state), input = await body(request), type = String(input.type || '').trim(), requirement = requiredAdmissionDocuments.find(item => item.type === type); if (!requirement) return send(response, 422, { error: 'Choose a valid admission-document type.' });
      if (['DOCUMENTS_SUBMITTED_PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'VERIFICATION_IN_PROGRESS', 'ACTIVE'].includes(access.enrollment.status)) return send(response, 409, { error: 'Documents are locked while the application is under review.' });
      const file = filePayload(input, 6 * 1024 * 1024), storageKey = `admissions/${access.enrollment.id}/${type}/${Date.now()}-${file.fileName}`; await storage.put(storageKey, file.bytes, file.mimeType);
      const document = await updateState(data => { data.admissionDocuments = data.admissionDocuments.filter(item => !(item.enrollmentId === access.enrollment.id && item.type === type)); const created = { id: uid('admission-doc'), enrollmentId: access.enrollment.id, studentId: access.session.studentId, type, label: requirement.label, fileName: file.fileName, mimeType: file.mimeType, storageKey, status: 'RECEIVED', uploadedAt: now() }; data.admissionDocuments.push(created); const enrollment = data.enrollments.find(item => item.id === access.enrollment.id); if (enrollment && enrollment.status === 'PAYMENT_CONFIRMED') enrollment.status = 'DOCUMENTS_IN_PROGRESS'; if (enrollment) enrollment.updatedAt = now(); data.audit.push({ id: uid('audit'), at: now(), action: 'admission.document-uploaded', enrollmentId: access.enrollment.id, studentId: access.session.studentId, documentType: type }); return created; });
      emit(access.session.studentId, 'admission.document-uploaded', publicAdmissionDocument(document)); return send(response, 201, publicAdmissionDocument(document));
    }
    if (method === 'POST' && path === '/api/admission/submit') {
      const state = await readState(), access = requireApplicationEnrollment(request, state), missing = requiredAdmissionDocuments.filter(requirement => !state.admissionDocuments.some(document => document.enrollmentId === access.enrollment.id && document.type === requirement.type));
      if (!(access.enrollment.selectedSubjects || []).length || missing.length) return send(response, 422, { error: `Choose subjects and upload: ${missing.map(item => item.label).join(', ') || 'at least one subject'}.` });
      if (!admissionIntakeSafeguards(access.enrollment).ready) return send(response, 422, { error: 'Confirm the document-processing acknowledgement, enter the applicant date of birth, and complete guardian confirmation when required before submitting.' });
      const submitted = await updateState(data => { const enrollment = data.enrollments.find(item => item.id === access.enrollment.id); if (!enrollment || !['SUBJECTS_SELECTED', 'DOCUMENTS_IN_PROGRESS'].includes(enrollment.status)) throw Object.assign(new Error('This application cannot be submitted in its current state.'), { status: 409 }); Object.assign(enrollment, { status: 'DOCUMENTS_SUBMITTED_PENDING_PAYMENT', documentsSubmittedAt: now(), updatedAt: now() }); data.audit.push({ id: uid('audit'), at: now(), action: 'admission.documents-submitted', enrollmentId: enrollment.id, studentId: access.session.studentId }); return enrollment; });
      const current = await readState(), delivery = await sendAdmissionIntakeNotice(current, submitted), finalized = await updateState(data => { const enrollment = data.enrollments.find(item => item.id === submitted.id); if (!enrollment) throw Object.assign(new Error('Admission application not found.'), { status: 404 }); enrollment.intakeNotice = delivery; enrollment.updatedAt = now(); data.audit.push({ id: uid('audit'), at: now(), action: `admission.intake-notice-${delivery.status}`, enrollmentId: enrollment.id, studentId: access.session.studentId, provider: delivery.provider, error: delivery.error || null }); return enrollment; });
      const finalState = await readState(); emit(access.session.studentId, 'admission.submitted', { enrollmentId: submitted.id, status: submitted.status }); return send(response, 200, publicEnrollment(finalized, finalState));
    }
    const admissionDocumentMatch = path.match(/^\/api\/admission\/documents\/([^/]+)\/download$/);
    if (method === 'GET' && admissionDocumentMatch) { const state = await readState(), access = requireApplicationEnrollment(request, state), document = state.admissionDocuments.find(item => item.id === admissionDocumentMatch[1] && item.enrollmentId === access.enrollment.id); if (!document) return send(response, 404, { error: 'Admission document not found.' }); const stored = await storage.get(document.storageKey); response.writeHead(200, { 'content-type': document.mimeType, 'content-disposition': `attachment; filename="${document.fileName}"` }); return response.end(stored.bytes); }
    if (method === 'POST' && path === '/api/payments/orders') {
      const input = await body(request), session = readSession(request); if (!session?.studentId) return send(response, 401, { error: 'Student sign-in is required.' });
      const state = await readState(), batch = state.batches.find(item => item.id === input.batchId && item.published !== false); if (!batch) return send(response, 404, { error: 'Batch not found.' });
      const route = batch.board === 'NIOS' ? batchAdmissionRoute(batch) : 'always', cycle = batch.board === 'NIOS' ? admissionCycle(route) : { route: 'always', isOpen: true, target: 'Current admission', targetCode: 'CURRENT', lateFee: false };
      if (!cycle.isOpen) return send(response, 409, { error: cycle.message || 'This batch is not accepting admissions in the current NIOS window.' });
      const application = applicationEnrollment(state, session.studentId, batch.id); if (!application || application.status !== 'DOCUMENTS_SUBMITTED_PENDING_PAYMENT') return send(response, 409, { error: 'Complete your subject selection and document submission before opening payment.' });
      const amount = Number(String(batch.price).replace(/[^0-9]/g, '')) * 100, provider = String(process.env.PAYMENT_PROVIDER || 'mock').trim().toLowerCase();
      if (!Number.isSafeInteger(amount) || amount < 100 || !['mock', 'razorpay'].includes(provider) || (isProduction && provider !== 'razorpay')) return send(response, 503, { error: 'Live Razorpay payments are not configured for this batch yet.' });
      const paymentResult = await updateState(data => {
        const existing = data.payments.find(item => item.studentId === session.studentId && item.batchId === batch.id && item.provider === provider && item.amount === amount && item.currency === 'INR' && item.status === 'CREATED' && (provider !== 'razorpay' || item.providerOrderId));
        if (existing) return { payment: existing, reused: true };
        const created = { id: uid('payment'), studentId: session.studentId, batchId: batch.id, assignedBatchCode: batch.board === 'NIOS' ? assignedBatchCode(batch, cycle) : `BATCH-${batch.id.toUpperCase()}`, cycle, provider, amount, currency: 'INR', status: 'CREATED', createdAt: now() }; data.payments.push(created); data.audit.push({ id: uid('audit'), at: now(), action: 'payment.order-created', studentId: session.studentId, paymentId: created.id, batchId: batch.id, assignedBatchCode: created.assignedBatchCode }); return { payment: created, reused: false };
      });
      const payment = paymentResult.payment;
      if (paymentResult.reused) {
        if (provider === 'razorpay') {
          const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET; if (!keyId || !keySecret) return send(response, 503, { error: 'Razorpay is not configured.' });
          return send(response, 200, { payment, checkout: { provider: 'razorpay', keyId, orderId: payment.providerOrderId, amount: payment.amount, currency: payment.currency }, reused: true });
        }
        return send(response, 200, { payment, checkout: { provider: 'mock', amount: payment.amount, currency: payment.currency }, reused: true });
      }
      if (provider === 'razorpay') {
        const keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET; if (!keyId || !keySecret) return send(response, 503, { error: 'Razorpay is not configured.' });
        let upstream;
        try { upstream = await fetch('https://api.razorpay.com/v1/orders', { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount, currency: 'INR', receipt: payment.id, notes: { academyPaymentId: payment.id, studentId: session.studentId, batchId: batch.id } }), signal: AbortSignal.timeout(15_000) }); } catch { upstream = null; }
        if (!upstream?.ok) { await updateState(data => { const current = data.payments.find(item => item.id === payment.id); if (current) { current.status = 'FAILED'; current.failureReason = 'provider-order-creation-failed'; current.updatedAt = now(); } }); return send(response, 502, { error: 'Razorpay order creation failed. No payment was captured.' }); }
        const order = await upstream.json().catch(() => ({}));
        if (!order.id) { await updateState(data => { const current = data.payments.find(item => item.id === payment.id); if (current) { current.status = 'FAILED'; current.failureReason = 'provider-order-id-missing'; current.updatedAt = now(); } }); return send(response, 502, { error: 'Razorpay did not return a payment order. No payment was captured.' }); }
        await updateState(data => { const current = data.payments.find(item => item.id === payment.id); if (current) { current.providerOrderId = order.id; current.updatedAt = now(); } }); return send(response, 201, { payment: { ...payment, providerOrderId: order.id }, checkout: { provider: 'razorpay', keyId, orderId: order.id, amount, currency: 'INR' } });
      }
      return send(response, 201, { payment, checkout: { provider: 'mock', amount, currency: 'INR' } });
    }
    const completePaymentMatch = path.match(/^\/api\/payments\/([^/]+)\/complete$/);
    if (method === 'POST' && completePaymentMatch) {
      const session = readSession(request); if (!session?.studentId) return send(response, 401, { error: 'Student sign-in is required.' });
      if (isProduction || (process.env.PAYMENT_PROVIDER || 'mock') !== 'mock') return send(response, 403, { error: 'Only verified payment-provider webhooks can activate production enrollments.' });
      const activated = await updateState(data => { const payment = data.payments.find(item => item.id === completePaymentMatch[1] && item.studentId === session.studentId); if (!payment) throw Object.assign(new Error('Payment order not found.'), { status: 404 }); if (payment.status === 'CAPTURED') return { payment, enrollment: paidEnrollment(data, session.studentId) }; return { payment, enrollment: activateEnrollment(data, payment, `mock_${uid('capture')}`) }; });
      const state = await readState(), student = state.students.find(item => item.id === session.studentId); emit(session.studentId, 'payment.captured', { paymentId: activated.payment.id, enrollment: publicEnrollment(activated.enrollment, state) }); await sendNotification(student, `Payment received. Your ${activated.enrollment.stream} batch is active in the Student Desk.`); return send(response, 200, { payment: activated.payment, enrollment: publicEnrollment(activated.enrollment, state), redirect: '/dashboard' });
    }
    const verifyPaymentMatch = path.match(/^\/api\/payments\/([^/]+)\/razorpay-verify$/);
    if (method === 'POST' && verifyPaymentMatch) {
      const session = readSession(request); if (!session?.studentId) return send(response, 401, { error: 'Student sign-in is required.' });
      const input = await body(request), paymentId = String(input.razorpay_payment_id || ''), orderId = String(input.razorpay_order_id || ''), signature = String(input.razorpay_signature || ''), keyId = process.env.RAZORPAY_KEY_ID, keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keyId || !keySecret || !paymentId || !orderId || !signature) return send(response, 422, { error: 'A complete signed Razorpay payment response is required.' });
      const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return send(response, 401, { error: 'Razorpay payment signature verification failed.' });
      const stateBeforeVerification = await readState(), pendingPayment = stateBeforeVerification.payments.find(item => item.id === verifyPaymentMatch[1] && item.studentId === session.studentId && item.provider === 'razorpay');
      if (!pendingPayment) return send(response, 404, { error: 'Payment order not found.' });
      if (!pendingPayment.providerOrderId || pendingPayment.providerOrderId !== orderId) return send(response, 409, { error: 'Payment order mismatch.' });
      if (pendingPayment.status !== 'CAPTURED') {
        const upstream = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers: { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` }, signal: AbortSignal.timeout(15_000) });
        if (!upstream.ok) return send(response, 502, { error: 'Razorpay payment verification could not be completed.' });
        const captured = await upstream.json();
        if (captured.status !== 'captured' || captured.order_id !== pendingPayment.providerOrderId || Number(captured.amount) !== Number(pendingPayment.amount) || String(captured.currency || '').toUpperCase() !== String(pendingPayment.currency || '').toUpperCase()) return send(response, 409, { error: 'Payment is not captured for the correct order, amount, and currency yet. Please retry shortly.' });
      }
      const activated = await updateState(data => {
        const payment = data.payments.find(item => item.id === verifyPaymentMatch[1] && item.studentId === session.studentId && item.provider === 'razorpay');
        if (!payment) throw Object.assign(new Error('Payment order not found.'), { status: 404 });
        if (!payment.providerOrderId || payment.providerOrderId !== orderId) throw Object.assign(new Error('Payment order mismatch.'), { status: 409 });
        if (payment.status === 'CAPTURED') return { payment, enrollment: paidEnrollment(data, session.studentId), duplicate: true };
        return { payment, enrollment: activateEnrollment(data, payment, paymentId), duplicate: false };
      });
      const state = await readState(), student = state.students.find(item => item.id === session.studentId);
      if (!activated.duplicate) { emit(session.studentId, 'payment.captured', { paymentId: activated.payment.id, enrollment: publicEnrollment(activated.enrollment, state) }); if (student) await sendNotification(student, `Payment received. Your ${activated.enrollment.stream} batch is active in the Student Desk.`); }
      return send(response, 200, { payment: activated.payment, enrollment: publicEnrollment(activated.enrollment, state), redirect: '/dashboard' });
    }
    if (method === 'GET' && path === '/api/live-classes') { const state = await readState(), access = requireActiveEnrollment(request, state); return send(response, 200, state.liveClasses.filter(item => forEnrollment(item, access.enrollment, state)).map(classroomView)); }
    if (method === 'GET' && path === '/api/homework') { const state = await readState(), access = requireActiveEnrollment(request, state); return send(response, 200, state.homework.filter(item => forEnrollment(item, access.enrollment, state)).map(item => ({ ...item, submission: state.submissions.find(submission => submission.homeworkId === item.id && submission.studentId === access.session.studentId) || null }))); }
    const homeworkSubmissionMatch = path.match(/^\/api\/homework\/([^/]+)\/submissions$/);
    if (method === 'POST' && homeworkSubmissionMatch) {
      const state = await readState(), access = requireActiveEnrollment(request, state), task = state.homework.find(item => item.id === homeworkSubmissionMatch[1] && forEnrollment(item, access.enrollment, state)); if (!task) return send(response, 404, { error: 'Homework task not found for this batch.' });
      const input = await body(request), file = filePayload(input, 5 * 1024 * 1024), storageKey = `homework/${access.session.studentId}/${task.id}/${Date.now()}-${file.fileName}`; await storage.put(storageKey, file.bytes, file.mimeType);
      const submission = await updateState(data => { let saved = data.submissions.find(item => item.homeworkId === task.id && item.studentId === access.session.studentId); if (!saved) { saved = { id: uid('submission'), homeworkId: task.id, studentId: access.session.studentId }; data.submissions.push(saved); } Object.assign(saved, { status: 'Submitted', fileName: file.fileName, mimeType: file.mimeType, storageKey, submittedAt: now(), grade: null, feedback: null, audioFeedbackUrl: null }); data.audit.push({ id: uid('audit'), at: now(), action: 'homework.submitted', studentId: access.session.studentId, homeworkId: task.id, submissionId: saved.id }); return saved; }); emit(access.session.studentId, 'homework.submitted', { homeworkId: task.id, submissionId: submission.id }); return send(response, 201, submission);
    }
    if (method === 'GET' && path === '/api/materials') { const state = await readState(), access = requireActiveEnrollment(request, state); return send(response, 200, state.materials.filter(item => forEnrollment(item, access.enrollment, state)).map(({ storageKey, ...item }) => ({ ...item, downloadable: Boolean(storageKey) }))); }
    const materialDownloadMatch = path.match(/^\/api\/materials\/([^/]+)\/download$/);
    if (method === 'GET' && materialDownloadMatch) { const state = await readState(), access = requireActiveEnrollment(request, state), material = state.materials.find(item => item.id === materialDownloadMatch[1] && forEnrollment(item, access.enrollment, state)); if (!material?.storageKey) return send(response, 404, { error: 'Material file not found.' }); const stored = await storage.get(material.storageKey); response.writeHead(200, { 'content-type': material.mimeType || 'application/octet-stream', 'content-disposition': `attachment; filename="${material.fileName || 'material'}"` }); return response.end(stored.bytes); }
    if (method === 'GET' && path === '/api/events') {
      const studentId = url.searchParams.get('studentId'); if (!studentId) return send(response, 400, { error: 'studentId is required.' }); requireStudent(request, studentId);
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' }); response.write('retry: 5000\n\n');
      const clients = sseClients.get(studentId) || new Set(); clients.add(response); sseClients.set(studentId, clients);
      const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 25_000); request.on('close', () => { clearInterval(heartbeat); clients.delete(response); }); return;
    }
    const profileMatch = path.match(/^\/api\/students\/([^/]+)\/profile$/);
    if (method === 'GET' && profileMatch) { requireStudent(request, profileMatch[1]); const state = await readState(), student = state.students.find(item => item.id === profileMatch[1]); return student ? send(response, 200, publicStudent(student, state)) : send(response, 404, { error: 'Student not found.' }); }
    if (method === 'PUT' && profileMatch) {
      requireStudent(request, profileMatch[1]); const input = await body(request); const updated = await updateState(state => {
        const student = state.students.find(item => item.id === profileMatch[1]); if (!student) throw Object.assign(new Error('Student not found.'), { status: 404 });
        const board = String(input.board ?? student.board).trim(), boardCode = String(input.boardCode ?? student.boardCode ?? student.board).trim(), classLevel = String(input.classLevel ?? student.classLevel).trim();
        if (!['NIOS', 'IGNOU', 'CBSE Private', 'DU SOL'].includes(board) || !isSafeString(boardCode, 40) || !['10', '12', 'UG', 'PG', 'Unselected'].includes(classLevel)) throw Object.assign(new Error('Use a supported board, board code, and class level.'), { status: 422 });
        student.board = board; student.boardCode = boardCode; student.classLevel = classLevel; if (input.subjects !== undefined) student.subjects = subjectMappings(input.subjects); student.updatedAt = now(); state.audit.push({ id: uid('audit'), at: now(), action: 'student.profile-updated', studentId: student.id }); return publicStudent(student, state);
      });
      return send(response, 200, updated);
    }
    const syncLogMatch = path.match(/^\/api\/students\/([^/]+)\/sync-logs$/);
    if (method === 'GET' && syncLogMatch) { requireStudent(request, syncLogMatch[1]); const state = await readState(); return send(response, 200, (state.syncLogs || []).filter(item => item.studentId === syncLogMatch[1]).slice(-50).reverse()); }
    const statusMatch = path.match(/^\/api\/students\/([^/]+)\/status$/);
    if (method === 'GET' && statusMatch) { requireStudent(request, statusMatch[1]); const state = await readState(), student = state.students.find(item => item.id === statusMatch[1]); return student ? send(response, 200, publicStudent(student, state)) : send(response, 404, { error: 'Student not found.' }); }
    const vaultMatch = path.match(/^\/api\/students\/([^/]+)\/vault$/);
    if (method === 'PUT' && vaultMatch) {
      requireStudent(request, vaultMatch[1]);
      const input = await body(request); if (!input.consent || !isSafeString(input.enrollmentNumber) || !isSafeString(input.referenceNumber) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dateOfBirth || '')) return send(response, 422, { error: 'Enrollment number, reference number, ISO date of birth, and consent are required.' });
      await updateState(state => { const student = state.students.find(item => item.id === vaultMatch[1]); if (!student) throw Object.assign(new Error('Student not found.'), { status: 404 }); const boardCode = String(input.boardCode || student.boardCode || student.board).trim(); if (!isSafeString(boardCode, 40)) throw Object.assign(new Error('A valid board code is required.'), { status: 422 }); student.boardCode = boardCode; state.vault[vaultMatch[1]] = encrypt({ enrollmentNumber: input.enrollmentNumber.trim(), referenceNumber: input.referenceNumber.trim(), dateOfBirth: input.dateOfBirth, boardCode, consent: true, consentedAt: now() }); state.audit.push({ id: uid('audit'), at: now(), action: 'vault.updated', studentId: vaultMatch[1] }); });
      return send(response, 200, { configured: true, consented: true });
    }
    const syncMatch = path.match(/^\/api\/students\/([^/]+)\/sync$/);
    if (method === 'POST' && syncMatch) { requireStudent(request, syncMatch[1]); const state = await readState(); if (!state.students.some(item => item.id === syncMatch[1])) return send(response, 404, { error: 'Student not found.' }); if (!state.vault[syncMatch[1]]) return send(response, 409, { error: 'A consented vault record is required before sync.' }); if (process.env.NIOS_SYNC_MODE === 'manual') return send(response, 202, { manual: true, message: 'Official status is updated by your academy after manual NIOS verification.' }); return send(response, 202, { job: await queueSync(syncMatch[1], 'manual') }); }
    const downloadMatch = path.match(/^\/api\/documents\/([^/]+)\/download$/);
    if (method === 'GET' && downloadMatch) { const state = await readState(), document = state.documents.find(item => item.id === downloadMatch[1]); if (!document?.storageKey) return send(response, 404, { error: 'No stored document is available.' }); requireStudent(request, document.studentId); const stored = await storage.get(document.storageKey); response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${document.fileName || 'document'}"` }); return response.end(stored.bytes); }
    if (method === 'GET' && path === '/api/teacher/batches') { const session = requireTeacher(request), state = await readState(), allowed = teacherAllowedBatchIds(session, state); return send(response, 200, state.batches.filter(batch => session.role === 'admin' || allowed.includes(batch.id)).map(({ id, name, board, class: classLevel, stream, streamId }) => ({ id, name, board, classLevel, stream, streamId }))); }
    if (method === 'GET' && path === '/api/teacher/live-classes') { const session = requireTeacher(request), state = await readState(), allowed = teacherAllowedBatchIds(session, state); return send(response, 200, state.liveClasses.filter(item => session.role === 'admin' || allowed.includes(item.batchId)).map(teacherClassroomView)); }
    const attendanceRosterMatch = path.match(/^\/api\/teacher\/live-classes\/([^/]+)\/attendance$/);
    if (method === 'GET' && attendanceRosterMatch) {
      const state = await readState(), { liveClass } = attendanceClassAccess(request, state, attendanceRosterMatch[1]);
      return send(response, 200, attendanceRoster(state, liveClass));
    }
    const attendanceStudentMatch = path.match(/^\/api\/teacher\/live-classes\/([^/]+)\/attendance\/([^/]+)$/);
    if (method === 'PUT' && attendanceStudentMatch) {
      const input = await body(request), state = await readState(), { liveClass, staff } = attendanceClassAccess(request, state, attendanceStudentMatch[1]);
      const status = String(input.status || '').trim(), note = String(input.note || '').trim();
      const rawMinutes = input.minutesAttended, hasMinutes = rawMinutes !== undefined && rawMinutes !== null && rawMinutes !== '';
      const minutesAttended = hasMinutes ? Number(rawMinutes) : null, maxMinutes = Number(liveClass.durationMinutes || 60);
      if (!attendanceStatuses.has(status) || note.length > 500 || (hasMinutes && (!Number.isFinite(minutesAttended) || minutesAttended < 0 || minutesAttended > maxMinutes))) return send(response, 422, { error: 'Choose a valid attendance state, up to 500 characters of notes, and a valid number of minutes.' });
      if (!attendanceEligibleStudents(state, liveClass).some(item => item.student.id === attendanceStudentMatch[2])) return send(response, 404, { error: 'This student is not enrolled in the target class.' });
      const updated = await updateState(data => {
        const currentClass = data.liveClasses.find(item => item.id === attendanceStudentMatch[1]);
        if (!currentClass) throw Object.assign(new Error('Live class not found.'), { status: 404 });
        if (!attendanceEligibleStudents(data, currentClass).some(item => item.student.id === attendanceStudentMatch[2])) throw Object.assign(new Error('This student is not enrolled in the target class.'), { status: 404 });
        let record = data.attendance.find(item => item.liveClassId === currentClass.id && item.studentId === attendanceStudentMatch[2]);
        if (!record) { record = { id: uid('attendance'), liveClassId: currentClass.id, studentId: attendanceStudentMatch[2], absenceNotifiedAt: null }; data.attendance.push(record); }
        Object.assign(record, { status, minutesAttended, note: note || null, markedAt: now(), markedBy: staff.sub, updatedAt: now() });
        data.audit.push({ id: uid('audit'), at: now(), action: 'attendance.marked', classId: currentClass.id, studentId: record.studentId, status, staffId: staff.sub });
        return { record, liveClass: currentClass };
      });
      emit(updated.record.studentId, 'attendance.updated', { classId: updated.liveClass.id, status: updated.record.status, minutesAttended: updated.record.minutesAttended });
      const current = await readState(), currentClass = current.liveClasses.find(item => item.id === updated.liveClass.id);
      return send(response, 200, { record: { id: updated.record.id, studentId: updated.record.studentId, status: updated.record.status, minutesAttended: updated.record.minutesAttended, note: updated.record.note || '', markedAt: updated.record.markedAt, absenceNotifiedAt: updated.record.absenceNotifiedAt || null }, ...attendanceRoster(current, currentClass) });
    }
    const attendanceFinalizeMatch = path.match(/^\/api\/teacher\/live-classes\/([^/]+)\/attendance\/finalize$/);
    if (method === 'POST' && attendanceFinalizeMatch) {
      const state = await readState(), { liveClass, staff } = attendanceClassAccess(request, state, attendanceFinalizeMatch[1]);
      if (!liveClassHasEnded(liveClass)) return send(response, 409, { error: 'Attendance can be finalised only after the scheduled class has ended.' });
      const finalized = await updateState(data => {
        const currentClass = data.liveClasses.find(item => item.id === attendanceFinalizeMatch[1]);
        if (!currentClass) throw Object.assign(new Error('Live class not found.'), { status: 404 });
        const eligible = attendanceEligibleStudents(data, currentClass);
        for (const { student } of eligible) {
          if (!data.attendance.some(item => item.liveClassId === currentClass.id && item.studentId === student.id)) data.attendance.push({ id: uid('attendance'), liveClassId: currentClass.id, studentId: student.id, status: 'Absent', minutesAttended: null, note: null, markedAt: now(), markedBy: staff.sub, updatedAt: now(), absenceNotifiedAt: null });
        }
        currentClass.attendanceFinalizedAt = now(); currentClass.attendanceFinalizedBy = staff.sub;
        const candidates = data.attendance.filter(item => item.liveClassId === currentClass.id && item.status === 'Absent' && !item.absenceNotifiedAt).map(record => ({ recordId: record.id, student: data.students.find(item => item.id === record.studentId) })).filter(item => item.student);
        data.audit.push({ id: uid('audit'), at: now(), action: 'attendance.finalized', classId: currentClass.id, staffId: staff.sub, absentCount: candidates.length });
        return { liveClass: currentClass, candidates };
      });
      let delivered = 0, failed = 0;
      for (const { recordId, student } of finalized.candidates) {
        try {
          const classTime = new Date(finalized.liveClass.startsAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
          await sendNotification(student, `You were recorded absent for ${finalized.liveClass.subject} — ${finalized.liveClass.title} on ${classTime}. If this is incorrect, please contact the academy.`, { subject: `Attendance notice — ${finalized.liveClass.subject || 'Live class'}`, kind: 'attendance-absence' });
          await updateState(data => { const record = data.attendance.find(item => item.id === recordId); if (record) { record.absenceNotifiedAt = now(); record.absenceNotificationError = null; record.updatedAt = now(); } });
          delivered += 1;
        } catch (error) {
          await updateState(data => { const record = data.attendance.find(item => item.id === recordId); if (record) { record.absenceNotificationError = String(error.message || 'Notification delivery failed.').slice(0, 300); record.absenceNotificationAttemptedAt = now(); record.updatedAt = now(); } });
          failed += 1;
        }
      }
      const current = await readState(), currentClass = current.liveClasses.find(item => item.id === finalized.liveClass.id), roster = attendanceRoster(current, currentClass);
      for (const item of roster.students) emit(item.id, 'attendance.finalized', { classId: currentClass.id, status: item.status, finalizedAt: currentClass.attendanceFinalizedAt });
      return send(response, 200, { ...roster, notification: { delivered, failed, provider: process.env.NOTIFICATION_PROVIDER || 'mock' } });
    }
    if (method === 'POST' && path === '/api/teacher/live-classes') {
      const input = await body(request), state = await readState(), target = targetForBatch(input, state), staff = requireTeacherPermission(request, state, 'manageLiveClasses', target.batchId), title = String(input.title || '').trim(), startMs = Date.parse(String(input.startsAt || '')), durationMinutes = Number(input.durationMinutes || 60), suppliedLiveUrl = String(input.liveUrl || '').trim();
      if (!isSafeString(title, 140) || Number.isNaN(startMs) || startMs <= Date.now() || !Number.isFinite(durationMinutes) || durationMinutes < 15 || durationMinutes > 240 || (suppliedLiveUrl && !/^https:\/\//.test(suppliedLiveUrl))) return send(response, 422, { error: 'Use a title, future schedule, 15–240 minute duration, and an HTTPS meeting link when one is supplied.' });
      const startsAt = new Date(startMs).toISOString();
      const meeting = suppliedLiveUrl ? { liveUrl: suppliedLiveUrl, hostUrl: null, meetingProvider: 'external' } : await createZoomMeeting({ title, startsAt, durationMinutes });
      const created = await updateState(data => { const item = { id: uid('class'), ...target, title, startsAt, durationMinutes, ...meeting, recordingUrl: null, createdBy: staff.sub, createdAt: now() }; data.liveClasses.push(item); data.audit.push({ id: uid('audit'), at: now(), action: 'live-class.scheduled', batchId: item.batchId, classId: item.id, staffId: staff.sub, meetingProvider: item.meetingProvider }); return item; });
      const current = await readState(), notification = { attempted: 0, delivered: 0, failed: 0 };
      for (const enrollment of current.enrollments.filter(item => item.batchId === created.batchId && item.status === 'ACTIVE')) {
        const student = current.students.find(item => item.id === enrollment.studentId);
        if (!student) continue;
        notification.attempted += 1;
        try {
          await sendNotification(student, `${created.subject} live class scheduled: ${created.title}.`);
          notification.delivered += 1;
        } catch (error) {
          // The class is already scheduled. A notification failure must not turn
          // that successful action into a misleading error or invite duplicates.
          notification.failed += 1;
          console.warn('Live-class notification failed:', error.message);
          await updateState(data => {
            data.audit.push({ id: uid('audit'), at: now(), action: 'live-class.notification-failed', classId: created.id, studentId: student.id, reason: String(error.message || 'Notification delivery failed.').slice(0, 300) });
          });
        }
        emit(enrollment.studentId, 'live-class.scheduled', classroomView(created));
      }
      return send(response, 201, { ...teacherClassroomView(created), notification });
    }
    if (method === 'POST' && path === '/api/teacher/homework') {
      const input = await body(request), state = await readState(), target = targetForBatch(input, state), staff = requireTeacherPermission(request, state, 'manageHomework', target.batchId), title = String(input.title || '').trim(), instructions = String(input.instructions || '').trim(), dueMs = Date.parse(String(input.dueAt || ''));
      if (!isSafeString(title, 140) || !isSafeString(instructions, 1200) || Number.isNaN(dueMs) || dueMs <= Date.now()) return send(response, 422, { error: 'Homework title, instructions, and a valid future due date are required.' });
      const dueAt = new Date(dueMs).toISOString();
      const created = await updateState(data => { const item = { id: uid('homework'), ...target, title, instructions, dueAt, createdBy: staff.sub, createdAt: now() }; data.homework.push(item); data.audit.push({ id: uid('audit'), at: now(), action: 'homework.created', batchId: item.batchId, homeworkId: item.id, staffId: staff.sub }); return item; }); return send(response, 201, created);
    }
    if (method === 'POST' && path === '/api/teacher/materials') {
      const input = await body(request), state = await readState(), target = targetForBatch(input, state), staff = requireTeacherPermission(request, state, 'manageMaterials', target.batchId), title = String(input.title || '').trim(), materialType = String(input.materialType || 'Class note').trim(), file = filePayload(input, 8 * 1024 * 1024);
      if (!isSafeString(title, 140) || !['Class note', 'TMA solution', 'Practical guide', 'Recorded session'].includes(materialType)) return send(response, 422, { error: 'Use a title and valid material type.' });
      const storageKey = `materials/${target.batchId}/${target.subjectCode}/${Date.now()}-${file.fileName}`; await storage.put(storageKey, file.bytes, file.mimeType);
      const created = await updateState(data => { const item = { id: uid('material'), ...target, title, materialType, fileName: file.fileName, mimeType: file.mimeType, storageKey, createdBy: staff.sub, createdAt: now() }; data.materials.push(item); data.audit.push({ id: uid('audit'), at: now(), action: 'material.uploaded', batchId: item.batchId, materialId: item.id, staffId: staff.sub }); return item; }); return send(response, 201, { ...created, downloadable: true });
    }
    if (method === 'GET' && path === '/api/teacher/submissions') { const state = await readState(), batchId = url.searchParams.get('batchId'), session = requireTeacherPermission(request, state, 'gradeSubmissions', batchId || ''), allowed = teacherAllowedBatchIds(session, state); const records = state.submissions.filter(item => { const task = state.homework.find(record => record.id === item.homeworkId); return Boolean(task) && (!batchId || task.batchId === batchId) && (session.role === 'admin' || allowed.includes(task.batchId)); }).map(item => ({ ...item, student: state.students.find(student => student.id === item.studentId)?.name || 'Student', homework: state.homework.find(task => task.id === item.homeworkId) || null })); return send(response, 200, records); }
    const evaluateMatch = path.match(/^\/api\/teacher\/submissions\/([^/]+)$/);
    if (method === 'PUT' && evaluateMatch) { const input = await body(request), permissionState = await readState(), permissionSubmission = permissionState.submissions.find(item => item.id === evaluateMatch[1]), permissionHomework = permissionSubmission && permissionState.homework.find(item => item.id === permissionSubmission.homeworkId), staff = requireTeacherPermission(request, permissionState, 'gradeSubmissions', permissionHomework?.batchId || ''), grade = String(input.grade || '').trim(), feedback = String(input.feedback || '').trim(), audioFeedbackUrl = String(input.audioFeedbackUrl || '').trim(); if (!isSafeString(grade, 30) || !isSafeString(feedback, 1200) || (audioFeedbackUrl && !/^https:\/\//.test(audioFeedbackUrl))) return send(response, 422, { error: 'Grade, text feedback, and an optional HTTPS audio-feedback URL are required.' }); const updated = await updateState(data => { const submission = data.submissions.find(item => item.id === evaluateMatch[1]); if (!submission) throw Object.assign(new Error('Submission not found.'), { status: 404 }); Object.assign(submission, { status: 'Graded', grade, feedback, audioFeedbackUrl: audioFeedbackUrl || null, gradedAt: now(), gradedBy: staff.sub }); data.audit.push({ id: uid('audit'), at: now(), action: 'homework.graded', submissionId: submission.id, staffId: staff.sub }); return submission; }); emit(updated.studentId, 'homework.graded', { submissionId: updated.id, grade: updated.grade }); return send(response, 200, updated); }
    if (method === 'GET' && path === '/api/admin/staff') { const state = await readState(); requireSuperAdmin(request, state); return send(response, 200, { staff: state.users.filter(user => ['admin', 'teacher'].includes(user.role)).map(user => ({ ...publicUser(user), protectedAccount: Boolean(user.protectedAccount), suspended: Boolean(user.suspended), requiresPasswordSetup: Boolean(user.requiresPasswordSetup) })), batches: state.batches.map(({ id, name }) => ({ id, name })) }); }
    if (method === 'POST' && path === '/api/admin/staff/invite') { const state = await readState(); const owner = requireSuperAdmin(request, state), input = await body(request), email = String(input.email || '').trim().toLowerCase(), name = String(input.name || '').trim(); if (!/^\S+@\S+\.\S+$/.test(email) || !isSafeString(name, 80)) return send(response, 422, { error: 'A teacher name and valid email address are required.' }); const existing = state.users.find(user => String(user.email || '').toLowerCase() === email); if (existing && !existing.requiresPasswordSetup) return send(response, 409, { error: 'That email already has an active account.' }); const token = randomBytes(32).toString('base64url'), tokenHash = createHash('sha256').update(token).digest('hex'), expires = new Date(Date.now() + 86400_000).toISOString(); const staff = await updateState(data => { let user = data.users.find(item => String(item.email || '').toLowerCase() === email); if (!user) { user = { id: uid('user'), name, email, role: permanentSuperAdminEmails.has(email) ? 'admin' : 'teacher', passwordHash: hashPassword(randomBytes(32).toString('hex')), createdAt: now() }; data.users.push(user); } if (!user.protectedAccount) { user.role = 'teacher'; user.permissions = defaultTeacherPermissions(); } user.name = name; user.inviteTokenHash = tokenHash; user.inviteExpiresAt = expires; user.requiresPasswordSetup = true; data.audit.push({ id: uid('audit'), at: now(), action: 'staff.invited', staffId: user.id, invitedBy: owner.user.id }); return user; }); const delivery = await sendStaffInvite(email, token, staff.role); return send(response, 201, { staff: publicUser(staff), delivered: delivery.delivered, setupUrl: delivery.setupUrl }); }
    const staffPermissionMatch = path.match(/^\/api\/admin\/staff\/([^/]+)\/permissions$/);
    if (method === 'PUT' && staffPermissionMatch) { const current = await readState(); const owner = requireSuperAdmin(request, current), input = await body(request); const updated = await updateState(state => { const user = state.users.find(item => item.id === staffPermissionMatch[1]); if (!user || user.role !== 'teacher') throw Object.assign(new Error('Teacher account not found.'), { status: 404 }); const allowedBatchIds = Array.isArray(input.allowedBatchIds) ? [...new Set(input.allowedBatchIds.map(String))] : []; if (allowedBatchIds.some(id => !state.batches.some(batch => batch.id === id))) throw Object.assign(new Error('One or more assigned batches are invalid.'), { status: 422 }); user.permissions = { manageLiveClasses: Boolean(input.manageLiveClasses), manageHomework: Boolean(input.manageHomework), manageMaterials: Boolean(input.manageMaterials), gradeSubmissions: Boolean(input.gradeSubmissions), allowedBatchIds }; user.suspended = Boolean(input.suspended); user.updatedAt = now(); state.audit.push({ id: uid('audit'), at: now(), action: 'teacher.permissions-updated', staffId: user.id, updatedBy: owner.user.id, permissions: user.permissions, suspended: user.suspended }); return user; }); return send(response, 200, publicUser(updated)); }
    if (method === 'GET' && path === '/api/admin/live-classes') { const state = await readState(); requireSuperAdmin(request, state); return send(response, 200, state.liveClasses.map(item => ({ ...teacherClassroomView(item), batchName: state.batches.find(batch => batch.id === item.batchId)?.name || item.batchId }))); }
    const adminClassMatch = path.match(/^\/api\/admin\/live-classes\/([^/]+)$/);
    if (method === 'PUT' && adminClassMatch) { const current = await readState(); const owner = requireSuperAdmin(request, current), input = await body(request); const updated = await updateState(state => { const item = state.liveClasses.find(record => record.id === adminClassMatch[1]); if (!item) throw Object.assign(new Error('Live class not found.'), { status: 404 }); item.restricted = Boolean(input.restricted); item.restrictionReason = item.restricted ? String(input.reason || 'Restricted by an administrator').trim().slice(0, 300) : null; item.restrictedAt = item.restricted ? now() : null; item.restrictedBy = item.restricted ? owner.user.id : null; state.audit.push({ id: uid('audit'), at: now(), action: item.restricted ? 'live-class.restricted' : 'live-class.restored', classId: item.id, staffId: owner.user.id }); return item; }); return send(response, 200, teacherClassroomView(updated)); }
    if (method === 'GET' && path === '/api/admin/materials') { requireAdmin(request); const state = await readState(); return send(response, 200, state.materials.map(({ storageKey, ...item }) => ({ ...item, batchName: state.batches.find(batch => batch.id === item.batchId)?.name || item.batchId, downloadable: Boolean(storageKey) }))); }
    const adminMaterialAccessMatch = path.match(/^\/api\/admin\/materials\/([^/]+)\/access$/);
    if (method === 'PUT' && adminMaterialAccessMatch) { const admin = requireAdmin(request), input = await body(request); const updated = await updateState(state => { const item = state.materials.find(record => record.id === adminMaterialAccessMatch[1]); if (!item) throw Object.assign(new Error('Batch material not found.'), { status: 404 }); item.restricted = Boolean(input.restricted); item.restrictionReason = item.restricted ? String(input.reason || 'Restricted by administrator').trim().slice(0, 300) : null; item.restrictedAt = item.restricted ? now() : null; item.restrictedBy = item.restricted ? admin.sub : null; state.audit.push({ id: uid('audit'), at: now(), action: item.restricted ? 'material.restricted' : 'material.restored', materialId: item.id, staffId: admin.sub }); return item; }); return send(response, 200, { ...updated, downloadable: Boolean(updated.storageKey) }); }
    if (method === 'GET' && path === '/api/admin/admission-applications') { requireAdmin(request); const state = await readState(); return send(response, 200, state.enrollments.filter(item => ['DOCUMENTS_SUBMITTED_PENDING_PAYMENT', 'PAYMENT_CONFIRMED', 'VERIFICATION_IN_PROGRESS', 'ACTIVE', 'NEEDS_ACTION'].includes(item.status)).map(enrollment => { const student = state.students.find(item => item.id === enrollment.studentId), notice = enrollment.intakeNotice; return { ...publicEnrollment(enrollment, state), student: student ? { id: student.id, name: student.name, email: student.email, phone: student.phone, referenceNumber: student.referenceNumber } : null, intakeNotice: notice ? { status: notice.status, provider: notice.provider, attemptedAt: notice.attemptedAt, error: notice.error || null } : null, documents: state.admissionDocuments.filter(item => item.enrollmentId === enrollment.id).map(publicAdmissionDocument) }; })); }
    const admissionApplicationMatch = path.match(/^\/api\/admin\/admission-applications\/([^/]+)$/);
    if (method === 'PUT' && admissionApplicationMatch) {
      const admin = requireAdmin(request), input = await body(request), requestedStatus = String(input.status || '').trim(), enrollmentNumber = String(input.enrollmentNumber || '').trim(), dateOfBirth = String(input.dateOfBirth || '').trim(), boardCode = String(input.boardCode || '').trim(), referenceNumber = String(input.referenceNumber || '').trim();
      if (!['VERIFICATION_IN_PROGRESS', 'NEEDS_ACTION', 'ACTIVE'].includes(requestedStatus)) return send(response, 422, { error: 'Choose a valid admission status.' });
      if (requestedStatus !== 'NEEDS_ACTION' && (!isSafeString(enrollmentNumber, 80) || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth))) return send(response, 422, { error: 'An enrollment number and ISO date of birth are required to start NIOS verification.' });
      const updated = await updateState(data => { const enrollment = data.enrollments.find(item => item.id === admissionApplicationMatch[1]); if (!enrollment) throw Object.assign(new Error('Admission application not found.'), { status: 404 }); const student = data.students.find(item => item.id === enrollment.studentId); if (!student) throw Object.assign(new Error('Student record not found.'), { status: 404 }); if (requestedStatus !== 'NEEDS_ACTION' && !['PAYMENT_CONFIRMED', 'VERIFICATION_IN_PROGRESS', 'ACTIVE'].includes(enrollment.status)) throw Object.assign(new Error('Full payment must be received before official registration verification can begin.'), { status: 409 }); if (requestedStatus === 'ACTIVE' && !['VERIFICATION_IN_PROGRESS', 'ACTIVE'].includes(enrollment.status)) throw Object.assign(new Error('Start verification before manually confirming an official admission.'), { status: 409 }); if (requestedStatus !== 'NEEDS_ACTION') { const currentVault = data.vault[student.id] ? decrypt(data.vault[student.id]) : {}; data.vault[student.id] = encrypt({ ...currentVault, enrollmentNumber, dateOfBirth, referenceNumber: referenceNumber || currentVault.referenceNumber || student.referenceNumber, boardCode: boardCode || currentVault.boardCode || student.boardCode || student.board, consent: Boolean(currentVault.consent || enrollment.portalSyncConsent), consentedAt: currentVault.consentedAt || (enrollment.portalSyncConsent ? now() : null), adminRecordedAt: now() }); student.boardCode = boardCode || student.boardCode || student.board; if (referenceNumber) student.referenceNumber = referenceNumber; }
        const manuallyConfirmed = requestedStatus === 'ACTIVE'; Object.assign(enrollment, { status: requestedStatus, enrollmentNumber: requestedStatus === 'NEEDS_ACTION' ? enrollment.enrollmentNumber || null : enrollmentNumber, verificationStartedAt: requestedStatus === 'VERIFICATION_IN_PROGRESS' ? now() : enrollment.verificationStartedAt, officialVerificationConfirmedAt: manuallyConfirmed ? now() : enrollment.officialVerificationConfirmedAt, manualVerificationConfirmedAt: manuallyConfirmed ? now() : enrollment.manualVerificationConfirmedAt, activatedAt: manuallyConfirmed ? now() : enrollment.activatedAt, adminNote: String(input.adminNote || '').trim().slice(0, 1000) || null, updatedAt: now(), updatedBy: admin.sub }); if (manuallyConfirmed) student.accountStatus = 'ACTIVE_STUDENT'; data.audit.push({ id: uid('audit'), at: now(), action: manuallyConfirmed ? 'admission.manually-confirmed' : 'admission.admin-updated', enrollmentId: enrollment.id, studentId: student.id, status: requestedStatus, staffId: admin.sub }); return { enrollment, studentId: student.id, manuallyConfirmed }; });
      if (requestedStatus === 'VERIFICATION_IN_PROGRESS' && process.env.NIOS_SYNC_MODE !== 'manual') await queueSync(updated.studentId, 'admin-admission-verification'); const current = await readState(), student = current.students.find(item => item.id === updated.studentId); emit(updated.studentId, updated.manuallyConfirmed ? 'admission.confirmed' : 'admission.status-updated', { enrollmentId: updated.enrollment.id, status: requestedStatus, manual: updated.manuallyConfirmed }); if (updated.manuallyConfirmed && student) await sendNotification(student, 'Your NIOS admission has been confirmed by the academy. Your full Student Desk is now available.'); return send(response, 200, publicEnrollment(updated.enrollment, current));
    }
    const adminAdmissionDocumentMatch = path.match(/^\/api\/admin\/admission-documents\/([^/]+)\/download$/);
    if (method === 'GET' && adminAdmissionDocumentMatch) { requireAdmin(request); const state = await readState(), document = state.admissionDocuments.find(item => item.id === adminAdmissionDocumentMatch[1]); if (!document) return send(response, 404, { error: 'Admission document not found.' }); const stored = await storage.get(document.storageKey); response.writeHead(200, { 'content-type': document.mimeType, 'content-disposition': `attachment; filename="${document.fileName}"` }); return response.end(stored.bytes); }
    if (method === 'GET' && path === '/api/admin/health') { requireAdmin(request); const state = await readState(), logs = state.syncLogs || [], success = logs.filter(item => item.status === 'SUCCESS').length, failed = logs.filter(item => item.status === 'FAILED' || item.status === 'PORTAL_OFFLINE').length; return send(response, 200, { queued: state.jobs.filter(item => item.status === 'queued').length, processing: state.jobs.filter(item => item.status === 'processing').length, failed: state.jobs.filter(item => item.status === 'failed' || item.status === 'portal_offline').slice(-10), completed: state.jobs.filter(item => item.status === 'completed').slice(-20), successRate: success + failed ? Math.round((success / (success + failed)) * 1000) / 10 : null, audit: state.audit.slice(-25), readyForWrites: productionWritesReady, readiness: integrationReadiness(state) }); }
    if (method === 'GET' && path === '/api/admin/sync-logs') { requireAdmin(request); const state = await readState(); return send(response, 200, (state.syncLogs || []).slice(-100).reverse()); }
    if (method === 'GET' && path === '/api/admin/batches') { requireAdmin(request); const state = await readState(); return send(response, 200, state.batches); }
    if (method === 'POST' && path === '/api/admin/batches') { requireAdmin(request); const input = await body(request); const created = await updateState(state => { const batch = batchFrom(input); state.batches.push(batch); state.audit.push({ id: uid('audit'), at: now(), action: 'batch.created', batchId: batch.id }); return batch; }); return send(response, 201, created); }
    const batchMatch = path.match(/^\/api\/admin\/batches\/([^/]+)$/);
    if (method === 'PUT' && batchMatch) { const admin = requireAdmin(request), input = await body(request); const updated = await updateState(state => { const index = state.batches.findIndex(batch => batch.id === batchMatch[1]); if (index < 0) throw Object.assign(new Error('Batch not found.'), { status: 404 }); const existing = state.batches[index], batch = batchFrom(input, existing), enrollments = state.enrollments.filter(item => item.batchId === existing.id); if (enrollments.length) { if (batch.board !== existing.board || batch.class !== existing.class || batch.stream !== existing.stream || batch.streamId !== existing.streamId) throw Object.assign(new Error('Board, class, stream and stream ID are locked after students enroll. Create a new batch for a new cohort.'), { status: 409 }); const offered = new Map(batch.subjects.map(subject => [String(subject.code), String(subject.name)])); const affected = enrollments.flatMap(enrollment => (enrollment.selectedSubjects || []).filter(subject => offered.get(String(subject.code)) !== String(subject.name))); if (affected.length) throw Object.assign(new Error('This change would remove a subject selected by an enrolled student. Keep that subject or create a new batch.'), { status: 409 }); } state.batches[index] = batch; state.audit.push({ id: uid('audit'), at: now(), action: 'batch.updated', batchId: batch.id, staffId: admin.sub }); return batch; }); return send(response, 200, updated); }
    if (method === 'DELETE' && batchMatch) { requireAdmin(request); const removed = await updateState(state => { const index = state.batches.findIndex(batch => batch.id === batchMatch[1]); if (index < 0) throw Object.assign(new Error('Batch not found.'), { status: 404 }); const hasDependents = [state.enrollments, state.payments, state.liveClasses, state.homework, state.materials].some(records => records.some(record => record.batchId === batchMatch[1])); if (hasDependents) throw Object.assign(new Error('This batch already has student or learning records. Move it to draft instead of deleting it.'), { status: 409 }); const [batch] = state.batches.splice(index, 1); state.audit.push({ id: uid('audit'), at: now(), action: 'batch.deleted', batchId: batch.id }); return batch; }); return send(response, 200, { deleted: removed.id }); }
    if (method === 'GET' && path === '/api/admin/students') { requireAdmin(request); const state = await readState(); return send(response, 200, state.students.map(student => publicStudent(student, state))); }
    const adminEnrollmentSubjectsMatch = path.match(/^\/api\/admin\/enrollments\/([^/]+)\/subjects$/);
    if (adminEnrollmentSubjectsMatch && method === 'GET') { requireAdmin(request); const state = await readState(), enrollment = state.enrollments.find(item => item.id === adminEnrollmentSubjectsMatch[1]); if (!enrollment) return send(response, 404, { error: 'Enrollment not found.' }); const student = state.students.find(item => item.id === enrollment.studentId), batch = state.batches.find(item => item.id === enrollment.batchId); if (!student || !batch) return send(response, 404, { error: 'The enrolled student or batch is no longer available.' }); return send(response, 200, { student: { id: student.id, name: student.name, email: student.email }, enrollment: publicEnrollment(enrollment, state), subjectOptions: admissionSubjectOptions(batch), selectedSubjects: studentSubjectsForEnrollment(student, enrollment, state) }); }
    if (adminEnrollmentSubjectsMatch && method === 'PUT') { const admin = requireAdmin(request), input = await body(request); const updated = await updateState(state => { const enrollment = state.enrollments.find(item => item.id === adminEnrollmentSubjectsMatch[1]); if (!enrollment) throw Object.assign(new Error('Enrollment not found.'), { status: 404 }); const student = state.students.find(item => item.id === enrollment.studentId), batch = state.batches.find(item => item.id === enrollment.batchId); if (!student || !batch) throw Object.assign(new Error('The enrolled student or batch is no longer available.'), { status: 404 }); const selectedSubjects = admissionSubjects(input.subjects, admissionSubjectOptions(batch)); enrollment.selectedSubjects = selectedSubjects; enrollment.subjectAccessUpdatedAt = now(); enrollment.subjectAccessUpdatedBy = admin.sub; enrollment.updatedAt = now(); state.audit.push({ id: uid('audit'), at: now(), action: 'enrollment.subject-access-updated', enrollmentId: enrollment.id, studentId: student.id, batchId: batch.id, staffId: admin.sub, subjectCount: selectedSubjects.length }); return { enrollment, studentId: student.id }; }); const state = await readState(), enrollment = state.enrollments.find(item => item.id === updated.enrollment.id); emit(updated.studentId, 'enrollment.subject-access-updated', { enrollmentId: updated.enrollment.id, subjectCount: updated.enrollment.selectedSubjects.length }); return send(response, 200, { enrollment: publicEnrollment(enrollment, state), selectedSubjects: studentSubjectsForEnrollment(state.students.find(item => item.id === updated.studentId), enrollment, state) }); }
    const overrideMatch = path.match(/^\/api\/admin\/students\/([^/]+)\/documents\/([^/]+)$/);
    if (method === 'PUT' && overrideMatch) { requireAdmin(request); const input = await body(request); if (!['Pending', 'Processing', 'Issued', 'Verified', 'Action Needed'].includes(input.status)) return send(response, 422, { error: 'Invalid document status.' }); const updated = await updateState(state => { const document = state.documents.find(item => item.id === overrideMatch[2] && item.studentId === overrideMatch[1]); if (!document) throw Object.assign(new Error('Document not found.'), { status: 404 }); document.status = input.status; document.updatedAt = now(); document.staffNote = String(input.note || '').slice(0, 500); state.audit.push({ id: uid('audit'), at: now(), action: 'document.override', studentId: overrideMatch[1], documentId: document.id, status: input.status }); return document; }); emit(overrideMatch[1], 'document.updated', updated); return send(response, 200, updated); }
    if (method === 'POST' && path === '/api/admin/test-notification') { requireAdmin(request); const input = await body(request), state = await readState(), student = state.students.find(item => item.id === input.studentId); if (!student) return send(response, 404, { error: 'Student not found.' }); await sendNotification(student, input.message || 'Test notification from NIOS Best Academy.'); return send(response, 202, { accepted: true }); }
    return serveStatic(path, response, request);
  } catch (error) { console.error(error.message); return send(response, error.status || 500, { error: error.message || 'Internal server error.' }, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {}); }
});
server.listen(port, () => console.log(`NIOS Best Academy portal service is running at http://localhost:${port}`));
