(() => {
  // A standalone PDF purchase must never inherit an old course-enrolment
  // draft. The resource checkout has its own post-sign-in route.
  const resource = new URLSearchParams(location.search).get('resource');
  if (/^(tma|study|pyq)-(10|12)-[a-z-]+$/.test(resource || '')) {
    localStorage.removeItem('niosEnrollIntent');
    document.querySelectorAll('.intent').forEach(item => {
      item.textContent = '';
      item.classList.remove('show');
    });
  }
  const style = document.createElement('style');
  style.textContent = '.password-control{position:relative}.password-control input{padding-right:52px!important}.password-eye{position:absolute;right:3px;top:50%;transform:translateY(-50%);width:44px;height:44px;display:grid;place-items:center;background:transparent;border:0;border-radius:8px;color:#c7bdff;cursor:pointer}.password-eye:hover{background:rgba(137,119,255,.15)}.password-eye:focus-visible{outline:2px solid #b6acff;outline-offset:1px}.password-eye svg{width:21px;height:21px;pointer-events:none}';
  document.head.append(style);
  document.querySelectorAll('input[type="password"]').forEach((input, index) => {
    if (input.closest('.password-control')) return;
    if (!input.id) input.id = 'password-field-' + index;
    const wrapper = document.createElement('div');
    wrapper.className = 'password-control';
    input.before(wrapper);
    wrapper.append(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'password-eye';
    button.setAttribute('aria-controls', input.id);
    const update = visible => {
      input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      button.title = visible ? 'Hide password' : 'Show password';
      button.setAttribute('aria-pressed', String(visible));
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>' + (visible ? '<path d="m3 3 18 18"/>' : '') + '</svg>';
    };
    update(false);
    button.addEventListener('click', () => update(input.type === 'password'));
    input.form?.addEventListener('submit', () => update(false));
    wrapper.append(button);
  });
})();
