import { test, expect } from '@playwright/test';
import { login, required, publicPages } from './helpers.js';

test('server files are not public assets', async ({ request }) => {
  for (const path of ['/portal-service/.env','/portal-service/server.mjs','/portal-service/package.json'])
    expect([403,404]).toContain((await request.get(path)).status());
});

test('anonymous API access denied', async ({ request }) => {
  for (const path of ['/api/admin/batches','/api/admin/students','/api/admin/health','/api/teacher/batches','/api/teacher/submissions','/api/materials','/api/homework']) {
    expect([401,403]).toContain((await request.get(path)).status());
  }
});
test('student cannot call staff APIs or forge a frontend role', async ({ page }) => {
  await login(page, 'STUDENT');
  await page.evaluate(() => sessionStorage.setItem('niosSession', JSON.stringify({ role:'admin' })));
  for (const path of ['/api/admin/batches','/api/admin/students','/api/teacher/batches','/api/teacher/submissions'])
    expect([401,403]).toContain((await page.request.get(path)).status());
  for (const path of ['/api/admin/batches','/api/teacher/live-classes','/api/teacher/materials'])
    expect([401,403]).toContain((await page.request.post(path, { data:{} })).status());
});
test('teacher can view teaching data but cannot administer batches', async ({ page }) => {
  await login(page, 'TEACHER');
  expect((await page.request.get('/api/teacher/batches')).status()).toBe(200);
  expect([401,403]).toContain((await page.request.get('/api/admin/batches')).status());
});
test('student cannot download another batch material', async ({ page }) => {
  await login(page, 'STUDENT');
  const id = required('E2E_OTHER_BATCH_MATERIAL_ID');
  expect([403,404]).toContain((await page.request.get('/api/materials/' + encodeURIComponent(id) + '/download')).status());
});

test('@production TLS, cookies and client storage', async ({ page, baseURL }) => {
  expect(new URL(baseURL).protocol).toBe('https:');
  const insecure = [];
  page.on('request', request => { if (/^http:|^ws:/.test(request.url())) insecure.push(new URL(request.url()).pathname); });
  await login(page, 'STUDENT');
  await page.goto('/dashboard');
  const cookies = await page.context().cookies();
  const session = cookies.find(c => c.name === 'nios_session');
  expect(session).toBeTruthy();
  expect(session.httpOnly).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.sameSite).toBe('Strict');
  const storage = await page.evaluate(() => ({ local:{ ...localStorage }, session:{ ...sessionStorage } }));
  // Identity metadata is not a bearer credential. Sensitive values must not exist here.
  expect(JSON.stringify(storage)).not.toMatch(/password|dateOfBirth|enrollmentNumber|access_token|refresh_token|sb_secret_|client_secret/i);
  expect(insecure).toEqual([]);
});
test('@production no secrets in public HTML, scripts or API responses', async ({ request }) => {
  const forbidden = /sb_secret_[a-z0-9_-]+|postgres(?:ql)?:\/\/[^\s"<>]+|-----BEGIN (?:RSA )?PRIVATE KEY-----|re_[a-z0-9_]{20,}|"(?:client_secret|access_token|refresh_token)"\s*:/i;
  for (const path of [...publicPages, '/api/batches', '/api/admission-cycle']) {
    const response = await request.get(path);
    const body = await response.text();
    expect(forbidden.test(body), 'Secret signature found in ' + path).toBe(false);
    const scripts = [...body.matchAll(/<script[^>]+src=["']([^"']+)/g)].map(m => m[1]);
    for (const src of scripts) {
      const script = await request.get(new URL(src, response.url()).href);
      expect(forbidden.test(await script.text()), 'Secret signature found in frontend script').toBe(false);
    }
  }
});
test('@production private document rejects anonymous requests', async ({ playwright, page, baseURL }) => {
  await login(page, 'STUDENT');
  const path = '/api/documents/' + encodeURIComponent(required('E2E_OWN_DOCUMENT_ID')) + '/download';
  expect((await page.request.get(path)).status()).toBe(200);
  const anonymous = await playwright.request.newContext({ baseURL });
  try { expect([401,403]).toContain((await anonymous.get(path)).status()); }
  finally { await anonymous.dispose(); }
  // This application proxies private files: no signed storage URL is sent to the browser.
  // Test the actual underlying object as well, not a nonexistent invented key.
  const storageURL = required('E2E_PRIVATE_OBJECT_PUBLIC_URL');
  const response = await playwright.request.newContext();
  try { expect([400,401,403,404]).toContain((await response.get(storageURL)).status()); }
  finally { await response.dispose(); }
});
