const menuButton = document.querySelector('.menu-button');
const nav = document.querySelector('.main-nav');
const paperGrid = document.querySelector('#paper-grid');
const search = document.querySelector('#resource-search');
const searchButton = document.querySelector('#search-button');
let searchTimer;
let activeSearchRequest;
let searchRequestId = 0;

function closeMenu() { nav?.classList.remove('open'); menuButton?.setAttribute('aria-expanded', 'false'); }
menuButton?.addEventListener('click', () => { const isOpen = nav.classList.toggle('open'); menuButton.setAttribute('aria-expanded', String(isOpen)); });
nav?.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });

const searchStatus = document.createElement('p');
searchStatus.setAttribute('role', 'status');
searchStatus.setAttribute('aria-live', 'polite');
searchStatus.style.cssText = 'margin:12px 0 0;color:#657477;font-size:13px;';
document.querySelector('.quick-search')?.append(searchStatus);
const fallbackPapers = [
  ['1','Chemical Reactions and Equations'],['2','Acids, Bases and Salts'],['3','Metals and Non-metals'],['4','Carbon and its Compounds'],['5','Life Processes'],['6','Control and Coordination'],['7','How Do Organisms Reproduce?'],['8','Heredity'],['9','Light: Reflection and Refraction'],['10','The Human Eye and the Colourful World'],['11','Electricity'],['12','Magnetic Effects of Electric Current'],['13','Our Environment'],['14','Sustainable Management of Natural Resources']
].map(([chapter,title]) => ({ slug:`sample-class-10-science-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`, className:'10', subject:'Science', type:'sample', title, description:'Sample papers, PYQs, MCQs and important questions', price:'39' }));

function escapeHTML(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }
function productUrl(slug) { return `/paper/${encodeURIComponent(slug)}`; }
function renderPapers(papers, message = '') {
  paperGrid.setAttribute('aria-busy', 'false');
  if (!papers.length) { paperGrid.innerHTML = '<p class="empty-state">No papers match that search yet. Try a class, subject, or chapter name.</p>'; return; }
  paperGrid.innerHTML = papers.map((paper, index) => `<article class="paper-card"><span class="tag ${['blue','amber','green','plum'][index % 4]}">Class ${escapeHTML(paper.className)} · ${escapeHTML(paper.subject)}</span><h3>${escapeHTML(paper.title)}</h3><p>${escapeHTML(paper.description || 'Chapter-wise study material')}</p><footer><span>₹${escapeHTML(paper.price || '39')} PDF</span><a href="${productUrl(paper.slug)}" aria-label="View ${escapeHTML(paper.title)}">→</a></footer></article>`).join('');
  if (message) searchStatus.textContent = message;
}
async function fetchPapers(query = '', initial = false) {
  const requestId = ++searchRequestId;
  activeSearchRequest?.abort();
  const controller = new AbortController();
  activeSearchRequest = controller;
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
