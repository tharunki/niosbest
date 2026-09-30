import assert from 'node:assert/strict';
import { inspectResendSenderReadiness, senderDomainForEmail } from '../resend-sender-readiness.mjs';

assert.equal(senderDomainForEmail('NIOS Best Academy <accounts@NiosBest.in>'), 'niosbest.in');
assert.equal(senderDomainForEmail('not an address'), null);

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
