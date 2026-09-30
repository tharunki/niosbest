const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_DURATION_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const CHECKOUT_WINDOW_MS = 10 * 60 * 1000;
const MAX_CHECKOUT_ATTEMPTS = 12;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_JSON_BYTES = 1_000_000;
const MAX_WEBHOOK_BYTES = 1_000_000;
const MAX_BULK_UPLOAD_BYTES = 90 * 1024 * 1024;
const MAX_BULK_PDF_FILES = 10;
const MAX_BULK_METADATA_BYTES = 1_000_000;
const RAZORPAY_TIMEOUT_MS = 8_000;
const SUPABASE_TIMEOUT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_TIME_ZONE = 'Asia/Kolkata';
const ANALYTICS_VISITOR_RETENTION_DAYS = 35;
const ANALYTICS_DAILY_RETENTION_DAYS = 400;
const RATE_LIMIT_RETENTION_MS = 8 * DAY_MS;
const INDIVIDUAL_CARD_PRICE = 39;
const FULL_COURSE_BUNDLE_PRICE = 399;
const ANALYTICS_WINDOW_MS = 60 * 60 * 1000;
const MAX_ANALYTICS_EVENTS = 30;
const FEEDBACK_WINDOW_MS = 15 * 60 * 1000;
const MAX_FEEDBACK_SUBMISSIONS = 5;
const CANONICAL_SITE_HOST = 'tksolutions.in';
const CANONICAL_SITE_WWW_HOST = `www.${CANONICAL_SITE_HOST}`;
const PUBLIC_READ_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const ALLOWED_TYPES = new Set(['sample', 'pyq', 'mcq', 'important']);
const ALLOWED_CLASSES = new Set(['10', '11', '12']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9-]{1,80}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER_STATUSES = new Set(['created', 'captured', 'fulfilled', 'failed', 'refunded']);
const FEEDBACK_STATUSES = new Set(['open', 'in_progress', 'resolved', 'closed']);
const PROMOTION_KINDS = new Set(['discount', 'bundle', 'subscription']);
const PROMOTION_DISCOUNT_TYPES = new Set(['percent', 'fixed']);
const PROMOTION_INTERVALS = new Set(['none', 'monthly', 'yearly']);
const PAPER_STORAGE_UNAVAILABLE = 'Secure PDF storage is not configured yet. PDF uploads, purchases, and downloads are temporarily unavailable.';
const SUPABASE_PAPER_BUCKET = 'tks-papers';

const scienceLessons = [
  'Chemical Reactions and Equations', 'Acids, Bases and Salts', 'Metals and Non-metals',
  'Carbon and its Compounds', 'Life Processes', 'Control and Coordination',
  'How Do Organisms Reproduce?', 'Heredity', 'Light: Reflection and Refraction',
  'The Human Eye and the Colourful World', 'Electricity', 'Magnetic Effects of Electric Current',
  'Our Environment', 'Sustainable Management of Natural Resources'
];

const staticPageAliases = new Map([
  ['/', '/index.html'],
  ['/index', '/index.html'],
  ['/admin', '/admin.html'],
  ['/library', '/library.html'],
  ['/privacy', '/privacy.html'],
  ['/terms', '/terms.html'],
  ['/sample-papers', '/sample-papers.html'],
  ['/pyqs', '/pyqs.html'],
  ['/mcqs', '/mcqs.html'],
  ['/important-questions', '/important-questions.html']
]);
const staticPagePaths = new Set([
  ...staticPageAliases.keys(),
  ...staticPageAliases.values()
]);

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

// Catalogue reads contain no protected file keys and are identical for every
// visitor. A short browser cache and longer edge revalidation window reduce
// D1 work without making an admin publish feel delayed for long.
function publicJson(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...securityHeaders(), 'Cache-Control': PUBLIC_READ_CACHE_CONTROL, ...extraHeaders }
  });
}

function text(body, status = 200, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { ...securityHeaders(contentType), 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

function methodNotAllowed(allowed) {
  return json({ error: 'Method not allowed.' }, 405, { Allow: allowed });
}

class PaperStorageUnavailableError extends Error {
  constructor() {
    super(PAPER_STORAGE_UNAVAILABLE);
    this.name = 'PaperStorageUnavailableError';
  }
}

class RequestBodyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RequestBodyError';
    this.status = status;
  }
}

class UpstreamServiceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamServiceError';
  }
}

// Keep the original R2 adapter readable for any already-configured preview,
// while production uses the private Supabase adapter below. Both providers stay
// behind these server-only helpers: browser code never receives a storage key.
function hasR2PaperStorage(env) {
  const papers = env?.PAPERS;
  return Boolean(papers
    && typeof papers.head === 'function'
    && typeof papers.get === 'function'
    && typeof papers.put === 'function'
    && typeof papers.delete === 'function'
    && typeof papers.list === 'function');
}

