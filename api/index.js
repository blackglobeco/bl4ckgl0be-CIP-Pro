/**
 * api/index.js — Single Vercel serverless function handling all /api/* routes.
 *
 * vercel.json rewrites everything: /api/:path* → /api/index
 * Vercel preserves the original URL in req.url, so we dispatch by path.
 *
 * Routes handled:
 *   /api/opensky                    live aircraft state vectors (OpenSky)
 *   /api/opensky-track              flight track backfill
 *   /api/adsbdb                     route/aircraft enrichment
 *   /api/adsblol/mil                military aircraft (adsb.lol)
 *   /api/adsblol/trace              flight trace (adsb.lol)
 *   /api/celestrak/*                TLE orbital elements
 *   /api/launches                   rocket launches (Launch Library 2)
 *   /api/openai/hud-summary         5-word AI HUD summary
 *   /api/realtime/token             OpenAI Realtime ephemeral token
 *   /api/realtime/debug-log         Realtime debug log collector
 *   /api/google/nearby-places       Google Places nearby search
 *   /api/google/text-search         Google Places text search
 *   /api/overpass                   OpenStreetMap Overpass queries
 *   /api/route                      OSRM routing directions
 *   /api/terrain/heights            terrain elevation lookup
 *   /api/military-installations     OSM military land-use polygons
 *   /api/firms                      NASA FIRMS active fires
 *   /api/regional-brief             Open-Meteo weather + Nominatim place
 *   /api/weather-effects            camera-local weather observations
 *   /api/tomtom/*                   TomTom live traffic tiles
 *   /api/ais-live                   AIS vessel positions (degraded on serverless)
 *   /api/cctv                       CCTV traffic cameras
 *   /api/gbfs/*                     GBFS bike-share stations
 *   /api/radio/*                    Radio Browser station directory
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// OPENSKY
// ─────────────────────────────────────────────────────────────────────────────
let _osCache = null, _osCacheAt = 0, _osCooldown = 0;
let _osToken = null, _osTokenExpiry = 0, _osTokenPromise = null;

function normaliseOpenSkyMode(raw) {
  const m = String(raw || '').toLowerCase().trim();
  return ['oauth', 'basic', 'auto', 'anon'].includes(m) ? m : 'anon';
}

async function getOpenSkyOAuthToken() {
  const now = Date.now();
  if (_osToken && now < _osTokenExpiry - 30_000) return _osToken;
  if (_osTokenPromise) return _osTokenPromise;
  const cid = process.env.OPENSKY_CLIENT_ID, cs = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !cs) return null;
  _osTokenPromise = (async () => {
    try {
      const r = await fetch(
        'https://auth.opensky-network.org/realms/opensky-network/protocol/openid-connect/token',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: cs }), signal: AbortSignal.timeout(10_000) }
      );
      if (!r.ok) return null;
      const d = await r.json();
      _osToken = d.access_token || null;
      _osTokenExpiry = now + (d.expires_in || 3600) * 1000;
      return _osToken;
    } catch { return null; } finally { _osTokenPromise = null; }
  })();
  return _osTokenPromise;
}

async function handleOpenSky(req, res) {
  const now = Date.now();
  if (_osCache && (now - _osCacheAt < 15_000 || now < _osCooldown)) {
    return json(res, 200, _osCache, true);
  }
  const mode = normaliseOpenSkyMode(process.env.OPENSKY_AUTH_MODE);
  const headers = { Accept: 'application/json' };
  if (mode === 'oauth' || mode === 'auto') {
    const token = await getOpenSkyOAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (mode === 'auto') {
      const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD;
      if (u && p) headers.Authorization = `Basic ${b64(`${u}:${p}`)}`;
    }
  } else if (mode === 'basic') {
    const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD;
    if (u && p) headers.Authorization = `Basic ${b64(`${u}:${p}`)}`;
  }
  try {
    const upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers, signal: AbortSignal.timeout(20_000) });
    const body = await upstream.text();
    if (upstream.status === 429) {
      _osCooldown = now + 120_000;
      if (_osCache) return json(res, 200, _osCache, true);
      return res.status(429).json({ error: 'OpenSky rate limited' });
    }
    if (upstream.ok) { _osCache = body; _osCacheAt = now; _osCooldown = 0; }
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body);
  } catch {
    if (_osCache) return json(res, 200, _osCache, true);
    return res.status(502).json({ error: 'OpenSky proxy error' });
  }
}

async function handleOpenSkyTrack(req, res) {
  const url = qurl(req);
  const icao24 = url.searchParams.get('icao24');
  if (!icao24) return res.status(400).json({ error: 'icao24 required' });
  const headers = { Accept: 'application/json' };
  const cid = process.env.OPENSKY_CLIENT_ID, cs = process.env.OPENSKY_CLIENT_SECRET;
  if (cid && cs) headers.Authorization = `Basic ${b64(`${cid}:${cs}`)}`;
  try {
    const u = new URL('https://opensky-network.org/api/tracks/all');
    u.searchParams.set('icao24', icao24);
    const begin = url.searchParams.get('begin');
    if (begin) u.searchParams.set('time', begin);
    const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(15_000) });
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(await r.text());
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADSBDB
// ─────────────────────────────────────────────────────────────────────────────
const _adsbdb = { routes: new Map(), aircraft: new Map() };

async function handleAdsbdb(req, res) {
  const url = qurl(req);
  const kind = url.searchParams.get('kind'), key = (url.searchParams.get('key') || '').trim();
  if (!['route', 'aircraft'].includes(kind) || !key) return res.status(400).json({ error: 'kind (route|aircraft) and key are required' });
  const store = kind === 'route' ? _adsbdb.routes : _adsbdb.aircraft;
  const now = Date.now(), entry = store.get(key);
  if (entry && now - entry.at < 24 * 3600_000) return res.status(200).json({ data: entry.data });
  try {
    const upUrl = kind === 'route'
      ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
      : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
    const r = await fetch(upUrl, { signal: AbortSignal.timeout(8_000) });
    if (r.status === 404) { store.set(key, { at: now, data: null }); return res.status(200).json({ data: null }); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json_ = await r.json();
    let data = null;
    if (kind === 'route') {
      const fr = json_?.response?.flightroute;
      if (fr?.origin && fr?.destination) {
        const ap = a => ({ code: a.iata_code || a.icao_code || '', name: a.municipality || a.name || '', lat: a.latitude ?? null, lon: a.longitude ?? null });
        data = { airline: fr.airline?.name || null, origin: ap(fr.origin), destination: ap(fr.destination) };
      }
    } else {
      const a = json_?.response?.aircraft;
      if (a) data = { typeCode: a.icao_type || null, typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null), registration: a.registration || null };
    }
    store.set(key, { at: now, data });
    return res.status(200).json({ data });
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADSB.LOL
// ─────────────────────────────────────────────────────────────────────────────
let _milCache = null, _milAt = 0;

async function handleAdsbLolMil(req, res) {
  const now = Date.now();
  if (_milCache && now - _milAt < 30_000) return json(res, 200, _milCache, true);
  try {
    const r = await fetch('https://api.adsb.lol/v2/mil', { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(10_000) });
    const body = await r.text();
    if (r.ok) { _milCache = body; _milAt = now; }
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(body);
  } catch { if (_milCache) return json(res, 200, _milCache, true); return res.status(502).json({ error: 'adsb.lol error' }); }
}

async function handleAdsbLolTrace(req, res) {
  const url = qurl(req);
  const hex = (url.searchParams.get('hex') || '').toLowerCase().trim();
  if (!/^[0-9a-f]{6}$/.test(hex)) return res.status(400).json({ error: 'hex must be a 6-character ICAO address' });
  try {
    const r = await fetch(`https://api.adsb.lol/v2/icao/${hex}`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(10_000) });
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(await r.text());
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CELESTRAK
// ─────────────────────────────────────────────────────────────────────────────
const _tleCache = new Map();

async function handleCelestrak(req, res) {
  const group = (req.url || '').replace(/.*\/celestrak\//, '').split('?')[0];
  if (!group || !/^[a-z0-9._-]+$/i.test(group)) return res.status(400).send('invalid group');
  const now = Date.now(), entry = _tleCache.get(group);
  if (entry && now - entry.at < 2 * 3600_000) { res.setHeader('Content-Type', 'text/plain'); return res.status(200).send(entry.body); }
  try {
    const r = await fetch(`https://celestrak.org/pub/TLE/${encodeURIComponent(group)}.txt`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`CelesTrak HTTP ${r.status}`);
    const body = await r.text();
    if (!body.trim()) throw new Error('empty TLE response');
    _tleCache.set(group, { at: now, body });
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send(body);
  } catch (err) {
    if (entry) { res.setHeader('Content-Type', 'text/plain'); return res.status(200).send(entry.body); }
    return res.status(502).send(`CelesTrak error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCHES (Launch Library 2)
// ─────────────────────────────────────────────────────────────────────────────
let _launchCache = null, _launchAt = 0;

async function handleLaunches(req, res) {
  const now = Date.now();
  if (_launchCache && now - _launchAt < 15 * 60_000) return json(res, 200, _launchCache, true);
  try {
    const end = new Date(), start = new Date(end.getTime() - 30 * 86400_000);
    const u = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    u.searchParams.set('net__gte', start.toISOString());
    u.searchParams.set('net__lte', end.toISOString());
    u.searchParams.set('limit', '100');
    u.searchParams.set('mode', 'detailed');
    const headers = { Accept: 'application/json' };
    if (process.env.LL2_API_TOKEN) headers.Authorization = `Token ${process.env.LL2_API_TOKEN}`;
    const r = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(20_000) });
    const body = await r.text();
    if (r.ok) { _launchCache = body; _launchAt = now; }
    res.setHeader('Content-Type', 'application/json');
    return res.status(r.status).send(body);
  } catch { if (_launchCache) return json(res, 200, _launchCache, true); return res.status(502).json({ error: 'launches proxy error' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — HUD SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
async function handleHudSummary(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY is not set' });
  let context = {};
  try { context = JSON.parse((await readBody(req)) || '{}'); } catch {}
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_HUD_SUMMARY_MODEL || 'gpt-5-nano',
        instructions: "Write one concise intelligence-HUD summary for God's Eye View. Use only the supplied place, street, nearby-place, and enabled-layer text labels. Prefer the clearest named place and include a relevant enabled layer only when useful. Do not infer from coordinates or invent a place. Output exactly five words with no title, punctuation, markdown, or introductory phrase.",
        input: JSON.stringify(context),
        reasoning: { effort: 'minimal' },
        max_output_tokens: 100,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await r.json().catch(() => ({}));
    let summary = null;
    if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const c of item.content) { if (c.type === 'output_text' && c.text) { summary = c.text.trim().split(/\s+/).slice(0, 5).join(' '); break; } }
        }
        if (summary) break;
      }
    }
    if (!summary) summary = data?.choices?.[0]?.message?.content?.trim().split(/\s+/).slice(0, 5).join(' ') || null;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(r.ok && summary ? 200 : r.status || 502).json({ summary: summary || null, error: r.ok ? null : data.error?.message || 'OpenAI request failed' });
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI — REALTIME TOKEN
// ─────────────────────────────────────────────────────────────────────────────
async function handleRealtimeToken(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY is not set' });

  const url = qurl(req);
  const requestedTier = url.searchParams.get('tier');
  const isMini = requestedTier === 'mini';
  const model = isMini
    ? (process.env.OPENAI_REALTIME_MODEL_MINI || 'gpt-realtime-2.1-mini')
    : (process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2');
  const voice = process.env.OPENAI_REALTIME_VOICE || 'marin';
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || 'low';
  const contextTokenLimit = Math.round(Math.max(1000, Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || 3000)));
  const contextRetentionRatio = Math.max(0.1, Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || 0.5));

  const sessionConfig = {
    session: {
      type: 'realtime',
      model,
      reasoning: { effort },
      truncation: {
        type: 'retention_ratio',
        retention_ratio: contextRetentionRatio,
        token_limits: { post_instructions: contextTokenLimit },
      },
      audio: {
        input: {
          noise_reduction: { type: 'near_field' },
          turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false },
        },
        output: { voice },
      },
      instructions: "You are GEV Voice Control, a concise voice controller for a Cesium geospatial app called God's Eye View. Have a natural spoken conversation with the user while the mic session is active. Only control the app by calling the provided tools.",
      tool_choice: 'auto',
    },
  };

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Safety-Identifier': 'gev-vercel-deploy' },
      body: JSON.stringify(sessionConfig),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.text();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-GEV-Voice-Tier', isMini ? 'mini' : 'standard');
    res.setHeader('X-GEV-Voice-Model', model);
    return res.status(r.status).send(body);
  } catch (err) { return res.status(502).json({ error: err.message || 'Failed to create Realtime token' }); }
}

async function handleRealtimeDebugLog(req, res) {
  try { const record = JSON.parse((await readBody(req)) || '{}'); console.log('[realtime-debug]', JSON.stringify({ loggedAt: new Date().toISOString(), ...record })); } catch {}
  return res.status(204).end();
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE PLACES
// ─────────────────────────────────────────────────────────────────────────────
function geodist(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371000, dl = (lat2 - lat1) * Math.PI / 180, dg = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dg / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function handleNearbyPlaces(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set', places: [] });
  const url = qurl(req);
  const latitude = Number(url.searchParams.get('lat')), longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(url.searchParams.get('radiusM')) || 250));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'Valid lat and lon are required', places: [] });
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.types' },
      body: JSON.stringify({ maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusM } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json().catch(() => ({}));
    const seen = new Set();
    const places = (Array.isArray(data.places) ? data.places : [])
      .map(p => ({ id: p.id || null, name: p.displayName?.text || null, address: p.shortFormattedAddress || p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, distanceM: geodist(latitude, longitude, p.location?.latitude, p.location?.longitude), primaryType: p.primaryTypeDisplayName?.text || p.primaryType || null, types: (p.types || []).slice(0, 8) }))
      .filter(p => { const k = `${p.name}:${p.address || ''}`.toLowerCase(); if (!p.name || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.distanceM - b.distanceM).slice(0, 20);
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(r.ok ? 200 : r.status).json({ places, error: r.ok ? null : data.error?.message || 'Google Places failed' });
  } catch (err) { return res.status(502).json({ error: err.message, places: [] }); }
}

async function handleTextSearch(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY is not set', places: [] });
  const url = qurl(req);
  const textQuery = (url.searchParams.get('q') || '').trim();
  const latitude = Number(url.searchParams.get('lat')), longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(url.searchParams.get('radiusM')) || 4000));
  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'q, lat and lon are required', places: [] });
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.primaryType,places.types' },
      body: JSON.stringify({ textQuery, locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } }, maxResultCount: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await r.json().catch(() => ({}));
    const places = (Array.isArray(data.places) ? data.places : []).map(p => { const vp = p.viewport; return { id: p.id || null, name: p.displayName?.text || null, address: p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, primaryType: p.primaryType || null, types: (p.types || []).slice(0, 8), viewport: (vp?.low && vp?.high) ? vp : null }; }).filter(p => p.name);
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(r.ok ? 200 : r.status).json({ places, error: r.ok ? null : data.error?.message || 'Google text-search failed' });
  } catch (err) { return res.status(502).json({ error: err.message, places: [] }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAP — OVERPASS, ROUTE, TERRAIN, MILITARY INSTALLATIONS
// ─────────────────────────────────────────────────────────────────────────────
async function handleOverpass(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = await readBody(req, 8192);
  if (!body) return res.status(400).json({ error: 'empty or oversized query' });
  try {
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(body.trim())}`, signal: AbortSignal.timeout(30_000) });
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(r.status).send(buf);
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

async function handleRoute(req, res) {
  const url = qurl(req);
  const mode = url.searchParams.get('mode') || url.searchParams.get('profile') || 'driving';
  const coords = url.searchParams.get('coordinates') || url.searchParams.get('coords');
  if (!['driving', 'walking', 'cycling'].includes(mode)) return res.status(400).json({ error: 'invalid mode' });
  if (!coords) return res.status(400).json({ error: 'coordinates required' });
  const pairs = coords.split(';');
  if (pairs.length < 2 || pairs.length > 25) return res.status(400).json({ error: 'need 2-25 coordinate pairs' });
  const osrmMode = mode === 'walking' ? 'foot' : mode === 'cycling' ? 'bike' : 'car';
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/${osrmMode}/${encodeURIComponent(coords)}?overview=full&geometries=geojson&steps=false`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(15_000) });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

const _terrainCache = new Map();
async function handleTerrainHeights(req, res) {
  const url = qurl(req);
  const rawPoints = url.searchParams.get('points');
  if (!rawPoints) return res.status(400).json({ error: 'points required' });
  let points;
  try { points = rawPoints.split(';').map(s => { const [lon, lat] = s.split(',').map(Number); if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(); return { lon, lat }; }); }
  catch { return res.status(400).json({ error: 'invalid points — expected "lon,lat;lon,lat"' }); }
  if (points.length > 100) return res.status(400).json({ error: 'max 100 points' });
  const now = Date.now(), entry = _terrainCache.get(rawPoints);
  if (entry && now - entry.at < 24 * 3600_000) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json(entry.data); }
  try {
    const r = await fetch('https://api.reearth.io/terrain-heights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(points.map(p => ({ lat: p.lat, lng: p.lon }))), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    _terrainCache.set(rawPoints, { at: now, data });
    if (_terrainCache.size > 1000) _terrainCache.delete(_terrainCache.keys().next().value);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(data);
  } catch (err) { if (entry) return res.status(200).json(entry.data); return res.status(502).json({ error: err.message }); }
}

const _milInstCache = new Map();
async function handleMilitaryInstallations(req, res) {
  const url = qurl(req);
  const s = Number(url.searchParams.get('south')), w = Number(url.searchParams.get('west'));
  const n = Number(url.searchParams.get('north')), e = Number(url.searchParams.get('east'));
  if (![s, w, n, e].every(Number.isFinite) || n <= s || e <= w || n - s > 10 || e - w > 10) return res.status(400).json({ error: 'valid bbox required (max 10°)' });
  const key = `${s.toFixed(2)},${w.toFixed(2)},${n.toFixed(2)},${e.toFixed(2)}`;
  const now = Date.now(), cached = _milInstCache.get(key);
  if (cached && now - cached.at < 3600_000) { res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }
  try {
    const query = `[out:json][timeout:25];\n(\n  way["landuse"="military"](${s},${w},${n},${e});\n  relation["landuse"="military"](${s},${w},${n},${e});\n);\nout center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
    const data = await r.json();
    const payload = { status: 'ready', elements: data.elements || [], fetchedAt: now };
    _milInstCache.set(key, { at: now, payload });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=60');
    return res.status(200).json(payload);
  } catch (err) {
    if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' });
    return res.status(503).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRMS
// ─────────────────────────────────────────────────────────────────────────────
const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
let _firmsCache = null;

function parseFirmsCsv(text) {
  if (!text?.includes(',')) return null;
  const lines = text.trim().split('\n'); if (lines.length < 2) return [];
  const h = lines[0].split(',');
  const li = h.indexOf('latitude'), oi = h.indexOf('longitude'), di = h.indexOf('acq_date'), ti = h.indexOf('acq_time');
  if (li < 0 || oi < 0) return null;
  return lines.slice(1).map(l => { const p = l.split(','); return { latitude: parseFloat(p[li]), longitude: parseFloat(p[oi]), acq_date: p[di] || '', acq_time: p[ti] || '' }; }).filter(f => Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
}

function filterFirms24h(fires, now = Date.now()) {
  const cutoff = now - 24 * 3600_000;
  return fires.filter(f => { try { const t = (f.acq_time?.toString() || '0000').padStart(4, '0'); return new Date(`${f.acq_date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`).getTime() > cutoff; } catch { return false; } });
}

async function handleFirms(req, res) {
  const mapKey = String(process.env.FIRMS_MAP_KEY || '').trim();
  if (!mapKey) return res.status(503).json({ error: 'FIRMS_MAP_KEY is not set' });
  const now = Date.now();
  if (_firmsCache && now - _firmsCache.at < 30 * 60_000) {
    const fires = filterFirms24h(_firmsCache.fires, now);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ fetchedAt: _firmsCache.at, stale: false, sources: _firmsCache.sources, count: fires.length, fires });
  }
  const sources = [], fires = [];
  for (const source of FIRMS_SOURCES) {
    try {
      const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/world/2`, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const records = parseFirmsCsv(await r.text());
      if (!records) throw new Error('non-CSV response');
      const filtered = filterFirms24h(records, now);
      sources.push({ source, count: filtered.length, ok: true }); fires.push(...filtered);
    } catch (err) { sources.push({ source, count: 0, ok: false, error: err.message }); }
  }
  if (!sources.some(s => s.ok)) {
    if (_firmsCache) { const f = filterFirms24h(_firmsCache.fires, now); return res.status(200).json({ fetchedAt: _firmsCache.at, stale: true, sources: _firmsCache.sources, count: f.length, fires: f }); }
    return res.status(502).json({ error: 'all FIRMS sources failed' });
  }
  _firmsCache = { at: now, sources, fires };
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({ fetchedAt: now, stale: false, sources, count: fires.length, fires });
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIONAL BRIEF + WEATHER EFFECTS
// ─────────────────────────────────────────────────────────────────────────────
const _briefCache = new Map(), _wxCache = new Map();
function ck(lat, lon) { return `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`; }

async function handleRegionalBrief(req, res) {
  const url = qurl(req);
  const latitude = Number(url.searchParams.get('latitude')), longitude = Number(url.searchParams.get('longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'latitude and longitude required' });
  const k = ck(latitude, longitude), now = Date.now(), cached = _briefCache.get(k);
  if (cached && now - cached.at < 5 * 60_000) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }
  try {
    const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
    wxUrl.searchParams.set('latitude', latitude); wxUrl.searchParams.set('longitude', longitude);
    wxUrl.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m');
    wxUrl.searchParams.set('temperature_unit', 'celsius');
    const [weather, place] = await Promise.allSettled([
      fetch(wxUrl.toString(), { signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null),
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(8_000) }).then(r => r.ok ? r.json() : null),
    ]);
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: { latitude, longitude }, weather: weather.value ?? null, place: place.value ?? null };
    _briefCache.set(k, { at: now, payload }); if (_briefCache.size > 200) _briefCache.delete(_briefCache.keys().next().value);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(payload);
  } catch { if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' }); return res.status(503).json({ error: 'regional brief unavailable' }); }
}

async function handleWeatherEffects(req, res) {
  const url = qurl(req);
  const latitude = Number(url.searchParams.get('latitude')), longitude = Number(url.searchParams.get('longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'latitude and longitude required' });
  const k = ck(latitude, longitude), now = Date.now(), cached = _wxCache.get(k);
  if (cached && now - cached.at < 3 * 60_000) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json({ ...cached.payload, status: 'cached' }); }
  try {
    const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
    wxUrl.searchParams.set('latitude', latitude); wxUrl.searchParams.set('longitude', longitude);
    wxUrl.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,cloud_cover,visibility,precipitation');
    wxUrl.searchParams.set('temperature_unit', 'celsius');
    const r = await fetch(wxUrl.toString(), { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const weather = await r.json();
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: { latitude, longitude }, weather };
    _wxCache.set(k, { at: now, payload }); if (_wxCache.size > 500) _wxCache.delete(_wxCache.keys().next().value);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(payload);
  } catch { if (cached) return res.status(200).json({ ...cached.payload, status: 'stale' }); return res.status(503).json({ error: 'weather effects unavailable' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOMTOM
// ─────────────────────────────────────────────────────────────────────────────
const _tileCache = new Map(); let _dailyCount = 0, _dailyDate = '';
function tomtomBudget() { return Number(process.env.TOMTOM_DAILY_TILE_BUDGET) || 40000; }
function tomtomBudgetOk() {
  const d = new Date().toISOString().slice(0, 10);
  if (_dailyDate !== d) { _dailyDate = d; _dailyCount = 0; }
  return _dailyCount < tomtomBudget();
}

async function handleTomtom(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  if (urlPath.endsWith('/status') || /\/tomtom\/status/.test(urlPath)) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ hasKey: Boolean(process.env.TOMTOM_API_KEY), dailyCount: _dailyCount, budget: tomtomBudget() });
  }
  const m = urlPath.match(/\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const [, z, x, y] = m;
  if (!process.env.TOMTOM_API_KEY) return res.status(503).json({ error: 'TOMTOM_API_KEY is not set' });
  const tileKey = `${z}/${x}/${y}`, now = Date.now(), entry = _tileCache.get(tileKey);
  if (entry && now - entry.at < 30_000) { res.setHeader('Content-Type', 'application/x-protobuf'); return res.status(200).send(entry.buf); }
  if (!tomtomBudgetOk()) { if (entry) { res.setHeader('Content-Type', 'application/x-protobuf'); return res.status(200).send(entry.buf); } return res.status(429).json({ error: 'daily tile budget exhausted' }); }
  try {
    const r = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.pbf?key=${process.env.TOMTOM_API_KEY}&thickness=10`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return res.status(502).json({ error: 'TomTom upstream error' });
    const buf = Buffer.from(await r.arrayBuffer());
    _tileCache.set(tileKey, { at: now, buf }); _dailyCount++;
    res.setHeader('Content-Type', 'application/x-protobuf');
    return res.status(200).send(buf);
  } catch { if (entry) { res.setHeader('Content-Type', 'application/x-protobuf'); return res.status(200).send(entry.buf); } return res.status(502).json({ error: 'TomTom proxy error' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// AIS LIVE
// ─────────────────────────────────────────────────────────────────────────────
async function handleAisLive(req, res) {
  const hasKey = Boolean(process.env.AISSTREAM_API_KEY);
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
  if (!hasKey) return res.status(503).json({ rows: [], source: 'AISStream', status: 'no_key', error: 'AISSTREAM_API_KEY not configured', refreshing: false, newestPositionAt: null, lastMessageAt: null });
  return res.status(200).json({ rows: [], source: 'AISStream', status: 'degraded', error: 'AIS live feed requires a persistent WebSocket server. Deploy on Railway or Render for full AIS support.', refreshing: true, newestPositionAt: null, lastMessageAt: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// CCTV
// ─────────────────────────────────────────────────────────────────────────────
let _cctvCache = null, _cctvAt = 0;
async function handleCctv(req, res) {
  const now = Date.now();
  if (_cctvCache && now - _cctvAt < 5 * 60_000) { res.setHeader('Content-Type', 'application/json'); return res.status(200).json(_cctvCache); }
  try {
    const r = await fetch('https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=100&$select=camera_id,location_latitude,location_longitude,camera_status', { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    const sources = rows.filter(row => row.camera_status === 'TURNED_ON' && row.location_latitude && row.location_longitude).slice(0, 36).map(row => ({ id: `austin-${row.camera_id}`, name: `Austin Camera ${row.camera_id}`, latitude: parseFloat(row.location_latitude), longitude: parseFloat(row.location_longitude), type: 'cctv', source: 'austin' }));
    _cctvCache = { sources, fetchedAt: now }; _cctvAt = now;
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(_cctvCache);
  } catch { if (_cctvCache) return res.status(200).json({ ..._cctvCache, stale: true }); return res.status(502).json({ error: 'CCTV proxy error' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GBFS
// ─────────────────────────────────────────────────────────────────────────────
const GBFS_HOSTS = new Set(['gbfs.lyft.com', 'gbfs.baywheels.com', 'gbfs.capitalbikeshare.com', 'gbfs.citibikenyc.com', 'gbfs.divvybikes.com', 'gbfs.bluebikes.com', 'data.lime.bike']);
async function handleGbfs(req, res) {
  const encoded = (req.url || '').replace(/.*\/gbfs\//, '');
  let upstreamUrl;
  try { upstreamUrl = new URL(decodeURIComponent(encoded)); } catch { return res.status(400).json({ error: 'invalid URL' }); }
  if (upstreamUrl.protocol !== 'https:') return res.status(400).json({ error: 'HTTPS only' });
  const host = upstreamUrl.hostname.toLowerCase();
  if (!GBFS_HOSTS.has(host) && !host.endsWith('.publicbikesystem.net')) return res.status(403).json({ error: 'host not allowlisted' });
  if (!/\/station_(information|status)\.json$/i.test(upstreamUrl.pathname)) return res.status(403).json({ error: 'only station endpoints allowed' });
  try {
    const r = await fetch(upstreamUrl.toString(), { signal: AbortSignal.timeout(10_000) });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', /station_information/i.test(upstreamUrl.pathname) ? 'public, max-age=300' : 'no-store');
    return res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// RADIO
// ─────────────────────────────────────────────────────────────────────────────
async function handleRadio(req, res) {
  const forwardPath = (req.url || '').replace(/^\/api\/radio/, '') || '/json/stations/topclick';
  try {
    const r = await fetch(`https://all.api.radio-browser.info${forwardPath}`, { headers: { 'User-Agent': 'gods-eye-view/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(r.status).send(Buffer.from(await r.arrayBuffer()));
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function qurl(req) { return new URL(req.url || '/', 'http://localhost'); }
function b64(s) { return Buffer.from(s).toString('base64'); }
function json(res, status, body, raw = false) {
  res.setHeader('Content-Type', 'application/json');
  return raw ? res.status(status).send(body) : res.status(status).json(body);
}
async function readBody(req, maxBytes = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) return null; chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // Vercel preserves the original path in req.url through the rewrite
  const path = (req.url || '').split('?')[0];

  // Aircraft
  if (path === '/api/opensky')              return handleOpenSky(req, res);
  if (path === '/api/opensky-track')        return handleOpenSkyTrack(req, res);
  if (path === '/api/adsbdb')               return handleAdsbdb(req, res);
  if (path === '/api/adsblol/mil')          return handleAdsbLolMil(req, res);
  if (path === '/api/adsblol/trace')        return handleAdsbLolTrace(req, res);

  // Satellites & launches
  if (path.startsWith('/api/celestrak/'))   return handleCelestrak(req, res);
  if (path === '/api/launches')             return handleLaunches(req, res);

  // OpenAI
  if (path === '/api/openai/hud-summary')   return handleHudSummary(req, res);
  if (path === '/api/realtime/token')       return handleRealtimeToken(req, res);
  if (path === '/api/realtime/debug-log')   return handleRealtimeDebugLog(req, res);

  // Google Places
  if (path === '/api/google/nearby-places') return handleNearbyPlaces(req, res);
  if (path === '/api/google/text-search')   return handleTextSearch(req, res);

  // Map / geometry
  if (path === '/api/overpass')             return handleOverpass(req, res);
  if (path === '/api/route')                return handleRoute(req, res);
  if (path === '/api/terrain/heights')      return handleTerrainHeights(req, res);
  if (path === '/api/military-installations') return handleMilitaryInstallations(req, res);

  // Environment
  if (path === '/api/firms')                return handleFirms(req, res);
  if (path === '/api/regional-brief')       return handleRegionalBrief(req, res);
  if (path === '/api/weather-effects')      return handleWeatherEffects(req, res);

  // Traffic
  if (path.startsWith('/api/tomtom'))       return handleTomtom(req, res);

  // Live feeds
  if (path === '/api/ais-live' || path.startsWith('/api/ais-live/')) return handleAisLive(req, res);
  if (path === '/api/cctv')                 return handleCctv(req, res);
  if (path.startsWith('/api/gbfs/'))        return handleGbfs(req, res);
  if (path.startsWith('/api/radio'))        return handleRadio(req, res);

  return res.status(404).json({ error: `No API handler for ${path}` });
}
