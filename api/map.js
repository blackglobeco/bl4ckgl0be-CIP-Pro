/**
 * /api/map — Map geometry and terrain proxies.
 *
 * Routes:
 *   POST /api/map/overpass               → Overpass API (OSM road geometry)
 *   GET  /api/map/route                  → OSRM routing directions
 *   GET  /api/map/terrain-heights        → Re:Earth terrain heights
 *   GET  /api/map/military-installations → OSM military land use
 */

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------
async function handleOverpass(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) return res.status(413).json({ error: 'query too large' }); chunks.push(chunk); }
  const query = Buffer.concat(chunks).toString('utf8').trim();
  if (!query) return res.status(400).json({ error: 'empty query' });
  try {
    const upstream = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(30_000) });
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > 4 * 1024 * 1024) return res.status(502).json({ error: 'response too large' });
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(upstream.status).send(Buffer.from(buf));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// OSRM Route
// ---------------------------------------------------------------------------
async function handleRoute(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const mode = url.searchParams.get('mode') || 'driving';
  const coords = url.searchParams.get('coordinates');
  if (!['driving', 'walking', 'cycling'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  if (!coords) return res.status(400).json({ error: 'coordinates required' });
  const pairs = coords.split(';');
  if (pairs.length < 2 || pairs.length > 25) return res.status(400).json({ error: 'need 2-25 coordinate pairs' });
  const osrmMode = mode === 'walking' ? 'foot' : mode === 'cycling' ? 'bike' : 'car';
  try {
    const upstream = await fetch(`https://router.project-osrm.org/route/v1/${osrmMode}/${encodeURIComponent(coords)}?overview=full&geometries=geojson&steps=false`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(15_000) });
    const buf = await upstream.arrayBuffer();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(upstream.status).send(Buffer.from(buf));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// Terrain heights
// ---------------------------------------------------------------------------
const terrainCache = new Map();
const TERRAIN_TTL = 24 * 3600_000;

async function handleTerrainHeights(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rawPoints = url.searchParams.get('points');
  if (!rawPoints) return res.status(400).json({ error: 'points required' });
  let points;
  try {
    points = rawPoints.split(';').map(s => { const [lon, lat] = s.split(',').map(Number); if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('invalid'); return { lon, lat }; });
  } catch { return res.status(400).json({ error: 'invalid points — expected "lon,lat;lon,lat"' }); }
  if (points.length > 100) return res.status(400).json({ error: 'max 100 points' });

  const cacheKey = points.map(p => `${p.lon},${p.lat}`).join(';');
  const now = Date.now();
  const entry = terrainCache.get(cacheKey);
  if (entry && now - entry.at < TERRAIN_TTL) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json(entry.data); }

  try {
    const r = await fetch('https://api.reearth.io/terrain-heights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(points.map(p => ({ lat: p.lat, lng: p.lon }))), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    terrainCache.set(cacheKey, { at: now, data });
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) {
    if (entry) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json(entry.data); }
    return res.status(502).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Military installations
// ---------------------------------------------------------------------------
const milCache = new Map();
const MIL_TTL = 3600_000;

async function handleMilitaryInstallations(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const url = new URL(req.url, 'http://localhost');
  const s = Number(url.searchParams.get('south')), w = Number(url.searchParams.get('west'));
  const n = Number(url.searchParams.get('north')), e = Number(url.searchParams.get('east'));
  if (![s, w, n, e].every(Number.isFinite) || n - s > 10 || e - w > 10 || n <= s || e <= w) return res.status(400).json({ error: 'Valid south/west/north/east bbox (max 10°) required' });

  const key = `${s.toFixed(2)},${w.toFixed(2)},${n.toFixed(2)},${e.toFixed(2)}`;
  const now = Date.now();
  const cached = milCache.get(key);
  if (cached && now - cached.at < MIL_TTL) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }

  try {
    const query = `[out:json][timeout:25];\n(\n  way["landuse"="military"](${s},${w},${n},${e});\n  relation["landuse"="military"](${s},${w},${n},${e});\n);\nout center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
    const data = await r.json();
    const payload = { status: 'ready', elements: data.elements || [], fetchedAt: now };
    milCache.set(key, { at: now, payload });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json({ ...cached.payload, status: 'stale' }); }
    return res.status(503).json({ error: 'Military installation context temporarily unavailable' });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/overpass')) return handleOverpass(req, res);
  if (path.endsWith('/route')) return handleRoute(req, res);
  if (path.includes('/terrain-heights')) return handleTerrainHeights(req, res);
  if (path.endsWith('/military-installations')) return handleMilitaryInstallations(req, res);
  return res.status(404).json({ error: 'not found' });
}
