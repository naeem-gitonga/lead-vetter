const MOCK_SERVER = 'http://localhost:3000';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Strips script blocks, style blocks, stylesheet links, and inline style attributes
// from raw HTML before sending to the server. Reduces payload from ~1.5 MB to ~100–200 KB.
function cleanHtml(html) {
  return html
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]+rel=["']?stylesheet["']?[^>]*\/?>/gi, '')
    .replace(/\s+style="[^"]*"/gi, '')
    .replace(/\s+style='[^']*'/gi, '');
}

// In-memory workflow state.
// Note: MV3 service workers may be terminated when idle; state resets on restart.
let state = {
  running: false,
  stopped: false,
  workflow: null,
  currentIndex: 0,
  totalUrls: 0,
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'runWorkflow') {
    runWorkflow(msg.workflow, msg.tabId);
    sendResponse({ ok: true });
  } else if (msg.action === 'stopWorkflow') {
    state.stopped = true;
    sendResponse({ ok: true });
  } else if (msg.action === 'getWorkflowState') {
    sendResponse({ ...state });
  }
  return true;
});

async function runWorkflow(workflow, heyreachTabId) {
  state = { running: true, stopped: false, workflow, currentIndex: 0, totalUrls: 0 };

  try {
    await ensureContentScript(heyreachTabId);
    await sendToContentScript(heyreachTabId, { action: 'showStopButton' });

    broadcast({ step: 'extracting', message: 'Reading leads from page...' });

    // Grab the full HTML from the active heyreach tab
    const [{ result: pageHtml }] = await chrome.scripting.executeScript({
      target: { tabId: heyreachTabId },
      func: () => document.documentElement.outerHTML,
    });

    // Ask the mock server to extract LinkedIn URLs
    const extractRes = await fetch(`${MOCK_SERVER}/extract-urls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: pageHtml }),
    });
    const { urls } = await extractRes.json();

    state.totalUrls = urls.length;
    broadcast({ step: 'processing', message: `Found ${urls.length} leads. Starting checks...`, current: 0, total: urls.length });

    for (let i = 0; i < urls.length; i++) {
      if (state.stopped) break;

      state.currentIndex = i;
      const url = urls[i];

      broadcast({ step: 'checking', message: `Checking lead ${i + 1} of ${urls.length}`, current: i + 1, total: urls.length });

      // Open the LinkedIn profile tab in the foreground so window.scrollTo
      // triggers LinkedIn's IntersectionObserver lazy-loading.
      const linkedInTabId = await openTabAndWait(url, true);
      await waitForLinkedInContent(linkedInTabId);

      // Scroll to the bottom then wait 5 s for the Experience section to render.
      await chrome.scripting.executeScript({
        target: { tabId: linkedInTabId },
        func: () => window.scrollTo(0, document.body.scrollHeight),
      });
      console.log('[background] Scrolled profile page — waiting 5 s for lazy content...');
      await sleep(5000);

      // ── Capture LinkedIn Experience section HTML (after lazy content has loaded) ──
      let profileHtml = '';
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: linkedInTabId },
          func: () => {
            // LinkedIn SDUI: componentkey ends with "Experience"
            const bySdui = document.querySelector('[componentkey$="Experience"]');
            if (bySdui) {
              const section = bySdui.closest('section') || bySdui;
              return section.outerHTML;
            }
            // Fallback: section with aria-label="Experience"
            const byLabel = document.querySelector('section[aria-label="Experience"]');
            if (byLabel) return byLabel.outerHTML;
            // Fallback: find <h2> whose text is exactly "Experience"
            for (const h2 of document.querySelectorAll('h2')) {
              if (h2.textContent.trim() === 'Experience') {
                const section = h2.closest('section');
                if (section) return section.outerHTML;
              }
            }
            return '';
          },
        });
        profileHtml = cleanHtml(result || '');
        console.log(`[background] Experience section HTML: ${profileHtml.length} chars for ${url}`);
        if (!profileHtml) console.warn(`[background] Experience section not found for ${url}`);
      } catch (err) {
        console.warn(`[background] Could not capture profile HTML for ${url}:`, err.message);
      }

      // ── Find the company URL from the live DOM (Experience is now rendered) ──
      let companyHtml = '';
      try {
        const [{ result: companyUrl }] = await chrome.scripting.executeScript({
          target: { tabId: linkedInTabId },
          func: () => {
            const links = document.querySelectorAll('a[href*="/company/"]');
            for (const link of links) {
              if (link.textContent.includes('Present')) {
                return link.href;
              }
            }
            return null;
          },
        });
        console.log(`[background] Company URL from DOM: ${companyUrl}`);

        if (companyUrl) {

          // Navigate directly to the About page by appending /about/
          const aboutUrl = companyUrl.replace(/\/$/, '') + '/about/';
          const companyTabId = await openTabAndWait(aboutUrl);
          await waitForLinkedInContent(companyTabId);

          try {
            const [{ result }] = await chrome.scripting.executeScript({
              target: { tabId: companyTabId },
              func: () => {
                // Classic LinkedIn company about page wraps description + structured
                // data (industry, company size, headquarters, etc.) in this section.
                const section = document.querySelector('section.org-about-module__margin-bottom');
                if (section) return section.outerHTML;
                return '';
              },
            });
            companyHtml = cleanHtml(result || '');
            console.log(`[background] Company about HTML: ${companyHtml.length} chars`);
            if (!companyHtml) console.warn('[background] Company about section not found');
          } catch (err) {
            console.warn('[background] Could not capture company HTML:', err.message);
          }

          await chrome.tabs.remove(companyTabId);
        } else {
          console.log('[background] No company URL found in profile — skipping company check');
        }
      } catch (err) {
        console.warn(`[background] Company URL extraction failed for ${url}:`, err.message);
      }

      await chrome.tabs.remove(linkedInTabId);

      // ── Send both HTMLs to the server in one request ────────────────────────
      const checkRes = await fetch(`${MOCK_SERVER}/check-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileHtml, companyHtml, workflow, url }),
      });
      const { pass } = await checkRes.json();

      if (!pass) {
        broadcast({ step: 'removing', message: `Removing lead ${i + 1} of ${urls.length}`, current: i + 1, total: urls.length });

        // Guarantee the content script is present — it won't be on tabs that were
        // already open when the extension was first loaded.
        await ensureContentScript(heyreachTabId);

        const result = await sendToContentScript(heyreachTabId, { action: 'removeLead', linkedInUrl: url });
        if (result && !result.ok) {
          console.warn(`[background] removeLead failed for ${url}:`, result.error);
          broadcast({ step: 'error', message: `Remove failed: ${result.error}` });
        }
      }
    }

    state.running = false;
    await sendToContentScript(heyreachTabId, { action: 'hideStopButton' });
    broadcast({ step: 'done', message: `Done. Processed ${urls.length} leads.`, current: urls.length, total: urls.length });

  } catch (err) {
    state.running = false;
    await sendToContentScript(heyreachTabId, { action: 'hideStopButton' });
    broadcast({ step: 'error', message: `Error: ${err.message}` });
  }
}

