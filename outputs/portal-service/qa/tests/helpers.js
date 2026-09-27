import { expect } from '@playwright/test';
export function required(name) {
  const value = process.env[name];
  if (!value) throw new Error('Required test fixture is missing: ' + name);
  return value;
}
export async function login(page, role) {
  await page.goto('/login');
  await page.locator('#loginEmail').fill(required('E2E_' + role + '_EMAIL'));
  await page.locator('#loginPassword').fill(required('E2E_' + role + '_PASSWORD'));
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login');
  await page.locator('#loginForm button[type=submit], #loginForm .submit').click();
  expect((await response).status()).toBe(200);
  await expect(page.locator('#loginForm')).not.toBeVisible();
}
export function monitor(page) {
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('response', response => {
    if (response.status() === 404 || response.status() >= 500) failures.push(response.status() + ' ' + new URL(response.url()).pathname);
  });
  return failures;
}
export const publicPages = ['/', '/updates.html', '/academy-services.html', '/contact.html', '/login'];
