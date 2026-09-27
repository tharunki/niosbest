// Public catalogue navigation; protected files remain behind Student Desk authorization.
const searchField = document.querySelector('#search');
const foundStatus = document.querySelector('.found');
searchField.setAttribute('aria-label', 'Search resources');
foundStatus.innerHTML = '<b id="found">0</b> matching resources';
const subjectCatalogue = {
  '10': ['Hindi', 'English', 'Mathematics', 'Science', 'Social Science', 'Data Entry Operations'],
  '12': ['Hindi', 'English', 'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Economics', 'Business Studies', 'Accountancy', 'History', 'Geography', 'Political Science', 'Data Entry Operations']
};
const resourceSections = [['tma', 'SOLVED TMA', 'Solved TMA'], ['study', 'Study material', 'Study material'], ['pyq', 'PYQs', 'PYQs']];
document.querySelector('#resourceSections').innerHTML = resourceSections.map(([id, title]) =>
  `<section style="margin-bottom:32px" aria-labelledby="${id}Heading"><h2 class="section-title" id="${id}Heading">${title}</h2><label for="${id}Class">Choose class</label> <select id="${id}Class" style="margin:12px 0;padding:8px;border-radius:8px;background:#252154;color:white"><option value="10">Class 10</option><option value="12">Class 12</option></select><div class="feed" id="${id}List"></div></section>`
).join('');
function render() {
  const query = searchField.value.trim().toLowerCase();
  let count = 0;
  for (const [id, , kind] of resourceSections) {
    const level = document.getElementById(id + 'Class').value;
    const matches = subjectCatalogue[level].filter(subject =>
      (active === 'All' || active === 'NIOS') && ('NIOS Class ' + level + ' ' + subject + ' ' + kind).toLowerCase().includes(query));
    count += matches.length;
    const list = document.getElementById(id + 'List');
    const fragment = document.createDocumentFragment();
    for (const subject of matches) {
      const card = document.createElement('article'); card.className = 'resource glass';
      const heading = document.createElement('h3'); heading.textContent = 'Class ' + level + ' ' + subject + ' ' + kind;
      const price = {tma:249,study:499,pyq:399}[id];
      const copy = document.createElement('p'); copy.textContent = 'NIOS · Class ' + level + ' · ₹' + price + ' per subject PDF';
      const link = document.createElement('a'); link.className = 'resource-action'; link.style.display = 'block';
      link.href = '/resource-checkout.html?product='+encodeURIComponent(id+'-'+level+'-'+subject.toLowerCase().replaceAll(' ','-')); link.textContent = 'Buy PDF · ₹'+price+' →';
      link.setAttribute('aria-label', 'Buy Class ' + level + ' ' + subject + ' ' + kind + ' for ₹' + price);
      card.append(heading, copy, link); fragment.append(card);
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.textContent = 'No resources match this board, class and search.'; fragment.append(empty); }
    list.replaceChildren(fragment);
  }
  document.querySelector('#found').textContent = count;
};
document.querySelectorAll('#resourceSections select').forEach(select => select.addEventListener('change', scheduleResourceRender));
document.querySelectorAll('.download button').forEach(button => button.setAttribute('aria-label', 'Download ' + button.closest('.download').querySelector('b').textContent));
render();
