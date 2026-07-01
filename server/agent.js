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

const SYSTEM_PROMPT = `You are a lead vetting assistant for a law firm recruiting tool.
You receive HTML from a LinkedIn profile's Experience section, optionally a company's About section, and optionally the most recent Activity post.
Extract the requested information and decide if the lead meets ALL criteria.

Respond with a raw JSON object — no markdown, no code fences, no extra text before or after. Example:
{"currentJobTitle":"Paralegal","employeeCount":"2-10 employees","recentActivity":true,"pass":true,"reason":"Title matches, small firm, active within the last month."}

Fields:
- currentJobTitle: string | null  — the person's CURRENT job title (most recent role in Experience)
- employeeCount: string | null    — the company's employee count range as written (e.g. "2-10 employees"), or null if no company HTML
- recentActivity: boolean         — true if an activity post was provided AND its timestamp is within the last month; false if no activity or timestamp is older
- pass: boolean                   — true only if ALL applicable criteria below are met
- reason: string                  — one sentence explaining the decision

Criteria (ALL must be met to pass):
1. The current job title must semantically match the target title (allow variations like "Legal Assistant", "Litigation Paralegal", "Attorney at Law", etc.)
2. If company HTML is provided: the company employee count must be exactly "2-10 employees"
3. Activity: if no activity HTML is provided, recentActivity is false and the lead fails. 
  If activity HTML is provided, any engagement counts — original posts, reposts, comments, 
  and likes or any interaction found in this section all qualify. Find the timestamp (values like "3w", "2d", "1mo", "4w").
  Rule: Xh, Xd, or Xw where X is 1–4 → recentActivity=true (PASS). "1mo" or any higher value → recentActivity=false (FAIL). 
  "4w" explicitly PASSES — do not treat it as equivalent to 1 month.

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
    recentActivity: !!parsed.recentActivity,
    reason: parsed.reason ?? '',
  };
}

// ── Local (OpenAI-compatible) ──────────────────────────────────────────────────

async function checkLeadLocal(userMessage) {
  const OpenAI = require('openai');
  const baseURL = process.env.LOCAL_MODEL_URL || 'http://192.168.2.17:8884/v1';
  const model   = process.env.LOCAL_MODEL_NAME || 'local';

  console.log(`[agent] backend=local  url=${baseURL}  model=${model}`);

  const client = new OpenAI({ baseURL, apiKey: 'local' });
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userMessage },
    ],
    temperature: 0,
    stream: false,
  });

  return response.choices[0].message.content || '';
}

// ── Bedrock ───────────────────────────────────────────────────────────────────

async function checkLeadBedrock(userMessage) {
  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');

  const region  = process.env.AWS_REGION       || 'us-east-1';
  const modelId = process.env.BEDROCK_MODEL_ID || 'amazon.nova-lite-v1:0';

  console.log(`[agent] backend=bedrock  region=${region}  modelId=${modelId}`);

  // Credentials come from the default chain: IAM role in prod,
  // SSO session / default profile locally (aws sso login).
  const client = new BedrockRuntimeClient({ region });

  const command = new ConverseCommand({
    modelId,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: 'user', content: [{ text: userMessage }] }],
    inferenceConfig: { temperature: 0 },
  });

  const response = await client.send(command);
  return response.output?.message?.content?.[0]?.text || '';
}

// ── Public interface ──────────────────────────────────────────────────────────

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

  console.log(`[agent] raw response (first 300 chars): ${raw.slice(0, 300)}`);
  return parseResponse(raw);
  // return parseResponse({"currentJobTitle":"Paralegal","employeeCount":"2-10 employees","pass":true,"reason":"Current title matches and firm is small."});
}

module.exports = { checkLead };
