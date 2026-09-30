const science10Lessons = [
  'Chemical Reactions and Equations', 'Acids, Bases and Salts', 'Metals and Non-metals', 'Carbon and its Compounds', 'Life Processes', 'Control and Coordination', 'How Do Organisms Reproduce?', 'Heredity', 'Light: Reflection and Refraction', 'The Human Eye and the Colourful World', 'Electricity', 'Magnetic Effects of Electric Current', 'Our Environment', 'Sustainable Management of Natural Resources'
];

// Only published, verified lesson titles belong here. Additional subjects appear automatically
// after an administrator adds a real card for them, so learners are never sent to an empty subject.
const catalog = {
  10: { Science: science10Lessons },
  11: {},
  12: {}
};

const type = document.body.dataset.type;

// The four resource-category pages share this script. Load the tiny analytics
// module once here rather than duplicating its privacy and opt-out behaviour in
// each static HTML file.
if (!document.querySelector('script[src="analytics.js"]')) {
  const analytics = document.createElement('script');
  analytics.src = 'analytics.js';
  analytics.async = true;
  document.head.append(analytics);
}

const labels = { sample: 'Sample Paper', pyq: 'Previous Year Questions', mcq: 'MCQ Practice Set', important: 'Important Questions' };
const slugs = { sample: 'sample-papers.html', pyq: 'pyqs.html', mcq: 'mcqs.html', important: 'important-questions.html' };
const seoTitle = `${labels[type]} for Classes 10, 11 & 12 | TK's SOLUTION`;
const seoDescription = `Buy chapter-wise ${labels[type].toLowerCase()} PDFs for Classes 10, 11 and 12. Lesson PDFs are ₹39 and complete bundles are ₹399.`;
const seoOrigin = location.hostname.endsWith('.workers.dev') ? location.origin : 'https://tksolutions.in';
document.title = seoTitle;

function setMeta(attribute, name, content) {
  let element = document.head.querySelector(`meta[${attribute}="${name}"]`);
  if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, name); document.head.append(element); }
  element.content = content;
}
setMeta('name', 'description', seoDescription);
setMeta('name', 'robots', location.hostname.endsWith('.workers.dev') ? 'noindex, nofollow' : 'index, follow');
setMeta('property', 'og:type', 'website');
setMeta('property', 'og:site_name', "TK's SOLUTION");
setMeta('property', 'og:title', seoTitle);
setMeta('property', 'og:description', seoDescription);
setMeta('property', 'og:url', `${seoOrigin}/${slugs[type]}`);
setMeta('property', 'og:image', `${seoOrigin}/tk-solution-social-card.png`);
setMeta('property', 'og:image:alt', "TK's SOLUTION study materials");
setMeta('property', 'og:image:width', '1672');
setMeta('property', 'og:image:height', '941');
setMeta('property', 'og:image:type', 'image/png');
setMeta('name', 'twitter:card', 'summary_large_image');
setMeta('name', 'twitter:image', `${seoOrigin}/tk-solution-social-card.png`);
setMeta('name', 'twitter:image:alt', "TK's SOLUTION study materials");
setMeta('name', 'twitter:title', seoTitle);
setMeta('name', 'twitter:description', seoDescription);
let canonical = document.head.querySelector('link[rel="canonical"]');
if (!canonical) { canonical = document.createElement('link'); canonical.rel = 'canonical'; document.head.append(canonical); }
canonical.href = `${seoOrigin}/${slugs[type]}`;
document.querySelectorAll('.brand').forEach((brand) => { brand.innerHTML = '<img src="tk-solution-logo.png" alt="TK\'s SOLUTION logo" width="46" height="46" decoding="async" style="width:46px;height:46px;object-fit:contain">TK\'s <b>SOLUTION</b>'; });

const grid = document.querySelector('#library-grid');
const courseNote = document.querySelector('#course-note');
const bundle = document.querySelector('#bundle-button');
bundle.removeAttribute('target');
bundle.removeAttribute('rel');
let selectedClass = '10';
let selectedSubject = null;
let selectedTags = new Set();
let classCards = [];
let classRequestId = 0;
let activeClassRequest;
const CLASS_REQUEST_TIMEOUT_MS = 12_000;

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
}

function productLink(slug) { return slug ? `/paper/${encodeURIComponent(slug)}` : '#library-grid'; }

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

function cardTagMarkup(card) {
  const tags = tagsFor(card);
  if (!tags.length) return '';
  return `<div class="card-tags" aria-label="Topics: ${escapeHTML(tags.join(', '))}">${tags.map((tag) => `<span>${escapeHTML(tag)}</span>`).join('')}</div>`;
}

