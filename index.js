require('dotenv').config();
const path = require('path');
const express = require('express');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves index.html at GET /

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const VALID_SEVERITIES = ['low', 'medium', 'high'];
const VALID_ACTIONS = ['reminder', 'slack_alert', 'escalate', 'none'];

const FALLBACK_DECISION = {
  severity: 'medium',
  action: 'slack_alert',
  message: 'Needs manual review — AI response could not be parsed.',
};

if (!API_SECRET) console.warn('WARNING: API_SECRET is not set — /judge will reject every request.');
if (!GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY is not set — Gemini calls will fail.');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPrompt(type, client, item, strict) {
  const clientBlock = `Client: ${client.name}
Tier: ${client.tier}
Systems used: ${client.systems_used}
Escalation contact: ${client.escalation_contact}`;

  let itemBlock;
  if (type === 'invoice') {
    itemBlock = `Type: overdue invoice
Amount: ${item.amount}
Days overdue: ${item.days_overdue}`;
  } else {
    itemBlock = `Type: ops health issue
System: ${item.system}
Expected frequency: ${item.expected_frequency}
Last checked: ${item.last_checked}
Issue description: ${item.issue_description}`;
  }

  let prompt = `You are an operations triage agent for a marketing/creative agency.
Given the client and item details below, decide how urgent this issue is and what action to take.

${clientBlock}

${itemBlock}

Respond with ONLY valid JSON, no markdown code fences, no explanation, in exactly this shape:
{"severity": "low" | "medium" | "high", "action": "reminder" | "slack_alert" | "escalate" | "none", "message": "<one short sentence>"}`;

  if (strict) {
    prompt += '\n\nIMPORTANT: Return ONLY the raw JSON object. No markdown, no code fences, no extra text of any kind.';
  }
  return prompt;
}

function isValidDecision(obj) {
  return (
    obj &&
    typeof obj === 'object' &&
    VALID_SEVERITIES.includes(obj.severity) &&
    VALID_ACTIONS.includes(obj.action) &&
    typeof obj.message === 'string'
  );
}

function tryParseJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}

async function callGemini(prompt, attempt = 1) {
  const maxAttempts = 3;
  const backoffMs = [1000, 2000, 4000];

  let response;
  try {
    response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });
  } catch (err) {
    console.error('Gemini request failed:', err.message);
    return null;
  }

  if (response.status === 429 && attempt <= maxAttempts) {
    const wait = backoffMs[attempt - 1] || 4000;
    console.warn(`Gemini rate limited, retrying in ${wait}ms (attempt ${attempt})`);
    await sleep(wait);
    return callGemini(prompt, attempt + 1);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('Gemini API error:', response.status, errText);
    return null;
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('Failed to parse Gemini response body:', err.message);
    return null;
  }

  return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function judge(type, client, item) {
  const prompt = buildPrompt(type, client, item, false);

  let text = await callGemini(prompt);
  let parsed = tryParseJson(text);

  if (!isValidDecision(parsed)) {
    const stricterPrompt = buildPrompt(type, client, item, true);
    text = await callGemini(stricterPrompt);
    parsed = tryParseJson(text);
  }

  if (!isValidDecision(parsed)) {
    return FALLBACK_DECISION;
  }

  return parsed;
}

function validateRequestBody(body) {
  if (!body || (body.type !== 'invoice' && body.type !== 'ops')) {
    return 'Field "type" must be "invoice" or "ops".';
  }
  const { client, item } = body;
  if (!client || !client.name || !client.tier || !client.systems_used || !client.escalation_contact) {
    return 'Missing required "client" fields (name, tier, systems_used, escalation_contact).';
  }
  if (!item) {
    return 'Missing "item".';
  }
  if (body.type === 'invoice') {
    if (typeof item.amount !== 'number' || typeof item.days_overdue !== 'number') {
      return 'Invoice items require numeric "amount" and "days_overdue".';
    }
  } else {
    if (!item.system || !item.expected_frequency || !item.last_checked || !item.issue_description) {
      return 'Ops items require "system", "expected_frequency", "last_checked", and "issue_description".';
    }
  }
  return null;
}

app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Agency Judge API is running. Use /health or /judge.' });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/judge', async (req, res) => {
  try {
    const apiKey = req.header('x-api-key');
    if (!API_SECRET || apiKey !== API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const validationError = validateRequestBody(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const { type, client, item } = req.body;
    const decision = await judge(type, client, item);

    console.log(`[${new Date().toISOString()}] ${type} | ${client.name} -> ${decision.severity}/${decision.action}`);

    return res.status(200).json(decision);
  } catch (err) {
    console.error('Unhandled error in /judge:', err);
    return res.status(200).json(FALLBACK_DECISION);
  }
});

app.listen(PORT, () => {
  console.log(`agency-judge-api listening on port ${PORT}`);
});
