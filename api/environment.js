/**
 * /api/environment — Environmental data proxies.
 *
 * Routes:
 *   GET /api/environment/firms          → NASA FIRMS active fires
 *   GET /api/environment/firms-status   → FIRMS key status
 *   GET /api/environment/regional-brief → Open-Meteo weather + Nominatim place
 *   GET /api/environment/weather-effects → Camera-local weather
 */

// ---------------------------------------------------------------------------
// FIRMS
// ---------------------------------------------------------------------------
const FIRMS_TTL = 30 * 60_000;
const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
let firmsCache = null;

function parseFirmsCsv(text) {
  if (!text || !text.includes(',')) return null;
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const latIdx = header.indexOf('latitude'), lonIdx = header.indexOf('longitude');
  const dateIdx = header.indexOf('acq_date'), timeIdx = header.indexOf('acq_time');
  if (latIdx < 0 || lonIdx < 0) return null;
  return lines.slice(1).map(line => {
    const parts = line.split(',');
    return { latitude: parseFloat(parts[latIdx]), longitude: parseFloat(parts[lonIdx]), acq_date: parts[dateIdx] || '', acq_time: parts[timeIdx] || '' };
  }).filter(f => Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
}

function filterTrailing24h(fires, now = Date.now()) {
  const cutoff = now - 24 * 3600_000;
  return fires.filter(f => {
    try { const t = f.acq_time?.toString().padStart(4, '0') || '0000'; return new Date(`${f.acq_date}T${t.slice(0,2)}:${t.slice(2)}:00Z`).getTime() > cutoff; } catch { return false; }
  });
}

async function fetchFirmsSource(key, source) {
  const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const records = parseFirmsCsv(await r.text());
  if (records === null) throw new Error('non-CSV response');
  return records;
}

async function handleFirms(req, res) {
  const path = (req.url || '').split('?')[0];
  const key = (process.env.FIRMS_MAP_KEY || '').trim();

  if (path.endsWith('/firms-status')) {
    return res.status(200).json({ hasKey: Boolean(key), lastFetch: firmsCache?.at || null, count: firmsCache?.fires?.length || 0, stale: firmsCache ? Date.now() - firmsCache.at > FIRMS_TTL : true });
  }

  if (!key) return res.status(503).json({ error: 'no_key' });
  const now = Date.now();
  if (firmsCache && now - firmsCache.at < FIRMS_TTL) {
    const fires = filterTrailing24h(firmsCache.fires, now);
    return res.status(200).json({ fetchedAt: firmsCache.at, stale: false, ttlMs: FIRMS_TTL, sources: firmsCache.sources, count: fires.length, fires });
  }
  try {
    const sources = [], fires = [];
    for (const source of FIRMS_SOURCES) {
      try { const records = filterTrailing24h(await fetchFirmsSource(key, source), now); sources.push({ source, count: records.length, ok: true }); fires.push(...records); }
      catch (err) { sources.push({ source, count: 0, ok: false }); }
    }
    if (!sources.some(s => s.ok)) throw new Error('all sources failed');
    firmsCache = { at: now, sources, fires };
    const out = filterTrailing24h(fires, now);
    return res.status(200).json({ fetchedAt: now, stale: false, ttlMs: FIRMS_TTL, sources, count: out.length, fires: out });
  } catch (err) {
    if (firmsCache) { const out = filterTrailing24h(firmsCache.fires, now); return res.status(200).json({ fetchedAt: firmsCache.at, stale: true, ttlMs: FIRMS_TTL, sources: firmsCache.sources, count: out.length, fires: out }); }
    return res.status(502).json({ error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Regional brief + weather effects (Open-Meteo / Nominatim)
// ---------------------------------------------------------------------------
const briefCache = new Map(), wxCache = new Map();
const BRIEF_TTL = 5 * 60_000, WX_TTL = 3 * 60_000;

function parsePoint(params) {
  const lat = Number(params.get('latitude')), lon = Number(params.get('longitude'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { latitude: lat, longitude: lon };
}

function cacheKey(point) {
  return `${(Math.round(point.latitude * 10) / 10).toFixed(1)},${(Math.round(point.longitude * 10) / 10).toFixed(1)}`;
}

async function fetchWeather(point, extra = '') {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', point.latitude);
  url.searchParams.set('longitude', point.longitude);
  url.searchParams.set('current', `temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m${extra}`);
  url.searchParams.set('temperature_unit', 'celsius');
  const r = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
  return r.json();
}

async function handleRegionalBrief(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const url = new URL(req.url, 'http://localhost');
  const point = parsePoint(url.searchParams);
  if (!point) return res.status(400).json({ error: 'Valid latitude and longitude required' });
  const key = cacheKey(point), now = Date.now();
  const cached = briefCache.get(key);
  if (cached && now - cached.at < BRIEF_TTL) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }
  try {
    const [weather, place] = await Promise.allSettled([
      fetchWeather(point),
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${point.latitude}&lon=${point.longitude}&zoom=10`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null),
    ]);
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather: weather.status === 'fulfilled' ? weather.value : null, place: place.status === 'fulfilled' ? place.value : null };
    briefCache.set(key, { at: now, payload });
    if (briefCache.size > 200) briefCache.delete(briefCache.keys().next().value);
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' });
    return res.status(503).json({ error: 'Regional briefing temporarily unavailable' });
  }
}

async function handleWeatherEffects(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  const url = new URL(req.url, 'http://localhost');
  const point = parsePoint(url.searchParams);
  if (!point) return res.status(400).json({ error: 'Valid latitude and longitude required' });
  const key = cacheKey(point), now = Date.now();
  const cached = wxCache.get(key);
  if (cached && now - cached.at < WX_TTL) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }
  try {
    const weather = await fetchWeather(point, ',cloud_cover,visibility,precipitation');
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: point, weather };
    wxCache.set(key, { at: now, payload });
    if (wxCache.size > 500) wxCache.delete(wxCache.keys().next().value);
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' });
    return res.status(503).json({ error: 'Weather effects temporarily unavailable' });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/firms') || path.endsWith('/firms-status')) return handleFirms(req, res);
  if (path.endsWith('/regional-brief')) return handleRegionalBrief(req, res);
  if (path.endsWith('/weather-effects')) return handleWeatherEffects(req, res);
  return res.status(404).json({ error: 'not found' });
}
