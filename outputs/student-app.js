(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const state = { dashboard: null, user: null, installPrompt: null, assistantTopic: '', assistantBusy: false };
  const views = ['loadingView', 'guestView', 'roleView', 'pendingView', 'errorView', 'studentView'];
  const toast = byId('toast');
  const allowedPath = path => /^\/(?!\/)/.test(String(path || ''));
  const appIsInstalled = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;

  function showView(id) {
    views.forEach(view => byId(view).hidden = view !== id);
    byId('bottomNav').hidden = id !== 'studentView';
    byId('signoutButton').hidden = id !== 'studentView';
  }

  function tell(message, error = false) {
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('show');
    clearTimeout(tell.timer);
    tell.timer = setTimeout(() => toast.classList.remove('show'), 3800);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function clampProgress(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
  }

  function localTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Time to be confirmed';
    return date.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function humanStatus(value) {
    return String(value || 'Pending').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function safeExternalUrl(value) {
    try {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const url = new URL(raw, window.location.origin);
      return url.protocol === 'https:' ? url.href : '';
    } catch { return ''; }
  }

  function safeOfficialSource(value) {
    try {
      const url = new URL(String(value || ''));
      const host = url.hostname.toLowerCase();
      return url.protocol === 'https:' && new Set(['nios.ac.in', 'www.nios.ac.in', 'sdmis.nios.ac.in']).has(host) ? url.href : '';
    } catch { return ''; }
  }

  // Do not transmit a likely actual secret, card/ID value, or private identifier to Mira.
  // General process questions still reach the privacy-safe server response.
  function containsSensitiveAssistantValue(value) {
    const text = String(value || '').trim();
    return /\b(?:password|passcode|otp|one[ -]?time (?:passcode|password)|upi\s*pin|cvv|card(?:\s*(?:number|details|pin))?|bank(?:\s*(?:account|details|number|ifsc))?)\s*(?:is|:|=|-)?\s*(?:\d{4,}|[A-Za-z0-9!@#$%^&*_-]{6,})\b/i.test(text)
      || /\b(?:\d[ -]?){12}\b/.test(text)
      || /\b(?:\d[ -]?){13,19}\b/.test(text)
      || /\b(?:enrol(?:l?ment)?|reference|registration)\s*(?:number|no\.?|id)?\s*(?:is|:|#|-)\s*[A-Za-z0-9-]{5,}\b/i.test(text)
      || /\b(?:date of birth|dob)\s*(?:is|:|#|-)\s*\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/i.test(text)
      || /\b[A-Z]{4}0[A-Z0-9]{6}\b/.test(text);
  }

  const localPrivacyReply = {
    title: 'Private information was not sent',
    text: 'For your safety, Mira did not send that message. Never paste a password, OTP, PIN, card or bank detail, Aadhaar/PAN/passport number, date of birth, enrolment/reference number, or document image into chat.',
    steps: ['Use the signed-in admission workflow for document or profile updates.', 'Use official account recovery or payment-provider support for a secret or payment issue.'],
    links: [['Open secure admission status', '/admission-intake'], ['Contact academy support', '/contact.html#form']]
  };

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), options.timeout || 12000);
    try {
      const response = await fetch(path, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        signal: controller.signal,
        headers: { accept: 'application/json', ...(options.headers || {}) }
      });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function setText(id, value) { byId(id).textContent = String(value ?? '—'); }

  function empty(target, title, copy) {
    target.replaceChildren();
    const box = element('div', 'empty');
    box.append(element('strong', '', title), document.createTextNode(copy));
    target.append(box);
  }

  function renderSubjects(subjects) {
    const target = byId('subjectList');
    if (!subjects.length) return empty(target, 'Your subject choices are being prepared', 'Your selected subjects will appear here after admission review.');
    target.replaceChildren();
    subjects.slice(0, 8).forEach(subject => {
      const progress = clampProgress(subject.progress);
      const card = element('article', 'subject');
      const copy = element('div', 'subject-copy');
      copy.append(element('b', '', subject.name || 'Selected subject'), element('small', '', `${subject.code || 'Subject code pending'} · TMA: ${subject.tmaStatus || 'Pending'}`));
      const meter = element('div', 'subject-progress');
      const line = element('div', 'progress-line');
      const fill = element('i');
      fill.style.width = `${progress}%`;
      line.append(fill);
      meter.append(line, element('span', '', `${progress}% ready`));
      card.append(copy, meter);
      target.append(card);
    });
  }

  function activity(icon, title, copy, tagText, isReady = false) {
    const card = element('article', 'activity');
    const iconNode = element('span', `item-icon ${isReady ? 'aqua' : 'gold'}`, icon);
    iconNode.setAttribute('aria-hidden', 'true');
    const copyNode = element('div', 'item-copy');
    copyNode.append(element('b', '', title), element('small', '', copy));
    const tag = element('span', `tag ${isReady ? 'ready' : ''}`, tagText);
    card.append(iconNode, copyNode, tag);
    return card;
  }

  function renderActivity(dashboard, pendingHomework) {
    const target = byId('activityList');
    const enrollment = dashboard.enrollment || {};
    const issued = (dashboard.profile?.documents || []).filter(document => document.status === 'Issued').length;
    target.replaceChildren(
      activity(enrollment.contentAccess ? '✓' : '◷', enrollment.contentAccess ? 'Learning access active' : 'Admission review in progress', enrollment.contentAccess ? 'Your batch learning features are unlocked.' : 'You can track your admission from this Student App.', humanStatus(enrollment.status), Boolean(enrollment.contentAccess)),
      activity('▧', issued ? 'Official documents available' : 'Official documents are being checked', issued ? `${issued} secure document${issued === 1 ? '' : 's'} available in the full Student Desk.` : 'New documents will appear after the academy or official service issues them.', issued ? 'Issued' : 'Pending', Boolean(issued)),
      activity('✓', pendingHomework ? `${pendingHomework} homework task${pendingHomework === 1 ? '' : 's'} to complete` : 'No homework waiting', pendingHomework ? 'Open Homework to read teacher instructions and submit work.' : 'Your teacher has not assigned a pending task in this batch.', pendingHomework ? 'Action' : 'Clear', !pendingHomework)
    );
  }

  function renderClasses(items) {
    const target = byId('classList');
    if (!items.length) return empty(target, 'No live classes scheduled yet', 'When your teacher schedules a class for your batch and selected subject, it will appear here.');
    target.replaceChildren();
    items.slice(0, 4).forEach(item => {
      const card = element('article', 'class-card');
      const icon = element('span', 'item-icon', '▣'); icon.setAttribute('aria-hidden', 'true');
      const copy = element('div', 'item-copy');
      copy.append(element('b', '', item.title || 'Live class'), element('small', '', `${item.subject || 'Subject'} · ${localTime(item.startsAt)}`));
      const url = item.joinEnabled ? safeExternalUrl(item.liveUrl) : '';
      const action = element(url ? 'a' : 'a', 'class-action', url ? 'Join class' : item.isPast ? 'Class ended' : 'View schedule');
      action.href = url || '/live-classes';
      if (url) { action.target = '_blank'; action.rel = 'noopener'; }
      if (!url && item.isPast) action.setAttribute('aria-disabled', 'true');
      card.append(icon, copy, action);
      target.append(card);
    });
  }

  function renderMaterials(items) {
    const target = byId('materialList');
    if (!items.length) return empty(target, 'No batch materials available yet', 'Only material assigned to your active batch and selected subjects appears in this app.');
    target.replaceChildren();
    items.slice(0, 6).forEach(item => {
      const card = element('article', 'material-card');
      const icon = element('span', 'item-icon aqua', '⇩'); icon.setAttribute('aria-hidden', 'true');
      const copy = element('div', 'item-copy');
      copy.append(element('b', '', item.title || 'Batch material'), element('small', '', `${item.subject || 'Subject'} · ${item.materialType || 'Study material'}`));
      card.append(icon, copy);
      if (item.downloadable && item.id) {
        const download = element('a', 'download', 'Download');
        download.href = `/api/materials/${encodeURIComponent(item.id)}/download`;
        card.append(download);
      } else card.append(element('span', 'tag', 'Coming soon'));
      target.append(card);
    });
  }

  function renderDashboard(dashboard) {
    state.dashboard = dashboard;
    const profile = dashboard.profile || {};
    const enrollment = dashboard.enrollment || {};
    const subjects = Array.isArray(profile.subjects) ? profile.subjects : [];
    const homework = Array.isArray(dashboard.homework) ? dashboard.homework : [];
    const materials = Array.isArray(dashboard.materials) ? dashboard.materials : [];
    const classes = Array.isArray(dashboard.liveClasses) ? dashboard.liveClasses : [];
    const pendingHomework = homework.filter(item => !item.submission || !['Submitted', 'Graded'].includes(item.submission.status)).length;
    const average = subjects.length ? Math.round(subjects.reduce((sum, subject) => sum + clampProgress(subject.progress), 0) / subjects.length) : 0;
    const firstName = String(profile.name || 'Student').trim().split(/\s+/)[0] || 'Student';
    const currentStatus = enrollment.contentAccess ? 'Your secure batch learning space is ready.' : `Your payment is recorded. ${humanStatus(enrollment.status)} is being managed by the academy.`;

    setText('welcome', `Welcome back, ${firstName}.`);
    setText('heroCopy', currentStatus);
    setText('batchName', enrollment.batch?.name || enrollment.assignedBatchCode || 'Assigned batch');
    byId('accessDot').classList.toggle('waiting', !enrollment.contentAccess);
    setText('subjectCount', subjects.length);
    setText('progressValue', subjects.length ? `${average}%` : '—');
    setText('homeworkCount', pendingHomework);
    setText('materialCount', materials.length);
    setText('classShortcutMeta', classes.length ? `${classes.length} scheduled` : 'No schedule yet');
    setText('homeworkShortcutMeta', pendingHomework ? `${pendingHomework} need attention` : 'Up to date');
    setText('materialShortcutMeta', materials.length ? `${materials.length} available` : 'Teacher uploads');
    renderSubjects(subjects);
    renderActivity(dashboard, pendingHomework);
    renderClasses(classes);
    renderMaterials(materials);
    showView('studentView');
  }

  function showPending(profile, copy) {
    const enrollment = profile?.enrollment || {};
    setText('pendingCopy', copy || (enrollment.status ? `Your current admission status is ${humanStatus(enrollment.status)}. Complete the next step with the academy to unlock learning.` : 'Choose a batch, select subjects, upload documents and complete payment before your Student App opens.'));
    byId('pendingLink').href = enrollment.status ? '/dashboard' : '/';
    byId('pendingLink').textContent = enrollment.status ? 'View admission status' : 'Choose a batch';
    showView('pendingView');
  }

  function showRole(user) {
    const isTeacher = user.role === 'teacher';
    setText('roleTitle', isTeacher ? 'This is the Student App' : 'This app is for enrolled students');
    setText('roleCopy', isTeacher ? 'Your teacher account has a dedicated portal for classes, homework and materials.' : 'Your account does not have student access for this app.');
    const link = byId('roleLink');
    link.href = isTeacher ? '/teacher-portal' : user.role === 'admin' ? '/admin' : '/';
    link.textContent = isTeacher ? 'Open Teacher Portal' : user.role === 'admin' ? 'Open Admin Portal' : 'Back to home';
    showView('roleView');
  }

  async function load() {
    showView('loadingView');
    try {
      const auth = await api('/api/auth/me');
      if (auth.response.status === 401) return showView('guestView');
      if (!auth.response.ok) throw new Error(auth.data.error || 'Your account could not be checked.');
      state.user = auth.data.user || {};
      if (state.user.role !== 'student') return showRole(state.user);

      const desk = await api('/api/dashboard');
      if (desk.response.status === 401) return showView('guestView');
      if (!desk.response.ok) return showPending(auth.data.profile, desk.data.error);
      renderDashboard(desk.data);
    } catch (error) {
      setText('errorCopy', error.name === 'AbortError' ? 'The request took too long. Check your connection and try again.' : error.message || 'Check your connection and try again.');
      showView('errorView');
    }
  }

  async function refreshStatus() {
    const dashboard = state.dashboard;
    const profile = dashboard?.profile;
    if (!profile?.vault?.configured) return tell('The academy will add your official enrollment record after registration is complete.');
    const button = byId('refreshButton');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      const result = await api(`/api/students/${encodeURIComponent(profile.id)}/sync`, { method: 'POST' });
      if (!result.response.ok) throw new Error(result.data.error || 'Could not start an official status refresh.');
      tell(result.data.manual ? (result.data.message || 'The academy will update your official status manually.') : 'Official status refresh queued. This app will update when it finishes.');
      if (!result.data.manual) window.setTimeout(load, 900);
    } catch (error) {
      tell(error.message || 'Could not refresh your status.', true);
    } finally {
      button.disabled = false;
      button.textContent = '↻ Refresh status';
    }
  }

  async function signOut() {
    const button = byId('signoutButton');
    button.disabled = true;
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch { /* The local session is still cleared below. */ }
    sessionStorage.removeItem('niosSession');
    window.location.reload();
  }

  function appendMessage(copy, isUser = false) {
    const message = element('article', `message${isUser ? ' user' : ''}`);
    if (typeof copy === 'string') message.textContent = copy;
    else {
      message.append(element('h3', '', copy.title || 'Mira'), element('p', '', copy.text || ''));
      if (Array.isArray(copy.steps) && copy.steps.length) {
        const list = element('ol');
        copy.steps.slice(0, 4).forEach(step => list.append(element('li', '', step)));
        message.append(list);
      }
      if (Array.isArray(copy.links)) {
        copy.links.slice(0, 2).forEach(link => {
          const label = Array.isArray(link) ? link[0] : '';
          const path = Array.isArray(link) ? link[1] : '';
          if (!allowedPath(path)) return;
          const anchor = element('a', '', `${label} →`);
          anchor.href = path;
          message.append(anchor);
        });
      }
      if (Array.isArray(copy.sources) && copy.sources.length) {
        const sources = element('div', 'assistant-sources');
        sources.append(element('span', '', 'Official source to check'));
        copy.sources.slice(0, 2).forEach(source => {
          const label = Array.isArray(source) ? source[0] : '';
          const href = safeOfficialSource(Array.isArray(source) ? source[1] : '');
          if (!href) return;
          const anchor = element('a', '', `${label} →`);
          anchor.href = href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          sources.append(anchor);
        });
        if (sources.childElementCount > 1) message.append(sources);
      }
    }
    byId('assistantLog').append(message);
    byId('assistantLog').scrollTop = byId('assistantLog').scrollHeight;
  }

  function renderPrompts(items) {
    const target = byId('assistantPrompts');
    target.replaceChildren();
    items.slice(0, 4).forEach(item => {
      const button = element('button', '', item);
      button.type = 'button';
      button.addEventListener('click', () => askMira(item));
      target.append(button);
    });
  }

  function setAssistantBusy(value) {
    state.assistantBusy = value;
    byId('assistantInput').disabled = value;
    byId('assistantForm').querySelector('button[type=submit]').disabled = value;
    byId('assistantPrompts').querySelectorAll('button').forEach(button => { button.disabled = value; });
  }

  function openAssistant() {
    const sheet = byId('assistantSheet');
    sheet.hidden = false;
    if (!byId('assistantLog').childElementCount) {
      appendMessage({ title: 'Hi — I’m Mira.', text: 'I can help with your admission, batch, selected subjects, TMA work, PYQs, practicals, study plan, live classes and materials. I do not ask for or retrieve passwords, OTPs, Aadhaar details, payment details, or private identifiers.', steps: ['Ask one question at a time for the clearest answer.', 'Confirm official dates, fees, hall tickets and decisions with NIOS or the academy.'], links: [] });
      renderPrompts(['My admission status', 'Subjects & batch', 'TMA help', 'PYQs and materials']);
    }
    window.setTimeout(() => byId('assistantInput').focus(), 20);
  }

  function closeAssistant() { byId('assistantSheet').hidden = true; }

  async function askMira(question) {
    const input = byId('assistantInput');
    const text = String(question || input.value || '').trim();
    if (!text || state.assistantBusy) return;
    if (containsSensitiveAssistantValue(text)) {
      input.value = '';
      appendMessage('A private detail was removed and was not sent.', true);
      appendMessage(localPrivacyReply);
      renderPrompts(['What documents are required?', 'What is my admission status?', 'How do I select subjects?']);
      setText('assistantStatus', 'For your privacy, that value was kept out of the assistant request.');
      return;
    }
    setAssistantBusy(true);
    input.value = '';
    appendMessage(text, true);
    setText('assistantStatus', 'Mira is matching your question to Student Desk guidance…');
    try {
      const result = await api('/api/counselor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, topic: state.assistantTopic }), timeout: 15000 });
      if (!result.response.ok) throw new Error(result.data.error || 'Mira is unavailable right now.');
      state.assistantTopic = result.data.topic || '';
      appendMessage(result.data);
      renderPrompts(result.data.followUps || []);
      setText('assistantStatus', 'Guidance based on your Student Desk. Confirm official dates and decisions with NIOS or the academy.');
    } catch (error) {
      setText('assistantStatus', error.name === 'AbortError' ? 'The reply timed out. Please try again.' : error.message || 'Mira is unavailable right now.');
    } finally {
      setAssistantBusy(false);
    }
  }

  async function install() {
    if (appIsInstalled()) return tell('Student App is already installed on this device.');
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const choice = await state.installPrompt.userChoice;
      if (choice.outcome === 'accepted') tell('Student App is being installed.');
      state.installPrompt = null;
      return;
    }
    const isAppleMobile = /iphone|ipad|ipod/i.test(navigator.userAgent);
    tell(isAppleMobile ? 'In Safari, tap Share and then “Add to Home Screen”.' : 'Use your browser menu and choose “Install app” or “Add to Home screen”.');
  }

  function registerServiceWorker() {
    const supportedOrigin = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
    if (!supportedOrigin || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/student-app-sw.js', { scope: '/' }).catch(() => {});
  }

  byId('retryButton').addEventListener('click', load);
  byId('refreshButton').addEventListener('click', refreshStatus);
  byId('assistantOpen').addEventListener('click', openAssistant);
  byId('bottomAssistant').addEventListener('click', openAssistant);
  byId('assistantClose').addEventListener('click', closeAssistant);
  byId('assistantForm').addEventListener('submit', event => { event.preventDefault(); askMira(); });
  byId('installButton').addEventListener('click', install);
  byId('signoutButton').addEventListener('click', signOut);
  byId('bottomNav').querySelectorAll('[data-target]').forEach(button => button.addEventListener('click', () => {
    const target = byId(button.dataset.target);
    if (!target) return;
    byId('bottomNav').querySelectorAll('[data-target]').forEach(item => item.classList.toggle('active', item === button));
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    state.installPrompt = event;
    byId('installButton').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    byId('installButton').textContent = '✓ Installed';
  });

  registerServiceWorker();
  load();
})();
