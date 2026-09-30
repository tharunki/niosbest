import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectResendSenderReadiness, resolveResendSenderConfiguration, senderDomainForEmail } from '../resend-sender-readiness.mjs';

assert.equal(senderDomainForEmail('NIOS Best Academy <accounts@NiosBest.in>'), 'niosbest.in');
assert.equal(senderDomainForEmail('not an address'), null);
assert.equal(senderDomainForEmail('accounts@localhost'), null, 'a sender must contain a real domain name');

const sharedSender = resolveResendSenderConfiguration({
  apiKey: 'send-key', admissionFrom: 'NIOS Best Academy <accounts@mail.niosbest.in>'
});
assert.equal(sharedSender.verificationFrom, sharedSender.admissionFrom, 'OTP may deliberately reuse the verified admission sender');
assert.equal(sharedSender.verificationSource, 'admission-email-from');
assert.equal(sharedSender.readinessApiKey, 'send-key', 'the send key remains the backwards-compatible readiness fallback');
assert.equal(sharedSender.readinessKeySource, 'sending-key-fallback');

const dedicatedReadiness = resolveResendSenderConfiguration({
  apiKey: 'send-key', readinessApiKey: 'read-key',
  admissionFrom: 'Admissions <admissions@mail.niosbest.in>',
  emailVerificationFrom: 'Accounts <accounts@verify.niosbest.in>'
});
assert.equal(dedicatedReadiness.readinessApiKey, 'read-key');
assert.equal(dedicatedReadiness.readinessKeySource, 'dedicated-readiness-key');
assert.deepEqual(dedicatedReadiness.senderDomains, ['mail.niosbest.in', 'verify.niosbest.in']);

const malformedOtpSender = resolveResendSenderConfiguration({
  apiKey: 'send-key', admissionFrom: 'Admissions <admissions@mail.niosbest.in>', emailVerificationFrom: 'not-an-email'
});
assert.equal(malformedOtpSender.verificationConfigured, false, 'an explicitly invalid OTP sender must not silently use another identity');
assert.deepEqual(malformedOtpSender.invalid, ['valid EMAIL_VERIFICATION_FROM']);

const serverSource = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
assert.equal(serverSource.includes('onboarding@resend.dev'), false, 'production sender paths must never fall back to Resend onboarding mail');

const calls = [];
const verified = await inspectResendSenderReadiness({
  apiKey: 'test-key',
  from: 'NIOS Best Academy <accounts@niosbest.in>',
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: [{ name: 'niosbest.in', status: 'verified' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
});
assert.equal(verified.ready, true);
assert.equal(verified.reachable, true);
assert.equal(verified.code, null);
assert.equal(calls.length, 1);
assert.equal(new URL(calls[0].url).pathname, '/domains');
assert.equal(calls[0].options.method, 'GET', 'the readiness check must never create or send an email');
assert.equal(calls[0].options.body, undefined, 'the readiness check must not contain a message payload');

const twoDomains = await inspectResendSenderReadiness({
  apiKey: 'read-key',
  froms: ['Admissions <admissions@mail.niosbest.in>', 'Accounts <accounts@verify.niosbest.in>'],
  fetchImpl: async () => new Response(JSON.stringify({ data: [
    { name: 'mail.niosbest.in', status: 'verified' },
    { name: 'verify.niosbest.in', status: 'pending' }
  ] }), { status: 200 })
});
assert.equal(twoDomains.ready, false, 'every configured sender domain must be verified');
assert.deepEqual(twoDomains.domains, [
  { name: 'mail.niosbest.in', verified: true },
  { name: 'verify.niosbest.in', verified: false }
]);

const unverified = await inspectResendSenderReadiness({
  apiKey: 'test-key', from: 'accounts@niosbest.in',
  fetchImpl: async () => new Response(JSON.stringify({ data: [{ name: 'niosbest.in', status: 'pending' }] }), { status: 200 })
});
assert.deepEqual({ ready: unverified.ready, reachable: unverified.reachable, code: unverified.code }, { ready: false, reachable: true, code: 'sender-domain-unverified' });

const missingDomain = await inspectResendSenderReadiness({
  apiKey: 'test-key', from: 'accounts@niosbest.in',
  fetchImpl: async () => new Response(JSON.stringify({ data: [{ name: 'other.example', status: 'verified' }] }), { status: 200 })
});
assert.equal(missingDomain.ready, false);
assert.equal(missingDomain.code, 'sender-domain-unverified');

const rejected = await inspectResendSenderReadiness({
  apiKey: 'test-key', from: 'accounts@niosbest.in',
  fetchImpl: async () => new Response('{}', { status: 403 })
});
assert.deepEqual({ ready: rejected.ready, reachable: rejected.reachable, code: rejected.code, httpStatus: rejected.httpStatus }, { ready: false, reachable: false, code: 'authorization-or-request-rejected', httpStatus: 403 });

const unavailable = await inspectResendSenderReadiness({
  apiKey: 'test-key', from: 'accounts@niosbest.in',
  fetchImpl: async () => { throw new Error('network unavailable'); }
});
assert.deepEqual({ ready: unavailable.ready, reachable: unavailable.reachable, code: unavailable.code }, { ready: false, reachable: false, code: 'provider-unavailable' });

const missingConfig = await inspectResendSenderReadiness({ apiKey: '', from: 'accounts@niosbest.in' });
assert.deepEqual({ ready: missingConfig.ready, configured: missingConfig.configured, code: missingConfig.code }, { ready: false, configured: false, code: 'not-configured' });

console.log('resend-sender-readiness.test.mjs: verified, pending, rejected, unreachable, and safe GET-only readiness checks passed');
