const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const logger    = require('./logger');
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
  logger.warn('server', `Could not load to-be-deleted.json: ${err.message}`);
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
  logger.info('server', 'Reset all lead lists');
  res.json({ ok: true });
});

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

  logger.debug('\ncheck-lead', `────────────────────────────────────\n\nURL: ${url}\nJob title: ${jobTitle}\nProfile: ${profileHtml.length} chars\nCompany: ${companyHtml.length} chars\nActivity: ${activityHtml.length} chars`);

  // Write HTMLs to files for inspection
  WRITE_CONTENTS_TO_FILE && [{ filename: 'profile', content: profileHtml, type: 'profile' },
   { filename: 'company', content: companyHtml, type: 'company' },
   { filename: 'activity', content: activityHtml, type: 'activity' }].forEach(writeToFile);

  try {
    const result = await checkLead(profileHtml, companyHtml, activityHtml, jobTitle);

    logger.debug('check-lead', `Agent result: pass=${result.pass}, title=${result.currentJobTitle}, companySize=${result.employeeCount}, activity=${result.recentActivity}, reason=${result.reason}`);
    logger.debug('\ncheck-lead', `────────────────────────────────────\n\n\n`);
    // Track leads that matched on title + company size but failed only due to no activity
    const titleMatched   = result.currentJobTitle !== null;
    const sizeMatched    = result.employeeCount === '2-10 employees' || !companyHtml.trim();
    if (!result.pass && !result.recentActivity && titleMatched && sizeMatched) {
      noActivityLeads.push({ url });
      logger.info('\nno-activity', url);
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