function supabaseProjectUrl(env) {
  const value = String(env?.SUPABASE_URL || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function supabaseServerKey(env) {
  // Supabase's current dashboard calls this a secret key (`sb_secret_...`).
  // Keep the legacy service-role name as a temporary migration fallback only.
  return String(env?.SUPABASE_SECRET_KEY || env?.SUPABASE_SERVICE_ROLE_KEY || '').trim();
}

function hasSupabasePaperStorage(env) {
  return Boolean(supabaseProjectUrl(env) && hasConfiguredSecret(supabaseServerKey(env), 32));
}

function hasPaperStorage(env) {
  return hasR2PaperStorage(env) || hasSupabasePaperStorage(env);
}

function requirePaperStorage(env) {
  if (!hasPaperStorage(env)) throw new PaperStorageUnavailableError();
  return env;
}

// Public traffic must fail closed if someone changes the managed bucket in the
// Supabase dashboard. This check intentionally runs before every storage
// operation, including checkout existence checks and protected downloads; a
// private-object URL is never a substitute for the application's own access
// controls.
function newStorageOperationContext() {
  // This object is created only inside one authenticated request. It avoids
  // repeating the same bucket lookup for every file in an admin bulk upload;
  // public checkout and download requests deliberately do not receive it.
  return { supabaseReady: false, uploadedFileKeys: new Set() };
}

async function requireReadyPaperStorage(env, storageContext = null) {
  requirePaperStorage(env);
  if (hasSupabasePaperStorage(env) && !hasR2PaperStorage(env) && !storageContext?.supabaseReady) {
    await ensureSupabasePaperBucket(env);
    if (storageContext) storageContext.supabaseReady = true;
  }
  return env;
}

function paperStorageUnavailableResponse() {
  return json({ error: PAPER_STORAGE_UNAVAILABLE, code: 'PAPER_STORAGE_UNAVAILABLE' }, 503);
}

function hasConfiguredSecret(value, minimumLength = 1) {
  return typeof value === 'string' && value.trim().length >= minimumLength;
}

function supabaseStoragePath(filename = '') {
  return `${encodeURIComponent(SUPABASE_PAPER_BUCKET)}/${encodeURIComponent(filename)}`;
}

function supabaseStorageUrl(env, path = '') {
  const projectUrl = supabaseProjectUrl(env);
  if (!projectUrl) throw new PaperStorageUnavailableError();
  return `${projectUrl}/storage/v1${path}`;
}

function supabaseStorageHeaders(env, headers = {}) {
  const key = supabaseServerKey(env);
  // Current sb_secret keys are opaque API keys, not JWTs. Supabase requires
  // those on `apikey` only. The Authorization fallback exists solely for an
  // older JWT-shaped service_role key during a controlled migration.
  return {
    ...headers,
    apikey: key,
    'X-Client-Info': 'tks-solution-worker/1.0',
    ...(key.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${key}` })
  };
}

async function supabaseStorageFetch(env, path, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  try {
    return await fetch(supabaseStorageUrl(env, path), {
      ...init,
      signal: controller.signal,
      headers: supabaseStorageHeaders(env, init.headers || {})
    });
  } catch {
    throw new UpstreamServiceError('The private PDF storage service could not be reached. Please try again shortly.');
  } finally {
    clearTimeout(timeout);
  }
}

async function storageResponseError(response, fallback) {
  // Storage responses may contain internal implementation detail. Keep that
  // out of public/admin API errors while still providing a useful action.
  try { await response.body?.cancel(); } catch { /* response cleanup is best effort */ }
  throw new UpstreamServiceError(fallback);
}

async function isMissingSupabaseObject(response) {
  if (response.status === 404) {
    try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
    return true;
  }
  if (response.status !== 400) return false;
  // Supabase Storage uses a 400 response with `NoSuchKey` for a missing
  // private object on some renderer routes. Do not treat any other 400 as a
  // missing PDF: configuration and credential failures need a clear error.
  const payload = await response.clone().json().catch(() => null);
  const missing = payload?.code === 'NoSuchKey';
  if (missing) {
    try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
  }
  return missing;
}

async function ensureSupabasePaperBucket(env) {
  if (!hasSupabasePaperStorage(env)) throw new PaperStorageUnavailableError();
  const bucketPath = `/bucket/${encodeURIComponent(SUPABASE_PAPER_BUCKET)}`;
  let response = await supabaseStorageFetch(env, bucketPath);
  if (response.status === 404) {
    response = await supabaseStorageFetch(env, '/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: SUPABASE_PAPER_BUCKET,
        name: SUPABASE_PAPER_BUCKET,
        public: false,
        file_size_limit: MAX_PDF_BYTES,
        allowed_mime_types: ['application/pdf']
      })
    });
    if (!response.ok && response.status !== 409) await storageResponseError(response, 'The private PDF storage bucket could not be prepared. Please check the Supabase connection.');
    response = await supabaseStorageFetch(env, bucketPath);
  }
  if (!response.ok) await storageResponseError(response, 'The private PDF storage bucket is unavailable. Please check the Supabase connection.');
  const bucket = await response.json().catch(() => null);
  if (!bucket || bucket.public !== false) {
    throw new UpstreamServiceError('The PDF storage bucket must remain private. Change the Supabase bucket to private before uploading or selling PDFs.');
  }
  const allowedMimeTypes = Array.isArray(bucket.allowed_mime_types) ? bucket.allowed_mime_types : [];
  if (Number(bucket.file_size_limit) !== MAX_PDF_BYTES || allowedMimeTypes.length !== 1 || allowedMimeTypes[0] !== 'application/pdf') {
    const update = await supabaseStorageFetch(env, bucketPath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_size_limit: MAX_PDF_BYTES, allowed_mime_types: ['application/pdf'] })
    });
    if (!update.ok) await storageResponseError(update, 'The private PDF storage bucket must allow only PDFs up to 25 MB. Please check the Supabase connection.');
  }
}

async function paperExists(env, filename, storageContext = null) {
  await requireReadyPaperStorage(env, storageContext);
  if (hasR2PaperStorage(env)) return Boolean(await env.PAPERS.head(filename));
  // Object-info is a tiny metadata response with a structured NoSuchKey
  // error. It is safer than interpreting a bodyless HEAD 400 as missing.
  const response = await supabaseStorageFetch(env, `/object/info/authenticated/${supabaseStoragePath(filename)}`);
  if (await isMissingSupabaseObject(response)) return false;
  if (!response.ok) await storageResponseError(response, 'The private PDF storage service could not check this file. Please try again shortly.');
  try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
  return true;
}

async function readPaper(env, filename, storageContext = null) {
  await requireReadyPaperStorage(env, storageContext);
  if (hasR2PaperStorage(env)) {
    const object = await env.PAPERS.get(filename);
    return object ? { body: object.body, size: object.size, writeHttpMetadata: (headers) => object.writeHttpMetadata(headers) } : null;
  }
  const response = await supabaseStorageFetch(env, `/object/authenticated/${supabaseStoragePath(filename)}`);
  if (await isMissingSupabaseObject(response)) return null;
  if (!response.ok || !response.body) await storageResponseError(response, 'The protected PDF file could not be read. Please try again shortly.');
  const contentLength = response.headers.get('Content-Length');
  const length = contentLength === null ? null : Number(contentLength);
  return { body: response.body, size: Number.isSafeInteger(length) && length >= 0 ? length : null };
}

async function writePaper(env, filename, body, storageContext = null) {
  await requireReadyPaperStorage(env, storageContext);
  if (hasR2PaperStorage(env)) {
    await env.PAPERS.put(filename, body, {
      httpMetadata: { contentType: 'application/pdf', contentDisposition: `attachment; filename="${filename}"` }
    });
    return;
  }
  const response = await supabaseStorageFetch(env, `/object/${supabaseStoragePath(filename)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      // Storage keys are generated by the Worker and are immutable. Refuse a
      // collision rather than permitting any accidental replacement.
      'x-upsert': 'false'
    },
    body
  });
  if (!response.ok) await storageResponseError(response, 'The PDF could not be stored securely. Please try again shortly.');
}

async function removePaper(env, filename, storageContext = null) {
  await requireReadyPaperStorage(env, storageContext);
  if (hasR2PaperStorage(env)) {
    await env.PAPERS.delete(filename);
    return;
  }
  const response = await supabaseStorageFetch(env, `/object/${encodeURIComponent(SUPABASE_PAPER_BUCKET)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [filename] })
  });
  if (!response.ok) await storageResponseError(response, 'The PDF could not be removed from secure storage. Please try again shortly.');
}

// This is a deliberate launch switch rather than an inferred state. A bucket
// and test credentials can be present while the public site is still being
// checked, so no student should see a purchasable resource until the owner
// explicitly opens sales.
function paymentsAreEnabled(env) {
  return String(env?.PAYMENTS_ENABLED || '').trim().toLowerCase() === 'true';
}

function hasSecureDownloadConfiguration(env) {
  return hasConfiguredSecret(env?.DOWNLOAD_TOKEN_SECRET, 32);
}

// This covers the secure delivery machinery itself. Keep it independent from
// the public sales switch so a sale already in progress can still be verified,
// recovered, and fulfilled if the owner pauses new purchases.
function hasPaymentDeliveryConfiguration(env) {
  return hasPaperStorage(env)
    && hasSecureDownloadConfiguration(env)
    && hasConfiguredSecret(env?.RAZORPAY_KEY_ID)
    && hasConfiguredSecret(env?.RAZORPAY_KEY_SECRET)
    && hasConfiguredSecret(env?.RAZORPAY_WEBHOOK_SECRET);
}

// New sales require both a complete payment-delivery configuration and an
// explicit owner decision to open checkout to the public.
function canAcceptNewPayments(env) {
  return paymentsAreEnabled(env) && hasPaymentDeliveryConfiguration(env);
}

function paymentDeliveryUnavailableResponse(env) {
  if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
  if (!paymentsAreEnabled(env)) {
    return json({
      error: 'Secure purchases are not open yet. The administrator must enable sales after completing the final payment checks.',
      code: 'PAYMENTS_DISABLED'
    }, 503);
  }
  return json({
    error: 'Secure purchases are not configured yet. The administrator must complete protected downloads and payment-webhook setup before accepting payments.',
    code: 'PAYMENT_DELIVERY_UNAVAILABLE'
  }, 503);
}

function apiErrorResponse(error, fallback, status = 400) {
  if (error instanceof PaperStorageUnavailableError) return paperStorageUnavailableResponse();
  if (error instanceof RequestBodyError) return json({ error: error.message }, error.status);
  if (error instanceof UpstreamServiceError) return json({ error: error.message }, 502);
  return json({ error: error instanceof Error && error.message ? error.message : fallback }, status);
}

function secureStaticPage(response, request) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (name !== 'Content-Type') headers.set(name, value);
  }
  const pathname = new URL(request.url).pathname;
  if (isWorkersDev(request.url) || pathname === '/admin' || pathname === '/admin.html') headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Static files use stable filenames, so keep the browser cache deliberately
// short. This removes repeat-visit revalidation without leaving a revised
// checkout/admin script stuck on a device for days.
function cacheStaticAsset(response, request) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (response.ok && /\.(?:css|js|png|jpe?g|webp|avif|svg|ico|woff2?)$/i.test(pathname)) {
    // A versioned URL is a new immutable resource. Keep legacy unversioned
    // files short-lived so a future edit cannot leave a checkout UI stale.
    const immutable = url.searchParams.has('v') || pathname.endsWith('/tk-solution-logo-192.png');
    headers.set('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
  }
  if (isWorkersDev(request.url)) headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
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

function decodeCookiePart(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function parseCookies(request) {
  const cookies = {};
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf('=');
    const rawName = index < 0 ? trimmed : trimmed.slice(0, index);
    const rawValue = index < 0 ? '' : trimmed.slice(index + 1);
    const name = decodeCookiePart(rawName);
    const value = decodeCookiePart(rawValue);
    // An unrelated malformed cookie must not turn an admin/session request into
    // a 500 response. Ignore just that cookie instead.
    if (name && value !== null) cookies[name] = value;
  }
  return cookies;
}

function isLocalOrTestHost(request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.test');
  } catch {
    return false;
  }
}

function validSameOrigin(request) {
  // Safe reads do not need an Origin header. Browser state changes do: this
  // keeps cookie-authenticated admin and payment actions fail-closed while
  // retaining the isolated .test/local hosts used by automated smoke tests.
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) return true;
  const origin = request.headers.get('Origin');
  if (!origin) return isLocalOrTestHost(request);
  return origin === new URL(request.url).origin;
}

function declaredContentLength(request) {
  const raw = request.headers.get('Content-Length');
  if (!raw || !/^\d+$/.test(raw.trim())) return 0;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Infinity;
}

function requiredContentLength(request, maximum, label = 'Request body') {
  const raw = request.headers.get('Content-Length');
  if (!raw || !/^\d+$/.test(raw.trim())) {
    throw new RequestBodyError(`${label} requires a valid Content-Length header.`, 411);
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RequestBodyError(`${label} requires a positive Content-Length header.`, 411);
  }
  if (length > maximum) {
    throw new RequestBodyError(`${label} must be at most ${Math.floor(maximum / 1_000_000)} MB.`, 413);
  }
  return length;
}

async function readBodyBytes(request, maxBytes) {
  if (declaredContentLength(request) > maxBytes) {
    throw new RequestBodyError(`Request body must be at most ${Math.floor(maxBytes / 1_000_000)} MB.`, 413);
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyError(`Request body must be at most ${Math.floor(maxBytes / 1_000_000)} MB.`, 413);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(request, maxBytes = MAX_JSON_BYTES) {
  const bytes = await readBodyBytes(request, maxBytes);
  if (!bytes.byteLength) return {};
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new RequestBodyError('Invalid JSON request body.');
  }
}

async function readOptionalJson(request, maxBytes = MAX_JSON_BYTES) {
  if (!request.body) return {};
  const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) throw new RequestBodyError('Request body must be JSON.');
  const value = await readJson(request, maxBytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestBodyError('Request body must be a JSON object.');
  return value;
}

function isFullCourseBundle(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function fixedCardPrice(isBundle) {
  return isBundle ? FULL_COURSE_BUNDLE_PRICE : INDIVIDUAL_CARD_PRICE;
}

function requireFixedCardPrice(inputPrice, isBundle, source = 'A study card') {
  const expected = fixedCardPrice(isBundle);
  if (inputPrice === undefined || inputPrice === null || String(inputPrice).trim() === '') return expected;
  const supplied = Number(inputPrice);
  if (!Number.isSafeInteger(supplied) || supplied !== expected) {
    throw new Error(`${source} must be priced at ₹${expected}${isBundle ? ' for a full-course bundle.' : ' for an individual study card.'}`);
  }
  return expected;
}

function isTrue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function optionalBoolean(input, field, fallback) {
  if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined || input[field] === null || input[field] === '') return fallback;
  if ([true, false, 1, 0, '1', '0', 'true', 'false'].includes(input[field])) return isTrue(input[field]);
  throw new Error(`Choose whether ${field} is enabled.`);
}

function optionalSortOrder(input, field, fallback = 0) {
  if (!Object.prototype.hasOwnProperty.call(input, field) || input[field] === undefined || input[field] === null || input[field] === '') return fallback;
  const value = Number(input[field]);
  if (!Number.isSafeInteger(value) || value < -100000 || value > 100000) throw new Error(`${field} must be a whole number between -100000 and 100000.`);
  return value;
}

function optionalIdentifier(value, label = 'Identifier') {
  const identifier = String(value || '').trim();
  if (!identifier) return '';
  if (!IDENTIFIER_PATTERN.test(identifier)) throw new Error(`${label} is invalid.`);
  return identifier;
}

function plainText(value, maxLength, label, { required = false, multiline = false } = {}) {
  let text = String(value ?? '').replace(/\u0000/g, '');
  // Keep ordinary spaces and, for feedback/admin notes, line breaks. Control
  // characters are never useful in database-backed page content.
  text = multiline ? text.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : text.replace(/[\u0000-\u001F\u007F]/g, ' ');
  text = text.trim().slice(0, maxLength);
  if (required && !text) throw new Error(`${label} is required.`);
  return text;
}

function cleanEmail(value, { required = false } = {}) {
  const email = String(value || '').trim().toLowerCase();
  if (!email) {
    if (required) throw new Error('Email address is required.');
    return '';
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw new Error('Enter a valid email address.');
  return email;
}

function cleanTags(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : (value === undefined || value === null ? [] : null));
  if (!source || source.some((tag) => typeof tag !== 'string')) throw new Error('Tags must be a comma-separated list or an array of text labels.');
  if (source.length > 30) throw new Error('Use no more than 30 tags.');
  const seen = new Set();
  const tags = [];
  for (const rawTag of source) {
    const tag = plainText(rawTag, 50, 'Tag').replace(/\s+/g, ' ').toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

function parseStoredTags(value) {
  try {
    return cleanTags(JSON.parse(String(value || '[]')));
  } catch {
    return [];
  }
}

function cleanSeoKeywords(value) {
  return cleanTags(value).join(', ');
}

function cleanSeoFields(input, existing = null) {
  const supplied = (field, fallback = '') => Object.prototype.hasOwnProperty.call(input, field) ? input[field] : fallback;
  return {
    metaTitle: plainText(supplied('metaTitle', existing?.metaTitle || ''), 160, 'Meta title'),
    metaDescription: plainText(supplied('metaDescription', existing?.metaDescription || ''), 320, 'Meta description'),
    seoKeywords: cleanSeoKeywords(supplied('seoKeywords', existing?.seoKeywords || ''))
  };
}

function optionalIsoDate(value, label) {
  if (value === undefined || value === null || value === '') return '';
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid date.`);
  return new Date(timestamp).toISOString();
}

function boundedLimit(value, fallback = 100, maximum = 200) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function boundedOffset(value, maximum = 100_000) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return Math.min(parsed, maximum);
}

const CARD_SECTION_CONTEXT_COLUMNS = `
  c.*,
  s.id AS section_context_id,
  s.parent_id AS section_parent_id,
  s.title AS section_title,
  s.slug AS section_slug,
  s.is_published AS section_is_published,
  p.id AS parent_section_id,
  p.title AS parent_section_title,
  p.slug AS parent_section_slug,
  p.is_published AS parent_section_is_published`;

const CARD_SECTION_CONTEXT_JOINS = `
  LEFT JOIN catalog_sections AS s ON s.id = c.section_id
  LEFT JOIN catalog_sections AS p ON p.id = s.parent_id`;

function cardSelectSql(where = '', orderBy = 'c.sort_order ASC, c.updated_at DESC', limit = '') {
  return `SELECT ${CARD_SECTION_CONTEXT_COLUMNS} FROM cards AS c ${CARD_SECTION_CONTEXT_JOINS}${where ? ` WHERE ${where}` : ''} ORDER BY ${orderBy}${limit ? ` LIMIT ${limit}` : ''}`;
}

function cardIsPubliclyVisible(card) {
  return Boolean(card?.isPublished)
    && (!card.sectionId || (card.sectionIsPublished && (!card.sectionParentId || card.parentSectionIsPublished)));
}

function rowToCard(row) {
  const isBundle = isFullCourseBundle(row.is_bundle);
  const sectionId = String(row.section_id || '').trim();
  const sectionParentId = String(row.section_parent_id || '').trim();
  const sectionTitle = String(row.section_title || '').trim();
  const rootTitle = sectionParentId ? String(row.parent_section_title || '').trim() : sectionTitle;
  return {
    id: row.id,
    type: row.type,
    className: row.class_name,
    subject: row.subject,
    title: row.title,
    description: row.description,
    // Price is derived from the bundle flag, so historic or manually changed DB values
    // can never alter what students see or what the payment provider is charged.
    price: String(fixedCardPrice(isBundle)),
    link: row.link,
    fileKey: row.file_key,
    isBundle,
    slug: row.slug,
    sectionId,
    resourceLabel: String(row.resource_label || '').trim(),
    tags: parseStoredTags(row.tags),
    metaTitle: String(row.meta_title || '').trim(),
    metaDescription: String(row.meta_description || '').trim(),
    seoKeywords: String(row.seo_keywords || '').trim(),
    sortOrder: Number.isSafeInteger(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    isPublished: row.is_published === undefined || row.is_published === null ? true : isTrue(row.is_published),
    // These labels are for the flexible catalogue. The original className/type
    // values remain untouched so the original class/category pages keep working.
    displayClassName: rootTitle || row.class_name,
    displayType: sectionTitle || row.type,
    sectionTitle,
    sectionSlug: String(row.section_slug || '').trim(),
    sectionParentId,
    sectionIsPublished: sectionId ? isTrue(row.section_is_published) : true,
    parentSectionTitle: String(row.parent_section_title || '').trim(),
    parentSectionSlug: String(row.parent_section_slug || '').trim(),
    parentSectionId: String(row.parent_section_id || '').trim(),
    parentSectionIsPublished: sectionParentId ? isTrue(row.parent_section_is_published) : true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicCard(card, paymentDeliveryReady = false) {
  const { fileKey, ...safe } = card;
  return { ...safe, available: Boolean(fileKey) && paymentDeliveryReady && cardIsPubliclyVisible(card) };
}

async function readCards(env) {
  const result = await env.DB.prepare(cardSelectSql('', 'c.sort_order ASC, c.updated_at DESC', '5000')).all();
  return (result.results || []).map(rowToCard);
}

// Public pages should never fetch drafts and discard them in JavaScript. Apart
// from protecting unpublished work, this lets D1 use the public-listing index
// when the catalogue grows.
async function readPublicCards(env) {
  const result = await env.DB.prepare(cardSelectSql(publicCardVisibilityClause(), 'c.sort_order ASC, c.updated_at DESC', '5000')).all();
  return (result.results || []).map(rowToCard);
}

async function getCard(env, id) {
  const row = await env.DB.prepare(cardSelectSql('c.id = ?', 'c.updated_at DESC', '1')).bind(id).first();
  return row ? rowToCard(row) : null;
}

async function getCardBySlug(env, slug) {
  const row = await env.DB.prepare(cardSelectSql('c.slug = ?', 'c.updated_at DESC', '1')).bind(slug).first();
  return row ? rowToCard(row) : null;
}

async function getPublicCardBySlug(env, slug) {
  const row = await env.DB.prepare(cardSelectSql(`c.slug = ? AND ${publicCardVisibilityClause()}`, 'c.updated_at DESC', '1')).bind(slug).first();
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

function rowToSection(row) {
  return {
    id: row.id,
    parentId: String(row.parent_id || '').trim(),
    title: row.title,
    slug: row.slug,
    description: row.description || '',
    icon: row.icon || '',
    tags: parseStoredTags(row.tags),
    metaTitle: String(row.meta_title || '').trim(),
    metaDescription: String(row.meta_description || '').trim(),
    seoKeywords: String(row.seo_keywords || '').trim(),
    sortOrder: Number.isSafeInteger(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    isPublished: isTrue(row.is_published),
    showOnHome: isTrue(row.show_on_home),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sectionContextFromRow(row) {
  if (!row) return null;
  const section = rowToSection(row);
  const parentId = section.parentId;
  const parentTitle = String(row.parent_section_title || '').trim();
  const parentSlug = String(row.parent_section_slug || '').trim();
  const parentIsPublished = parentId ? isTrue(row.parent_section_is_published) : true;
  if (parentId && !parentTitle) return null;
  return {
    ...section,
    rootId: parentId || section.id,
    rootTitle: parentTitle || section.title,
    rootSlug: parentSlug || section.slug,
    sectionTitle: section.title,
    sectionSlug: section.slug,
    parentTitle,
    parentSlug,
    parentIsPublished
  };
}

async function getSection(env, id) {
  const row = await env.DB.prepare('SELECT * FROM catalog_sections WHERE id = ?').bind(id).first();
  return row ? rowToSection(row) : null;
}

async function getSectionContext(env, id) {
  const row = await env.DB.prepare(`SELECT s.*, p.title AS parent_section_title, p.slug AS parent_section_slug,
      p.is_published AS parent_section_is_published, p.parent_id AS parent_parent_id
    FROM catalog_sections AS s LEFT JOIN catalog_sections AS p ON p.id = s.parent_id WHERE s.id = ?`).bind(id).first();
  if (!row || (row.parent_id && (!row.parent_section_title || row.parent_parent_id))) return null;
  return sectionContextFromRow(row);
}

async function readSectionContexts(env) {
  const result = await env.DB.prepare(`SELECT s.*, p.title AS parent_section_title, p.slug AS parent_section_slug,
      p.is_published AS parent_section_is_published, p.parent_id AS parent_parent_id
    FROM catalog_sections AS s LEFT JOIN catalog_sections AS p ON p.id = s.parent_id
    ORDER BY s.sort_order ASC, s.title COLLATE NOCASE ASC`).all();
  const contexts = new Map();
  for (const row of result.results || []) {
    if (!row.parent_id || (row.parent_section_title && !row.parent_parent_id)) {
      const context = sectionContextFromRow(row);
      if (context) contexts.set(context.id, context);
    }
  }
  return contexts;
}

async function readSections(env) {
  const result = await env.DB.prepare('SELECT * FROM catalog_sections ORDER BY parent_id IS NOT NULL, sort_order ASC, title COLLATE NOCASE ASC').all();
  return (result.results || []).map(rowToSection);
}

async function sectionSlugAvailable(env, slug, existingId) {
  const row = await env.DB.prepare('SELECT id FROM catalog_sections WHERE slug = ?').bind(slug).first();
  return !row || row.id === existingId;
}

async function uniqueSectionSlug(env, value, existingId) {
  const base = slugify(value);
  let candidate = base;
  let attempt = 2;
  while (!(await sectionSlugAvailable(env, candidate, existingId))) candidate = `${base.slice(0, 104)}-${attempt++}`;
  return candidate;
}

function legacyFieldsForSection(context) {
  const root = /^class-(10|11|12)$/.exec(context.rootId || '');
  if (!root) return null;
  const type = ['sample', 'pyq', 'mcq', 'important'].find((candidate) => context.id === `class-${root[1]}-${candidate}`);
  return type ? { className: root[1], type } : null;
}

function defaultCardPublished(section) {
  return !section || Boolean(legacyFieldsForSection(section));
}

async function cleanSection(env, input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid catalogue section.');
  const supplied = (field, fallback = '') => Object.prototype.hasOwnProperty.call(input, field) ? input[field] : fallback;
  const title = String(supplied('title', existing?.title || '') || '').trim().slice(0, 90);
  const description = String(supplied('description', existing?.description || '') || '').trim().slice(0, 500);
  const icon = String(supplied('icon', existing?.icon || '') || '').trim().slice(0, 64);
  const tags = cleanTags(supplied('tags', existing?.tags || []));
  const seo = cleanSeoFields(input, existing);
  if (!title) throw new Error('Add a section title.');
  const id = existing?.id || crypto.randomUUID();
  const suppliedParent = Object.prototype.hasOwnProperty.call(input, 'parentId') ? input.parentId : existing?.parentId;
  const parentId = optionalIdentifier(suppliedParent, 'Parent section');
  if (parentId === id) throw new Error('A section cannot be its own parent.');
  if (parentId) {
    const parent = await getSection(env, parentId);
    if (!parent) throw new Error('Choose an existing top-level section.');
    if (parent.parentId) throw new Error('Catalogue sections can be only two levels deep.');
    if (existing && existing.parentId !== parentId) {
      const children = await env.DB.prepare('SELECT 1 FROM catalog_sections WHERE parent_id = ? LIMIT 1').bind(existing.id).first();
      if (children) throw new Error('A section with child tiles must remain at the top level.');
    }
  }
  const sortOrder = optionalSortOrder(input, 'sortOrder', existing?.sortOrder || 0);
  const isPublished = optionalBoolean(input, 'isPublished', existing?.isPublished || false);
  const showOnHome = optionalBoolean(input, 'showOnHome', existing?.showOnHome || false);
  const desiredSlug = String(input.slug || '').trim() || existing?.slug || title;
  const slug = await uniqueSectionSlug(env, desiredSlug, id);
  const now = new Date().toISOString();
  return {
    id, parentId, title, slug, description, icon, tags, ...seo, sortOrder, isPublished, showOnHome,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function sectionInsertStatement(env, section) {
  return env.DB.prepare(`INSERT INTO catalog_sections
    (id,parent_id,title,slug,description,icon,tags,meta_title,meta_description,seo_keywords,sort_order,is_published,show_on_home,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(section.id, section.parentId || null, section.title, section.slug, section.description, section.icon,
      JSON.stringify(section.tags), section.metaTitle, section.metaDescription, section.seoKeywords, section.sortOrder, Number(section.isPublished), Number(section.showOnHome), section.createdAt, section.updatedAt);
}

async function insertSection(env, section) {
  await sectionInsertStatement(env, section).run();
  return section;
}

async function updateSection(env, section) {
  await env.DB.prepare(`UPDATE catalog_sections SET parent_id=?,title=?,slug=?,description=?,icon=?,tags=?,sort_order=?,
      meta_title=?,meta_description=?,seo_keywords=?,is_published=?,show_on_home=?,updated_at=? WHERE id=?`)
    .bind(section.parentId || null, section.title, section.slug, section.description, section.icon, JSON.stringify(section.tags), section.sortOrder,
      section.metaTitle, section.metaDescription, section.seoKeywords, Number(section.isPublished), Number(section.showOnHome), section.updatedAt, section.id).run();
  return section;
}

function importedSectionSlug(value, usedSlugs) {
  const slug = slugify(value);
  if (usedSlugs.has(slug)) throw new Error('The backup contains duplicate catalogue section slugs.');
  usedSlugs.add(slug);
  return slug;
}

function cleanImportedSection(input, usedSlugs) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The backup contains an invalid catalogue section.');
  const id = optionalIdentifier(input.id, 'Section') || crypto.randomUUID();
  const parentId = optionalIdentifier(input.parentId, 'Parent section');
  if (parentId === id) throw new Error('A catalogue section cannot be its own parent.');
  const title = String(input.title || '').trim().slice(0, 90);
  const description = String(input.description || '').trim().slice(0, 500);
  const icon = String(input.icon || '').trim().slice(0, 64);
  const tags = cleanTags(input.tags);
  const seo = cleanSeoFields(input);
  if (!title) throw new Error('The backup contains a catalogue section without a title.');
  const now = new Date().toISOString();
  return {
    id,
    parentId,
    title,
    slug: importedSectionSlug(input.slug || title, usedSlugs),
    description,
    icon,
    tags,
    ...seo,
    sortOrder: optionalSortOrder(input, 'sortOrder', 0),
    isPublished: optionalBoolean(input, 'isPublished', false),
    showOnHome: optionalBoolean(input, 'showOnHome', false),
    createdAt: importTimestamp(input.createdAt, now),
    updatedAt: importTimestamp(input.updatedAt, now)
  };
}

function importedSectionContexts(sections) {
  const sectionsById = new Map();
  for (const section of sections) {
    if (sectionsById.has(section.id)) throw new Error('The backup contains duplicate catalogue section IDs.');
    sectionsById.set(section.id, section);
  }
  const contexts = new Map();
  for (const section of sections) {
    const parent = section.parentId ? sectionsById.get(section.parentId) : null;
    if (section.parentId && !parent) throw new Error('The backup references a parent catalogue section that does not exist.');
    if (parent?.parentId) throw new Error('The backup contains catalogue sections deeper than two levels.');
    contexts.set(section.id, {
      ...section,
      rootId: parent?.id || section.id,
      rootTitle: parent?.title || section.title,
      rootSlug: parent?.slug || section.slug,
      sectionTitle: section.title,
      sectionSlug: section.slug,
      parentTitle: parent?.title || '',
      parentSlug: parent?.slug || '',
      parentIsPublished: parent?.isPublished ?? true
    });
  }
  return contexts;
}

function bulkSectionImportStatement(env, sections) {
  const payload = JSON.stringify(sections.map((section) => ({
    id: section.id,
    parentId: section.parentId || null,
    title: section.title,
    slug: section.slug,
    description: section.description,
    icon: section.icon,
    tags: section.tags,
    metaTitle: section.metaTitle,
    metaDescription: section.metaDescription,
    seoKeywords: section.seoKeywords,
    sortOrder: section.sortOrder,
    isPublished: Number(section.isPublished),
    showOnHome: Number(section.showOnHome),
    createdAt: section.createdAt,
    updatedAt: section.updatedAt
  })));
  return env.DB.prepare(`INSERT INTO catalog_sections
    (id,parent_id,title,slug,description,icon,tags,meta_title,meta_description,seo_keywords,sort_order,is_published,show_on_home,created_at,updated_at)
    SELECT json_extract(value,'$.id'), json_extract(value,'$.parentId'), json_extract(value,'$.title'), json_extract(value,'$.slug'),
      json_extract(value,'$.description'), json_extract(value,'$.icon'), json_extract(value,'$.tags'), json_extract(value,'$.metaTitle'), json_extract(value,'$.metaDescription'), json_extract(value,'$.seoKeywords'), json_extract(value,'$.sortOrder'), json_extract(value,'$.isPublished'),
      json_extract(value,'$.showOnHome'), json_extract(value,'$.createdAt'), json_extract(value,'$.updatedAt')
    FROM json_each(?)`).bind(payload);
}

function safePdfFilename(value) {
  const filename = String(value || '').trim();
  if (!filename || filename.length > 180 || !/^[a-z0-9][a-z0-9._ ()-]*\.pdf$/i.test(filename)) {
    throw new Error('Choose a valid PDF filename.');
  }
  return filename;
}

function downloadPdfFilename(storageKey) {
  const key = safePdfFilename(storageKey);
  const generated = /^(?:bulk|upload)-[0-9a-f]{32}-(.+\.pdf)$/i.exec(key);
  return generated ? safePdfFilename(generated[1]) : key;
}

function generatedStorageKey(prefix, filename) {
  const source = safePdfFilename(filename);
  const extension = '.pdf';
  const base = source.slice(0, -extension.length);
  const generatedPrefix = `${prefix}-${crypto.randomUUID().replace(/-/g, '')}-`;
  const maximumBaseLength = 180 - generatedPrefix.length - extension.length;
  return safePdfFilename(`${generatedPrefix}${base.slice(0, maximumBaseLength)}${extension}`);
}

function generatedBulkStorageKey(filename) {
  return generatedStorageKey('bulk', filename);
}

function generatedUploadStorageKey(filename) {
  return generatedStorageKey('upload', filename);
}

async function newBulkStorageKey(env, filename, storageContext = null) {
  // Each batch receives an immutable server-generated key. Besides avoiding
  // accidental overwrites, this makes failure cleanup safe even if two admins
  // upload files with the same display filename at the same time.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const key = generatedBulkStorageKey(filename);
    if (!await paperExists(env, key, storageContext)) return key;
  }
  throw new Error('Could not reserve secure storage for this PDF. Please retry the batch.');
}

async function newUploadStorageKey(env, filename, storageContext = null) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const key = generatedUploadStorageKey(filename);
    if (!await paperExists(env, key, storageContext)) return key;
  }
  throw new Error('Could not reserve secure storage for this PDF. Please retry the upload.');
}

async function cleanCard(env, input, existing = null, storageContext = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid card details.');
  const supplied = (field, fallback = '') => Object.prototype.hasOwnProperty.call(input, field) ? input[field] : fallback;
  const sectionId = optionalIdentifier(supplied('sectionId', existing?.sectionId || ''), 'Section');
  const section = sectionId ? await getSectionContext(env, sectionId) : null;
  if (sectionId && !section) throw new Error('Choose an existing catalogue section.');
  const title = String(supplied('title', existing?.title || '') || '').trim().slice(0, 140);
  const description = String(supplied('description', existing?.description || '') || '').trim().slice(0, 500);
  const resourceLabel = String(supplied('resourceLabel', existing?.resourceLabel || '') || '').trim().slice(0, 100);
  const tags = cleanTags(supplied('tags', existing?.tags || []));
  const seo = cleanSeoFields(input, existing);
  let subject = String(supplied('subject', existing?.subject || '') || '').trim().slice(0, 80);
  let link = String(supplied('link', existing?.link || '') || '').trim();
  let fileKey = String(supplied('fileKey', existing?.fileKey || '') || '').trim();
  const isBundle = Object.prototype.hasOwnProperty.call(input, 'isBundle') ? isFullCourseBundle(input.isBundle) : Boolean(existing?.isBundle);
  const price = requireFixedCardPrice(input.price, isBundle);
  let type = String(supplied('type', existing?.type || '') || '').trim().slice(0, 80);
  let className = String(supplied('className', existing?.className || '') || '').trim().slice(0, 80);
  if (section) {
    const legacy = legacyFieldsForSection(section);
    className = legacy?.className || limitUtf8(section.rootTitle, 80);
    type = legacy?.type || limitUtf8(section.sectionTitle, 80);
    subject = subject || resourceLabel || limitUtf8(section.sectionTitle, 80);
  }
  if ((!section && (!ALLOWED_TYPES.has(type) || !ALLOWED_CLASSES.has(className))) || !subject || !title) {
    throw new Error('Invalid card details.');
  }
  if (link) {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Preview links must use HTTPS.');
    link = url.href;
  }
  if (fileKey) {
    fileKey = safePdfFilename(fileKey);
    if (!storageContext?.uploadedFileKeys?.has(fileKey) && !await paperExists(env, fileKey, storageContext)) {
      throw new Error('Upload the selected PDF before linking it to a card.');
    }
  }
  const id = existing?.id || crypto.randomUUID();
  const desiredSlug = String(input.slug || '').trim() || existing?.slug || `${type}-class-${className}-${subject}-${title}`;
  const slug = await uniqueSlug(env, desiredSlug, id);
  const sortOrder = optionalSortOrder(input, 'sortOrder', existing?.sortOrder || 0);
  // Existing legacy cards stay publicly visible. New cards placed in flexible
  // sections are drafts until the admin explicitly publishes them.
  const isPublished = optionalBoolean(input, 'isPublished', existing ? existing.isPublished : defaultCardPublished(section));
  const now = new Date().toISOString();
  return {
    id, type, className, subject, title, description, price: String(price), link, fileKey, isBundle, slug,
    sectionId, resourceLabel, tags, ...seo, sortOrder, isPublished,
    displayClassName: section?.rootTitle || className,
    displayType: section?.sectionTitle || type,
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

function cleanImportedCard(input, usedSlugs, pdfFiles, sectionContexts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('The backup contains an invalid card.');
  const sectionId = optionalIdentifier(input.sectionId, 'Section');
  const section = sectionId ? sectionContexts.get(sectionId) : null;
  if (sectionId && !section) throw new Error('The backup references a catalogue section that does not exist.');
  let type = String(input.type || '').trim().slice(0, 80);
  let className = String(input.className || '').trim().slice(0, 80);
  let subject = String(input.subject || '').trim().slice(0, 80);
  const title = String(input.title || '').trim().slice(0, 140);
  const description = String(input.description || '').trim().slice(0, 500);
  const resourceLabel = String(input.resourceLabel || '').trim().slice(0, 100);
  const tags = cleanTags(input.tags);
  const seo = cleanSeoFields(input);
  let link = String(input.link || '').trim();
  let fileKey = String(input.fileKey || '').trim();
  const isBundle = isFullCourseBundle(input.isBundle);
  const price = requireFixedCardPrice(input.price, isBundle, 'Each imported study card');
  if (section) {
    const legacy = legacyFieldsForSection(section);
    className = legacy?.className || limitUtf8(section.rootTitle, 80);
    type = legacy?.type || limitUtf8(section.sectionTitle, 80);
    subject = subject || resourceLabel || limitUtf8(section.sectionTitle, 80);
  }
  if ((!section && (!ALLOWED_TYPES.has(type) || !ALLOWED_CLASSES.has(className))) || !subject || !title) {
    throw new Error('The backup contains invalid card details.');
  }
  if (link) {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The backup contains a preview link that does not use HTTPS.');
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
    sectionId,
    resourceLabel,
    tags,
    ...seo,
    sortOrder: optionalSortOrder(input, 'sortOrder', 0),
    isPublished: optionalBoolean(input, 'isPublished', defaultCardPublished(section)),
    slug: uniqueSlugFromSet(input.slug || `${type}-class-${className}-${subject}-${title}`, usedSlugs),
    createdAt: importTimestamp(input.createdAt, now),
    updatedAt: now
  };
}

function cardInsertStatement(env, card) {
  return env.DB.prepare(`INSERT INTO cards
    (id,type,class_name,subject,title,description,price,link,file_key,is_bundle,slug,section_id,resource_label,tags,meta_title,meta_description,seo_keywords,sort_order,is_published,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(card.id, card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey,
      Number(card.isBundle), card.slug, card.sectionId || null, card.resourceLabel, JSON.stringify(card.tags), card.metaTitle, card.metaDescription, card.seoKeywords, card.sortOrder, Number(card.isPublished), card.createdAt, card.updatedAt);
}

function bulkCardImportStatement(env, cards) {
  const payload = JSON.stringify(cards.map((card) => ({
    id: card.id,
    type: card.type,
    className: card.className,
    subject: card.subject,
    title: card.title,
    description: card.description,
    price: Number(card.price),
    link: card.link,
    fileKey: card.fileKey,
    isBundle: Number(card.isBundle),
    slug: card.slug,
    sectionId: card.sectionId || null,
    resourceLabel: card.resourceLabel,
    tags: card.tags,
    metaTitle: card.metaTitle,
    metaDescription: card.metaDescription,
    seoKeywords: card.seoKeywords,
    sortOrder: card.sortOrder,
    isPublished: Number(card.isPublished),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt
  })));
  return env.DB.prepare(`INSERT INTO cards (id,type,class_name,subject,title,description,price,link,file_key,is_bundle,slug,section_id,resource_label,tags,meta_title,meta_description,seo_keywords,sort_order,is_published,created_at,updated_at)
    SELECT json_extract(value,'$.id'), json_extract(value,'$.type'), json_extract(value,'$.className'), json_extract(value,'$.subject'),
      json_extract(value,'$.title'), json_extract(value,'$.description'), json_extract(value,'$.price'), json_extract(value,'$.link'),
      json_extract(value,'$.fileKey'), json_extract(value,'$.isBundle'), json_extract(value,'$.slug'), json_extract(value,'$.sectionId'),
      json_extract(value,'$.resourceLabel'), json_extract(value,'$.tags'), json_extract(value,'$.metaTitle'), json_extract(value,'$.metaDescription'), json_extract(value,'$.seoKeywords'), json_extract(value,'$.sortOrder'), json_extract(value,'$.isPublished'),
      json_extract(value,'$.createdAt'), json_extract(value,'$.updatedAt')
    FROM json_each(?)`).bind(payload);
}

async function insertCard(env, card) {
  await cardInsertStatement(env, card).run();
  return card;
}

async function updateCard(env, card) {
  await env.DB.prepare(`UPDATE cards SET type=?,class_name=?,subject=?,title=?,description=?,price=?,link=?,file_key=?,is_bundle=?,slug=?,
      section_id=?,resource_label=?,tags=?,meta_title=?,meta_description=?,seo_keywords=?,sort_order=?,is_published=?,updated_at=? WHERE id=?`)
    .bind(card.type, card.className, card.subject, card.title, card.description, Number(card.price), card.link, card.fileKey,
      Number(card.isBundle), card.slug, card.sectionId || null, card.resourceLabel, JSON.stringify(card.tags), card.metaTitle, card.metaDescription, card.seoKeywords, card.sortOrder, Number(card.isPublished), card.updatedAt, card.id).run();
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
  const paymentDeliveryReady = canAcceptNewPayments(env);
  const cards = (await readPublicCards(env)).map((card) => publicCard(card, paymentDeliveryReady));
  const cardSlugs = new Set(cards.map((card) => card.slug));
  return [...cards, ...seedPapers().filter((paper) => !cardSlugs.has(paper.slug))];
}

function publicCardVisibilityClause() {
  return `c.is_published = 1 AND (c.section_id IS NULL OR (s.id IS NOT NULL AND s.is_published = 1
    AND (s.parent_id IS NULL OR (p.id IS NOT NULL AND p.is_published = 1))))`;
}

function cardFilterStatement(env, searchParams, limit = 100) {
  const className = String(searchParams.get('class') || '');
  const subject = String(searchParams.get('subject') || '').trim();
  const type = String(searchParams.get('type') || '');
  const tag = plainText(searchParams.get('tag') || '', 50, 'Tag').toLowerCase();
  const clauses = [publicCardVisibilityClause()];
  const bindings = [];
  if (ALLOWED_CLASSES.has(className)) { clauses.push('c.class_name = ?'); bindings.push(className); }
  if (subject) { clauses.push('LOWER(c.subject) = ?'); bindings.push(subject.toLowerCase()); }
  if (ALLOWED_TYPES.has(type)) { clauses.push('c.type = ?'); bindings.push(type); }
  if (tag) { clauses.push("EXISTS (SELECT 1 FROM json_each(COALESCE(c.tags, '[]')) WHERE LOWER(value) = ?)"); bindings.push(tag); }
  const statement = env.DB.prepare(cardSelectSql(clauses.join(' AND '), 'c.sort_order ASC, c.updated_at DESC', limit));
  return bindings.length ? statement.bind(...bindings) : statement;
}

async function filteredCards(env, searchParams, limit = 100) {
  const result = await cardFilterStatement(env, searchParams, limit).all();
  return (result.results || []).map(rowToCard);
}

function matchesPaper(paper, { query, className, subject, type, tag }) {
  const paperTags = Array.isArray(paper.tags) ? paper.tags : [];
  const haystack = `${paper.displayClassName || paper.className} ${paper.displayType || paper.type} ${paper.className} ${paper.subject} ${paper.type} ${paper.resourceLabel || ''} ${paperTags.join(' ')} ${paper.title} ${paper.description}`.toLowerCase();
  return (!className || paper.className === className)
    && (!subject || paper.subject.toLowerCase() === subject.toLowerCase())
    && (!type || paper.type === type)
    && (!tag || paperTags.some((paperTag) => paperTag === tag))
    && (!query || haystack.includes(query));
}

function ftsExpression(query) {
  const terms = [...new Set(String(query).match(/[a-z0-9]{3,}/g) || [])].slice(0, 12);
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ');
}

function searchTerms(searchParams) {
  const rawQuery = limitUtf8(String(searchParams.get('q') || '').trim().toLowerCase(), 100);
  const explicitClass = String(searchParams.get('class') || '');
  const classMatch = rawQuery.match(/\bclass\s*(10|11|12)\b/);
  const className = ALLOWED_CLASSES.has(explicitClass) ? explicitClass : (classMatch?.[1] || '');
  // Students naturally type queries such as "Class 10 Science". Class labels are
  // filters, not FTS terms, because the database stores the class as just "10".
  const query = rawQuery.replace(/\bclass\s*(10|11|12)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return { query, className };
}

async function filterPapers(env, searchParams) {
  const { query, className } = searchTerms(searchParams);
  const subject = String(searchParams.get('subject') || '').trim();
  const type = String(searchParams.get('type') || '');
  const tag = plainText(searchParams.get('tag') || '', 50, 'Tag').toLowerCase();
  const clauses = [publicCardVisibilityClause()];
  const bindings = [];
  if (ALLOWED_CLASSES.has(className)) { clauses.push('c.class_name = ?'); bindings.push(className); }
  if (subject) { clauses.push('LOWER(c.subject) = ?'); bindings.push(subject.toLowerCase()); }
  if (ALLOWED_TYPES.has(type)) { clauses.push('c.type = ?'); bindings.push(type); }
  if (tag) { clauses.push("EXISTS (SELECT 1 FROM json_each(COALESCE(c.tags, '[]')) WHERE LOWER(value) = ?)"); bindings.push(tag); }
  if (query) {
    const expression = ftsExpression(query);
    if (expression) {
      // `resource_label` was added after the legacy FTS index. Keep it
      // searchable without rebuilding that index (and keep all legacy search
      // terms on its fast FTS path).
      clauses.push("(c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?) OR instr(LOWER(COALESCE(c.resource_label, '')), ?) > 0 OR instr(LOWER(COALESCE(c.tags, '[]')), ?) > 0)");
      bindings.push(expression, query, query);
    } else {
      clauses.push("instr(LOWER(c.class_name || ' ' || c.subject || ' ' || c.type || ' ' || COALESCE(c.resource_label, '') || ' ' || COALESCE(c.tags, '[]') || ' ' || c.title || ' ' || c.description), ?) > 0");
      bindings.push(query);
    }
  }
  const statement = env.DB.prepare(cardSelectSql(clauses.join(' AND '), 'c.sort_order ASC, c.updated_at DESC', '100'));
  const boundStatement = bindings.length ? statement.bind(...bindings) : statement;
  const paymentDeliveryReady = canAcceptNewPayments(env);
  const custom = ((await boundStatement.all()).results || []).map(rowToCard).map((card) => publicCard(card, paymentDeliveryReady));
  const customSlugs = new Set(custom.map((paper) => paper.slug));
  const filters = { query, className, subject, type, tag };
  const seeds = seedPapers().filter((paper) => !customSlugs.has(paper.slug) && matchesPaper(paper, filters));
  return [...custom, ...seeds].slice(0, 100);
}

async function findPaperBySlug(env, slug) {
  const card = await getPublicCardBySlug(env, slug);
  if (card) return publicCard(card, canAcceptNewPayments(env));
  return seedPapers().find((paper) => paper.slug === slug) || null;
}

function publicSection(section) {
  return {
    id: section.id,
    parentId: section.parentId,
    title: section.title,
    slug: section.slug,
    description: section.description,
    icon: section.icon,
    tags: section.tags,
    metaTitle: section.metaTitle,
    metaDescription: section.metaDescription,
    seoKeywords: section.seoKeywords,
    sortOrder: section.sortOrder,
    isPublished: section.isPublished,
    showOnHome: section.showOnHome,
    updatedAt: section.updatedAt,
    cards: [],
    children: []
  };
}

async function publicCatalog(env) {
  const paymentDeliveryReady = canAcceptNewPayments(env);
  const allSections = await readSections(env);
  const sectionsById = new Map(allSections.map((section) => [section.id, section]));
  const visibleSections = allSections.filter((section) => section.isPublished
    && (!section.parentId || sectionsById.get(section.parentId)?.isPublished));
  const nodes = new Map(visibleSections.map((section) => [section.id, publicSection(section)]));
  const roots = [];
  for (const section of visibleSections) {
    const node = nodes.get(section.id);
    if (section.parentId) {
      const parent = nodes.get(section.parentId);
      if (parent) parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const unsectionedCards = [];
  for (const card of await readPublicCards(env)) {
    const target = card.sectionId ? nodes.get(card.sectionId) : null;
    if (target) target.cards.push(publicCard(card, paymentDeliveryReady));
    else if (!card.sectionId) unsectionedCards.push(publicCard(card, paymentDeliveryReady));
  }
  return { sections: roots, cards: unsectionedCards };
}

function sectionIsPubliclyVisible(section) {
  return Boolean(section?.isPublished)
    && (!section.parentId || Boolean(section.parentIsPublished));
}

async function getPublicSectionBySlug(env, slug) {
  const row = await env.DB.prepare(`SELECT s.*, p.title AS parent_section_title, p.slug AS parent_section_slug,
      p.is_published AS parent_section_is_published, p.parent_id AS parent_parent_id
    FROM catalog_sections AS s
    LEFT JOIN catalog_sections AS p ON p.id = s.parent_id
    WHERE s.slug = ? AND s.is_published = 1
      AND (s.parent_id IS NULL OR (p.id IS NOT NULL AND p.is_published = 1 AND p.parent_id IS NULL))`)
    .bind(slug).first();
  return row ? sectionContextFromRow(row) : null;
}

async function publicCollection(env, slug) {
  const section = await getPublicSectionBySlug(env, slug);
  if (!section) return null;
  const [childrenResult, cardsResult] = await Promise.all([
    env.DB.prepare('SELECT * FROM catalog_sections WHERE parent_id = ? AND is_published = 1 ORDER BY sort_order ASC, title COLLATE NOCASE ASC')
      .bind(section.id).all(),
    env.DB.prepare(cardSelectSql(`c.section_id = ? AND ${publicCardVisibilityClause()}`, 'c.sort_order ASC, c.updated_at DESC', '1000'))
      .bind(section.id).all()
  ]);
  const paymentDeliveryReady = canAcceptNewPayments(env);
  return {
    section,
    children: (childrenResult.results || []).map(rowToSection).map(publicSection),
    cards: (cardsResult.results || []).map(rowToCard).map((card) => publicCard(card, paymentDeliveryReady))
  };
}

async function signedDownloadToken(env, card, orderId = '') {
  // New payment flows bind the signed link to its order. This lets an admin
  // revoke one purchase without taking away access from other purchasers of
  // the same paper. Tokens issued before this change remain valid only for
  // their original short lifetime, preserving a completed purchase flow.
  const payload = base64UrlEncode(JSON.stringify({ cardId: card.id, fileKey: card.fileKey, orderId: orderId || undefined, exp: Date.now() + DOWNLOAD_DURATION_MS }));
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
  if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
  if (!hasSecureDownloadConfiguration(env)) {
    return json({ error: 'Secure downloads are not configured yet.' }, 503);
  }
  const data = await readDownloadToken(env, token);
  if (!data) return json({ error: 'This download link is invalid or has expired.' }, 403);
  let filename;
  try { filename = safePdfFilename(data.fileKey); } catch { return json({ error: 'This download link is invalid.' }, 403); }
  const card = await getCard(env, data.cardId);
  if (!card || !cardIsPubliclyVisible(card) || card.fileKey !== filename) return json({ error: 'This download link is no longer available.' }, 403);
  if (data.orderId) {
    const order = await getOrder(env, data.orderId);
    if (!order || order.card_id !== card.id || !await orderAccessAllowed(env, order)) {
      return json({ error: 'Access to this purchase is no longer available.' }, 403);
    }
  }
  let object;
  try {
    object = await readPaper(env, filename);
  } catch (error) {
    return apiErrorResponse(error, 'The protected PDF file could not be read. Please try again shortly.');
  }
  if (!object) return json({ error: 'The protected PDF file was not found.' }, 404);
  const headers = new Headers(securityHeaders('application/pdf'));
  object.writeHttpMetadata?.(headers);
  headers.set('Content-Disposition', `attachment; filename="${downloadPdfFilename(filename)}"`);
  headers.set('Cache-Control', 'private, no-store');
  if (Number.isSafeInteger(object.size) && object.size >= 0) headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

async function getOrder(env, id) {
  return env.DB.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').bind(id).first();
}

async function getStudent(env, id) {
  return env.DB.prepare('SELECT * FROM students WHERE id = ?').bind(id).first();
}

async function studentForEmail(env, email) {
  return env.DB.prepare('SELECT * FROM students WHERE email = ?').bind(email).first();
}

function rowToStudent(row, summary = {}) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    accessRevoked: isTrue(row.access_revoked),
    notes: row.notes || '',
    passwordResetRequestedAt: row.password_reset_requested_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    purchases: Number(summary.purchases || row.purchases || 0),
    paidOrders: Number(summary.paidOrders || row.paid_orders || 0),
    totalSpent: Number(summary.totalSpent || row.total_spent || 0)
  };
}

async function upsertStudent(env, { email, name = '' }) {
  if (!email) return null;
  const now = new Date().toISOString();
  // Payment webhooks and the browser callback can arrive at almost the same
  // time. A single UPSERT avoids the select-then-insert race that could make a
  // valid capture fail on the unique email constraint.
  const id = crypto.randomUUID();
  const student = await env.DB.prepare(`INSERT INTO students (id,email,name,access_revoked,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET
        name=CASE WHEN students.name = '' AND excluded.name <> '' THEN excluded.name ELSE students.name END,
        updated_at=excluded.updated_at
      RETURNING *`)
    .bind(id, email, name, 0, '', now, now).first();
  // D1 supports RETURNING. Keep a conservative lookup fallback for local
  // development adapters that do not expose returned write rows.
  return student || studentForEmail(env, email);
}

async function orderAccessAllowed(env, order) {
  if (!order || isTrue(order.access_revoked) || order.status === 'refunded') return false;
  if (!['captured', 'fulfilled'].includes(order.status)) return false;
  if (order.student_id) {
    const student = await getStudent(env, order.student_id);
    if (!student || isTrue(student.access_revoked)) return false;
  }
  return true;
}

async function attachOrderStudent(env, order, buyer = {}) {
  const email = cleanEmail(buyer.email || buyer.buyerEmail || order?.buyer_email || '');
  if (!email) return order;
  const name = plainText(buyer.name || buyer.buyerName || order?.buyer_name || '', 100, 'Student name');
  const student = await upsertStudent(env, { email, name });
  await env.DB.prepare(`UPDATE orders SET student_id=?,buyer_email=?,buyer_name=?,updated_at=? WHERE razorpay_order_id=?`)
    .bind(student.id, email, name || student.name || '', new Date().toISOString(), order.razorpay_order_id).run();
  return getOrder(env, order.razorpay_order_id);
}

function cleanCheckoutBuyer(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid checkout details.');
  return {
    email: cleanEmail(input.email || input.buyerEmail || '', { required: true }),
    name: plainText(input.name || input.buyerName || '', 100, 'Student name')
  };
}

async function saveOrder(env, { orderId, cardId, amount, currency, recoveryTokenHash, status = 'created', paymentId = null, expiresAt, recoveryExpiresAt, fulfilledAt = null, studentId = null, buyerEmail = '', buyerName = '' }) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO orders (razorpay_order_id,card_id,amount,currency,status,razorpay_payment_id,recovery_token_hash,student_id,buyer_email,buyer_name,access_revoked,revocation_reason,created_at,updated_at,expires_at,recovery_expires_at,fulfilled_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(razorpay_order_id) DO UPDATE SET status=excluded.status, razorpay_payment_id=COALESCE(excluded.razorpay_payment_id,orders.razorpay_payment_id), student_id=COALESCE(excluded.student_id,orders.student_id), buyer_email=CASE WHEN excluded.buyer_email != '' THEN excluded.buyer_email ELSE orders.buyer_email END, buyer_name=CASE WHEN excluded.buyer_name != '' THEN excluded.buyer_name ELSE orders.buyer_name END, updated_at=excluded.updated_at, fulfilled_at=COALESCE(excluded.fulfilled_at,orders.fulfilled_at)`)
    .bind(orderId, cardId, amount, currency, status, paymentId, recoveryTokenHash, studentId, buyerEmail, buyerName, 0, '', now, now, expiresAt, recoveryExpiresAt, fulfilledAt).run();
}

async function updateOrderStatus(env, orderId, status, paymentId = null, fulfilled = false) {
  if (!['captured', 'fulfilled'].includes(status) || !paymentId) throw new Error('Invalid successful payment status.');
  const now = new Date().toISOString();
  // Payment IDs are immutable once recorded. This prevents a late failed or
  // duplicate payment event from taking over a completed purchase.
  const result = await env.DB.prepare(`UPDATE orders
    SET status=CASE WHEN status='fulfilled' THEN 'fulfilled' ELSE ? END,
        razorpay_payment_id=CASE WHEN razorpay_payment_id IS NULL THEN ? ELSE razorpay_payment_id END,
        updated_at=?,
        fulfilled_at=CASE WHEN status='fulfilled' THEN fulfilled_at WHEN ? THEN COALESCE(fulfilled_at, ?) ELSE fulfilled_at END
    WHERE razorpay_order_id=? AND status <> 'refunded'
      AND (razorpay_payment_id IS NULL OR razorpay_payment_id=?)`)
    .bind(fulfilled ? 'fulfilled' : 'captured', paymentId, now, Number(fulfilled), now, orderId, paymentId).run();
  return Number(result.meta?.changes || 0) > 0;
}

async function recordFailedPaymentAttempt(env, orderId) {
  // A failed payment may be followed by a successful retry for the same
  // Razorpay order. Do not save the failed transaction ID and never downgrade
  // a captured or fulfilled order when webhook events arrive out of order.
  await env.DB.prepare("UPDATE orders SET status='failed',updated_at=? WHERE razorpay_order_id=? AND status IN ('created','failed')")
    .bind(new Date().toISOString(), orderId).run();
}

const ADMIN_ORDER_COLUMNS = `o.razorpay_order_id,o.card_id,o.amount,o.currency,o.status,o.razorpay_payment_id,
  o.student_id,o.buyer_email,o.buyer_name,o.access_revoked,o.revoked_at,o.revocation_reason,o.refunded_at,o.refund_note,
  o.created_at,o.updated_at,o.expires_at,o.recovery_expires_at,o.fulfilled_at,
  c.title AS card_title,c.slug AS card_slug,c.class_name AS card_class_name,c.subject AS card_subject,c.is_bundle AS card_is_bundle,
  s.email AS student_email,s.name AS student_name,s.access_revoked AS student_access_revoked`;

function rowToOrder(row) {
  if (!row) return null;
  const amountPaise = Number(row.amount || 0);
  return {
    id: row.razorpay_order_id,
    cardId: row.card_id,
    amount: amountPaise / 100,
    amountPaise,
    currency: row.currency,
    status: row.status,
    paymentId: row.razorpay_payment_id || null,
    buyerEmail: row.buyer_email || row.student_email || '',
    buyerName: row.buyer_name || row.student_name || '',
    accessRevoked: isTrue(row.access_revoked),
    revokedAt: row.revoked_at || null,
    revocationReason: row.revocation_reason || '',
    refundedAt: row.refunded_at || null,
    refundNote: row.refund_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    recoveryExpiresAt: row.recovery_expires_at,
    fulfilledAt: row.fulfilled_at || null,
    card: row.card_id ? {
      id: row.card_id,
      title: row.card_title || 'Deleted study material',
      slug: row.card_slug || '',
      className: row.card_class_name || '',
      subject: row.card_subject || '',
      isBundle: isTrue(row.card_is_bundle)
    } : null,
    student: row.student_id ? {
      id: row.student_id,
      email: row.student_email || row.buyer_email || '',
      name: row.student_name || row.buyer_name || '',
      accessRevoked: isTrue(row.student_access_revoked)
    } : null
  };
}

async function listAdminOrders(env, searchParams) {
  const requestedStatus = String(searchParams.get('status') || '').trim();
  const status = ORDER_STATUSES.has(requestedStatus) ? requestedStatus : '';
  const access = String(searchParams.get('access') || '').trim();
  const query = plainText(searchParams.get('q') || '', 100, 'Search').toLowerCase();
  const limit = boundedLimit(searchParams.get('limit'), 100);
  const offset = boundedOffset(searchParams.get('offset'));
  const clauses = ['1=1'];
  const bindings = [];
  if (status) { clauses.push('o.status = ?'); bindings.push(status); }
  if (access === 'revoked') clauses.push('o.access_revoked = 1');
  if (access === 'active') clauses.push("o.access_revoked = 0 AND o.status <> 'refunded'");
  if (query) {
    clauses.push("instr(LOWER(COALESCE(o.razorpay_order_id,'') || ' ' || COALESCE(o.buyer_email,'') || ' ' || COALESCE(o.buyer_name,'') || ' ' || COALESCE(c.title,'') || ' ' || COALESCE(s.email,'')), ?) > 0");
    bindings.push(query);
  }
  const statement = env.DB.prepare(`SELECT ${ADMIN_ORDER_COLUMNS} FROM orders AS o
    LEFT JOIN cards AS c ON c.id = o.card_id LEFT JOIN students AS s ON s.id = o.student_id
    WHERE ${clauses.join(' AND ')} ORDER BY o.created_at DESC LIMIT ? OFFSET ?`).bind(...bindings, limit + 1, offset);
  const result = await statement.all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  return {
    orders: rows.slice(0, limit).map(rowToOrder),
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

async function getAdminOrder(env, id) {
  const row = await env.DB.prepare(`SELECT ${ADMIN_ORDER_COLUMNS} FROM orders AS o
    LEFT JOIN cards AS c ON c.id = o.card_id LEFT JOIN students AS s ON s.id = o.student_id
    WHERE o.razorpay_order_id = ?`).bind(id).first();
  return rowToOrder(row);
}

async function updateAdminOrder(env, id, input) {
  const existing = await getOrder(env, id);
  if (!existing) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid order update.');
  const accessRevoked = optionalBoolean(input, 'accessRevoked', isTrue(existing.access_revoked));
  const markRefunded = optionalBoolean(input, 'markRefunded', false);
  const revocationReason = plainText(Object.prototype.hasOwnProperty.call(input, 'revocationReason') ? input.revocationReason : existing.revocation_reason || '', 500, 'Revocation reason', { multiline: true });
  const refundNote = plainText(Object.prototype.hasOwnProperty.call(input, 'refundNote') ? input.refundNote : existing.refund_note || '', 500, 'Refund note', { multiline: true });
  const now = new Date().toISOString();
  const refunded = markRefunded || existing.status === 'refunded';
  await env.DB.prepare(`UPDATE orders SET status=?,access_revoked=?,revoked_at=?,revocation_reason=?,refunded_at=?,refund_note=?,updated_at=?
    WHERE razorpay_order_id=?`).bind(
    refunded ? 'refunded' : existing.status,
    Number(refunded || accessRevoked),
    (refunded || accessRevoked) ? (existing.revoked_at || now) : null,
    revocationReason,
    refunded ? (existing.refunded_at || now) : null,
    refundNote,
    now,
    id
  ).run();
  return getAdminOrder(env, id);
}

async function listStudents(env, searchParams) {
  const query = plainText(searchParams.get('q') || '', 100, 'Search').toLowerCase();
  const limit = boundedLimit(searchParams.get('limit'), 100);
  const offset = boundedOffset(searchParams.get('offset'));
  const clauses = ['1=1'];
  const bindings = [];
  if (query) {
    clauses.push("instr(LOWER(s.email || ' ' || COALESCE(s.name,'')), ?) > 0");
    bindings.push(query);
  }
  const result = await env.DB.prepare(`SELECT s.*, COUNT(o.razorpay_order_id) AS purchases,
      SUM(CASE WHEN o.status IN ('captured','fulfilled') AND o.refunded_at IS NULL THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN o.status IN ('captured','fulfilled') AND o.refunded_at IS NULL THEN o.amount ELSE 0 END) AS total_spent
    FROM students AS s LEFT JOIN orders AS o ON o.student_id = s.id
    WHERE ${clauses.join(' AND ')} GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`).bind(...bindings, limit + 1, offset).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  return {
    students: rows.slice(0, limit).map((row) => rowToStudent(row)),
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

async function getAdminStudent(env, id) {
  const row = await env.DB.prepare(`SELECT s.*, COUNT(o.razorpay_order_id) AS purchases,
      SUM(CASE WHEN o.status IN ('captured','fulfilled') AND o.refunded_at IS NULL THEN 1 ELSE 0 END) AS paid_orders,
      SUM(CASE WHEN o.status IN ('captured','fulfilled') AND o.refunded_at IS NULL THEN o.amount ELSE 0 END) AS total_spent
    FROM students AS s LEFT JOIN orders AS o ON o.student_id = s.id WHERE s.id = ? GROUP BY s.id`).bind(id).first();
  if (!row) return null;
  const orderRows = await env.DB.prepare(`SELECT ${ADMIN_ORDER_COLUMNS} FROM orders AS o
    LEFT JOIN cards AS c ON c.id = o.card_id LEFT JOIN students AS s ON s.id = o.student_id
    WHERE o.student_id = ? ORDER BY o.created_at DESC LIMIT 100`).bind(id).all();
  return { student: rowToStudent(row), orders: (orderRows.results || []).map(rowToOrder) };
}

async function updateAdminStudent(env, id, input) {
  const existing = await getStudent(env, id);
  if (!existing) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid student update.');
  const name = plainText(Object.prototype.hasOwnProperty.call(input, 'name') ? input.name : existing.name || '', 100, 'Student name');
  const notes = plainText(Object.prototype.hasOwnProperty.call(input, 'notes') ? input.notes : existing.notes || '', 2000, 'Student notes', { multiline: true });
  const accessRevoked = optionalBoolean(input, 'accessRevoked', isTrue(existing.access_revoked));
  await env.DB.prepare('UPDATE students SET name=?,notes=?,access_revoked=?,updated_at=? WHERE id=?')
    .bind(name, notes, Number(accessRevoked), new Date().toISOString(), id).run();
  return getAdminStudent(env, id);
}

async function requestStudentPasswordReset(env, id) {
  const student = await getStudent(env, id);
  if (!student) return null;
  const now = new Date().toISOString();
  // There is deliberately no student-login password in this product yet. We
  // retain a support audit record rather than pretending an email was sent.
  await env.DB.prepare('UPDATE students SET password_reset_requested_at=?,updated_at=? WHERE id=?').bind(now, now, id).run();
  return { student: rowToStudent(await getStudent(env, id)), message: 'Password reset request logged. Student sign-in is not enabled yet, so no reset email was sent.' };
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToPromotion(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description || '',
    kind: row.kind,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value || 0),
    appliesTo: parseJsonArray(row.applies_to),
    bundleCardIds: parseJsonArray(row.bundle_card_ids),
    billingInterval: row.billing_interval,
    startsAt: row.starts_at || null,
    endsAt: row.ends_at || null,
    maxRedemptions: Number(row.max_redemptions || 0),
    redemptions: Number(row.redemptions || 0),
    isActive: isTrue(row.is_active),
    checkoutEnabled: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function cleanPromotion(input, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid promotion details.');
  const supplied = (field, fallback = '') => Object.prototype.hasOwnProperty.call(input, field) ? input[field] : fallback;
  const code = plainText(supplied('code', existing?.code || ''), 32, 'Promotion code', { required: true }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) throw new Error('Promotion code must use 3–32 letters, numbers, hyphens, or underscores.');
  const kind = String(supplied('kind', existing?.kind || 'discount')).toLowerCase();
  if (!PROMOTION_KINDS.has(kind)) throw new Error('Choose a valid promotion type.');
  const discountType = String(supplied('discountType', existing?.discountType || 'percent')).toLowerCase();
  if (!PROMOTION_DISCOUNT_TYPES.has(discountType)) throw new Error('Choose a valid discount type.');
  const rawDiscount = Number(supplied('discountValue', existing?.discountValue || 0));
  const maxDiscount = discountType === 'percent' ? 100 : 100_000;
  if (!Number.isSafeInteger(rawDiscount) || rawDiscount < 0 || rawDiscount > maxDiscount) throw new Error('Enter a valid promotion value.');
  const appliesTo = (Array.isArray(supplied('appliesTo', existing?.appliesTo || [])) ? supplied('appliesTo', existing?.appliesTo || []) : []).map((id) => optionalIdentifier(id, 'Promotion scope'));
  const bundleCardIds = (Array.isArray(supplied('bundleCardIds', existing?.bundleCardIds || [])) ? supplied('bundleCardIds', existing?.bundleCardIds || []) : []).map((id) => optionalIdentifier(id, 'Bundle card'));
  if (appliesTo.length > 100 || bundleCardIds.length > 100) throw new Error('A promotion can target no more than 100 items.');
  const startsAt = optionalIsoDate(supplied('startsAt', existing?.startsAt || ''), 'Start date');
  const endsAt = optionalIsoDate(supplied('endsAt', existing?.endsAt || ''), 'End date');
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) throw new Error('End date must be after the start date.');
  const maxRedemptions = optionalSortOrder(input, 'maxRedemptions', existing?.maxRedemptions || 0);
  if (maxRedemptions < 0) throw new Error('Maximum redemptions cannot be negative.');
  const billingInterval = String(supplied('billingInterval', existing?.billingInterval || 'none')).toLowerCase();
  if (!PROMOTION_INTERVALS.has(billingInterval)) throw new Error('Choose a valid billing interval.');
  const now = new Date().toISOString();
  return {
    id: existing?.id || crypto.randomUUID(), code,
    title: plainText(supplied('title', existing?.title || ''), 120, 'Promotion title', { required: true }),
    description: plainText(supplied('description', existing?.description || ''), 500, 'Promotion description', { multiline: true }),
    kind, discountType, discountValue: rawDiscount,
    appliesTo: [...new Set(appliesTo.filter(Boolean))], bundleCardIds: [...new Set(bundleCardIds.filter(Boolean))], billingInterval,
    startsAt, endsAt, maxRedemptions,
    redemptions: existing?.redemptions || 0,
    isActive: optionalBoolean(input, 'isActive', existing?.isActive || false),
    createdAt: existing?.createdAt || now, updatedAt: now
  };
}

async function promotionCodeAvailable(env, code, existingId) {
  const row = await env.DB.prepare('SELECT id FROM promotions WHERE code = ? COLLATE NOCASE').bind(code).first();
  return !row || row.id === existingId;
}

function promotionStatement(env, promotion) {
  return env.DB.prepare(`INSERT INTO promotions (id,code,title,description,kind,discount_type,discount_value,applies_to,bundle_card_ids,billing_interval,starts_at,ends_at,max_redemptions,redemptions,is_active,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(promotion.id, promotion.code, promotion.title, promotion.description, promotion.kind, promotion.discountType, promotion.discountValue,
      JSON.stringify(promotion.appliesTo), JSON.stringify(promotion.bundleCardIds), promotion.billingInterval, promotion.startsAt || null, promotion.endsAt || null,
      promotion.maxRedemptions, promotion.redemptions, Number(promotion.isActive), promotion.createdAt, promotion.updatedAt);
}

async function listPromotions(env) {
  const result = await env.DB.prepare('SELECT * FROM promotions ORDER BY is_active DESC, updated_at DESC LIMIT 500').all();
  return (result.results || []).map(rowToPromotion);
}

async function getPromotion(env, id) {
  return rowToPromotion(await env.DB.prepare('SELECT * FROM promotions WHERE id = ?').bind(id).first());
}

async function createPromotion(env, input) {
  const promotion = cleanPromotion(input);
  if (!await promotionCodeAvailable(env, promotion.code, promotion.id)) throw new Error('That promotion code already exists.');
  await promotionStatement(env, promotion).run();
  return getPromotion(env, promotion.id);
}

async function updatePromotion(env, id, input) {
  const existing = await getPromotion(env, id);
  if (!existing) return null;
  const promotion = cleanPromotion(input, existing);
  if (!await promotionCodeAvailable(env, promotion.code, promotion.id)) throw new Error('That promotion code already exists.');
  await env.DB.prepare(`UPDATE promotions SET code=?,title=?,description=?,kind=?,discount_type=?,discount_value=?,applies_to=?,bundle_card_ids=?,billing_interval=?,starts_at=?,ends_at=?,max_redemptions=?,is_active=?,updated_at=? WHERE id=?`)
    .bind(promotion.code, promotion.title, promotion.description, promotion.kind, promotion.discountType, promotion.discountValue,
      JSON.stringify(promotion.appliesTo), JSON.stringify(promotion.bundleCardIds), promotion.billingInterval, promotion.startsAt || null, promotion.endsAt || null,
      promotion.maxRedemptions, Number(promotion.isActive), promotion.updatedAt, id).run();
  return getPromotion(env, id);
}

function rowToFeedback(row) {
  if (!row) return null;
  return {
    id: row.id,
    cardId: row.card_id || null,
    slug: row.slug || '',
    title: row.resource_title || '',
    category: row.category || 'general',
    email: row.email || '',
    name: row.name || '',
    message: row.message,
    status: row.status,
    adminNote: row.admin_note || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at || null
  };
}

async function createFeedback(env, request, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid feedback request.');
  const slug = String(input.slug || '').trim().toLowerCase();
  if (slug && !/^[a-z0-9-]{1,110}$/.test(slug)) throw new Error('Invalid study material reference.');
  const card = slug ? await getPublicCardBySlug(env, slug) : null;
  const title = plainText(input.title || card?.title || '', 140, 'Study material title');
  const category = plainText(input.category || 'general', 50, 'Feedback category').toLowerCase();
  const message = plainText(input.message, 2000, 'Feedback message', { required: true, multiline: true });
  // The public feedback form intentionally has no contact fields. Ignore any
  // hand-crafted email/name payload rather than turning a content report into
  // an unsolicited personal-data collection endpoint.
  const email = '';
  const name = '';
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO feedback (id,card_id,slug,resource_title,category,email,name,message,status,admin_note,client_hash,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, card?.id || null, slug, title, category, email, name, message, 'open', '', '', now, now).run();
  return id;
}

async function listFeedback(env, searchParams) {
  const requestedStatus = String(searchParams.get('status') || '').trim();
  const status = FEEDBACK_STATUSES.has(requestedStatus) ? requestedStatus : '';
  const query = plainText(searchParams.get('q') || '', 100, 'Search').toLowerCase();
  const limit = boundedLimit(searchParams.get('limit'), 100);
  const offset = boundedOffset(searchParams.get('offset'));
  const clauses = ['1=1'];
  const bindings = [];
  if (status) { clauses.push('status = ?'); bindings.push(status); }
  if (query) {
    clauses.push("instr(LOWER(COALESCE(resource_title,'') || ' ' || COALESCE(slug,'') || ' ' || COALESCE(category,'') || ' ' || COALESCE(email,'') || ' ' || message), ?) > 0");
    bindings.push(query);
  }
  const result = await env.DB.prepare(`SELECT * FROM feedback WHERE ${clauses.join(' AND ')} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, created_at DESC LIMIT ? OFFSET ?`).bind(...bindings, limit + 1, offset).all();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  return {
    feedback: rows.slice(0, limit).map(rowToFeedback),
    hasMore,
    nextOffset: hasMore ? offset + limit : null
  };
}

async function getFeedback(env, id) {
  return rowToFeedback(await env.DB.prepare('SELECT * FROM feedback WHERE id = ?').bind(id).first());
}

async function updateFeedback(env, id, input) {
  const existing = await getFeedback(env, id);
  if (!existing) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid feedback update.');
  const status = String(Object.prototype.hasOwnProperty.call(input, 'status') ? input.status : existing.status).toLowerCase();
  if (!FEEDBACK_STATUSES.has(status)) throw new Error('Choose a valid feedback status.');
  const adminNote = plainText(Object.prototype.hasOwnProperty.call(input, 'adminNote') ? input.adminNote : existing.adminNote, 2000, 'Admin note', { multiline: true });
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE feedback SET status=?,admin_note=?,resolved_at=?,updated_at=? WHERE id=?')
    .bind(status, adminNote, ['resolved', 'closed'].includes(status) ? (existing.resolvedAt || now) : null, now, id).run();
  return getFeedback(env, id);
}

async function recordVisit(env, request, now = new Date()) {
  if (!await consumeRateLimit(request, env, 'analytics_attempts', ANALYTICS_WINDOW_MS, MAX_ANALYTICS_EVENTS)) return false;
  const day = istDayKey(now);
  const nowIso = now.toISOString();
  const visitorHash = await clientHash(request, env, `analytics-visitor:${day}`);
  if (!visitorHash) return false;
  await env.DB.prepare(`INSERT INTO analytics_daily (day,visits,unique_visitors,created_at,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(day) DO UPDATE SET visits=analytics_daily.visits + 1,updated_at=excluded.updated_at`).bind(day, 1, 0, nowIso, nowIso).run();
  const visitor = await env.DB.prepare('INSERT OR IGNORE INTO analytics_visitors (day,visitor_hash,created_at) VALUES (?,?,?)').bind(day, visitorHash, nowIso).run();
  if (Number(visitor.meta?.changes)) {
    await env.DB.prepare('UPDATE analytics_daily SET unique_visitors=unique_visitors + 1,updated_at=? WHERE day=?').bind(nowIso, day).run();
  }
  return true;
}

async function cleanupExpiredRecords(env, now = new Date()) {
  const rateLimitCutoff = now.getTime() - RATE_LIMIT_RETENTION_MS;
  const visitorCutoff = istDayKeyDaysAgo(ANALYTICS_VISITOR_RETENTION_DAYS, now);
  const dailyCutoff = istDayKeyDaysAgo(ANALYTICS_DAILY_RETENTION_DAYS, now);
  const nowIso = now.toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').bind(now.getTime()),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_started_at < ?').bind(rateLimitCutoff),
    env.DB.prepare('DELETE FROM checkout_attempts WHERE window_started_at < ?').bind(rateLimitCutoff),
    env.DB.prepare('DELETE FROM analytics_attempts WHERE window_started_at < ?').bind(rateLimitCutoff),
    env.DB.prepare('DELETE FROM feedback_attempts WHERE window_started_at < ?').bind(rateLimitCutoff),
    env.DB.prepare('DELETE FROM analytics_visitors WHERE day < ?').bind(visitorCutoff),
    env.DB.prepare('DELETE FROM analytics_daily WHERE day < ?').bind(dailyCutoff),
    // An unfinished or failed checkout can be recovered only while its
    // short-lived cookie is valid. Once that window has passed, retain the
    // non-personal order audit but remove buyer contact data and replace the
    // one-time recovery-token hash. The replacement stays unique because the
    // historic schema marks that column UNIQUE, yet cannot match a browser
    // recovery cookie. Captured, fulfilled, and refunded purchases are
    // deliberately excluded from this privacy cleanup.
    env.DB.prepare(`UPDATE orders
      SET buyer_email='', buyer_name='', recovery_token_hash='expired:' || razorpay_order_id, updated_at=?
      WHERE status IN ('created','failed') AND recovery_expires_at < ?
        AND (buyer_email <> '' OR buyer_name <> '' OR recovery_token_hash NOT LIKE 'expired:%')`).bind(nowIso, nowIso)
  ]);
}

async function dashboardSummary(env, now = new Date()) {
  const today = istDayKey(now);
  const monthStart = istMonthStartIso(now);
  const dayStart = istDayStartIso(now);
  const [analytics, todayRevenue, monthRevenue, totalRevenue, orders, students, feedbackOpen, promotions, topRows] = await Promise.all([
    env.DB.prepare('SELECT visits,unique_visitors FROM analytics_daily WHERE day = ?').bind(today).first(),
    env.DB.prepare("SELECT COUNT(*) AS orders,COALESCE(SUM(amount),0) AS revenue FROM orders WHERE status IN ('captured','fulfilled') AND refunded_at IS NULL AND created_at >= ?").bind(dayStart).first(),
    env.DB.prepare("SELECT COUNT(*) AS orders,COALESCE(SUM(amount),0) AS revenue FROM orders WHERE status IN ('captured','fulfilled') AND refunded_at IS NULL AND created_at >= ?").bind(monthStart).first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS revenue FROM orders WHERE status IN ('captured','fulfilled') AND refunded_at IS NULL").first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM orders').first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM students').first(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM feedback WHERE status IN ('open','in_progress')").first(),
    env.DB.prepare('SELECT COUNT(*) AS count FROM promotions WHERE is_active = 1').first(),
    env.DB.prepare(`SELECT c.id,c.title,c.slug,c.class_name,c.subject,COUNT(o.razorpay_order_id) AS purchases,COALESCE(SUM(o.amount),0) AS revenue
      FROM orders AS o INNER JOIN cards AS c ON c.id = o.card_id
      WHERE o.status IN ('captured','fulfilled') AND o.refunded_at IS NULL
      GROUP BY c.id ORDER BY revenue DESC,purchases DESC,c.title COLLATE NOCASE ASC LIMIT 5`).all()
  ]);
  return {
    generatedAt: now.toISOString(),
    users: { dailyActive: Number(analytics?.unique_visitors || 0), dailyVisits: Number(analytics?.visits || 0), students: Number(students?.count || 0) },
    revenue: { today: Number(todayRevenue?.revenue || 0) / 100, month: Number(monthRevenue?.revenue || 0) / 100, allTime: Number(totalRevenue?.revenue || 0) / 100, todayOrders: Number(todayRevenue?.orders || 0), monthOrders: Number(monthRevenue?.orders || 0) },
    orders: { total: Number(orders?.count || 0) },
    feedback: { open: Number(feedbackOpen?.count || 0) },
    promotions: { active: Number(promotions?.count || 0), checkoutEnabled: false },
    topPapers: (topRows.results || []).map((row) => ({ id: row.id, title: row.title, slug: row.slug, className: row.class_name, subject: row.subject, purchases: Number(row.purchases || 0), revenue: Number(row.revenue || 0) / 100 }))
  };
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

async function sectionHasActivePaidDownloads(env, sectionId) {
  const cutoff = new Date(Date.now() - DOWNLOAD_DURATION_MS).toISOString();
  const result = await env.DB.prepare(`SELECT 1 AS active FROM orders AS o INNER JOIN cards AS c ON c.id = o.card_id
    WHERE (c.section_id = ? OR c.section_id IN (SELECT id FROM catalog_sections WHERE parent_id = ?))
      AND o.status IN ('captured','fulfilled') AND o.recovery_expires_at >= ? LIMIT 1`)
    .bind(sectionId, sectionId, cutoff).first();
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

async function razorpayFetch(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RAZORPAY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new UpstreamServiceError('The payment service is unavailable right now. Please try again in a moment.');
  } finally {
    clearTimeout(timeout);
  }
}

function paymentMatchesOrder(payment, order) {
  return typeof payment?.id === 'string'
    && /^[A-Za-z0-9_]{6,120}$/.test(payment.id)
    && payment.order_id === order?.razorpay_order_id
    && Number.isSafeInteger(Number(payment.amount))
    && Number(payment.amount) === Number(order?.amount)
    && String(payment.currency || '').toUpperCase() === String(order?.currency || '').toUpperCase();
}

async function razorpayPayment(env, order, paymentId) {
  const upstream = await razorpayFetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: razorpayAuthorization(env) }
  });
  const payment = await upstream.json().catch(() => ({}));
  if (!upstream.ok || !paymentMatchesOrder(payment, order)) {
    throw new Error('Payment details could not be confirmed.');
  }
  if (payment.status !== 'captured') throw new Error('Payment is still being processed. Please wait a moment and try again.');
  return payment;
}

async function paymentWebhook(request, env) {
  if (!hasPaymentDeliveryConfiguration(env)) return paymentDeliveryUnavailableResponse(env);
  try {
    const raw = await readBodyBytes(request, MAX_WEBHOOK_BYTES);
    const signature = request.headers.get('X-Razorpay-Signature') || '';
    const expected = await hmac(raw, env.RAZORPAY_WEBHOOK_SECRET);
    if (!(await secureEqual(signature, expected))) return json({ error: 'Invalid webhook signature.' }, 400);
    let event;
    try { event = JSON.parse(decoder.decode(raw)); } catch { throw new RequestBodyError('Invalid webhook payload.'); }
    const payment = event?.payload?.payment?.entity;
    if (!payment?.order_id) return json({ ok: true });
    const order = await getOrder(env, payment.order_id);
    if (!order) return json({ ok: true });
    if (event.event === 'payment.captured' && payment.status === 'captured' && paymentMatchesOrder(payment, order)) {
      const recorded = await updateOrderStatus(env, payment.order_id, 'captured', payment.id);
      // Prefer the buyer details the checkout collected, falling back to the
      // provider response for older orders. This preserves a customer name
      // that Razorpay does not return on every webhook payload.
      if (recorded && !order.student_id && (order.buyer_email || payment.email)) {
        try {
          await attachOrderStudent(env, order, {
            email: order.buyer_email || payment.email,
            name: order.buyer_name || payment.contact_name || ''
          });
        } catch { /* optional profile creation must not reject a valid webhook */ }
      }
    }
    if (event.event === 'payment.failed' && payment.status === 'failed') await recordFailedPaymentAttempt(env, payment.order_id);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof RequestBodyError) return apiErrorResponse(error, 'Invalid webhook payload.');
    return json({ error: 'Invalid webhook payload.' }, 400);
  }
}

async function authenticated(request, env) {
  const token = parseCookies(request).admin_session;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).first();
  const now = Date.now();
  const expiresAt = Number(session?.expires_at);
  if (!session || !Number.isFinite(expiresAt) || expiresAt < now) {
    if (session) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
    return false;
  }
  // A dashboard can poll several endpoints. Renewing on every request turns
  // those reads into D1 writes, so renew only once the session is halfway old.
  if (expiresAt - now <= SESSION_DURATION_MS / 2) {
    await env.DB.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_DURATION_MS, tokenHash).run();
  }
  return true;
}

function clientHashSecret(env) {
  // A dedicated CLIENT_HASH_SECRET can be added later. Until then, use an
  // existing server-only secret rather than a plain SHA-256 IP hash, which is
  // enumerable and can be correlated across otherwise unrelated tables.
  const candidates = [env?.CLIENT_HASH_SECRET, env?.DOWNLOAD_TOKEN_SECRET, env?.ADMIN_PASSWORD, env?.RAZORPAY_KEY_SECRET];
  return candidates.find((candidate) => typeof candidate === 'string' && candidate.length >= 12) || '';
}

async function clientHash(request, env, purpose) {
  const secret = clientHashSecret(env);
  if (!secret) return '';
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return hmac(`${purpose}\u0000${ip}`, secret);
}

function istDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts
    .filter((part) => ['year', 'month', 'day'].includes(part.type))
    .map((part) => [part.type, part.value]));
  return { year: value.year, month: value.month, day: value.day };
}

function istDayKey(date = new Date()) {
  const { year, month, day } = istDateParts(date);
  return `${year}-${month}-${day}`;
}

function istDayStartIso(date = new Date()) {
  return new Date(`${istDayKey(date)}T00:00:00.000+05:30`).toISOString();
}

function istMonthStartIso(date = new Date()) {
  const { year, month } = istDateParts(date);
  return new Date(`${year}-${month}-01T00:00:00.000+05:30`).toISOString();
}

function istDayKeyDaysAgo(days, now = new Date()) {
  const { year, month, day } = istDateParts(now);
  // Treat the India calendar date as a UTC calendar value only for arithmetic;
  // the result is formatted back as a YYYY-MM-DD key, so daylight saving in
  // the host/runtime cannot affect the retention boundary.
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) - days)).toISOString().slice(0, 10);
}

async function consumeRateLimit(request, env, table, windowMs, maxAttempts) {
  if (!new Set(['login_attempts', 'checkout_attempts', 'analytics_attempts', 'feedback_attempts']).has(table)) throw new Error('Invalid rate limit table.');
  const ipHash = await clientHash(request, env, `rate-limit:${table}`);
  // Do not fall back to a predictable hash or an unbounded unauthenticated
  // endpoint when deployment secrets are absent. Callers treat false as a
  // closed admission decision.
  if (!ipHash) return false;
  const now = Date.now();
  const cutoff = now - windowMs;
  // The WHERE clause makes the mutation itself the admission decision. A
  // request that arrives after the limit is reached returns no row, so parallel
  // requests cannot all pass a separate read-before-write check.
  const attempt = await env.DB.prepare(`INSERT INTO ${table} (client_hash,count,window_started_at) VALUES (?,?,?)
    ON CONFLICT(client_hash) DO UPDATE SET count=CASE WHEN ${table}.window_started_at < ? THEN 1 ELSE ${table}.count + 1 END,
    window_started_at=CASE WHEN ${table}.window_started_at < ? THEN excluded.window_started_at ELSE ${table}.window_started_at END
    WHERE ${table}.window_started_at < ? OR ${table}.count < ?
    RETURNING count, window_started_at`)
    .bind(ipHash, 1, now, cutoff, cutoff, cutoff, maxAttempts).first();
  return Boolean(attempt);
}

async function recordFailedLogin(request, env) {
  return consumeRateLimit(request, env, 'login_attempts', LOGIN_WINDOW_MS, MAX_LOGIN_ATTEMPTS);
}

async function clearLoginAttempts(request, env) {
  const ipHash = await clientHash(request, env, 'rate-limit:login_attempts');
  if (!ipHash) return;
  await env.DB.prepare('DELETE FROM login_attempts WHERE client_hash = ?').bind(ipHash).run();
}

function adminCookie(token, maxAge, secure) {
  return `admin_session=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function recoveryCookieName(orderId) {
  const id = String(orderId || '');
  return /^[A-Za-z0-9_-]{1,160}$/.test(id) ? `purchase_recovery_${id}` : '';
}

function recoveryCookie(orderId, token, maxAge, secure) {
  const name = recoveryCookieName(orderId);
  if (!name || !/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) {
    throw new Error('The purchase recovery session could not be created.');
  }
  // Keep the bearer token out of JavaScript and restrict the browser to send
  // it only to the recovery endpoint. Local HTTP development intentionally
  // omits Secure; every HTTPS deployment receives the Secure attribute.
  return `${name}=${token}; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/api/payment/recover; Max-Age=${maxAge}`;
}

function clearRecoveryCookie(orderId, secure) {
  const name = recoveryCookieName(orderId);
  if (!name) return '';
  return `${name}=; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Strict; Path=/api/payment/recover; Max-Age=0`;
}

async function listPdfFiles(env) {
  await requireReadyPaperStorage(env);
  if (hasSupabasePaperStorage(env) && !hasR2PaperStorage(env)) {
    const files = [];
    const limit = 1000;
    for (let offset = 0; offset < 20_000; offset += limit) {
      const response = await supabaseStorageFetch(env, `/object/list/${encodeURIComponent(SUPABASE_PAPER_BUCKET)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: '', limit, offset, sortBy: { column: 'name', order: 'asc' } })
      });
      if (!response.ok) await storageResponseError(response, 'The private PDF library could not be listed. Please check the Supabase connection.');
      const page = await response.json().catch(() => null);
      if (!Array.isArray(page)) throw new UpstreamServiceError('The private PDF library returned an invalid response. Please try again shortly.');
      files.push(...page.map((object) => String(object?.name || '')).filter((name) => /\.pdf$/i.test(name)));
      if (page.length < limit) break;
    }
    return [...new Set(files)].sort((left, right) => left.localeCompare(right));
  }
  const papers = env.PAPERS;
  const files = [];
  let cursor;
  do {
    const page = await papers.list({ cursor, limit: 1000 });
    files.push(...page.objects.filter((object) => /\.pdf$/i.test(object.key)).map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return files.sort((left, right) => left.localeCompare(right));
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(field); field = ''; continue; }
    if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; continue; }
    field += character;
  }
  if (quoted) throw new Error('The CSV contains an unclosed quoted value.');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) throw new Error('The CSV does not contain any rows.');
  const headers = rows.shift().map((header) => String(header).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''));
  if (!headers.some(Boolean)) throw new Error('The CSV needs a header row.');
  return rows.filter((values) => values.some((value) => String(value).trim())).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function bulkMetadata(formData) {
  const entry = formData.get('metadata') || formData.get('csv') || formData.get('cards');
  if (!entry) throw new Error('Add a CSV or JSON metadata file for the uploaded PDFs.');
  const text = typeof entry === 'string' ? entry : await entry.text();
  if (encoder.encode(text).byteLength > MAX_BULK_METADATA_BYTES) throw new Error('Bulk metadata must be smaller than 1 MB.');
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Bulk metadata is empty.');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('Bulk JSON metadata is invalid.'); }
    const cards = Array.isArray(parsed) ? parsed : parsed.cards;
    if (!Array.isArray(cards)) throw new Error('Bulk JSON metadata needs a cards array.');
    return cards;
  }
  return parseCsv(trimmed);
}

