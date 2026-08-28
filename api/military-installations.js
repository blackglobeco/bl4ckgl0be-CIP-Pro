/**
 * /api/military-installations — Military installation OSM features proxy.
 * GET /api/military-installations?south=...&west=...&north=...&east=...
 * Uses Overpass API (no key required).
 */

const MAX_BOX_DEG = 10;
const CACHE_MS = 60 * 60_000; // 1 hour
const cache = new Map();

function parseBox(params) {
  const s = Number(params.get('south'));
  const w = Number(params.get('west'));
  const n = Number(params.get('north'));
  const e = Number(params.get('east'));
  if (![s, w, n, e].every(Number.isFinite)) return null;
  if (n - s > MAX_BOX_DEG || e - w > MAX_BOX_DEG) return null;
  if (n <= s || e <= w) return null;
  return { south: s, west: w, north: n, east: e };
}

async function fetchInstallations(box) {
  const { south, west, north, east } = box;
  const query = `[out:json][timeout:25];
(
  way["landuse"="military"](${south},${west},${north},${east});
  relation["landuse"="military"](${south},${west},${north},${east});
);
out center tags;`;

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const url = new URL(req.url || '', 'http://localhost');
  const box = parseBox(url.searchParams);
  if (!box) {
    return res.status(400).json({ error: 'Valid south/west/north/east bbox (max 10°) required' });
  }

  const key = `${box.south.toFixed(2)},${box.west.toFixed(2)},${box.north.toFixed(2)},${box.east.toFixed(2)}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Military-Installations', 'HIT');
    return res.status(200).json({ ...cached.payload, status: 'cached' });
  }

  try {
    const data = await fetchInstallations(box);
    const payload = { status: 'ready', elements: data.elements || [], fetchedAt: now };
    cache.set(key, { at: now, payload });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('X-Military-Installations', 'MISS');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Military-Installations', 'STALE');
      return res.status(200).json({ ...cached.payload, status: 'stale' });
    }
    return res.status(503).json({ error: 'Military installation context temporarily unavailable' });
  }
}
