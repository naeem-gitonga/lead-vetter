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
  let heyreachScrolled = false;

  try {
    await ensureContentScript(heyreachTabId);
    await sendToContentScript(heyreachTabId, { action: 'showStopButton' });

    await fetch(`${MOCK_SERVER}/workflow-start`, { method: 'POST' });

    broadcast({ step: 'extracting', message: 'Exporting leads from heyreach...' });

    const csvText = await fetchHeyreachCsv(heyreachTabId);
    const urls = parseLinkedInUrls(csvText);

    state.totalUrls = urls.length;
    broadcast({ step: 'processing', message: `Found ${urls.length} leads. Starting checks...`, current: 0, total: urls.length });

    let nextTabPromise = null; // pre-opened next tab — resolves during LLM inference

    for (let i = 0; i < urls.length; i++) {
      if (state.stopped) break;

      state.currentIndex = i;
      const url = urls[i];

      broadcast({ step: 'checking', message: `Checking lead ${i + 1} of ${urls.length}`, current: i + 1, total: urls.length });

      let linkedInTabId;
      if (nextTabPromise !== null) {
        try { linkedInTabId = await nextTabPromise; } catch (_) { linkedInTabId = null; }
        nextTabPromise = null;
        if (!linkedInTabId) linkedInTabId = await openTabAndWait(url, true);
      } else {
        linkedInTabId = await openTabAndWait(url, true);
      }
      await waitForLinkedInContent(linkedInTabId);
      await ensureContentScript(linkedInTabId);
      await sendToContentScript(linkedInTabId, { action: 'showStopButton' });

      // Scroll down in steps from the background script — each step scrolls the
      // page, waits for LinkedIn's IntersectionObserver to fire and render the
      // newly visible section, then checks if Experience is in the DOM.
      // ── Scroll and extract Experience ────────────────────────────────────────
      // Drive the loop from the background script (synchronous executeScript calls
      // + sleep here) so LinkedIn's JS cannot reset the scroll between our steps.
      // Activity sits directly above Experience — once Activity's bottom is fully
      // on screen, we pause and wait for Experience to render beneath it.
      let profileHtml = '';
      try {
        await chrome.tabs.update(linkedInTabId, { active: true });

        domEvent('profile_start', { url });

        let scrollY = 0;
        let activityTriggered = false;

        for (let i = 0; i < 60; i++) {
          scrollY += 300;

          domEvent('scroll', { y: scrollY });

          await chrome.scripting.executeScript({
            target: { tabId: linkedInTabId },
            func: (y) => {
              const main = document.querySelector('.scaffold-layout__main') ||
                           document.querySelector('main');
              if (main) main.scrollTo({ top: y, behavior: 'smooth' });
            },
            args: [scrollY],
          });

          await sleep(1000);

          const [{ result: state }] = await chrome.scripting.executeScript({
            target: { tabId: linkedInTabId },
            func: () => {
              const experience =
                document.querySelector('[componentkey$="ExperienceTopLevelSection"]') ||
                document.querySelector('section[aria-label="Experience"]');
              const activity = document.querySelector('[componentkey$="Activity"]');
              const activityRect = activity ? activity.getBoundingClientRect() : null;
              const main = document.querySelector('.scaffold-layout__main') ||
                           document.querySelector('main');
              return {
                text: experience ? experience.innerText.trim() : '',
                activityBottomVisible: activityRect
                  ? activityRect.bottom > 0 && activityRect.bottom <= window.innerHeight
                  : false,
                atBottom: main
                  ? main.scrollTop + main.clientHeight >= main.scrollHeight - 50
                  : window.scrollY + window.innerHeight >= document.body.scrollHeight - 50,
              };
            },
          });

          domEvent('dom_check', {
            exp: state.text ? `yes(${state.text.length}c)` : 'no',
            actBottom: state.activityBottomVisible ? 'yes' : 'no',
            atBottom: state.atBottom ? 'yes' : 'no',
          });

          if (state.text) {
            domEvent('experience_found', { chars: state.text.length });
            profileHtml = state.text;
            break;
          }

          if (state.atBottom) {
            domEvent('reached_bottom');
            break;
          }

          if (!activityTriggered && state.activityBottomVisible) {
            activityTriggered = true;
            domEvent('activity_visible_waiting');
            await sleep(1000);
            const [{ result: text }] = await chrome.scripting.executeScript({
              target: { tabId: linkedInTabId },
              func: () => {
                const el =
                  document.querySelector('[componentkey$="ExperienceTopLevelSection"]') ||
                  document.querySelector('section[aria-label="Experience"]');
                return el ? el.innerText.trim() : '';
              },
            });
            if (text) {
              domEvent('experience_found_after_activity', { chars: text.length });
              profileHtml = text;
              break;
            }
          }
        }
      } catch (err) {
        console.warn(`[background] Scroll-and-extract failed for ${url}:`, err.message);
      }

      // If the Experience section never appeared, flag for investigation — don't auto-delete
      if (!profileHtml) {
        console.warn(`[background] Could not load profile for ${url} — marking for investigation`);
        await fetch(`${MOCK_SERVER}/mark-investigation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, reason: 'Experience section not found after retry' }),
        });
        broadcast({ step: 'checking', message: `Flagged lead ${i + 1} of ${urls.length} for investigation`, current: i + 1, total: urls.length });
        await chrome.tabs.remove(linkedInTabId);
        continue;
      }

      console.log(`[background] Experience section text: ${profileHtml.length} chars for ${url}`);

      // ── Start loading the company About tab immediately in the background ──────
      // Kick this off before activity extraction so the tab loads while we're
      // still on the profile page, overlapping network time with DOM work.
      let companyHtml = '';
      let companyTabPromise = null;
      try {
        const [{ result: companyUrl }] = await chrome.scripting.executeScript({
          target: { tabId: linkedInTabId },
          func: () => {
            const links = document.querySelectorAll('a[href*="/company/"]');
            for (const link of links) {
              if (link.textContent.includes('Present')) return link.href;
            }
            return null;
          },
        });
        console.log(`[background] Company URL from DOM: ${companyUrl}`);
        if (companyUrl) {
          const aboutUrl = companyUrl.replace(/\/$/, '') + '/about/';
          companyTabPromise = openTabAndWait(aboutUrl, false);
        } else {
          console.log('[background] No company URL found in profile — skipping company check');
        }
      } catch (err) {
        console.warn(`[background] Company URL extraction failed for ${url}:`, err.message);
      }

      // ── Capture most recent Activity post ─────────────────────────────────────
      let activityHtml = '';
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: linkedInTabId },
          func: () => {
            const activityEl = document.querySelector('[componentkey$="Activity"]');
            if (!activityEl) return { text: '', reason: 'no_element' };
            if (activityEl.textContent.includes('no recent posts')) return { text: '', reason: 'no_recent_posts' };
            // Carousel container covers posts/reposts; comments/likes don't use it —
            // fall back to the full section text so the LLM still sees the timestamp.
            const firstPost = activityEl.querySelector('[data-testid="carousel-child-container"]');
            if (firstPost) return { text: firstPost.innerText.trim(), reason: 'carousel' };
            return { text: activityEl.innerText.trim(), reason: 'section_fallback' };
          },
        });
        activityHtml = result?.text || '';
        domEvent('activity_extract', { chars: activityHtml.length, reason: result?.reason || 'error' });
        console.log(`[background] Activity text: ${activityHtml.length} chars for ${url}`);
      } catch (err) {
        console.warn(`[background] Could not capture activity HTML for ${url}:`, err.message);
      }

      await chrome.tabs.remove(linkedInTabId);

      // ── Scrape the company About tab (was loading in background since we found the URL) ──
      if (companyTabPromise) {
        try {
          const companyTabId = await companyTabPromise;
          await waitForLinkedInContent(companyTabId);
          try {
            const [{ result }] = await chrome.scripting.executeScript({
              target: { tabId: companyTabId },
              func: () => {
                const section = document.querySelector('section.org-about-module__margin-bottom');
                if (section) return section.innerText.trim();
                return '';
              },
            });
            companyHtml = result || '';
            console.log(`[background] Company about text: ${companyHtml.length} chars`);
            if (!companyHtml) console.warn('[background] Company about section not found');
          } catch (err) {
            console.warn('[background] Could not capture company HTML:', err.message);
          }
          await chrome.tabs.remove(companyTabId);
        } catch (err) {
          console.warn(`[background] Company tab failed for ${url}:`, err.message);
        }
      }

      // Pre-open the next profile tab while the LLM processes this lead.
      // Tab HTML/JS loads during inference (~4s), eliminating the inter-lead gap.
      if (i + 1 < urls.length && !state.stopped) {
        nextTabPromise = openTabAndWait(urls[i + 1], false);
      }

      // ── Send both HTMLs to the server in one request ────────────────────────
      const checkRes = await fetch(`${MOCK_SERVER}/check-lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileHtml, companyHtml, activityHtml, workflow, url }),
      });
      const { pass } = await checkRes.json();

      if (!pass) {
        await ensureContentScript(heyreachTabId);
        if (!heyreachScrolled) {
          await sendToContentScript(heyreachTabId, { action: 'scrollToLoadAll' });
          heyreachScrolled = true;
        }

        // REMOVAL COMMENTED OUT
        // const result = await sendToContentScript(heyreachTabId, { action: 'removeLead', linkedInUrl: url });
        // if (result && !result.ok) {
        //   console.warn(`[background] removeLead failed for ${url}:`, result.error);
        //   broadcast({ step: 'error', message: `Remove failed: ${result.error}` });
        // }
      }
    }

    // Close any pre-opened tab that was never consumed (workflow stopped early)
    if (nextTabPromise) {
      nextTabPromise.then(id => chrome.tabs.remove(id).catch(() => {})).catch(() => {});
      nextTabPromise = null;
    }

    state.running = false;
    await sendToContentScript(heyreachTabId, { action: 'hideStopButton' });

    await downloadCsvIfNotEmpty('/no-activity-leads.csv', 'no-activity-leads.csv');
    await downloadCsvIfNotEmpty('/investigation-leads.csv', 'investigation-leads.csv');

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