function availableTags(cards) {
  const tags = new Map();
  cards.forEach((card) => tagsFor(card).forEach((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }));
  return [...tags.values()].sort((first, second) => first.localeCompare(second));
}

function hasSelectedTags(card) {
  if (!selectedTags.size) return true;
  const cardTags = new Set(tagsFor(card).map((tag) => tag.toLocaleLowerCase()));
  return [...selectedTags].every((tag) => cardTags.has(tag));
}

function tagFilterMarkup(tags) {
  if (!tags.length) return '';
  return `<div class="tag-filter" aria-label="Filter by topic"><span>Filter by topic</span><div class="tag-filter-options">${tags.map((tag) => {
    const key = tag.toLocaleLowerCase();
    return `<button type="button" class="tag-filter-button" data-tag-filter="${escapeHTML(tag)}" aria-pressed="${selectedTags.has(key)}">${escapeHTML(tag)}</button>`;
  }).join('')}<button type="button" class="tag-filter-clear" data-clear-tags ${selectedTags.size ? '' : 'hidden'}>Clear filters</button></div></div>`;
}

function bindTagFilters() {
  grid.querySelectorAll('[data-tag-filter]').forEach((button) => button.addEventListener('click', () => {
    const tag = compactTag(button.dataset.tagFilter).toLocaleLowerCase();
    if (!tag) return;
    if (selectedTags.has(tag)) selectedTags.delete(tag); else selectedTags.add(tag);
    renderLessons();
  }));
  grid.querySelector('[data-clear-tags]')?.addEventListener('click', () => {
    selectedTags.clear();
    renderLessons();
  });
}

function subjectsForSelectedClass() {
  const verifiedSubjects = Object.keys(catalog[selectedClass] || {});
  const publishedSubjects = classCards
    .filter((card) => card.type === type && card.className === selectedClass && card.subject)
    .map((card) => card.subject);
  return [...new Set([...verifiedSubjects, ...publishedSubjects])];
}

async function loadClassCards() {
  const requestId = ++classRequestId;
  const requestedClass = selectedClass;
  activeClassRequest?.abort();
  const controller = new AbortController();
  activeClassRequest = controller;
  const timeout = window.setTimeout(() => controller.abort(), CLASS_REQUEST_TIMEOUT_MS);
  grid.setAttribute('aria-busy', 'true');
  courseNote.textContent = `Loading the latest Class ${requestedClass} releases…`;
  let usingFallback = false;
  try {
    const query = new URLSearchParams({ type, class: requestedClass });
    const response = await fetch(`/api/cards?${query}`, { headers: { Accept: 'application/json' }, signal:controller.signal });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (requestId !== classRequestId || selectedClass !== requestedClass) return;
    classCards = Array.isArray(data.cards) ? data.cards : [];
  } catch (error) {
    if (requestId !== classRequestId || selectedClass !== requestedClass) return;
    classCards = [];
    usingFallback = true;
  } finally {
    window.clearTimeout(timeout);
    if (requestId === classRequestId) {
      activeClassRequest = null;
      grid.setAttribute('aria-busy', 'false');
    }
  }
  if (requestId !== classRequestId || selectedClass !== requestedClass) return;
  if (selectedSubject) renderLessons(); else renderSubjects();
  if (usingFallback) courseNote.textContent = `Class ${requestedClass}: showing verified lesson titles while live releases reconnect.`;
}

function renderSubjects() {
  selectedSubject = null;
  selectedTags.clear();
  const subjects = subjectsForSelectedClass();
  if (!subjects.length) {
    courseNote.textContent = `Class ${selectedClass}: the verified subject catalogue is being prepared.`;
    grid.innerHTML = `<div class="empty-library"><strong>Class ${escapeHTML(selectedClass)} materials are not published yet.</strong>TK's SOLUTION will list a subject here after its verified lesson titles and secure PDFs are ready.</div>`;
    bundle.href = '#library-grid';
    bundle.textContent = 'Full bundle coming soon';
    return;
  }
  courseNote.textContent = `Class ${selectedClass}: choose a subject to see its lesson list and released PDFs.`;
  grid.innerHTML = subjects.map((subject) => {
    const lessonCount = (catalog[selectedClass]?.[subject] || []).length;
    const releasedCount = classCards.filter((card) => card.type === type && card.className === selectedClass && card.subject === subject && card.available).length;
    const detail = lessonCount ? `${lessonCount} verified lesson titles${releasedCount ? ` · ${releasedCount} PDF${releasedCount === 1 ? '' : 's'} released` : ' · PDFs released as published'}` : `${releasedCount} PDF${releasedCount === 1 ? '' : 's'} released`;
    return `<button class="subject-card" type="button" data-subject="${escapeHTML(subject)}"><span class="chapter">Class ${escapeHTML(selectedClass)}</span><strong>${escapeHTML(subject)}</strong><small>${escapeHTML(detail)} →</small></button>`;
  }).join('');
  grid.querySelectorAll('[data-subject]').forEach((button) => button.addEventListener('click', () => {
    selectedSubject = button.dataset.subject;
    selectedTags.clear();
    renderLessons();
  }));
  bundle.href = '#library-grid';
  bundle.textContent = 'Choose a subject first';
}