function bulkRowValue(row, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name) && row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== '') return row[name];
  }
  return '';
}

function bulkCardInput(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Bulk metadata contains an invalid study card.');
  // JSON imports use the public camelCase keys; CSV headers are normalized by
  // parseCsv, so accept both without ever evaluating spreadsheet formulas.
  const suppliedPublishState = bulkRowValue(row, 'isPublished', 'ispublished');
  return {
    fileKey: bulkRowValue(row, 'fileKey', 'filekey', 'filename', 'file', 'pdf'),
    title: bulkRowValue(row, 'title'),
    description: bulkRowValue(row, 'description'),
    sectionId: bulkRowValue(row, 'sectionId', 'sectionid'),
    className: bulkRowValue(row, 'className', 'classname', 'class'),
    subject: bulkRowValue(row, 'subject'),
    type: bulkRowValue(row, 'type'),
    resourceLabel: bulkRowValue(row, 'resourceLabel', 'resourcelabel'),
    link: bulkRowValue(row, 'link', 'previewlink'),
    tags: bulkRowValue(row, 'tags'),
    metaTitle: bulkRowValue(row, 'metaTitle', 'metatitle'),
    metaDescription: bulkRowValue(row, 'metaDescription', 'metadescription'),
    seoKeywords: bulkRowValue(row, 'seoKeywords', 'seokeywords', 'keywords'),
    slug: bulkRowValue(row, 'slug'),
    sortOrder: bulkRowValue(row, 'sortOrder', 'sortorder'),
    // Bulk uploads are intentionally conservative: the editor must explicitly
    // write true in the CSV/JSON before a newly uploaded card can be public.
    isPublished: suppliedPublishState === '' ? false : suppliedPublishState,
    isBundle: bulkRowValue(row, 'isBundle', 'isbundle'),
    price: bulkRowValue(row, 'price')
  };
}

