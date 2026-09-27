(() => {
  const style = document.createElement('style');
  style.textContent = `
  .counselor-launch{position:fixed;bottom:22px;right:22px;z-index:40;border:1px solid #b6acff;border-radius:30px;padding:14px 20px;background:#6750d8;color:white;font:700 14px system-ui;cursor:pointer;box-shadow:0 8px 30px #0005}.counselor-panel{position:fixed;bottom:85px;right:22px;z-index:41;width:min(440px,calc(100vw - 24px));height:min(650px,calc(100dvh - 110px));background:#1d1c50;color:#f5f3ff;border:1px solid #8073bd;border-radius:20px;box-shadow:0 20px 80px #0008;display:flex;flex-direction:column;font:14px/1.5 system-ui;overflow:hidden}.counselor-panel[hidden]{display:none}.counselor-head{padding:15px 16px;border-bottom:1px solid #ffffff22;display:flex;gap:8px;align-items:center}.counselor-head strong{flex:1}.counselor-head small{display:block;color:#bdb6e9;font-weight:400;font-size:11px}.counselor-panel button{cursor:pointer;border:1px solid #ffffff33;background:#ffffff0b;color:inherit;border-radius:9px;padding:9px;font:inherit}.counselor-panel button:disabled{opacity:.5;cursor:wait}.counselor-log{flex:1;overflow:auto;padding:15px;min-height:0}.counselor-message{white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border-radius:12px;background:#ffffff0a;margin:0 0 12px}.counselor-message.user{background:#6750d855;margin-left:24px}.counselor-answer h3{font-size:14px;margin:0 0 6px;color:#fff}.counselor-answer p{margin:0;color:#e7e4fa}.counselor-answer ol{margin:9px 0 0;padding-left:20px;color:#d9d5f4}.counselor-answer a{display:block;color:#87eee3;margin-top:9px;font-weight:700}.counselor-sources{margin:11px 0 0;padding:9px;border:1px solid #ffffff18;border-radius:9px;background:#ffffff08}.counselor-sources span{display:block;color:#cfc8f2;font-size:11px;font-weight:700}.counselor-sources a{font-size:12px}.counselor-followups{display:flex;flex-wrap:wrap;gap:6px;margin:-5px 0 13px 6px}.counselor-followups button{font-size:11px;padding:7px 9px;background:#6750d833}.counselor-prompts{padding:10px;display:flex;flex-wrap:wrap;gap:6px;border-top:1px solid #ffffff18}.counselor-prompts button{font-size:12px}.counselor-form{padding:12px;display:flex;gap:8px;border-top:1px solid #ffffff22}.counselor-form input{min-width:0;flex:1;padding:11px;border-radius:9px;border:1px solid #ffffff44;background:#0c0c29;color:white;font:inherit}.counselor-state{padding:0 14px 9px;color:#d2cafa;font-size:12px}.counselor-panel :focus-visible,.counselor-launch:focus-visible{outline:3px solid #55d9d0;outline-offset:2px}@media(max-width:600px){.counselor-launch{bottom:12px;right:12px;padding:12px 15px}.counselor-panel{bottom:70px;right:12px;height:min(630px,calc(100dvh - 86px))}}`;
  document.head.append(style);

  const launch = document.createElement('button');
  launch.className = 'counselor-launch';
  launch.type = 'button';
  launch.textContent = '✦ Ask Mira';
  launch.setAttribute('aria-expanded', 'false');
  launch.setAttribute('aria-controls', 'studentAssistant');

  const panel = document.createElement('section');
  panel.id = 'studentAssistant';
  panel.className = 'counselor-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Mira academic assistant');
  panel.innerHTML = '<header class="counselor-head"><strong>Mira · Academic Assistant<small>Guidance from your Student Desk · not an official NIOS source</small></strong><button type="button" id="assistantClear">New chat</button><button type="button" id="assistantClose" aria-label="Close assistant">×</button></header><div class="counselor-log" role="log" aria-live="polite"></div><div class="counselor-prompts" aria-label="Suggested questions"></div><form class="counselor-form"><input aria-label="Your question" maxlength="1200" autocomplete="off" placeholder="Ask about admission, TMA, PYQs or classes…" required><button type="submit">Send</button></form><div class="counselor-state" role="status"></div>';
  document.body.append(launch, panel);

  const log = panel.querySelector('.counselor-log');
  const input = panel.querySelector('input');
  const status = panel.querySelector('.counselor-state');
  const send = panel.querySelector('[type=submit]');
  const promptBar = panel.querySelector('.counselor-prompts');
  let topic = '';
  let pending = null;
  let revision = 0;
  let lastQuestion = '';

  const safePath = path => /^\/(?!\/)/.test(String(path || ''));
  const safeOfficialSource = value => {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && new Set(['nios.ac.in', 'www.nios.ac.in', 'sdmis.nios.ac.in']).has(host) ? url.href : '';
    } catch { return ''; }
  };

  // Avoid sending values that look like real credentials, financial details, or IDs.
  // General questions such as "How do I upload a document?" still go to Mira for guidance.
  const containsSensitiveValue = value => {
    const text = String(value || '').trim();
    return /\b(?:password|passcode|otp|one[ -]?time (?:passcode|password)|upi\s*pin|cvv|card(?:\s*(?:number|details|pin))?|bank(?:\s*(?:account|details|number|ifsc))?)\s*(?:is|:|=|-)?\s*(?:\d{4,}|[A-Za-z0-9!@#$%^&*_-]{6,})\b/i.test(text)
      || /\b(?:\d[ -]?){12}\b/.test(text)
      || /\b(?:\d[ -]?){13,19}\b/.test(text)
      || /\b(?:enrol(?:l?ment)?|reference|registration)\s*(?:number|no\.?|id)?\s*(?:is|:|#|-)\s*[A-Za-z0-9-]{5,}\b/i.test(text)
      || /\b(?:date of birth|dob)\s*(?:is|:|#|-)\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/i.test(text)
      || /\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text);
  };

  const localPrivacyReply = {
    title: 'Private information was not sent',
    text: 'For your safety, Mira did not send that message. Never paste a password, OTP, PIN, card or bank detail, Aadhaar/PAN/passport number, date of birth, enrolment/reference number, or document image into chat.',
    steps: ['Use the signed-in admission workflow for documents or profile updates.', 'Use official account recovery or payment-provider support for a secret or payment issue.'],
    followUps: ['What documents are required?', 'What is my admission status?', 'How do I select subjects?'],
    links: [['Open secure admission status', '/admission-intake'], ['Contact academy support', '/contact.html#form']]
  };

  function scroll() {
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 60) log.firstElementChild.remove();
  }

  function plainMessage(text, user = false) {
    const item = document.createElement('div');
    item.className = 'counselor-message' + (user ? ' user' : '');
    item.textContent = text;
    log.append(item);
    scroll();
  }

  function addLink(parent, label, path, source = false) {
    const href = source ? safeOfficialSource(path) : (safePath(path) ? path : '');
    if (!href) return;
    const link = document.createElement('a');
    link.href = href;
    link.textContent = `${label} →`;
    if (source) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    parent.append(link);
  }

  function answerMessage(answer) {
    const item = document.createElement('article');
    item.className = 'counselor-message counselor-answer';
    const title = document.createElement('h3');
    title.textContent = answer.title || 'Mira';
    const copy = document.createElement('p');
    copy.textContent = answer.text || '';
    item.append(title, copy);

    if (Array.isArray(answer.steps) && answer.steps.length) {
      const list = document.createElement('ol');
      answer.steps.slice(0, 5).forEach(step => {
        const line = document.createElement('li');
        line.textContent = step;
        list.append(line);
      });
      item.append(list);
    }
    if (Array.isArray(answer.links)) {
      answer.links.slice(0, 3).forEach(([label, path]) => addLink(item, label, path));
    }
    if (Array.isArray(answer.sources) && answer.sources.length) {
      const sources = document.createElement('div');
      sources.className = 'counselor-sources';
      const heading = document.createElement('span');
      heading.textContent = 'Official source to check';
      sources.append(heading);
      answer.sources.slice(0, 2).forEach(([label, url]) => addLink(sources, label, url, true));
      if (sources.childElementCount > 1) item.append(sources);
    }
    log.append(item);
    scroll();
    renderFollowUps(answer.followUps || []);
  }

  function renderFollowUps(items) {
    const older = log.querySelector('.counselor-followups');
    if (older) older.remove();
    if (!items.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'counselor-followups';
    items.slice(0, 4).forEach(text => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.onclick = () => ask(text);
      wrap.append(button);
    });
    log.append(wrap);
    scroll();
  }

  function busy(value) {
    send.disabled = value;
    input.disabled = value;
    promptBar.querySelectorAll('button').forEach(button => { button.disabled = value; });
    panel.querySelectorAll('.counselor-followups button').forEach(button => { button.disabled = value; });
    panel.setAttribute('aria-busy', String(value));
  }

  function reset() {
    revision += 1;
    pending?.abort();
    pending = null;
    topic = '';
    lastQuestion = '';
    log.replaceChildren();
    status.textContent = '';
    input.value = '';
    busy(false);
    answerMessage({
      title: 'Hi — I’m Mira, your academic assistant.',
      text: 'Ask about your admission, batch, selected subjects, TMA work, PYQs, practicals, study routine, live classes or materials. I give Student Desk guidance, not official NIOS decisions.',
      steps: ['Check official dates, fees, hall tickets and decisions with NIOS or the academy.', 'Never send passwords, OTPs, Aadhaar numbers, payment details or document images in chat.'],
      followUps: ['What is my admission status?', 'Help me plan this week', 'Where are my batch materials?']
    });
  }

  function show(open) {
    panel.hidden = !open;
    launch.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
    else launch.focus();
  }

  function showLocalPrivacyReply() {
    plainMessage('A private detail was removed and was not sent.', true);
    answerMessage(localPrivacyReply);
    status.textContent = 'For your privacy, that value was kept out of the assistant request.';
  }

  launch.onclick = () => show(panel.hidden);
  panel.querySelector('#assistantClose').onclick = () => show(false);
  panel.querySelector('#assistantClear').onclick = () => { reset(); input.focus(); };
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') show(false); });

  async function ask(text, retry = false) {
    const question = String(text || '').trim();
    if (pending || !question) return;
    if (!retry && containsSensitiveValue(question)) {
      input.value = '';
      showLocalPrivacyReply();
      return;
    }
    const version = revision;
    lastQuestion = question;
    if (!retry) plainMessage(question, true);
    input.value = '';
    busy(true);
    status.textContent = 'Mira is matching your question to Student Desk guidance…';
    const controller = new AbortController();
    pending = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/counselor', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question, topic }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Mira is unavailable right now.');
      if (version !== revision) return;
      topic = data.topic || '';
      answerMessage(data);
      status.textContent = 'Guidance is based on your Student Desk. Confirm official dates and decisions with NIOS or the academy.';
    } catch (error) {
      if (version !== revision) return;
      status.textContent = error.name === 'AbortError' ? 'The reply timed out. Try again.' : error.message;
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.textContent = 'Retry';
      retryButton.onclick = () => ask(lastQuestion, true);
      status.append(' ', retryButton);
    } finally {
      clearTimeout(timer);
      if (version === revision) {
        pending = null;
        busy(false);
      }
    }
  }

  panel.querySelector('form').onsubmit = event => { event.preventDefault(); ask(input.value); };
  for (const prompt of ['Admission status', 'Subjects & batch', 'TMA help', 'PYQs and materials', 'Live classes']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = prompt;
    button.onclick = () => ask(prompt);
    promptBar.append(button);
  }
  reset();
})();