// Polls the LinkedIn tab until the profile's main content section exists in the DOM,
// or bails out after a timeout so the workflow never hangs indefinitely.
async function waitForLinkedInContent(tabId, timeoutMs = 10000) {
  const interval = 500;
  const attempts = Math.ceil(timeoutMs / interval);

  for (let i = 0; i < attempts; i++) {
    try {
      const [{ result: ready }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(
          document.querySelector('main') ||
          document.querySelector('.scaffold-layout__main') ||
          document.querySelector('#profile-content') ||
          document.querySelector('section.artdeco-card')
        ),
      });

      if (ready) {
        console.log(`[background] LinkedIn content ready after ~${(i + 1) * interval}ms`);
        return;
      }
    } catch (_) {
      // Tab may still be loading — keep polling
    }

    await sleep(interval);
  }

  console.warn('[background] LinkedIn content did not appear within timeout — capturing whatever is there');
}

// Opens a tab and resolves with its tabId once fully loaded.
// Pass active=true to bring the tab to the foreground (needed for scroll-triggered lazy loading).
function openTabAndWait(url, active = false) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const tabId = tab.id;

      // 30-second timeout — resolve anyway so the loop can continue
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tabId);
      }, 30000);

      const listener = (id, changeInfo) => {
        if (id === tabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tabId);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// Injects content.js into a tab only if it isn't already running there.
async function ensureContentScript(tabId) {
  try {
    const [{ result: active }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__leadVetterActive,
    });

    if (!active) {
      console.log('[background] Content script not found — injecting now');
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    }
  } catch (err) {
    console.warn('[background] ensureContentScript failed:', err.message);
  }
}

// Sends a message to the content script and returns its response.
// Errors are surfaced as { ok: false, error } rather than swallowed.
function sendToContentScript(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[background] sendToContentScript error:', chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(response ?? { ok: true });
      }
    });
  });
}

function broadcast(data) {
  chrome.runtime.sendMessage({ action: 'workflowProgress', ...data }).catch(() => {
    // Popup is closed — nothing to do
  });
}