function isFileEntry(value) {
  return value && typeof value === 'object' && typeof value.name === 'string' && typeof value.stream === 'function';
}

async function bulkUpload(env, request) {
  if (!hasPaperStorage(env)) throw new PaperStorageUnavailableError();
  // `Request.formData()` parses the whole multipart request before individual
  // File streams are available. Refuse unknown-length/chunked uploads first so
  // an authenticated browser cannot make the Worker buffer an unbounded body.
  requiredContentLength(request, MAX_BULK_UPLOAD_BYTES, 'Bulk upload');
  const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) throw new Error('Bulk upload must use multipart form data.');
  const formData = await request.formData();
  const files = [...formData.getAll('files'), ...formData.getAll('pdfs')].filter(isFileEntry);
  if (!files.length) throw new Error('Choose at least one PDF file.');
  if (files.length > MAX_BULK_PDF_FILES) throw new Error(`Upload no more than ${MAX_BULK_PDF_FILES} PDFs at a time.`);
  const metadata = await bulkMetadata(formData);
  if (!metadata.length || metadata.length > MAX_BULK_PDF_FILES) throw new Error(`Bulk metadata must contain 1–${MAX_BULK_PDF_FILES} cards.`);
  const storageContext = newStorageOperationContext();
  await requireReadyPaperStorage(env, storageContext);
  const fileByName = new Map();
  for (const file of files) {
    const filename = safePdfFilename(file.name);
    if (file.size < 5 || file.size > MAX_PDF_BYTES) throw new Error(`PDF ${filename} must be between 5 bytes and 25 MB.`);
    if (file.type && file.type !== 'application/pdf') throw new Error(`PDF ${filename} has an invalid file type.`);
    if (fileByName.has(filename)) throw new Error(`PDF ${filename} was added more than once.`);
    fileByName.set(filename, { file, storageKey: await newBulkStorageKey(env, filename, storageContext) });
  }
  const cardInputs = metadata.map(bulkCardInput);
  const metadataFiles = new Set();
  for (const cardInput of cardInputs) {
    const filename = safePdfFilename(cardInput.fileKey);
    const upload = fileByName.get(filename);
    if (!upload) throw new Error(`Metadata references ${filename}, but that PDF was not uploaded.`);
    if (metadataFiles.has(filename)) throw new Error(`Metadata references ${filename} more than once.`);
    metadataFiles.add(filename);
    cardInput.fileKey = upload.storageKey;
  }
  if (metadataFiles.size !== fileByName.size) throw new Error('Each uploaded PDF needs exactly one metadata row.');
  const uploaded = [];
  try {
    for (const { storageKey, file } of fileByName.values()) {
      // Track it before awaiting storage: a failed streamed write may still have
      // created an object. Keys are generated per batch, so cleanup can never
      // remove another upload that happened to use the same display filename.
      uploaded.push(storageKey);
      await writePaper(env, storageKey, pdfUploadStream(file.stream()), storageContext);
      storageContext.uploadedFileKeys.add(storageKey);
    }
    const cards = [];
    const usedSlugs = new Set();
    for (const input of cardInputs) {
      const card = await cleanCard(env, input, null, storageContext);
      const base = card.slug;
      let candidate = base;
      let attempt = 2;
      while (usedSlugs.has(candidate) || !(await slugAvailable(env, candidate, card.id))) candidate = `${base.slice(0, 104)}-${attempt++}`;
      card.slug = candidate;
      usedSlugs.add(candidate);
      cards.push(card);
    }
    await env.DB.batch(cards.map((card) => cardInsertStatement(env, card)));
    return { files: uploaded, cards };
  } catch (error) {
    // Each key is server-generated for this one batch, so cleanup can never
    // remove someone else's PDF when metadata or the D1 batch is rejected.
    await Promise.all(uploaded.map((filename) => removePaper(env, filename, storageContext).catch(() => {})));
    throw error;
  }
}

