const catalogGrid = document.querySelector('#catalog-grid');
const catalogHeading = document.querySelector('#catalog-heading');
const catalogNote = document.querySelector('#catalog-note');
const catalogBack = document.querySelector('#catalog-back');
const CATALOG_REQUEST_TIMEOUT_MS = 12_000;
let catalog = { sections: [], cards: [] };
let selectedSectionId = '';
let selectedCatalogTags = new Set();
let catalogRequest;

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function compactTag(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 48);
}

function tagsFor(card) {
  let source = card?.tags;
  if (typeof source === 'string') {
    try {
      const parsed = JSON.parse(source);
      source = Array.isArray(parsed) ? parsed : source;
    } catch { /* Legacy comma-separated tags are still accepted. */ }
  }
  const values = Array.isArray(source) ? source : String(source || '').split(/[,\n]/);
  const seen = new Set();
  return values.map(compactTag).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function normaliseCatalog(data) {
  const sections = [];
  const cards = [];
  const seenSections = new Set();
  const seenCards = new Set();
  const addCard = (card) => {
    if (!card || !card.id || seenCards.has(card.id)) return;
    seenCards.add(card.id);
    cards.push(card);
  };
  const addSection = (section, parentId = '') => {
    if (!section || !section.id || seenSections.has(section.id)) return;
    seenSections.add(section.id);
    const { children, cards: nestedCards, ...details } = section;
    const item = { ...details, parentId: details.parentId || parentId || '' };
    sections.push(item);
    (Array.isArray(nestedCards) ? nestedCards : []).forEach((card) => addCard({ ...card, sectionId: card.sectionId || item.id }));
    (Array.isArray(children) ? children : []).forEach((child) => addSection(child, item.id));
  };
  (Array.isArray(data?.sections) ? data.sections : []).forEach((section) => addSection(section));
  (Array.isArray(data?.cards) ? data.cards : []).forEach(addCard);
  return { sections, cards };
}

function sectionById(id) { return catalog.sections.find((section) => section.id === id); }
function cardsFor(sectionId) { return catalog.cards.filter((card) => card.sectionId === sectionId); }
function childrenFor(sectionId) { return catalog.sections.filter((section) => section.parentId === sectionId); }
function sectionIcon(section) { return section.icon || '📚'; }
function sectionHref(section) { return section?.slug ? `/collection/${encodeURIComponent(section.slug)}` : '/library.html'; }

function resourceAction(card) {
  if (!card.available) return `<span class="coming-soon">Secure checkout opens soon</span><a class="button" href="/paper/${encodeURIComponent(card.slug)}">View details</a>`;
  return `<a class="button" href="/paper/${encodeURIComponent(card.slug)}">View details</a>`;
}

function tagMarkup(card) {
  const tags = tagsFor(card);
  if (!tags.length) return '';
  return `<div class="catalog-card-tags" aria-label="Topics: ${escapeHTML(tags.join(', '))}">${tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join('')}</div>`;
}

function availableTags(cards) {
  const tags = new Map();
  cards.forEach((card) => tagsFor(card).forEach((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }));
  return [...tags.values()].sort((first, second) => first.localeCompare(second));
}

function matchesTags(card) {
  if (!selectedCatalogTags.size) return true;
  const cardTags = new Set(tagsFor(card).map((tag) => tag.toLocaleLowerCase()));
  return [...selectedCatalogTags].every((tag) => cardTags.has(tag));
}

function tagFilterMarkup(tags) {
  if (!tags.length) return '';
  return `<div class="catalog-tag-filter" aria-label="Filter resources by topic"><span>Filter by topic</span><div>${tags.map((tag) => {
    const key = tag.toLocaleLowerCase();
    return `<button type="button" data-catalog-tag="${escapeHTML(tag)}" aria-pressed="${selectedCatalogTags.has(key)}">${escapeHTML(tag)}</button>`;
  }).join('')}<button type="button" class="catalog-tag-clear" data-clear-catalog-tags ${selectedCatalogTags.size ? '' : 'hidden'}>Clear filters</button></div></div>`;
}

function bindTagFilters(section) {
  catalogGrid.querySelectorAll('[data-catalog-tag]').forEach((button) => button.addEventListener('click', () => {
    const tag = compactTag(button.dataset.catalogTag).toLocaleLowerCase();
    if (!tag) return;
    if (selectedCatalogTags.has(tag)) selectedCatalogTags.delete(tag); else selectedCatalogTags.add(tag);
    renderResources(section);
  }));
  catalogGrid.querySelector('[data-clear-catalog-tags]')?.addEventListener('click', () => {
    selectedCatalogTags.clear();
    renderResources(section);
  });
}

function setHash(section) {
  const hash = section?.slug ? `#${encodeURIComponent(section.slug)}` : '';
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${hash}`);
}

function renderCollections() {
  selectedSectionId = '';
  selectedCatalogTags.clear();
  setHash(null);
  catalogBack.hidden = true;
  catalogHeading.textContent = 'Study collections';
  catalogNote.textContent = 'Choose a class, exam or learning path.';
  const roots = catalog.sections.filter((section) => !section.parentId);
  if (!roots.length) {
    catalogGrid.innerHTML = "<div class=\"catalog-empty\"><strong>The library is being prepared.</strong>New class and exam collections will appear here as TK's SOLUTION publishes them.</div>";
    return;
  }
  catalogGrid.innerHTML = roots.map((section) => `<a class="catalog-tile" href="${escapeHTML(sectionHref(section))}"><span class="catalog-tile-icon" aria-hidden="true">${escapeHTML(sectionIcon(section))}</span><h3>${escapeHTML(section.title)}</h3><p>${escapeHTML(section.description || 'Browse the resources in this collection.')}</p><small>Open collection →</small></a>`).join('');
}

function renderResources(section) {
  const allResources = cardsFor(section.id);
  const filterTags = availableTags(allResources);
  selectedCatalogTags = new Set([...selectedCatalogTags].filter((tag) => filterTags.some((item) => item.toLocaleLowerCase() === tag)));
  const resources = allResources.filter(matchesTags);
  catalogHeading.textContent = section.title;
  catalogNote.textContent = section.description || 'Choose a resource to see its details.';
  if (!allResources.length) {
    catalogGrid.innerHTML = `<div class="catalog-empty"><strong>${escapeHTML(section.title)} is being prepared.</strong>TK's SOLUTION will add resources here once they are verified and published.</div>`;
    return;
  }
  if (!resources.length) {
    catalogGrid.innerHTML = `${tagFilterMarkup(filterTags)}<div class="catalog-empty"><strong>No resources match those topics.</strong>Clear a filter to see all published materials in this collection.</div>`;
    bindTagFilters(section);
    return;
  }
  catalogGrid.innerHTML = tagFilterMarkup(filterTags) + resources.map((card) => `<article class="catalog-resource"><span class="chapter">${escapeHTML(card.resourceLabel || card.type || 'Study resource')}</span><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(card.description || "Focused study material from TK's SOLUTION.")}</p>${tagMarkup(card)}<div class="buy"><span class="price">₹${escapeHTML(card.price || '39')}<small>${card.available ? (card.isBundle ? 'full bundle' : 'secure PDF') : 'secure checkout opens soon'}</small></span>${resourceAction(card)}</div></article>`).join('');
  bindTagFilters(section);
}

