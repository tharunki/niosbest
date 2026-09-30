import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';

// This test deliberately talks to a small, in-memory imitation of the
// server-side Supabase Storage API. It must never make a network request or
// use a real Supabase credential.
class D1Statement {
  constructor(database, sql, values = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  async first() { return this.database.prepare(this.sql).get(...this.values) || null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class D1Database {
  constructor(database) { this.database = database; }
  prepare(sql) { return new D1Statement(this.database, sql); }
  async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); }
}

const sqlite = new DatabaseSync(':memory:');
for (const migration of [
  '0001_initial.sql', '0002_checkout_rate_limit.sql', '0003_cards_fts.sql', '0004_catalog_sections.sql',
  '0005_public_and_purchase_indexes.sql', '0006_business_admin_and_seo.sql',
  '0007_analytics_retention_indexes.sql', '0008_rate_limit_retention_indexes.sql'
]) {
  sqlite.exec(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
}

const origin = 'https://tksolutions.test';
const supabaseOrigin = 'https://project-ref.supabase.co';
const supabaseSecret = `sb_secret_${'safe-test-key-material-'.repeat(3)}`;
const pdfBytes = new TextEncoder().encode('%PDF-1.7\nSupabase adapter smoke test\n');
const storedObjects = new Map();
const storageCalls = [];
let bucket = null;
let razorpayOrderId = 'order_supabase_1';
const razorpayPaymentId = 'pay_supabase_1';
const privateBucketConfig = {
  id: 'tks-papers',
  name: 'tks-papers',
  public: false,
  file_size_limit: 25 * 1024 * 1024,
  allowed_mime_types: ['application/pdf']
};

const env = {
  DB: new D1Database(sqlite),
  SUPABASE_URL: supabaseOrigin,
  SUPABASE_SECRET_KEY: supabaseSecret,
  ADMIN_PASSWORD: 'supabase-admin-test-password',
  DOWNLOAD_TOKEN_SECRET: 'supabase-download-test-secret-that-is-over-32-characters',
  PAYMENTS_ENABLED: 'true',
  RAZORPAY_KEY_ID: 'rzp_test_supabase',
  RAZORPAY_KEY_SECRET: 'supabase-razorpay-test-secret',
  RAZORPAY_WEBHOOK_SECRET: 'supabase-webhook-test-secret'
};

const request = (path, method = 'GET', body, cookie = '', headers = {}) => new Request(`${origin}${path}`, {
  method,
  headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers
  },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function responseHasNoSupabaseLeak(response, label) {
  const forbidden = supabaseOrigin;
  for (const [name, value] of response.headers) {
    assert.equal(value.includes(forbidden), false, `${label} must not expose Supabase through the ${name} header`);
  }
}

function storageFilename(pathname) {
  const prefixes = [
    '/storage/v1/object/info/authenticated/tks-papers/',
    '/storage/v1/object/authenticated/tks-papers/',
    '/storage/v1/object/tks-papers/'
  ];
  const prefix = prefixes.find((candidate) => pathname.startsWith(candidate));
  assert.ok(prefix, `unexpected Supabase object endpoint: ${pathname}`);
  return decodeURIComponent(pathname.slice(prefix.length));
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));

  if (url.origin === supabaseOrigin) {
    // A current sb_secret key is an opaque API key, not a JWT. It must never
    // be placed in Authorization, even for server-side calls.
    assert.equal(headers.get('apikey'), supabaseSecret, 'every Supabase request must use the server-only apikey header');
    assert.equal(headers.get('authorization'), null, 'a current sb_secret key must not be sent as a Bearer token');
    assert.equal(url.pathname.includes('/object/public/'), false, 'the Worker must never call Supabase public-object endpoints');
    storageCalls.push({ method, pathname: url.pathname, headers });

    if (method === 'GET' && url.pathname === '/storage/v1/bucket/tks-papers') {
      return bucket ? json(bucket) : new Response(null, { status: 404 });
    }
    if (method === 'POST' && url.pathname === '/storage/v1/bucket') {
      const payload = JSON.parse(String(init.body || '{}'));
      assert.deepEqual(payload, privateBucketConfig, 'the automatically created bucket must be private and accept PDFs only up to 25 MB');
      bucket = { ...payload };
      return json(bucket, 201);
    }
    if (method === 'PUT' && url.pathname === '/storage/v1/bucket/tks-papers') {
      const payload = JSON.parse(String(init.body || '{}'));
      assert.deepEqual(payload, {
        file_size_limit: privateBucketConfig.file_size_limit,
        allowed_mime_types: privateBucketConfig.allowed_mime_types
      }, 'a previously configured private bucket is repaired to the PDF-only policy');
      bucket = { ...bucket, ...payload };
      return json(bucket);
    }
    if (method === 'POST' && url.pathname === '/storage/v1/object/list/tks-papers') {
      const payload = JSON.parse(String(init.body || '{}'));
      assert.equal(payload.limit, 1000, 'file listing must use bounded pages');
      return json([...storedObjects.keys()].sort().map((name) => ({ name })));
    }
    if (method === 'DELETE' && url.pathname === '/storage/v1/object/tks-papers') {
      const payload = JSON.parse(String(init.body || '{}'));
      for (const key of payload.prefixes || []) storedObjects.delete(key);
      return json({});
    }
    const isObjectInfoRoute = url.pathname.startsWith('/storage/v1/object/info/authenticated/tks-papers/');
    const isAuthenticatedObjectRoute = url.pathname.startsWith('/storage/v1/object/authenticated/tks-papers/');
    const isUploadObjectRoute = url.pathname.startsWith('/storage/v1/object/tks-papers/');
    if (isObjectInfoRoute || isAuthenticatedObjectRoute || isUploadObjectRoute) {
      const filename = storageFilename(url.pathname);
      if (method === 'GET' && isObjectInfoRoute) {
        return storedObjects.has(filename)
          ? json({ name: filename, metadata: { size: storedObjects.get(filename).byteLength } })
          : json({ code: 'NoSuchKey', message: 'The object does not exist.' }, 400);
      }
      if (method === 'POST') {
        assert.equal(isUploadObjectRoute, true, 'private uploads use the authenticated server storage endpoint');
        assert.equal(headers.get('content-type'), 'application/pdf', 'uploads must retain the PDF MIME type');
        assert.equal(headers.get('cache-control'), 'private, no-store', 'uploaded private PDFs must not be cacheable as public content');
        assert.equal(headers.get('x-upsert'), 'false', 'an immutable upload must refuse replacement on collision');
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        storedObjects.set(filename, bytes);
        return json({ Key: filename }, 200);
      }
      if (method === 'GET') {
        assert.equal(isAuthenticatedObjectRoute, true, 'private object downloads must use Supabase authenticated storage routes');
        const bytes = storedObjects.get(filename);
        return bytes
          ? new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength) } })
          : json({ code: 'NoSuchKey', message: 'The object does not exist.' }, 400);
      }
    }
    throw new Error(`Unexpected Supabase Storage request: ${method} ${url.pathname}`);
  }

  if (url.origin === 'https://api.razorpay.com') {
    if (method === 'POST' && url.pathname === '/v1/orders') {
      const payload = JSON.parse(String(init.body || '{}'));
      assert.equal(payload.amount, 3900, 'the secure checkout keeps the fixed individual-PDF price');
      return json({ id: razorpayOrderId, amount: 3900, currency: 'INR' });
    }
    if (method === 'GET' && url.pathname === `/v1/payments/${razorpayPaymentId}`) {
      return json({ id: razorpayPaymentId, order_id: razorpayOrderId, amount: 3900, currency: 'INR', status: 'captured' });
    }
  }
  throw new Error(`Unexpected external fetch: ${method} ${url.href}`);
};