function isWorkersDev(url) {
  return new URL(url).hostname.endsWith('.workers.dev');
}

function isOfficialPaymentHost(request) {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase();
    // The isolated test and local hosts never resolve publicly. They keep the
    // Worker testable without allowing the workers.dev preview to take sales.
    return hostname === CANONICAL_SITE_HOST || isLocalOrTestHost(request);
  } catch {
    return false;
  }
}

function officialPaymentHostResponse() {
  return json({ error: `Secure checkout is available only on ${CANONICAL_SITE_HOST}.`, code: 'OFFICIAL_DOMAIN_REQUIRED' }, 403);
}

async function renderStaticPage(request, env) {
  const assetUrl = new URL(request.url);
  const aliasTarget = staticPageAliases.get(assetUrl.pathname);
  if (aliasTarget) assetUrl.pathname = aliasTarget;
  const assetRequest = aliasTarget ? new Request(assetUrl.toString(), request) : request;
  return secureStaticPage(await env.ASSETS.fetch(assetRequest), request);
}

function collectionUrl(slug) {
  return `/collection/${encodeURIComponent(String(slug || ''))}`;
}

function collectionTagMarkup(tags) {
  if (!Array.isArray(tags) || !tags.length) return '';
  return `<div class="collection-tags" aria-label="Topics: ${escapeHtml(tags.join(', '))}">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>`;
}

