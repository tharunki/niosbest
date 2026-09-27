const subjectOptions = {
  10:['Science','Mathematics','Social Science','English','Tamil'],
  11:['Physics','Chemistry','Biology','Mathematics','English','Computer Science'],
  12:['Physics','Chemistry','Biology','Mathematics','English','Computer Science']
};
const INDIVIDUAL_CARD_PRICE = '39';
const FULL_COURSE_BUNDLE_PRICE = '399';
let cards = [], sections = [], editingId = null, editingSectionId = null, toastTimer;
const loginView = document.querySelector('#login-view');
const dashboard = document.querySelector('#dashboard');
const loginForm = document.querySelector('#login-form');
const form = document.querySelector('#card-form');
const list = document.querySelector('#cards');
const status = document.querySelector('#status');
const loginStatus = document.querySelector('#login-status');
const toast = document.querySelector('#toast');
const uploadInput = document.querySelector('#upload-pdf');
const uploadButton = document.querySelector('#upload-button');
const uploadName = document.querySelector('#upload-name');
const fileList = document.querySelector('#pdf-files');
const sectionForm = document.querySelector('#section-form');
const sectionList = document.querySelector('#section-list');
const sectionParent = document.querySelector('#section-parent');
const cardSection = document.querySelector('#card-section');