function purchaseAction(card, fallbackPrice, unitLabel) {
  if (!card?.available) return '<span class="coming-soon">Coming soon</span>';
  return `<span class="price">₹${escapeHTML(card.price || fallbackPrice)}<small>${escapeHTML(unitLabel)}</small></span><a class="button" href="${productLink(card.slug)}">View details</a>`;
}

function renderLessons() {
  const lessons = catalog[selectedClass]?.[selectedSubject] || [];
  const subjectCards = classCards.filter((card) => card.type === type && card.className === selectedClass && card.subject === selectedSubject);
  const allCustomCards = subjectCards.filter((card) => !card.isBundle);
  const bundleCard = subjectCards.find((card) => card.isBundle);
  const releasedCount = subjectCards.filter((card) => card.available).length;
  const filterTags = availableTags(allCustomCards);
  selectedTags = new Set([...selectedTags].filter((tag) => filterTags.some((item) => item.toLocaleLowerCase() === tag)));
  const customCards = allCustomCards.filter(hasSelectedTags);
  courseNote.textContent = releasedCount
    ? `Class ${selectedClass} · ${selectedSubject}. Select a released PDF for secure purchase.`
    : `Class ${selectedClass} · ${selectedSubject}. This catalogue is released only when its secure PDF is ready.`;
  const toolbar = `<div class="lesson-toolbar"><span class="chapter">Class ${escapeHTML(selectedClass)} · ${escapeHTML(selectedSubject)}</span><button class="back-subjects" type="button">← All subjects</button></div>`;
  if (!lessons.length && !allCustomCards.length) {
    grid.innerHTML = `${toolbar}<div class="empty-library"><strong>${escapeHTML(selectedSubject)} is not published yet.</strong>TK's SOLUTION will add the exact lesson list and PDFs after they are verified.</div>`;
  } else {
    const standardSlugs = new Set();
    const standardCards = lessons.map((lesson, index) => {
      const slug = `${type}-class-${selectedClass}-${selectedSubject}-${lesson}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      standardSlugs.add(slug);
      const sourceCard = allCustomCards.find((card) => card.slug === slug);
      if (selectedTags.size && (!sourceCard || !hasSelectedTags(sourceCard))) return '';
      const custom = sourceCard && hasSelectedTags(sourceCard) ? sourceCard : null;
      const title = custom?.title || lesson;
      const description = custom?.description || `${labels[type]} PDF · chapter-wise practice`;
      return `<article class="lesson"><span class="chapter">Lesson ${index + 1} · Class ${escapeHTML(selectedClass)}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${cardTagMarkup(custom)}<div class="buy">${purchaseAction(custom, '39', 'per lesson PDF')}</div></article>`;
    }).join('');
    const addedCards = customCards.filter((card) => !standardSlugs.has(card.slug)).map((card) => {
      return `<article class="lesson"><span class="chapter">${escapeHTML(labels[type])} · Class ${escapeHTML(selectedClass)}</span><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(card.description || `${labels[type]} practice material`)}</p>${cardTagMarkup(card)}<div class="buy">${purchaseAction(card, '39', 'per PDF')}</div></article>`;
    }).join('');
    const resources = standardCards + addedCards;
    const noMatches = !resources ? '<div class="empty-library"><strong>No materials match those topic filters.</strong>Clear a filter to see the complete lesson list.</div>' : '';
    grid.innerHTML = toolbar + tagFilterMarkup(filterTags) + resources + noMatches;
  }
  grid.querySelector('.back-subjects')?.addEventListener('click', renderSubjects);
  bindTagFilters();
  bundle.href = bundleCard?.available ? productLink(bundleCard.slug) : '#library-grid';
  bundle.textContent = bundleCard?.available ? `View full bundle · ₹${bundleCard.price || '399'}` : 'Full bundle coming soon';
}

document.querySelectorAll('[data-class]').forEach((button) => button.addEventListener('click', () => {
  selectedClass = button.dataset.class;
  selectedSubject = null;
  classCards = [];
  document.querySelectorAll('[data-class]').forEach((item) => item.classList.toggle('active', item === button));
  renderSubjects();
  void loadClassCards();
}));

renderSubjects();
void loadClassCards();
