// ── Backend selection via environment variables ────────────────────────────────
//
//   LLM_BACKEND          "local" (default) | "bedrock"
//
//   Local (OpenAI-compatible):
//     LOCAL_MODEL_URL    base URL for the inference server  (default: http://192.168.2.17:8884/v1)
//     LOCAL_MODEL_NAME   model alias to send in requests    (default: local)
//
//   Bedrock:
//     AWS_REGION         AWS region                         (default: us-east-1)
//     BEDROCK_MODEL_ID   Bedrock model ID                   (default: amazon.nova-lite-v1:0)
//
//   Credentials for Bedrock are resolved via the default AWS credential chain:
//   IAM role in production (ECS/EC2/Lambda), SSO session locally (aws sso login).

const logger = require('./logger');

const TITLE_CHECK_PROMPT = `You are a job title screener for a law firm recruiting tool.
You receive text from a LinkedIn profile's Experience section and a target job title.
Determine whether the person's CURRENT job title (most recent role) semantically matches the target.

Respond with a raw JSON object only — no markdown, no extra text.
Example: {"currentJobTitle":"Litigation Paralegal","pass":true}

Fields:
- currentJobTitle: string | null — the person's current job title as written, or null if not found
- pass: boolean — true if the current title is semantically in the same field as the target (e.g. "Legal Assistant", "Litigation Paralegal", "Paralegal Specialist" all match "paralegal"); false otherwise

Be strict: "IT Assistant", "Marketing Coordinator", "Office Manager" do NOT match "paralegal".`;

const SYSTEM_PROMPT = `You are a lead vetting assistant for a law firm recruiting tool.
You receive HTML from a LinkedIn profile's Experience section, optionally a company's About section, and optionally the most recent Activity post.
Extract the requested information and decide if the lead meets ALL criteria.

Respond with a raw JSON object — no markdown, no code fences, no extra text before or after. Example:
{"currentJobTitle":"Paralegal","employeeCount":"2-10 employees","sizeMatch":true,"recentActivity":true,"pass":true,"reason":"Title matches, small firm, active within the last month."}

Fields:
- currentJobTitle: string | null  — the person's CURRENT job title (most recent role in Experience)
- employeeCount: string | null    — the company's employee count range as written, or null if no company HTML
- sizeMatch: boolean              — true if company HTML was provided AND the employee count meets the size criterion; false if no company HTML or count is out of range
- recentActivity: boolean         — true if an activity post was provided AND its timestamp is within the last month; false if no activity or timestamp is older
- pass: boolean                   — true only if ALL applicable criteria below are met
- reason: string                  — one sentence explaining the decision

Criteria (ALL must be met to pass):
1. The current job title must semantically match the target title (allow variations like "Legal Assistant", "Litigation Paralegal", "Attorney at Law", etc.)
2. The company employee count must be between 0-10 employees. If no company HTML is provided, employeeCount is null, this criterion fails, and the lead does NOT pass — unverified company size is not acceptable.
3. Activity: if no activity HTML is provided, recentActivity is false and the lead fails.
  If activity HTML is provided, the section may list multiple activities. You must find ONLY the FIRST
  (most recent) timestamp and evaluate that one alone. Ignore all subsequent timestamps.
  Any engagement type qualifies: original posts, reposts, comments, likes.
  Timestamps look like "3w", "2d", "1mo", "4w". Find the first one that appears in the text.
  Rule: Xh, Xd, or Xw where X is 1–4 → recentActivity=true (PASS). "2mo" or higher → recentActivity=false (FAIL).
  "4w" explicitly PASSES — it is 4 weeks and 1mo is one month and should pass too.

If ANY criterion fails, pass must be false.`;

function parseResponse(raw) {
  // Strip DeepSeek-style <think>...</think> reasoning blocks
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    // Fallback: extract the first {...} block if the model added surrounding text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Unparseable response: ${cleaned.slice(0, 300)}`);
    parsed = JSON.parse(match[0]);
  }
  return {
    pass: !!parsed.pass,
    currentJobTitle: parsed.currentJobTitle ?? null,
    employeeCount: parsed.employeeCount ?? null,
    sizeMatch: !!parsed.sizeMatch,
    recentActivity: !!parsed.recentActivity,
    reason: parsed.reason ?? '',
  };
}

// ── Local (OpenAI-compatible) ──────────────────────────────────────────────────

async function checkLeadLocal(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const OpenAI = require('openai');
  const baseURL = process.env.LOCAL_MODEL_URL || 'http://192.168.2.17:8884/v1';
  const model   = process.env.LOCAL_MODEL_NAME || 'local';

  logger.debug('agent', `backend=local  url=${baseURL}  model=${model}`);

  const client = new OpenAI({ baseURL, apiKey: 'local' });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userMessage },
    ],
    temperature: 0,
    stream: false,
  });

  return response.choices[0].message.content || '';
}

// ── Bedrock ───────────────────────────────────────────────────────────────────

async function checkLeadBedrock(userMessage, systemPrompt = SYSTEM_PROMPT) {
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

  const region  = process.env.AWS_REGION       || 'us-east-1';
  const modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-lite-v1:0';

  logger.debug('agent', `backend=bedrock  region=${region}  modelId=${modelId}`);

  // Credentials come from the default chain: IAM role in prod,
  // SSO session / default profile locally (aws sso login).
  const client = new BedrockRuntimeClient({ region });

  const command = new ConverseCommand({
    modelId,
    system: [{ text: systemPrompt }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: { temperature: 0 },
  });

  const response = await client.send(command);
  return response.output?.message?.content?.[0]?.text || '';
}

// ── Public interface ──────────────────────────────────────────────────────────

async function checkTitle(profileHtml, jobTitle) {
  const userMessage = `Target job title: "${jobTitle}"\n\n--- EXPERIENCE SECTION ---\n${profileHtml}`;
  const backend = (process.env.LLM_BACKEND || 'local').toLowerCase();
  const raw = backend === 'bedrock'
    ? await checkLeadBedrock(userMessage, TITLE_CHECK_PROMPT)
    : await checkLeadLocal(userMessage, TITLE_CHECK_PROMPT);
  logger.debug('agent', `title-check raw: ${raw.slice(0, 200)}`);
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : { pass: false, currentJobTitle: null };
  }
  return { pass: !!parsed.pass, currentJobTitle: parsed.currentJobTitle ?? null };
}

async function checkLead(profileHtml, companyHtml, activityHtml, jobTitle) {
  const hasCompany  = companyHtml  && companyHtml.trim().length  > 0;
  const hasActivity = activityHtml && activityHtml.trim().length > 0;

  const userMessage =
    `Target job title: "${jobTitle}"\n\n` +
    `--- EXPERIENCE SECTION HTML ---\n${profileHtml}\n\n` +
    (hasCompany  ? `--- COMPANY ABOUT HTML ---\n${companyHtml}\n\n`    : '') +
    (hasActivity ? `--- MOST RECENT ACTIVITY POST ---\n${activityHtml}` : '(No activity provided — recentActivity must be false, lead fails)');

  const backend = (process.env.LLM_BACKEND || 'local').toLowerCase();
  const raw = backend === 'bedrock'
    ? await checkLeadBedrock(userMessage)
    : await checkLeadLocal(userMessage);

  logger.debug('agent', `raw response (first 300 chars): ${raw.slice(0, 300)}`);
  return parseResponse(raw);
  // return parseResponse({"currentJobTitle":"Paralegal","employeeCount":"2-10 employees","pass":true,"reason":"Current title matches and firm is small."});
}

module.exports = { checkLead, checkTitle };
