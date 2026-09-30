import http from 'node:http';
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'build');
// In production, STORAGE_DIR must point to Render's attached persistent disk.
// Locally it defaults to this project folder, so existing files continue to work.
const storageRoot = path.resolve(process.env.STORAGE_DIR || root);
const dataDir = path.join(storageRoot, 'data');
const legacyCardsFile = path.join(dataDir, 'cards.json');
const databaseFile = path.join(dataDir, 'best-education.sqlite');
const papersDir = path.join(storageRoot, 'papers');
const packagedDataDir = path.join(root, 'data');
const packagedPapersDir = path.join(root, 'papers');
const port = Number(process.env.PORT || 4173);
const siteUrl = String(process.env.SITE_URL || 'https://www.ravitestpapers.in').replace(/\/$/, '');
const adminPassword = process.env.ADMIN_PASSWORD;
const downloadSecret = process.env.DOWNLOAD_TOKEN_SECRET;
const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
const razorpayKeySecret = process.env.RAZORPAY_KEY_SECRET;
const razorpayWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
const sessions = new Map();
const loginAttempts = new Map();
const sessionDuration = 12 * 60 * 60 * 1000;
const downloadDuration = 24 * 60 * 60 * 1000;
const maxPdfBytes = 25 * 1024 * 1024;
const allowedTypes = new Set(['sample', 'pyq', 'mcq', 'important']);
const allowedClasses = new Set(['10', '11', '12']);
const individualCardPrice = 39;
const fullCourseBundlePrice = 399;
const legacySectionIds = new Map([
  ['class-10-sample', { className:'10', type:'sample' }],
  ['class-10-pyq', { className:'10', type:'pyq' }],
  ['class-10-mcq', { className:'10', type:'mcq' }],
  ['class-10-important', { className:'10', type:'important' }],
  ['class-11-sample', { className:'11', type:'sample' }],
  ['class-11-pyq', { className:'11', type:'pyq' }],
  ['class-11-mcq', { className:'11', type:'mcq' }],
  ['class-11-important', { className:'11', type:'important' }],
  ['class-12-sample', { className:'12', type:'sample' }],
  ['class-12-pyq', { className:'12', type:'pyq' }],
  ['class-12-mcq', { className:'12', type:'mcq' }],
  ['class-12-important', { className:'12', type:'important' }]
]);

