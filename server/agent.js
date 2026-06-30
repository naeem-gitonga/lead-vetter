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
You receive HTML from a LinkedIn profile's Experience section and optionally a LinkedIn company's About section.
Extract the requested information and decide if the lead meets the criteria.

Respond with a raw JSON object — no markdown, no code fences, no extra text before or after. Example:
{"currentJobTitle":"Paralegal","employeeCount":"2-10 employees","pass":true,"reason":"Current title matches and firm is small."}

Fields:
- currentJobTitle: string | null  — the person's CURRENT job title (most recent role in Experience)
- employeeCount: string | null    — the company's employee count range as written (e.g. "2-10 employees"), or null if no company HTML provided
- pass: boolean                   — true if criteria are met (see below)
- reason: string                  — one sentence explaining the decision

Criteria:
1. If company HTML is provided: The current job title must semantically match the target title AND the company employee count must be exactly "2-10 employees"
2. If company HTML is NOT provided (empty): The current job title must semantically match the target title (paralegal, attorney, or closely related roles like "Legal Assistant", "Litigation Paralegal", "Attorney at Law", etc.)

The target job title is: "paralegal" (but allow variations like attorney, legal assistant, litigation paralegal, etc.)

If criterion 1 (or 2 for no company) fails, pass must be false.`;

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

async function checkLead(profileHtml, companyHtml, jobTitle) {
  // If no company HTML, use a simpler prompt that only checks job title
  const hasCompanyHtml = companyHtml && companyHtml.trim().length > 0;
  
  const userMessage =
    `Target job title: "${jobTitle}"\n` +
    (hasCompanyHtml ? '' : '(No company information provided - only check job title)\n\n') +
    `--- EXPERIENCE SECTION HTML ---\n${profileHtml}\n\n` +
    (hasCompanyHtml ? `--- COMPANY ABOUT HTML ---\n${companyHtml}` : '');

  const backend = (process.env.LLM_BACKEND || 'local').toLowerCase();
  const raw = backend === 'bedrock'
    ? await checkLeadBedrock(userMessage)
    : await checkLeadLocal(userMessage);

  console.log(`[agent] raw response (first 300 chars): ${raw.slice(0, 300)}`);
  return parseResponse(raw);
}

module.exports = { checkLead };
