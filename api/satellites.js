/**
 * /api/satellites — Satellite-related proxies.
 *
 * Routes:
 *   GET /api/satellites/celestrak/[group]  → CelesTrak TLE data
 *   GET /api/satellites/launches            → Launch Library 2 recent launches
 */

// ---------------------------------------------------------------------------
// CelesTrak
// ---------------------------------------------------------------------------
const TLE_TTL_MS = 2 * 3600_000;
const tleMem = new Map();

async function handleCelesTrak(req, res) {
  // Extract group from path: /api/satellites/celestrak/active → "active"
  const group = (req.url || '').replace(/.*\/celestrak\//, '').split('?')[0];
  if (!/^[a-z0-9._-]+$/i.test(group)) return res.status(400).send('invalid group');

  const now = Date.now();
  const entry = tleMem.get(group);
  if (entry && now - entry.at < TLE_TTL_MS) {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('x-tle-cache', 'HIT');
    return res.status(200).send(entry.body);
  }
  try {
    const r = await fetch(`https://celestrak.org/pub/TLE/${encodeURIComponent(group)}.txt`, {
      headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text();
    if (!body.trim()) throw new Error('empty response');
    tleMem.set(group, { at: now, body });
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('x-tle-cache', 'MISS');
    return res.status(200).send(body);
  } catch (err) {
    if (entry) { res.setHeader('Content-Type', 'text/plain'); res.setHeader('x-tle-cache', 'STALE-ERR'); return res.status(200).send(entry.body); }
    return res.status(502).send(`CelesTrak fetch failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Launch Library 2
// ---------------------------------------------------------------------------
let _launchCache = null, _launchCacheAt = 0;
const LAUNCH_TTL_MS = 15 * 60_000;

async function handleLaunches(req, res) {
  const now = Date.now();
  if (_launchCache && now - _launchCacheAt < LAUNCH_TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.setHeader('X-GEV-Cache', 'HIT');
    return res.status(200).send(_launchCache);
  }
  try {
    const end = new Date(), start = new Date(end.getTime() - 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', start.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');
    const headers = { Accept: 'application/json' };
    const token = process.env.LL2_API_TOKEN;
    if (token) headers.Authorization = `Token ${token}`;
    const upstream = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(20_000) });
    const body = await upstream.text();
    if (upstream.ok) { _launchCache = body; _launchCacheAt = now; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=900' : 'no-store');
    res.setHeader('X-GEV-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    if (_launchCache) { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-GEV-Cache', 'STALE-ERR'); return res.status(200).send(_launchCache); }
    return res.status(502).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.includes('/celestrak/')) return handleCelesTrak(req, res);
  if (path.endsWith('/launches')) return handleLaunches(req, res);
  return res.status(404).json({ error: 'not found' });
}
