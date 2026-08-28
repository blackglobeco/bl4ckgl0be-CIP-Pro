/**
 * /api/route — OSRM walking/driving/cycling directions proxy.
 * GET /api/route?mode=walking&coordinates=lon,lat;lon,lat
 * No API key required (uses public OSRM demo server).
 */

const ALLOWED_MODES = new Set(['driving', 'walking', 'cycling']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export default async function handler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  const mode = url.searchParams.get('mode') || 'driving';
  const coords = url.searchParams.get('coordinates');

  if (!ALLOWED_MODES.has(mode)) return res.status(400).json({ error: 'invalid mode' });
  if (!coords) return res.status(400).json({ error: 'coordinates required' });

  // Validate coord pairs
  const pairs = coords.split(';');
  if (pairs.length < 2 || pairs.length > 25) return res.status(400).json({ error: 'need 2-25 coordinate pairs' });

  const osrmMode = mode === 'walking' ? 'foot' : mode === 'cycling' ? 'bike' : 'car';
  const upstreamUrl = `https://router.project-osrm.org/route/v1/${osrmMode}/${encodeURIComponent(coords)}?overview=full&geometries=geojson&steps=false`;

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { 'User-Agent': 'gods-eye-view/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_RESPONSE_BYTES) return res.status(502).json({ error: 'response too large' });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(upstream.status).send(Buffer.from(buf));
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Route proxy error' });
  }
}
