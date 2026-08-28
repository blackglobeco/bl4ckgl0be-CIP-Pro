/**
 * /api/celestrak/[group] — CelesTrak TLE orbital elements proxy.
 *
 * Caches TLE data for 2 hours in memory (within a warm serverless instance).
 * Route: GET /api/celestrak/active  →  fetches GP data for "active" group
 */

const TLE_TTL_MS = 2 * 3600_000; // 2 hours
const mem = new Map();

async function fetchUpstream(group) {
  const url = `https://celestrak.org/SOCRATES/query.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
  const gp = `https://celestrak.org/SOCRATES/query.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
  // Primary: GP endpoint (JSON)
  const primary = `https://celestrak.org/SOCRATES/query.php?GROUP=${encodeURIComponent(group)}&FORMAT=TLE`;
  const gpUrl = `https://celestrak.org/pub/TLE/${encodeURIComponent(group)}.txt`;
  const r = await fetch(gpUrl, {
    headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`CelesTrak HTTP ${r.status}`);
  const body = await r.text();
  if (!body.trim()) throw new Error('empty TLE response');
  return body;
}

export default async function handler(req, res) {
  // Strip leading slash, ignore query string to get group name
  const group = (req.url || '').replace(/^\//, '').split('?')[0];

  if (!/^[a-z0-9._-]+$/i.test(group)) {
    return res.status(400).send('invalid group');
  }

  const send = (status, body, cacheStatus) => {
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('x-tle-cache', cacheStatus);
    res.status(status).send(body);
  };

  const now = Date.now();
  const entry = mem.get(group);
  if (entry && now - entry.at < TLE_TTL_MS) {
    return send(200, entry.body, 'HIT');
  }

  try {
    const body = await fetchUpstream(group);
    mem.set(group, { at: now, body });
    return send(200, body, 'MISS');
  } catch (err) {
    console.error('[celestrak]', err.message);
    if (entry) return send(200, entry.body, 'STALE-ERR');
    return send(502, `CelesTrak fetch failed: ${err.message}`, 'NONE');
  }
}
