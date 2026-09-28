const menuButton = document.querySelector('.menu-button');
const nav = document.querySelector('.main-nav');
const paperGrid = document.querySelector('#paper-grid');
const search = document.querySelector('#resource-search');
const searchButton = document.querySelector('#search-button');
const homeCollections = document.querySelector('#home-collections');
const homeCollectionGrid = document.querySelector('#home-collection-grid');
let searchTimer;
let activeSearchRequest;
let searchRequestId = 0;
const SEARCH_REQUEST_TIMEOUT_MS = 12_000;

function closeMenu() { nav?.classList.remove('open'); menuButton?.setAttribute('aria-expanded', 'false'); menuButton?.setAttribute('aria-label', 'Open menu'); }
menuButton?.addEventListener('click', () => { const isOpen = nav.classList.toggle('open'); menuButton.setAttribute('aria-expanded', String(isOpen)); menuButton.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu'); });
nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

const searchStatus = document.querySelector('#search-status') || document.createElement('p');
if (!searchStatus.id) {
  searchStatus.id = 'search-status';
  searchStatus.setAttribute('role', 'status');
  searchStatus.setAttribute('aria-live', 'polite');
  searchStatus.setAttribute('aria-atomic', 'true');
  searchStatus.style.cssText = 'min-height:1.3em;margin:12px 0 0;color:#657477;font-size:13px;';
  (document.querySelector('.search-group') || document.querySelector('.quick-search'))?.append(searchStatus);
}
const fallbackPapers = [
  ['1','Chemical Reactions and Equations'],['2','Acids, Bases and Salts'],['3','Metals and Non-metals'],['4','Carbon and its Compounds'],['5','Life Processes'],['6','Control and Coordination'],['7','How Do Organisms Reproduce?'],['8','Heredity'],['9','Light: Reflection and Refraction'],['10','The Human Eye and the Colourful World'],['11','Electricity'],['12','Magnetic Effects of Electric Current'],['13','Our Environment'],['14','Sustainable Management of Natural Resources']
].map(([chapter,title]) => ({ slug:`sample-class-10-science-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`, className:'10', subject:'Science', type:'sample', title, description:'Sample papers, PYQs, MCQs and important questions', price:'39', available:false }));

function escapeHTML(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }
function tagsFor(paper) {
  let source = paper?.tags;
  if (typeof source === 'string') {
    try {
      const parsed = JSON.parse(source);
      source = Array.isArray(parsed) ? parsed : source;
    } catch { /* Legacy comma-separated tags are still accepted. */ }
  }
  const values = Array.isArray(source) ? source : String(source || '').split(/[,\n]/);
  const seen = new Set();
  return values.map((tag) => String(tag || '').replace(/\s+/g, ' ').trim().slice(0, 48)).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}
function paperTagMarkup(paper) {
  const tags = tagsFor(paper);
  if (!tags.length) return '';
  return `<div class="paper-card-tags" aria-label="Topics: ${escapeHTML(tags.join(', '))}">${tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join('')}</div>`;
}
function featuredCardCount(section) {
  return (Array.isArray(section.cards) ? section.cards.length : 0)
    + (Array.isArray(section.children) ? section.children.reduce((total, child) => total + (Array.isArray(child.cards) ? child.cards.length : 0), 0) : 0);
}
function renderFeaturedCollections(collections) {
  if (!homeCollections || !homeCollectionGrid) return;
  const featured = collections.filter(collection => collection?.showOnHome);
  if (!featured.length) return;
  homeCollectionGrid.innerHTML = featured.map(collection => {
    const count = featuredCardCount(collection);
    const note = count ? `${count} published resource${count === 1 ? '' : 's'} to explore` : 'New resources are being prepared';
    return `<a class="home-library-card" href="library.html#${encodeURIComponent(collection.slug || '')}"><span class="home-library-icon" aria-hidden="true">${escapeHTML(collection.icon || '📚')}</span><h3>${escapeHTML(collection.title || 'Study collection')}</h3><p>${escapeHTML(collection.description || 'Choose a tile and find the material you need.')}</p><small>${escapeHTML(note)} →</small></a>`;
  }).join('');
  homeCollections.hidden = false;
}
async function loadFeaturedCollections() {
  if (!homeCollections) return;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch('/api/catalog', { headers:{ Accept:'application/json' }, signal:controller.signal });
    if (!response.ok) return;
    const data = await response.json();
    renderFeaturedCollections(Array.isArray(data.sections) ? data.sections : []);
  } catch { /* The core home page remains useful if the optional featured shelf is unavailable. */ }
  finally { window.clearTimeout(timeout); }
}
function productUrl(slug) { return `/paper/${encodeURIComponent(slug)}`; }
function collectionLabel(paper) {
  const name = String(paper.displayClassName || paper.className || '').trim();
  return /^\d+$/.test(name) ? `Class ${name}` : name || 'Study resource';
}
function paperAction(paper) {
  if (!paper.available) return '<span class="availability">Coming soon</span>';
  return `<span>₹${escapeHTML(paper.price || '39')} PDF</span><a href="${productUrl(paper.slug)}" aria-label="View ${escapeHTML(paper.title)}">→</a>`;
}
function renderPapers(papers, message = '') {
  paperGrid.setAttribute('aria-busy', 'false');
  if (message) searchStatus.textContent = message;
  if (!papers.length) { paperGrid.innerHTML = '<p class="empty-state">No papers match that search yet. Try a class, subject, or chapter name.</p>'; return; }
  paperGrid.innerHTML = papers.map((paper, index) => `<article class="paper-card"><span class="tag ${['blue','amber','green','plum'][index % 4]}">${escapeHTML(collectionLabel(paper))} · ${escapeHTML(paper.subject)}</span><h3>${escapeHTML(paper.title)}</h3><p>${escapeHTML(paper.description || 'Chapter-wise study material')}</p>${paperTagMarkup(paper)}<footer>${paperAction(paper)}</footer></article>`).join('');
}
async function fetchPapers(query = '', initial = false) {
  const requestId = ++searchRequestId;
  activeSearchRequest?.abort();
  const controller = new AbortController();
  activeSearchRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), SEARCH_REQUEST_TIMEOUT_MS);
  paperGrid.setAttribute('aria-busy', 'true');
  const params = new URLSearchParams(query ? { q:query } : { type:'sample', class:'10', subject:'Science' });
  try {
    const response = await fetch(`/api/papers?${params}`, { headers:{ Accept:'application/json' }, signal:controller.signal });
    if (!response.ok) throw new Error(); const data = await response.json(); const papers = Array.isArray(data.papers) ? data.papers : [];
    if (requestId !== searchRequestId) return null;
    renderPapers(papers, initial ? 'Showing Class 10 Science sample papers.' : `${papers.length} result${papers.length === 1 ? '' : 's'} found.`);
    return papers;
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== searchRequestId) return null;
    const filtered = query ? fallbackPapers.filter(paper => `${paper.className} ${paper.subject} ${paper.title}`.toLowerCase().includes(query.toLowerCase())) : fallbackPapers;
    renderPapers(filtered, 'Showing available papers while the search service reconnects.'); return filtered;
  } finally {
    window.clearTimeout(timeout);
    if (requestId === searchRequestId) activeSearchRequest = null;
  }
}
async function runSearch({ scroll = false } = {}) {
  const term = search.value.trim();
  if (!term) { const papers = await fetchPapers('', true); if (papers !== null) searchStatus.textContent = 'Enter a class, subject, or chapter name.'; return; }
  searchStatus.textContent = 'Searching study material…'; const papers = await fetchPapers(term);
  if (papers === null) return;
  if (papers.length && scroll) document.querySelector('#latest')?.scrollIntoView({ behavior:'smooth', block:'start' });
  if (!papers.length) {
    const matchingResource = [...document.querySelectorAll('.resource-card')].find(card => card.dataset.keywords.toLowerCase().includes(term.toLowerCase()));
    if (matchingResource) { searchStatus.textContent = 'A matching resource category was found.'; matchingResource.scrollIntoView({ behavior:'smooth', block:'center' }); matchingResource.focus(); }
  }
}
searchButton?.addEventListener('click', () => { clearTimeout(searchTimer); runSearch({ scroll:true }); });
search?.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(), 300); });
search?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); runSearch({ scroll:true }); } });
fetchPapers('', true);
const scheduleLibraryShelf = window.requestIdleCallback || (callback => setTimeout(callback, 120));
scheduleLibraryShelf(() => { void loadFeaturedCollections(); });

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function reportAnonymousVisit() {
  // This intentionally contains no account, device, name, email, or browsing data.
  // The server is responsible for rate-limiting and aggregating this minimal signal.
  if (location.protocol === 'file:' || navigator.doNotTrack === '1' || navigator.onLine === false) return;
  const day = todayKey();
  const sessionKey = `best-education-visit-session-${day}`;
  const dayKey = `best-education-visit-${day}`;
  try {
    if (sessionStorage.getItem(sessionKey) || localStorage.getItem(dayKey)) return;
    sessionStorage.setItem(sessionKey, '1');
    localStorage.setItem(dayKey, '1');
  } catch {
    if (window.__bestEducationVisitReported) return;
    window.__bestEducationVisitReported = true;
  }
  void fetch('/api/analytics/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    credentials: 'omit',
    cache: 'no-store',
    keepalive: true,
    referrerPolicy: 'no-referrer'
  }).catch(() => { /* Analytics must never affect the learner experience. */ });
}

const scheduleAnalytics = window.requestIdleCallback || (callback => setTimeout(callback, 900));
scheduleAnalytics(reportAnonymousVisit);