function collectionChildMarkup(section) {
  return `<a class="collection-tile" href="${escapeHtml(collectionUrl(section.slug))}">
    <span class="collection-tile-icon" aria-hidden="true">${escapeHtml(section.icon || '📚')}</span>
    <h3>${escapeHtml(section.title)}</h3>
    <p>${escapeHtml(section.description || 'Browse the study resources in this collection.')}</p>
    <small>Open collection <span aria-hidden="true">→</span></small>
  </a>`;
}

function collectionResourceMarkup(card) {
  const label = card.resourceLabel || card.displayType || card.type || 'Study resource';
  const action = `<a class="collection-action" href="/paper/${encodeURIComponent(card.slug)}">View details <span aria-hidden="true">→</span></a>`;
  const price = `<span class="collection-price">₹${escapeHtml(card.price || '39')}<small>${card.available ? (card.isBundle ? 'full bundle' : 'secure PDF') : 'secure checkout opens soon'}</small></span>`;
  return `<article class="collection-resource">
    <p class="collection-resource-label">${escapeHtml(label)}</p>
    <h3>${escapeHtml(card.title)}</h3>
    <p>${escapeHtml(card.description || "Focused study material from TK's SOLUTION.")}</p>
    ${collectionTagMarkup(card.tags)}
    <footer>${price}${action}</footer>
  </article>`;
}

function safeJsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    if (character === '<') return '\\u003c';
    if (character === '>') return '\\u003e';
    if (character === '&') return '\\u0026';
    if (character === '\u2028') return '\\u2028';
    return '\\u2029';
  });
}

function paperPageContent(paper) {
  const className = String(paper.displayClassName || paper.className || '').trim();
  const classLabel = /^\d+$/.test(className) ? `Class ${className}` : className || 'Study resource';
  const material = String(paper.displayType || paper.type || 'Study material').toUpperCase();
  const tags = Array.isArray(paper.tags) && paper.tags.length
    ? paper.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')
    : '';
  const availability = paper.available
    ? 'Loading secure checkout…'
    : 'Secure checkout opens soon. You can still review the resource details.';
  return `<p class="eyebrow">${escapeHtml(classLabel)} · ${escapeHtml(paper.subject)} · ${escapeHtml(material)}</p><h1>${escapeHtml(paper.title)}</h1><p>${escapeHtml(paper.description || 'Chapter-wise study material for focused revision.')}</p><div class="meta"><span>Secure access</span><span>PDF material</span>${tags}</div><p class="price">₹${escapeHtml(paper.price || '39')}</p><p class="notice">${availability}</p>`;
}

