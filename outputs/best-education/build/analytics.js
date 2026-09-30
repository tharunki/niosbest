(() => {
  'use strict';

  const endpoint = '/api/analytics/visit';
  const timeZone = 'Asia/Kolkata';

  function dayInIndia(date = new Date()) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
      return `${values.year}-${values.month}-${values.day}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function shouldSkip() {
    const dnt = String(navigator.doNotTrack || window.doNotTrack || '').toLowerCase();
    return location.protocol === 'file:'
      || location.hostname.endsWith('.workers.dev')
      || navigator.onLine === false
      || dnt === '1'
      || dnt === 'yes';
  }

  function reportVisit() {
    if (shouldSkip()) return;
    const day = dayInIndia();
    const key = `best-education-visit-${day}`;
    try {
      if (sessionStorage.getItem(key) || localStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
      localStorage.setItem(key, '1');
    } catch {
      if (window.__bestEducationVisitReported) return;
      window.__bestEducationVisitReported = true;
    }

    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'omit',
      cache: 'no-store',
      keepalive: true,
      referrerPolicy: 'no-referrer'
    }).catch(() => { /* Analytics must never affect study access. */ });
  }

  const schedule = window.requestIdleCallback || ((callback) => window.setTimeout(callback, 900));
  schedule(reportVisit);
})();
