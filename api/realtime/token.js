/**
 * /api/realtime/token — OpenAI Realtime ephemeral session token proxy.
 * GET or POST /api/realtime/token?tier=standard|mini
 * Requires OPENAI_API_KEY env var.
 */

const MODEL_DEFAULT = 'gpt-4o-realtime-preview-2024-12-17';
const MODEL_MINI_DEFAULT = 'gpt-4o-mini-realtime-preview-2024-12-17';
const VOICE_DEFAULT = 'alloy';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not set' });

  const url = new URL(req.url || '', 'http://localhost');
  const requestedTier = url.searchParams.get('tier');
  const isMini = requestedTier === 'mini';
  const model = isMini
    ? (process.env.OPENAI_REALTIME_MODEL_MINI || MODEL_MINI_DEFAULT)
    : (process.env.OPENAI_REALTIME_MODEL || MODEL_DEFAULT);
  const voice = process.env.OPENAI_REALTIME_VOICE || VOICE_DEFAULT;
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || 'low';

  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'low',
            create_response: true,
            interrupt_response: false,
          },
        },
        output: { voice },
      },
      instructions: "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View. Have a natural spoken conversation with the user while the mic session is active. Only control the app by calling the provided tools.",
      tool_choice: 'auto',
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': 'gev-vercel-deploy',
      },
      body: JSON.stringify(sessionConfig),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.text();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
    res.setHeader('X-GEV-Voice-Tier', isMini ? 'mini' : 'standard');
    res.setHeader('X-GEV-Voice-Model', model);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(response.status).send(body);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Realtime token proxy error' });
  }
}
