import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serviceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDirectory = await mkdtemp(join(tmpdir(), 'nios-email-verification-'));
const port = 45000 + Math.floor(Math.random() * 1000);
const authPage = await readFile(resolve(serviceDirectory, '..', 'auth-v2.html'), 'utf8');
assert.match(authPage, /id="verifyForm"/);
assert.match(authPage, /autocomplete="one-time-code"/);
assert.match(authPage, /id="verifyPasswordConfirmation"/);
assert.match(authPage, /\/api\/auth\/email-verification\/verify/);
assert.match(authPage, /\/api\/auth\/email-verification\/resend/);
const signupStart = authPage.indexOf('async function signup');
const signupEnd = authPage.indexOf('async function verifyEmailAddress');
assert.ok(signupStart >= 0 && signupEnd > signupStart);
assert.equal(authPage.slice(signupStart, signupEnd).includes('await go('), false, 'signup UI must not create a usable session before code verification');
const environment = {
  ...process.env,
  NODE_ENV: 'development', PORT: String(port), PORTAL_STATE_DRIVER: 'local',
  PORTAL_STATE_DIR: stateDirectory, STORAGE_DRIVER: 'local', PAYMENT_PROVIDER: 'mock',
  NOTIFICATION_PROVIDER: 'mock', NIOS_SYNC_MODE: 'manual', ALLOW_DEMO_ACCOUNTS: 'true',
  APP_ENCRYPTION_KEY: 'a'.repeat(64),
  // Explicit mock test mode comes before any local .env delivery credentials.
  EMAIL_VERIFICATION_TEST_MODE: 'true'
};
const child = spawn(process.execPath, ['server.mjs'], { cwd: serviceDirectory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });

