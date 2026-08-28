/**
 * /api/launches — Launch Library 2 recent rocket launches proxy.
 * Caches 15 minutes. No API key required (free tier).
 */

let cache = null;
let cacheAt = 0;
const TTL_MS = 15 * 60_000;
const MAX_BYTES = 12 * 1024 * 1024;

export default async function handler(req, res) {
  const now = Date.now();

  if (cache && now - cacheAt < TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.setHeader('X-GEV-Cache', 'HIT');
    return res.status(200).send(cache);
  }

  try {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');

    const headers = { Accept: 'application/json' };
    const token = process.env.LL2_API_TOKEN;
    if (token) headers.Authorization = `Token ${token}`;

    const upstream = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    const body = await upstream.text();
    if (upstream.ok) {
      cache = body;
      cacheAt = now;
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=900' : 'no-store');
    res.setHeader('X-GEV-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    if (cache) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-GEV-Cache', 'STALE-ERR');
      return res.status(200).send(cache);
    }
    return res.status(502).json({ error: err.message || 'Launches proxy error' });
  }
}