function escapeHTML(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }
function value(id) { return document.querySelector(`#${id}`).value; }
function numberValue(id, fallback = 0) { const number = Number(value(id)); return Number.isSafeInteger(number) ? number : fallback; }
function syncFixedPrice() {
  const isBundle = document.querySelector('#isBundle').checked;
  document.querySelector('#price').value = isBundle ? FULL_COURSE_BUNDLE_PRICE : INDIVIDUAL_CARD_PRICE;
  document.querySelector('#price-helper').textContent = isBundle
    ? 'Full-course bundles are always ₹399. The server checks this again before saving.'
    : 'Individual study cards are always ₹39. The server checks this again before saving.';
}
function showToast(message, kind = 'success') { clearTimeout(toastTimer); toast.textContent = message; toast.classList.toggle('error', kind === 'error'); toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3200); }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function roots() { return sections.filter(section => !section.parentId); }
function childrenOf(parentId) { return sections.filter(section => section.parentId === parentId); }
function sectionPath(sectionId) {
  const section = sections.find(item => item.id === sectionId);
  if (!section) return 'Library placement unavailable';
  const parent = section.parentId ? sections.find(item => item.id === section.parentId) : null;
  return parent ? `${parent.title} → ${section.title}` : section.title;
}
function syncHomeToggle() {
  const isTile = Boolean(sectionParent.value);
  const toggle = document.querySelector('#section-home');
  toggle.disabled = isTile;
  if (isTile) toggle.checked = false;
  document.querySelector('#section-home-helper').textContent = isTile
    ? 'Only top-level sections can be featured on the homepage.'
    : 'Feature this top-level section on the homepage.';
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
    const item = section => `<div class="section-row${section.parentId ? ' section-child' : ''}"><div class="section-icon" aria-hidden="true">${escapeHTML(section.icon || '📚')}</div><div class="section-details"><strong>${escapeHTML(section.title)}</strong><span>${escapeHTML(section.description || (section.parentId ? 'Library tile' : 'Top-level library section'))}</span><small>${section.isPublished ? 'Published' : 'Draft'} · Order ${escapeHTML(section.sortOrder)}</small></div><div class="section-actions"><button class="secondary edit-section" type="button" data-id="${escapeHTML(section.id)}">Edit</button><button class="remove delete-section" type="button" data-id="${escapeHTML(section.id)}">Remove</button></div></div>`;
    return `<div class="section-group">${item(root)}${childrenOf(root.id).map(item).join('')}</div>`;
  }).join('');
  sectionList.querySelectorAll('.edit-section').forEach(button => button.addEventListener('click', () => editSection(button.dataset.id)));
  sectionList.querySelectorAll('.delete-section').forEach(button => button.addEventListener('click', () => removeSection(button.dataset.id)));
}
async function loadSections() {
  const data = await request('/api/admin/sections');
  sections = Array.isArray(data.sections) ? data.sections : [];
  refreshCatalogOptions();
  renderSections();
  if (cards.length) render();
}
function resetSectionForm() {
  editingSectionId = null;
  sectionForm.reset();
  document.querySelector('#section-id').value = '';
  document.querySelector('#section-published').checked = true;
  document.querySelector('#section-home').checked = false;
  document.querySelector('#section-order').value = '0';
  document.querySelector('#section-form-heading').textContent = 'Create a section or tile';
  document.querySelector('#section-submit').textContent = 'Create section';
  document.querySelector('#section-cancel').hidden = true;
  refreshCatalogOptions('');
}
function editSection(id) {
  const section = sections.find(item => item.id === id);
  if (!section) return;
  editingSectionId = id;
  document.querySelector('#section-id').value = section.id;
  refreshCatalogOptions();
  sectionParent.value = section.parentId || '';
  document.querySelector('#section-title').value = section.title || '';
  document.querySelector('#section-description').value = section.description || '';
  if ([...document.querySelector('#section-icon').options].some(option => option.value === section.icon)) document.querySelector('#section-icon').value = section.icon;
  document.querySelector('#section-order').value = String(section.sortOrder || 0);
  document.querySelector('#section-published').checked = Boolean(section.isPublished);
  document.querySelector('#section-home').checked = Boolean(section.showOnHome);
  syncHomeToggle();
  document.querySelector('#section-form-heading').textContent = section.parentId ? 'Edit library tile' : 'Edit library section';
  document.querySelector('#section-submit').textContent = 'Save changes';
  document.querySelector('#section-cancel').hidden = false;
  sectionForm.scrollIntoView({ behavior:'smooth', block:'start' });
}
async function removeSection(id) {
  const section = sections.find(item => item.id === id);
  if (!section || !confirm(`Remove “${section.title}”? Remove or move its tiles and study cards first.`)) return;
  try {
    await request(`/api/admin/sections/${encodeURIComponent(id)}`, { method:'DELETE' });
    await loadSections();
    resetSectionForm();
    showToast('Library section removed.');
  } catch (error) { showToast(error.message, 'error'); }
}
function renderFiles(files = []) {
  if (!fileList) return;
  fileList.innerHTML = files.length ? files.map(file => `<div class="pdf-file"><span>${escapeHTML(file)}</span><button class="remove delete-file" type="button" data-file="${escapeHTML(file)}">Remove</button></div>`).join('') : '<p class="notice">No protected PDFs have been uploaded yet.</p>';
  fileList.querySelectorAll('.delete-file').forEach(button => button.addEventListener('click', () => removePdf(button.dataset.file)));
}
function refreshSubjects() {
  const subject = document.querySelector('#subject'); const current = subject.value;
  const subjects = subjectOptions[value('className')] || subjectOptions[10];
  document.querySelector('#subject-suggestions').innerHTML = subjects.map(option => `<option value="${escapeHTML(option)}"></option>`).join('');
  if (!current) subject.value = subjects[0];
}
async function loadFiles(selected = value('fileKey')) {
  const select = document.querySelector('#fileKey');
  try {
    const data = await request('/api/admin/files');
    const files = Array.isArray(data.files) ? data.files : [];
    select.innerHTML = `<option value="">Not ready for sale yet</option>${files.map(file => `<option value="${escapeHTML(file)}">${escapeHTML(file)}</option>`).join('')}`;
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    renderFiles(files);
  } catch { select.innerHTML = '<option value="">No protected PDFs found</option>'; renderFiles([]); }
}
function resetForm() {
  editingId = null;
  form.reset();
  document.querySelector('#is-published').checked = true;
  document.querySelector('#sort-order').value = '0';
  syncFixedPrice();
  document.querySelector('#form-heading').textContent = 'New study card';
  document.querySelector('#cancel-edit').hidden = true;
  refreshSubjects();
  refreshCatalogOptions('');
  loadFiles('');
}
function showDashboard() { loginView.hidden = true; dashboard.hidden = false; }
function showLogin() { dashboard.hidden = true; loginView.hidden = false; document.querySelector('#password').value = ''; }
function render() {
  const query = value('filter-cards').trim().toLowerCase();
  const items = cards.filter(card => !query || `${card.title} ${card.className} ${card.subject} ${card.type} ${card.resourceLabel || ''} ${sectionPath(card.sectionId)}`.toLowerCase().includes(query));
  list.innerHTML = items.length ? items.map(card => {
    const location = card.sectionId ? `Library: ${sectionPath(card.sectionId)}` : `Legacy: Class ${card.className} · ${card.type}`;
    const state = card.isPublished ? 'Published' : 'Draft';
    return `<article class="card"><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(location)} · ${escapeHTML(card.subject)} · ₹${escapeHTML(card.price)}${card.isBundle ? ' · Full bundle' : ''}</p><footer><span>${escapeHTML(state)} · ${card.fileKey ? 'Protected PDF linked' : card.link ? 'Preview linked' : 'File pending'}</span><span><button class="secondary edit" type="button" data-id="${escapeHTML(card.id)}">Edit</button> <button class="remove delete" type="button" data-id="${escapeHTML(card.id)}">Remove</button></span></footer></article>`;
  }).join('') : `<p class="notice">${query ? 'No cards match your search.' : 'No study cards added yet.'}</p>`;
  list.querySelectorAll('.edit').forEach(button => button.addEventListener('click', () => editCard(button.dataset.id)));
  list.querySelectorAll('.delete').forEach(button => button.addEventListener('click', () => removeCard(button.dataset.id)));
}
async function loadCards() { const data = await request('/api/admin/cards'); cards = data.cards || []; render(); }
async function editCard(id) {
  const card = cards.find(item => item.id === id); if (!card) return; editingId = card.id;
  document.querySelector('#type').value = card.type; document.querySelector('#className').value = card.className; refreshSubjects();
  ['subject','title','description','link'].forEach(field => { document.querySelector(`#${field}`).value = card[field] || ''; });
  refreshCatalogOptions(card.sectionId || '');
  document.querySelector('#resource-label').value = card.resourceLabel || '';
  document.querySelector('#sort-order').value = String(card.sortOrder || 0);
  document.querySelector('#is-published').checked = Boolean(card.isPublished);
  document.querySelector('#isBundle').checked = Boolean(card.isBundle); syncFixedPrice();
  await loadFiles(card.fileKey || ''); document.querySelector('#form-heading').textContent = 'Edit study card'; document.querySelector('#cancel-edit').hidden = false; window.scrollTo({ top:0, behavior:'smooth' });
}
async function removeCard(id) {
  if (!confirm('Remove this study card?')) return;
  try { await request(`/api/admin/cards/${encodeURIComponent(id)}`, { method:'DELETE' }); cards = cards.filter(card => card.id !== id); render(); status.textContent = 'Study card removed.'; showToast('Study card removed.'); }
  catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault(); loginStatus.textContent = 'Signing in…';
  try { await request('/api/admin/login', { method:'POST', body:JSON.stringify({ password:value('password') }) }); showDashboard(); await Promise.all([loadCards(), loadFiles(''), loadSections()]); loginStatus.textContent = ''; showToast('Signed in successfully.'); }
  catch (error) { loginStatus.textContent = error.message; showToast(error.message, 'error'); }
});
sectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const section = {
    parentId: value('section-parent') || null,
    title: value('section-title').trim(),
    description: value('section-description').trim(),
    icon: value('section-icon'),
    sortOrder: numberValue('section-order'),
    isPublished: document.querySelector('#section-published').checked,
    showOnHome: document.querySelector('#section-home').checked
  };
  const isEditing = Boolean(editingSectionId);
  try {
    await request(isEditing ? `/api/admin/sections/${encodeURIComponent(editingSectionId)}` : '/api/admin/sections', {
      method: isEditing ? 'PUT' : 'POST', body: JSON.stringify(section)
    });
    await loadSections();
    resetSectionForm();
    render();
    showToast(isEditing ? 'Library section updated.' : 'Library section created.');
  } catch (error) { showToast(error.message, 'error'); }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); status.textContent = 'Saving…';
  // Price is intentionally absent: the server derives ₹39 or ₹399 from isBundle.
  const card = {
    type:value('type'), className:value('className'), subject:value('subject'), title:value('title').trim(),
    description:value('description').trim(), fileKey:value('fileKey'), link:value('link').trim(),
    isBundle:document.querySelector('#isBundle').checked, sectionId:value('card-section') || null,
    resourceLabel:value('resource-label').trim(), sortOrder:numberValue('sort-order'),
    isPublished:document.querySelector('#is-published').checked
  };
  try {
    const result = await request(editingId ? `/api/admin/cards/${encodeURIComponent(editingId)}` : '/api/admin/cards', { method:editingId ? 'PUT' : 'POST', body:JSON.stringify(card) });
    if (editingId) cards = cards.map(item => item.id === editingId ? result.card : item); else cards.unshift(result.card);
    const message = card.isPublished ? (editingId ? 'Study card updated for all visitors.' : 'Study card published for all visitors.') : 'Study card saved as a private draft.';
    status.textContent = message; resetForm(); render(); showToast(message);
  } catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
});
document.querySelector('#logout').addEventListener('click', async () => { try { await request('/api/admin/logout', { method:'POST' }); } finally { showLogin(); showToast('Signed out.'); } });
document.querySelector('#className').addEventListener('change', refreshSubjects);
sectionParent.addEventListener('change', syncHomeToggle);
document.querySelector('#isBundle').addEventListener('change', syncFixedPrice);
document.querySelector('#filter-cards').addEventListener('input', render);
document.querySelector('#cancel-edit').addEventListener('click', resetForm);
document.querySelector('#section-cancel').addEventListener('click', resetSectionForm);
document.querySelector('#export-data').addEventListener('click', async () => {
  try {
    const data = await request('/api/admin/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'best-education-content-backup.json'; link.click(); URL.revokeObjectURL(link.href); status.textContent = 'Backup exported.'; showToast('Backup exported.');
  } catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
});
document.querySelector('#import-data').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { const data = JSON.parse(await file.text()); const result = await request('/api/admin/import', { method:'PUT', body:JSON.stringify(data) }); await Promise.all([loadCards(), loadSections()]); status.textContent = `${result.count} study cards imported.`; showToast(`${result.count} study cards imported.`); }
  catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
  event.target.value = '';
});
uploadInput.addEventListener('change', () => { const file = uploadInput.files[0]; uploadName.textContent = file ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB selected` : 'Maximum file size: 25 MB.'; });
uploadButton.addEventListener('click', async () => {
  const file = uploadInput.files[0];
  if (!file) return showToast('Choose a PDF file first.', 'error');
  if (!/\.pdf$/i.test(file.name) || file.size > 25 * 1024 * 1024) return showToast('Choose a PDF smaller than 25 MB.', 'error');
  uploadButton.disabled = true; uploadButton.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/admin/files', { method:'POST', headers:{ Accept:'application/json', 'Content-Type':'application/pdf', 'X-Upload-Filename':encodeURIComponent(file.name) }, body:file });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'The PDF could not be uploaded.');
    await loadFiles(result.file); document.querySelector('#fileKey').value = result.file; uploadInput.value = ''; uploadName.textContent = 'Maximum file size: 25 MB.'; showToast('Protected PDF uploaded successfully.');
  } catch (error) { showToast(error.message, 'error'); }
  finally { uploadButton.disabled = false; uploadButton.textContent = 'Upload selected PDF'; }
});
async function removePdf(filename) {
  if (!confirm(`Remove ${filename}? This cannot be undone.`)) return;
  try { await request(`/api/admin/files/${encodeURIComponent(filename)}`, { method:'DELETE' }); await loadFiles(''); showToast('Protected PDF removed.'); }
  catch (error) { showToast(error.message, 'error'); }
}
refreshSubjects();
syncFixedPrice();
request('/api/admin/session').then(async data => { if (data.authenticated) { showDashboard(); await Promise.all([loadCards(), loadFiles(''), loadSections()]); } else showLogin(); }).catch(() => { showLogin(); loginStatus.textContent = 'Start the Best Education server to use the admin dashboard.'; });
