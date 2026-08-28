/**
 * /api/feeds — Live feed proxies.
 *
 * Routes:
 *   GET /api/feeds/ais-live  → AIS vessel positions (degraded on serverless)
 *   GET /api/feeds/cctv      → CCTV traffic cameras
 *   GET /api/feeds/gbfs/...  → GBFS bike-share stations
 *   GET /api/feeds/radio/... → Radio Browser station directory
 */

// ---------------------------------------------------------------------------
// AIS live (degraded — WebSocket not supported in serverless)
// ---------------------------------------------------------------------------
async function handleAisLive(req, res) {
  const hasKey = Boolean(process.env.AISSTREAM_API_KEY);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (!hasKey) return res.status(503).json({ rows: [], source: 'AISStream', status: 'no_key', error: 'AISSTREAM_API_KEY not configured', refreshing: false, newestPositionAt: null, lastMessageAt: null });
  return res.status(200).json({ rows: [], source: 'AISStream', status: 'degraded', error: 'AIS live feed requires a persistent server; deploy on Railway or Render for full AIS support.', refreshing: true, newestPositionAt: null, lastMessageAt: null });
}

// ---------------------------------------------------------------------------
// CCTV
// ---------------------------------------------------------------------------
let cctvCache = null, cctvCacheAt = 0;
const CCTV_TTL = 5 * 60_000;

async function handleCctv(req, res) {
  const now = Date.now();
  if (cctvCache && now - cctvCacheAt < CCTV_TTL) {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cctvCache);
  }
  try {
    const r = await fetch('https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=100&$select=camera_id,location_latitude,location_longitude,camera_status', { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    const sources = rows.filter(row => row.camera_status === 'TURNED_ON' && row.location_latitude && row.location_longitude).slice(0, 36).map(row => ({ id: `austin-${row.camera_id}`, name: `Austin Camera ${row.camera_id}`, latitude: parseFloat(row.location_latitude), longitude: parseFloat(row.location_longitude), type: 'cctv', source: 'austin' }));
    cctvCache = { sources, fetchedAt: now };
    cctvCacheAt = now;
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cctvCache);
  } catch (err) {
    if (cctvCache) return res.status(200).json({ ...cctvCache, stale: true });
    return res.status(502).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GBFS
// ---------------------------------------------------------------------------
const GBFS_ALLOWED = new Set(['gbfs.lyft.com','gbfs.baywheels.com','gbfs.capitalbikeshare.com','gbfs.citibikenyc.com','gbfs.divvybikes.com','gbfs.bluebikes.com','data.lime.bike']);

async function handleGbfs(req, res) {
  // URL encoded after /api/feeds/gbfs/
  const encoded = (req.url || '').replace(/.*\/gbfs\//, '');
  let upstreamUrl;
  try { upstreamUrl = new URL(decodeURIComponent(encoded)); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  if (upstreamUrl.protocol !== 'https:') return res.status(400).json({ error: 'HTTPS only' });
  const host = upstreamUrl.hostname.toLowerCase();
  if (!GBFS_ALLOWED.has(host) && !host.endsWith('.publicbikesystem.net')) return res.status(403).json({ error: 'host not allowlisted' });
  if (!/\/station_(information|status)\.json$/i.test(upstreamUrl.pathname)) return res.status(403).json({ error: 'only station endpoints allowed' });
  try {
    const r = await fetch(upstreamUrl.toString(), { signal: AbortSignal.timeout(10_000) });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 5 * 1024 * 1024) return res.status(502).json({ error: 'response too large' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', /station_information/i.test(upstreamUrl.pathname) ? 'public, max-age=300' : 'no-store');
    return res.status(r.status).send(Buffer.from(buf));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// Radio Browser
// ---------------------------------------------------------------------------
async function handleRadio(req, res) {
  // Strip /api/feeds/radio prefix, keep rest as path to forward
  const forwardPath = (req.url || '').replace(/.*\/radio/, '') || '/json/stations/topclick';
  try {
    const r = await fetch(`https://all.api.radio-browser.info${forwardPath}`, { headers: { 'User-Agent': 'gods-eye-view/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 4 * 1024 * 1024) return res.status(502).json({ error: 'response too large' });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(r.status).send(Buffer.from(buf));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.includes('/ais-live')) return handleAisLive(req, res);
  if (path.endsWith('/cctv')) return handleCctv(req, res);
  if (path.includes('/gbfs/')) return handleGbfs(req, res);
  if (path.includes('/radio')) return handleRadio(req, res);
  return res.status(404).json({ error: 'not found' });
}
