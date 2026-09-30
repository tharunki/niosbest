import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from './worker.mjs';

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
for (const migration of ['0001_initial.sql', '0002_checkout_rate_limit.sql', '0003_cards_fts.sql', '0004_catalog_sections.sql', '0005_public_and_purchase_indexes.sql', '0006_business_admin_and_seo.sql', '0007_analytics_retention_indexes.sql', '0008_rate_limit_retention_indexes.sql']) {
  sqlite.exec(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
}

const storedFiles = new Set(['published.pdf']);
const env = {
  DB: new D1Database(sqlite),
  PAPERS: {
    async head(name) { return storedFiles.has(name) ? { size: 1 } : null; },
    async list() { return { objects: [...storedFiles].map((key) => ({ key })), truncated: false }; },
    async get(name) {
      if (!storedFiles.has(name)) return null;
      return { size: 8, body: new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55]), writeHttpMetadata() {} };
    },
    async put(name) { storedFiles.add(name); },
    async delete(name) { storedFiles.delete(name); }
  },
  ADMIN_PASSWORD: 'a-long-test-password',
  DOWNLOAD_TOKEN_SECRET: 'a-long-test-download-secret-that-is-over-32-characters'
};
const origin = 'https://best-education.test';
const jsonRequest = (path, body, cookie = '') => new Request(`${origin}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body)
});
const adminRequest = (path, method, body, cookie) => new Request(`${origin}${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});
const webhookRequest = (event, payment, webhookSecret) => {
  const body = JSON.stringify({ event, payload: { payment: { entity: payment } } });
  return new Request(`${origin}/api/payment/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Razorpay-Signature': createHmac('sha256', webhookSecret).update(body).digest('hex')
    },
    body
  });
};
const call = (request) => worker.fetch(request, env);

const login = await call(jsonRequest('/api/admin/login', { password: env.ADMIN_PASSWORD }));
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];

const originalSessionExpiry = sqlite.prepare('SELECT expires_at FROM admin_sessions').get().expires_at;
let response = await call(adminRequest('/api/admin/session', 'GET', undefined, cookie));
assert.equal(response.status, 200);
assert.equal(sqlite.prepare('SELECT expires_at FROM admin_sessions').get().expires_at, originalSessionExpiry, 'a fresh admin session must not write to D1 on every request');
sqlite.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now() + 1_000);
response = await call(adminRequest('/api/admin/session', 'GET', undefined, cookie));
assert.equal(response.status, 200);
assert.ok(sqlite.prepare('SELECT expires_at FROM admin_sessions').get().expires_at > Date.now() + 10 * 60 * 60 * 1_000, 'a near-expiry admin session must be renewed');

response = await call(new Request(`${origin}/api/catalog`, { method: 'PATCH' }));
assert.equal(response.status, 405, 'unsupported API methods must be rejected predictably');
assert.equal(response.headers.get('allow'), 'GET, POST, PUT, DELETE');
response = await call(new Request(`${origin}/api/payment/webhook`));
assert.equal(response.status, 405, 'payment webhooks only accept their signed POST requests');
assert.equal(response.headers.get('allow'), 'POST');
response = await call(new Request(`${origin}/`, { method: 'POST' }));
assert.equal(response.status, 405, 'static routes accept only GET and HEAD');
assert.equal(response.headers.get('allow'), 'GET, HEAD');
const requestedStaticAssets = [];
const staticEnv = { ASSETS: { async fetch(request) {
  requestedStaticAssets.push(new URL(request.url).pathname);
  return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} } };
for (const [alias, target] of [
  ['/', '/index.html'], ['/index', '/index.html'], ['/admin', '/admin.html'], ['/library', '/library.html'],
  ['/privacy', '/privacy.html'], ['/terms', '/terms.html'],
  ['/sample-papers', '/sample-papers.html'], ['/pyqs', '/pyqs.html'], ['/mcqs', '/mcqs.html'], ['/important-questions', '/important-questions.html']
]) {
  response = await worker.fetch(new Request(`${origin}${alias}`), staticEnv);
  assert.equal(response.status, 200, `${alias} must be served without a redirect`);
  assert.equal(requestedStaticAssets.at(-1), target, `${alias} must resolve to its HTML page`);
}
response = await call(new Request(`${origin}/api/admin/session`, { headers: { Cookie: 'unrelated=%E0%A4%A' } }));
assert.equal(response.status, 200, 'a malformed unrelated cookie must not crash the request');
assert.equal((await response.json()).authenticated, false);

response = await call(jsonRequest('/api/admin/login', null));
assert.equal(response.status, 400, 'non-object sign-in JSON is rejected without causing a worker error');

response = await call(adminRequest('/api/admin/cards', 'POST', { title: 'x'.repeat(1_000_001) }, cookie));
assert.equal(response.status, 413, 'oversized JSON is rejected while streaming before any card write');
response = await call(new Request(`${origin}/healthz`));
assert.equal(response.status, 200, 'health checks verify all live D1 tables');
assert.equal((await response.json()).payments.ready, false, 'health reports when payment delivery is intentionally unavailable');
const originalConsoleError = console.error;
console.error = () => {};
try {
  response = await worker.fetch(new Request(`${origin}/healthz`), { ...env, DB: { prepare() { throw new Error('missing migration'); } } });
  assert.equal(response.status, 503, 'health checks fail closed when D1 migrations are missing');
} finally {
  console.error = originalConsoleError;
}

response = await call(adminRequest('/api/admin/sections', 'POST', {
  title: 'Formula Cheat Sheets', parentId: 'jee', isPublished: true, sortOrder: 10,
  tags: ['formula', 'quick revision'], metaTitle: 'JEE Formula Cheat Sheets', metaDescription: 'Fast JEE revision sheets.', seoKeywords: 'JEE formulas, revision'
}, cookie));
assert.equal(response.status, 201);
const formulaSection = (await response.json()).section;
assert.deepEqual(formulaSection.tags, ['formula', 'quick revision']);
assert.equal(formulaSection.metaTitle, 'JEE Formula Cheat Sheets');

response = await call(adminRequest('/api/admin/sections/jee', 'PUT', { title: 'JEE', isPublished: false }, cookie));
assert.equal(response.status, 200);
response = await call(new Request(`${origin}/api/catalog`));
assert.equal((await response.json()).sections.some((section) => section.id === 'jee'), false, 'draft root must hide child catalogue content');
response = await call(new Request(`${origin}/collection/${formulaSection.slug}`));
assert.equal(response.status, 404, 'a child collection stays private while its root collection is a draft');

response = await call(adminRequest('/api/admin/sections/jee', 'PUT', { title: 'JEE', isPublished: true }, cookie));
assert.equal(response.status, 200);

response = await call(adminRequest('/api/admin/cards', 'POST', {
  sectionId: formulaSection.id,
  title: 'Physics Formula Sheet',
  resourceLabel: 'Formula Cheat Sheet', tags: ['physics', 'formula'], metaTitle: 'JEE Physics Formula Sheet', metaDescription: 'Physics formula revision sheet.', seoKeywords: 'physics, JEE formula'
}, cookie));
assert.equal(response.status, 201);
const genericCard = (await response.json()).card;
assert.equal(genericCard.isPublished, false, 'new generic cards are drafts');
assert.equal(genericCard.displayClassName, 'JEE');
assert.equal(genericCard.displayType, 'Formula Cheat Sheets');
assert.deepEqual(genericCard.tags, ['physics', 'formula']);
assert.equal(genericCard.metaTitle, 'JEE Physics Formula Sheet');

response = await call(adminRequest(`/api/admin/cards/${genericCard.id}`, 'PUT', { isPublished: true }, cookie));
assert.equal(response.status, 200);

response = await call(new Request(`${origin}/collection/${formulaSection.slug}`));
assert.equal(response.status, 200, 'a published collection has a server-rendered public route');
const collectionHtml = await response.text();
assert.match(collectionHtml, /<title>JEE Formula Cheat Sheets<\/title>/, 'collection pages use the section meta title');
assert.match(collectionHtml, /Fast JEE revision sheets\./, 'collection pages use the section meta description');
assert.match(collectionHtml, /name="keywords" content="jee formulas, revision"/, 'collection pages use section SEO keywords');
assert.match(collectionHtml, /Physics Formula Sheet/, 'collection pages include their published resources in the initial HTML');
assert.match(collectionHtml, /src="\/analytics\.js"/, 'collection pages include shared privacy-respecting analytics');
response = await call(new Request(`${origin}/collection/jee`));
assert.equal(response.status, 200);
assert.match(await response.text(), new RegExp(`/collection/${formulaSection.slug}`), 'parent collection pages link to their public child collections');

response = await call(adminRequest('/api/admin/cards', 'POST', {
  sectionId: 'class-10-mcq', title: 'Chemical Reactions MCQ', subject: 'Science'
}, cookie));
assert.equal(response.status, 201);
const legacyCard = (await response.json()).card;
assert.equal(legacyCard.isPublished, true, 'seeded legacy child tiles retain old published-card behaviour');
assert.equal(legacyCard.className, '10');
assert.equal(legacyCard.type, 'mcq');

response = await call(adminRequest('/api/admin/cards', 'POST', {
  sectionId: 'class-10-sample', title: 'Published PDF', subject: 'Science', fileKey: 'published.pdf'
}, cookie));
assert.equal(response.status, 201);
const paidCard = (await response.json()).card;

const configuredButPausedEnv = { ...env, RAZORPAY_KEY_ID: 'rzp_test_checkout', RAZORPAY_KEY_SECRET: 'checkout-secret', RAZORPAY_WEBHOOK_SECRET: 'checkout-webhook-secret' };
response = await worker.fetch(new Request(`${origin}/api/papers/slug/${paidCard.slug}`), configuredButPausedEnv);
assert.equal((await response.json()).paper.available, false, 'a configured-but-paused payment system never advertises a buyable PDF');
response = await worker.fetch(new Request(`${origin}/paper/${paidCard.slug}`), configuredButPausedEnv);
assert.match(await response.text(), /noindex,nofollow/, 'a configured-but-paused paid paper is not indexable');
response = await worker.fetch(new Request(`${origin}/healthz`), configuredButPausedEnv);
assert.equal((await response.json()).payments.ready, false, 'health keeps sales closed until the explicit payment switch is enabled');
response = await worker.fetch(jsonRequest(`/api/checkout/${paidCard.slug}`, { buyerEmail: 'student@example.test', buyerName: 'Test Student' }), configuredButPausedEnv);
assert.equal(response.status, 503, 'checkout stays closed while the owner has not explicitly opened sales');
assert.equal((await response.json()).code, 'PAYMENTS_DISABLED');

const incompletePaymentEnv = { ...env, PAYMENTS_ENABLED: 'true', RAZORPAY_KEY_ID: 'rzp_test_checkout', RAZORPAY_KEY_SECRET: 'checkout-secret' };
response = await worker.fetch(jsonRequest(`/api/checkout/${paidCard.slug}`, { buyerEmail: 'student@example.test', buyerName: 'Test Student' }), incompletePaymentEnv);
assert.equal(response.status, 503, 'checkout stays closed until protected downloads and a webhook are configured');
assert.equal((await response.json()).code, 'PAYMENT_DELIVERY_UNAVAILABLE');

const checkoutEnv = { ...configuredButPausedEnv, PAYMENTS_ENABLED: 'true' };
response = await worker.fetch(new Request(`${origin}/healthz`), checkoutEnv);
assert.equal((await response.json()).payments.ready, true, 'health reports when a complete payment setup has explicitly opened sales');
const originalFetch = globalThis.fetch;
let fakeOrderNumber = 0;
let firstCheckout;
globalThis.fetch = async () => new Response(JSON.stringify({ id: `order_test_${++fakeOrderNumber}`, amount: 3900, currency: 'INR' }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
});
try {
  const checkoutRequests = await Promise.all(Array.from({ length: 13 }, () => worker.fetch(new Request(`${origin}/api/checkout/${paidCard.slug}`, {
    method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.250', 'Content-Type': 'application/json' }, body: JSON.stringify({ buyerEmail: 'student@example.test', buyerName: 'Test Student' })
  }), checkoutEnv)));
  assert.equal(checkoutRequests.filter((item) => item.status === 200).length, 12, 'parallel checkout requests can consume only the configured quota');
  assert.equal(checkoutRequests.filter((item) => item.status === 429).length, 1, 'the first checkout request beyond the quota is denied atomically');
  const firstCheckoutResponse = checkoutRequests.find((item) => item.status === 200);
  firstCheckout = await firstCheckoutResponse.json();
  const recoveryCookie = firstCheckoutResponse.headers.get('set-cookie').split(';')[0];
  assert.equal(firstCheckout.recovery.token, undefined, 'the checkout JSON must never expose the recovery bearer token');
  assert.match(firstCheckoutResponse.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict; Path=\/api\/payment\/recover/);
  response = await worker.fetch(jsonRequest('/api/payment/recover', { orderId: firstCheckout.order.id }), checkoutEnv);
  assert.equal(response.status, 400, 'purchase recovery requires its HttpOnly browser cookie');
  response = await worker.fetch(new Request(`${origin}/api/payment/recover`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: recoveryCookie }, body: JSON.stringify({ orderId: firstCheckout.order.id })
  }), checkoutEnv);
  assert.equal(response.status, 202, 'the HttpOnly recovery cookie can safely resume a pending purchase');
} finally {
  globalThis.fetch = originalFetch;
}

response = await worker.fetch(jsonRequest(`/api/checkout/${paidCard.slug}`, { buyerName: 'Missing email' }), checkoutEnv);
assert.equal(response.status, 400, 'secure checkout requires a buyer email before an order can be created');

const verifiedOrder = sqlite.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(firstCheckout.order.id);
const retryOrder = sqlite.prepare("SELECT * FROM orders WHERE status = 'created' AND razorpay_order_id <> ? LIMIT 1").get(verifiedOrder.razorpay_order_id);
assert.ok(retryOrder, 'parallel checkout test provides an order for webhook retry coverage');
response = await worker.fetch(webhookRequest('payment.failed', {
  id: 'pay_test_failed_attempt', order_id: retryOrder.razorpay_order_id, status: 'failed'
}, checkoutEnv.RAZORPAY_WEBHOOK_SECRET), checkoutEnv);
assert.equal(response.status, 200, 'a valid failed-payment webhook is accepted');
let retryOrderRow = sqlite.prepare('SELECT status,razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(retryOrder.razorpay_order_id);
assert.equal(retryOrderRow.status, 'failed', 'a failed payment marks an unfinished order as failed');
assert.equal(retryOrderRow.razorpay_payment_id, null, 'a failed transaction ID is never stored as the successful payment ID');
response = await worker.fetch(webhookRequest('payment.captured', {
  id: 'pay_test_wrong_amount', order_id: retryOrder.razorpay_order_id, amount: 3901, currency: 'INR', status: 'captured'
}, checkoutEnv.RAZORPAY_WEBHOOK_SECRET), checkoutEnv);
assert.equal(response.status, 200, 'a signed webhook with the wrong amount is acknowledged but not fulfilled');
retryOrderRow = sqlite.prepare('SELECT status,razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(retryOrder.razorpay_order_id);
assert.equal(retryOrderRow.status, 'failed', 'a captured webhook with the wrong amount cannot mark an order paid');
assert.equal(retryOrderRow.razorpay_payment_id, null, 'a captured webhook with the wrong amount cannot store a payment ID');
response = await worker.fetch(webhookRequest('payment.captured', {
  id: 'pay_test_wrong_currency', order_id: retryOrder.razorpay_order_id, amount: 3900, currency: 'USD', status: 'captured'
}, checkoutEnv.RAZORPAY_WEBHOOK_SECRET), checkoutEnv);
assert.equal(response.status, 200, 'a signed webhook with the wrong currency is acknowledged but not fulfilled');
retryOrderRow = sqlite.prepare('SELECT status,razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(retryOrder.razorpay_order_id);
assert.equal(retryOrderRow.status, 'failed', 'a captured webhook with the wrong currency cannot mark an order paid');
assert.equal(retryOrderRow.razorpay_payment_id, null, 'a captured webhook with the wrong currency cannot store a payment ID');
const pausedSettlementEnv = { ...checkoutEnv, PAYMENTS_ENABLED: 'false' };
response = await worker.fetch(webhookRequest('payment.captured', {
  id: 'pay_test_successful_retry', order_id: retryOrder.razorpay_order_id, amount: 3900, currency: 'INR', status: 'captured'
}, checkoutEnv.RAZORPAY_WEBHOOK_SECRET), pausedSettlementEnv);
assert.equal(response.status, 200, 'an in-flight captured payment is settled even after new sales are paused');
retryOrderRow = sqlite.prepare('SELECT status,razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(retryOrder.razorpay_order_id);
assert.equal(retryOrderRow.status, 'captured', 'a captured retry restores the paid order state');
assert.equal(retryOrderRow.razorpay_payment_id, 'pay_test_successful_retry', 'the successful transaction ID is retained for recovery');
response = await worker.fetch(webhookRequest('payment.failed', {
  id: 'pay_test_late_failure', order_id: retryOrder.razorpay_order_id, status: 'failed'
}, checkoutEnv.RAZORPAY_WEBHOOK_SECRET), checkoutEnv);
assert.equal(response.status, 200, 'a late failed-payment webhook is safely acknowledged');
retryOrderRow = sqlite.prepare('SELECT status,razorpay_payment_id FROM orders WHERE razorpay_order_id = ?').get(retryOrder.razorpay_order_id);
assert.equal(retryOrderRow.status, 'captured', 'a late failure cannot downgrade a captured purchase');
assert.equal(retryOrderRow.razorpay_payment_id, 'pay_test_successful_retry', 'a late failure cannot replace the successful transaction ID');
// The remaining export/import coverage needs no active-link guard from this
// synthetic captured retry, so age only its test access window out.
sqlite.prepare('UPDATE orders SET recovery_expires_at=? WHERE razorpay_order_id=?').run('2000-01-01T00:00:00.000Z', retryOrder.razorpay_order_id);
const paymentId = 'pay_test_1';
const signature = createHmac('sha256', checkoutEnv.RAZORPAY_KEY_SECRET)
  .update(`${verifiedOrder.razorpay_order_id}|${paymentId}`).digest('hex');
globalThis.fetch = async (url) => new Response(JSON.stringify({
  id: paymentId, order_id: verifiedOrder.razorpay_order_id, amount: 3900, currency: 'INR', status: 'captured'
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
let verifiedPurchase;
try {
  response = await worker.fetch(jsonRequest('/api/payment/verify', {
    razorpay_order_id: verifiedOrder.razorpay_order_id,
    razorpay_payment_id: paymentId,
    razorpay_signature: signature
  }), checkoutEnv);
  assert.equal(response.status, 200, 'captured payment creates an order-bound secure download token');
  verifiedPurchase = await response.json();
} finally {
  globalThis.fetch = originalFetch;
}
assert.ok(verifiedPurchase.downloadUrl.includes(verifiedOrder.razorpay_order_id) === false, 'order IDs remain signed inside the opaque download token');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM students').get().count, 1, 'student profile is created only after payment capture');
response = await call(new Request(`${origin}${verifiedPurchase.downloadUrl}`));
assert.equal(response.status, 200, 'an order-bound token serves the protected PDF before an access revocation');

response = await call(jsonRequest('/api/analytics/visit', {}));
assert.equal(response.status, 200, 'public visit events are accepted without a student/admin session');
const anonymousVisitor = sqlite.prepare("SELECT visitor_hash FROM analytics_visitors WHERE day <> '2000-01-01' LIMIT 1").get();
assert.notEqual(anonymousVisitor.visitor_hash, createHash('sha256').update('unknown').digest('hex'), 'analytics stores a purpose-scoped keyed hash instead of an enumerable IP hash');
sqlite.prepare('INSERT INTO analytics_attempts (client_hash,count,window_started_at) VALUES (?,?,?)').run('old-analytics-attempt', 1, Date.now() - 9 * 24 * 60 * 60 * 1000);
sqlite.prepare('INSERT INTO feedback_attempts (client_hash,count,window_started_at) VALUES (?,?,?)').run('old-feedback-attempt', 1, Date.now() - 9 * 24 * 60 * 60 * 1000);
sqlite.prepare('INSERT INTO login_attempts (client_hash,count,window_started_at) VALUES (?,?,?)').run('old-login-attempt', 1, Date.now() - 9 * 24 * 60 * 60 * 1000);
sqlite.prepare('INSERT INTO checkout_attempts (client_hash,count,window_started_at) VALUES (?,?,?)').run('old-checkout-attempt', 1, Date.now() - 9 * 24 * 60 * 60 * 1000);
sqlite.prepare('INSERT INTO analytics_visitors (day,visitor_hash,created_at) VALUES (?,?,?)').run('2000-01-01', 'old-visitor', '2000-01-01T00:00:00.000Z');
sqlite.prepare('INSERT INTO analytics_daily (day,visits,unique_visitors,created_at,updated_at) VALUES (?,?,?,?,?)').run('2000-01-01', 1, 1, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z');
const abandonedOrder = sqlite.prepare("SELECT razorpay_order_id FROM orders WHERE status = 'created' AND razorpay_order_id <> ? LIMIT 1").get(firstCheckout.order.id);
assert.ok(abandonedOrder, 'parallel checkout test provides an unpaid order for privacy retention coverage');
sqlite.prepare("UPDATE orders SET buyer_email=?, buyer_name=?, recovery_token_hash=?, recovery_expires_at=? WHERE razorpay_order_id=?")
  .run('abandoned@example.test', 'Abandoned Buyer', 'old-recovery-token-hash', '2000-01-01T00:00:00.000Z', abandonedOrder.razorpay_order_id);
const failedOrder = sqlite.prepare("SELECT razorpay_order_id FROM orders WHERE status = 'created' AND razorpay_order_id <> ? AND razorpay_order_id <> ? LIMIT 1")
  .get(firstCheckout.order.id, abandonedOrder.razorpay_order_id);
assert.ok(failedOrder, 'parallel checkout test provides a failed order for privacy retention coverage');
sqlite.prepare("UPDATE orders SET status=?, buyer_email=?, buyer_name=?, recovery_token_hash=?, recovery_expires_at=? WHERE razorpay_order_id=?")
  .run('failed', 'failed@example.test', 'Failed Buyer', 'failed-recovery-token-hash', '2000-01-01T00:00:00.000Z', failedOrder.razorpay_order_id);
sqlite.prepare('INSERT INTO admin_sessions (token_hash,expires_at,created_at) VALUES (?,?,?)')
  .run('expired-session-hash', Date.now() - 1, '2000-01-01T00:00:00.000Z');
const scheduledTasks = [];
await worker.scheduled({}, env, { waitUntil(task) { scheduledTasks.push(task); } });
await Promise.all(scheduledTasks);
assert.equal(sqlite.prepare("SELECT 1 FROM analytics_attempts WHERE client_hash = 'old-analytics-attempt'").get(), undefined, 'scheduled cleanup removes expired analytics rate-limit rows');
assert.equal(sqlite.prepare("SELECT 1 FROM feedback_attempts WHERE client_hash = 'old-feedback-attempt'").get(), undefined, 'scheduled cleanup removes expired feedback rate-limit rows');
assert.equal(sqlite.prepare("SELECT 1 FROM login_attempts WHERE client_hash = 'old-login-attempt'").get(), undefined, 'scheduled cleanup removes expired login rate-limit rows');
assert.equal(sqlite.prepare("SELECT 1 FROM checkout_attempts WHERE client_hash = 'old-checkout-attempt'").get(), undefined, 'scheduled cleanup removes expired checkout rate-limit rows');
assert.equal(sqlite.prepare("SELECT 1 FROM admin_sessions WHERE token_hash = 'expired-session-hash'").get(), undefined, 'scheduled cleanup removes expired admin sessions');
assert.equal(sqlite.prepare("SELECT 1 FROM analytics_visitors WHERE visitor_hash = 'old-visitor'").get(), undefined, 'scheduled cleanup removes expired anonymous visitor hashes');
assert.equal(sqlite.prepare("SELECT 1 FROM analytics_daily WHERE day = '2000-01-01'").get(), undefined, 'scheduled cleanup retains only the configured analytics history');
const redactedOrder = sqlite.prepare('SELECT status,buyer_email,buyer_name,recovery_token_hash FROM orders WHERE razorpay_order_id = ?').get(abandonedOrder.razorpay_order_id);
assert.equal(redactedOrder.status, 'created', 'privacy cleanup retains a non-personal audit of an abandoned checkout');
assert.equal(redactedOrder.buyer_email, '', 'privacy cleanup removes abandoned buyer email after recovery expiry');
assert.equal(redactedOrder.buyer_name, '', 'privacy cleanup removes abandoned buyer name after recovery expiry');
assert.match(redactedOrder.recovery_token_hash, /^expired:/, 'privacy cleanup invalidates the old recovery capability without violating the unique schema constraint');
const redactedFailedOrder = sqlite.prepare('SELECT status,buyer_email,buyer_name,recovery_token_hash FROM orders WHERE razorpay_order_id = ?').get(failedOrder.razorpay_order_id);
assert.equal(redactedFailedOrder.status, 'failed', 'privacy cleanup retains the failed checkout status');
assert.equal(redactedFailedOrder.buyer_email, '', 'privacy cleanup removes failed buyer email after recovery expiry');
assert.equal(redactedFailedOrder.buyer_name, '', 'privacy cleanup removes failed buyer name after recovery expiry');
assert.match(redactedFailedOrder.recovery_token_hash, /^expired:/, 'privacy cleanup invalidates failed-order recovery capability');
assert.equal(sqlite.prepare('SELECT buyer_email FROM orders WHERE razorpay_order_id = ?').get(verifiedOrder.razorpay_order_id).buyer_email, 'student@example.test', 'privacy cleanup never touches a captured or fulfilled purchase');
response = await call(adminRequest('/api/admin/dashboard', 'GET', undefined, cookie));
const dashboard = await response.json();
assert.equal(response.status, 200);
assert.ok(dashboard.users.dailyActive >= 1, 'dashboard summarizes deduplicated daily active users');
assert.equal(dashboard.revenue.today, 78, 'dashboard totals both captured fixed-price purchases');

response = await call(adminRequest('/api/admin/orders', 'GET', undefined, cookie));
assert.equal(response.status, 200);
assert.ok((await response.json()).orders.some((order) => order.id === verifiedOrder.razorpay_order_id), 'admin can list paid orders');
response = await call(adminRequest('/api/admin/students', 'GET', undefined, cookie));
const students = (await response.json()).students;
assert.equal(students[0].email, 'student@example.test', 'students are derived from captured purchase emails');
response = await call(adminRequest(`/api/admin/students/${students[0].id}/password-reset`, 'POST', {}, cookie));
assert.equal(response.status, 200, 'password reset requests are logged without pretending student login exists');

response = await call(adminRequest('/api/admin/promotions', 'POST', {
  code: 'NEET2025', title: 'NEET early revision', description: 'A future campaign', discountType: 'percent', discountValue: 10, isActive: true
}, cookie));
assert.equal(response.status, 201, 'promotions can be stored without affecting checkout');
const promotion = (await response.json()).promotion;
assert.equal(promotion.checkoutEnabled, false);
response = await call(adminRequest(`/api/admin/promotions/${promotion.id}`, 'PUT', { title: 'Updated NEET campaign', isActive: false }, cookie));
assert.equal(response.status, 200, 'promotion metadata can be edited safely');

response = await call(jsonRequest('/api/feedback', {
  slug: genericCard.slug,
  title: genericCard.title,
  category: 'wrong-answer',
  message: 'Please review question 4.',
  email: 'not-collected@example.test',
  name: 'Not Collected'
}));
assert.equal(response.status, 201, 'public feedback is stored through the rate-limited inbox');
response = await call(adminRequest('/api/admin/feedback', 'GET', undefined, cookie));
const feedback = (await response.json()).feedback;
assert.equal(feedback[0].status, 'open');
assert.equal(feedback[0].email, '', 'public feedback ignores unsolicited email payloads');
assert.equal(feedback[0].name, '', 'public feedback ignores unsolicited name payloads');
assert.equal(sqlite.prepare('SELECT client_hash FROM feedback WHERE id = ?').get(feedback[0].id).client_hash, '', 'feedback reports do not persist an identifying connection hash');
response = await call(adminRequest(`/api/admin/feedback/${feedback[0].id}`, 'PUT', { status: 'resolved', adminNote: 'Reviewed.' }, cookie));
assert.equal(response.status, 200, 'admin can resolve feedback reports');

const pagedFeedbackTime = new Date().toISOString();
const insertPagedFeedback = sqlite.prepare(`INSERT INTO feedback
  (id,card_id,slug,resource_title,category,email,name,message,status,admin_note,client_hash,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
for (let index = 0; index < 55; index += 1) {
  insertPagedFeedback.run(`paged-feedback-${index}`, null, '', `Paged report ${index}`, 'general', '', '', `Pagination report ${index}`, 'open', '', '', pagedFeedbackTime, pagedFeedbackTime);
}
response = await call(adminRequest('/api/admin/feedback?limit=50&offset=0', 'GET', undefined, cookie));
const firstFeedbackPage = await response.json();
assert.equal(firstFeedbackPage.feedback.length, 50, 'admin feedback uses bounded server-side pages');
assert.equal(firstFeedbackPage.hasMore, true, 'admin feedback reveals when a subsequent page exists');
assert.equal(firstFeedbackPage.nextOffset, 50, 'admin feedback returns the next safe offset');
response = await call(adminRequest('/api/admin/feedback?limit=50&offset=50', 'GET', undefined, cookie));
const secondFeedbackPage = await response.json();
assert.ok(secondFeedbackPage.feedback.length >= 6, 'a later feedback page contains remaining records');
assert.equal(secondFeedbackPage.hasMore, false, 'the final feedback page is identified accurately');

const bulkForm = new FormData();
bulkForm.append('files', new Blob(['%PDF-1.7\n'], { type: 'application/pdf' }), 'bulk-draft.pdf');
bulkForm.append('metadata', 'filename,title,sectionId,subject,tags\nbulk-draft.pdf,Bulk Draft,class-10-mcq,Science,"batch, revision"\n');
response = await call(new Request(`${origin}/api/admin/bulk`, { method: 'POST', headers: { Cookie: cookie }, body: bulkForm }));
assert.equal(response.status, 411, 'bulk uploads without a declared size are rejected before multipart parsing');
const boundedBulkRequest = new Request(`${origin}/api/admin/bulk`, { method: 'POST', body: bulkForm });
const boundedBulkBody = await boundedBulkRequest.arrayBuffer();
response = await call(new Request(`${origin}/api/admin/bulk`, {
  method: 'POST',
  headers: {
    Cookie: cookie,
    'Content-Type': boundedBulkRequest.headers.get('Content-Type'),
    'Content-Length': String(boundedBulkBody.byteLength)
  },
  body: boundedBulkBody
}));
assert.equal(response.status, 201, 'bulk upload accepts bounded PDF + CSV batches');
const bulkResult = await response.json();
assert.equal(bulkResult.cards[0].isPublished, false, 'bulk card rows default to draft even in legacy public tiles');
assert.deepEqual(bulkResult.cards[0].tags, ['batch', 'revision']);
assert.notEqual(bulkResult.cards[0].fileKey, 'bulk-draft.pdf', 'bulk uploads use immutable server-generated storage keys');
assert.equal(storedFiles.has(bulkResult.cards[0].fileKey), true, 'the generated storage key is the only new object created for the batch');

response = await call(new Request(`${origin}/api/papers?tag=physics`));
assert.ok((await response.json()).papers.some((paper) => paper.id === genericCard.id), 'public search matches normalized card tags');
response = await call(new Request(`${origin}/paper/${genericCard.slug}`));
const paperHtml = await response.text();
assert.match(paperHtml, /JEE Physics Formula Sheet/);
assert.match(paperHtml, /Physics formula revision sheet/);

response = await call(adminRequest(`/api/admin/orders/${verifiedOrder.razorpay_order_id}`, 'PUT', { markRefunded: true, refundNote: 'Smoke-test refund record' }, cookie));
assert.equal(response.status, 200, 'admin can revoke/refund an order record without calling a payment provider');
assert.equal((await response.json()).order.status, 'refunded');
response = await call(new Request(`${origin}${verifiedPurchase.downloadUrl}`));
assert.equal(response.status, 403, 'a refunded order cannot use an already-issued order-bound download link');

const withoutPaperStorage = { ...env, PAPERS: undefined };
const callWithoutPaperStorage = (request) => worker.fetch(request, withoutPaperStorage);
response = await callWithoutPaperStorage(new Request(`${origin}/api/papers/slug/${paidCard.slug}`));
assert.equal(response.status, 200);
assert.equal((await response.json()).paper.available, false, 'the public page must not advertise a buy button without protected storage');
response = await callWithoutPaperStorage(adminRequest('/api/admin/files', 'GET', undefined, cookie));
assert.equal(response.status, 503, 'the admin file list explains missing storage instead of crashing');
assert.equal((await response.json()).code, 'PAPER_STORAGE_UNAVAILABLE');
response = await callWithoutPaperStorage(new Request(`${origin}/api/admin/files`, {
  method: 'POST',
  headers: { Cookie: cookie, 'Content-Type': 'application/pdf', 'X-Upload-Filename': 'blocked.pdf' },
  body: '%PDF-1.7\n'
}));
assert.equal(response.status, 503, 'the admin cannot upload files while storage is absent');
response = await callWithoutPaperStorage(adminRequest('/api/admin/files/published.pdf', 'DELETE', undefined, cookie));
assert.equal(response.status, 503, 'the admin cannot delete files while storage is absent');
response = await callWithoutPaperStorage(adminRequest('/api/admin/cards', 'POST', {
  sectionId: 'class-10-sample', title: 'Blocked PDF attachment', subject: 'Science', fileKey: 'published.pdf'
}, cookie));
assert.equal(response.status, 503, 'a PDF cannot be attached while storage is absent');
response = await callWithoutPaperStorage(jsonRequest(`/api/checkout/${paidCard.slug}`, {}));
assert.equal(response.status, 503, 'checkout is disabled before any payment order can be created without storage');
response = await callWithoutPaperStorage(new Request(`${origin}/api/download/not-a-real-token`));
assert.equal(response.status, 503, 'downloads explain missing storage instead of throwing');

response = await call(new Request(`${origin}/api/cards?class=10&type=mcq`));
assert.equal((await response.json()).cards.some((card) => card.id === legacyCard.id), true, 'legacy category endpoint remains compatible');

response = await call(new Request(`${origin}/api/catalog`));
const catalogue = await response.json();
const jee = catalogue.sections.find((section) => section.id === 'jee');
assert.ok(jee);
assert.equal(jee.children[0].cards.some((card) => card.id === genericCard.id), true);
assert.equal(jee.children[0].cards.find((card) => card.id === genericCard.id).available, false);

response = await call(adminRequest('/api/admin/export', 'GET', undefined, cookie));
assert.equal(response.status, 200);
const backup = await response.json();
assert.equal(backup.version, 5);
assert.ok(backup.sections.some((section) => section.id === formulaSection.id));
assert.ok(backup.cards.some((card) => card.id === genericCard.id));

const libraryCountBeforeRejectedImport = sqlite.prepare('SELECT COUNT(*) AS count FROM cards').get().count;
response = await call(adminRequest('/api/admin/import', 'PUT', backup, cookie));
assert.equal(response.status, 400, 'a full-library import requires explicit replacement confirmation');
assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM cards').get().count, libraryCountBeforeRejectedImport, 'an unconfirmed import cannot replace cards');
assert.ok(sqlite.prepare('SELECT 1 FROM catalog_sections WHERE id = ?').get(formulaSection.id), 'an unconfirmed import cannot replace sections');
response = await call(adminRequest('/api/admin/import', 'PUT', { ...backup, confirmReplace: true }, cookie));
const importResult = await response.json();
assert.equal(response.status, 200, `v5 graph backup restores atomically: ${JSON.stringify(importResult)}`);

response = await call(new Request(`${origin}/sitemap.xml`));
let sitemap = await response.text();
assert.doesNotMatch(sitemap, new RegExp(`/paper/${paidCard.slug}`), 'a paused payment system excludes paid papers from the sitemap');
response = await worker.fetch(new Request(`${origin}/sitemap.xml`), checkoutEnv);
sitemap = await response.text();
assert.match(sitemap, new RegExp(`/paper/${paidCard.slug}`), 'published secure card is indexed');
assert.match(sitemap, new RegExp(`/collection/${formulaSection.slug}`), 'published collection pages are indexed');
assert.match(sitemap, /\/privacy\.html/, 'the privacy notice is indexed');
assert.match(sitemap, /\/terms\.html/, 'the terms page is indexed');
response = await call(adminRequest(`/api/admin/cards/${paidCard.id}`, 'PUT', { isPublished: false }, cookie));
assert.equal(response.status, 200);
response = await worker.fetch(new Request(`${origin}/sitemap.xml`), checkoutEnv);
sitemap = await response.text();
assert.doesNotMatch(sitemap, new RegExp(`/paper/${paidCard.slug}`), 'draft card is excluded from sitemap');
response = await call(jsonRequest(`/api/checkout/${paidCard.slug}`, { buyerEmail: 'student@example.test' }));
assert.equal(response.status, 404, 'draft card cannot be checked out');

response = await call(adminRequest('/api/admin/sections/jee', 'DELETE', undefined, cookie));
assert.equal(response.status, 409, 'sections with child sections cannot be deleted');

const failedLoginResponses = await Promise.all(Array.from({ length: 6 }, () => call(new Request(`${origin}/api/admin/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.251' },
  body: JSON.stringify({ password: 'incorrect-password' })
}))));
assert.equal(failedLoginResponses.filter((item) => item.status === 401).length, 5, 'parallel failed sign-ins must admit exactly five attempts');
assert.equal(failedLoginResponses.filter((item) => item.status === 429).length, 1, 'the next parallel failed sign-in is denied atomically');

const headerRules = readFileSync(new URL('../build/_headers', import.meta.url), 'utf8');
assert.match(headerRules, /\/\*\.css\s+Cache-Control: public, max-age=3600/);
assert.match(headerRules, /\/\*\.js\s+Cache-Control: public, max-age=3600/);
assert.match(headerRules, /\/\*\.png\s+Cache-Control: public, max-age=3600/);
const productionConfig = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const previewConfig = readFileSync(new URL('../wrangler.catalog-preview.jsonc', import.meta.url), 'utf8');
assert.match(productionConfig, /"\/collection\/\*"/, 'the production Worker intercepts collection routes before static assets');
assert.match(previewConfig, /"\/collection\/\*"/, 'the catalogue preview Worker intercepts collection routes before static assets');

console.log(JSON.stringify({ catalogSections: backup.sections.length, cards: backup.cards.length, smoke: 'ok' }));
