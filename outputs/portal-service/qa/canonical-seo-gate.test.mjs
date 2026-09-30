import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-canonical-seo-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const environment = {
  ...process.env,
  NODE_ENV: 'production',
  PORT: String(port),
  PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory,
  STORAGE_DRIVER: 'local',
  APP_PUBLIC_URL: 'https://academy.example',
  APP_ENCRYPTION_KEY: 'c'.repeat(64),
  ADMIN_API_TOKEN: 'd'.repeat(40),
  BOOTSTRAP_ADMIN_EMAIL: 'niosbest.tvl@gmail.com',
  BOOTSTRAP_ADMIN_PASSWORD: 'a-production-only-test-password',
  ALLOW_DEMO_ACCOUNTS: 'false'
};
const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

function get(path, host) {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolvePromise({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function waitForService() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await get('/api/health', 'academy.example')).status === 200) return; } catch { /* startup */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Canonical SEO test service did not start. ${output}`);
}

try {
  const source = await readFile(resolve(serviceDirectory, 'server.mjs'), 'utf8');
  assert.match(source, /endsWith\('\.onrender\.com'\)/, 'hosting-provider preview origins must never become a canonical public origin');
  await waitForService();
  const previewHome = await get('/', 'niosbest-portal.onrender.com');
  assert.equal(previewHome.status, 200);
  assert.match(String(previewHome.headers['x-robots-tag']), /noindex/i, 'preview host must not be indexable');

  const previewRobots = await get('/robots.txt', 'niosbest-portal.onrender.com');
  assert.equal(previewRobots.status, 200);
  assert.match(previewRobots.body, /Disallow: \//, 'preview robots must block crawling');
  assert.equal((await get('/sitemap.xml', 'niosbest-portal.onrender.com')).status, 404, 'preview host must not publish a sitemap');

  const publicHome = await get('/', 'academy.example');
  assert.equal(publicHome.status, 200);
  assert.equal(publicHome.headers['x-robots-tag'], undefined, 'configured public host may be indexed');
  assert.match(publicHome.body, /https:\/\/academy\.example/, 'canonical metadata must use the configured public origin');
  assert.doesNotMatch(publicHome.body, /https:\/\/niosbest\.in/, 'stale hard-coded canonical origin must be replaced');
  assert.match(publicHome.body, /href="\/student-guides"/, 'homepage must link to the crawlable student-guides hub');
  assert.match(publicHome.body, /rel="icon" href="\/student-app-icon\.svg"/, 'homepage must declare a browser icon');
  assert.match(publicHome.body, /rel="manifest" href="\/manifest\.webmanifest"/, 'homepage must declare the public web manifest');

  const favicon = await get('/favicon.ico', 'academy.example');
  assert.equal(favicon.status, 200);
  assert.match(String(favicon.headers['content-type']), /^image\/svg\+xml/i, 'favicon fallback must resolve to a valid icon asset');
  const manifest = await get('/manifest.webmanifest', 'academy.example');
  assert.equal(manifest.status, 200);
  assert.match(String(manifest.headers['content-type']), /^application\/manifest\+json/i, 'public manifest must have the correct MIME type');
  assert.equal(JSON.parse(manifest.body).start_url, '/', 'public manifest must open the public homepage');
  const guideHub = await get('/student-guides', 'academy.example');
  assert.equal(guideHub.status, 200);
  assert.match(guideHub.body, /https:\/\/academy\.example\/student-guides/, 'guide hub must receive the configured canonical origin');
  assert.match(guideHub.body, /href="\/nios-on-demand-exam"/, 'guide hub must discover the on-demand examination guide');
  assert.match(guideHub.body, /href="\/nios-transfer-of-credit"/, 'guide hub must discover the transfer-of-credit guide');

  // Search engines should see exactly one clean public URL per document.
  // Preserve campaign attribution, but convert legacy .html and resource-hub
  // paths into permanent clean-URL redirects rather than duplicate pages.
  const duplicateHome = await get('/index.html?utm_source=search', 'academy.example');
  assert.equal(duplicateHome.status, 301);
  assert.equal(duplicateHome.headers.location, '/?utm_source=search');
  const duplicateArticle = await get('/nios-admission-2026.html?utm_campaign=admission', 'academy.example');
  assert.equal(duplicateArticle.status, 301);
  assert.equal(duplicateArticle.headers.location, '/nios-admission-2026?utm_campaign=admission');
  const legacyResourceHub = await get('/resource-download-hub', 'academy.example');
  assert.equal(legacyResourceHub.status, 301);
  assert.equal(legacyResourceHub.headers.location, '/updates');
  const legacyFragment = await get('/courses?utm_medium=social', 'academy.example');
  assert.equal(legacyFragment.status, 301);
  assert.equal(legacyFragment.headers.location, '/?utm_medium=social#courses');
  const wwwVariant = await get('/nios-admission-2026?utm_source=www', 'www.academy.example');
  assert.equal(wwwVariant.status, 301);
  assert.equal(wwwVariant.headers.location, 'https://academy.example/nios-admission-2026?utm_source=www');

  assert.match((await get('/student-app.html', 'academy.example')).headers['x-robots-tag'], /noindex/i, 'private student-app route must remain noindex');
  console.log('canonical-seo-gate.test.mjs: 32 passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