async function downloadCsvIfNotEmpty(serverPath, filename) {
  try {
    const res = await fetch(`${MOCK_SERVER}${serverPath}`);
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length <= 1) return;

    // Blob URLs don't work in MV3 service workers — use a data URL instead
    const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    console.log(`[background] Downloaded ${filename} (${lines.length - 1} rows)`);
  } catch (err) {
    console.warn(`[background] Could not download ${filename}:`, err.message);
  }
}

// Fire-and-forget debug logger — does not block the workflow.
function domEvent(event, data = {}) {
  fetch(`${MOCK_SERVER}/dom-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ts: Date.now(), ...data }),
  }).catch(() => {});
}

function broadcast(data) {
  chrome.runtime.sendMessage({ action: 'workflowProgress', ...data }).catch(() => {
    // Popup is closed — nothing to do
  });
}

async function fetchHeyreachCsv(heyreachTabId) {
  const tab = await chrome.tabs.get(heyreachTabId);
  const pathMatch = new URL(tab.url).pathname.match(/\/my-list\/(\d+)/);
  if (!pathMatch) throw new Error('Navigate to a heyreach list page first');
  const listId = pathMatch[1];

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: heyreachTabId },
    func: async (listId) => {
      // Abp.AuthToken is not HttpOnly so document.cookie can read it
      const token = document.cookie
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('Abp.AuthToken='))
        ?.slice('Abp.AuthToken='.length);

      if (!token) return { error: 'Auth token not found in cookies' };

      // selectedOrganizationUnits is stored as a JSON-encoded string e.g. "145295"
      const orgRaw = localStorage.getItem('selectedOrganizationUnits');
      const orgUnits = orgRaw ? JSON.parse(orgRaw) : null;

      const headers = {
        'authorization': `Bearer ${token}`,
        'x-requested-with': 'XMLHttpRequest',
        'accept': 'application/json, text/plain, */*',
      };
      if (orgUnits) headers['x-organization-units'] = String(orgUnits);

      try {
        const resp = await fetch(
          `https://api.heyreach.io/api/LinkedInUserList/GetExportedUsersFromList?listId=${listId}`,
          { headers }
        );
        if (!resp.ok) return { error: `Export API returned ${resp.status}` };
        const csvText = await resp.text();
        return { csvText };
      } catch (err) {
        return { error: `Fetch failed: ${err.message}` };
      }
    },
    args: [listId],
  });

  if (!result || result.error) throw new Error(result?.error || 'Unknown error fetching heyreach CSV');
  return result.csvText;
}

function parseCsvLine(line) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) { out.push(current); current = ''; }
    else { current += ch; }
  }
  out.push(current);
  return out;
}

function parseLinkedInUrls(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const urlIdx = headers.findIndex(h => h.trim() === 'Profile URL');
  if (urlIdx === -1) return [];
  return lines.slice(1)
    .map(line => parseCsvLine(line)[urlIdx]?.trim())
    .filter(u => u && u.startsWith('https://www.linkedin.com/in/'))
    .map(u => u.replace(/\/$/, ''));
}
