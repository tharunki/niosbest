const detail = document.querySelector('#paper-detail');
const REQUEST_TIMEOUT_MS = 15_000;
let razorpayLoader;

function paperSlugFromPath() {
  const fragment = location.pathname.split('/').filter(Boolean).pop() || '';
  try { return decodeURIComponent(fragment); }
  catch { return ''; }
}

const slug = paperSlugFromPath();

function escapeHTML(value = '') {
  return String(value).replace(/[&<>\'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function compactText(value, maximum = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normaliseTags(value) {
  let source = value;
  if (typeof source === 'string') {
    try {
      const parsed = JSON.parse(source);
      source = Array.isArray(parsed) ? parsed : source;
    } catch { /* A comma-separated legacy value is also supported. */ }
  }
  const values = Array.isArray(source) ? source : String(source || '').split(/[,\n]/);
  const seen = new Set();
  return values.map((tag) => compactText(tag, 48)).filter((tag) => {
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

function collectionLabel(paper) {
  const name = String(paper.displayClassName || paper.className || '').trim();
  return /^\d+$/.test(name) ? `Class ${name}` : name || 'Study resource';
}

function materialLabel(paper) {
  return String(paper.displayType || paper.type || 'Study material');
}

function setMeta(attribute, name, content) {
  if (!content) return;
  let element = document.head.querySelector(`meta[${attribute}="${name}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, name);
    document.head.append(element);
  }
  element.content = content;
}

function updateDocumentMetadata(paper) {
  const fallbackTitle = compactText(paper.title, 100) || 'Study material';
  const title = compactText(paper.metaTitle || paper.seoTitle, 100) || `${fallbackTitle} | TK's SOLUTION`;
  const description = compactText(paper.metaDescription || paper.seoDescription || paper.description, 180)
    || "Chapter-wise study material from TK's SOLUTION.";
  const keywords = normaliseTags(paper.seoKeywords || paper.keywords || paper.tags).join(', ');

  document.title = title;
  setMeta('name', 'description', description);
  setMeta('property', 'og:type', 'product');
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', description);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', description);
  if (keywords) setMeta('name', 'keywords', keywords);
}

function embeddedPaper() {
  const source = document.querySelector('#paper-data');
  if (!source?.textContent) return null;
  try {
    const paper = JSON.parse(source.textContent);
    return paper && typeof paper === 'object' && !Array.isArray(paper) && typeof paper.slug === 'string' ? paper : null;
  } catch {
    return null;
  }
}

async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong.');
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The request took too long. Please check your connection and try again.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function buyerDetailsFromForm(form) {
  const emailInput = form.elements.buyerEmail;
  const nameInput = form.elements.buyerName;
  const status = form.querySelector('#payment-status');
  const buyerEmail = compactText(emailInput?.value, 254).toLocaleLowerCase();
  const buyerName = compactText(nameInput?.value, 80);

  if (emailInput) emailInput.value = buyerEmail;
  if (nameInput) nameInput.value = buyerName;
  if (!emailInput || !buyerEmail || !emailInput.checkValidity()) {
    if (status) status.textContent = 'Enter a valid email address for your purchase access.';
    emailInput?.focus();
    emailInput?.reportValidity();
    return null;
  }
  return { buyerEmail, buyerName };
}

function checkoutPrefill(checkout) {
  const buyer = checkout?.buyer;
  if (!buyer || typeof buyer !== 'object') return null;
  const email = compactText(buyer.email, 254).toLocaleLowerCase();
  const name = compactText(buyer.name, 80);
  // Prefill only values the server just validated and returned for this order.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return name ? { email, name } : { email };
}

function setPurchaseControls(form, disabled) {
  form.querySelectorAll('input, button').forEach((control) => { control.disabled = disabled; });
}

function showError(message) {
  detail.innerHTML = `<h1>Paper unavailable</h1><p class="error">${escapeHTML(message)}</p><p><a href="/library.html">Return to the library</a></p>`;
}

const recoveryKey = `tks-solution-purchase-${slug}`;

function readRecovery() {
  try {
    const value = JSON.parse(localStorage.getItem(recoveryKey) || 'null');
    // The browser retains only a non-secret order reference. The matching
    // recovery bearer token lives in a short-lived HttpOnly cookie, so a
    // same-origin script cannot read or copy it.
    if (!value || !value.orderId || new Date(value.expiresAt).getTime() < Date.now()) {
      localStorage.removeItem(recoveryKey);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function saveRecovery(checkout) {
  if (!checkout?.order?.id || !checkout.recovery?.expiresAt) return;
  try {
    localStorage.setItem(recoveryKey, JSON.stringify({
      orderId: checkout.order.id,
      expiresAt: checkout.recovery.expiresAt
    }));
  } catch { /* Browser storage is optional; the normal checkout callback still works. */ }
}

function clearRecovery() {
  try { localStorage.removeItem(recoveryKey); }
  catch { /* Ignore unavailable browser storage. */ }
}

function showVerifiedDownload(verified) {
  clearRecovery();
  detail.innerHTML = `<h1>Payment verified</h1><p>Your private download link is ready. It expires in 24 hours.</p><p><a class="button" href="${escapeHTML(verified.downloadUrl)}">Download your PDF</a></p><p class="notice">Please save the file now. The link cannot be used after it expires.</p>`;
}

async function recoverPurchase() {
  const pending = readRecovery();
  if (!pending) return;
  try {
    const recovered = await request('/api/payment/recover', { method: 'POST', body: JSON.stringify({ orderId: pending.orderId }) });
    if (recovered.downloadUrl) return showVerifiedDownload(recovered);
    if (recovered.pending) {
      const status = document.querySelector('#payment-status');
      if (status) {
        status.textContent = `${recovered.message} `;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'secondary';
        retry.textContent = 'Check payment status';
        retry.addEventListener('click', recoverPurchase);
        status.append(retry);
      }
    }
  } catch {
    clearRecovery();
  }
}

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  if (razorpayLoader) return razorpayLoader;
  razorpayLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timeout = window.setTimeout(() => reject(new Error('The secure payment window took too long to load. Please try again.')), REQUEST_TIMEOUT_MS);
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => { window.clearTimeout(timeout); resolve(); };
    script.onerror = () => { window.clearTimeout(timeout); reject(new Error('The secure payment window could not load.')); };
    document.head.append(script);
  }).catch((error) => {
    razorpayLoader = null;
    throw error;
  });
  return razorpayLoader;
}

async function buy(paper, form) {
  const button = form.querySelector('#buy');
  const status = form.querySelector('#payment-status');
  const buyer = buyerDetailsFromForm(form);
  if (!button || !status || !buyer) return;
  setPurchaseControls(form, true);
  button.textContent = 'Preparing secure checkout…';
  try {
    const checkout = await request(`/api/checkout/${encodeURIComponent(paper.slug)}`, {
      method: 'POST',
      body: JSON.stringify(buyer)
    });
    await loadRazorpay();
    saveRecovery(checkout);
    let paymentCallbackStarted = false;
    const resetCheckout = () => {
      setPurchaseControls(form, false);
      button.textContent = 'Buy securely';
    };
    const prefill = checkoutPrefill(checkout);
    const razorpay = new window.Razorpay({
      key: checkout.key,
      amount: checkout.order.amount,
      currency: checkout.order.currency,
      name: "TK's SOLUTION",
      description: paper.title,
      order_id: checkout.order.id,
      theme: { color: '#263eb7' },
      ...(prefill ? { prefill } : {}),
      modal: {
        ondismiss: () => {
          if (!paymentCallbackStarted) {
            resetCheckout();
            status.textContent = 'Checkout closed. You can try again whenever you are ready.';
          }
        }
      },
      handler: async (payment) => {
        paymentCallbackStarted = true;
        try {
          const verified = await request('/api/payment/verify', { method: 'POST', body: JSON.stringify(payment) });
          showVerifiedDownload(verified);
        } catch (error) {
          status.textContent = `${error.message} Checking your payment safely…`;
          await recoverPurchase();
        }
      }
    });
    razorpay.on('payment.failed', (response) => {
      clearRecovery();
      resetCheckout();
      status.textContent = response.error.description || 'Payment was not completed.';
    });
    razorpay.open();
  } catch (error) {
    setPurchaseControls(form, false);
    button.textContent = 'Buy securely';
    status.textContent = error.message;
  }
}

function tagChips(paper) {
  return normaliseTags(paper.tags)
    .map((tag) => `<span class="tag-chip">${escapeHTML(tag)}</span>`)
    .join('');
}

function feedbackMarkup() {
  return `<details class="feedback"><summary>Report a content issue</summary><p>If you spot an incorrect answer, typo or broken link, send a short report to TK's SOLUTION. Do not include personal details.</p><form id="feedback-form"><label for="feedback-category">Issue type</label><select id="feedback-category" name="category" required><option value="incorrect-answer">Incorrect answer or solution</option><option value="typo">Typo or formatting issue</option><option value="broken-link">Broken link or file issue</option><option value="other">Other content issue</option></select><label for="feedback-message">What needs correcting?</label><textarea id="feedback-message" name="message" maxlength="1200" minlength="5" required placeholder="Describe the page, question or correction."></textarea><div class="feedback-actions"><button class="secondary" type="submit">Send report</button><p id="feedback-status" class="notice" role="status" aria-live="polite"></p></div></form></details>`;
}

function purchaseMarkup() {
  return `<form id="purchase-form" class="purchase-form"><div class="purchase-field"><label for="buyer-email">Email for your purchase record <span aria-hidden="true">*</span></label><input id="buyer-email" name="buyerEmail" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254" required aria-describedby="buyer-help" placeholder="you@example.com"></div><div class="purchase-field"><label for="buyer-name">Display name <span class="field-optional">Optional</span></label><input id="buyer-name" name="buyerName" type="text" autocomplete="name" maxlength="80" placeholder="Your name"></div><p id="buyer-help" class="buyer-help">We use your email for the purchase record and support. It is never sent to analytics. Save the private download link shown after payment.</p><button id="buy" class="button" type="submit">Buy securely</button><p class="notice" id="payment-status" role="status" aria-live="polite"></p></form>`;
}

async function submitFeedback(event, paper) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('#feedback-status');
  const category = compactText(form.elements.category?.value, 64);
  const message = compactText(form.elements.message?.value, 1200);
  if (!category || message.length < 5) {
    status.textContent = 'Please add a brief description of the issue.';
    return;
  }
  button.disabled = true;
  status.textContent = 'Sending your report…';
  try {
    await request('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({
        slug: compactText(paper.slug, 160),
        title: compactText(paper.title, 180),
        category,
        message
      })
    });
    form.reset();
    status.textContent = "Thank you. Your report has been sent to TK's SOLUTION.";
  } catch (error) {
    status.textContent = error.message || 'Your report could not be sent. Please try again.';
  } finally {
    button.disabled = false;
  }
}

function renderPaper(paper) {
  const preview = paper.link
    ? `<p><a class="preview-link" href="${escapeHTML(paper.link)}" target="_blank" rel="noopener">Open free preview ↗</a></p>`
    : '';
  const tags = tagChips(paper);
  detail.innerHTML = `<p class="eyebrow">${escapeHTML(collectionLabel(paper))} · ${escapeHTML(paper.subject)} · ${escapeHTML(materialLabel(paper).toUpperCase())}</p><h1>${escapeHTML(paper.title)}</h1><p>${escapeHTML(paper.description || 'Chapter-wise study material for focused revision.')}</p><div class="meta"><span>Secure access</span><span>PDF material</span>${tags}</div><p class="price">₹${escapeHTML(paper.price || '39')}</p>${preview}${paper.available ? purchaseMarkup() : '<p class="notice">This paper is being prepared for secure purchase. Please check back soon.</p>'}${feedbackMarkup()}`;
  document.querySelector('#purchase-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void buy(paper, event.currentTarget);
  });
  document.querySelector('#feedback-form')?.addEventListener('submit', (event) => { void submitFeedback(event, paper); });
}

async function loadPaper() {
  try {
    // The Worker embeds a safe public-card payload in the first HTML response.
    // Use it first so the detail page is readable immediately and stays useful
    // if the catalogue API is briefly unavailable after page delivery.
    const initialPaper = embeddedPaper();
    const data = initialPaper ? null : await request(`/api/papers/slug/${encodeURIComponent(slug)}`);
    const paper = initialPaper || data?.paper;
    if (!paper || !paper.slug) throw new Error('Paper not found.');
    updateDocumentMetadata(paper);
    renderPaper(paper);
    if (paper.available) await recoverPurchase();
  } catch (error) {
    showError(error.message);
  }
}

void loadPaper();
