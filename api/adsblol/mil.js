/**
 * /api/adsblol/mil — adsb.lol military aircraft tracking proxy.
 * No API key required. Cached 30 seconds.
 */

let cache = null;
let cacheAt = 0;
const CACHE_MS = 30_000;

export default async function handler(req, res) {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-ADS-B-Cache', 'HIT');
    return res.status(200).send(cache);
  }

  try {
    const upstream = await fetch('https://api.adsb.lol/v2/mil', {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.text();
    if (upstream.ok) { cache = body; cacheAt = now; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-ADS-B-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    if (cache) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-ADS-B-Cache', 'STALE');
      return res.status(200).send(cache);
    }
    return res.status(502).json({ error: 'ADS-B proxy error' });
  }
}
