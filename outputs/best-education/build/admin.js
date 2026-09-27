const subjectOptions = {
  10:['Science','Mathematics','Social Science','English','Tamil'],
  11:['Physics','Chemistry','Biology','Mathematics','English','Computer Science'],
  12:['Physics','Chemistry','Biology','Mathematics','English','Computer Science']
};
let cards = [], editingId = null, toastTimer;
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

function escapeHTML(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]); }
function value(id) { return document.querySelector(`#${id}`).value; }
function showToast(message, kind = 'success') { clearTimeout(toastTimer); toast.textContent = message; toast.classList.toggle('error', kind === 'error'); toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 3200); }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers:{ Accept:'application/json', ...(options.body ? { 'Content-Type':'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}
function renderFiles(files = []) {
  if (!fileList) return;
  fileList.innerHTML = files.length ? files.map(file => `<div class="pdf-file"><span>${escapeHTML(file)}</span><button class="remove delete-file" type="button" data-file="${escapeHTML(file)}">Remove</button></div>`).join('') : '<p class="notice">No protected PDFs have been uploaded yet.</p>';
  fileList.querySelectorAll('.delete-file').forEach(button => button.addEventListener('click', () => removePdf(button.dataset.file)));
}
function refreshSubjects() {
  const select = document.querySelector('#subject'); const current = select.value;
  select.innerHTML = subjectOptions[value('className')].map(subject => `<option>${escapeHTML(subject)}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
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
function resetForm() { editingId = null; form.reset(); document.querySelector('#price').value = '39'; document.querySelector('#form-heading').textContent = 'New study card'; document.querySelector('#cancel-edit').hidden = true; refreshSubjects(); loadFiles(''); }
function showDashboard() { loginView.hidden = true; dashboard.hidden = false; }
function showLogin() { dashboard.hidden = true; loginView.hidden = false; document.querySelector('#password').value = ''; }
function render() {
  const query = value('filter-cards').trim().toLowerCase();
  const items = cards.filter(card => !query || `${card.title} ${card.className} ${card.subject} ${card.type}`.toLowerCase().includes(query));
  list.innerHTML = items.length ? items.map(card => `<article class="card"><h3>${escapeHTML(card.title)}</h3><p>${escapeHTML(card.type)} · Class ${escapeHTML(card.className)} · ${escapeHTML(card.subject)} · ₹${escapeHTML(card.price)}${card.isBundle ? ' · Full bundle' : ''}</p><footer><span>${card.fileKey ? 'Protected PDF linked' : card.link ? 'Preview linked' : 'File pending'}</span><span><button class="secondary edit" type="button" data-id="${escapeHTML(card.id)}">Edit</button> <button class="remove delete" type="button" data-id="${escapeHTML(card.id)}">Remove</button></span></footer></article>`).join('') : `<p class="notice">${query ? 'No cards match your search.' : 'No study cards added yet.'}</p>`;
  list.querySelectorAll('.edit').forEach(button => button.addEventListener('click', () => editCard(button.dataset.id)));
  list.querySelectorAll('.delete').forEach(button => button.addEventListener('click', () => removeCard(button.dataset.id)));
}
async function loadCards() { const data = await request('/api/admin/cards'); cards = data.cards || []; render(); }
async function editCard(id) {
  const card = cards.find(item => item.id === id); if (!card) return; editingId = card.id;
  document.querySelector('#type').value = card.type; document.querySelector('#className').value = card.className; refreshSubjects();
  ['subject','title','description','price','link'].forEach(field => { document.querySelector(`#${field}`).value = card[field] || ''; }); document.querySelector('#isBundle').checked = Boolean(card.isBundle);
  await loadFiles(card.fileKey || ''); document.querySelector('#form-heading').textContent = 'Edit study card'; document.querySelector('#cancel-edit').hidden = false; window.scrollTo({ top:0, behavior:'smooth' });
}
async function removeCard(id) {
  if (!confirm('Remove this study card?')) return;
  try { await request(`/api/admin/cards/${encodeURIComponent(id)}`, { method:'DELETE' }); cards = cards.filter(card => card.id !== id); render(); status.textContent = 'Study card removed.'; showToast('Study card removed.'); }
  catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault(); loginStatus.textContent = 'Signing in…';
  try { await request('/api/admin/login', { method:'POST', body:JSON.stringify({ password:value('password') }) }); showDashboard(); await Promise.all([loadCards(), loadFiles('')]); loginStatus.textContent = ''; showToast('Signed in successfully.'); }
  catch (error) { loginStatus.textContent = error.message; showToast(error.message, 'error'); }
});
form.addEventListener('submit', async event => {
  event.preventDefault(); status.textContent = 'Saving…';
  const card = { type:value('type'), className:value('className'), subject:value('subject'), title:value('title').trim(), description:value('description').trim(), price:value('price'), fileKey:value('fileKey'), link:value('link').trim(), isBundle:document.querySelector('#isBundle').checked };
  try {
    const result = await request(editingId ? `/api/admin/cards/${encodeURIComponent(editingId)}` : '/api/admin/cards', { method:editingId ? 'PUT' : 'POST', body:JSON.stringify(card) });
    if (editingId) cards = cards.map(item => item.id === editingId ? result.card : item); else cards.unshift(result.card);
    const message = editingId ? 'Study card updated for all visitors.' : 'Study card published for all visitors.'; status.textContent = message; resetForm(); render(); showToast(message);
  } catch (error) { status.textContent = error.message; showToast(error.message, 'error'); }
});
document.querySelector('#logout').addEventListener('click', async () => { try { await request('/api/admin/logout', { method:'POST' }); } finally { showLogin(); showToast('Signed out.'); } });
document.querySelector('#className').addEventListener('change', refreshSubjects);
document.querySelector('#isBundle').addEventListener('change', event => { const price = document.querySelector('#price'); if (event.target.checked && price.value === '39') price.value = '399'; if (!event.target.checked && price.value === '399') price.value = '39'; });
document.querySelector('#filter-cards').addEventListener('input', render);
document.querySelector('#cancel-edit').addEventListener('click', resetForm);
document.querySelector('#export-data').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version:3, exportedAt:new Date().toISOString(), cards }, null, 2)], { type:'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'best-education-content-backup.json'; link.click(); URL.revokeObjectURL(link.href); status.textContent = 'Backup exported.'; showToast('Backup exported.');
});
document.querySelector('#import-data').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try { const data = JSON.parse(await file.text()); const result = await request('/api/admin/import', { method:'PUT', body:JSON.stringify(data) }); await loadCards(); status.textContent = `${result.count} cards imported and published.`; showToast(`${result.count} cards imported and published.`); }
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
request('/api/admin/session').then(async data => { if (data.authenticated) { showDashboard(); await Promise.all([loadCards(), loadFiles('')]); } else showLogin(); }).catch(() => { showLogin(); loginStatus.textContent = 'Start the Best Education server to use the admin dashboard.'; });
