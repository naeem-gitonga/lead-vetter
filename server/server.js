const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const logger    = require('./logger');
const { checkLead, checkTitle } = require('./agent');

const HTML_DIR = path.join(__dirname, 'html-files');
const REJECTED_URLS_FILE    = path.join(__dirname, 'html-files/to-be-deleted.json');
const PRIORITY_LEADS_FILE   = path.join(__dirname, 'html-files/priority-leads.json');
const NO_ACTIVITY_LEADS_FILE = path.join(__dirname, 'html-files/no-activity-leads.json');
const { WRITE_CONTENTS_TO_FILE } = process.env;

// Load existing rejected URLs or initialize empty array
let rejectedUrls = [];
try {
  if (fs.existsSync(REJECTED_URLS_FILE)) {
    rejectedUrls = JSON.parse(fs.readFileSync(REJECTED_URLS_FILE, 'utf8'));
  }
} catch (err) {
  logger.warn('server', `Could not load to-be-deleted.json: ${err.message}`);
  rejectedUrls = [];
}

// Priority leads — loaded from disk so a server restart doesn't lose mid-run data.
// Reset by POST /workflow-start at the beginning of each run.
let priorityLeads = [];
let csvHeaders    = '';
try {
  if (fs.existsSync(PRIORITY_LEADS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PRIORITY_LEADS_FILE, 'utf8'));
    priorityLeads = saved.leads  || [];
    csvHeaders    = saved.headers || '';
  }
} catch (err) {
  logger.warn('server', `Could not load priority-leads.json: ${err.message}`);
}

// No-activity leads — file-backed so a server restart mid-run doesn't lose data.
let noActivityLeads = [];
try {
  if (fs.existsSync(NO_ACTIVITY_LEADS_FILE)) {
    noActivityLeads = JSON.parse(fs.readFileSync(NO_ACTIVITY_LEADS_FILE, 'utf8'));
  }
} catch (err) {
  logger.warn('server', `Could not load no-activity-leads.json: ${err.message}`);
}

// In-memory only (short-lived per run).
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
  priorityLeads    = [];
  csvHeaders       = '';
  noActivityLeads  = [];
  investigationLeads = [];
  rejectedUrls     = [];
  lastDomEventTs   = null;
  fs.writeFileSync(REJECTED_URLS_FILE,    JSON.stringify([], null, 2));
  fs.writeFileSync(PRIORITY_LEADS_FILE,   JSON.stringify({ headers: '', leads: [] }, null, 2));
  fs.writeFileSync(NO_ACTIVITY_LEADS_FILE, JSON.stringify([], null, 2));
  logger.info('server', 'Reset all lead lists');
  res.json({ ok: true });
});

app.get('/ping', (req, res) => res.json({ ok: true }));

app.post('/dom-event', (req, res) => {
  logger.debug('dom', fmtDomEvent(req.body));
  res.json({ ok: true });``
});

