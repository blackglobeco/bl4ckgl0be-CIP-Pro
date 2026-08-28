/**
 * /api/openai/hud-summary — OpenAI intelligence HUD summary proxy.
 * POST /api/openai/hud-summary  body: JSON scene context
 * Requires OPENAI_API_KEY env var.
 */

const MAX_BODY_BYTES = 64 * 1024;
const MODEL_DEFAULT = 'gpt-4o-mini';

function toFiveWordSummary(text) {
  if (!text) return null;
  const words = text.trim().replace(/[^\w\s'-]/g, '').split(/\s+/).slice(0, 5);
  return words.length > 0 ? words.join(' ') : null;
}

function extractText(data) {
  // OpenAI Responses API
  if (Array.isArray(data?.output)) {
    for (const item of data.output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) return c.text;
        }
      }
    }
  }
  // Chat completions API fallback
  return data?.choices?.[0]?.message?.content || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not set' });

  // Read body
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return res.status(413).json({ error: 'request too large' });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');

  let context;
  try { context = JSON.parse(body || '{}'); } catch { context = {}; }

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_HUD_SUMMARY_MODEL || MODEL_DEFAULT,
        instructions: [
          "Write one concise intelligence-HUD summary for God's Eye View.",
          'Use only the supplied place, street, nearby-place, and enabled-layer text labels.',
          'Prefer the clearest named place and include a relevant enabled layer only when useful.',
          'Do not infer from coordinates or invent a place.',
          'Output exactly five words with no title, punctuation, markdown, or introductory phrase.',
        ].join(' '),
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
  } catch (err) {
    return res.status(502).json({ error: err.message || 'HUD summary proxy error' });
  }
}
