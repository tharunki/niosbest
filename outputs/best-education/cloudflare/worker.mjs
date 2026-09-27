const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_DURATION_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
const MAX_CHECKOUT_ATTEMPTS = 12;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['sample', 'pyq', 'mcq', 'important']);
const ALLOWED_CLASSES = new Set(['10', '11', '12']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const scienceLessons = [
  'Chemical Reactions and Equations', 'Acids, Bases and Salts', 'Metals and Non-metals',
  'Carbon and its Compounds', 'Life Processes', 'Control and Coordination',
  'How Do Organisms Reproduce?', 'Heredity', 'Light: Reflection and Refraction',
  'The Human Eye and the Colourful World', 'Electricity', 'Magnetic Effects of Electric Current',
  'Our Environment', 'Sustainable Management of Natural Resources'
];

const libraryPages = new Set(['/sample-papers.html', '/pyqs.html', '/mcqs.html', '/important-questions.html']);

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' https://checkout.razorpay.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.razorpay.com; frame-src https://api.razorpay.com https://checkout.razorpay.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...securityHeaders(contentType), 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function escapeXml(value = '') {
  return String(value).replace(/[<>&'"]/g, (character) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  })[character]);
}

function slugify(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 110) || 'study-material';
}

function limitUtf8(value, maxBytes) {
  let output = '';
  let size = 0;
  for (const character of String(value)) {
    const characterSize = encoder.encode(character).byteLength;
    if (size + characterSize > maxBytes) break;
    output += character;
    size += characterSize;
  }
  return output;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return encoder.encode(String(value));
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64UrlEncode(value) {
  return bytesToBase64(toBytes(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(value)));
}

async function sha256Hex(value) {
  return [...await sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(value, secret, output = 'hex') {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, toBytes(value)));
  return output === 'base64url'
    ? bytesToBase64(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    : [...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function secureEqual(left, right) {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
  }));
}

function validSameOrigin(request) {
  const origin = request.headers.get('Origin');
  return !origin || origin === new URL(request.url).origin;
}

async function readJson(request, maxBytes = 1_000_000) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('Request too large');
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new Error('Request too large');
  return bytes.byteLength ? JSON.parse(decoder.decode(bytes)) : {};
}

function rowToCard(row) {
  return {
    id: row.id,
    type: row.type,
    className: row.class_name,
    subject: row.subject,
    title: row.title,
    description: row.description,
    price: String(row.price),
    link: row.link,
    fileKey: row.file_key,
    isBundle: Boolean(row.is_bundle),
    slug: row.slug,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicCard(card) {
  const { fileKey, ...safe } = card;
  return { ...safe, available: Boolean(fileKey) };
}

async function readCards(env) {
  const result = await env.DB.prepare('SELECT * FROM cards ORDER BY updated_at DESC LIMIT 5000').all();
  return (result.results || []).map(rowToCard);
}

async function getCard(env, id) {
  const row = await env.DB.prepare('SELECT * FROM cards WHERE id = ?').bind(id).first();
  return row ? rowToCard(row) : null;
}

async function getCardBySlug(env, slug) {
  const row = await env.DB.prepare('SELECT * FROM cards WHERE slug = ?').bind(slug).first();
  return row ? rowToCard(row) : null;
}

async function slugAvailable(env, slug, existingId) {
  const row = await env.DB.prepare('SELECT id FROM cards WHERE slug = ?').bind(slug).first();
  return !row || row.id === existingId;
}

async function uniqueSlug(env, value, existingId) {
  const base = slugify(value);
  let candidate = base;
  let attempt = 2;
  while (!(await slugAvailable(env, candidate, existingId))) candidate = `${base}-${attempt++}`;
  return candidate;
}

function safePdfFilename(value) {
  const filename = String(value || '').trim();
  if (!filename || filename.length > 180 || !/^[a-z0-9][a-z0-9._ ()-]*\.pdf$/i.test(filename)) {
    throw new Error('Choose a valid PDF filename.');
  }
  return filename;
}

async function cleanCard(env, input, existing = null) {
  const type = String(input.type || '');
  const className = String(input.className || '');
  const subject = String(input.subject || '').trim().slice(0, 80);
  const title = String(input.title || '').trim().slice(0, 140);
  const description = String(input.description || '').trim().slice(0, 500);
  const price = Math.round(Number(input.price));
  let link = String(input.link || '').trim();
  let fileKey = String(input.fileKey || '').trim();
  const isBundle = input.isBundle === true || input.isBundle === 'true' || input.isBundle === 1 || input.isBundle === '1';
  if (!ALLOWED_TYPES.has(type) || !ALLOWED_CLASSES.has(className) || !subject || !title || !Number.isFinite(price) || price < 1 || price > 9999) {
    throw new Error('Invalid card details.');
  }
  if (link) {
    const url = new URL(link);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid preview link.');
    link = url.href;
  }
  if (fileKey) {
    fileKey = safePdfFilename(fileKey);
    if (!await env.PAPERS.head(fileKey)) throw new Error('Upload the selected PDF before linking it to a card.');
  }
  const id = existing?.id || crypto.randomUUID();
  const slug = await uniqueSlug(env, input.slug || `${type}-class-${className}-${subject}-${title}`, id);
  const now = new Date().toISOString();
  return {
    id, type, className, subject, title, description, price: String(price), link, fileKey, isBundle, slug,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function uniqueSlugFromSet(value, usedSlugs) {
  const base = slugify(value);
  let candidate = base;
  let attempt = 2;
  while (usedSlugs.has(candidate)) candidate = `${base.slice(0, 104)}-${attempt++}`;
  usedSlugs.add(candidate);
  return candidate;
}

function importTimestamp(value, fallback) {
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function cleanImportedCard(input, usedSlugs, pdfFiles) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The backup contains an invalid card.');
  const type = String(input.type || '');
  const className = String(input.className || '');
  const subject = String(input.subject || '').trim().slice(0, 80);
  const title = String(input.title || '').trim().slice(0, 140);
  const description = String(input.description || '').trim().slice(0, 500);
  const price = Math.round(Number(input.price));
  let link = String(input.link || '').trim();
  let fileKey = String(input.fileKey || '').trim();
  const isBundle = input.isBundle === true || input.isBundle === 'true' || input.isBundle === 1 || input.isBundle === '1';
  if (!ALLOWED_TYPES.has(type) || !ALLOWED_CLASSES.has(className) || !subject || !title || !Number.isFinite(price) || price < 1 || price > 9999) {
    throw new Error('The backup contains invalid card details.');
  }
  if (link) {
    const url = new URL(link);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('The backup contains an invalid preview link.');
    link = url.href;
  }
  if (fileKey) {
    fileKey = safePdfFilename(fileKey);
    if (!pdfFiles.has(fileKey)) throw new Error(`Upload ${fileKey} before importing a card that uses it.`);
  }
  const now = new Date().toISOString();
  return {
    id: UUID_PATTERN.test(String(input.id || '')) ? String(input.id) : crypto.randomUUID(),
    type,
    className,
    subject,
    title,
    description,
    price: String(price),
    link,
    fileKey,
    isBundle,
    slug: uniqueSlugFromSet(input.slug || `${type}-class-${className}-${subject}-${title}`, usedSlugs),
    createdAt: importTimestamp(input.createdAt, now),
    updatedAt: now
  };
}

function cardInsertStatement(env, card) {
  return env.DB.prepare('INSERT INTO cards (id,type,class_name,subject,title,description,price,link,file_key,is_bundle,slug,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(card.id, card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey, Number(card.isBundle), card.slug, card.createdAt, card.updatedAt);
}

async function insertCard(env, card) {
  await cardInsertStatement(env, card).run();
  return card;
}

async function updateCard(env, card) {
  await env.DB.prepare('UPDATE cards SET type=?,class_name=?,subject=?,title=?,description=?,price=?,link=?,file_key=?,is_bundle=?,slug=?,updated_at=? WHERE id=?')
    .bind(card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey, Number(card.isBundle), card.slug, card.updatedAt, card.id).run();
  return card;
}

function seedPapers() {
  return [...ALLOWED_TYPES].flatMap((type) => scienceLessons.map((title, index) => ({
    id: `${type}-class-10-science-chapter-${index + 1}`,
    slug: `${type}-class-10-science-${slugify(title)}`,
    type,
    className: '10',
    subject: 'Science',
    title,
    description: 'Chapter-wise practice material',
    price: '39',
    updatedAt: '2026-09-24T00:00:00.000Z',
    available: false
  })));
}

async function allPapers(env) {
  const cards = (await readCards(env)).map(publicCard);
  const cardSlugs = new Set(cards.map((card) => card.slug));
  return [...cards, ...seedPapers().filter((paper) => !cardSlugs.has(paper.slug))];
}

function cardFilterStatement(env, searchParams, limit = 100) {
  const className = String(searchParams.get('class') || '');
  const subject = String(searchParams.get('subject') || '').trim();
  const type = String(searchParams.get('type') || '');
  const clauses = [];
  const bindings = [];
  if (ALLOWED_CLASSES.has(className)) { clauses.push('class_name = ?'); bindings.push(className); }
  if (subject) { clauses.push('LOWER(subject) = ?'); bindings.push(subject.toLowerCase()); }
  if (ALLOWED_TYPES.has(type)) { clauses.push('type = ?'); bindings.push(type); }
  const statement = env.DB.prepare(`SELECT * FROM cards${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ${limit}`);
  return bindings.length ? statement.bind(...bindings) : statement;
}

async function filteredCards(env, searchParams, limit = 100) {
  const result = await cardFilterStatement(env, searchParams, limit).all();
  return (result.results || []).map(rowToCard);
}

function matchesPaper(paper, { query, className, subject, type }) {
  const haystack = `${paper.className} ${paper.subject} ${paper.type} ${paper.title} ${paper.description}`.toLowerCase();
  return (!className || paper.className === className)
    && (!subject || paper.subject.toLowerCase() === subject.toLowerCase())
    && (!type || paper.type === type)
    && (!query || haystack.includes(query));
}

async function filterPapers(env, searchParams) {
  const query = limitUtf8(String(searchParams.get('q') || '').trim().toLowerCase(), 100);
  const className = String(searchParams.get('class') || '');
  const subject = String(searchParams.get('subject') || '').trim();
  const type = String(searchParams.get('type') || '');
  const clauses = [];
  const bindings = [];
  if (ALLOWED_CLASSES.has(className)) { clauses.push('class_name = ?'); bindings.push(className); }
  if (subject) { clauses.push('LOWER(subject) = ?'); bindings.push(subject.toLowerCase()); }
  if (ALLOWED_TYPES.has(type)) { clauses.push('type = ?'); bindings.push(type); }
  if (query) {
    clauses.push("instr(LOWER(class_name || ' ' || subject || ' ' || type || ' ' || title || ' ' || description), ?) > 0");
    bindings.push(query);
  }
  const statement = env.DB.prepare(`SELECT * FROM cards${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT 100`);
  const boundStatement = bindings.length ? statement.bind(...bindings) : statement;
  const custom = ((await boundStatement.all()).results || []).map(rowToCard).map(publicCard);
  const customSlugs = new Set(custom.map((paper) => paper.slug));
  const filters = { query, className, subject, type };
  const seeds = seedPapers().filter((paper) => !customSlugs.has(paper.slug) && matchesPaper(paper, filters));
  return [...custom, ...seeds].slice(0, 100);
}

async function findPaperBySlug(env, slug) {
  const card = await getCardBySlug(env, slug);
  if (card) return publicCard(card);
  return seedPapers().find((paper) => paper.slug === slug) || null;
}

async function signedDownloadToken(env, card) {
  const payload = base64UrlEncode(JSON.stringify({ cardId: card.id, fileKey: card.fileKey, exp: Date.now() + DOWNLOAD_DURATION_MS }));
  const signature = await hmac(payload, env.DOWNLOAD_TOKEN_SECRET, 'base64url');
  return `${payload}.${signature}`;
}

async function readDownloadToken(env, token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = await hmac(payload, env.DOWNLOAD_TOKEN_SECRET, 'base64url');
  if (!(await secureEqual(signature, expected))) return null;
  try {
    const data = JSON.parse(decoder.decode(base64UrlDecode(payload)));
    return Number(data.exp) > Date.now() && data.cardId && data.fileKey ? data : null;
  } catch {
    return null;
  }
}

async function secureDownload(request, env, token) {
  if (!env.DOWNLOAD_TOKEN_SECRET || String(env.DOWNLOAD_TOKEN_SECRET).length < 32) {
    return json({ error: 'Secure downloads are not configured yet.' }, 503);
  }
  const data = await readDownloadToken(env, token);
  if (!data) return json({ error: 'This download link is invalid or has expired.' }, 403);
  let filename;
  try { filename = safePdfFilename(data.fileKey); } catch { return json({ error: 'This download link is invalid.' }, 403); }
  const card = await getCard(env, data.cardId);
  if (!card || card.fileKey !== filename) return json({ error: 'This download link is no longer available.' }, 403);
  const object = await env.PAPERS.get(filename);
  if (!object) return json({ error: 'The protected PDF file was not found.' }, 404);
  const headers = new Headers(securityHeaders('application/pdf'));
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Length', String(object.size));
  object.writeHttpMetadata(headers);
  return new Response(object.body, { status: 200, headers });
}

async function getOrder(env, id) {
  return env.DB.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').bind(id).first();
}

async function saveOrder(env, { orderId, cardId, amount, currency, recoveryTokenHash, status = 'created', paymentId = null, expiresAt, recoveryExpiresAt, fulfilledAt = null }) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO orders (razorpay_order_id,card_id,amount,currency,status,razorpay_payment_id,recovery_token_hash,created_at,updated_at,expires_at,recovery_expires_at,fulfilled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(razorpay_order_id) DO UPDATE SET status=excluded.status, razorpay_payment_id=COALESCE(excluded.razorpay_payment_id,orders.razorpay_payment_id), updated_at=excluded.updated_at, fulfilled_at=COALESCE(excluded.fulfilled_at,orders.fulfilled_at)`)
    .bind(orderId, cardId, amount, currency, status, paymentId, recoveryTokenHash, now, now, expiresAt, recoveryExpiresAt, fulfilledAt).run();
}

async function updateOrderStatus(env, orderId, status, paymentId = null, fulfilled = false) {
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE orders SET status=?, razorpay_payment_id=COALESCE(?, razorpay_payment_id), updated_at=?, fulfilled_at=CASE WHEN ? THEN ? ELSE fulfilled_at END WHERE razorpay_order_id=?')
    .bind(status, paymentId, now, Number(fulfilled), now, orderId).run();
}

async function hasActivePaidDownload(env, cardId) {
  const cutoff = new Date(Date.now() - DOWNLOAD_DURATION_MS).toISOString();
  // A webhook can confirm payment before the browser exchanges it for a link.
  // Keep the card immutable for that recovery window plus the 24-hour link window.
  const result = await env.DB.prepare("SELECT 1 AS active FROM orders WHERE card_id = ? AND status IN ('captured','fulfilled') AND recovery_expires_at >= ? LIMIT 1").bind(cardId, cutoff).first();
  return Boolean(result?.active);
}

async function hasAnyActivePaidDownloads(env) {
  const cutoff = new Date(Date.now() - DOWNLOAD_DURATION_MS).toISOString();
  const result = await env.DB.prepare("SELECT 1 AS active FROM orders WHERE status IN ('captured','fulfilled') AND recovery_expires_at >= ? LIMIT 1").bind(cutoff).first();
  return Boolean(result?.active);
}

async function hasActivePaidDownloadForFile(env, filename) {
  const cutoff = new Date(Date.now() - DOWNLOAD_DURATION_MS).toISOString();
  const result = await env.DB.prepare(`SELECT 1 AS active
    FROM orders INNER JOIN cards ON cards.id = orders.card_id
    WHERE cards.file_key = ? AND orders.status IN ('captured','fulfilled') AND orders.recovery_expires_at >= ?
    LIMIT 1`).bind(filename, cutoff).first();
  return Boolean(result?.active);
}

async function ensureFileCanChange(env, filename) {
  if (await hasActivePaidDownloadForFile(env, filename)) {
    throw new Error('This PDF has a paid purchase that may still be downloaded. Keep its content unchanged until the access window expires (up to 48 hours).');
  }
}

function razorpayAuthorization(env) {
  return `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`;
}

async function razorpayPayment(env, order, paymentId) {
  const upstream = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: razorpayAuthorization(env) }
  });
  const payment = await upstream.json().catch(() => ({}));
  if (!upstream.ok || payment.order_id !== order.razorpay_order_id || Number(payment.amount) !== Number(order.amount) || payment.currency !== order.currency) {
    throw new Error('Payment details could not be confirmed.');
  }
  if (payment.status !== 'captured') throw new Error('Payment is still being processed. Please wait a moment and try again.');
  return payment;
}

async function paymentWebhook(request, env) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return json({ error: 'Webhook endpoint is not configured.' }, 404);
  try {
    const raw = await request.arrayBuffer();
    if (raw.byteLength > 1_000_000) return json({ error: 'Webhook payload is too large.' }, 413);
    const signature = request.headers.get('X-Razorpay-Signature') || '';
    const expected = await hmac(new Uint8Array(raw), env.RAZORPAY_WEBHOOK_SECRET);
    if (!(await secureEqual(signature, expected))) return json({ error: 'Invalid webhook signature.' }, 400);
    const event = JSON.parse(decoder.decode(raw));
    const payment = event?.payload?.payment?.entity;
    if (!payment?.order_id) return json({ ok: true });
    const order = await getOrder(env, payment.order_id);
    if (!order) return json({ ok: true });
    if (event.event === 'payment.captured' && payment.status === 'captured' && order.status !== 'fulfilled') {
      await updateOrderStatus(env, payment.order_id, 'captured', payment.id);
    }
    if (event.event === 'payment.failed') await updateOrderStatus(env, payment.order_id, 'failed', payment.id);
    return json({ ok: true });
  } catch {
    return json({ error: 'Invalid webhook payload.' }, 400);
  }
}

async function authenticated(request, env) {
  const token = parseCookies(request).admin_session;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).first();
  if (!session || Number(session.expires_at) < Date.now()) {
    if (session) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return false;
  }
  await env.DB.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?').bind(Date.now() + SESSION_DURATION_MS, tokenHash).run();
  return true;
}

async function loginAllowed(request, env) {
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown');
  const attempt = await env.DB.prepare('SELECT count, window_started_at FROM login_attempts WHERE client_hash = ?').bind(ipHash).first();
  return !attempt || Date.now() - Number(attempt.window_started_at) >= LOGIN_WINDOW_MS || Number(attempt.count) < MAX_LOGIN_ATTEMPTS;
}

async function recordFailedLogin(request, env) {
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO login_attempts (client_hash,count,window_started_at) VALUES (?,?,?)
    ON CONFLICT(client_hash) DO UPDATE SET count=CASE WHEN login_attempts.window_started_at < ? THEN 1 ELSE login_attempts.count + 1 END,
    window_started_at=CASE WHEN login_attempts.window_started_at < ? THEN ? ELSE login_attempts.window_started_at END`)
    .bind(ipHash, 1, now, now - LOGIN_WINDOW_MS, now - LOGIN_WINDOW_MS, now).run();
}

async function clearLoginAttempts(request, env) {
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown');
  await env.DB.prepare('DELETE FROM login_attempts WHERE client_hash = ?').bind(ipHash).run();
}

async function checkoutAllowed(request, env) {
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown');
  const attempt = await env.DB.prepare('SELECT count, window_started_at FROM checkout_attempts WHERE client_hash = ?').bind(ipHash).first();
  return !attempt || Date.now() - Number(attempt.window_started_at) >= CHECKOUT_WINDOW_MS || Number(attempt.count) < MAX_CHECKOUT_ATTEMPTS;
}

async function recordCheckoutAttempt(request, env) {
  const ipHash = await sha256Hex(request.headers.get('CF-Connecting-IP') || 'unknown');
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO checkout_attempts (client_hash,count,window_started_at) VALUES (?,?,?)
    ON CONFLICT(client_hash) DO UPDATE SET count=CASE WHEN checkout_attempts.window_started_at < ? THEN 1 ELSE checkout_attempts.count + 1 END,
    window_started_at=CASE WHEN checkout_attempts.window_started_at < ? THEN ? ELSE checkout_attempts.window_started_at END`)
    .bind(ipHash, 1, now, now - CHECKOUT_WINDOW_MS, now - CHECKOUT_WINDOW_MS, now).run();
}

function adminCookie(token, maxAge, secure) {
  return `admin_session=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

async function listPdfFiles(env) {
  const files = [];
  let cursor;
  do {
    const page = await env.PAPERS.list({ cursor, limit: 1000 });
    files.push(...page.objects.filter((object) => /\.pdf$/i.test(object.key)).map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files.sort((left, right) => left.localeCompare(right));
}

function decodePdfUpload(input) {
  const source = String(input || '');
  const marker = /^data:application\/pdf(?:;charset=[^;,]+)?;base64,/i;
  if (!marker.test(source)) throw new Error('Choose a valid PDF file.');
  const base64 = source.replace(marker, '').replace(/\s/g, '');
  if (!base64 || !/^[A-Za-z0-9+/=]+$/.test(base64) || Math.floor(base64.length * 3 / 4) > MAX_PDF_BYTES) {
    throw new Error('Upload a PDF smaller than 25 MB.');
  }
  const binary = atob(base64);
  const pdf = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) pdf[index] = binary.charCodeAt(index);
  if (!pdf.length || pdf.length > MAX_PDF_BYTES || decoder.decode(pdf.subarray(0, 5)) !== '%PDF-') {
    throw new Error('Upload a valid PDF smaller than 25 MB.');
  }
  return pdf;
}

function pdfUploadStream(stream) {
  let totalBytes = 0;
  let prefix = new Uint8Array(0);
  return stream.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PDF_BYTES) {
        controller.error(new Error('Upload a PDF smaller than 25 MB.'));
        return;
      }
      if (prefix.length < 5) {
        const needed = Math.min(5 - prefix.length, bytes.length);
        const next = new Uint8Array(prefix.length + needed);
        next.set(prefix);
        next.set(bytes.subarray(0, needed), prefix.length);
        prefix = next;
        if (prefix.length === 5 && decoder.decode(prefix) !== '%PDF-') {
          controller.error(new Error('Upload a valid PDF file.'));
          return;
        }
      }
      controller.enqueue(bytes);
    },
    flush(controller) {
      if (totalBytes < 5 || decoder.decode(prefix) !== '%PDF-') controller.error(new Error('Upload a valid PDF file.'));
    }
  }));
}

function isWorkersDev(url) {
  return new URL(url).hostname.endsWith('.workers.dev');
}

async function renderLibraryPage(request, env, url) {
  const response = await env.ASSETS.fetch(request);
  if (!isWorkersDev(request.url)) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function renderSitemap(request, env) {
  const origin = new URL(request.url).origin;
  const pages = ['/', '/sample-papers.html', '/pyqs.html', '/mcqs.html', '/important-questions.html'];
  const fixed = pages.map((page) => `  <url><loc>${escapeXml(`${origin}${page}`)}</loc></url>`);
  const cards = (await readCards(env)).filter((card) => card.fileKey);
  const cardUrls = cards.map((card) => `  <url><loc>${escapeXml(`${origin}/paper/${card.slug}`)}</loc><lastmod>${card.updatedAt.slice(0, 10)}</lastmod></url>`);
  return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...fixed, ...cardUrls].join('\n')}\n</urlset>\n`, 200, 'application/xml; charset=utf-8');
}

function renderRobots(request) {
  const origin = new URL(request.url).origin;
  const content = isWorkersDev(request.url)
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: /admin.html\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;
  return text(content, 200, 'text/plain; charset=utf-8');
}

function paperPageHtml(request, paper) {
  const origin = new URL(request.url).origin;
  const title = `${paper.title} | Best Education`;
  const description = paper.description || 'Chapter-wise study material for focused revision.';
  const indexable = paper.available && !isWorkersDev(request.url);
  const productSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'LearningResource',
    name: paper.title,
    description,
    educationalLevel: `Class ${paper.className}`,
    learningResourceType: paper.type,
    provider: { '@type': 'EducationalOrganization', name: 'Best Education' },
    offers: { '@type': 'Offer', price: paper.price, priceCurrency: 'INR', availability: paper.available ? 'https://schema.org/InStock' : 'https://schema.org/PreOrder', url: `${origin}/paper/${paper.slug}` }
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${indexable ? 'index,follow' : 'noindex,nofollow'}"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="canonical" href="${escapeHtml(`${origin}/paper/${paper.slug}`)}"><meta property="og:type" content="product"><meta property="og:site_name" content="Best Education"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(`${origin}/paper/${paper.slug}`)}"><meta property="og:image" content="${escapeHtml(`${origin}/logo.png`)}"><meta name="twitter:card" content="summary_large_image"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/paper.css"><script type="application/ld+json">${productSchema}</script></head><body><header><a class="brand" href="/index.html"><img src="/logo.png" alt="Best Education logo" width="46" height="46">Best <strong>Education</strong></a><a href="/index.html">Back to library</a></header><main><p class="eyebrow">Secure study material</p><div id="paper-detail" class="paper-detail" aria-live="polite"><div class="loading-block"></div><div class="loading-block short"></div></div></main><script src="/paper.js"></script></body></html>`;
}

async function renderPaperPage(request, env, slug) {
  const paper = await findPaperBySlug(env, slug);
  if (!paper) return text('Not found', 404);
  return text(paperPageHtml(request, paper), 200, 'text/html; charset=utf-8');
}

async function api(request, env, url) {
  if (request.method === 'POST' && url.pathname === '/api/payment/webhook') return paymentWebhook(request, env);
  if (!validSameOrigin(request)) return json({ error: 'Invalid origin.' }, 403);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    await env.DB.prepare('SELECT 1').first();
    return json({ ok: true, platform: 'cloudflare' });
  }
  if (request.method === 'GET' && url.pathname === '/api/cards') return json({ cards: (await filteredCards(env, url.searchParams)).map(publicCard) });
  if (request.method === 'GET' && url.pathname === '/api/papers') return json({ papers: await filterPapers(env, url.searchParams) });
  const slugMatch = url.pathname.match(/^\/api\/papers\/slug\/([a-z0-9-]+)$/i);
  if (request.method === 'GET' && slugMatch) {
    const paper = await findPaperBySlug(env, slugMatch[1]);
    return paper ? json({ paper }) : json({ error: 'Paper not found.' }, 404);
  }
  const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
  if (request.method === 'GET' && downloadMatch) return secureDownload(request, env, downloadMatch[1]);
  if (request.method === 'GET' && url.pathname === '/api/admin/session') return json({ authenticated: await authenticated(request, env) });
  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 12) return json({ error: 'Admin authentication is not configured yet.' }, 503);
    if (!(await loginAllowed(request, env))) return json({ error: 'Too many attempts. Try again later.' }, 429);
    const input = await readJson(request).catch(() => ({}));
    if (!(await secureEqual(input.password || '', env.ADMIN_PASSWORD))) {
      await recordFailedLogin(request, env);
      return json({ error: 'Incorrect password.' }, 401);
    }
    await clearLoginAttempts(request, env);
    const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare('INSERT INTO admin_sessions (token_hash,expires_at,created_at) VALUES (?,?,?)').bind(tokenHash, Date.now() + SESSION_DURATION_MS, new Date().toISOString()).run();
    return json({ ok: true }, 200, { 'Set-Cookie': adminCookie(token, SESSION_DURATION_MS / 1000, url.protocol === 'https:') });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = parseCookies(request).admin_session;
    if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': adminCookie('', 0, url.protocol === 'https:') });
  }
  const checkoutMatch = url.pathname.match(/^\/api\/checkout\/([a-z0-9-]+)$/i);
  if (request.method === 'POST' && checkoutMatch) {
    const card = await getCardBySlug(env, checkoutMatch[1]);
    if (!card?.fileKey || !await env.PAPERS.head(card.fileKey)) return json({ error: 'This paper is not ready for secure purchase yet.' }, 404);
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return json({ error: 'Secure payments are not configured yet. The administrator must add Razorpay credentials.' }, 503);
    if (!await checkoutAllowed(request, env)) return json({ error: 'Too many checkout attempts from this connection. Please wait 10 minutes and try again.' }, 429);
    await recordCheckoutAttempt(request, env);
    const receipt = `best_${crypto.randomUUID().replace(/-/g, '').slice(0, 30)}`;
    const upstream = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: razorpayAuthorization(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Number(card.price) * 100, currency: 'INR', receipt, notes: { card_id: card.id, slug: card.slug } })
    });
    const order = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !order.id) return json({ error: 'The payment service could not create an order. Please try again.' }, 502);
    const recoveryToken = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const recoveryExpiresAt = new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString();
    await saveOrder(env, { orderId: order.id, cardId: card.id, amount: Number(order.amount), currency: order.currency || 'INR', recoveryTokenHash: await sha256Hex(recoveryToken), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), recoveryExpiresAt });
    return json({ key: env.RAZORPAY_KEY_ID, order: { id: order.id, amount: order.amount, currency: order.currency }, recovery: { token: recoveryToken, expiresAt: recoveryExpiresAt }, paper: publicCard(card) });
  }
  if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
    try {
      if (!env.RAZORPAY_KEY_SECRET || !env.DOWNLOAD_TOKEN_SECRET) throw new Error('Secure payments are not configured yet.');
      const input = await readJson(request);
      const order = await getOrder(env, input.razorpay_order_id);
      const expected = await hmac(`${input.razorpay_order_id}|${input.razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
      if (!order || (order.razorpay_payment_id && order.razorpay_payment_id !== input.razorpay_payment_id) || new Date(order.expires_at).getTime() < Date.now() || !(await secureEqual(input.razorpay_signature || '', expected))) throw new Error('Payment verification failed.');
      const card = await getCard(env, order.card_id);
      if (!card?.fileKey) throw new Error('The requested PDF is unavailable.');
      const payment = await razorpayPayment(env, order, input.razorpay_payment_id);
      await updateOrderStatus(env, order.razorpay_order_id, 'fulfilled', payment.id, true);
      return json({ ok: true, downloadUrl: `/api/download/${await signedDownloadToken(env, card)}`, expiresAt: new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString() });
    } catch (error) {
      return json({ error: error.message || 'Payment verification failed.' }, 400);
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/payment/recover') {
    try {
      if (!env.RAZORPAY_KEY_SECRET || !env.DOWNLOAD_TOKEN_SECRET) throw new Error('Secure payments are not configured yet.');
      const input = await readJson(request);
      const orderId = String(input.orderId || '');
      const recoveryToken = String(input.recoveryToken || '');
      if (!orderId || !/^[A-Za-z0-9_-]{43}$/.test(recoveryToken)) throw new Error('This purchase recovery request is invalid.');
      const order = await env.DB.prepare('SELECT * FROM orders WHERE razorpay_order_id = ? AND recovery_token_hash = ?').bind(orderId, await sha256Hex(recoveryToken)).first();
      if (!order || new Date(order.recovery_expires_at).getTime() < Date.now()) throw new Error('This purchase recovery link has expired. Please contact Best Education with your payment details.');
      if (order.status === 'failed') throw new Error('This payment was not completed.');
      if (!order.razorpay_payment_id) return json({ pending: true, message: 'Payment confirmation is still arriving. Please check again in a minute.' }, 202);
      const card = await getCard(env, order.card_id);
      if (!card?.fileKey) throw new Error('The requested PDF is unavailable.');
      const payment = await razorpayPayment(env, order, order.razorpay_payment_id);
      await updateOrderStatus(env, order.razorpay_order_id, 'fulfilled', payment.id, true);
      return json({ ok: true, downloadUrl: `/api/download/${await signedDownloadToken(env, card)}`, expiresAt: new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString() });
    } catch (error) {
      return json({ error: error.message || 'Purchase recovery failed.' }, 400);
    }
  }
  if (!(await authenticated(request, env))) return json({ error: 'Sign in required.' }, 401);
  if (request.method === 'GET' && url.pathname === '/api/admin/cards') return json({ cards: await readCards(env) });
  if (request.method === 'GET' && url.pathname === '/api/admin/files') return json({ files: await listPdfFiles(env) });
  if (request.method === 'POST' && url.pathname === '/api/admin/files') {
    try {
      const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
      if (contentType.startsWith('application/pdf')) {
        const filename = safePdfFilename(decodeURIComponent(request.headers.get('X-Upload-Filename') || ''));
        const declaredSize = Number(request.headers.get('Content-Length') || 0);
        if (Number.isFinite(declaredSize) && declaredSize > MAX_PDF_BYTES) throw new Error('Upload a PDF smaller than 25 MB.');
        if (!request.body) throw new Error('Choose a valid PDF file.');
        await ensureFileCanChange(env, filename);
        await env.PAPERS.put(filename, pdfUploadStream(request.body), { httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${filename}"` } });
        return json({ file: filename }, 201);
      }
      const input = await readJson(request, Math.ceil(MAX_PDF_BYTES * 1.4));
      const filename = safePdfFilename(input.filename);
      const pdf = decodePdfUpload(input.data);
      await ensureFileCanChange(env, filename);
      await env.PAPERS.put(filename, pdf, { httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${filename}"` } });
      return json({ file: filename }, 201);
    } catch (error) {
      return json({ error: error.message || 'The PDF could not be uploaded.' }, 400);
    }
  }
  const fileMatch = url.pathname.match(/^\/api\/admin\/files\/([^/]+)$/);
  if (request.method === 'DELETE' && fileMatch) {
    try {
      const filename = safePdfFilename(decodeURIComponent(fileMatch[1]));
      const references = await env.DB.prepare('SELECT COUNT(*) AS count FROM cards WHERE file_key = ?').bind(filename).first();
      if (Number(references?.count)) return json({ error: 'Update or remove the linked study card before deleting this PDF.' }, 409);
      const existing = await env.PAPERS.head(filename);
      if (!existing) return json({ error: 'The PDF was not found.' }, 404);
      await env.PAPERS.delete(filename);
      return json({ ok: true });
    } catch (error) {
      return json({ error: error.message || 'The PDF could not be deleted.' }, 400);
    }
  }
  const cardMatch = url.pathname.match(/^\/api\/admin\/cards\/([a-zA-Z0-9-]+)$/);
  if (request.method === 'POST' && url.pathname === '/api/admin/cards') {
    try {
      const card = await insertCard(env, await cleanCard(env, await readJson(request)));
      return json({ card }, 201);
    }
    catch (error) { return json({ error: error.message || 'The study card could not be saved.' }, 400); }
  }
  if (request.method === 'PUT' && cardMatch) {
    try {
      const existing = await getCard(env, cardMatch[1]);
      if (!existing) return json({ error: 'Card not found.' }, 404);
      const card = await cleanCard(env, await readJson(request), existing);
      if (card.fileKey !== existing.fileKey && await hasActivePaidDownload(env, existing.id)) {
        return json({ error: 'Keep this PDF linked until the last paid download link has expired (up to 24 hours).' }, 409);
      }
      return json({ card: await updateCard(env, card) });
    } catch (error) { return json({ error: error.message || 'The study card could not be updated.' }, 400); }
  }
  if (request.method === 'DELETE' && cardMatch) {
    if (await hasActivePaidDownload(env, cardMatch[1])) return json({ error: 'This card has a paid download link that can remain active for up to 24 hours.' }, 409);
    const result = await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardMatch[1]).run();
    return Number(result.meta?.changes) ? json({ ok: true }) : json({ error: 'Card not found.' }, 404);
  }
  if (request.method === 'PUT' && url.pathname === '/api/admin/import') {
    try {
      const input = await readJson(request, 2_000_000);
      const source = Array.isArray(input) ? input : input.cards;
      if (!Array.isArray(source) || source.length > 500) throw new Error('Choose a valid backup with no more than 500 cards.');
      if (await hasAnyActivePaidDownloads(env)) throw new Error('Wait until active paid download links expire before importing a full card backup.');
      const pdfFiles = new Set(await listPdfFiles(env));
      const usedSlugs = new Set();
      const parsed = [];
      for (const item of source) {
        parsed.push(cleanImportedCard(item, usedSlugs, pdfFiles));
      }
      if (new Set(parsed.map((card) => card.id)).size !== parsed.length) throw new Error('The backup contains duplicate card IDs.');
      await env.DB.batch([env.DB.prepare('DELETE FROM cards'), ...parsed.map((card) => cardInsertStatement(env, card))]);
      return json({ count: parsed.length });
    } catch (error) { return json({ error: error.message || 'The backup could not be imported.' }, 400); }
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return await api(request, env, url);
      if (url.pathname === '/sitemap.xml') return await renderSitemap(request, env);
      if (url.pathname === '/robots.txt') return renderRobots(request);
      const paperMatch = url.pathname.match(/^\/paper\/([a-z0-9-]+)$/i);
      if (paperMatch) return await renderPaperPage(request, env, paperMatch[1]);
      if (libraryPages.has(url.pathname)) return await renderLibraryPage(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('Best Education Worker error', error);
      return json({ error: 'The service could not complete that request. Please try again.' }, 500);
    }
  }
};
