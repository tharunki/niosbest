const science10Lessons = [
  'Chemical Reactions and Equations', 'Acids, Bases and Salts', 'Metals and Non-metals', 'Carbon and its Compounds', 'Life Processes', 'Control and Coordination', 'How Do Organisms Reproduce?', 'Heredity', 'Light: Reflection and Refraction', 'The Human Eye and the Colourful World', 'Electricity', 'Magnetic Effects of Electric Current', 'Our Environment', 'Sustainable Management of Natural Resources'
];

const catalog = {
  10: { Science: science10Lessons, Mathematics: [], 'Social Science': [], English: [], Tamil: [] },
  11: { Physics: [], Chemistry: [], Biology: [], Mathematics: [], English: [], 'Computer Science': [] },
  12: { Physics: [], Chemistry: [], Biology: [], Mathematics: [], English: [], 'Computer Science': [] }
};

const type = document.body.dataset.type;
const labels = { sample: 'Sample Paper', pyq: 'Previous Year Questions', mcq: 'MCQ Practice Set', important: 'Important Questions' };
const slugs = { sample: 'sample-papers.html', pyq: 'pyqs.html', mcq: 'mcqs.html', important: 'important-questions.html' };
const seoTitle = `${labels[type]} for Classes 10, 11 & 12 | TK's SOLUTION`;
const seoDescription = `Buy chapter-wise ${labels[type].toLowerCase()} PDFs for Classes 10, 11 and 12. Lesson PDFs are ₹39 and complete bundles are ₹399.`;
document.title = seoTitle;

function setMeta(attribute, name, content) {
  let element = document.head.querySelector(`meta[${attribute}="${name}"]`);
  if (!element) { element = document.createElement('meta'); element.setAttribute(attribute, name); document.head.append(element); }
  element.content = content;
}
setMeta('name', 'description', seoDescription);
setMeta('name', 'robots', 'index, follow');
setMeta('property', 'og:type', 'website');
setMeta('property', 'og:site_name', "TK's SOLUTION");
setMeta('property', 'og:title', seoTitle);
setMeta('property', 'og:description', seoDescription);
setMeta('property', 'og:url', `https://tksolutions.in/${slugs[type]}`);
setMeta('property', 'og:image', 'https://tksolutions.in/tk-solution-social-card.png');
setMeta('property', 'og:image:alt', "TK's SOLUTION study materials");
setMeta('name', 'twitter:card', 'summary_large_image');
setMeta('name', 'twitter:image', 'https://tksolutions.in/tk-solution-social-card.png');
setMeta('name', 'twitter:title', seoTitle);
setMeta('name', 'twitter:description', seoDescription);
const canonical = document.createElement('link'); canonical.rel = 'canonical'; canonical.href = `https://tksolutions.in/${slugs[type]}`; document.head.append(canonical);
document.querySelectorAll('.brand').forEach((brand) => { brand.innerHTML = '<img src="tk-solution-logo.png" alt="TK\'s SOLUTION logo" width="46" height="46" decoding="async" style="width:46px;height:46px;object-fit:contain">TK\'s <b>SOLUTION</b>'; });

const grid = document.querySelector('#library-grid');
const courseNote = document.querySelector('#course-note');
const bundle = document.querySelector('#bundle-button');
let selectedClass = '10';
let selectedSubject = null;
let sharedCards = [];
function getCustomCards() {
  return sharedCards;
}

async function loadSharedCards() {
  if (!selectedSubject) { sharedCards = []; return; }
  const requestedClass = selectedClass;
  const requestedSubject = selectedSubject;
  try {
    const query = new URLSearchParams({ type, class:requestedClass, subject:requestedSubject });
    const response = await fetch(`/api/cards?${query}`, { headers:{ Accept:'application/json' } });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (selectedClass === requestedClass && selectedSubject === requestedSubject) { sharedCards = Array.isArray(data.cards) ? data.cards : []; renderLessons(false); }
  } catch { if (selectedClass === requestedClass && selectedSubject === requestedSubject) { sharedCards = []; renderLessons(false); } }
}

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
}

function productLink(slug) { return slug ? `/paper/${encodeURIComponent(slug)}` : '#library-grid'; }