function collectionPageShellHtml(request, collection) {
  const origin = new URL(request.url).origin;
  const { section, children, cards } = collection;
  const canonical = `${origin}${collectionUrl(section.slug)}`;
  const title = section.metaTitle || `${section.title} Study Resources | TK's SOLUTION`;
  const description = section.metaDescription || section.description || `Browse ${section.title} study resources from TK's SOLUTION.`;
  const keywords = section.seoKeywords || (Array.isArray(section.tags) ? section.tags.join(', ') : '');
  const indexable = !isWorkersDev(request.url);
  const breadcrumbItems = [
    { name: 'Home', item: `${origin}/` },
    { name: 'Study Library', item: `${origin}/library.html` },
    ...(section.parentId ? [{ name: section.parentTitle, item: `${origin}${collectionUrl(section.parentSlug)}` }] : []),
    { name: section.title, item: canonical }
  ];
  const itemList = [
    ...children.map((child) => ({ '@type': 'CollectionPage', name: child.title, url: `${origin}${collectionUrl(child.slug)}` })),
    ...cards.map((card) => ({
      '@type': 'LearningResource',
      name: card.title,
      description: card.description || "Study material from TK's SOLUTION.",
      url: `${origin}/paper/${card.slug}`,
      ...(card.available ? { offers: { '@type': 'Offer', price: card.price, priceCurrency: 'INR', availability: 'https://schema.org/InStock' } } : {})
    }))
  ];
  const collectionSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${canonical}#page`,
        name: section.title,
        description,
        url: canonical,
        isPartOf: { '@type': 'WebSite', name: "TK's SOLUTION", url: `${origin}/` },
        ...(itemList.length ? { mainEntity: { '@type': 'ItemList', itemListElement: itemList.map((item, index) => ({ '@type': 'ListItem', position: index + 1, item })) } } : {})
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumbItems.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: item.item }))
      }
    ]
  }).replace(/</g, '\\u003c');
  const breadcrumbMarkup = [
    '<a href="/index.html">Home</a>',
    '<a href="/library.html">Study library</a>',
    ...(section.parentId ? [`<a href="${escapeHtml(collectionUrl(section.parentSlug))}">${escapeHtml(section.parentTitle)}</a>`] : []),
    `<span aria-current="page">${escapeHtml(section.title)}</span>`
  ].join('<span class="collection-breadcrumb-separator" aria-hidden="true">/</span>');
  const childSection = children.length ? `<section class="collection-content" aria-labelledby="child-collections-heading">
    <div class="collection-section-heading"><div><p class="eyebrow">Study paths</p><h2 id="child-collections-heading">Choose a collection</h2></div><p>Open a focused area to see its complete list of resources.</p></div>
    <div class="collection-grid">${children.map(collectionChildMarkup).join('')}</div>
  </section>` : '';
  const resourceSection = cards.length ? `<section class="collection-content" aria-labelledby="collection-resources-heading">
    <div class="collection-section-heading"><div><p class="eyebrow">Available to explore</p><h2 id="collection-resources-heading">${escapeHtml(section.title)} resources</h2></div><p>Each published item has its own detail page and secure purchase flow when its PDF is ready.</p></div>
    <div class="collection-grid collection-resource-grid">${cards.map(collectionResourceMarkup).join('')}</div>
  </section>` : '';
  const emptyState = !children.length && !cards.length ? `<section class="collection-empty"><strong>This collection is being prepared.</strong><p>TK's SOLUTION will add verified study materials here as they are published.</p><a href="/library.html">Browse every collection</a></section>` : '';
  const parentLabel = section.parentId ? escapeHtml(section.parentTitle) : "TK's SOLUTION study library";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${indexable ? 'index,follow' : 'noindex,nofollow'}"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}">${keywords ? `<meta name="keywords" content="${escapeHtml(keywords)}">` : ''}<link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:site_name" content="TK's SOLUTION"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(canonical)}"><meta property="og:image" content="${escapeHtml(`${origin}/tk-solution-social-card.png`)}"><meta property="og:image:alt" content="TK's SOLUTION study materials"><meta property="og:image:width" content="1672"><meta property="og:image:height" content="941"><meta property="og:image:type" content="image/png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(`${origin}/tk-solution-social-card.png`)}"><meta name="twitter:image:alt" content="TK's SOLUTION study materials"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/collection.css"><script type="application/ld+json">${collectionSchema}</script></head><body><header class="collection-header"><div><a class="collection-brand" href="/index.html"><img src="/tk-solution-logo-192.png" alt="TK's SOLUTION logo" width="46" height="46">TK's <strong>SOLUTION</strong></a><a class="collection-library-link" href="/library.html">Study library</a></div></header><main class="collection-page"><nav class="collection-breadcrumb" aria-label="Breadcrumb">${breadcrumbMarkup}</nav><section class="collection-hero"><span class="collection-hero-icon" aria-hidden="true">${escapeHtml(section.icon || '📚')}</span><p class="eyebrow">${parentLabel}</p><h1>${escapeHtml(section.title)}</h1><p>${escapeHtml(description)}</p>${collectionTagMarkup(section.tags)}</section>${childSection}${resourceSection}${emptyState}</main><footer class="collection-footer"><div><div><span>© 2026 TK's SOLUTION</span><span>Run by Sumathy Manoharan since 2001</span></div><nav aria-label="Footer"><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms &amp; purchases</a><a href="mailto:sumathynl.maths@gmail.com">Contact</a></nav></div></footer><script src="/analytics.js"></script></body></html>`;
}

function collectionPageHtml(request, collection) {
  return collectionPageShellHtml(request, collection)
    .replace('<link rel="stylesheet" href="/collection.css">', '<link rel="stylesheet" href="/collection.css?v=20260930-ssr"><link rel="stylesheet" href="/accessibility.css?v=20260930-ssr">')
    .replace('<body>', '<body><a class="skip-link" href="#main">Skip to content</a>')
    .replace('<main class="collection-page">', '<main id="main" class="collection-page">')
    .replace('<script src="/analytics.js"></script>', '<script src="/analytics.js?v=20260930-ssr"></script>');
}

async function renderCollectionPage(request, env, slug) {
  const collection = await publicCollection(env, slug);
  if (!collection) return text('Not found', 404);
  return text(collectionPageHtml(request, collection), 200, 'text/html; charset=utf-8', { 'Cache-Control': PUBLIC_READ_CACHE_CONTROL });
}

function sitemapEntry(origin, path, updatedAt = '') {
  const lastmod = /^\d{4}-\d{2}-\d{2}/.exec(String(updatedAt || ''))?.[0];
  return `  <url><loc>${escapeXml(`${origin}${path}`)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
}

async function renderSitemap(request, env) {
  const origin = new URL(request.url).origin;
  const pages = ['/', '/library.html', '/sample-papers.html', '/pyqs.html', '/mcqs.html', '/important-questions.html', '/privacy.html', '/terms.html'];
  const fixed = pages.map((page) => sitemapEntry(origin, page));
  const sections = [...(await readSectionContexts(env)).values()].filter(sectionIsPubliclyVisible);
  const sectionUrls = sections.map((section) => sitemapEntry(origin, collectionUrl(section.slug), section.updatedAt));
  // Publishing a card is the editor's explicit decision to make its public
  // detail page discoverable. The separate sales switch still controls only
  // whether checkout is offered: a published card can build its search
  // presence while its protected PDF or payment checks are being prepared.
  // `readPublicCards` already excludes drafts and cards in hidden sections.
  const cards = await readPublicCards(env);
  const cardUrls = cards.map((card) => sitemapEntry(origin, `/paper/${card.slug}`, card.updatedAt));
  return text(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...fixed, ...sectionUrls, ...cardUrls].join('\n')}\n</urlset>\n`, 200, 'application/xml; charset=utf-8');
}

function renderRobots(request) {
  const origin = new URL(request.url).origin;
  const content = isWorkersDev(request.url)
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin.html\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`;
  return text(content, 200, 'text/plain; charset=utf-8');
}

function paperPageShellHtml(request, paper) {
  const origin = new URL(request.url).origin;
  const title = paper.metaTitle || `${paper.title} | TK's SOLUTION`;
  const description = paper.metaDescription || paper.description || 'Chapter-wise study material for focused revision.';
  const keywords = paper.seoKeywords || (Array.isArray(paper.tags) ? paper.tags.join(', ') : '');
  // A published database card has a stable public SEO URL even while sales
  // are paused. `available` remains the stricter, separate condition used to
  // show checkout. Seed placeholders deliberately have no `isPublished`
  // flag, so they remain noindex until a real card replaces them.
  const indexable = Boolean(paper.isPublished) && !isWorkersDev(request.url);
  const rawEducationalLevel = String(paper.displayClassName || paper.className || '').trim();
  const educationalLevel = /^\d+$/.test(rawEducationalLevel) ? `Class ${rawEducationalLevel}` : (rawEducationalLevel || 'School and competitive exam preparation');
  const learningResourceType = String(paper.displayType || paper.type || 'Study material');
  const productSchema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'LearningResource',
    name: paper.title,
    description,
    educationalLevel,
    learningResourceType,
    provider: { '@type': 'EducationalOrganization', name: "TK's SOLUTION" },
    ...(paper.available ? { offers: { '@type': 'Offer', price: paper.price, priceCurrency: 'INR', availability: 'https://schema.org/InStock', url: `${origin}/paper/${paper.slug}` } } : {})
  }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="${indexable ? 'index,follow' : 'noindex,nofollow'}"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}">${keywords ? `<meta name="keywords" content="${escapeHtml(keywords)}">` : ''}<link rel="canonical" href="${escapeHtml(`${origin}/paper/${paper.slug}`)}"><meta property="og:type" content="product"><meta property="og:site_name" content="TK's SOLUTION"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:url" content="${escapeHtml(`${origin}/paper/${paper.slug}`)}"><meta property="og:image" content="${escapeHtml(`${origin}/tk-solution-social-card.png`)}"><meta property="og:image:alt" content="TK's SOLUTION study materials"><meta property="og:image:width" content="1672"><meta property="og:image:height" content="941"><meta property="og:image:type" content="image/png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${escapeHtml(`${origin}/tk-solution-social-card.png`)}"><meta name="twitter:image:alt" content="TK's SOLUTION study materials"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,700&display=swap" rel="stylesheet"><link rel="stylesheet" href="/paper.css"><script type="application/ld+json">${productSchema}</script></head><body><header><a class="brand" href="/index.html"><img src="/tk-solution-logo-192.png" alt="TK's SOLUTION logo" width="46" height="46">TK's <strong>SOLUTION</strong></a><a href="/index.html">Back to library</a></header><main><p class="eyebrow">Secure study material</p><div id="paper-detail" class="paper-detail" aria-live="polite"><div class="loading-block"></div><div class="loading-block short"></div></div></main><script src="/paper.js"></script><script src="/analytics.js"></script></body></html>`;
}

function paperPageHtml(request, paper) {
  const embeddedPaper = safeJsonForHtml(paper);
  return paperPageShellHtml(request, paper)
    .replace('<link rel="stylesheet" href="/paper.css">', '<link rel="stylesheet" href="/paper.css?v=20260930-ssr"><link rel="stylesheet" href="/accessibility.css?v=20260930-ssr">')
    .replace('<body>', '<body><a class="skip-link" href="#main">Skip to content</a>')
    .replace('<main><p class="eyebrow">Secure study material</p><div id="paper-detail" class="paper-detail" aria-live="polite"><div class="loading-block"></div><div class="loading-block short"></div></div></main>', `<main id="main"><p class="eyebrow">Secure study material</p><div id="paper-detail" class="paper-detail" aria-live="polite">${paperPageContent(paper)}</div></main>`)
    .replace('<script src="/paper.js"></script><script src="/analytics.js"></script>', `<script id="paper-data" type="application/json">${embeddedPaper}</script><script src="/paper.js?v=20260930-ssr"></script><script src="/analytics.js?v=20260930-ssr"></script>`);
}

async function renderPaperPage(request, env, slug) {
  const paper = await findPaperBySlug(env, slug);
  if (!paper) return text('Not found', 404);
  return text(paperPageHtml(request, paper), 200, 'text/html; charset=utf-8', { 'Cache-Control': PUBLIC_READ_CACHE_CONTROL });
}

