import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
for (const migration of ['0001_initial.sql', '0002_checkout_rate_limit.sql', '0003_cards_fts.sql', '0004_catalog_sections.sql']) {
  sqlite.exec(readFileSync(new URL(`./migrations/${migration}`, import.meta.url), 'utf8'));
}

const storedFiles = new Set(['published.pdf']);
const env = {
  DB: new D1Database(sqlite),
  PAPERS: {
    async head(name) { return storedFiles.has(name) ? { size: 1 } : null; },
    async list() { return { objects: [...storedFiles].map((key) => ({ key })), truncated: false }; },
    async get() { return null; },
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
const call = (request) => worker.fetch(request, env);

const login = await call(jsonRequest('/api/admin/login', { password: env.ADMIN_PASSWORD }));
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];

let response = await call(adminRequest('/api/admin/sections', 'POST', {
  title: 'Formula Cheat Sheets', parentId: 'jee', isPublished: true, sortOrder: 10
}, cookie));
assert.equal(response.status, 201);
const formulaSection = (await response.json()).section;

response = await call(adminRequest('/api/admin/sections/jee', 'PUT', { title: 'JEE', isPublished: false }, cookie));
assert.equal(response.status, 200);
response = await call(new Request(`${origin}/api/catalog`));
assert.equal((await response.json()).sections.some((section) => section.id === 'jee'), false, 'draft root must hide child catalogue content');

response = await call(adminRequest('/api/admin/sections/jee', 'PUT', { title: 'JEE', isPublished: true }, cookie));
assert.equal(response.status, 200);

response = await call(adminRequest('/api/admin/cards', 'POST', {
  sectionId: formulaSection.id,
  title: 'Physics Formula Sheet',
  resourceLabel: 'Formula Cheat Sheet'
}, cookie));
assert.equal(response.status, 201);
const genericCard = (await response.json()).card;
assert.equal(genericCard.isPublished, false, 'new generic cards are drafts');
assert.equal(genericCard.displayClassName, 'JEE');
assert.equal(genericCard.displayType, 'Formula Cheat Sheets');

response = await call(adminRequest(`/api/admin/cards/${genericCard.id}`, 'PUT', { isPublished: true }, cookie));
assert.equal(response.status, 200);

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
assert.equal(backup.version, 4);
assert.ok(backup.sections.some((section) => section.id === formulaSection.id));
assert.ok(backup.cards.some((card) => card.id === genericCard.id));

response = await call(adminRequest('/api/admin/import', 'PUT', backup, cookie));
const importResult = await response.json();
assert.equal(response.status, 200, `v4 graph backup restores atomically: ${JSON.stringify(importResult)}`);

response = await call(new Request(`${origin}/sitemap.xml`));
assert.match(await response.text(), new RegExp(`/paper/${paidCard.slug}`), 'published secure card is indexed');
response = await call(adminRequest(`/api/admin/cards/${paidCard.id}`, 'PUT', { isPublished: false }, cookie));
assert.equal(response.status, 200);
response = await call(new Request(`${origin}/sitemap.xml`));
assert.doesNotMatch(await response.text(), new RegExp(`/paper/${paidCard.slug}`), 'draft card is excluded from sitemap');
response = await call(jsonRequest(`/api/checkout/${paidCard.slug}`, {}));
assert.equal(response.status, 404, 'draft card cannot be checked out');

response = await call(adminRequest('/api/admin/sections/jee', 'DELETE', undefined, cookie));
assert.equal(response.status, 409, 'sections with child sections cannot be deleted');

console.log(JSON.stringify({ catalogSections: backup.sections.length, cards: backup.cards.length, smoke: 'ok' }));
