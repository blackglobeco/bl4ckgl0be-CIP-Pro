/**
 * /api/overpass — Overpass API proxy for OpenStreetMap road geometry.
 * POST /api/overpass  body: Overpass QL query text
 * No API key required.
 */

const MAX_BODY_BYTES = 8 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read body
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return res.status(413).json({ error: 'query too large' });
    chunks.push(chunk);
  }
  const query = Buffer.concat(chunks).toString('utf8').trim();
  if (!query) return res.status(400).json({ error: 'empty query' });

  try {
    const upstream = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(30_000),
    });

    const bodyBuf = await upstream.arrayBuffer();
    if (bodyBuf.byteLength > MAX_RESPONSE_BYTES) {
      return res.status(502).json({ error: 'upstream response too large' });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(upstream.status).send(Buffer.from(bodyBuf));
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Overpass proxy error' });
  }
}
