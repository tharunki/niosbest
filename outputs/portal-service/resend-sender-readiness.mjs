function trim(value) {
  return String(value || '').trim();
}

function senderDomainForEmail(value) {
  const raw = trim(value);
  const address = (raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/) || [])[1] || raw;
  const match = address.match(/^[^@\s]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Normalises every sender-related environment value in one place. The return
 * value is server-only: callers must never serialise apiKey values to a client.
 *
 * EMAIL_VERIFICATION_FROM intentionally falls back to ADMISSION_EMAIL_FROM so
 * a small deployment can use one verified identity. An explicitly malformed
 * OTP sender never falls back silently; that would hide a production mistake.
 */
function resolveResendSenderConfiguration({ apiKey, readinessApiKey, admissionFrom, emailVerificationFrom } = {}) {
  const sendingApiKey = trim(apiKey);
  const explicitReadinessApiKey = trim(readinessApiKey);
  const admission = trim(admissionFrom);
  const explicitVerification = trim(emailVerificationFrom);
  const verification = explicitVerification || admission;
  const admissionDomain = senderDomainForEmail(admission);
  const verificationDomain = senderDomainForEmail(verification);
  const verificationSource = explicitVerification ? 'email-verification-from' : 'admission-email-from';
  const senderDomains = [...new Set([admissionDomain, verificationDomain].filter(Boolean))];
  const invalid = [];
  if (!admissionDomain) invalid.push('valid ADMISSION_EMAIL_FROM');
  if (explicitVerification && !verificationDomain) invalid.push('valid EMAIL_VERIFICATION_FROM');

  return {
    // Do not expose this object outside server code: it intentionally retains
    // the keys for the caller that performs a secure server-side request.
    sendingApiKey,
    readinessApiKey: explicitReadinessApiKey || sendingApiKey,
    readinessKeySource: explicitReadinessApiKey ? 'dedicated-readiness-key' : (sendingApiKey ? 'sending-key-fallback' : 'missing'),
    admissionFrom: admission || null,
    verificationFrom: verification || null,
    admissionDomain,
    verificationDomain,
    verificationSource,
    senderDomains,
    sendingConfigured: Boolean(sendingApiKey),
    admissionConfigured: Boolean(admissionDomain),
    verificationConfigured: Boolean(verificationDomain),
    readinessConfigured: Boolean(explicitReadinessApiKey || sendingApiKey),
    invalid
  };
}

function rejectionCode(status) {
  return Number.isInteger(status) && status >= 400 && status < 500
    ? 'authorization-or-request-rejected'
    : 'provider-unavailable';
}

/**
 * Performs the one safe Resend readiness request used by the account-creation
 * gate and operations diagnostics. It only lists domains; it never sends a
 * message or exposes credentials. `from` is maintained for older callers;
 * `froms` verifies every distinct sender domain in one request.
 */
async function inspectResendSenderReadiness({ apiKey, from, froms, fetchImpl = fetch, endpoint = 'https://api.resend.com/domains', timeoutMs = 12_000 } = {}) {
  const configuredFroms = Array.isArray(froms) ? froms : [from];
  const senderDomains = [...new Set(configuredFroms.map(senderDomainForEmail).filter(Boolean))];
  if (!trim(apiKey) || senderDomains.length === 0) {
    return { ready: false, configured: false, reachable: false, httpStatus: null, code: 'not-configured', senderDomain: senderDomains[0] || null, senderDomains, domains: [] };
  }

  let url;
  try {
    url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid endpoint');
  } catch {
    return { ready: false, configured: true, reachable: false, httpStatus: null, code: 'invalid-endpoint', senderDomain: senderDomains[0], senderDomains, domains: [] };
  }

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (!response?.ok) return { ready: false, configured: true, reachable: false, httpStatus, code: rejectionCode(httpStatus), senderDomain: senderDomains[0], senderDomains, domains: [] };
    const payload = await response.json().catch(() => ({}));
    const returnedDomains = Array.isArray(payload?.data) ? payload.data : [];
    const domains = senderDomains.map(name => {
      const domain = returnedDomains.find(item => String(item?.name || '').toLowerCase() === name);
      return { name, verified: String(domain?.status || '').toLowerCase() === 'verified' };
    });
    const ready = domains.every(domain => domain.verified);
    return {
      ready,
      configured: true,
      reachable: true,
      httpStatus,
      code: ready ? null : 'sender-domain-unverified',
      senderDomain: senderDomains[0],
      senderDomains,
      domains
    };
  } catch {
    return { ready: false, configured: true, reachable: false, httpStatus: null, code: 'provider-unavailable', senderDomain: senderDomains[0], senderDomains, domains: [] };
  }
}

export { inspectResendSenderReadiness, resolveResendSenderConfiguration, senderDomainForEmail };
