function senderDomainForEmail(value) {
  const raw = String(value || '').trim();
  const address = (raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/) || [])[1] || raw;
  const match = address.match(/^[^@\s]+@([^@\s]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function rejectionCode(status) {
  return Number.isInteger(status) && status >= 400 && status < 500
    ? 'authorization-or-request-rejected'
    : 'provider-unavailable';
}

/**
 * Performs the one safe Resend readiness request used by the account-creation
 * gate. It only lists domains; it never sends a message or exposes credentials.
 */
async function inspectResendSenderReadiness({ apiKey, from, fetchImpl = fetch, endpoint = 'https://api.resend.com/domains', timeoutMs = 12_000 } = {}) {
  const senderDomain = senderDomainForEmail(from);
  if (!String(apiKey || '').trim() || !senderDomain) {
    return { ready: false, configured: false, reachable: false, httpStatus: null, code: 'not-configured', senderDomain };
  }

  let url;
  try {
    url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid endpoint');
  } catch {
    return { ready: false, configured: true, reachable: false, httpStatus: null, code: 'invalid-endpoint', senderDomain };
  }

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const httpStatus = Number.isInteger(response?.status) ? response.status : null;
    if (!response?.ok) return { ready: false, configured: true, reachable: false, httpStatus, code: rejectionCode(httpStatus), senderDomain };
    const payload = await response.json().catch(() => ({}));
    const domains = Array.isArray(payload?.data) ? payload.data : [];
    const domain = domains.find(item => String(item?.name || '').toLowerCase() === senderDomain);
    const ready = String(domain?.status || '').toLowerCase() === 'verified';
    return {
      ready,
      configured: true,
      reachable: true,
      httpStatus,
      code: ready ? null : 'sender-domain-unverified',
      senderDomain
    };
  } catch {
    return { ready: false, configured: true, reachable: false, httpStatus: null, code: 'provider-unavailable', senderDomain };
  }
}

export { inspectResendSenderReadiness, senderDomainForEmail };