const style = document.createElement('style');
style.textContent = '.subject-card{cursor:pointer;text-align:left;border:1px solid #d9e0dc;background:#fff;border-radius:11px;padding:22px;min-height:158px;color:#19272b;font:inherit}.subject-card:hover{border-color:#263eb7;box-shadow:0 10px 22px #1b344014}.subject-card strong{display:block;font:700 23px Georgia,serif;margin:16px 0 8px}.subject-card small{color:#657477;font-size:13px}.lesson-toolbar{grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:4px}.back-subjects{border:0;background:transparent;color:#263eb7;font:700 13px "DM Sans",sans-serif;padding:0;cursor:pointer}.empty-library{grid-column:1/-1;background:#fff8df;border:1px solid #eed384;border-radius:10px;padding:24px;line-height:1.55;color:#596668}.empty-library strong{display:block;color:#19272b;margin-bottom:5px}';
document.head.append(style);

function renderSubjects() {
  selectedSubject = null;
  sharedCards = [];
  const subjects = Object.keys(catalog[selectedClass]);
  courseNote.textContent = `Class ${selectedClass}: choose a subject to see its complete lesson list.`;
  grid.innerHTML = subjects.map((subject) => `<button class="subject-card" type="button" data-subject="${subject}"><span class="chapter">Class ${selectedClass}</span><strong>${subject}</strong><small>View lesson PDFs and pricing →</small></button>`).join('');
  grid.querySelectorAll('[data-subject]').forEach((button) => button.addEventListener('click', () => {
    selectedSubject = button.dataset.subject;
    sharedCards = [];
    renderLessons();
  }));
  bundle.href = '#library-grid';
  bundle.textContent = 'Choose a subject first';
}

function renderLessons(refresh = true) {
  const lessons = catalog[selectedClass][selectedSubject];
  const subjectCards = getCustomCards().filter((card) => card.type === type && card.className === selectedClass && card.subject === selectedSubject);
  const customCards = subjectCards.filter((card) => !card.isBundle);
  const bundleCard = subjectCards.find((card) => card.isBundle);
  courseNote.textContent = `Class ${selectedClass} · ${selectedSubject}. Choose a lesson PDF for ₹39, or get the full bundle for ₹399.`;
  const toolbar = `<div class="lesson-toolbar"><span class="chapter">Class ${selectedClass} · ${selectedSubject}</span><button class="back-subjects" type="button">← All subjects</button></div>`;
  if (!lessons.length && !customCards.length) {
    grid.innerHTML = `${toolbar}<div class="empty-library"><strong>${selectedSubject} lessons will be added next.</strong>Send the subject PDFs or official lesson list and TK's SOLUTION will add the exact chapter-wise library here.</div>`;
  } else {
    const standardSlugs = new Set();
    const standardCards = lessons.map((lesson, index) => {
      const slug = `${type}-class-${selectedClass}-${selectedSubject}-${lesson}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      standardSlugs.add(slug);
      const custom = customCards.find((card) => card.slug === slug);
      const title = custom?.title || lesson;
      const description = custom?.description || `${labels[type]} PDF · chapter-wise practice`;
      const price = custom?.price || '39';
      return `<article class="lesson"><span class="chapter">Lesson ${index + 1} · Class ${selectedClass}</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p><div class="buy"><span class="price">₹${escapeHTML(price)}<small>per lesson PDF</small></span><a class="button" href="${productLink(custom?.slug || slug)}">View details</a></div></article>`;
    }).join('');
    const addedCards = customCards.filter((card) => !standardSlugs.has(card.slug)).map((card) => {
      return `<article class="lesson"><span class="chapter">${escapeHTML(labels[type])} · Class ${escapeHTML(selectedClass)}</span><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(card.description || `${labels[type]} practice material`)}</p><div class="buy"><span class="price">₹${escapeHTML(card.price || '39')}<small>per PDF</small></span><a class="button" href="${productLink(card.slug)}">View details</a></div></article>`;
    }).join('');
    grid.innerHTML = toolbar + standardCards + addedCards;
  }
  grid.querySelector('.back-subjects').addEventListener('click', renderSubjects);
  bundle.href = bundleCard ? productLink(bundleCard.slug) : '#library-grid';
  bundle.textContent = bundleCard ? `View full bundle · ₹${bundleCard.price || '399'}` : 'Full bundle coming soon';
  if (refresh) void loadSharedCards();
}

document.querySelectorAll('[data-class]').forEach((button) => button.addEventListener('click', () => {
  selectedClass = button.dataset.class;
  document.querySelectorAll('[data-class]').forEach((item) => item.classList.toggle('active', item === button));
  renderSubjects();
}));

renderSubjects();