async function waitForService() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Email-verification test service did not start. ${output}`);
}
async function api(path, { method = 'POST', body, cookie } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { response, data: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}
const attackerRegistrationPassword = 'attacker-known-registration-password';
const finalVerifiedPassword = 'mailbox-holder-final-password-2026';
const registrationInput = email => ({ name: 'Verification Student', email, phone: '+919876543210', password: attackerRegistrationPassword });
const verificationInput = (email, code, overrides = {}) => ({ email, code, password: finalVerifiedPassword, passwordConfirmation: finalVerifiedPassword, ...overrides });

try {
  await waitForService();

  const email = 'otp-student@example.test';
  const registered = await api('/api/auth/register', { body: registrationInput(email) });
  assert.equal(registered.response.status, 202);
  assert.equal(registered.data.accepted, true);
  assert.equal(registered.data.verificationRequired, true);
  assert.match(registered.data.testCode, /^\d{6}$/);
  assert.equal(registered.cookie, '', 'registration must not issue an authenticated session');
  assert.equal('user' in registered.data, false, 'registration response must not make a pending account usable');

  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  const pending = state.users.find(user => user.email === email);
  assert.ok(pending && !pending.emailVerifiedAt, 'the pending student must remain unverified');
  assert.match(pending.emailVerification.codeHash, /^[a-f0-9]{64}$/i);
  assert.notEqual(pending.emailVerification.codeHash, registered.data.testCode, 'state must store only an HMAC, never the raw code');
  assert.equal(JSON.stringify(pending).includes(registered.data.testCode), false, 'the raw code must never be persisted');
  const legacyPayload = Buffer.from(JSON.stringify({ sub: pending.id, studentId: pending.studentId, role: 'student', exp: Date.now() + 60_000 })).toString('base64url');
  const legacySignature = createHmac('sha256', Buffer.from('a'.repeat(64), 'hex')).update(legacyPayload).digest('base64url');
  const legacySession = await api('/api/auth/me', { method: 'GET', cookie: `nios_session=${legacyPayload}.${legacySignature}` });
  assert.equal(legacySession.response.status, 401, 'student sessions issued before email verification cannot remain usable');

  const preVerificationLogin = await api('/api/auth/login', { body: { email, password: attackerRegistrationPassword } });
  assert.equal(preVerificationLogin.response.status, 401);
  assert.equal(preVerificationLogin.cookie, '');

  const invalidFinalPassword = await api('/api/auth/email-verification/verify', { body: verificationInput(email, registered.data.testCode, { password: 'too-short', passwordConfirmation: 'too-short' }) });
  assert.equal(invalidFinalPassword.response.status, 422, 'a mailbox holder must choose a final 12+ character password');

  const wrongCode = registered.data.testCode === '000000' ? '999999' : '000000';
  const rejected = await api('/api/auth/email-verification/verify', { body: verificationInput(email, wrongCode) });
  assert.equal(rejected.response.status, 400);
  assert.match(rejected.data.error, /invalid.*expired/i);

  const expiredEmail = 'expired-otp@example.test';
  const expiredRegistration = await api('/api/auth/register', { body: registrationInput(expiredEmail) });
  assert.equal(expiredRegistration.response.status, 202);
  const expiredState = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  expiredState.users.find(user => user.email === expiredEmail).emailVerification.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await writeFile(join(stateDirectory, 'state.json'), JSON.stringify(expiredState), 'utf8');
  const expired = await api('/api/auth/email-verification/verify', { body: verificationInput(expiredEmail, expiredRegistration.data.testCode) });
  assert.equal(expired.response.status, 400, 'an expired code must not authenticate a student');

  const verified = await api('/api/auth/email-verification/verify', { body: verificationInput(email, registered.data.testCode) });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.data.user.emailVerified, true);
  assert.ok(verified.cookie.startsWith('nios_session='));
  const attackerLogin = await api('/api/auth/login', { body: { email, password: attackerRegistrationPassword } });
  assert.equal(attackerLogin.response.status, 401, 'the password chosen during an unverified registration must not survive email verification');
  const finalPasswordLogin = await api('/api/auth/login', { body: { email, password: finalVerifiedPassword } });
  assert.equal(finalPasswordLogin.response.status, 200, 'only the mailbox holder’s final password can sign in');
  const reused = await api('/api/auth/email-verification/verify', { body: verificationInput(email, registered.data.testCode) });
  assert.equal(reused.response.status, 400, 'a code must be single-use');
  const me = await api('/api/auth/me', { method: 'GET', cookie: finalPasswordLogin.cookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.data.user.emailVerified, true);

  const existing = await api('/api/auth/register', { body: { ...registrationInput('aarav@example.com'), password: 'wrong-password-for-enumeration' } });
  assert.equal(existing.response.status, 202, 'existing accounts receive the same registration acknowledgement');
  assert.equal(existing.data.message, registered.data.message);
  assert.equal(existing.cookie, '');
  const verifiedResend = await api('/api/auth/email-verification/resend', { body: { email: 'aarav@example.com' } });
  const unknownResend = await api('/api/auth/email-verification/resend', { body: { email: 'unknown@example.test' } });
  assert.equal(verifiedResend.response.status, 202);
  assert.equal(unknownResend.response.status, 202);
  assert.equal(verifiedResend.data.message, unknownResend.data.message, 'resend must not enumerate accounts');
  assert.equal('testCode' in unknownResend.data, false);

  const resendEmail = 'resend-student@example.test';
  const resendRegistration = await api('/api/auth/register', { body: registrationInput(resendEmail) });
  assert.equal(resendRegistration.response.status, 202);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const resent = await api('/api/auth/email-verification/resend', { body: { email: resendEmail } });
    assert.equal(resent.response.status, 202);
    assert.match(resent.data.testCode, /^\d{6}$/);
  }
  const resendLimited = await api('/api/auth/email-verification/resend', { body: { email: resendEmail } });
  assert.equal(resendLimited.response.status, 429, 'verification email sends must be rate limited');
  assert.ok(Number(resendLimited.response.headers.get('retry-after')) > 0);

  const attemptsEmail = 'attempts-student@example.test';
  const attemptsRegistration = await api('/api/auth/register', { body: registrationInput(attemptsEmail) });
  assert.equal(attemptsRegistration.response.status, 202);
  const alwaysWrong = attemptsRegistration.data.testCode === '111111' ? '222222' : '111111';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await api('/api/auth/email-verification/verify', { body: verificationInput(attemptsEmail, alwaysWrong) });
    assert.equal(response.response.status, 400);
  }
  const verificationLimited = await api('/api/auth/email-verification/verify', { body: verificationInput(attemptsEmail, alwaysWrong) });
  assert.equal(verificationLimited.response.status, 429, 'verification guesses must be rate limited');
  assert.ok(Number(verificationLimited.response.headers.get('retry-after')) > 0);

  console.log('email-verification.test.mjs: OTP hashing, final-password handoff, expiry, one-time use, generic responses, and throttles passed');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolvePromise => child.once('exit', resolvePromise));
  await rm(stateDirectory, { recursive: true, force: true });
}
