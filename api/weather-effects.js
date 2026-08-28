/**
 * /api/weather-effects — Camera-local weather observations proxy.
 * GET /api/weather-effects?latitude=...&longitude=...
 * Uses Open-Meteo (no API key required).
 */

const CACHE_MS = 3 * 60_000;
const cache = new Map();

function parsePoint(params) {
  const lat = Number(params.get('latitude'));
  const lon = Number(params.get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

async function fetchWeather(point) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', point.latitude);
  url.searchParams.set('longitude', point.longitude);
  url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,cloud_cover,visibility,precipitation');
  url.searchParams.set('temperature_unit', 'celsius');
  url.searchParams.set('wind_speed_unit', 'ms');
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  const url = new URL(req.url || '', 'http://localhost');
  const point = parsePoint(url.searchParams);
  if (!point) return res.status(400).json({ error: 'Valid latitude and longitude required' });

  const key = `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_MS) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json({ ...cached.payload, status: 'cached' });
  }

  try {
    const weather = await fetchWeather(point);
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather };
    cache.set(key, { at: now, payload });
    if (cache.size > 500) { const first = cache.keys().next().value; cache.delete(first); }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' });
    return res.status(503).json({ error: 'Weather effects temporarily unavailable' });
  }
}
