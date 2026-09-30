const subjectOptions = {
  10: ['Science', 'Mathematics', 'Social Science', 'English', 'Tamil'],
  11: ['Physics', 'Chemistry', 'Biology', 'Mathematics', 'English', 'Computer Science'],
  12: ['Physics', 'Chemistry', 'Biology', 'Mathematics', 'English', 'Computer Science']
};

const INDIVIDUAL_CARD_PRICE = '39';
const FULL_COURSE_BUNDLE_PRICE = '399';
const KNOWN_VIEWS = ['overview', 'content', 'orders', 'students', 'bulk', 'promotions', 'feedback'];
const MANAGEMENT_PAGE_SIZE = 50;
const MAX_BULK_PDF_FILES = 10;
const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_BULK_UPLOAD_BYTES = 90 * 1024 * 1024;
const MAX_BULK_METADATA_BYTES = 1024 * 1024;
const state = {
  cards: [],
  sections: [],
  orders: [],
  students: [],
  promotions: [],
  feedback: [],
  loadedViews: new Set(),
  activeView: 'overview',
  editingCardId: null,
  editingSectionId: null,
  editingPromotionId: null,
  tags: { card: [], section: [] },
  management: {
    orders: { request: null, signature: '', nextOffset: 0, hasMore: false },
    students: { request: null, signature: '', nextOffset: 0, hasMore: false },
    feedback: { request: null, signature: '', nextOffset: 0, hasMore: false }
  }
};

let toastTimer;
let orderSearchTimer;
let studentSearchTimer;
let feedbackSearchTimer;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const loginView = $('#login-view');
const dashboard = $('#dashboard');
const loginForm = $('#login-form');
const form = $('#card-form');
const list = $('#cards');
const status = $('#status');
const loginStatus = $('#login-status');
const toast = $('#toast');
const uploadInput = $('#upload-pdf');
const uploadButton = $('#upload-button');
const uploadName = $('#upload-name');
const fileList = $('#pdf-files');
const sectionForm = $('#section-form');
const sectionList = $('#section-list');
const sectionParent = $('#section-parent');
const cardSection = $('#card-section');

function escapeHTML(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function value(id) { return $(`#${id}`).value; }
function numberValue(id, fallback = 0) {
  const number = Number(value(id));
  return Number.isSafeInteger(number) ? number : fallback;
}

function toArray(valueToCheck) {
  return Array.isArray(valueToCheck) ? valueToCheck : [];
}

function firstValue(source, keys, fallback = null) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) return source[key];
  }
  return fallback;
}

function collectionFrom(payload, keys) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
  }
  return [];
}