app.post('/mark-investigation', (req, res) => {
  const { url, reason } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  investigationLeads.push({ url, reason: reason || 'unknown' });
  logger.info('investigation', `${url} — ${reason}`);
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

app.get('/priority-leads.csv', (req, res) => {
  let headers = csvHeaders;
  let leads   = priorityLeads;
  try {
    const saved = JSON.parse(fs.readFileSync(PRIORITY_LEADS_FILE, 'utf8'));
    headers = saved.headers || headers;
    leads   = saved.leads   || leads;
  } catch (_) {}
  const rows = headers ? [headers, ...leads].join('\n') : leads.join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

app.get('/no-activity-leads.csv', (req, res) => {
  let leads = noActivityLeads;
  try {
    leads = JSON.parse(fs.readFileSync(NO_ACTIVITY_LEADS_FILE, 'utf8'));
  } catch (_) {}
  const rows = ['LinkedIn URL', ...leads.map(l => l.url)].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.send(rows);
});

app.post('/check-lead', async (req, res) => {
  const { profileHtml = '', companyHtml = '', activityHtml = '', url, workflow, csvRow, csvHeaders: rowHeaders, titleOnly = false } = req.body;

  const jobTitle = workflow?.criteria?.trim() || 'paralegal';

  // ── Phase 1: title-only quick check ──────────────────────────────────────────
  if (titleOnly) {
    logger.debug('title-check', `${url} — "${jobTitle}"`);
    try {
      const result = await checkTitle(profileHtml, jobTitle);
      logger.debug('title-check', `pass=${result.pass}  title=${result.currentJobTitle}`);
      return res.json({ pass: result.pass, currentJobTitle: result.currentJobTitle });
    } catch (err) {
      logger.error('title-check', `Error: ${err.message}`);
      return res.json({ pass: true }); // fail open so we don't skip someone incorrectly
    }
  }

  // ── Phase 2: full check ───────────────────────────────────────────────────────
  logger.debug('\ncheck-lead', `────────────────────────────────────\n\nURL: ${url}\nJob title: ${jobTitle}\nProfile: ${profileHtml.length} chars\nCompany: ${companyHtml.length} chars\nActivity: ${activityHtml.length} chars`);

  WRITE_CONTENTS_TO_FILE && [{ filename: 'profile', content: profileHtml, type: 'profile' },
   { filename: 'company', content: companyHtml, type: 'company' },
   { filename: 'activity', content: activityHtml, type: 'activity' }].forEach(writeToFile);

  try {
    const result = await checkLead(profileHtml, companyHtml, activityHtml, jobTitle);

    logger.debug('check-lead', `Agent result: pass=${result.pass}, title=${result.currentJobTitle}, size=${result.employeeCount}, sizeMatch=${result.sizeMatch}, activity=${result.recentActivity}, reason=${result.reason}`);

    if (result.pass && csvRow) {
      if (rowHeaders && !csvHeaders) csvHeaders = rowHeaders;
      priorityLeads.push(csvRow);
      fs.writeFileSync(PRIORITY_LEADS_FILE, JSON.stringify({ headers: csvHeaders, leads: priorityLeads }, null, 2));
      logger.info('priority', `[${priorityLeads.length}] ${url}`);
    }
    logger.debug('\ncheck-lead', `────────────────────────────────────\n\n\n`);
    // Track leads that matched on title + company size but failed only due to no activity
    const titleMatched = result.currentJobTitle !== null;
    if (!result.pass && !result.recentActivity && titleMatched && result.sizeMatch) {
      noActivityLeads.push({ url });
      fs.writeFileSync(NO_ACTIVITY_LEADS_FILE, JSON.stringify(noActivityLeads, null, 2));
      logger.info('no-activity', `[${noActivityLeads.length}] ${url}`);
    }

    // Track rejected profiles
    if (!result.pass) {
      if (!rejectedUrls.includes(url)) {
        rejectedUrls.push(url);
        fs.writeFileSync(REJECTED_URLS_FILE, JSON.stringify(rejectedUrls, null, 2));
        logger.info('','______________________________________\n')
        logger.info('reject', url);
        logger.info('','\n______________________________________\n')
      } else {
        logger.debug('\n______________________________________\n')
        logger.debug('reject', `Already tracked: ${url}`);
        logger.debug('\n______________________________________\n')
      }
    }

    res.json({ pass: result.pass, reason: result.reason });
  } catch (err) {
    logger.error('check-lead', `Agent error: ${err.message}`);
    // Fail safe: if the agent errors, do not remove the lead
    res.status(500).json({ pass: true, reason: `Agent error: ${err.message}` });
  }
});

function writeToFile({filename, content, type, url}) {
  const slug = url.replace(/https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '').replace(/[^a-z0-9-]/gi, '-');
  fs.writeFileSync(path.join(HTML_DIR, `${slug}-${type}.html`), content);
  logger.debug('check-lead', `Wrote ${type} HTML to ${slug}-${type}.html`);
}

const PORT = 3000;
app.listen(PORT, () => {
  logger.info('server', `Server running at http://localhost:${PORT}`);
  logger.info('server', `Tracking rejected URLs to: ${REJECTED_URLS_FILE}`);
});
