const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const { checkLead } = require('./agent');

const HTML_DIR = path.join(__dirname, 'html-files');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Throwaway URL extraction — regex pulls linkedin.com/in/ paths from raw HTML.
// Will be replaced by the real AI-based server later.
app.post('/extract-urls', (req, res) => {
  const html    = req.body.html || '';
  const regex   = /https?:\/\/(?:www\.)?linkedin\.com\/in\/[\w%-]+\/?/g;
  const matches = html.match(regex) || [];

  const urls = [...new Set(matches.map(u => u.replace(/\/$/, '')))];

  console.log(`[extract-urls] Found ${urls.length} LinkedIn URLs`);
  urls.forEach(u => console.log(`  ${u}`));

  res.json({ urls });
});

app.post('/check-lead', async (req, res) => {
  const { profileHtml = '', companyHtml = '', url, workflow } = req.body;

  // Use workflow criteria as the job title if provided, otherwise default to "paralegal"
  const jobTitle = workflow?.criteria?.trim() || 'paralegal';

  console.log(`\n[check-lead] ─────────────────────────────────────`);
  console.log(`[check-lead] URL:          ${url}`);
  console.log(`[check-lead] Job title:    "${jobTitle}"`);
  console.log(`[check-lead] Profile HTML: ${profileHtml.length} chars`);
  console.log(`[check-lead] Company HTML: ${companyHtml.length} chars`);

  // Write HTMLs to files for inspection
  const slug = url.replace(/https?:\/\/(www\.)?linkedin\.com\/in\//, '').replace(/\/$/, '').replace(/[^a-z0-9-]/gi, '-');
  if (profileHtml) {
    fs.writeFileSync(path.join(HTML_DIR, `${slug}-profile.html`), profileHtml);
    console.log(`[check-lead] Wrote profile HTML to ${slug}-profile.html`);
  }
  if (companyHtml) {
    fs.writeFileSync(path.join(HTML_DIR, `${slug}-company.html`), companyHtml);
    console.log(`[check-lead] Wrote company HTML to ${slug}-company.html`);
  }

  try {
    const result = await checkLead(profileHtml, companyHtml, jobTitle);

    console.log(`\n[check-lead] Agent result:`);
    console.log(`  pass:          ${result.pass}`);
    console.log(`  currentTitle:  ${result.currentJobTitle}`);
    console.log(`  employeeCount: ${result.employeeCount}`);
    console.log(`  reason:        ${result.reason}`);
    console.log(`[check-lead] ─────────────────────────────────────\n`);

    res.json({ pass: result.pass, reason: result.reason });
  } catch (err) {
    console.error('[check-lead] Agent error:', err.message);
    // Fail safe: if the agent errors, do not remove the lead
    res.status(500).json({ pass: true, reason: `Agent error: ${err.message}` });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