function normalizeTags(valueToNormalize) {
  const raw = Array.isArray(valueToNormalize)
    ? valueToNormalize
    : String(valueToNormalize || '').split(',');
  const seen = new Set();
  return raw
    .map(tag => String(tag || '').trim().replace(/\s+/g, ' '))
    .filter(tag => tag && tag.length <= 50)
    .filter(tag => {
      const key = tag.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function entityValue(entity, key) {
  const seo = entity && typeof entity.seo === 'object' && entity.seo ? entity.seo : {};
  const metadata = entity && typeof entity.metadata === 'object' && entity.metadata ? entity.metadata : {};
  return entity?.[key] ?? seo[key] ?? metadata[key] ?? '';
}

function showToast(message, kind = 'success') {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3600);
}

async function request(url, options = {}) {
  const { headers = {}, body, ...requestOptions } = options;
  const requestHeaders = new Headers({ Accept: 'application/json' });
  Object.entries(headers).forEach(([key, headerValue]) => requestHeaders.set(key, headerValue));
  if (body && typeof body === 'string' && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  const response = await fetch(url, {
    ...requestOptions,
    body,
    headers: requestHeaders,
    credentials: 'same-origin'
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch { data = { message: raw }; }
  }
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'The request could not be completed.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

async function optionalRequest(url, options = {}) {
  try {
    return await request(url, options);
  } catch (error) {
    if ([404, 405, 501].includes(error.status) || error.code === 'NOT_IMPLEMENTED') return null;
    if (error.status === 401) {
      showLogin();
      showToast('Your admin session has expired. Please sign in again.', 'error');
    }
    throw error;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function buildAdminListUrl(path, values = {}, offset = 0) {
  const requestedOffset = Number(offset);
  const safeOffset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
  const query = new URLSearchParams({ limit: String(MANAGEMENT_PAGE_SIZE), offset: String(safeOffset) });
  Object.entries(values).forEach(([key, rawValue]) => {
    const valueToAdd = String(rawValue || '').trim();
    if (valueToAdd) query.set(key, valueToAdd);
  });
  return `${path}?${query.toString()}`;
}

function beginManagementRequest(kind) {
  const entry = state.management[kind];
  entry.request?.abort();
  const controller = new AbortController();
  entry.request = controller;
  return controller;
}

function managementRequestIsCurrent(kind, controller) {
  return state.management[kind].request === controller;
}

function resetManagementPage(kind, signature) {
  const entry = state.management[kind];
  entry.signature = signature;
  entry.nextOffset = 0;
  entry.hasMore = false;
}

function applyManagementPage(kind, response, offset, itemCount) {
  const entry = state.management[kind];
  const nextOffset = Number(response?.nextOffset);
  const hasValidNextOffset = Number.isSafeInteger(nextOffset) && nextOffset > offset;
  entry.hasMore = response?.hasMore === true && hasValidNextOffset;
  entry.nextOffset = entry.hasMore ? nextOffset : offset + itemCount;
}

function loadMoreMarkup(kind, loadedCount, label) {
  const entry = state.management[kind];
  if (!entry.hasMore) return '';
  const loading = Boolean(entry.request);
  const countLabel = `${loadedCount} matching ${label} loaded`;
  return `<div class="management-pagination"><span>${escapeHTML(countLabel)}${loading ? ' — loading more…' : '. More matching records are available.'}</span><button class="secondary small-button" type="button" data-load-more="${escapeHTML(kind)}"${loading ? ' disabled' : ''}>${loading ? 'Loading…' : 'Load more'}</button></div>`;
}

function loadMoreManagement(kind) {
  if (kind === 'orders') void loadOrders(false, true);
  if (kind === 'students') void loadStudents(false, true);
  if (kind === 'feedback') void loadFeedback(false, true);
}

async function copyIdentifier(identifier, label) {
  const valueToCopy = String(identifier || '').trim();
  if (!valueToCopy) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(valueToCopy);
  } catch {
    let copied = false;
    try {
      const input = document.createElement('textarea');
      input.value = valueToCopy;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      copied = typeof document.execCommand === 'function' && document.execCommand('copy');
      input.remove();
    } catch { /* Show a clear manual-copy fallback below. */ }
    if (!copied) {
      showToast(`Could not copy the ${label}. Select it manually.`, 'error');
      return;
    }
  }
  showToast(`${label} copied.`);
}

function wireCopyButtons(root) {
  $$('.copy-id', root).forEach((button) => button.addEventListener('click', () => {
    void copyIdentifier(button.dataset.copyId, button.dataset.copyLabel || 'ID');
  }));
}

function formatNumber(number) {
  const parsed = Number(number);
  return Number.isFinite(parsed) ? new Intl.NumberFormat('en-IN').format(parsed) : '—';
}

function formatMoney(amount) {
  const parsed = Number(amount);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(parsed)
    : '—';
}

function formatDate(valueToFormat, withTime = true) {
  if (!valueToFormat) return '—';
  const date = new Date(valueToFormat);
  if (Number.isNaN(date.getTime())) return String(valueToFormat);
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {})
  }).format(date);
}

function toDateTimeLocal(valueToFormat) {
  if (!valueToFormat) return '';
  const date = new Date(valueToFormat);
  if (Number.isNaN(date.getTime())) return String(valueToFormat).slice(0, 16);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function statusLabel(valueToFormat = 'unknown') {
  return String(valueToFormat).replace(/[_-]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function roots() { return state.sections.filter(section => !section.parentId); }
function childrenOf(parentId) { return state.sections.filter(section => section.parentId === parentId); }
function sectionPath(sectionId) {
  const section = state.sections.find(item => item.id === sectionId);
  if (!section) return 'Library placement unavailable';
  const parent = section.parentId ? state.sections.find(item => item.id === section.parentId) : null;
  return parent ? `${parent.title} → ${section.title}` : section.title;
}

function sectionIsPublic(section) {
  if (!section?.isPublished) return false;
  if (!section.parentId) return true;
  const parent = state.sections.find(item => item.id === section.parentId);
  return Boolean(parent?.isPublished);
}

function cardIsPublic(card) {
  if (!card?.isPublished) return false;
  if (!card.sectionId) return true;
  return sectionIsPublic(state.sections.find(section => section.id === card.sectionId));
}

function idMarkup(id, label) {
  const safeId = String(id || '').trim();
  if (!safeId) return '';
  return `<span class="record-id"><span>${escapeHTML(label)}:</span> <code>${escapeHTML(safeId)}</code><button class="copy-id" type="button" data-copy-id="${escapeHTML(safeId)}" data-copy-label="${escapeHTML(label)}" aria-label="Copy ${escapeHTML(label)}">Copy</button></span>`;
}

function renderTags(scope) {
  const container = $(`#${scope}-tags`);
  if (!container) return;
  const tags = state.tags[scope] || [];
  container.innerHTML = tags.map((tag, index) => `<span class="tag-chip">${escapeHTML(tag)}<button type="button" data-tag-scope="${scope}" data-tag-index="${index}" aria-label="Remove ${escapeHTML(tag)}">×</button></span>`).join('');
  $$('button[data-tag-index]', container).forEach(button => button.addEventListener('click', () => {
    state.tags[scope].splice(Number(button.dataset.tagIndex), 1);
    renderTags(scope);
  }));
}

function setTags(scope, tags) {
  state.tags[scope] = normalizeTags(tags);
  renderTags(scope);
}

function addTags(scope, source) {
  const next = normalizeTags([...(state.tags[scope] || []), ...String(source || '').split(',')]);
  if (next.length === state.tags[scope].length && String(source || '').trim()) {
    showToast('That tag is already added or the tag limit has been reached.', 'error');
  }
  state.tags[scope] = next;
  renderTags(scope);
}

function wireTagInput(scope) {
  const input = $(`#${scope}-tag-input`);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (input.value.trim()) addTags(scope, input.value);
      input.value = '';
    }
    if (event.key === 'Backspace' && !input.value && state.tags[scope].length) {
      state.tags[scope].pop();
      renderTags(scope);
    }
  });
  input.addEventListener('blur', () => {
    if (!input.value.trim()) return;
    addTags(scope, input.value);
    input.value = '';
  });
}

function syncFixedPrice() {
  const isBundle = $('#isBundle').checked;
  $('#price').value = isBundle ? FULL_COURSE_BUNDLE_PRICE : INDIVIDUAL_CARD_PRICE;
  $('#price-helper').textContent = isBundle
    ? 'Full-course bundles are always ₹399. The server checks this again before saving.'
    : 'Individual study cards are always ₹39. The server checks this again before saving.';
}

function syncHomeToggle() {
  const isTile = Boolean(sectionParent.value);
  const toggle = $('#section-home');
  toggle.disabled = isTile;
  if (isTile) toggle.checked = false;
  $('#section-home-helper').textContent = isTile
    ? 'Only top-level sections can be featured on the homepage.'
    : 'Feature this top-level section on the homepage.';
}

function clarifyPromotionDraftMode() {
  const label = $('#promotion-active')?.closest('.toggle-field');
  if (!label) return;
  const title = $('strong', label);
  const helper = $('small', label);
  if (title) title.textContent = 'Save as active draft';
  if (helper) helper.textContent = 'This stores the rule for future checkout. It does not change student prices or access yet.';
  $('#promotion-form-heading').textContent = 'Create a promotion draft';
  $('#promotion-submit').textContent = 'Save promotion draft';
}

function setLabelText(controlId, text) {
  const control = $(`#${controlId}`);
  const label = control?.closest('label');
  const textNode = [...(label?.childNodes || [])].find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  if (textNode) textNode.nodeValue = `${text}\n`;
}

function clarifyLiveAdminCopy() {
  const activeMetric = $('#metric-active-users')?.closest('.metric-card');
  const activeMetricLabel = activeMetric ? $('.metric-label', activeMetric) : null;
  if (activeMetricLabel) activeMetricLabel.textContent = 'Daily active visitors';
  $('#metric-active-users-detail').textContent = 'Privacy-preserving unique visits';

  const studentsHeading = $('#students-view .view-heading > p');
  if (studentsHeading) studentsHeading.textContent = 'See students with a verified purchase, their library access and purchase history.';
  const studentSearch = $('#student-search');
  if (studentSearch) studentSearch.placeholder = 'Search name or email';

  const sectionAdvanced = $('#section-meta-title')?.closest('.advanced-settings');
  if (sectionAdvanced) {
    $('summary', sectionAdvanced).textContent = 'Tags & collection SEO';
    const helper = $('.helper', sectionAdvanced);
    if (helper) helper.textContent = 'Tags help students filter the library. These fields are used on this collection’s public, search-ready page.';
  }
  setLabelText('section-meta-title', 'Collection meta title');
  setLabelText('section-meta-description', 'Collection meta description');
  setLabelText('section-seo-keywords', 'Collection SEO keywords');

  const bulkDraftStep = $('#bulk-view .steps-list li:nth-child(4)');
  if (bulkDraftStep) bulkDraftStep.textContent = 'Leave isPublished blank (or use false) to create drafts. Use true only when each card is ready to be public.';
  const bulkCsvHelper = $('#bulk-csv')?.closest('label')?.querySelector('.helper');
  if (bulkCsvHelper) bulkCsvHelper.textContent = 'Includes title, section, subject, description, tags and publishing options. Blank or false in isPublished creates a draft; true publishes a card when its parent is published.';
}

function refreshCatalogOptions(selectedCardSection = cardSection.value) {
  const selectedParent = sectionParent.value;
  const editingId = value('section-id');
  const parentOptions = roots().filter(section => section.id !== editingId)
    .map(section => `<option value="${escapeHTML(section.id)}">${escapeHTML(section.title)}</option>`).join('');
  sectionParent.innerHTML = `<option value="">Top-level library section</option>${parentOptions}`;
  if ([...sectionParent.options].some(option => option.value === selectedParent)) sectionParent.value = selectedParent;
  syncHomeToggle();
  const locationOptions = roots().map(root => {
    const direct = `<option value="${escapeHTML(root.id)}">${escapeHTML(root.title)} — direct resource</option>`;
    const children = childrenOf(root.id).map(child => `<option value="${escapeHTML(child.id)}">${escapeHTML(root.title)} → ${escapeHTML(child.title)}</option>`).join('');
    return direct + children;
  }).join('');
  cardSection.innerHTML = `<option value="">Legacy category pages only</option>${locationOptions}`;
  if ([...cardSection.options].some(option => option.value === selectedCardSection)) cardSection.value = selectedCardSection;
}

function renderSections() {
  const rootsToRender = roots();
  if (!rootsToRender.length) { sectionList.innerHTML = ''; return; }
  sectionList.innerHTML = rootsToRender.map(root => {
    const item = section => {
      const tags = normalizeTags(entityValue(section, 'tags'));
      const tagNote = tags.length ? ` · ${tags.length} tag${tags.length === 1 ? '' : 's'}` : '';
      const metadataNote = entityValue(section, 'metaTitle') || entityValue(section, 'metaDescription') || entityValue(section, 'seoKeywords')
        ? ' · Collection SEO saved'
        : '';
      const identifier = idMarkup(section.id, section.parentId ? 'Tile ID' : 'Section ID');
      return `<div class="section-row${section.parentId ? ' section-child' : ''}"><div class="section-icon" aria-hidden="true">${escapeHTML(section.icon || '📚')}</div><div class="section-details"><strong>${escapeHTML(section.title)}</strong><span>${escapeHTML(section.description || (section.parentId ? 'Library tile' : 'Top-level library section'))}</span><small>${section.isPublished ? 'Published' : 'Draft'} · Order ${escapeHTML(section.sortOrder)}${escapeHTML(tagNote)}${escapeHTML(metadataNote)}</small>${identifier}</div><div class="section-actions"><button class="secondary edit-section" type="button" data-id="${escapeHTML(section.id)}">Edit</button><button class="remove delete-section" type="button" data-id="${escapeHTML(section.id)}">Remove</button></div></div>`;
    };
    return `<div class="section-group">${item(root)}${childrenOf(root.id).map(item).join('')}</div>`;
  }).join('');
  $$('.edit-section', sectionList).forEach(button => button.addEventListener('click', () => editSection(button.dataset.id)));
  $$('.delete-section', sectionList).forEach(button => button.addEventListener('click', () => removeSection(button.dataset.id)));
  wireCopyButtons(sectionList);
}

async function loadSections() {
  const data = await request('/api/admin/sections');
  state.sections = toArray(data.sections);
  refreshCatalogOptions();
  renderSections();
  if (state.cards.length) renderCards();
}

function resetSectionForm() {
  state.editingSectionId = null;
  sectionForm.reset();
  $('#section-id').value = '';
  $('#section-published').checked = true;
  $('#section-home').checked = false;
  $('#section-order').value = '0';
  $('#section-form-heading').textContent = 'Create a section or tile';
  $('#section-submit').textContent = 'Create section';
  $('#section-cancel').hidden = true;
  setTags('section', []);
  refreshCatalogOptions('');
}

function editSection(id) {
  const section = state.sections.find(item => item.id === id);
  if (!section) return;
  state.editingSectionId = id;
  $('#section-id').value = section.id;
  refreshCatalogOptions();
  sectionParent.value = section.parentId || '';
  $('#section-title').value = section.title || '';
  $('#section-description').value = section.description || '';
  if ([...$('#section-icon').options].some(option => option.value === section.icon)) $('#section-icon').value = section.icon;
  $('#section-order').value = String(section.sortOrder || 0);
  $('#section-published').checked = Boolean(section.isPublished);
  $('#section-home').checked = Boolean(section.showOnHome);
  $('#section-meta-title').value = entityValue(section, 'metaTitle');
  $('#section-meta-description').value = entityValue(section, 'metaDescription');
  $('#section-seo-keywords').value = entityValue(section, 'seoKeywords');
  setTags('section', entityValue(section, 'tags'));
  syncHomeToggle();
  $('#section-form-heading').textContent = section.parentId ? 'Edit library tile' : 'Edit library section';
  $('#section-submit').textContent = 'Save changes';
  $('#section-cancel').hidden = false;
  sectionForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function removeSection(id) {
  const section = state.sections.find(item => item.id === id);
  if (!section || !confirm(`Remove “${section.title}”? Remove or move its tiles and study cards first.`)) return;
  try {
    await request(`/api/admin/sections/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSections();
    resetSectionForm();
    showToast('Library section removed.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderFiles(files = [], emptyMessage = 'No protected PDFs have been uploaded yet.') {
  fileList.innerHTML = files.length
    ? files.map(file => `<div class="pdf-file"><span>${escapeHTML(file)}</span><button class="remove delete-file" type="button" data-file="${escapeHTML(file)}">Remove</button></div>`).join('')
    : `<p class="notice">${escapeHTML(emptyMessage)}</p>`;
  $$('.delete-file', fileList).forEach(button => button.addEventListener('click', () => removePdf(button.dataset.file)));
}

function refreshSubjects() {
  const subject = $('#subject');
  const current = subject.value;
  const subjects = subjectOptions[value('className')] || subjectOptions[10];
  $('#subject-suggestions').innerHTML = subjects.map(option => `<option value="${escapeHTML(option)}"></option>`).join('');
  if (!current) subject.value = subjects[0];
}

async function loadFiles(selected = value('fileKey')) {
  const select = $('#fileKey');
  try {
    const data = await request('/api/admin/files');
    const files = toArray(data.files);
    select.disabled = false;
    uploadInput.disabled = false;
    uploadButton.disabled = false;
    uploadName.textContent = 'Maximum file size: 25 MB.';
    select.innerHTML = `<option value="">Not ready for sale yet</option>${files.map(file => `<option value="${escapeHTML(file)}">${escapeHTML(file)}</option>`).join('')}`;
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    renderFiles(files);
  } catch (error) {
    if (error.status === 503 && error.code === 'PAPER_STORAGE_UNAVAILABLE') {
      const message = 'Secure PDF storage is not configured yet. You can create sections and draft cards, but uploads and paid PDF access stay disabled until it is connected.';
      select.disabled = true;
      uploadInput.disabled = true;
      uploadButton.disabled = true;
      select.innerHTML = `<option value="${escapeHTML(selected || '')}">${escapeHTML(selected ? `${selected} — storage unavailable` : 'Protected storage unavailable')}</option>`;
      if (selected) select.value = selected;
      uploadName.textContent = 'Connect protected PDF storage before uploading or selling PDFs.';
      renderFiles([], message);
      return;
    }
    select.disabled = false;
    uploadInput.disabled = false;
    uploadButton.disabled = false;
    select.innerHTML = '<option value="">No protected PDFs found</option>';
    renderFiles([], 'Protected PDF files could not be loaded. Try again shortly.');
  }
}

function resetCardForm() {
  state.editingCardId = null;
  form.reset();
  $('#is-published').checked = true;
  $('#sort-order').value = '0';
  $('#form-heading').textContent = 'New study card';
  $('#cancel-edit').hidden = true;
  setTags('card', []);
  syncFixedPrice();
  refreshSubjects();
  refreshCatalogOptions('');
  loadFiles('');
}

function renderCardTags(card) {
  const tags = normalizeTags(entityValue(card, 'tags'));
  if (!tags.length) return '';
  return `<div class="card-tags">${tags.map(tag => `<span>${escapeHTML(tag)}</span>`).join('')}</div>`;
}

function renderCards() {
  const query = value('filter-cards').trim().toLowerCase();
  const items = state.cards.filter(card => !query || `${card.title} ${card.className} ${card.subject} ${card.type} ${card.resourceLabel || ''} ${sectionPath(card.sectionId)} ${normalizeTags(entityValue(card, 'tags')).join(' ')}`.toLowerCase().includes(query));
  list.innerHTML = items.length ? items.map(card => {
    const location = card.sectionId ? `Library: ${sectionPath(card.sectionId)}` : `Legacy: Class ${card.className} · ${card.type}`;
    const cardState = card.isPublished ? (cardIsPublic(card) ? 'Published' : 'Published card · parent draft') : 'Draft';
    const seoState = entityValue(card, 'metaTitle') || entityValue(card, 'metaDescription') ? ' · SEO ready' : '';
    return `<article class="card"><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(location)} · ${escapeHTML(card.subject)} · ₹${escapeHTML(card.price)}${card.isBundle ? ' · Full bundle' : ''}</p>${renderCardTags(card)}<footer><span>${escapeHTML(cardState)} · ${card.fileKey ? 'Protected PDF linked' : card.link ? 'Preview linked' : 'File pending'}${escapeHTML(seoState)}${idMarkup(card.id, 'Card ID')}</span><span><button class="secondary edit" type="button" data-id="${escapeHTML(card.id)}">Edit</button> <button class="remove delete" type="button" data-id="${escapeHTML(card.id)}">Remove</button></span></footer></article>`;
  }).join('') : `<p class="notice">${query ? 'No cards match your search.' : 'No study cards added yet.'}</p>`;
  $$('.edit', list).forEach(button => button.addEventListener('click', () => editCard(button.dataset.id)));
  $$('.delete', list).forEach(button => button.addEventListener('click', () => removeCard(button.dataset.id)));
  wireCopyButtons(list);
}

async function loadCards() {
  const data = await request('/api/admin/cards');
  state.cards = toArray(data.cards);
  renderCards();
}

async function editCard(id) {
  const card = state.cards.find(item => item.id === id);
  if (!card) return;
  state.editingCardId = card.id;
  $('#type').value = card.type;
  $('#className').value = card.className;
  refreshSubjects();
  ['subject', 'title', 'description', 'link'].forEach(field => { $(`#${field}`).value = card[field] || ''; });
  refreshCatalogOptions(card.sectionId || '');
  $('#resource-label').value = card.resourceLabel || '';
  $('#sort-order').value = String(card.sortOrder || 0);
  $('#is-published').checked = Boolean(card.isPublished);
  $('#isBundle').checked = Boolean(card.isBundle);
  $('#card-meta-title').value = entityValue(card, 'metaTitle');
  $('#card-meta-description').value = entityValue(card, 'metaDescription');
  $('#card-seo-keywords').value = entityValue(card, 'seoKeywords');
  setTags('card', entityValue(card, 'tags'));
  syncFixedPrice();
  await loadFiles(card.fileKey || '');
  $('#form-heading').textContent = 'Edit study card';
  $('#cancel-edit').hidden = false;
  $('#content-view').hidden = false;
  showView('content');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function removeCard(id) {
  if (!confirm('Remove this study card?')) return;
  try {
    await request(`/api/admin/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.cards = state.cards.filter(card => card.id !== id);
    renderCards();
    status.textContent = 'Study card removed.';
    showToast('Study card removed.');
    state.loadedViews.delete('overview');
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, 'error');
  }
}

function setMetric(id, amount, detail) {
  $(`#${id}`).textContent = amount;
  if (detail) $(`#${id}-detail`).textContent = detail;
}

function renderTopResources(resources) {
  const container = $('#dashboard-top-resources');
  const items = toArray(resources);
  container.innerHTML = items.length ? items.slice(0, 6).map((item, index) => {
    const title = firstValue(item, ['title', 'name', 'resourceTitle', 'paperTitle'], 'Untitled resource');
    const orders = firstValue(item, ['orders', 'sales', 'purchases', 'purchaseCount', 'count'], 0);
    const revenue = firstValue(item, ['revenue', 'amount', 'total'], null);
    return `<div class="performance-row"><span class="performance-rank">${index + 1}</span><div><strong>${escapeHTML(title)}</strong><small>${formatNumber(orders)} purchase${Number(orders) === 1 ? '' : 's'}${revenue !== null ? ` · ${formatMoney(revenue)}` : ''}</small></div></div>`;
  }).join('') : '<p class="notice">No verified resource performance is available yet.</p>';
}

function renderRecentActivity(entries) {
  const container = $('#dashboard-recent-orders');
  const items = toArray(entries);
  container.innerHTML = items.length ? items.slice(0, 6).map(item => {
    const title = firstValue(item, ['title', 'resourceTitle', 'paperTitle', 'name'], 'Order update');
    const person = firstValue(item, ['studentName', 'customerName', 'email'], 'Student');
    const createdAt = firstValue(item, ['createdAt', 'updatedAt', 'purchasedAt'], null);
    const eventStatus = firstValue(item, ['status', 'paymentStatus', 'state'], 'updated');
    return `<div class="activity-row"><div class="activity-dot" aria-hidden="true"></div><div><strong>${escapeHTML(title)}</strong><small>${escapeHTML(person)} · ${escapeHTML(statusLabel(eventStatus))}${createdAt ? ` · ${escapeHTML(formatDate(createdAt))}` : ''}</small></div></div>`;
  }).join('') : '<p class="notice">No recent verified activity is available yet.</p>';
}

function dashboardPayload(data) {
  const candidate = data?.dashboard || data?.data || data || {};
  return {
    metrics: candidate.metrics || candidate.summary || candidate,
    users: candidate.users || {},
    revenue: candidate.revenue || {},
    orders: candidate.orders || {},
    topResources: collectionFrom(candidate, ['topResources', 'topPapers', 'resources', 'bestSellers']),
    recentOrders: collectionFrom(candidate, ['recentOrders', 'recentActivity', 'activity']),
    openFeedback: firstValue(candidate, ['openFeedback', 'feedbackOpenCount', 'openReports'], firstValue(candidate.feedback, ['open'], null))
  };
}

async function loadDashboard(force = false) {
  if (!force && state.loadedViews.has('overview')) return;
  $('#dashboard-note').textContent = 'Loading live business data…';
  try {
    const data = await optionalRequest('/api/admin/dashboard');
    const publishedFallback = state.cards.filter(card => card.isPublished).length;
    if (!data) {
      setMetric('metric-active-users', '—', 'Analytics will appear after the service is connected');
      setMetric('metric-revenue-today', '—', 'Verified payments only');
      setMetric('metric-revenue-month', '—', 'Verified payments only');
      setMetric('metric-orders', '—', 'Order reporting not connected yet');
      setMetric('metric-published', formatNumber(publishedFallback), 'Visible to students');
      renderTopResources([]);
      renderRecentActivity([]);
      $('#dashboard-note').textContent = 'Live sales analytics will appear here when the reporting service is available. Catalogue data remains ready to manage.';
      return;
    }
    const payload = dashboardPayload(data);
    const metrics = payload.metrics;
    const activeUsers = firstValue(metrics, ['dailyActiveUsers', 'activeUsers', 'dau'], firstValue(payload.users, ['dailyActive', 'dailyActiveUsers'], null));
    const todayRevenue = firstValue(metrics, ['dailyRevenue', 'todayRevenue', 'revenueToday'], firstValue(payload.revenue, ['today'], null));
    const monthRevenue = firstValue(metrics, ['monthlyRevenue', 'monthRevenue', 'revenueThisMonth'], firstValue(payload.revenue, ['month'], null));
    const successfulOrders = firstValue(metrics, ['dailyOrders', 'ordersToday', 'successfulOrders'], firstValue(payload.revenue, ['todayOrders'], null));
    const published = firstValue(metrics, ['publishedResources', 'publishedCards', 'publishedCount'], state.cards.filter(card => card.isPublished).length);
    setMetric('metric-active-users', activeUsers === null ? '—' : formatNumber(activeUsers), activeUsers === null ? 'Awaiting visitor activity data' : 'Unique visitors today');
    setMetric('metric-revenue-today', todayRevenue === null ? '—' : formatMoney(todayRevenue), 'Verified payments only');
    setMetric('metric-revenue-month', monthRevenue === null ? '—' : formatMoney(monthRevenue), 'Verified payments only');
    setMetric('metric-orders', successfulOrders === null ? '—' : formatNumber(successfulOrders), 'Successful orders today');
    setMetric('metric-published', formatNumber(published), 'Visible to students');
    renderTopResources(payload.topResources);
    renderRecentActivity(payload.recentOrders);
    if (payload.openFeedback !== null) updateFeedbackBadge(payload.openFeedback);
    $('#dashboard-note').textContent = 'Metrics refresh from verified server records. Revenue never includes pending payments.';
    state.loadedViews.add('overview');
  } catch (error) {
    $('#dashboard-note').textContent = `Dashboard data could not be loaded: ${error.message}`;
    renderTopResources([]);
    renderRecentActivity([]);
  }
}

function unavailableMessage(label) {
  return `<div class="empty-state"><strong>${escapeHTML(label)} is not available yet.</strong><p>The dashboard is ready for this feature. It will show shared data as soon as the corresponding secure server service is enabled.</p></div>`;
}

function loadingMessage(label) {
  return `<div class="loading-state"><span class="loading-dot" aria-hidden="true"></span>${escapeHTML(label)}</div>`;
}

function orderStatus(order) { return String(firstValue(order, ['status', 'paymentStatus', 'state'], 'unknown')).toLowerCase(); }
function orderAccess(order) {
  if (order?.accessRevoked === true || order?.student?.accessRevoked === true) return 'revoked';
  const access = firstValue(order, ['accessStatus', 'access', 'entitlementStatus'], null);
  if (typeof access === 'boolean') return access ? 'granted' : 'revoked';
  if (access !== null) return String(access).toLowerCase();
  return ['paid', 'completed', 'successful', 'captured', 'fulfilled'].includes(orderStatus(order)) ? 'granted' : 'pending';
}

function renderOrders() {
  const container = $('#orders-content');
  const loadedCount = state.orders.length;
  const items = state.orders;
  if (!loadedCount) {
    container.innerHTML = '<p class="notice">No orders match the current server filters.</p>';
    $('#orders-note').textContent = 'No matching order records were found.';
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="management-table"><thead><tr><th>Order</th><th>Student</th><th>Resource</th><th>Amount</th><th>Payment</th><th>Access</th><th>Actions</th></tr></thead><tbody>${items.map(order => {
    const id = firstValue(order, ['id', 'orderId'], '');
    const student = order.student?.name || firstValue(order, ['studentName', 'customerName', 'buyerName', 'name', 'email', 'buyerEmail'], 'Student');
    const contact = order.student?.email || firstValue(order, ['email', 'buyerEmail', 'phone'], '—');
    const resource = order.card?.title || firstValue(order, ['resourceTitle', 'paperTitle', 'title', 'cardTitle'], 'Study resource');
    const amount = firstValue(order, ['amount', 'total', 'price', 'amountPaid'], null);
    const created = firstValue(order, ['createdAt', 'purchasedAt', 'paidAt'], null);
    const payment = orderStatus(order);
    const access = orderAccess(order);
    const paidOrder = ['captured', 'fulfilled'].includes(payment);
    const studentAccessRevoked = order?.student?.accessRevoked === true;
    let actions = '<span class="muted-cell">Payment not completed</span>';
    if (id && paidOrder) {
      if (access === 'granted') {
        actions = `<button class="secondary small-button" type="button" data-order-action="revoke_access" data-order-id="${escapeHTML(id)}">Revoke access</button><button class="remove small-button" type="button" data-order-action="refund" data-order-id="${escapeHTML(id)}">Mark refunded</button>`;
      } else if (access === 'revoked' && !studentAccessRevoked) {
        actions = `<button class="secondary small-button" type="button" data-order-action="restore_access" data-order-id="${escapeHTML(id)}">Restore access</button><button class="remove small-button" type="button" data-order-action="refund" data-order-id="${escapeHTML(id)}">Mark refunded</button>`;
      } else if (studentAccessRevoked) {
        actions = '<span class="muted-cell">Restore in Students</span>';
      }
    } else if (id && payment === 'refunded') {
      actions = '<span class="muted-cell">Refunded orders stay blocked</span>';
    } else if (!id) {
      actions = '<span class="muted-cell">No order ID</span>';
    }
    return `<tr><td><strong>${escapeHTML(id || '—')}</strong><small>${escapeHTML(formatDate(created))}</small></td><td><strong>${escapeHTML(student)}</strong><small>${escapeHTML(contact)}</small></td><td>${escapeHTML(resource)}</td><td>${formatMoney(amount)}</td><td><span class="status-pill status-${escapeHTML(payment)}">${escapeHTML(statusLabel(payment))}</span></td><td><span class="status-pill status-${escapeHTML(access)}">${escapeHTML(statusLabel(access))}</span></td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join('')}</tbody></table></div>${loadMoreMarkup('orders', loadedCount, 'order records')}`;
  $('#orders-note').textContent = `${loadedCount} matching order record${loadedCount === 1 ? '' : 's'} loaded from the server.${state.management.orders.hasMore ? ' More matching order records are available.' : ''}`;
}

async function loadOrders(force = false, append = false) {
  const query = value('order-search').trim();
  const selectedStatus = value('order-status-filter').trim();
  const filters = selectedStatus === 'revoked' ? { q: query, access: 'revoked' } : { q: query, status: selectedStatus };
  const signature = JSON.stringify(filters);
  const entry = state.management.orders;
  if (append && entry.signature !== signature) return loadOrders(true);
  if (append && (!entry.hasMore || entry.request)) return;
  if (!append && !force && state.loadedViews.has('orders') && entry.signature === signature) return;
  const offset = append ? entry.nextOffset : 0;
  const controller = beginManagementRequest('orders');
  let shouldRender = false;
  let appendError = '';
  if (append) {
    renderOrders();
    $('#orders-note').textContent = `Loading more matching order records after ${state.orders.length} already loaded…`;
  } else {
    resetManagementPage('orders', signature);
    state.orders = [];
    state.loadedViews.delete('orders');
    $('#orders-content').innerHTML = loadingMessage('Loading secure order records…');
    $('#orders-note').textContent = 'Loading verified orders…';
  }
  try {
    const data = await optionalRequest(buildAdminListUrl('/api/admin/orders', filters, offset), { signal: controller.signal });
    if (!managementRequestIsCurrent('orders', controller)) return;
    if (!data) {
      if (append) {
        entry.hasMore = false;
        appendError = 'More records are not available because the order-management service is not enabled.';
        shouldRender = true;
      } else {
        $('#orders-content').innerHTML = unavailableMessage('Order management');
        $('#orders-note').textContent = 'No order-management endpoint is enabled yet.';
      }
      return;
    }
    const orders = collectionFrom(data, ['orders', 'items']);
    state.orders = append ? [...state.orders, ...orders] : orders;
    applyManagementPage('orders', data, offset, orders.length);
    shouldRender = true;
    state.loadedViews.add('orders');
  } catch (error) {
    if (isAbortError(error)) return;
    if (!managementRequestIsCurrent('orders', controller)) return;
    if (append) {
      appendError = `Could not load more order records: ${error.message}`;
      shouldRender = true;
    } else {
      $('#orders-content').innerHTML = `<p class="notice">${escapeHTML(error.message)}</p>`;
      $('#orders-note').textContent = 'Order records could not be loaded.';
    }
  } finally {
    if (managementRequestIsCurrent('orders', controller)) {
      entry.request = null;
      if (shouldRender) {
        renderOrders();
        if (appendError) $('#orders-note').textContent = `${state.orders.length} matching order record${state.orders.length === 1 ? '' : 's'} loaded from the server. ${appendError}`;
      }
    }
  }
}

async function changeOrder(id, action) {
  const needsConfirmation = action === 'refund'
    ? 'Record this order as refunded? This updates the access and order record; it does not automatically send a refund through a payment provider.'
    : action === 'revoke_access'
      ? 'Revoke this student’s access to the purchased material?'
      : null;
  if (needsConfirmation && !confirm(needsConfirmation)) return;
  try {
    const update = action === 'refund'
      ? { markRefunded: true, refundNote: 'Recorded by administrator' }
      : { accessRevoked: action === 'revoke_access', revocationReason: action === 'revoke_access' ? 'Revoked by administrator' : null };
    await request(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(update) });
    showToast(action === 'refund' ? 'Order marked as refunded. Process the payment-provider refund separately if needed.' : action === 'restore_access' ? 'Access record restored.' : 'Access record updated.');
    state.loadedViews.delete('orders');
    state.loadedViews.delete('overview');
    await Promise.all([loadOrders(true), loadDashboard(true)]);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function studentAccess(student) {
  if (student?.accessRevoked === true) return 'revoked';
  const access = firstValue(student, ['accessStatus', 'access', 'status'], null);
  if (typeof access === 'boolean') return access ? 'granted' : 'revoked';
  return access === null ? 'active' : String(access).toLowerCase();
}

function renderStudents() {
  const container = $('#students-content');
  const loadedCount = state.students.length;
  const items = state.students;
  if (!loadedCount) {
    container.innerHTML = '<p class="notice">No students match the current server search.</p>';
    $('#students-note').textContent = 'No matching student records were found.';
    return;
  }
  container.innerHTML = `<div class="table-wrap"><table class="management-table"><thead><tr><th>Student</th><th>Purchase history</th><th>Access</th><th>Last activity</th><th>Actions</th></tr></thead><tbody>${items.map(student => {
    const id = firstValue(student, ['id', 'studentId', 'userId'], '');
    const name = firstValue(student, ['name', 'studentName', 'displayName'], 'Student');
    const email = firstValue(student, ['email'], '—');
    const phone = firstValue(student, ['phone', 'phoneNumber'], '');
    const rawPurchases = student.purchases ?? student.purchaseHistory;
    const purchases = toArray(rawPurchases);
    const count = firstValue(student, ['purchaseCount', 'orderCount'], typeof rawPurchases === 'number' ? rawPurchases : purchases.length);
    const access = studentAccess(student);
    const activity = firstValue(student, ['lastActiveAt', 'updatedAt', 'createdAt'], null);
    const details = purchases.length ? `<details class="purchase-details"><summary>${formatNumber(count)} purchase${Number(count) === 1 ? '' : 's'}</summary><ul>${purchases.slice(0, 5).map(purchase => `<li>${escapeHTML(firstValue(purchase, ['title', 'resourceTitle', 'paperTitle'], 'Study resource'))}</li>`).join('')}</ul></details>` : `${formatNumber(count)} purchase${Number(count) === 1 ? '' : 's'}`;
    const actions = id ? `<button class="secondary small-button" type="button" data-student-action="reset_password" data-student-id="${escapeHTML(id)}">Log reset request</button><button class="${access === 'revoked' ? 'secondary' : 'remove'} small-button" type="button" data-student-action="${access === 'revoked' ? 'restore_access' : 'revoke_access'}" data-student-id="${escapeHTML(id)}">${access === 'revoked' ? 'Restore access' : 'Revoke access'}</button>` : '<span class="muted-cell">No student ID</span>';
    return `<tr><td><strong>${escapeHTML(name)}</strong><small>${escapeHTML(email)}${phone ? ` · ${escapeHTML(phone)}` : ''}</small></td><td>${details}</td><td><span class="status-pill status-${escapeHTML(access)}">${escapeHTML(statusLabel(access))}</span></td><td>${escapeHTML(formatDate(activity))}</td><td><div class="row-actions">${actions}</div></td></tr>`;
  }).join('')}</tbody></table></div>${loadMoreMarkup('students', loadedCount, 'student records')}`;
  $('#students-note').textContent = `${loadedCount} matching student record${loadedCount === 1 ? '' : 's'} loaded from the server.${state.management.students.hasMore ? ' More matching student records are available.' : ''}`;
}

async function loadStudents(force = false, append = false) {
  const query = value('student-search').trim();
  const signature = JSON.stringify({ q: query });
  const entry = state.management.students;
  if (append && entry.signature !== signature) return loadStudents(true);
  if (append && (!entry.hasMore || entry.request)) return;
  if (!append && !force && state.loadedViews.has('students') && entry.signature === signature) return;
  const offset = append ? entry.nextOffset : 0;
  const controller = beginManagementRequest('students');
  let shouldRender = false;
  let appendError = '';
  if (append) {
    renderStudents();
    $('#students-note').textContent = `Loading more matching student records after ${state.students.length} already loaded…`;
  } else {
    resetManagementPage('students', signature);
    state.students = [];
    state.loadedViews.delete('students');
    $('#students-content').innerHTML = loadingMessage('Loading student records…');
    $('#students-note').textContent = 'Loading secure student records…';
  }
  try {
    const data = await optionalRequest(buildAdminListUrl('/api/admin/students', { q: query }, offset), { signal: controller.signal });
    if (!managementRequestIsCurrent('students', controller)) return;
    if (!data) {
      if (append) {
        entry.hasMore = false;
        appendError = 'More records are not available because the student-management service is not enabled.';
        shouldRender = true;
      } else {
        $('#students-content').innerHTML = unavailableMessage('Student management');
        $('#students-note').textContent = 'Student accounts and order-linked profiles will appear here once enabled.';
      }
      return;
    }
    const students = collectionFrom(data, ['students', 'items', 'users']);
    state.students = append ? [...state.students, ...students] : students;
    applyManagementPage('students', data, offset, students.length);
    shouldRender = true;
    state.loadedViews.add('students');
  } catch (error) {
    if (isAbortError(error)) return;
    if (!managementRequestIsCurrent('students', controller)) return;
    if (append) {
      appendError = `Could not load more student records: ${error.message}`;
      shouldRender = true;
    } else {
      $('#students-content').innerHTML = `<p class="notice">${escapeHTML(error.message)}</p>`;
      $('#students-note').textContent = 'Student records could not be loaded.';
    }
  } finally {
    if (managementRequestIsCurrent('students', controller)) {
      entry.request = null;
      if (shouldRender) {
        renderStudents();
        if (appendError) $('#students-note').textContent = `${state.students.length} matching student record${state.students.length === 1 ? '' : 's'} loaded from the server. ${appendError}`;
      }
    }
  }
}

async function changeStudent(id, action) {
  const confirmation = action === 'revoke_access'
    ? 'Revoke this student’s access? Their purchase history will remain available to you.'
    : action === 'reset_password'
      ? 'Log a password reset-support request? Student sign-in is not enabled yet, so this will not send a reset email.'
      : null;
  if (confirmation && !confirm(confirmation)) return;
  try {
    if (action === 'reset_password') {
      await request(`/api/admin/students/${encodeURIComponent(id)}/password-reset`, { method: 'POST', body: JSON.stringify({}) });
    } else {
      await request(`/api/admin/students/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ accessRevoked: action === 'revoke_access' }) });
    }
    showToast(action === 'reset_password' ? 'Reset-support request logged. Student sign-in is not active yet.' : 'Student access updated.');
    state.loadedViews.delete('students');
    state.loadedViews.delete('orders');
    await loadStudents(true);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function promotionKindLabel(kind) {
  return ({ discount: 'Discount code', bundle: 'Bundle offer', subscription: 'Subscription tier' })[kind] || statusLabel(kind || 'offer');
}

function idList(valueToNormalize) {
  const values = Array.isArray(valueToNormalize) ? valueToNormalize : String(valueToNormalize || '').split(',');
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
}

function displayScope(valueToFormat) {
  const values = idList(valueToFormat);
  return values.length ? values.join(', ') : 'All eligible resources';
}

function renderPromotions() {
  const container = $('#promotions-content');
  if (!state.promotions.length) {
    container.innerHTML = '<p class="notice">No offers have been created yet.</p>';
    return;
  }
  container.innerHTML = state.promotions.map(promotion => {
    const id = firstValue(promotion, ['id', 'promotionId'], '');
    const code = firstValue(promotion, ['code'], 'No code');
    const name = firstValue(promotion, ['name', 'title'], 'Untitled offer');
    const kind = firstValue(promotion, ['kind', 'type'], 'discount');
    const discountType = firstValue(promotion, ['discountType', 'valueType'], 'percent');
    const discountValue = firstValue(promotion, ['value', 'discountValue', 'amount'], null);
    const active = Boolean(firstValue(promotion, ['isActive', 'active'], false));
    const usage = firstValue(promotion, ['redemptions', 'usageCount', 'uses'], 0);
    const limit = firstValue(promotion, ['maxRedemptions', 'usageLimit', 'limit'], null);
    const endsAt = firstValue(promotion, ['endsAt', 'endDate'], null);
    const discount = discountValue === null ? 'Server-defined' : discountType === 'percent' || discountType === 'percentage' ? `${discountValue}% off` : `${formatMoney(discountValue)} off`;
    const actionButtons = id ? `<button class="secondary small-button" type="button" data-promotion-action="edit" data-promotion-id="${escapeHTML(id)}">Edit</button><button class="${active ? 'secondary' : 'save'} small-button" type="button" data-promotion-action="toggle" data-promotion-id="${escapeHTML(id)}">${active ? 'Mark inactive' : 'Mark active'}</button><button class="remove small-button" type="button" data-promotion-action="delete" data-promotion-id="${escapeHTML(id)}">Delete</button>` : '';
    return `<article class="offer-card"><div class="offer-card-main"><div><span class="offer-code">${escapeHTML(code)}</span><h3>${escapeHTML(name)}</h3><p>${escapeHTML(promotionKindLabel(kind))} · ${escapeHTML(discount)} · ${escapeHTML(displayScope(firstValue(promotion, ['appliesTo', 'scope'], [])))}</p><small>${escapeHTML(formatNumber(usage))}${Number(limit) > 0 ? ` / ${escapeHTML(formatNumber(limit))}` : ''} recorded uses${endsAt ? ` · Ends ${escapeHTML(formatDate(endsAt, false))}` : ''} · Checkout inactive</small></div><span class="status-pill ${active ? 'status-paid' : 'status-muted'}">${active ? 'Saved active' : 'Saved inactive'}</span></div><div class="row-actions">${actionButtons}</div></article>`;
  }).join('');
}

function resetPromotionForm() {
  state.editingPromotionId = null;
  $('#promotion-form').reset();
  $('#promotion-id').value = '';
  $('#promotion-active').checked = true;
  $('#promotion-form-heading').textContent = 'Create a promotion draft';
  $('#promotion-submit').textContent = 'Save promotion draft';
  $('#promotion-cancel').hidden = true;
}

function editPromotion(id) {
  const promotion = state.promotions.find(item => String(firstValue(item, ['id', 'promotionId'], '')) === String(id));
  if (!promotion) return;
  state.editingPromotionId = id;
  $('#promotion-id').value = id;
  $('#promotion-code').value = firstValue(promotion, ['code'], '');
  $('#promotion-name').value = firstValue(promotion, ['name', 'title'], '');
  $('#promotion-description').value = firstValue(promotion, ['description'], '');
  $('#promotion-kind').value = firstValue(promotion, ['kind', 'type'], 'discount');
  $('#promotion-discount-type').value = firstValue(promotion, ['discountType', 'valueType'], 'percent');
  $('#promotion-value').value = firstValue(promotion, ['value', 'discountValue', 'amount'], '');
  $('#promotion-applies-to').value = idList(firstValue(promotion, ['appliesTo', 'scope'], [])).join(', ');
  $('#promotion-bundle-card-ids').value = idList(firstValue(promotion, ['bundleCardIds'], [])).join(', ');
  $('#promotion-limit').value = firstValue(promotion, ['maxRedemptions', 'usageLimit', 'limit'], '');
  $('#promotion-billing-interval').value = firstValue(promotion, ['billingInterval'], 'none');
  $('#promotion-starts').value = toDateTimeLocal(firstValue(promotion, ['startsAt', 'startDate'], ''));
  $('#promotion-ends').value = toDateTimeLocal(firstValue(promotion, ['endsAt', 'endDate'], ''));
  $('#promotion-active').checked = Boolean(firstValue(promotion, ['isActive', 'active'], false));
  $('#promotion-form-heading').textContent = 'Edit promotion draft';
  $('#promotion-submit').textContent = 'Save changes';
  $('#promotion-cancel').hidden = false;
  $('#promotion-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadPromotions(force = false) {
  if (!force && state.loadedViews.has('promotions')) return;
  $('#promotions-content').innerHTML = loadingMessage('Loading current offers…');
  $('#promotions-note').textContent = 'Loading offers…';
  try {
    const data = await optionalRequest('/api/admin/promotions');
    if (!data) {
      $('#promotions-content').innerHTML = unavailableMessage('Promotions');
      $('#promotions-note').textContent = 'Promotions will become available once pricing rules are enabled on the server.';
      return;
    }
    state.promotions = collectionFrom(data, ['promotions', 'offers', 'items']);
    renderPromotions();
    const checkoutEnabled = data.checkoutEnabled === true;
    $('#promotions-note').textContent = checkoutEnabled
      ? `${state.promotions.length} offer${state.promotions.length === 1 ? '' : 's'} loaded. Payment eligibility is checked by the server.`
      : `${state.promotions.length} promotion draft${state.promotions.length === 1 ? '' : 's'} loaded. Checkout does not apply codes, bundles or subscriptions yet.`;
    state.loadedViews.add('promotions');
  } catch (error) {
    $('#promotions-content').innerHTML = `<p class="notice">${escapeHTML(error.message)}</p>`;
    $('#promotions-note').textContent = 'Offers could not be loaded.';
  }
}

async function savePromotion(event) {
  event.preventDefault();
  const kind = value('promotion-kind');
  const code = value('promotion-code').trim().toUpperCase();
  const discountType = value('promotion-discount-type');
  const discountValue = Number(value('promotion-value'));
  const startsAt = value('promotion-starts');
  const endsAt = value('promotion-ends');
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code)) {
    showToast('Use a 3–32 character code with letters, numbers, hyphens or underscores.', 'error');
    $('#promotion-code').focus();
    return;
  }
  if (!Number.isSafeInteger(discountValue) || discountValue < 0 || (discountType === 'percent' && discountValue > 100)) {
    showToast('Enter a valid discount value.', 'error');
    $('#promotion-value').focus();
    return;
  }
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    showToast('The offer end time must be after the start time.', 'error');
    $('#promotion-ends').focus();
    return;
  }
  const appliesTo = idList(value('promotion-applies-to'));
  const bundleCardIds = idList(value('promotion-bundle-card-ids'));
  if ([...appliesTo, ...bundleCardIds].some(identifier => !/^[A-Za-z0-9-]{1,80}$/.test(identifier))) {
    showToast('Eligible and bundle card IDs may contain only letters, numbers and hyphens.', 'error');
    return;
  }
  const payload = {
    code,
    title: value('promotion-name').trim(),
    description: value('promotion-description').trim(),
    kind,
    discountType,
    discountValue,
    appliesTo,
    bundleCardIds,
    maxRedemptions: value('promotion-limit') ? numberValue('promotion-limit') : 0,
    billingInterval: value('promotion-billing-interval'),
    startsAt: startsAt ? new Date(startsAt).toISOString() : null,
    endsAt: endsAt ? new Date(endsAt).toISOString() : null,
    isActive: $('#promotion-active').checked
  };
  const editingId = state.editingPromotionId;
  $('#promotion-submit').disabled = true;
  try {
    await request(editingId ? `/api/admin/promotions/${encodeURIComponent(editingId)}` : '/api/admin/promotions', {
      method: editingId ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    showToast(editingId ? 'Promotion draft updated.' : 'Promotion draft saved. Checkout remains inactive.');
    resetPromotionForm();
    state.loadedViews.delete('promotions');
    await loadPromotions(true);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    $('#promotion-submit').disabled = false;
  }
}

async function changePromotion(id, action) {
  const promotion = state.promotions.find(item => String(firstValue(item, ['id', 'promotionId'], '')) === String(id));
  if (!promotion) return;
  if (action === 'edit') return editPromotion(id);
  if (action === 'delete' && !confirm('Delete this promotion draft? Historical transactions should be retained by the server.')) return;
  try {
    if (action === 'delete') {
      await request(`/api/admin/promotions/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast('Promotion draft deleted.');
    } else {
      const active = Boolean(firstValue(promotion, ['isActive', 'active'], false));
      await request(`/api/admin/promotions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ isActive: !active }) });
      showToast(active ? 'Promotion draft marked inactive.' : 'Promotion draft marked active. Checkout remains inactive.');
    }
    state.loadedViews.delete('promotions');
    await loadPromotions(true);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function feedbackStatus(report) { return String(firstValue(report, ['status', 'state'], 'open')).toLowerCase(); }

function updateFeedbackBadge(count, hasMore = false) {
  const badge = $('#feedback-badge');
  const numericCount = Number(count);
  if (!Number.isFinite(numericCount) || numericCount <= 0) {
    badge.hidden = true;
    return;
  }
  badge.textContent = hasMore || numericCount > 99 ? `${Math.min(numericCount, 99)}+` : String(numericCount);
  badge.hidden = false;
}

function renderFeedback() {
  const container = $('#feedback-content');
  const loadedCount = state.feedback.length;
  const items = state.feedback;
  if (!loadedCount) {
    container.innerHTML = '<p class="notice">No feedback reports match the current server filters.</p>';
    $('#feedback-note').textContent = 'No matching feedback reports were found.';
    return;
  }
  container.innerHTML = items.map(report => {
    const id = firstValue(report, ['id', 'feedbackId', 'reportId'], '');
    const reportStatus = feedbackStatus(report);
    const severity = String(firstValue(report, ['severity', 'priority'], 'normal')).toLowerCase();
    const subject = firstValue(report, ['subject', 'title', 'resourceTitle'], 'Student report');
    const message = firstValue(report, ['message', 'description', 'details'], 'No description was provided.');
    const reporter = firstValue(report, ['studentName', 'name', 'email'], 'Student');
    const resource = firstValue(report, ['resourceTitle', 'paperTitle', 'cardTitle'], null);
    const created = firstValue(report, ['createdAt', 'reportedAt', 'updatedAt'], null);
    const action = reportStatus === 'resolved' ? 'reopen' : 'resolve';
    const actionText = reportStatus === 'resolved' ? 'Reopen' : 'Mark resolved';
    return `<article class="feedback-card"><div class="feedback-card-heading"><div><div class="feedback-meta"><span class="status-pill status-${escapeHTML(reportStatus)}">${escapeHTML(statusLabel(reportStatus))}</span><span class="severity-pill severity-${escapeHTML(severity)}">${escapeHTML(statusLabel(severity))}</span></div><h3>${escapeHTML(subject)}</h3></div><small>${escapeHTML(formatDate(created))}</small></div><p>${escapeHTML(message)}</p><footer><span>${escapeHTML(reporter)}${resource ? ` · ${escapeHTML(resource)}` : ''}</span>${id ? `<button class="${reportStatus === 'resolved' ? 'secondary' : 'save'} small-button" type="button" data-feedback-action="${action}" data-feedback-id="${escapeHTML(id)}">${actionText}</button>` : ''}</footer></article>`;
  }).join('') + loadMoreMarkup('feedback', loadedCount, 'feedback reports');
  $('#feedback-note').textContent = `${loadedCount} matching feedback report${loadedCount === 1 ? '' : 's'} loaded from the server.${state.management.feedback.hasMore ? ' More matching feedback reports are available.' : ''}`;
}

async function loadFeedback(force = false, append = false) {
  const query = value('feedback-search').trim();
  const statusFilter = value('feedback-status-filter').trim();
  const filters = { q: query, status: statusFilter };
  const signature = JSON.stringify(filters);
  const entry = state.management.feedback;
  if (append && entry.signature !== signature) return loadFeedback(true);
  if (append && (!entry.hasMore || entry.request)) return;
  if (!append && !force && state.loadedViews.has('feedback') && entry.signature === signature) return;
  const offset = append ? entry.nextOffset : 0;
  const controller = beginManagementRequest('feedback');
  let shouldRender = false;
  let appendError = '';
  if (append) {
    renderFeedback();
    $('#feedback-note').textContent = `Loading more matching feedback reports after ${state.feedback.length} already loaded…`;
  } else {
    resetManagementPage('feedback', signature);
    state.feedback = [];
    state.loadedViews.delete('feedback');
    $('#feedback-content').innerHTML = loadingMessage('Loading feedback inbox…');
    $('#feedback-note').textContent = 'Loading student reports…';
  }
  try {
    const data = await optionalRequest(buildAdminListUrl('/api/admin/feedback', filters, offset), { signal: controller.signal });
    if (!managementRequestIsCurrent('feedback', controller)) return;
    if (!data) {
      if (append) {
        entry.hasMore = false;
        appendError = 'More reports are not available because the feedback service is not enabled.';
        shouldRender = true;
      } else {
        $('#feedback-content').innerHTML = unavailableMessage('Feedback inbox');
        $('#feedback-note').textContent = 'New student reports will appear here when the feedback endpoint is enabled.';
      }
      return;
    }
    const feedback = collectionFrom(data, ['feedback', 'reports', 'items']);
    state.feedback = append ? [...state.feedback, ...feedback] : feedback;
    applyManagementPage('feedback', data, offset, feedback.length);
    shouldRender = true;
    const openCount = state.feedback.filter(report => !['resolved', 'closed'].includes(feedbackStatus(report))).length;
    if (!query && !statusFilter) updateFeedbackBadge(openCount, entry.hasMore);
    state.loadedViews.add('feedback');
  } catch (error) {
    if (isAbortError(error)) return;
    if (!managementRequestIsCurrent('feedback', controller)) return;
    if (append) {
      appendError = `Could not load more feedback reports: ${error.message}`;
      shouldRender = true;
    } else {
      $('#feedback-content').innerHTML = `<p class="notice">${escapeHTML(error.message)}</p>`;
      $('#feedback-note').textContent = 'Feedback reports could not be loaded.';
    }
  } finally {
    if (managementRequestIsCurrent('feedback', controller)) {
      entry.request = null;
      if (shouldRender) {
        renderFeedback();
        if (appendError) $('#feedback-note').textContent = `${state.feedback.length} matching feedback report${state.feedback.length === 1 ? '' : 's'} loaded from the server. ${appendError}`;
      }
    }
  }
}

async function changeFeedback(id, action) {
  try {
    await request(`/api/admin/feedback/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status: action === 'resolve' ? 'resolved' : 'open', adminNote: action === 'resolve' ? 'Resolved by administrator' : 'Reopened by administrator' }) });
    showToast(action === 'resolve' ? 'Feedback report marked resolved.' : 'Feedback report reopened.');
    state.loadedViews.delete('feedback');
    state.loadedViews.delete('overview');
    await Promise.all([loadFeedback(true), loadDashboard(true)]);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderBulkResult(result) {
  const container = $('#bulk-result');
  if (!result || typeof result !== 'object') { container.innerHTML = ''; return; }
  const summary = [
    ['Validated', firstValue(result, ['validated', 'validatedCount'], null)],
    ['Created', firstValue(result, ['created', 'createdCount', 'count'], Array.isArray(result.cards) ? result.cards.length : null)],
    ['Updated', firstValue(result, ['updated', 'updatedCount'], null)],
    ['Skipped', firstValue(result, ['skipped', 'skippedCount'], null)]
  ].filter(([, count]) => count !== null && count !== undefined);
  const errors = collectionFrom(result, ['errors', 'issues']);
  container.innerHTML = `${summary.length ? `<div class="bulk-summary">${summary.map(([label, count]) => `<div><strong>${escapeHTML(String(count))}</strong><span>${escapeHTML(label)}</span></div>`).join('')}</div>` : ''}${errors.length ? `<details class="bulk-errors" open><summary>${errors.length} row issue${errors.length === 1 ? '' : 's'} need attention</summary><ul>${errors.slice(0, 30).map(issue => `<li>${escapeHTML(typeof issue === 'string' ? issue : firstValue(issue, ['message', 'error'], JSON.stringify(issue)))}</li>`).join('')}</ul></details>` : ''}`;
}

function downloadBulkTemplate() {
  const rows = [
    'filename,title,description,type,className,subject,sectionId,resourceLabel,isBundle,isPublished,sortOrder,metaTitle,metaDescription,seoKeywords,tags',
    'electricity-mcqs.pdf,"Electricity: 50 MCQs","Chapter practice with answers",mcq,10,Science,,Quick revision PDF,false,false,0,"Class 10 Electricity MCQs PDF","Practice Class 10 Science electricity MCQs with answers.","class 10 science,electricity mcqs","class 10,science,electricity,mcq,medium"'
  ];
  const blob = new Blob([`${rows.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'tks-solution-bulk-upload-template.csv';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
  showToast('CSV template downloaded.');
}

function bulkPreflightError(files, csv) {
  if (files.length > MAX_BULK_PDF_FILES) return `Choose no more than ${MAX_BULK_PDF_FILES} PDFs in one batch.`;
  if (csv.size > MAX_BULK_METADATA_BYTES) return 'The CSV metadata file must be smaller than 1 MB.';
  const names = new Set();
  for (const file of files) {
    if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf')) return `${file.name || 'A selected file'} is not a valid PDF.`;
    if (file.size < 5 || file.size > MAX_PDF_SIZE_BYTES) return `${file.name} must be between 5 bytes and 25 MB.`;
    if (names.has(file.name)) return `${file.name} was selected more than once.`;
    names.add(file.name);
  }
  const totalBytes = csv.size + files.reduce((total, file) => total + file.size, 0);
  if (totalBytes >= MAX_BULK_UPLOAD_BYTES) return 'Keep the PDFs and CSV below 90 MB in total.';
  return '';
}

async function submitBulkUpload(event) {
  event.preventDefault();
  const files = [...$('#bulk-pdfs').files];
  const csv = $('#bulk-csv').files[0];
  if (!files.length || !csv) {
    showToast('Choose at least one PDF and the matching CSV file.', 'error');
    return;
  }
  const preflightMessage = bulkPreflightError(files, csv);
  if (preflightMessage) {
    $('#bulk-status').textContent = preflightMessage;
    showToast(preflightMessage, 'error');
    return;
  }
  const payload = new FormData();
  files.forEach(file => payload.append('files', file));
  payload.append('metadata', csv);
  const submit = $('#bulk-submit');
  submit.disabled = true;
  $('#bulk-status').textContent = `Uploading ${files.length} PDF${files.length === 1 ? '' : 's'} for secure validation…`;
  $('#bulk-result').innerHTML = '';
  try {
    const result = await request('/api/admin/bulk', { method: 'POST', body: payload });
    renderBulkResult(result);
    const errors = collectionFrom(result, ['errors', 'issues']);
    $('#bulk-status').textContent = errors.length ? 'The batch was processed with issues. Review the details below.' : 'Batch created successfully. Each card used the isPublished value in its CSV row.';
    showToast(errors.length ? 'Batch processed with issues to review.' : 'Batch created successfully.', errors.length ? 'error' : 'success');
    if (!errors.length) {
      await Promise.allSettled([loadCards(), loadSections()]);
      state.loadedViews.delete('overview');
    }
  } catch (error) {
    const unavailable = [404, 405, 503].includes(error.status);
    const message = unavailable ? 'Bulk upload is unavailable until protected PDF storage is connected. No files or cards were created.' : error.message;
    $('#bulk-status').textContent = message;
    showToast(message, 'error');
  } finally {
    submit.disabled = false;
  }
}

function updateCurrentViewHash(view) {
  const expectedHash = `#${view}`;
  if (window.location.hash !== expectedHash) history.replaceState(null, '', expectedHash);
}

function showView(view, { focus = false, force = false, load = true } = {}) {
  if (!KNOWN_VIEWS.includes(view)) return;
  state.activeView = view;
  $$('.admin-view').forEach(panel => { panel.hidden = panel.id !== `${view}-view`; });
  $$('.admin-nav-item').forEach(button => {
    const selected = button.dataset.view === view;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  updateCurrentViewHash(view);
  if (focus) $(`#${view}-view`).focus({ preventScroll: true });
  if (!load) return;
  if (view === 'overview') loadDashboard(force);
  if (view === 'orders') loadOrders(force);
  if (view === 'students') loadStudents(force);
  if (view === 'promotions') loadPromotions(force);
  if (view === 'feedback') loadFeedback(force);
}

function handleAdminTabKeydown(event) {
  const tabs = $$('.admin-nav-item');
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  let nextIndex = -1;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
  if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = tabs.length - 1;
  if (nextIndex < 0) return;
  event.preventDefault();
  const next = tabs[nextIndex];
  next.focus();
  showView(next.dataset.view);
}

function scheduleManagementLoad(kind) {
  const timerKeys = { orders: 'orderSearchTimer', students: 'studentSearchTimer', feedback: 'feedbackSearchTimer' };
  const timerKey = timerKeys[kind];
  if (!timerKey) return;
  clearTimeout({ orderSearchTimer, studentSearchTimer, feedbackSearchTimer }[timerKey]);
  const run = () => {
    if (kind === 'orders') void loadOrders(true);
    if (kind === 'students') void loadStudents(true);
    if (kind === 'feedback') void loadFeedback(true);
  };
  if (timerKey === 'orderSearchTimer') orderSearchTimer = setTimeout(run, 300);
  if (timerKey === 'studentSearchTimer') studentSearchTimer = setTimeout(run, 300);
  if (timerKey === 'feedbackSearchTimer') feedbackSearchTimer = setTimeout(run, 300);
}

async function signOut() {
  try { await request('/api/admin/logout', { method: 'POST' }); }
  finally { showLogin(); showToast('Signed out.'); }
}

function showDashboard() {
  loginView.hidden = true;
  dashboard.hidden = false;
  $('#admin-session-label').hidden = false;
  $('#logout-top').hidden = false;
  const requestedView = window.location.hash.slice(1);
  showView(KNOWN_VIEWS.includes(requestedView) ? requestedView : 'overview', { load: false });
}

function showLogin() {
  dashboard.hidden = true;
  loginView.hidden = false;
  $('#password').value = '';
  $('#admin-session-label').hidden = true;
  $('#logout-top').hidden = true;
}

async function beginAuthenticatedSession() {
  showDashboard();
  const results = await Promise.allSettled([loadCards(), loadFiles(''), loadSections()]);
  const catalogFailure = results.find(result => result.status === 'rejected');
  if (catalogFailure) showToast('Some catalogue data could not be refreshed. You can retry from the content area.', 'error');
  renderCards();
  showView(state.activeView, { force: true });
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginStatus.textContent = 'Signing in…';
  try {
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: value('password') }) });
    await beginAuthenticatedSession();
    loginStatus.textContent = '';
    showToast('Signed in successfully.');
  } catch (error) {
    loginStatus.textContent = error.message;
    showToast(error.message, 'error');
  }
});

sectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const section = {
    parentId: value('section-parent') || null,
    title: value('section-title').trim(),
    description: value('section-description').trim(),
    icon: value('section-icon'),
    sortOrder: numberValue('section-order'),
    isPublished: $('#section-published').checked,
    showOnHome: $('#section-home').checked,
    metaTitle: value('section-meta-title').trim(),
    metaDescription: value('section-meta-description').trim(),
    seoKeywords: value('section-seo-keywords').trim(),
    tags: state.tags.section
  };
  const editing = Boolean(state.editingSectionId);
  try {
    await request(editing ? `/api/admin/sections/${encodeURIComponent(state.editingSectionId)}` : '/api/admin/sections', {
      method: editing ? 'PUT' : 'POST', body: JSON.stringify(section)
    });
    await loadSections();
    resetSectionForm();
    renderCards();
    showToast(editing ? 'Library section updated.' : 'Library section created.');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = 'Saving…';
  const card = {
    type: value('type'),
    className: value('className'),
    subject: value('subject'),
    title: value('title').trim(),
    description: value('description').trim(),
    fileKey: value('fileKey'),
    link: value('link').trim(),
    isBundle: $('#isBundle').checked,
    sectionId: value('card-section') || null,
    resourceLabel: value('resource-label').trim(),
    sortOrder: numberValue('sort-order'),
    isPublished: $('#is-published').checked,
    metaTitle: value('card-meta-title').trim(),
    metaDescription: value('card-meta-description').trim(),
    seoKeywords: value('card-seo-keywords').trim(),
    tags: state.tags.card
  };
  const editing = state.editingCardId;
  try {
    const result = await request(editing ? `/api/admin/cards/${encodeURIComponent(editing)}` : '/api/admin/cards', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(card) });
    if (editing) state.cards = state.cards.map(item => item.id === editing ? result.card : item);
    else state.cards.unshift(result.card);
    const savedCard = result.card;
    const message = !savedCard.isPublished
      ? 'Study card saved as a private draft.'
      : cardIsPublic(savedCard)
        ? (editing ? 'Study card updated for all visitors.' : 'Study card published for all visitors.')
        : 'Study card is marked published. Publish its parent section or tile to make it visible to students.';
    status.textContent = message;
    resetCardForm();
    renderCards();
    showToast(message);
    state.loadedViews.delete('overview');
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, 'error');
  }
});

$('#promotion-form').addEventListener('submit', savePromotion);
$('#bulk-form').addEventListener('submit', submitBulkUpload);
$('#download-bulk-template').addEventListener('click', downloadBulkTemplate);

$$('[data-logout]').forEach(button => button.addEventListener('click', signOut));
$$('.admin-nav-item').forEach(button => {
  button.addEventListener('click', () => showView(button.dataset.view, { focus: true }));
  button.addEventListener('keydown', handleAdminTabKeydown);
});
$$('[data-go-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.goView, { focus: true })));
$$('[data-refresh]').forEach(button => button.addEventListener('click', () => showView(button.dataset.refresh === 'dashboard' ? 'overview' : button.dataset.refresh, { force: true })));

$('#className').addEventListener('change', refreshSubjects);
sectionParent.addEventListener('change', syncHomeToggle);
$('#isBundle').addEventListener('change', syncFixedPrice);
$('#filter-cards').addEventListener('input', renderCards);
$('#order-search').addEventListener('input', () => scheduleManagementLoad('orders'));
$('#order-status-filter').addEventListener('change', () => scheduleManagementLoad('orders'));
$('#student-search').addEventListener('input', () => scheduleManagementLoad('students'));
$('#feedback-search').addEventListener('input', () => scheduleManagementLoad('feedback'));
$('#feedback-status-filter').addEventListener('change', () => scheduleManagementLoad('feedback'));
$('#cancel-edit').addEventListener('click', resetCardForm);
$('#section-cancel').addEventListener('click', resetSectionForm);
$('#promotion-cancel').addEventListener('click', resetPromotionForm);

$('#orders-content').addEventListener('click', event => {
  const button = event.target.closest('[data-order-action]');
  if (button) changeOrder(button.dataset.orderId, button.dataset.orderAction);
  const more = event.target.closest('[data-load-more="orders"]');
  if (more) loadMoreManagement('orders');
});
$('#students-content').addEventListener('click', event => {
  const button = event.target.closest('[data-student-action]');
  if (button) changeStudent(button.dataset.studentId, button.dataset.studentAction);
  const more = event.target.closest('[data-load-more="students"]');
  if (more) loadMoreManagement('students');
});
$('#promotions-content').addEventListener('click', event => {
  const button = event.target.closest('[data-promotion-action]');
  if (button) changePromotion(button.dataset.promotionId, button.dataset.promotionAction);
});
$('#feedback-content').addEventListener('click', event => {
  const button = event.target.closest('[data-feedback-action]');
  if (button) changeFeedback(button.dataset.feedbackId, button.dataset.feedbackAction);
  const more = event.target.closest('[data-load-more="feedback"]');
  if (more) loadMoreManagement('feedback');
});

$('#export-data').addEventListener('click', async () => {
  try {
    const data = await request('/api/admin/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'tks-solution-content-backup.json';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
    status.textContent = 'Backup exported.';
    showToast('Backup exported.');
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, 'error');
  }
});

$('#import-data').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const confirmed = window.confirm('Replace the full library with this backup? This permanently replaces every current study card and library section. Export a fresh backup first if you may need the current content.');
    if (!confirmed) {
      showToast('Import cancelled. Your library was not changed.');
      return;
    }
    const replacement = Array.isArray(data)
      ? { cards: data, confirmReplace: true }
      : { ...data, confirmReplace: true };
    const result = await request('/api/admin/import', { method: 'PUT', body: JSON.stringify(replacement) });
    await Promise.all([loadCards(), loadSections()]);
    status.textContent = `${result.count} study cards imported.`;
    showToast(`${result.count} study cards imported.`);
    state.loadedViews.delete('overview');
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message, 'error');
  }
  event.target.value = '';
});

uploadInput.addEventListener('change', () => {
  const file = uploadInput.files[0];
  uploadName.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB selected` : 'Maximum file size: 25 MB.';
});

uploadButton.addEventListener('click', async () => {
  const file = uploadInput.files[0];
  if (!file) return showToast('Choose a PDF file first.', 'error');
  if (!/\.pdf$/i.test(file.name) || file.size > 25 * 1024 * 1024) return showToast('Choose a PDF smaller than 25 MB.', 'error');
  uploadButton.disabled = true;
  uploadButton.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/admin/files', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/pdf', 'X-Upload-Filename': encodeURIComponent(file.name) },
      body: file,
      credentials: 'same-origin'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The PDF could not be uploaded.');
    await loadFiles(result.file);
    $('#fileKey').value = result.file;
    uploadInput.value = '';
    uploadName.textContent = 'Maximum file size: 25 MB.';
    showToast('Protected PDF uploaded successfully.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = 'Upload selected PDF';
  }
});

async function removePdf(filename) {
  if (!confirm(`Remove ${filename}? This cannot be undone.`)) return;
  try {
    await request(`/api/admin/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    await loadFiles('');
    showToast('Protected PDF removed.');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

window.addEventListener('hashchange', () => {
  const requestedView = window.location.hash.slice(1);
  if (!dashboard.hidden && KNOWN_VIEWS.includes(requestedView) && requestedView !== state.activeView) showView(requestedView);
});

wireTagInput('card');
wireTagInput('section');
refreshSubjects();
syncFixedPrice();
clarifyPromotionDraftMode();
clarifyLiveAdminCopy();
setTags('card', []);
setTags('section', []);

request('/api/admin/session').then(async data => {
  if (data.authenticated) await beginAuthenticatedSession();
  else showLogin();
}).catch(() => {
  showLogin();
  loginStatus.textContent = "Start the TK's SOLUTION server to use the admin dashboard.";
});