function renderSection(id) {
  const section = sectionById(id);
  if (!section) return renderCollections();
  const sectionChanged = selectedSectionId !== section.id;
  selectedSectionId = section.id;
  if (sectionChanged) selectedCatalogTags.clear();
  setHash(section);
  catalogBack.hidden = false;
  const children = childrenFor(section.id);
  if (!children.length) return renderResources(section);
  catalogHeading.textContent = section.title;
  catalogNote.textContent = section.description || 'Choose a tile to browse the published resources.';
  const directResources = cardsFor(section.id);
  const allResources = directResources.length ? `<a class="catalog-tile" href="${escapeHTML(sectionHref(section))}"><span class="catalog-tile-icon" aria-hidden="true">${escapeHTML(sectionIcon(section))}</span><h3>All ${escapeHTML(section.title)} resources</h3><p>Browse every published resource directly in this collection.</p><small>Browse resources →</small></a>` : '';
  catalogGrid.innerHTML = allResources + children.map((child) => `<a class="catalog-tile" href="${escapeHTML(sectionHref(child))}"><span class="catalog-tile-icon" aria-hidden="true">${escapeHTML(sectionIcon(child))}</span><h3>${escapeHTML(child.title)}</h3><p>${escapeHTML(child.description || 'Browse the resources in this tile.')}</p><small>Open tile →</small></a>`).join('');
}

function renderFromHash() {
  let slug = '';
  try { slug = decodeURIComponent(location.hash.slice(1)); }
  catch { /* A malformed URL fragment should simply open the library home. */ }
  const section = catalog.sections.find((item) => item.slug === slug);
  if (section) renderSection(section.id); else renderCollections();
}

async function loadCatalog() {
  catalogRequest?.abort();
  const controller = new AbortController();
  catalogRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), CATALOG_REQUEST_TIMEOUT_MS);
  catalogGrid.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/catalog', { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (catalogRequest !== controller) return;
    catalog = normaliseCatalog(data);
    catalogGrid.setAttribute('aria-busy', 'false');
    renderFromHash();
  } catch {
    if (catalogRequest !== controller) return;
    catalogGrid.setAttribute('aria-busy', 'false');
    catalogHeading.textContent = 'Study collections';
    catalogNote.textContent = 'The library is reconnecting.';
    catalogGrid.innerHTML = '<div class="catalog-empty"><strong>The study library is temporarily unavailable.</strong>Please try again in a moment, or return to the home page to browse the existing resource pages.<p><button class="catalog-back catalog-retry" type="button">Try again</button></p></div>';
    catalogGrid.querySelector('.catalog-retry')?.addEventListener('click', () => { void loadCatalog(); });
  } finally {
    window.clearTimeout(timeout);
    if (catalogRequest === controller) catalogRequest = null;
  }
}

catalogBack.addEventListener('click', () => {
  const current = sectionById(selectedSectionId);
  if (current?.parentId) renderSection(current.parentId); else renderCollections();
});
window.addEventListener('hashchange', renderFromHash);
void loadCatalog();
