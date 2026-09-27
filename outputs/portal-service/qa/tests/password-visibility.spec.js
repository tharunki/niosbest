import { test, expect } from '@playwright/test';

test('password eyes preserve values, support keyboard and never submit', async ({ page }) => {
  let authRequests = 0;
  page.on('request', request => {
    if (/\/api\/auth\/(login|register)$/.test(request.url())) authRequests++;
  });
  await page.goto('/login');
  for (const mode of ['login', 'signup']) {
    await page.locator('[data-mode="' + mode + '"]').click();
    const form = page.locator('#' + mode + 'Form');
    const input = page.locator('#' + mode + 'Password');
    await input.fill('Synthetic-Test-Password!');
    const button = form.locator('.password-eye');
    await expect(button).toHaveAttribute('type', 'button');
    await expect(input).toHaveAttribute('type', 'password');
    await button.click();
    await expect(input).toHaveAttribute('type', 'text');
    await expect(button).toHaveAttribute('aria-label', 'Hide password');
    await expect(input).toHaveValue('Synthetic-Test-Password!');
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(input).toHaveAttribute('type', 'password');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(input).toHaveValue('Synthetic-Test-Password!');
  }
  expect(authRequests).toBe(0);
});
