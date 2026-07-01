// IIFE guard — prevents duplicate listener registration if the script is injected
// programmatically into a tab that already had it injected via manifest.
(() => {
if (window.__leadVetterActive) return;
window.__leadVetterActive = true;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'removeLead') {
    // sendResponse({ ok: true }); // ! bring what's commented back when live.
    removeLead(msg.linkedInUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'scrollToLoadAll') {
    scrollToLoadAll()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === 'showStopButton') {
    showStopButton();
    sendResponse({ ok: true });
  }

  if (msg.action === 'hideStopButton') {
    hideStopButton();
    sendResponse({ ok: true });
  }
});

// Scrolls the leads table to the bottom repeatedly until no new rows appear,
// ensuring all lazy-loaded leads are in the DOM before removal begins.
async function scrollToLoadAll() {
  // Walk up from a known lead link to find the first scrollable ancestor
  function findScrollContainer() {
    const link = document.querySelector('a[href*="linkedin.com/in/"]');
    if (!link) return null;
    let el = link.parentElement;
    while (el && el !== document.body) {
      const { overflow, overflowY } = window.getComputedStyle(el);
      if (/auto|scroll/.test(overflow) || /auto|scroll/.test(overflowY)) return el;
      el = el.parentElement;
    }
    return null;
  }

  const container = findScrollContainer();
  let prevCount = 0;
  let stableRounds = 0;

  while (stableRounds < 2) {
    if (container) container.scrollTop = container.scrollHeight;
    window.scrollTo(0, document.body.scrollHeight);

    await new Promise(r => setTimeout(r, 1500));

    const count = document.querySelectorAll('a[href*="linkedin.com/in/"]').length;
    if (count > prevCount) {
      prevCount = count;
      stableRounds = 0;
    } else {
      stableRounds++;
    }
  }
}

async function removeLead(linkedInUrl) {
  const targetPath = normalizePath(linkedInUrl);

  // Find the <tr> that contains a link to this LinkedIn profile
  const links = document.querySelectorAll('a[href*="linkedin.com/in/"]');
  let targetRow = null;

  for (const link of links) {
    if (normalizePath(link.href) === targetPath) {
      targetRow = link.closest('tr');
      if (targetRow) break;
    }
  }

  if (!targetRow) throw new Error(`Row not found for: ${linkedInUrl}`);

  // The remove button lives in the last <td> of the row
  const cells = targetRow.querySelectorAll('td');
  if (!cells.length) throw new Error('No table cells found in row');

  const lastCell = cells[cells.length - 1];
  const removeBtn = lastCell.querySelector('button, [role="button"]');
  if (!removeBtn) throw new Error('Remove button not found in last cell');

  removeBtn.click();

  // Wait for the confirmation dialog Angular renders
  const dialog = await waitForElement('[role="dialog"], mat-dialog-container', 5000);

  // Find the destructive confirm button by text content
  const buttons = [...dialog.querySelectorAll('button')];
  const confirmBtn = buttons.find(btn => {
    const text = btn.textContent.trim().toLowerCase();
    return text.includes('remove') || text.includes('confirm') || text.includes('yes') || text.includes('delete');
  }) ?? buttons[buttons.length - 1]; // Fallback: last button in dialog

  if (!confirmBtn) throw new Error('Confirm button not found in dialog');

  confirmBtn.click();

  // Wait for Angular to remove the row from the DOM before continuing
  await waitForRemoval(targetRow, 5000);
}

// ── Stop button ──────────────────────────────────────────────────────────────

function showStopButton() {
  if (document.getElementById('__lv_stop_btn')) return;

  const btn = document.createElement('button');
  btn.id = '__lv_stop_btn';
  btn.textContent = '⏹ Stop Workflow';
  btn.style.cssText = [
    'position:fixed',
    'bottom:28px',
    'right:28px',
    'z-index:2147483647',
    'background:#dc2626',
    'color:#fff',
    'border:none',
    'border-radius:8px',
    'padding:12px 22px',
    'font-size:14px',
    'font-weight:600',
    'cursor:pointer',
    'box-shadow:0 4px 16px rgba(0,0,0,0.2)',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
  ].join(';');

  btn.addEventListener('mouseenter', () => { btn.style.background = '#b91c1c'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#dc2626'; });

  btn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'stopWorkflow' });
    btn.textContent = 'Stopping…';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    btn.style.cursor = 'default';
  });

  document.body.appendChild(btn);
}

function hideStopButton() {
  const btn = document.getElementById('__lv_stop_btn');
  if (btn) btn.remove();
}

// ── DOM utilities ────────────────────────────────────────────────────────────

function waitForElement(selector, timeout) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { obs.disconnect(); resolve(el); }
    });

    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      reject(new Error(`Timed out waiting for: ${selector}`));
    }, timeout);
  });
}

function waitForRemoval(el, timeout) {
  return new Promise((resolve) => {
    if (!document.contains(el)) { resolve(); return; }

    const obs = new MutationObserver(() => {
      if (!document.contains(el)) { obs.disconnect(); resolve(); }
    });

    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); resolve(); }, timeout);
  });
}

function normalizePath(url) {
  try {
    return new URL(url).pathname.replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return url.replace(/\/$/, '').toLowerCase();
  }
}

})(); // end guard IIFE