if (!adminPassword || adminPassword.length < 12) {
  console.error('Set ADMIN_PASSWORD to a private password with at least 12 characters.');
  process.exit(1);
}
if (!downloadSecret || downloadSecret.length < 32) {
  console.error('Set DOWNLOAD_TOKEN_SECRET to a separate random secret with at least 32 characters.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production' && !siteUrl.startsWith('https://')) {
  console.error('Set SITE_URL to the public HTTPS URL before starting in production.');
  process.exit(1);
}

async function fileExists(file) { try { await stat(file); return true; } catch { return false; } }
async function seedPersistentStorage() {
  await mkdir(dataDir, { recursive:true });
  await mkdir(papersDir, { recursive:true });
  if (storageRoot === root) return;
  const packagedCards = path.join(packagedDataDir, 'cards.json');
  if (await fileExists(packagedCards) && !await fileExists(legacyCardsFile)) await copyFile(packagedCards, legacyCardsFile);
  const packagedFiles = await readdir(packagedPapersDir).catch(() => []);
  for (const file of packagedFiles) {
    if (path.extname(file).toLowerCase() !== '.pdf') continue;
    const destination = path.join(papersDir, file);
    if (!await fileExists(destination)) await copyFile(path.join(packagedPapersDir, file), destination);
  }
}
await seedPersistentStorage();
const db = new DatabaseSync(databaseFile);
db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, class_name TEXT NOT NULL, subject TEXT NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL,
    link TEXT NOT NULL DEFAULT '', file_key TEXT NOT NULL DEFAULT '', is_bundle INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    razorpay_order_id TEXT PRIMARY KEY, card_id TEXT NOT NULL, amount INTEGER NOT NULL,
    currency TEXT NOT NULL, status TEXT NOT NULL, razorpay_payment_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    fulfilled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cards_filters ON cards(type, class_name, subject);
  CREATE INDEX IF NOT EXISTS idx_cards_slug ON cards(slug);
  CREATE INDEX IF NOT EXISTS idx_orders_card_id ON orders(card_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_payment_id ON orders(razorpay_payment_id);
  CREATE TABLE IF NOT EXISTS catalog_sections (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_published INTEGER NOT NULL DEFAULT 0,
    show_on_home INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_catalog_sections_parent_sort ON catalog_sections(parent_id, sort_order, title);
  CREATE INDEX IF NOT EXISTS idx_catalog_sections_public ON catalog_sections(is_published, parent_id, sort_order);
`);
try { db.exec('ALTER TABLE cards ADD COLUMN is_bundle INTEGER NOT NULL DEFAULT 0'); } catch { /* Existing databases already have this column. */ }
try { db.exec('ALTER TABLE cards ADD COLUMN section_id TEXT'); } catch { /* Existing databases already have this column. */ }
try { db.exec("ALTER TABLE cards ADD COLUMN resource_label TEXT NOT NULL DEFAULT ''"); } catch { /* Existing databases already have this column. */ }
try { db.exec('ALTER TABLE cards ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch { /* Existing databases already have this column. */ }
try { db.exec('ALTER TABLE cards ADD COLUMN is_published INTEGER NOT NULL DEFAULT 1'); } catch { /* Existing databases already have this column. */ }
db.exec('CREATE INDEX IF NOT EXISTS idx_cards_catalog_public ON cards(section_id, is_published, sort_order, updated_at)');

function slugify(value) { return String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 110) || 'study-material'; }
function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}
function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-100000, Math.min(100000, Math.trunc(number))) : fallback;
}
function requiredCardPrice(value, isBundle) {
  const fixedPrice = isBundle ? fullCourseBundlePrice : individualCardPrice;
  if (value !== undefined && value !== null && value !== '') {
    const supplied = Number(value);
    if (!Number.isFinite(supplied) || Math.round(supplied) !== fixedPrice) throw new Error(`The price is fixed at ₹${fixedPrice} for this material.`);
  }
  return fixedPrice;
}
function rowToCard(row) {
  return {
    id:row.id,
    type:row.type,
    className:row.class_name,
    subject:row.subject,
    title:row.title,
    description:row.description,
    price:String(row.price),
    link:row.link,
    fileKey:row.file_key,
    isBundle:Boolean(row.is_bundle),
    sectionId:row.section_id || '',
    resourceLabel:row.resource_label || '',
    sortOrder:Number(row.sort_order || 0),
    isPublished:Number(row.is_published) !== 0,
    slug:row.slug,
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}
function rowToSection(row) {
  return {
    id:row.id,
    parentId:row.parent_id || null,
    title:row.title,
    slug:row.slug,
    description:row.description || '',
    icon:row.icon || '',
    sortOrder:Number(row.sort_order || 0),
    isPublished:Boolean(row.is_published),
    showOnHome:Boolean(row.show_on_home),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}
function readCards() { return db.prepare('SELECT * FROM cards ORDER BY sort_order ASC, updated_at DESC').all().map(rowToCard); }
function getCard(id) { const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(id); return row ? rowToCard(row) : null; }
function getCardBySlug(slug) { const row = db.prepare('SELECT * FROM cards WHERE slug = ?').get(slug); return row ? rowToCard(row) : null; }
function readSections() { return db.prepare('SELECT * FROM catalog_sections ORDER BY parent_id IS NOT NULL, parent_id, sort_order ASC, title COLLATE NOCASE ASC').all().map(rowToSection); }
function getSection(id) { const row = db.prepare('SELECT * FROM catalog_sections WHERE id = ?').get(id); return row ? rowToSection(row) : null; }
function getOrder(id) { return db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(id) || null; }
function slugAvailable(slug, existingId) { const row = db.prepare('SELECT id FROM cards WHERE slug = ?').get(slug); return !row || row.id === existingId; }
function uniqueSlug(value, existingId) { const base = slugify(value); let candidate = base; let attempt = 2; while (!slugAvailable(candidate, existingId)) candidate = `${base}-${attempt++}`; return candidate; }
function sectionSlugAvailable(slug, existingId) { const row = db.prepare('SELECT id FROM catalog_sections WHERE slug = ?').get(slug); return !row || row.id === existingId; }
function uniqueSectionSlug(value, existingId) { const base = slugify(value); let candidate = base; let attempt = 2; while (!sectionSlugAvailable(candidate, existingId)) candidate = `${base}-${attempt++}`; return candidate; }

const seededSections = [
  ['class-10', null, 'Class 10', 'class-10', 'Study materials for Class 10.', '', 10, 1, 1],
  ['class-11', null, 'Class 11', 'class-11', 'Study materials for Class 11.', '', 20, 1, 1],
  ['class-12', null, 'Class 12', 'class-12', 'Study materials for Class 12.', '', 30, 1, 1],
  ['jee', null, 'JEE', 'jee', 'Study materials for JEE preparation.', '', 40, 1, 1],
  ['neet', null, 'NEET', 'neet', 'Study materials for NEET preparation.', '', 50, 1, 1],
  ['class-10-sample', 'class-10', 'Sample Papers', 'class-10-sample-papers', '', '', 10, 1, 0],
  ['class-10-pyq', 'class-10', 'Previous Year Questions', 'class-10-previous-year-questions', '', '', 20, 1, 0],
  ['class-10-mcq', 'class-10', 'MCQs', 'class-10-mcqs', '', '', 30, 1, 0],
  ['class-10-important', 'class-10', 'Important Questions', 'class-10-important-questions', '', '', 40, 1, 0],
  ['class-11-sample', 'class-11', 'Sample Papers', 'class-11-sample-papers', '', '', 10, 1, 0],
  ['class-11-pyq', 'class-11', 'Previous Year Questions', 'class-11-previous-year-questions', '', '', 20, 1, 0],
  ['class-11-mcq', 'class-11', 'MCQs', 'class-11-mcqs', '', '', 30, 1, 0],
  ['class-11-important', 'class-11', 'Important Questions', 'class-11-important-questions', '', '', 40, 1, 0],
  ['class-12-sample', 'class-12', 'Sample Papers', 'class-12-sample-papers', '', '', 10, 1, 0],
  ['class-12-pyq', 'class-12', 'Previous Year Questions', 'class-12-previous-year-questions', '', '', 20, 1, 0],
  ['class-12-mcq', 'class-12', 'MCQs', 'class-12-mcqs', '', '', 30, 1, 0],
  ['class-12-important', 'class-12', 'Important Questions', 'class-12-important-questions', '', '', 40, 1, 0]
];
function seedCatalogSections() {
  const now = new Date().toISOString();
  const statement = db.prepare(`INSERT OR IGNORE INTO catalog_sections
    (id,parent_id,title,slug,description,icon,sort_order,is_published,show_on_home,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, parentId, title, slug, description, icon, sortOrder, isPublished, showOnHome] of seededSections) {
    statement.run(id, parentId, title, slug, description, icon, sortOrder, isPublished, showOnHome, now, now);
  }
}
function backfillLegacyCardSections() {
  db.prepare(`UPDATE cards SET section_id = 'class-' || class_name || '-' || type
    WHERE (section_id IS NULL OR section_id = '')
      AND class_name IN ('10','11','12')
      AND type IN ('sample','pyq','mcq','important')`).run();
}
async function importLegacyCards() {
  if (Number(db.prepare('SELECT COUNT(*) AS count FROM cards').get().count) > 0) return;
  try { const legacy = JSON.parse(await readFile(legacyCardsFile, 'utf8')); if (!Array.isArray(legacy)) return; for (const input of legacy) insertCard(cleanCard(input)); } catch { /* First run does not have a legacy card file. */ }
}

function escapeXml(value) { return String(value).replace(/[<>&'\"]/g, char => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', "'":'&apos;', '"':'&quot;' })[char]); }
function buildSitemap(cards = readPublicCards()) {
  const pages = ['/', '/library.html', '/sample-papers.html', '/pyqs.html', '/mcqs.html', '/important-questions.html'];
  const fixed = pages.map(page => `  <url><loc>${escapeXml(`${siteUrl}${page}`)}</loc></url>`);
  const cardUrls = cards.map(card => `  <url><loc>${escapeXml(`${siteUrl}/paper/${card.slug}`)}</loc><lastmod>${card.updatedAt.slice(0, 10)}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...fixed, ...cardUrls].join('\n')}\n</urlset>\n`;
}
seedCatalogSections();
await importLegacyCards();
backfillLegacyCardSections();

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  const headers = { 'Content-Type':contentType, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin', 'X-Frame-Options':'DENY', 'Permissions-Policy':'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy':"default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" };
  if (process.env.NODE_ENV === 'production') headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}
function json(response, status, body, extraHeaders = {}) { response.writeHead(status, { ...securityHeaders(), 'Cache-Control':'no-store', ...extraHeaders }); response.end(JSON.stringify(body)); }
async function rawBody(request, maxBytes = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function body(request, maxBytes = 1_000_000) { const bytes = await rawBody(request, maxBytes); return bytes.length ? JSON.parse(bytes.toString('utf8')) : {}; }
function constantTimeEqual(left, right) { const a = Buffer.from(String(left)); const b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); }
function cookies(request) { return Object.fromEntries((request.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => { const index = part.indexOf('='); return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))]; })); }
function authenticated(request) { const token = cookies(request).admin_session; const expires = sessions.get(token); if (!expires || expires < Date.now()) { if (token) sessions.delete(token); return false; } sessions.set(token, Date.now() + sessionDuration); return true; }
function sameOrigin(request) { const origin = request.headers.origin; return !origin || origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`; }
function loginAllowed(address) { const recent = (loginAttempts.get(address) || []).filter(time => Date.now() - time < 15 * 60 * 1000); loginAttempts.set(address, recent); return recent.length < 5; }
function safePdfFilename(value) {
  const filename = String(value || '').trim();
  if (!filename || filename.length > 180 || path.basename(filename) !== filename || !/^[a-z0-9][a-z0-9._ ()-]*\.pdf$/i.test(filename)) throw new Error('Choose a valid PDF filename.');
  return filename;
}
const typeLabels = { sample:'Sample Papers', pyq:'Previous Year Questions', mcq:'MCQs', important:'Important Questions' };
function sectionPath(sectionId, sections = readSections()) {
  if (!sectionId) return null;
  const byId = sections instanceof Map ? sections : new Map(sections.map(section => [section.id, section]));
  const leaf = byId.get(sectionId);
  if (!leaf) return null;
  if (!leaf.parentId) return { root:leaf, leaf, byId };
  const root = byId.get(leaf.parentId);
  if (!root || root.parentId) return null;
  return { root, leaf, byId };
}
function legacyFieldsForSection(sectionId, resourceLabel, sections = readSections()) {
  const legacy = legacySectionIds.get(sectionId);
  if (legacy) return legacy;
  const path = sectionPath(sectionId, sections);
  if (!path) throw new Error('Choose a valid library section.');
  const rootMatch = path.root.id.match(/^class-(10|11|12)$/) || path.root.title.match(/^class\s*(10|11|12)$/i);
  const className = rootMatch ? rootMatch[1] : path.root.title.slice(0, 80);
  const tileTitle = resourceLabel || path.leaf.title || path.root.title;
  return { className, type:slugify(tileTitle).slice(0, 80) || 'resource' };
}
function cardDisplay(card, sections = readSections()) {
  const path = sectionPath(card.sectionId, sections);
  if (path) {
    const legacy = legacySectionIds.get(card.sectionId);
    return {
      displayClassName:path.root.title,
      displayType:card.resourceLabel || path.leaf.title || typeLabels[legacy?.type || card.type] || card.type
    };
  }
  return {
    displayClassName:allowedClasses.has(card.className) ? `Class ${card.className}` : card.className,
    displayType:card.resourceLabel || typeLabels[card.type] || card.type
  };
}
function sectionChainIsPublished(sectionId, sections = readSections()) {
  if (!sectionId) return true;
  const path = sectionPath(sectionId, sections);
  return Boolean(path?.root.isPublished && path.leaf.isPublished);
}
function cardIsPublic(card, sections = readSections()) { return card.isPublished && sectionChainIsPublished(card.sectionId, sections); }
function publicCard(card, sections = readSections()) {
  const { fileKey, isPublished, ...safe } = card;
  return { ...safe, ...cardDisplay(card, sections), available:Boolean(fileKey) };
}
function readPublicCards() {
  const sections = readSections();
  return readCards().filter(card => cardIsPublic(card, sections)).map(card => publicCard(card, sections));
}
function cleanSection(input, existing = null) {
  const hasParent = Object.prototype.hasOwnProperty.call(input, 'parentId');
  const parentId = String(hasParent ? input.parentId || '' : existing?.parentId || '').trim() || null;
  const title = String(input.title ?? existing?.title ?? '').trim().replace(/\s+/g, ' ').slice(0, 90);
  const description = String(input.description ?? existing?.description ?? '').trim().slice(0, 400);
  const icon = String(input.icon ?? existing?.icon ?? '').trim().slice(0, 24);
  if (!title) throw new Error('A section title is required.');
  const id = existing?.id || randomUUID();
  const sortOrder = numberValue(input.sortOrder, existing?.sortOrder || 0);
  const isPublished = booleanValue(input.isPublished, existing?.isPublished ?? false);
  const showOnHome = booleanValue(input.showOnHome, existing?.showOnHome ?? false);
  const slug = uniqueSectionSlug(input.slug || `${parentId ? 'tile-' : 'section-'}${title}`, id);
  const now = new Date().toISOString();
  return { id, parentId, title, slug, description, icon, sortOrder, isPublished, showOnHome, createdAt:existing?.createdAt || now, updatedAt:now };
}
function validateSectionParent(section, existing = null) {
  if (!section.parentId) return;
  if (section.parentId === section.id) throw new Error('A section cannot be its own parent.');
  const parent = getSection(section.parentId);
  if (!parent) throw new Error('Choose an existing top-level section.');
  if (parent.parentId) throw new Error('Library sections can only have one level of tiles.');
  if (existing && existing.parentId !== section.parentId) {
    const childCount = Number(db.prepare('SELECT COUNT(*) AS count FROM catalog_sections WHERE parent_id = ?').get(existing.id).count);
    if (childCount) throw new Error('Move or remove this section’s tiles before making it a tile.');
  }
}
function insertSection(section) {
  db.prepare(`INSERT INTO catalog_sections (id,parent_id,title,slug,description,icon,sort_order,is_published,show_on_home,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(section.id, section.parentId, section.title, section.slug, section.description, section.icon, section.sortOrder, Number(section.isPublished), Number(section.showOnHome), section.createdAt, section.updatedAt);
  return section;
}
function updateSection(section) {
  db.prepare(`UPDATE catalog_sections SET parent_id=?,title=?,slug=?,description=?,icon=?,sort_order=?,is_published=?,show_on_home=?,updated_at=? WHERE id=?`)
    .run(section.parentId, section.title, section.slug, section.description, section.icon, section.sortOrder, Number(section.isPublished), Number(section.showOnHome), section.updatedAt, section.id);
  return section;
}
function cleanCard(input, existing = null) {
  const sectionId = String(input.sectionId ?? existing?.sectionId ?? '').trim();
  const resourceLabel = String(input.resourceLabel ?? existing?.resourceLabel ?? '').trim().slice(0, 100);
  const sections = sectionId ? readSections() : [];
  const sectionFields = sectionId ? legacyFieldsForSection(sectionId, resourceLabel, sections) : null;
  const type = sectionFields?.type || String(input.type ?? existing?.type ?? '').trim();
  const className = sectionFields?.className || String(input.className ?? existing?.className ?? '').trim();
  const path = sectionId ? sectionPath(sectionId, sections) : null;
  const subject = String(input.subject ?? existing?.subject ?? (path ? (resourceLabel || path.leaf.title || path.root.title) : '')).trim().slice(0, 80);
  const title = String(input.title ?? existing?.title ?? '').trim().slice(0, 140);
  const description = String(input.description ?? existing?.description ?? '').trim().slice(0, 500);
  let link = String(input.link ?? existing?.link ?? '').trim();
  let fileKey = String(input.fileKey ?? existing?.fileKey ?? '').trim();
  const isBundle = booleanValue(input.isBundle, existing?.isBundle ?? false);
  const price = requiredCardPrice(input.price, isBundle);
  const isPublished = booleanValue(input.isPublished, existing?.isPublished ?? (!sectionId || legacySectionIds.has(sectionId)));
  const sortOrder = numberValue(input.sortOrder, existing?.sortOrder || 0);
  if ((!sectionId && (!allowedTypes.has(type) || !allowedClasses.has(className))) || !subject || !title) throw new Error('Invalid card details.');
  if (link) { const url = new URL(link); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid preview link'); link = url.href; }
  if (fileKey) fileKey = safePdfFilename(fileKey);
  const id = existing?.id || randomUUID();
  const slug = uniqueSlug(input.slug || `${type}-class-${className}-${subject}-${title}`, id);
  const now = new Date().toISOString();
  return { id, type, className, subject, title, description, price:String(price), link, fileKey, isBundle, sectionId, resourceLabel, sortOrder, isPublished, slug, createdAt:existing?.createdAt || now, updatedAt:now };
}
function insertCard(card) {
  db.prepare(`INSERT INTO cards (id,type,class_name,subject,title,description,price,link,file_key,is_bundle,section_id,resource_label,sort_order,is_published,slug,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(card.id, card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey, Number(card.isBundle), card.sectionId || null, card.resourceLabel, card.sortOrder, Number(card.isPublished), card.slug, card.createdAt, card.updatedAt);
  return card;
}
function updateCard(card) {
  db.prepare(`UPDATE cards SET type=?,class_name=?,subject=?,title=?,description=?,price=?,link=?,file_key=?,is_bundle=?,section_id=?,resource_label=?,sort_order=?,is_published=?,slug=?,updated_at=? WHERE id=?`)
    .run(card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey, Number(card.isBundle), card.sectionId || null, card.resourceLabel, card.sortOrder, Number(card.isPublished), card.slug, card.updatedAt, card.id);
  return card;
}

const scienceLessons = ['Chemical Reactions and Equations','Acids, Bases and Salts','Metals and Non-metals','Carbon and its Compounds','Life Processes','Control and Coordination','How Do Organisms Reproduce?','Heredity','Light: Reflection and Refraction','The Human Eye and the Colourful World','Electricity','Magnetic Effects of Electric Current','Our Environment','Sustainable Management of Natural Resources'];
function seedPapers() { return [...allowedTypes].flatMap(type => scienceLessons.map((title, index) => ({ id:`${type}-class-10-science-chapter-${index + 1}`, slug:`${type}-class-10-science-${slugify(title)}`, type, className:'10', subject:'Science', title, description:'Chapter-wise practice material', price:'39', updatedAt:'2026-09-24T00:00:00.000Z', available:false }))); }
function publicSection(section) {
  return {
    id:section.id,
    parentId:section.parentId,
    title:section.title,
    slug:section.slug,
    description:section.description,
    icon:section.icon,
    sortOrder:section.sortOrder,
    showOnHome:section.showOnHome
  };
}
function publicCatalog() {
  const sections = readSections();
  const sectionMap = new Map(sections.map(section => [section.id, section]));
  const cardsBySection = new Map();
  const unsectionedCards = [];
  for (const card of readCards()) {
    if (!cardIsPublic(card, sectionMap)) continue;
    const safe = publicCard(card, sectionMap);
    if (!card.sectionId) unsectionedCards.push(safe);
    else {
      const items = cardsBySection.get(card.sectionId) || [];
      items.push(safe);
      cardsBySection.set(card.sectionId, items);
    }
  }
  const roots = sections.filter(section => !section.parentId && section.isPublished);
  return {
    sections:roots.map(root => ({
      ...publicSection(root),
      cards:cardsBySection.get(root.id) || [],
      children:sections.filter(child => child.parentId === root.id && child.isPublished).map(child => ({
        ...publicSection(child),
        cards:cardsBySection.get(child.id) || []
      }))
    })),
    cards:unsectionedCards
  };
}
function allPapers() {
  const cards = readPublicCards();
  const cardSlugs = new Set(cards.map(card => card.slug));
  return [...cards, ...seedPapers().filter(paper => !cardSlugs.has(paper.slug))];
}
function findPaperBySlug(slug) { return allPapers().find(paper => paper.slug === slug) || null; }
function filterPapers(params) { const query = String(params.get('q') || '').trim().toLowerCase().slice(0, 100); const className = String(params.get('class') || ''); const subject = String(params.get('subject') || '').trim(); const type = String(params.get('type') || ''); return allPapers().filter(paper => (!className || paper.className === className) && (!subject || paper.subject.toLowerCase() === subject.toLowerCase()) && (!type || paper.type === type) && (!query || `${paper.displayClassName || paper.className} ${paper.displayType || paper.type} ${paper.className} ${paper.subject} ${paper.type} ${paper.resourceLabel || ''} ${paper.title} ${paper.description}`.toLowerCase().includes(query))).slice(0, 100); }
function signedDownloadToken(card) { const payload = Buffer.from(JSON.stringify({ cardId:card.id, fileKey:card.fileKey, exp:Date.now() + downloadDuration })).toString('base64url'); const signature = createHmac('sha256', downloadSecret).update(payload).digest('base64url'); return `${payload}.${signature}`; }
function readDownloadToken(token) { const [payload, signature] = String(token || '').split('.'); if (!payload || !signature) return null; const expected = createHmac('sha256', downloadSecret).update(payload).digest('base64url'); if (!constantTimeEqual(signature, expected)) return null; try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return data.exp > Date.now() && data.fileKey ? data : null; } catch { return null; } }
async function secureDownload(response, token) {
  const data = readDownloadToken(token); if (!data) return json(response, 403, { error:'This download link is invalid or has expired.' }); let filename; try { filename = safePdfFilename(data.fileKey); } catch { return json(response, 403, { error:'This download link is invalid.' }); } const card = getCard(data.cardId); if (!card || !cardIsPublic(card) || card.fileKey !== filename) return json(response, 403, { error:'This download link is no longer available.' });
  try { const pdf = await readFile(path.join(papersDir, data.fileKey)); response.writeHead(200, { ...securityHeaders('application/pdf'), 'Content-Disposition':`attachment; filename="${data.fileKey.replace(/"/g, '')}"`, 'Cache-Control':'private, no-store' }); response.end(pdf); } catch { json(response, 404, { error:'The protected PDF file was not found.' }); }
}
function saveOrder({ orderId, cardId, amount, currency, status = 'created', paymentId = null, expiresAt, fulfilledAt = null }) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders (razorpay_order_id,card_id,amount,currency,status,razorpay_payment_id,created_at,updated_at,expires_at,fulfilled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(razorpay_order_id) DO UPDATE SET status=excluded.status, razorpay_payment_id=COALESCE(excluded.razorpay_payment_id,orders.razorpay_payment_id), updated_at=excluded.updated_at, fulfilled_at=COALESCE(excluded.fulfilled_at,orders.fulfilled_at)`)
    .run(orderId, cardId, amount, currency, status, paymentId, now, now, expiresAt, fulfilledAt);
}
function updateOrderStatus(orderId, status, paymentId = null, fulfilled = false) {
  const now = new Date().toISOString();
  db.prepare('UPDATE orders SET status=?, razorpay_payment_id=COALESCE(?, razorpay_payment_id), updated_at=?, fulfilled_at=CASE WHEN ? THEN ? ELSE fulfilled_at END WHERE razorpay_order_id=?')
    .run(status, paymentId, now, Number(fulfilled), now, orderId);
}
async function razorpayPayment(order, paymentId) {
  const upstream = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, { headers:{ Authorization:`Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}` } });
  const payment = await upstream.json().catch(() => ({}));
  if (!upstream.ok || payment.order_id !== order.razorpay_order_id || Number(payment.amount) !== Number(order.amount) || payment.currency !== order.currency) throw new Error('Payment details could not be confirmed.');
  if (payment.status !== 'captured') throw new Error('Payment is still being processed. Please wait a moment and try again.');
  return payment;
}
async function paymentWebhook(request, response) {
  if (!razorpayWebhookSecret) return json(response, 404, { error:'Webhook endpoint is not configured.' });
  try {
    const payload = await rawBody(request, 1_000_000);
    const signature = request.headers['x-razorpay-signature'];
    const expected = createHmac('sha256', razorpayWebhookSecret).update(payload).digest('hex');
    if (!constantTimeEqual(signature || '', expected)) return json(response, 400, { error:'Invalid webhook signature.' });
    const event = JSON.parse(payload.toString('utf8'));
    const payment = event?.payload?.payment?.entity;
    const order = payment?.order_id ? getOrder(payment.order_id) : null;
    if (!order) return json(response, 200, { ok:true });
    if (event.event === 'payment.captured' && payment.status === 'captured' && order.status !== 'fulfilled') updateOrderStatus(payment.order_id, 'captured', payment.id);
    if (event.event === 'payment.failed') updateOrderStatus(payment.order_id, 'failed', payment.id);
    return json(response, 200, { ok:true });
  } catch { return json(response, 400, { error:'Invalid webhook payload.' }); }
}
async function pdfFiles() {
  const entries = await readdir(papersDir, { withFileTypes:true }).catch(() => []);
  return entries.filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf').map(entry => entry.name).sort((a, b) => a.localeCompare(b));
}
function decodePdfUpload(input) {
  const source = String(input || ''); const marker = /^data:application\/pdf(?:;charset=[^;,]+)?;base64,/i;
  if (!marker.test(source)) throw new Error('Choose a valid PDF file.');
  const base64 = source.replace(marker, '');
  if (!base64 || !/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new Error('The PDF upload is invalid.');
  const pdf = Buffer.from(base64, 'base64');
  if (!pdf.length || pdf.length > maxPdfBytes || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Upload a PDF smaller than 25 MB.');
  return pdf;
}
async function api(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/payment/webhook') return paymentWebhook(request, response);
  if (!sameOrigin(request)) return json(response, 403, { error:'Invalid origin' });
  if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok:true, storage:storageRoot });
  if (request.method === 'GET' && url.pathname === '/api/cards') return json(response, 200, { cards:readPublicCards() });
  if (request.method === 'GET' && url.pathname === '/api/catalog') return json(response, 200, publicCatalog());
  if (request.method === 'GET' && url.pathname === '/api/papers') return json(response, 200, { papers:filterPapers(url.searchParams) });
  const slugMatch = url.pathname.match(/^\/api\/papers\/slug\/([a-z0-9-]+)$/i); if (request.method === 'GET' && slugMatch) { const paper = findPaperBySlug(slugMatch[1]); return paper ? json(response, 200, { paper }) : json(response, 404, { error:'Paper not found.' }); }
  const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/); if (request.method === 'GET' && downloadMatch) return secureDownload(response, downloadMatch[1]);
  if (request.method === 'GET' && url.pathname === '/api/admin/session') return json(response, 200, { authenticated:authenticated(request) });
  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    const address = request.socket.remoteAddress || 'unknown'; if (!loginAllowed(address)) return json(response, 429, { error:'Too many attempts. Try again later.' }); const input = await body(request).catch(() => ({})); if (!constantTimeEqual(input.password || '', adminPassword)) { loginAttempts.get(address).push(Date.now()); return json(response, 401, { error:'Incorrect password.' }); }
    loginAttempts.delete(address); const token = randomBytes(32).toString('hex'); sessions.set(token, Date.now() + sessionDuration); const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''; return json(response, 200, { ok:true }, { 'Set-Cookie':`admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionDuration / 1000}${secure}` });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/logout') { const token = cookies(request).admin_session; if (token) sessions.delete(token); return json(response, 200, { ok:true }, { 'Set-Cookie':'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
  const checkoutMatch = url.pathname.match(/^\/api\/checkout\/([a-z0-9-]+)$/i);
  if (request.method === 'POST' && checkoutMatch) {
    const paper = findPaperBySlug(checkoutMatch[1]); const card = paper && getCard(paper.id); if (!card?.fileKey || !cardIsPublic(card)) return json(response, 404, { error:'This paper is not ready for secure purchase yet.' }); if (!razorpayKeyId || !razorpayKeySecret) return json(response, 503, { error:'Secure payments are not configured yet. The administrator must add Razorpay credentials.' });
    const receipt = `best_${randomUUID().replace(/-/g, '').slice(0, 30)}`; const upstream = await fetch('https://api.razorpay.com/v1/orders', { method:'POST', headers:{ Authorization:`Basic ${Buffer.from(`${razorpayKeyId}:${razorpayKeySecret}`).toString('base64')}`, 'Content-Type':'application/json' }, body:JSON.stringify({ amount:Number(card.price) * 100, currency:'INR', receipt, notes:{ card_id:card.id, slug:card.slug } }) }); const order = await upstream.json().catch(() => ({})); if (!upstream.ok || !order.id) return json(response, 502, { error:'The payment service could not create an order. Please try again.' }); saveOrder({ orderId:order.id, cardId:card.id, amount:Number(order.amount), currency:order.currency || 'INR', expiresAt:new Date(Date.now() + 30 * 60 * 1000).toISOString() }); return json(response, 200, { key:razorpayKeyId, order:{ id:order.id, amount:order.amount, currency:order.currency }, paper:publicCard(card) });
  }
  if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
    try { const input = await body(request); const order = getOrder(input.razorpay_order_id); const expected = createHmac('sha256', razorpayKeySecret || '').update(`${input.razorpay_order_id}|${input.razorpay_payment_id}`).digest('hex'); if (!order || new Date(order.expires_at).getTime() < Date.now() || !constantTimeEqual(input.razorpay_signature || '', expected)) throw new Error('Payment verification failed.'); const card = getCard(order.card_id); if (!card?.fileKey || !cardIsPublic(card)) throw new Error('The requested PDF is unavailable.'); const payment = await razorpayPayment(order, input.razorpay_payment_id); updateOrderStatus(order.razorpay_order_id, 'fulfilled', payment.id, true); return json(response, 200, { ok:true, downloadUrl:`/api/download/${signedDownloadToken(card)}`, expiresAt:new Date(Date.now() + downloadDuration).toISOString() }); } catch (error) { return json(response, 400, { error:error.message || 'Payment verification failed.' }); }
  }
  if (!authenticated(request)) return json(response, 401, { error:'Sign in required.' });
  if (request.method === 'GET' && url.pathname === '/api/admin/export') return json(response, 200, { version:4, exportedAt:new Date().toISOString(), sections:readSections(), cards:readCards() });
  if (request.method === 'GET' && url.pathname === '/api/admin/catalog') return json(response, 200, { sections:readSections(), cards:readCards() });
  if (request.method === 'GET' && url.pathname === '/api/admin/sections') return json(response, 200, { sections:readSections() });
  const sectionMatch = url.pathname.match(/^\/api\/admin\/sections\/([a-zA-Z0-9-]+)$/);
  if (request.method === 'POST' && url.pathname === '/api/admin/sections') {
    try {
      const section = cleanSection(await body(request));
      validateSectionParent(section);
      return json(response, 201, { section:insertSection(section) });
    } catch (error) { return json(response, 400, { error:error.message || 'The section could not be saved.' }); }
  }
  if (request.method === 'GET' && sectionMatch) {
    const section = getSection(sectionMatch[1]);
    return section ? json(response, 200, { section }) : json(response, 404, { error:'Section not found.' });
  }
  if (request.method === 'PUT' && sectionMatch) {
    try {
      const existing = getSection(sectionMatch[1]);
      if (!existing) return json(response, 404, { error:'Section not found.' });
      const section = cleanSection(await body(request), existing);
      validateSectionParent(section, existing);
      return json(response, 200, { section:updateSection(section) });
    } catch (error) { return json(response, 400, { error:error.message || 'The section could not be updated.' }); }
  }
  if (request.method === 'DELETE' && sectionMatch) {
    const existing = getSection(sectionMatch[1]);
    if (!existing) return json(response, 404, { error:'Section not found.' });
    const childCount = Number(db.prepare('SELECT COUNT(*) AS count FROM catalog_sections WHERE parent_id = ?').get(existing.id).count);
    const cardCount = Number(db.prepare('SELECT COUNT(*) AS count FROM cards WHERE section_id = ?').get(existing.id).count);
    if (childCount || cardCount) return json(response, 409, { error:childCount ? 'Move or remove this section’s tiles before deleting it.' : 'Move or remove the cards in this section before deleting it.' });
    db.prepare('DELETE FROM catalog_sections WHERE id = ?').run(existing.id);
    return json(response, 200, { ok:true });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/cards') return json(response, 200, { cards:readCards() });
  if (request.method === 'GET' && url.pathname === '/api/admin/files') return json(response, 200, { files:await pdfFiles() });
  if (request.method === 'POST' && url.pathname === '/api/admin/files') {
    try {
      const rawPdf = String(request.headers['content-type'] || '').toLowerCase().startsWith('application/pdf');
      const input = rawPdf ? null : await body(request, Math.ceil(maxPdfBytes * 1.4));
      const filename = safePdfFilename(rawPdf ? decodeURIComponent(String(request.headers['x-upload-filename'] || '')) : input.filename);
      const pdf = rawPdf ? await rawBody(request, maxPdfBytes) : decodePdfUpload(input.data);
      if (!pdf.length || pdf.length > maxPdfBytes || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Upload a valid PDF smaller than 25 MB.');
      const target = path.join(papersDir, filename); const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, pdf, { flag:'wx' }); await unlink(target).catch(() => {}); await rename(temporary, target);
      return json(response, 201, { file:filename });
    } catch (error) { return json(response, 400, { error:error.message || 'The PDF could not be uploaded.' }); }
  }
  const fileMatch = url.pathname.match(/^\/api\/admin\/files\/([^/]+)$/);
  if (request.method === 'DELETE' && fileMatch) {
    try { const filename = safePdfFilename(decodeURIComponent(fileMatch[1])); const references = db.prepare('SELECT COUNT(*) AS count FROM cards WHERE file_key = ?').get(filename).count; if (Number(references)) return json(response, 409, { error:'Update or remove the linked study card before deleting this PDF.' }); await unlink(path.join(papersDir, filename)); return json(response, 200, { ok:true }); } catch (error) { return json(response, 404, { error:'The PDF was not found.' }); }
  }
  const cardMatch = url.pathname.match(/^\/api\/admin\/cards\/([a-zA-Z0-9-]+)$/);
  if (request.method === 'POST' && url.pathname === '/api/admin/cards') { try { const card = insertCard(cleanCard(await body(request))); return json(response, 201, { card }); } catch (error) { return json(response, 400, { error:error.message }); } }
  if (request.method === 'PUT' && cardMatch) { try { const existing = getCard(cardMatch[1]); if (!existing) return json(response, 404, { error:'Card not found.' }); const card = updateCard(cleanCard(await body(request), existing)); return json(response, 200, { card }); } catch (error) { return json(response, 400, { error:error.message }); } }
  if (request.method === 'DELETE' && cardMatch) { const result = db.prepare('DELETE FROM cards WHERE id = ?').run(cardMatch[1]); if (!result.changes) return json(response, 404, { error:'Card not found.' }); return json(response, 200, { ok:true }); }
  if (request.method === 'PUT' && url.pathname === '/api/admin/import') {
    try {
      const input = await body(request);
      const source = Array.isArray(input) ? input : input.cards;
      const includesSections = !Array.isArray(input) && Object.prototype.hasOwnProperty.call(input, 'sections');
      const sectionSource = includesSections ? input.sections : null;
      if (!Array.isArray(source) || source.length > 5000 || (includesSections && (!Array.isArray(sectionSource) || sectionSource.length > 1000))) throw new Error('Invalid backup file.');
      const importedSections = includesSections ? sectionSource.map(item => {
        const id = String(item?.id || '').trim();
        if (!/^[A-Za-z0-9-]{1,120}$/.test(id)) throw new Error('A backup section has an invalid ID.');
        const section = cleanSection(item);
        section.id = id;
        return section;
      }) : [];
      if (new Set(importedSections.map(section => section.id)).size !== importedSections.length) throw new Error('Backup section IDs must be unique.');
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM cards');
        if (includesSections) {
          db.exec('DELETE FROM catalog_sections');
          const importedById = new Map(importedSections.map(section => [section.id, section]));
          for (const section of importedSections.filter(section => !section.parentId)) insertSection(section);
          for (const section of importedSections.filter(section => section.parentId)) {
            if (!importedById.has(section.parentId)) throw new Error('A backup tile refers to a missing parent section.');
            validateSectionParent(section);
            insertSection(section);
          }
        }
        const parsed = source.map(item => cleanCard(item));
        for (const card of parsed) insertCard(card);
        backfillLegacyCardSections();
        db.exec('COMMIT');
        return json(response, 200, { count:parsed.length, sectionCount:includesSections ? importedSections.length : readSections().length });
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } catch (error) { return json(response, 400, { error:error.message || 'The backup could not be imported.' }); }
  }
  return json(response, 404, { error:'Not found' });
}
function paperRouteHtml(paper) {
  const title = `${paper.title} | TK's SOLUTION`;
  const description = paper.description || 'Chapter-wise study material for focused revision.';
  const indexable = Boolean(paper.available) && siteUrl.startsWith('https://');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${indexable ? 'index,follow' : 'noindex,nofollow'}"><title>${escapeXml(title)}</title><meta name="description" content="${escapeXml(description)}"><link rel="canonical" href="${escapeXml(`${siteUrl}/paper/${paper.slug}`)}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/paper.css"></head><body><header><a class="brand" href="/index.html"><img src="/tk-solution-logo.png" alt="TK's SOLUTION logo" width="46" height="46">TK's <strong>SOLUTION</strong></a><a href="/library.html">Back to library</a></header><main><p class="eyebrow">Secure study material</p><div id="paper-detail" class="paper-detail" aria-live="polite"><div class="loading-block"></div><div class="loading-block short"></div></div></main><script src="/paper.js"></script></body></html>`;
}
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.png':'image/png', '.svg':'image/svg+xml', '.xml':'application/xml; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.json':'application/json; charset=utf-8' };
function sendStatic(request, response, content, contentType, cacheControl) {
  const etag = `"${createHash('sha1').update(content).digest('base64url')}"`;
  const headers = { ...securityHeaders(contentType), 'Cache-Control':cacheControl, ETag:etag, Vary:'Accept-Encoding' };
  if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); return response.end(); }
  const textLike = /^(text\/|application\/(javascript|json|xml))/.test(contentType);
  if (textLike && content.length > 700 && /\bgzip\b/.test(request.headers['accept-encoding'] || '')) { headers['Content-Encoding'] = 'gzip'; response.writeHead(200, headers); return response.end(gzipSync(content)); }
  response.writeHead(200, headers); response.end(content);
}
async function staticFile(request, response, url) {
  if (url.pathname === '/sitemap.xml') return sendStatic(request, response, Buffer.from(buildSitemap()), 'application/xml; charset=utf-8', 'no-cache');
  const paperMatch = url.pathname.match(/^\/paper\/([a-z0-9-]+)$/i);
  if (paperMatch) {
    const paper = findPaperBySlug(paperMatch[1]);
    if (!paper) return json(response, 404, { error:'Paper not found.' });
    return sendStatic(request, response, Buffer.from(paperRouteHtml(paper)), 'text/html; charset=utf-8', 'no-cache');
  }
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname); const file = path.resolve(publicDir, `.${pathname}`); if (!file.startsWith(`${publicDir}${path.sep}`)) return json(response, 403, { error:'Forbidden' }); const extension = path.extname(file).toLowerCase();
  try { const content = await readFile(file); return sendStatic(request, response, content, mime[extension] || 'application/octet-stream', extension === '.html' ? 'no-cache' : 'public, max-age=3600'); } catch { response.writeHead(404, securityHeaders('text/plain; charset=utf-8')); response.end('Not found'); }
}
const server = http.createServer(async (request, response) => { try { const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`); if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return await api(request, response, url); return await staticFile(request, response, url); } catch { if (!response.headersSent) json(response, 500, { error:'Server error' }); else response.end(); } });
server.listen(port, () => console.log(`TK's SOLUTION running at http://127.0.0.1:${port}`));
