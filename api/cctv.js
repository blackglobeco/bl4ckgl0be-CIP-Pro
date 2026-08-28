/**
 * /api/cctv — CCTV traffic camera source registry proxy.
 * Fetches Austin Open Data traffic cameras and returns normalized source list.
 * No API key required.
 */

let cache = null;
let cacheAt = 0;
const TTL_MS = 5 * 60_000; // 5 min

const AUSTIN_CATALOG_URL =
  'https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=100&$select=camera_id,location_latitude,location_longitude,camera_status,camera_mfr,camera_model';

async function fetchAustinCameras() {
  const res = await fetch(AUSTIN_CATALOG_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Austin catalog HTTP ${res.status}`);
  const rows = await res.json();
  return rows
    .filter(r => r.camera_status === 'TURNED_ON' && r.location_latitude && r.location_longitude)
    .slice(0, 36)
    .map(r => ({
      id: `austin-${r.camera_id}`,
      name: `Austin Camera ${r.camera_id}`,
      latitude: parseFloat(r.location_latitude),
      longitude: parseFloat(r.location_longitude),
      type: 'cctv',
      source: 'austin',
    }));
}

export default async function handler(req, res) {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cache);
  }

  try {
    const cameras = await fetchAustinCameras();
    cache = { sources: cameras, fetchedAt: now };
    cacheAt = now;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cache);
  } catch (err) {
    if (cache) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ ...cache, stale: true });
    }
    return res.status(502).json({ error: err.message || 'CCTV proxy error' });
  }
}
