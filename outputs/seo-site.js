document.querySelectorAll('a[href="/contact#form"]').forEach(link => link.addEventListener('click', () => {
  try { localStorage.setItem('niosContactTopic', 'SEO landing-page counselling'); } catch { /* Storage can be unavailable in private mode. */ }
}));
