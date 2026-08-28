/**
 * /api/openai — All OpenAI proxies in one function.
 *
 * Routes:
 *   GET|POST /api/openai/realtime-token   → ephemeral Realtime session token
 *   POST     /api/openai/debug-log        → log Realtime debug events
 *   POST     /api/openai/hud-summary      → 5-word HUD AI summary
 */

const MODEL_DEFAULT = 'gpt-4o-realtime-preview-2024-12-17';
const MODEL_MINI_DEFAULT = 'gpt-4o-mini-realtime-preview-2024-12-17';
const VOICE_DEFAULT = 'alloy';
const HUD_MODEL_DEFAULT = 'gpt-4o-mini';
const MAX_BODY = 64 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toFiveWordSummary(text) {
  if (!text) return null;
  const words = text.trim().replace(/[^\w\s'-]/g, '').split(/\s+/).slice(0, 5);
  return words.length > 0 ? words.join(' ') : null;
}

function extractText(data) {
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) return c.text;
        }
      }
    }
  }
  return data?.choices?.[0]?.message?.content || null;
}

async function handleRealtimeToken(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not set' });

  const url = new URL(req.url, 'http://localhost');
  const isMini = url.searchParams.get('tier') === 'mini';
  const model = isMini
    ? (process.env.OPENAI_REALTIME_MODEL_MINI || MODEL_MINI_DEFAULT)
    : (process.env.OPENAI_REALTIME_MODEL || MODEL_DEFAULT);
  const voice = process.env.OPENAI_REALTIME_VOICE || VOICE_DEFAULT;
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || 'low';

  const sessionConfig = {
    session: {
      type: 'realtime', model,
      reasoning: { effort },
      audio: {
        input: { noise_reduction: { type: 'near_field' }, turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false } },
        output: { voice },
      },
      instructions: "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View. Have a natural spoken conversation with the user while the mic session is active. Only control the app by calling the provided tools.",
      tool_choice: 'auto',
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Safety-Identifier': 'gev-vercel-deploy' },
      body: JSON.stringify(sessionConfig),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('X-GEV-Voice-Tier', isMini ? 'mini' : 'standard');
    res.setHeader('X-GEV-Voice-Model', model);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(response.status).send(body);
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

async function handleDebugLog(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const body = await readBody(req);
    const record = JSON.parse(body || '{}');
    console.log('[realtime-debug]', JSON.stringify({ loggedAt: new Date().toISOString(), ...record }));
    return res.status(204).end();
  } catch { return res.status(400).json({ error: 'invalid JSON' }); }
}

async function handleHudSummary(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not set' });
  try {
    const body = await readBody(req);
    const context = JSON.parse(body || '{}');
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_HUD_SUMMARY_MODEL || HUD_MODEL_DEFAULT,
        instructions: "Write one concise intelligence-HUD summary for God's Eye View. Use only the supplied place, street, nearby-place, and enabled-layer text labels. Output exactly five words with no title, punctuation, markdown, or introductory phrase.",
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => ({}));
    const summary = toFiveWordSummary(extractText(data));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(response.ok && summary ? 200 : response.status || 502).json({
      summary: summary || null,
      error: response.ok ? null : data.error?.message || 'OpenAI request failed',
    });
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/realtime-token')) return handleRealtimeToken(req, res);
  if (path.endsWith('/debug-log')) return handleDebugLog(req, res);
  if (path.endsWith('/hud-summary')) return handleHudSummary(req, res);
  return res.status(404).json({ error: 'not found' });
}
