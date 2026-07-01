const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const { checkLead } = require('./agent');

const HTML_DIR = path.join(__dirname, 'html-files');
const REJECTED_URLS_FILE = path.join(__dirname, '/html-files/to-be-deleted.json');
const { WRITE_CONTENTS_TO_FILE } = process.env;
// Load existing rejected URLs or initialize empty array
let rejectedUrls = [];
try {
  if (fs.existsSync(REJECTED_URLS_FILE)) {
    rejectedUrls = JSON.parse(fs.readFileSync(REJECTED_URLS_FILE, 'utf8'));
  }
} catch (err) {
  console.warn('[server] Could not load to-be-deleted.json:', err.message);
  rejectedUrls = [];
}

// In-memory lists reset at the start of each workflow run via POST /workflow-start.
let noActivityLeads = [];
let investigationLeads = [];

// ── DOM event debug log ───────────────────────────────────────────────────────
let lastDomEventTs = null;

function fmtDomEvent({ event, ts, ...data }) {
  const now  = ts || Date.now();
  const time = new Date(now).toTimeString().slice(0, 12);          // HH:MM:SS.mmm
  const elapsed = lastDomEventTs === null
    ? '   start'
    : `+${(now - lastDomEventTs).toString().padStart(5)}ms`;
  lastDomEventTs = now;

  const details = Object.entries(data)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');

  return `[dom] ${time}  ${elapsed}  ${event.padEnd(22)}  ${details}`;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Reset no-activity leads at the start of each workflow run
app.post('/workflow-start', (req, res) => {
  noActivityLeads = [];
  investigationLeads = [];
  rejectedUrls = [];
  lastDomEventTs = null;
  fs.writeFileSync(REJECTED_URLS_FILE, JSON.stringify([], null, 2));
  console.log('[workflow-start] Reset all lead lists');
  res.json({ ok: true });
});

app.post('/dom-event', (req, res) => {
  console.log(fmtDomEvent(req.body));
  res.json({ ok: true });
});

app.post('/mark-investigation', (req, res) => {
  const { url, reason } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  investigationLeads.push({ url, reason: reason || 'unknown' });
  console.log(`[mark-investigation] ${url} — ${reason}`);
  res.json({ ok: true });
});

app.get('/investigation-leads.csv', (req, res) => {
  const rows = [
    'LinkedIn URL,Reason',
    ...investigationLeads.map(l => `${l.url},"${l.reason.replace(/"/g, '""')}"`)
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

// Return the no-activity leads as a CSV for the user to download
app.get('/no-activity-leads.csv', (req, res) => {
  const rows = ['LinkedIn URL', ...noActivityLeads.map(l => l.url)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

app.post('/check-lead', async (req, res) => {
  const { profileHtml = '', companyHtml = '', activityHtml = '', url, workflow } = req.body;

  // Use workflow criteria as the job title if provided, otherwise default to "paralegal"
  const jobTitle = workflow?.criteria?.trim() || 'paralegal';

  console.log(`\n[check-lead] ─────────────────────────────────────`);
  console.log(`[check-lead] URL:           ${url}`);
  console.log(`[check-lead] Job title:     "${jobTitle}"`);
  console.log(`[check-lead] Profile HTML:  ${profileHtml.length} chars`);
  console.log(`[check-lead] Company HTML:  ${companyHtml.length} chars`);
  console.log(`[check-lead] Activity HTML: ${activityHtml.length} chars`);

  // Write HTMLs to files for inspection
  WRITE_CONTENTS_TO_FILE && [{ filename: 'profile', content: profileHtml, type: 'profile' },
   { filename: 'company', content: companyHtml, type: 'company' },
   { filename: 'activity', content: activityHtml, type: 'activity' }].forEach(writeToFile);

  try {
    const result = await checkLead(profileHtml, companyHtml, activityHtml, jobTitle);

    console.log(`\n[check-lead] Agent result:`);
    console.log(`  pass:           ${result.pass}`);
    console.log(`  currentTitle:   ${result.currentJobTitle}`);
    console.log(`  employeeCount:  ${result.employeeCount}`);
    console.log(`  recentActivity: ${result.recentActivity}`);
    console.log(`  reason:         ${result.reason}`);

    // Track leads that matched on title + company size but failed only due to no activity
    const titleMatched   = result.currentJobTitle !== null;
    const sizeMatched    = result.employeeCount === '2-10 employees' || !companyHtml.trim();
    if (!result.pass && !result.recentActivity && titleMatched && sizeMatched) {
      noActivityLeads.push({ url });
      console.log(`[check-lead] Added to no-activity leads: ${url}`);
    }

    // Track rejected profiles
    if (!result.pass) {
      if (!rejectedUrls.includes(url)) {
        rejectedUrls.push(url);
        fs.writeFileSync(REJECTED_URLS_FILE, JSON.stringify(rejectedUrls, null, 2));
        console.log(`[check-lead] Added to to-be-deleted.json: ${url}`);
      } else {
        console.log(`[check-lead] Already in to-be-deleted.json: ${url}`);
      }
    }

    console.log(`[check-lead] ─────────────────────────────────────\n`);

    res.json({ pass: result.pass, reason: result.reason });
  } catch (err) {
    console.error('[check-lead] Agent error:', err.message);
    // Fail safe: if the agent errors, do not remove the lead
    res.status(500).json({ pass: true, reason: `Agent error: ${err.message}` });
  }
});

function writeToFile({filename, content, type, url}) {
  const slug = url.replace(/https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '').replace(/[^a-z0-9-]/gi, '-');
  fs.writeFileSync(path.join(HTML_DIR, `${slug}-${type}.html`), content);
  console.log(`[check-lead] Wrote ${type} HTML to ${slug}-${type}.html`);
}

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`[server] Tracking rejected URLs to: ${REJECTED_URLS_FILE}`);
});
