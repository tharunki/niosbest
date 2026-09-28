/*
 * Public Resource Hub catalogue.
 *
 * Product IDs deliberately mirror the server catalogue in resource-store.mjs.
 * The checkout page verifies the product, price, current login and ownership on
 * the server; this page only makes the catalogue easy to browse.
 */
(() => {
  const searchField = document.querySelector('#search');
  const sectionsRoot = document.querySelector('#resourceSections');
  const resultCount = document.querySelector('#found');
  const boardButtons = [...document.querySelectorAll('[data-filter]')];

  if (!searchField || !sectionsRoot || !resultCount) return;

  const subjectsByClass = {
    '10': ['Hindi', 'English', 'Mathematics', 'Science', 'Social Science', 'Data Entry Operations'],
    '12': ['Hindi', 'English', 'Mathematics', 'Physics', 'Chemistry', 'Biology', 'Economics', 'Business Studies', 'Accountancy', 'History', 'Geography', 'Political Science', 'Data Entry Operations']
  };

  const sections = [
    {
      id: 'tma',
      title: 'SOLVED TMA',
      singular: 'Solved TMA',
      description: 'Subject-wise solved Tutor Marked Assignments for guided preparation.',
      price: 249
    },
    {
      id: 'study',
      title: 'Study material',
      singular: 'Study material',
      description: 'Focused study material for concepts, revision and exam readiness.',
      price: 499
    },
    {
      id: 'pyq',
      title: 'PYQs',
      singular: 'PYQs',
      description: 'Previous-year question paper practice arranged by subject.',
      price: 399
    }
  ];

  let activeBoard = 'All';
  let renderFrame = 0;

  const slug = value => value.toLowerCase().replaceAll(' ', '-');
  const availableBoard = () => activeBoard === 'All' || activeBoard === 'NIOS';
  const boardDisplayName = () => activeBoard === 'CBSE' ? 'CBSE Private' : activeBoard;

  function catalogueSection(section) {
    return `
      <section class="resource-section glass" data-kind="${section.id}" aria-labelledby="${section.id}Heading">
        <div class="resource-section__header">
          <div>
            <h2 class="resource-section__heading" id="${section.id}Heading">${section.title}</h2>
            <p class="resource-section__copy">${section.description}</p>
          </div>
          <label class="class-control" for="${section.id}Class"><span>Choose class</span><select id="${section.id}Class" name="${section.id}Class"><option value="10">Class 10</option><option value="12">Class 12</option></select></label>
        </div>
        <div class="resource-cards" id="${section.id}List" aria-live="polite"></div>
      </section>`;
  }

  function resourceCard(section, level, subject) {
    const productId = `${section.id}-${level}-${slug(subject)}`;
    const title = `Class ${level} ${subject} ${section.singular}`;
    const href = `/resource-checkout.html?product=${encodeURIComponent(productId)}`;
    return `
      <article class="resource-card">
        <span class="resource-card__tag">NIOS · Class ${level}</span>
        <h3>${title}</h3>
        <p>Single-subject PDF. Sign in and pay only for this resource.</p>
        <div class="resource-card__footer">
          <span class="resource-price">₹${section.price}</span>
          <a class="resource-action" href="${href}" aria-label="Buy ${title} for ₹${section.price}">View &amp; buy →</a>
        </div>
      </article>`;
  }

  function emptyState() {
    if (availableBoard()) return 'No NIOS PDFs match this search. Clear the search or choose another class.';
    return `${boardDisplayName()} resources are being prepared. Choose NIOS to browse the current resource catalogue.`;
  }

  function render() {
    const query = searchField.value.trim().toLocaleLowerCase('en-IN');
    let total = 0;

    for (const section of sections) {
      const classSelect = document.querySelector(`#${section.id}Class`);
      const list = document.querySelector(`#${section.id}List`);
      if (!classSelect || !list) continue;

      const level = classSelect.value;
      const matches = availableBoard()
        ? subjectsByClass[level].filter(subject => `${section.title} ${section.singular} NIOS Class ${level} ${subject}`.toLocaleLowerCase('en-IN').includes(query))
        : [];
      total += matches.length;
      list.innerHTML = matches.length
        ? matches.map(subject => resourceCard(section, level, subject)).join('')
        : `<p class="resource-empty">${emptyState()}</p>`;
    }

    resultCount.textContent = String(total);
  }

  function scheduleRender() {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render();
    });
  }

  sectionsRoot.innerHTML = sections.map(catalogueSection).join('');
  searchField.addEventListener('input', scheduleRender);
  sectionsRoot.querySelectorAll('select').forEach(select => select.addEventListener('change', scheduleRender));
  boardButtons.forEach(button => button.addEventListener('click', () => {
    activeBoard = button.dataset.filter || 'All';
    boardButtons.forEach(candidate => {
      const selected = candidate === button;
      candidate.classList.toggle('active', selected);
      candidate.setAttribute('aria-pressed', String(selected));
    });
    scheduleRender();
  }));

  render();
})();
