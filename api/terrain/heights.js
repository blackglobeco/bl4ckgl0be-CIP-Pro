/**
 * /api/terrain/heights — Terrain height lookup proxy (Re:Earth API).
 * GET ?points=lon,lat;lon,lat;...
 * No API key required.
 */

const MAX_POINTS = 100;
const TTL_MS = 24 * 3600_000;
const mem = new Map();

function parsePoints(raw) {
  if (!raw) return null;
  try {
    const pairs = raw.split(';').map(s => {
      const [lon, lat] = s.split(',').map(Number);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('invalid');
      return { lon, lat };
    });
    return pairs.length > 0 ? pairs : null;
  } catch { return null; }
}

async function fetchHeights(points) {
  const body = points.map(p => ({ lat: p.lat, lng: p.lon }));
  const res = await fetch('https://api.reearth.io/terrain-heights', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  const points = parsePoints(url.searchParams.get('points'));

  if (!points) {
    return res.status(400).json({ error: 'invalid points parameter — expected "lon,lat;lon,lat;…"' });
  }
  if (points.length > MAX_POINTS) {
    return res.status(400).json({ error: `too many points (${points.length}); max ${MAX_POINTS}` });
  }

  const cacheKey = points.map(p => `${p.lon},${p.lat}`).join(';');
  const entry = mem.get(cacheKey);
  const now = Date.now();

  if (entry && now - entry.at < TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(entry.data);
  }

  try {
    const data = await fetchHeights(points);
    mem.set(cacheKey, { at: now, data });
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) {
    if (entry) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json(entry.data);
    }
    return res.status(502).json({ error: err.message || 'terrain heights proxy error' });
  }
}