try {
  let response = await worker.fetch(request('/api/admin/login', 'POST', { password: env.ADMIN_PASSWORD }), env);
  assert.equal(response.status, 200, 'the test admin can establish a session');
  const cookie = response.headers.get('set-cookie').split(';')[0];

  response = await worker.fetch(request('/api/admin/files', 'GET', undefined, cookie), env);
  assert.equal(response.status, 200, 'an empty private Supabase library can be opened in admin');
  responseHasNoSupabaseLeak(response, 'file list');
  const emptyFilesText = await response.text();
  assert.doesNotMatch(emptyFilesText, new RegExp(supabaseOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the admin file list must not reveal the project URL');
  assert.deepEqual(JSON.parse(emptyFilesText).files, []);
  assert.deepEqual(bucket, privateBucketConfig, 'the first admin storage request creates a private PDF-only bucket');

  response = await worker.fetch(new Request(`${origin}/api/admin/files`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdfBytes.byteLength),
      'X-Upload-Filename': 'science-chapter-1.pdf'
    },
    body: pdfBytes
  }), env);
  assert.equal(response.status, 201, 'an authenticated admin can stream a PDF into the private bucket');
  responseHasNoSupabaseLeak(response, 'upload response');
  const uploaded = await response.json();
  assert.match(uploaded.file, /^upload-[0-9a-f]{32}-science-chapter-1\.pdf$/, 'single uploads must receive an immutable storage key');
  assert.deepEqual(storedObjects.get(uploaded.file), pdfBytes, 'the adapter stores the exact PDF bytes under its private key');

  response = await worker.fetch(request('/api/admin/files', 'GET', undefined, cookie), env);
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual(listed.files, [uploaded.file], 'the admin sees the private object key through the controlled API only');

  response = await worker.fetch(request('/api/admin/cards', 'POST', {
    sectionId: 'class-10-sample',
    title: 'Science Chapter 1 Sample Paper',
    subject: 'Science',
    fileKey: uploaded.file
  }, cookie), env);
  assert.equal(response.status, 201, 'a stored private PDF can be attached to a catalogue card');
  const card = (await response.json()).card;

  response = await worker.fetch(request(`/api/checkout/${card.slug}`, 'POST', {
    buyerEmail: 'student@example.test',
    buyerName: 'Student Test'
  }), env);
  assert.equal(response.status, 200, 'checkout confirms the PDF exists without revealing its storage location');
  responseHasNoSupabaseLeak(response, 'checkout response');
  const checkoutText = await response.text();
  assert.doesNotMatch(checkoutText, new RegExp(supabaseOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'checkout JSON must not contain a Supabase URL');
  const checkout = JSON.parse(checkoutText);

  const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${checkout.order.id}|${razorpayPaymentId}`).digest('hex');
  response = await worker.fetch(request('/api/payment/verify', 'POST', {
    razorpay_order_id: checkout.order.id,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: signature
  }), env);
  assert.equal(response.status, 200, 'a confirmed test payment produces a Worker download route');
  responseHasNoSupabaseLeak(response, 'payment confirmation');
  const verification = await response.json();
  assert.match(verification.downloadUrl, /^\/api\/download\//, 'students receive an opaque Worker route, not a provider URL');
  assert.equal(verification.downloadUrl.includes(supabaseOrigin), false);

  response = await worker.fetch(request(verification.downloadUrl), env);
  assert.equal(response.status, 200, 'the Worker streams the protected private PDF after purchase confirmation');
  responseHasNoSupabaseLeak(response, 'protected download');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.match(response.headers.get('content-disposition'), /science-chapter-1\.pdf/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdfBytes, 'the protected download streams the original bytes');

  // Supabase returns a 400/NoSuchKey for a missing private object on some
  // renderer paths. It is a normal missing-file result, not a storage outage.
  const savedPdf = storedObjects.get(uploaded.file);
  storedObjects.delete(uploaded.file);
  response = await worker.fetch(request(verification.downloadUrl), env);
  assert.equal(response.status, 404, 'a Supabase 400/NoSuchKey is presented as a missing protected PDF');
  storedObjects.set(uploaded.file, savedPdf);

  assert.ok(storageCalls.some((call) => call.method === 'POST' && call.pathname === '/storage/v1/bucket'), 'the private bucket creation endpoint is exercised');
  assert.ok(storageCalls.some((call) => call.method === 'POST' && call.pathname === '/storage/v1/object/list/tks-papers'), 'private object listing is exercised');
  assert.ok(storageCalls.some((call) => call.method === 'GET' && call.pathname.startsWith('/storage/v1/object/info/authenticated/tks-papers/')), 'private object checks use Supabase authenticated object-info storage');
  assert.ok(storageCalls.some((call) => call.method === 'POST' && call.pathname.startsWith('/storage/v1/object/tks-papers/')), 'private object upload is exercised');
  assert.ok(storageCalls.some((call) => call.method === 'GET' && call.pathname.startsWith('/storage/v1/object/authenticated/tks-papers/')), 'private object download is exercised through Supabase authenticated storage');

  // A maximum-size admin batch must stay well below Workers Free's 50
  // subrequest ceiling. One request-scoped bucket verification plus ten
  // collision checks and ten writes gives the D1 card work room to run too.
  const bulkFiles = Array.from({ length: 10 }, (_, index) => `batch-${String(index + 1).padStart(2, '0')}.pdf`);
  const bulkCards = bulkFiles.map((fileKey, index) => ({
    fileKey,
    sectionId: 'class-10-sample',
    title: `Batch science paper ${index + 1}`,
    subject: 'Science',
    isPublished: false
  }));
  const form = new FormData();
  for (const filename of bulkFiles) form.append('files', new File([pdfBytes], filename, { type: 'application/pdf' }));
  form.append('metadata', JSON.stringify({ cards: bulkCards }));
  const multipart = new Response(form);
  const multipartBytes = new Uint8Array(await multipart.arrayBuffer());
  const beforeBulkCalls = storageCalls.length;
  response = await worker.fetch(new Request(`${origin}/api/admin/bulk`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': multipart.headers.get('content-type'),
      'Content-Length': String(multipartBytes.byteLength)
    },
    body: multipartBytes
  }), env);
  assert.equal(response.status, 201, 'a full ten-file batch uploads within the Worker request budget');
  const bulkResult = await response.json();
  assert.equal(bulkResult.count, 10);
  assert.equal(bulkResult.files.length, 10);
  const bulkStorageCalls = storageCalls.slice(beforeBulkCalls);
  assert.equal(bulkStorageCalls.filter((call) => call.method === 'GET' && call.pathname === '/storage/v1/bucket/tks-papers').length, 1, 'one private-bucket verification is reused within a batch');
  assert.equal(bulkStorageCalls.filter((call) => call.method === 'GET' && call.pathname.startsWith('/storage/v1/object/info/authenticated/tks-papers/')).length, 10, 'each generated batch key is checked once');
  assert.equal(bulkStorageCalls.filter((call) => call.method === 'POST' && call.pathname.startsWith('/storage/v1/object/tks-papers/')).length, 10, 'each batch PDF is written once');
  assert.ok(bulkStorageCalls.length <= 22, 'bulk storage traffic leaves room below the Workers Free subrequest limit');

  // Fail closed if a dashboard setting ever turns the bucket public.
  bucket.public = true;
  response = await worker.fetch(request(`/api/checkout/${card.slug}`, 'POST', {
    buyerEmail: 'another-student@example.test',
    buyerName: 'Another Student'
  }), env);
  assert.equal(response.status, 502, 'checkout must fail closed when the bucket is no longer private');
  assert.match((await response.json()).error, /must remain private/i);

  response = await worker.fetch(request(verification.downloadUrl), env);
  assert.equal(response.status, 502, 'an already-issued Worker download must fail closed when the bucket becomes public');
  assert.match((await response.json()).error, /must remain private/i);

  response = await worker.fetch(request('/api/admin/files', 'GET', undefined, cookie), env);
  assert.equal(response.status, 502, 'a public bucket is rejected before it can be used for uploads or sales');
  const failure = await response.json();
  assert.match(failure.error, /must remain private/i);
  assert.equal(String(failure.error).includes(supabaseOrigin), false, 'private-bucket failures must not reveal the project URL');
} finally {
  globalThis.fetch = originalFetch;
}

console.log(JSON.stringify({ storageCalls: storageCalls.length, storage: 'supabase-private-smoke-ok' }));