async function api(request, env, url) {
  // Razorpay cannot send an Origin header, so its signed webhook is the one
  // deliberately origin-exempt route. Keep every other verb explicit rather
  // than allowing it to fall through to the general admin authentication path.
  if (url.pathname === '/api/payment/webhook') {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return paymentWebhook(request, env);
  }
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(request.method)) return methodNotAllowed('GET, HEAD, POST, PUT, DELETE');
  if (!validSameOrigin(request)) return json({ error: 'Invalid origin.' }, 403);
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/healthz') {
    try {
      // Check the tables used by the live paths, not just the D1 connection.
      // A deployment without the latest migration must fail health checks.
      await Promise.all([
        env.DB.prepare('SELECT 1 FROM cards LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM catalog_sections LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM orders LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM admin_sessions LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM checkout_attempts LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM students LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM promotions LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM feedback LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM analytics_daily LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM analytics_visitors LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM analytics_attempts LIMIT 1').first(),
        env.DB.prepare('SELECT 1 FROM feedback_attempts LIMIT 1').first()
      ]);
      const body = { ok: true, platform: 'cloudflare', payments: { ready: canAcceptNewPayments(env) } };
      return request.method === 'HEAD'
        ? new Response(null, { status: 200, headers: { ...securityHeaders(), 'Cache-Control': 'no-store' } })
        : json(body);
    } catch (error) {
      console.error("TK's SOLUTION database health check failed", error);
      const body = { ok: false, error: 'Database migration or connection is unavailable.' };
      return request.method === 'HEAD'
        ? new Response(null, { status: 503, headers: { ...securityHeaders(), 'Cache-Control': 'no-store' } })
        : json(body, 503);
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog') return publicJson(await publicCatalog(env));
  if (request.method === 'GET' && url.pathname === '/api/cards') {
    const paymentDeliveryReady = canAcceptNewPayments(env);
    return publicJson({ cards: (await filteredCards(env, url.searchParams)).map((card) => publicCard(card, paymentDeliveryReady)) });
  }
  if (request.method === 'GET' && url.pathname === '/api/papers') return publicJson({ papers: await filterPapers(env, url.searchParams) });
  const slugMatch = url.pathname.match(/^\/api\/papers\/slug\/([a-z0-9-]+)$/i);
  if (request.method === 'GET' && slugMatch) {
    const paper = await findPaperBySlug(env, slugMatch[1]);
    return paper ? publicJson({ paper }) : json({ error: 'Paper not found.' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/api/analytics/visit') {
    try {
      // Accept an empty body for lightweight beacon-style calls, while still
      // rejecting malformed JSON if a caller supplies a body.
      await readOptionalJson(request, 10_000);
      const recorded = await recordVisit(env, request);
      return json({ ok: true, recorded });
    } catch (error) { return apiErrorResponse(error, 'Analytics could not be recorded.'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/feedback') {
    if (!await consumeRateLimit(request, env, 'feedback_attempts', FEEDBACK_WINDOW_MS, MAX_FEEDBACK_SUBMISSIONS)) {
      return json({ error: 'Too many feedback reports from this connection. Please try again later.' }, 429);
    }
    try {
      await createFeedback(env, request, await readJson(request, 50_000));
      return json({ ok: true }, 201);
    } catch (error) { return apiErrorResponse(error, 'Feedback could not be sent.'); }
  }
  const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
  if (request.method === 'GET' && downloadMatch) return isOfficialPaymentHost(request)
    ? secureDownload(request, env, downloadMatch[1])
    : officialPaymentHostResponse();
  if (request.method === 'GET' && url.pathname === '/api/admin/session') return json({ authenticated: await authenticated(request, env) });
  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!env.ADMIN_PASSWORD || String(env.ADMIN_PASSWORD).length < 12) return json({ error: 'Admin authentication is not configured yet.' }, 503);
    let input;
    try { input = await readJson(request); }
    catch (error) { return apiErrorResponse(error, 'Invalid sign-in request.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'Invalid sign-in request.' }, 400);
    if (!(await secureEqual(input.password || '', env.ADMIN_PASSWORD))) {
      if (!await recordFailedLogin(request, env)) return json({ error: 'Too many attempts. Try again later.' }, 429);
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
    if (!isOfficialPaymentHost(request)) return officialPaymentHostResponse();
    if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
    let buyer;
    try { buyer = cleanCheckoutBuyer(await readOptionalJson(request)); }
    catch (error) { return apiErrorResponse(error, 'Invalid checkout details.'); }
    const card = await getCardBySlug(env, checkoutMatch[1]);
    let fileReady = false;
    try {
      fileReady = Boolean(card?.fileKey && cardIsPubliclyVisible(card) && await paperExists(env, card.fileKey));
    } catch (error) {
      return apiErrorResponse(error, 'The protected PDF service is unavailable. Please try again shortly.');
    }
    if (!fileReady) return json({ error: 'This paper is not ready for secure purchase yet.' }, 404);
    if (!canAcceptNewPayments(env)) return paymentDeliveryUnavailableResponse(env);
    if (!await consumeRateLimit(request, env, 'checkout_attempts', CHECKOUT_WINDOW_MS, MAX_CHECKOUT_ATTEMPTS)) return json({ error: 'Too many checkout attempts from this connection. Please wait 10 minutes and try again.' }, 429);
    const receipt = `best_${crypto.randomUUID().replace(/-/g, '').slice(0, 30)}`;
    const amount = fixedCardPrice(card.isBundle) * 100;
    let upstream;
    try {
      upstream = await razorpayFetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: razorpayAuthorization(env), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, currency: 'INR', receipt, notes: { card_id: card.id, slug: card.slug } })
      });
    } catch (error) {
      return apiErrorResponse(error, 'The payment service could not create an order. Please try again.', 502);
    }
    const order = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !order.id || Number(order.amount) !== amount || (order.currency && order.currency !== 'INR')) return json({ error: 'The payment service could not create an order. Please try again.' }, 502);
    const recoveryToken = bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const recoveryExpiresAt = new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString();
    if (!recoveryCookieName(order.id)) return json({ error: 'The payment service returned an invalid order reference. Please try again.' }, 502);
    // Keep the buyer details on the pending order, but do not create a student
    // profile until Razorpay has actually confirmed capture.
    await saveOrder(env, { orderId: order.id, cardId: card.id, amount, currency: 'INR', recoveryTokenHash: await sha256Hex(recoveryToken), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), recoveryExpiresAt, buyerEmail: buyer.email, buyerName: buyer.name });
    return json({ key: env.RAZORPAY_KEY_ID, order: { id: order.id, amount, currency: 'INR' }, recovery: { expiresAt: recoveryExpiresAt }, buyer: { email: buyer.email, name: buyer.name }, paper: publicCard(card, canAcceptNewPayments(env)) }, 200, {
      'Set-Cookie': recoveryCookie(order.id, recoveryToken, Math.ceil(DOWNLOAD_DURATION_MS / 1000), url.protocol === 'https:')
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/payment/verify') {
    if (!isOfficialPaymentHost(request)) return officialPaymentHostResponse();
    if (!hasPaymentDeliveryConfiguration(env)) return paymentDeliveryUnavailableResponse(env);
    try {
      const input = await readJson(request);
      const order = await getOrder(env, input.razorpay_order_id);
      const expected = await hmac(`${input.razorpay_order_id}|${input.razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
      if (!order || (order.razorpay_payment_id && order.razorpay_payment_id !== input.razorpay_payment_id) || new Date(order.expires_at).getTime() < Date.now() || !(await secureEqual(input.razorpay_signature || '', expected))) throw new Error('Payment verification failed.');
      if (isTrue(order.access_revoked) || order.status === 'refunded') throw new Error('Access to this purchase has been revoked.');
      const card = await getCard(env, order.card_id);
      if (!card?.fileKey || !cardIsPubliclyVisible(card)) throw new Error('The requested PDF is unavailable.');
      const payment = await razorpayPayment(env, order, input.razorpay_payment_id);
      await attachOrderStudent(env, order, { email: order.buyer_email, name: order.buyer_name });
      if (!await updateOrderStatus(env, order.razorpay_order_id, 'fulfilled', payment.id, true)) throw new Error('Payment verification failed.');
      const fulfilledOrder = await getOrder(env, order.razorpay_order_id);
      if (!fulfilledOrder || fulfilledOrder.razorpay_payment_id !== payment.id || fulfilledOrder.status !== 'fulfilled' || !await orderAccessAllowed(env, fulfilledOrder)) throw new Error('Access to this purchase has been revoked.');
      return json({ ok: true, downloadUrl: `/api/download/${await signedDownloadToken(env, card, order.razorpay_order_id)}`, expiresAt: new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString() }, 200, {
        'Set-Cookie': clearRecoveryCookie(order.razorpay_order_id, url.protocol === 'https:')
      });
    } catch (error) { return apiErrorResponse(error, 'Payment verification failed.'); }
  }
  if (request.method === 'POST' && url.pathname === '/api/payment/recover') {
    if (!isOfficialPaymentHost(request)) return officialPaymentHostResponse();
    if (!hasPaymentDeliveryConfiguration(env)) return paymentDeliveryUnavailableResponse(env);
    try {
      const input = await readJson(request);
      const orderId = String(input.orderId || '');
      const cookieName = recoveryCookieName(orderId);
      const recoveryToken = cookieName ? String(parseCookies(request)[cookieName] || '') : '';
      if (!cookieName || !/^[A-Za-z0-9_-]{43}$/.test(recoveryToken)) throw new Error('This purchase recovery request is invalid.');
      const order = await env.DB.prepare('SELECT * FROM orders WHERE razorpay_order_id = ? AND recovery_token_hash = ?').bind(orderId, await sha256Hex(recoveryToken)).first();
      if (!order || new Date(order.recovery_expires_at).getTime() < Date.now()) throw new Error("This purchase recovery link has expired. Please contact TK's SOLUTION with your payment details.");
      if (order.status === 'failed') throw new Error('This payment was not completed.');
      if (isTrue(order.access_revoked) || order.status === 'refunded') throw new Error('Access to this purchase has been revoked.');
      if (!order.razorpay_payment_id) return json({ pending: true, message: 'Payment confirmation is still arriving. Please check again in a minute.' }, 202);
      const card = await getCard(env, order.card_id);
      if (!card?.fileKey || !cardIsPubliclyVisible(card)) throw new Error('The requested PDF is unavailable.');
      const payment = await razorpayPayment(env, order, order.razorpay_payment_id);
      if (!order.student_id) await attachOrderStudent(env, order, { email: order.buyer_email, name: order.buyer_name });
      if (!await updateOrderStatus(env, order.razorpay_order_id, 'fulfilled', payment.id, true)) throw new Error('Purchase recovery failed.');
      const fulfilledOrder = await getOrder(env, order.razorpay_order_id);
      if (!fulfilledOrder || fulfilledOrder.razorpay_payment_id !== payment.id || fulfilledOrder.status !== 'fulfilled' || !await orderAccessAllowed(env, fulfilledOrder)) throw new Error('Access to this purchase has been revoked.');
      return json({ ok: true, downloadUrl: `/api/download/${await signedDownloadToken(env, card, order.razorpay_order_id)}`, expiresAt: new Date(Date.now() + DOWNLOAD_DURATION_MS).toISOString() }, 200, {
        'Set-Cookie': clearRecoveryCookie(order.razorpay_order_id, url.protocol === 'https:')
      });
    } catch (error) { return apiErrorResponse(error, 'Purchase recovery failed.'); }
  }
  if (!(await authenticated(request, env))) return json({ error: 'Sign in required.' }, 401);
  if (request.method === 'GET' && url.pathname === '/api/admin/dashboard') return json(await dashboardSummary(env));
  if (request.method === 'GET' && url.pathname === '/api/admin/orders') return json(await listAdminOrders(env, url.searchParams));
  const orderMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Za-z0-9_-]{1,160})$/);
  if (request.method === 'GET' && orderMatch) {
    const order = await getAdminOrder(env, orderMatch[1]);
    return order ? json({ order }) : json({ error: 'Order not found.' }, 404);
  }
  if (request.method === 'PUT' && orderMatch) {
    try {
      const order = await updateAdminOrder(env, orderMatch[1], await readJson(request));
      return order ? json({ order }) : json({ error: 'Order not found.' }, 404);
    } catch (error) { return apiErrorResponse(error, 'The order could not be updated.'); }
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/students') return json(await listStudents(env, url.searchParams));
  const studentResetMatch = url.pathname.match(/^\/api\/admin\/students\/([A-Za-z0-9-]{1,80})\/(?:password-reset|reset-password)$/);
  if (request.method === 'POST' && studentResetMatch) {
    const result = await requestStudentPasswordReset(env, studentResetMatch[1]);
    return result ? json(result) : json({ error: 'Student not found.' }, 404);
  }
  const studentMatch = url.pathname.match(/^\/api\/admin\/students\/([A-Za-z0-9-]{1,80})$/);
  if (request.method === 'GET' && studentMatch) {
    const result = await getAdminStudent(env, studentMatch[1]);
    return result ? json(result) : json({ error: 'Student not found.' }, 404);
  }
  if (request.method === 'PUT' && studentMatch) {
    try {
      const result = await updateAdminStudent(env, studentMatch[1], await readJson(request));
      return result ? json(result) : json({ error: 'Student not found.' }, 404);
    } catch (error) { return apiErrorResponse(error, 'The student could not be updated.'); }
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/promotions') return json({ promotions: await listPromotions(env), checkoutEnabled: false });
  if (request.method === 'POST' && url.pathname === '/api/admin/promotions') {
    try { return json({ promotion: await createPromotion(env, await readJson(request)), checkoutEnabled: false }, 201); }
    catch (error) { return apiErrorResponse(error, 'The promotion could not be saved.'); }
  }
  const promotionMatch = url.pathname.match(/^\/api\/admin\/promotions\/([A-Za-z0-9-]{1,80})$/);
  if (request.method === 'GET' && promotionMatch) {
    const promotion = await getPromotion(env, promotionMatch[1]);
    return promotion ? json({ promotion }) : json({ error: 'Promotion not found.' }, 404);
  }
  if (request.method === 'PUT' && promotionMatch) {
    try {
      const promotion = await updatePromotion(env, promotionMatch[1], await readJson(request));
      return promotion ? json({ promotion, checkoutEnabled: false }) : json({ error: 'Promotion not found.' }, 404);
    } catch (error) { return apiErrorResponse(error, 'The promotion could not be updated.'); }
  }
  if (request.method === 'DELETE' && promotionMatch) {
    const result = await env.DB.prepare('DELETE FROM promotions WHERE id = ?').bind(promotionMatch[1]).run();
    return Number(result.meta?.changes) ? json({ ok: true }) : json({ error: 'Promotion not found.' }, 404);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/feedback') return json(await listFeedback(env, url.searchParams));
  const feedbackMatch = url.pathname.match(/^\/api\/admin\/feedback\/([A-Za-z0-9-]{1,80})$/);
  if (request.method === 'GET' && feedbackMatch) {
    const feedback = await getFeedback(env, feedbackMatch[1]);
    return feedback ? json({ feedback }) : json({ error: 'Feedback report not found.' }, 404);
  }
  if (request.method === 'PUT' && feedbackMatch) {
    try {
      const feedback = await updateFeedback(env, feedbackMatch[1], await readJson(request));
      return feedback ? json({ feedback }) : json({ error: 'Feedback report not found.' }, 404);
    } catch (error) { return apiErrorResponse(error, 'The feedback report could not be updated.'); }
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/export') {
    return json({ version: 5, sections: await readSections(env), cards: await readCards(env) });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/sections') return json({ sections: await readSections(env) });
  const sectionMatch = url.pathname.match(/^\/api\/admin\/sections\/([A-Za-z0-9-]+)$/);
  if (request.method === 'GET' && sectionMatch) {
    const section = await getSection(env, sectionMatch[1]);
    return section ? json({ section }) : json({ error: 'Catalogue section not found.' }, 404);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/sections') {
    try {
      const section = await insertSection(env, await cleanSection(env, await readJson(request)));
      return json({ section }, 201);
    } catch (error) { return apiErrorResponse(error, 'The catalogue section could not be saved.'); }
  }
  if (request.method === 'PUT' && sectionMatch) {
    try {
      const existing = await getSection(env, sectionMatch[1]);
      if (!existing) return json({ error: 'Catalogue section not found.' }, 404);
      const section = await cleanSection(env, await readJson(request), existing);
      const changesPublicPath = (existing.isPublished && !section.isPublished) || existing.parentId !== section.parentId;
      if (changesPublicPath && await sectionHasActivePaidDownloads(env, existing.id)) {
        return json({ error: 'Keep this section published and in place until active paid download links have expired (up to 24 hours).' }, 409);
      }
      return json({ section: await updateSection(env, section) });
    } catch (error) { return apiErrorResponse(error, 'The catalogue section could not be updated.'); }
  }
  if (request.method === 'DELETE' && sectionMatch) {
    const section = await getSection(env, sectionMatch[1]);
    if (!section) return json({ error: 'Catalogue section not found.' }, 404);
    const [child, card] = await Promise.all([
      env.DB.prepare('SELECT 1 FROM catalog_sections WHERE parent_id = ? LIMIT 1').bind(section.id).first(),
      env.DB.prepare('SELECT 1 FROM cards WHERE section_id = ? LIMIT 1').bind(section.id).first()
    ]);
    if (child || card) return json({ error: 'Move or delete this section’s child tiles and cards before deleting it.' }, 409);
    await env.DB.prepare('DELETE FROM catalog_sections WHERE id = ?').bind(section.id).run();
    return json({ ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/cards') return json({ cards: await readCards(env) });
  if (request.method === 'POST' && url.pathname === '/api/admin/bulk') {
    try {
      const result = await bulkUpload(env, request);
      return json({ files: result.files, cards: result.cards, count: result.cards.length }, 201);
    } catch (error) { return apiErrorResponse(error, 'The bulk upload could not be completed.'); }
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/files') {
    if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
    try {
      return json({ files: await listPdfFiles(env) });
    } catch (error) {
      return apiErrorResponse(error, 'The private PDF library could not be loaded.');
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/files') {
    if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
    try {
      const contentType = String(request.headers.get('Content-Type') || '').toLowerCase();
      if (!contentType.startsWith('application/pdf')) throw new Error('Upload a PDF file.');
      const sourceFilename = safePdfFilename(decodeURIComponent(request.headers.get('X-Upload-Filename') || ''));
      const declaredSize = Number(request.headers.get('Content-Length') || 0);
      if (Number.isFinite(declaredSize) && declaredSize > MAX_PDF_BYTES) throw new Error('Upload a PDF smaller than 25 MB.');
      if (!request.body) throw new Error('Choose a valid PDF file.');
      // Give every upload a new, opaque storage key. The original filename is
      // retained only as a safe display/download name, so an old paid link can
      // never be silently overwritten by a later admin upload.
      const storageContext = newStorageOperationContext();
      const filename = await newUploadStorageKey(env, sourceFilename, storageContext);
      await writePaper(env, filename, pdfUploadStream(request.body), storageContext);
      return json({ file: filename }, 201);
    } catch (error) {
      return apiErrorResponse(error, 'The PDF could not be uploaded.');
    }
  }
  const fileMatch = url.pathname.match(/^\/api\/admin\/files\/([^/]+)$/);
  if (request.method === 'DELETE' && fileMatch) {
    if (!hasPaperStorage(env)) return paperStorageUnavailableResponse();
    try {
      const filename = safePdfFilename(decodeURIComponent(fileMatch[1]));
      const references = await env.DB.prepare('SELECT COUNT(*) AS count FROM cards WHERE file_key = ?').bind(filename).first();
      if (Number(references?.count)) return json({ error: 'Update or remove the linked study card before deleting this PDF.' }, 409);
      const existing = await paperExists(env, filename);
      if (!existing) return json({ error: 'The PDF was not found.' }, 404);
      await removePaper(env, filename);
      return json({ ok: true });
    } catch (error) {
      return apiErrorResponse(error, 'The PDF could not be deleted.');
    }
  }
  const cardMatch = url.pathname.match(/^\/api\/admin\/cards\/([a-zA-Z0-9-]+)$/);
  if (request.method === 'POST' && url.pathname === '/api/admin/cards') {
    try {
      const card = await insertCard(env, await cleanCard(env, await readJson(request)));
      return json({ card }, 201);
    }
    catch (error) { return apiErrorResponse(error, 'The study card could not be saved.'); }
  }
  if (request.method === 'PUT' && cardMatch) {
    try {
      const existing = await getCard(env, cardMatch[1]);
      if (!existing) return json({ error: 'Card not found.' }, 404);
      const card = await cleanCard(env, await readJson(request), existing);
      if (card.fileKey !== existing.fileKey && await hasActivePaidDownload(env, existing.id)) {
        return json({ error: 'Keep this PDF linked until the last paid download link has expired (up to 24 hours).' }, 409);
      }
      if (((existing.isPublished && !card.isPublished) || existing.sectionId !== card.sectionId) && await hasActivePaidDownload(env, existing.id)) {
        return json({ error: 'Keep this paid card published in its current catalogue section until active download links have expired (up to 24 hours).' }, 409);
      }
      return json({ card: await updateCard(env, card) });
    } catch (error) { return apiErrorResponse(error, 'The study card could not be updated.'); }
  }
  if (request.method === 'DELETE' && cardMatch) {
    if (await hasActivePaidDownload(env, cardMatch[1])) return json({ error: 'This card has a paid download link that can remain active for up to 24 hours.' }, 409);
    const result = await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardMatch[1]).run();
    return Number(result.meta?.changes) ? json({ ok: true }) : json({ error: 'Card not found.' }, 404);
  }
  if (request.method === 'PUT' && url.pathname === '/api/admin/import') {
    try {
      const input = await readJson(request, 2_000_000);
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.confirmReplace !== true) {
        throw new Error('Confirm that this backup should replace the full library before importing it.');
      }
      const source = input.cards;
      const sourceSections = input.sections;
      if (!Array.isArray(source) || source.length > 500) throw new Error('Choose a valid backup with no more than 500 cards.');
      if (sourceSections !== undefined && (!Array.isArray(sourceSections) || sourceSections.length > 200)) throw new Error('Choose a valid backup with no more than 200 catalogue sections.');
      if (await hasAnyActivePaidDownloads(env)) throw new Error('Wait until active paid download links expire before importing a full card backup.');
      const backupUsesPdfs = source.some((card) => String(card?.fileKey || '').trim());
      if (backupUsesPdfs && !hasPaperStorage(env)) return paperStorageUnavailableResponse();
      const pdfFiles = backupUsesPdfs ? new Set(await listPdfFiles(env)) : new Set();
      const usedSlugs = new Set();
      let sectionContexts;
      let parsedSections = null;
      if (sourceSections !== undefined) {
        const usedSectionSlugs = new Set();
        parsedSections = sourceSections.map((section) => cleanImportedSection(section, usedSectionSlugs));
        sectionContexts = importedSectionContexts(parsedSections);
      } else {
        sectionContexts = await readSectionContexts(env);
      }
      const parsed = [];
      for (const item of source) {
        parsed.push(cleanImportedCard(item, usedSlugs, pdfFiles, sectionContexts));
      }
      if (new Set(parsed.map((card) => card.id)).size !== parsed.length) throw new Error('The backup contains duplicate card IDs.');
      // Keep a full 500-card import within D1 Free's per-invocation statement limit.
      // Validation happens above; JSON-bound inserts keep the replacement within
      // D1 Free's per-invocation statement limit even for a complete catalogue.
      if (parsedSections) {
        await env.DB.batch([
          env.DB.prepare('DELETE FROM cards'),
          env.DB.prepare('DELETE FROM catalog_sections'),
          bulkSectionImportStatement(env, parsedSections),
          bulkCardImportStatement(env, parsed)
        ]);
      } else {
        await env.DB.batch([env.DB.prepare('DELETE FROM cards'), bulkCardImportStatement(env, parsed)]);
      }
      return json({ count: parsed.length, sections: parsedSections?.length });
    } catch (error) { return apiErrorResponse(error, 'The backup could not be imported.'); }
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      // Keep one public address for SEO, sharing, and student bookmarks. The
      // Worker still serves its workers.dev preview unchanged.
      if (url.hostname.toLowerCase() === CANONICAL_SITE_WWW_HOST) {
        url.protocol = 'https:';
        url.host = CANONICAL_SITE_HOST;
        return Response.redirect(url.toString(), 301);
      }
      if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return await api(request, env, url);
      if (!['GET', 'HEAD'].includes(request.method)) return methodNotAllowed('GET, HEAD');
      if (url.pathname === '/sitemap.xml') return await renderSitemap(request, env);
      if (url.pathname === '/robots.txt') return renderRobots(request);
      const paperMatch = url.pathname.match(/^\/paper\/([a-z0-9-]+)$/i);
      if (paperMatch) return await renderPaperPage(request, env, paperMatch[1]);
      const collectionMatch = url.pathname.match(/^\/collection\/([a-z0-9-]+)$/);
      if (collectionMatch) return await renderCollectionPage(request, env, collectionMatch[1]);
      if (staticPagePaths.has(url.pathname)) return await renderStaticPage(request, env);
      return cacheStaticAsset(await env.ASSETS.fetch(request), request);
    } catch (error) {
      console.error("TK's SOLUTION Worker error", error);
      return json({ error: 'The service could not complete that request. Please try again.' }, 500);
    }
  },
  async scheduled(_controller, env, ctx) {
    const cleanup = cleanupExpiredRecords(env).catch((error) => {
      console.error("TK's SOLUTION retention cleanup failed", error);
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(cleanup);
      return;
    }
    await cleanup;
  }
};
