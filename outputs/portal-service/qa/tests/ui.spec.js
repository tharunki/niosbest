import { test, expect } from '@playwright/test';
import { publicPages, monitor, login } from './helpers.js';

for (const path of publicPages) test('public page and same-origin navigation: ' + path, async ({ page, request }, testInfo) => {
  const errors = monitor(page);
  const response = await page.goto(path);
  expect(response.status()).toBe(200);
  await expect(page.locator('body')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  // Inventory is a coverage aid, not a claim that generic clicking verifies intent.
  const controls = await page.locator('a,button,input,select,textarea,[role=button]').evaluateAll(nodes =>
    nodes.map(n => ({ tag: n.tagName, id: n.id, text: n.textContent.trim().slice(0,80), href: n.getAttribute('href'), type: n.getAttribute('type') })));
  await testInfo.attach('interaction-inventory', { body: JSON.stringify(controls, null, 2), contentType: 'application/json' });
  const links = await page.locator('a[href]').evaluateAll(nodes => nodes.map(n => n.href));
  for (const href of new Set(links)) {
    const url = new URL(href);
    if (url.origin !== new URL(page.url()).origin) continue;
    const result = await request.get(url.href);
    expect(result.status(), url.pathname).toBeLessThan(400);
  }
  expect(errors).toEqual([]);
});

test('resource sections, independent class selectors, search, board and download', async ({ page }) => {
  const errors = monitor(page);
  await page.goto('/updates.html');
  await expect(page.getByRole('heading', { name: 'What’s new' })).toHaveCount(0);
  for (const id of ['tma', 'study', 'pyq']) {
    await expect(page.locator('#' + id + 'List')).toContainText('Class 10 Mathematics');
    await page.locator('#' + id + 'Class').selectOption('12');
    await expect(page.locator('#' + id + 'List')).toContainText('Class 12 Mathematics');
    await expect(page.locator('#' + id + 'List')).not.toContainText('Class 10');
  }
  await page.locator('#search').fill('Mathematics');
  for (const id of ['tma', 'study', 'pyq']) await expect(page.locator('#' + id + 'List article')).toHaveCount(1);
  await page.getByRole('button', { name: 'BOSSE', exact: true }).click();
  await expect(page.locator('#found')).toHaveText('0');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.locator('.download button').first().click();
  expect((await download).suggestedFilename()).toMatch(/\.txt$/);
  await page.locator('#tmaList a').first().click();
  await page.getByRole('button', { name: 'Sign in to continue' }).click();
  await expect(page.locator('#loginForm')).toBeVisible();
  expect(errors).toEqual([]);
});

test('login and signup toggles and invalid credentials', async ({ page }) => {
  await page.goto('/login');
  await page.locator('[data-mode=signup]').click();
  await expect(page.locator('#signupForm')).toBeVisible();
  await page.locator('[data-mode=login]').click();
  await page.locator('#loginEmail').fill('invalid@example.invalid');
  await page.locator('#loginPassword').fill('NotARealPassword123!');
  await page.locator('#loginForm .submit').click();
  await expect(page.locator('#loginError')).not.toBeEmpty();
});

test('admin edits every batch card field and reload preserves it', async ({ page }) => {
  test.skip(process.env.E2E_ALLOW_MUTATIONS !== 'yes', 'Enable only against disposable staging data.');
  await login(page, 'ADMIN');
  await page.goto('/admin/batches');
  await page.locator('#name').fill('QA batch ' + Date.now());
  await page.locator('#board').selectOption('BOSSE');
  await page.locator('#features').fill('Live classes, Notes, PYQs');
  const fields = { level:'QA subtitle', mode:'Recorded', duration:'9 months', starts:'Next term', streamId:'qa-science', old:'₹15,000', off:'10% off', fill:'40%' };
  for (const [id, value] of Object.entries(fields)) await page.locator('#' + id).fill(value);
  await page.locator('#popular').check();
  await page.locator('#tone').selectOption('pink');
  await page.locator('#published').uncheck();
  const savedResponse = page.waitForResponse(r => r.url().endsWith('/api/admin/batches') && r.request().method() === 'POST');
  await page.getByRole('button', { name:'Save batch', exact:true }).click();
  const result = await savedResponse;
  expect(result.status()).toBe(201);
  const saved = await result.json();
  try {
    expect(saved).toMatchObject({ ...fields, popular:true, tone:'pink', published:false });
    await page.reload();
    await page.locator('[data-edit="' + saved.id + '"]').click();
    for (const [id, value] of Object.entries(fields)) await expect(page.locator('#' + id)).toHaveValue(value);
  } finally {
    expect((await page.request.delete('/api/admin/batches/' + saved.id)).ok()).toBe(true);
  }
});
