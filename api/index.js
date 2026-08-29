/**
 * api/index.js — Single Vercel serverless function for all /api/* routes.
 * vercel.json: { "rewrites": [{ "source": "/api/:path*", "destination": "/api/index" }] }
 */

'use strict';

import { randomUUID } from 'node:crypto';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function qurl(req) { return new URL(req.url || '/', 'http://localhost'); }
function b64(s) { return Buffer.from(s).toString('base64'); }
function sj(res, status, obj) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res.status(status).json(obj); }
function sr(res, status, body, ct) { res.setHeader('Content-Type', ct); return res.status(status).send(body); }
async function readBody(req, max = 64 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > max) return null; chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}
function mkAbort(ms) { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c; }
function escXml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function hashSeed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; } return h; }

// ─────────────────────────────────────────────────────────────────────────────
// OPENSKY
// ─────────────────────────────────────────────────────────────────────────────
let _osCache = null, _osCacheAt = 0, _osCooldown = 0;
let _osToken = null, _osTokenExp = 0, _osTokenProm = null;

async function getOSToken() {
  const now = Date.now();
  if (_osToken && now < _osTokenExp - 30_000) return _osToken;
  if (_osTokenProm) return _osTokenProm;
  const cid = process.env.OPENSKY_CLIENT_ID, cs = process.env.OPENSKY_CLIENT_SECRET;
  if (!cid || !cs) return null;
  _osTokenProm = (async () => {
    try {
      const r = await fetch('https://auth.opensky-network.org/realms/opensky-network/protocol/openid-connect/token',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cid, client_secret: cs }), signal: mkAbort(10_000).signal });
      if (!r.ok) return null;
      const d = await r.json(); _osToken = d.access_token || null; _osTokenExp = now + (d.expires_in || 3600) * 1000; return _osToken;
    } catch { return null; } finally { _osTokenProm = null; }
  })();
  return _osTokenProm;
}

async function handleOpenSky(req, res) {
  const now = Date.now();
  if (_osCache && (now - _osCacheAt < 15_000 || now < _osCooldown)) return sr(res, 200, _osCache, 'application/json');
  const mode = String(process.env.OPENSKY_AUTH_MODE || 'anon').toLowerCase().trim();
  const headers = { Accept: 'application/json', 'User-Agent': 'gods-eye-view-opensky-proxy/1.0' };
  if (mode === 'oauth' || mode === 'auto') {
    const tok = await getOSToken();
    if (tok) headers.Authorization = `Bearer ${tok}`;
    else if (mode === 'auto') { const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD; if (u && p) headers.Authorization = `Basic ${b64(`${u}:${p}`)}`; }
  } else if (mode === 'basic') {
    const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD;
    if (u && p) headers.Authorization = `Basic ${b64(`${u}:${p}`)}`;
  }
  try {
    const r = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers, signal: mkAbort(28_000).signal });
    const body = await r.text();
    if (r.status === 429) { _osCooldown = now + 120_000; if (_osCache) return sr(res, 200, _osCache, 'application/json'); return sj(res, 429, { error: 'OpenSky rate limited' }); }
    if (r.ok) { _osCache = body; _osCacheAt = now; _osCooldown = 0; }
    return sr(res, r.status, body, 'application/json');
  } catch (err) {
    console.error('[opensky]', err.message);
    if (_osCache) return sr(res, 200, _osCache, 'application/json');
    return sj(res, 502, { error: 'OpenSky proxy error' });
  }
}

async function handleOpenSkyTrack(req, res) {
  const url = qurl(req); const icao24 = url.searchParams.get('icao24');
  if (!icao24) return sj(res, 400, { error: 'icao24 required' });
  const headers = { Accept: 'application/json', 'User-Agent': 'gods-eye-view/1.0' };
  const cid = process.env.OPENSKY_CLIENT_ID, cs = process.env.OPENSKY_CLIENT_SECRET;
  if (cid && cs) headers.Authorization = `Basic ${b64(`${cid}:${cs}`)}`;
  try {
    const u = new URL('https://opensky-network.org/api/tracks/all');
    u.searchParams.set('icao24', icao24);
    const begin = url.searchParams.get('begin'); if (begin) u.searchParams.set('time', begin);
    const r = await fetch(u.toString(), { headers, signal: mkAbort(15_000).signal });
    return sr(res, r.status, await r.text(), 'application/json');
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADSBDB
// ─────────────────────────────────────────────────────────────────────────────
const _adsbdb = { routes: new Map(), aircraft: new Map() };
async function handleAdsbdb(req, res) {
  const url = qurl(req); const kind = url.searchParams.get('kind'), key = (url.searchParams.get('key') || '').trim();
  if (!['route', 'aircraft'].includes(kind) || !key) return sj(res, 400, { error: 'kind and key required' });
  const store = kind === 'route' ? _adsbdb.routes : _adsbdb.aircraft;
  const now = Date.now(), entry = store.get(key);
  if (entry && now - entry.at < 24 * 3600_000) return sj(res, 200, { data: entry.data });
  try {
    const upUrl = kind === 'route' ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}` : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
    const r = await fetch(upUrl, { signal: mkAbort(8_000).signal });
    if (r.status === 404) { store.set(key, { at: now, data: null }); return sj(res, 200, { data: null }); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json(); let data = null;
    if (kind === 'route') { const fr = j?.response?.flightroute; if (fr?.origin && fr?.destination) { const ap = a => ({ code: a.iata_code || a.icao_code || '', name: a.municipality || a.name || '', lat: a.latitude ?? null, lon: a.longitude ?? null }); data = { airline: fr.airline?.name || null, origin: ap(fr.origin), destination: ap(fr.destination) }; } }
    else { const a = j?.response?.aircraft; if (a) data = { typeCode: a.icao_type || null, typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null), registration: a.registration || null }; }
    store.set(key, { at: now, data }); return sj(res, 200, { data });
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADSB.LOL
// ─────────────────────────────────────────────────────────────────────────────
let _milCache = null, _milAt = 0;
async function handleAdsbLolMil(req, res) {
  const now = Date.now();
  if (_milCache && now - _milAt < 30_000) return sr(res, 200, _milCache, 'application/json');
  try {
    const r = await fetch('https://api.adsb.lol/v2/mil', { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: mkAbort(10_000).signal });
    const body = await r.text(); if (r.ok) { _milCache = body; _milAt = now; }
    return sr(res, r.status, body, 'application/json');
  } catch { if (_milCache) return sr(res, 200, _milCache, 'application/json'); return sj(res, 502, { error: 'adsb.lol error' }); }
}
async function handleAdsbLolTrace(req, res) {
  const url = qurl(req); const hex = (url.searchParams.get('hex') || '').toLowerCase().trim();
  if (!/^[0-9a-f]{6}$/.test(hex)) return sj(res, 400, { error: 'hex must be 6-char ICAO' });
  try {
    const r = await fetch(`https://api.adsb.lol/v2/icao/${hex}`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: mkAbort(10_000).signal });
    return sr(res, r.status, await r.text(), 'application/json');
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// CELESTRAK — gp.php?GROUP=&FORMAT=tle (NOT /pub/TLE/ — returns 403)
// ─────────────────────────────────────────────────────────────────────────────
const _tleCache = new Map();
async function handleCelestrak(req, res) {
  const group = (req.url || '').replace(/.*\/celestrak\//, '').split('?')[0];
  if (!group || !/^[a-z0-9-]+$/i.test(group)) return res.status(400).send('invalid group');
  const now = Date.now(), entry = _tleCache.get(group);
  if (entry && now - entry.at < 6 * 3600_000) { res.setHeader('Content-Type', 'text/plain'); res.setHeader('x-tle-cache', 'HIT'); return res.status(200).send(entry.body); }
  try {
    const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
    url.searchParams.set('GROUP', group); url.searchParams.set('FORMAT', 'tle');
    const r = await fetch(url.toString(), { headers: { 'User-Agent': 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)' }, signal: mkAbort(20_000).signal });
    if (!r.ok) throw new Error(`CelesTrak HTTP ${r.status}`);
    const body = await r.text();
    if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
    _tleCache.set(group, { at: now, body });
    res.setHeader('Content-Type', 'text/plain'); res.setHeader('x-tle-cache', 'MISS');
    return res.status(200).send(body);
  } catch (err) {
    console.error('[celestrak]', group, err.message);
    if (entry) { res.setHeader('Content-Type', 'text/plain'); res.setHeader('x-tle-cache', 'STALE-ERR'); return res.status(200).send(entry.body); }
    return res.status(502).send(`CelesTrak error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCHES
// ─────────────────────────────────────────────────────────────────────────────
let _launchCache = null, _launchAt = 0;
async function handleLaunches(req, res) {
  const now = Date.now();
  if (_launchCache && now - _launchAt < 15 * 60_000) return sr(res, 200, _launchCache, 'application/json');
  try {
    const end = new Date(), start = new Date(end.getTime() - 30 * 86400_000);
    const u = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    u.searchParams.set('net__gte', start.toISOString()); u.searchParams.set('net__lte', end.toISOString());
    u.searchParams.set('limit', '100'); u.searchParams.set('mode', 'detailed');
    const headers = { Accept: 'application/json' }; if (process.env.LL2_API_TOKEN) headers.Authorization = `Token ${process.env.LL2_API_TOKEN}`;
    const r = await fetch(u.toString(), { headers, signal: mkAbort(20_000).signal }); const body = await r.text();
    if (r.ok) { _launchCache = body; _launchAt = now; }
    return sr(res, r.status, body, 'application/json');
  } catch { if (_launchCache) return sr(res, 200, _launchCache, 'application/json'); return sj(res, 502, { error: 'launches proxy error' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI
// ─────────────────────────────────────────────────────────────────────────────
async function handleHudSummary(req, res) {
  if (req.method !== 'POST') return sj(res, 405, { error: 'POST only' });
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) return sj(res, 503, { error: 'OPENAI_API_KEY is not set' });
  let context = {}; try { context = JSON.parse((await readBody(req)) || '{}'); } catch {}
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.OPENAI_HUD_SUMMARY_MODEL || 'gpt-5-nano', instructions: "Write one concise intelligence-HUD summary for God's Eye View. Output exactly five words with no title, punctuation, or markdown.", input: JSON.stringify(context), reasoning: { effort: 'minimal' }, max_output_tokens: 100 }), signal: mkAbort(15_000).signal });
    const data = await r.json().catch(() => ({}));
    let summary = null;
    if (Array.isArray(data?.output)) { for (const item of data.output) { if (item.type === 'message' && Array.isArray(item.content)) { for (const c of item.content) { if (c.type === 'output_text' && c.text) { summary = c.text.trim().split(/\s+/).slice(0, 5).join(' '); break; } } } if (summary) break; } }
    if (!summary && data?.output_text) summary = String(data.output_text).trim().split(/\s+/).slice(0, 5).join(' ');
    if (!summary) summary = data?.choices?.[0]?.message?.content?.trim().split(/\s+/).slice(0, 5).join(' ') || null;
    res.setHeader('Cache-Control', 'no-store');
    return sj(res, r.ok && summary ? 200 : r.status || 502, { summary: summary || null, error: r.ok ? null : data.error?.message || 'OpenAI failed' });
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

async function handleRealtimeToken(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return sj(res, 405, { error: 'Method not allowed' });
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) return sj(res, 503, { error: 'OPENAI_API_KEY is not set' });
  const url = qurl(req); const isMini = url.searchParams.get('tier') === 'mini';
  const model = isMini ? (process.env.OPENAI_REALTIME_MODEL_MINI || 'gpt-realtime-2.1-mini') : (process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2');
  const voice = process.env.OPENAI_REALTIME_VOICE || 'marin';
  const effort = process.env.OPENAI_REALTIME_REASONING_EFFORT || 'low';
  const contextTokens = Math.round(Math.max(1000, Math.min(12000, Number(process.env.OPENAI_REALTIME_CONTEXT_TOKENS) || 3000)));
  const contextRetention = Math.max(0.1, Math.min(1, Number(process.env.OPENAI_REALTIME_CONTEXT_RETENTION) || 0.5));
  try {
    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST', signal: mkAbort(15_000).signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'OpenAI-Safety-Identifier': 'gev-vercel-deploy' },
      body: JSON.stringify({ session: { type: 'realtime', model, reasoning: { effort }, truncation: { type: 'retention_ratio', retention_ratio: contextRetention, token_limits: { post_instructions: contextTokens } }, audio: { input: { noise_reduction: { type: 'near_field' }, turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false } }, output: { voice } }, instructions: "You are GEV Voice Control for God's Eye View. Respond concisely.", tool_choice: 'auto' } }) });
    const body = await r.text();
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-GEV-Voice-Tier', isMini ? 'mini' : 'standard'); res.setHeader('X-GEV-Voice-Model', model);
    return res.status(r.status).send(body);
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

async function handleRealtimeDebugLog(req, res) {
  try { const record = JSON.parse((await readBody(req)) || '{}'); console.log('[realtime-debug]', JSON.stringify({ loggedAt: new Date().toISOString(), ...record })); } catch {}
  return res.status(204).end();
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE PLACES
// ─────────────────────────────────────────────────────────────────────────────
function geodist(lat1, lon1, lat2, lon2) { if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity; const R = 6371000, dl = (lat2 - lat1) * Math.PI / 180, dg = (lon2 - lon1) * Math.PI / 180; const a = Math.sin(dl / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dg / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); }

async function handleNearbyPlaces(req, res) {
  if (req.method !== 'GET') return sj(res, 405, { error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; if (!apiKey) return sj(res, 503, { error: 'GOOGLE_MAPS_API_KEY not set', places: [] });
  const url = qurl(req); const latitude = Number(url.searchParams.get('lat')), longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(url.searchParams.get('radiusM')) || 250));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return sj(res, 400, { error: 'lat and lon required', places: [] });
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', signal: mkAbort(10_000).signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.types' }, body: JSON.stringify({ maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusM } } }) });
    const data = await r.json().catch(() => ({}));
    const seen = new Set();
    const places = (Array.isArray(data.places) ? data.places : []).map(p => ({ id: p.id || null, name: p.displayName?.text || null, address: p.shortFormattedAddress || p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, distanceM: geodist(latitude, longitude, p.location?.latitude, p.location?.longitude), primaryType: p.primaryTypeDisplayName?.text || p.primaryType || null, types: (p.types || []).slice(0, 8) })).filter(p => { const k = `${p.name}:${p.address || ''}`.toLowerCase(); if (!p.name || seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.distanceM - b.distanceM).slice(0, 20);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return sj(res, r.ok ? 200 : r.status, { places, error: r.ok ? null : data.error?.message || 'Google Places failed' });
  } catch (err) { return sj(res, 502, { error: err.message, places: [] }); }
}

async function handleTextSearch(req, res) {
  if (req.method !== 'GET') return sj(res, 405, { error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY; if (!apiKey) return sj(res, 503, { error: 'GOOGLE_MAPS_API_KEY not set', places: [] });
  const url = qurl(req); const textQuery = (url.searchParams.get('q') || '').trim();
  const latitude = Number(url.searchParams.get('lat')), longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(url.searchParams.get('radiusM')) || 4000));
  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return sj(res, 400, { error: 'q, lat and lon required', places: [] });
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST', signal: mkAbort(10_000).signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.primaryType,places.types' }, body: JSON.stringify({ textQuery, locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } }, maxResultCount: 5 }) });
    const data = await r.json().catch(() => ({}));
    const places = (Array.isArray(data.places) ? data.places : []).map(p => { const vp = p.viewport; return { id: p.id || null, name: p.displayName?.text || null, address: p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, primaryType: p.primaryType || null, types: (p.types || []).slice(0, 8), viewport: (vp?.low && vp?.high) ? vp : null }; }).filter(p => p.name);
    res.setHeader('Cache-Control', 'private, max-age=300');
    return sj(res, r.ok ? 200 : r.status, { places, error: r.ok ? null : data.error?.message || 'failed' });
  } catch (err) { return sj(res, 502, { error: err.message, places: [] }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// OVERPASS — Fixed: User-Agent header + multiple mirrors + raw body (not encoded)
// ─────────────────────────────────────────────────────────────────────────────
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchOverpass(query, timeoutMs = 30_000) {
  let lastErr;
  for (const endpoint of OVERPASS_MIRRORS) {
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'gods-eye-view-overpass-proxy/1.0',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: mkAbort(timeoutMs).signal,
      });
      if (r.status === 429) { lastErr = new Error(`rate limited on ${endpoint}`); continue; }
      if (r.status >= 500) { lastErr = new Error(`HTTP ${r.status} on ${endpoint}`); continue; }
      const body = await r.text();
      // Skip HTML error pages (406, runtime errors)
      if (body.trim().startsWith('<!')) { lastErr = new Error(`HTML error from ${endpoint}`); continue; }
      return { status: r.status, body, contentType: r.headers.get('content-type') || 'application/json' };
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('all Overpass mirrors failed');
}

const _overpassCache = new Map();

async function handleOverpass(req, res) {
  if (req.method !== 'POST') return sj(res, 405, { error: 'POST only' });
  const body = await readBody(req, 8192); if (!body) return sj(res, 400, { error: 'empty or oversized query' });
  const query = body.trim();
  const cacheKey = query.replace(/\s+/g, ' ');
  const now = Date.now(), cached = _overpassCache.get(cacheKey);
  if (cached && now - cached.at < 5 * 60_000) { res.setHeader('Cache-Control', 'public, max-age=300'); return sr(res, 200, cached.body, cached.ct); }
  try {
    const result = await fetchOverpass(query);
    if (result.status < 400) { _overpassCache.set(cacheKey, { at: now, body: result.body, ct: result.contentType }); if (_overpassCache.size > 100) _overpassCache.delete(_overpassCache.keys().next().value); }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return sr(res, result.status, result.body, result.contentType);
  } catch (err) {
    if (cached) { res.setHeader('Cache-Control', 'no-store'); return sr(res, 200, cached.body, cached.ct); }
    return sj(res, 502, { error: `Overpass proxy error: ${err.message}` });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE (OSRM)
// ─────────────────────────────────────────────────────────────────────────────
async function handleRoute(req, res) {
  const url = qurl(req); const mode = url.searchParams.get('mode') || url.searchParams.get('profile') || 'driving';
  const coords = url.searchParams.get('coordinates') || url.searchParams.get('coords');
  if (!['driving', 'walking', 'cycling'].includes(mode)) return sj(res, 400, { error: 'invalid mode' });
  if (!coords) return sj(res, 400, { error: 'coordinates required' });
  const osrmMode = mode === 'walking' ? 'foot' : mode === 'cycling' ? 'bike' : 'car';
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/${osrmMode}/${encodeURIComponent(coords)}?overview=full&geometries=geojson&steps=false`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: mkAbort(15_000).signal });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return sr(res, r.status, Buffer.from(await r.arrayBuffer()), 'application/json');
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TERRAIN HEIGHTS — GET to terrain.reearth.land/heights.json?points=lon,lat;...
// ─────────────────────────────────────────────────────────────────────────────
const _terrainCache = new Map();
async function handleTerrainHeights(req, res) {
  const url = qurl(req); const rawPoints = url.searchParams.get('points');
  if (!rawPoints) return sj(res, 400, { error: 'points required' });
  let points;
  try { points = rawPoints.split(';').map(s => { const [lon, lat] = s.split(',').map(Number); if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error(); return [lon, lat]; }); }
  catch { return sj(res, 400, { error: 'invalid points — expected "lon,lat;lon,lat"' }); }
  if (points.length > 256) return sj(res, 400, { error: 'max 256 points per call' });
  const canonKey = points.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const now = Date.now(), entry = _terrainCache.get(canonKey);
  if (entry && now - entry.at < 30 * 24 * 3600_000) return sj(res, 200, entry.data);
  try {
    const upUrl = `https://terrain.reearth.land/heights.json?points=${encodeURIComponent(canonKey)}`;
    const r = await fetch(upUrl, { signal: mkAbort(30_000).signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (!Array.isArray(data?.results)) throw new Error('malformed upstream response');
    _terrainCache.set(canonKey, { at: now, data });
    if (_terrainCache.size > 2000) _terrainCache.delete(_terrainCache.keys().next().value);
    return sj(res, 200, data);
  } catch (err) { if (entry) return sj(res, 200, entry.data); return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MILITARY INSTALLATIONS — Fixed: uses fetchOverpass helper (with mirrors + User-Agent)
// ─────────────────────────────────────────────────────────────────────────────
const _milInstCache = new Map();
async function handleMilitaryInstallations(req, res) {
  if (req.method !== 'GET') return sj(res, 405, { error: 'Method Not Allowed' });
  const url = qurl(req);
  const s = Number(url.searchParams.get('south')), w = Number(url.searchParams.get('west'));
  const n = Number(url.searchParams.get('north')), e = Number(url.searchParams.get('east'));
  if (![s, w, n, e].every(Number.isFinite) || n <= s || e <= w || n - s > 10 || e - w > 10) return sj(res, 400, { error: 'A non-dateline bbox no larger than 10 degrees is required' });
  const exact = url.searchParams.get('exact') === '1';
  const snap = v => Math.round(v * 2) / 2;
  const box = exact ? { south: s, west: w, north: n, east: e } : { south: snap(s), west: snap(w), north: snap(n), east: snap(e) };
  const key = `${exact ? 'exact:' : ''}${box.south.toFixed(2)},${box.west.toFixed(2)},${box.north.toFixed(2)},${box.east.toFixed(2)}`;
  const now = Date.now(), cached = _milInstCache.get(key);
  if (cached && now - cached.at < 3600_000) { res.setHeader('Cache-Control', 'public, max-age=60'); return sj(res, 200, { ...cached.payload, status: 'cached' }); }
  try {
    const query = `[out:json][timeout:25];\n(\n  way["landuse"="military"](${box.south},${box.west},${box.north},${box.east});\n  relation["landuse"="military"](${box.south},${box.west},${box.north},${box.east});\n);\nout center tags;`;
    const result = await fetchOverpass(query, 35_000);
    const data = JSON.parse(result.body);
    const retrievedAt = new Date().toISOString();
    const payload = { status: 'ready', elements: data.elements || [], retrievedAt, fetchedAt: now, source: 'OpenStreetMap' };
    _milInstCache.set(key, { at: now, payload });
    if (_milInstCache.size > 200) _milInstCache.delete(_milInstCache.keys().next().value);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return sj(res, 200, payload);
  } catch (err) {
    console.error('[military-installations]', err.message);
    if (cached) return sj(res, 200, { ...cached.payload, status: 'stale' });
    return sj(res, 503, { error: 'Mapped installation context is temporarily unavailable' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIRMS — Fixed: sequential fetches (quota courtesy), /status sub-route
// ─────────────────────────────────────────────────────────────────────────────
const FIRMS_SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];
let _firmsCache = null, _firmsInflight = null;

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
function buildFirmsPayload(entry, stale) {
  const fires = filterFirms24h(entry.fires, Date.now());
  return { fetchedAt: entry.at, stale, ttlMs: 30 * 60_000, sources: entry.sources, count: fires.length, fires };
}

async function refreshFirms(mapKey) {
  const now = Date.now(); const sources = [], fires = [];
  for (const source of FIRMS_SOURCES) {
    try {
      // Sequential — never in parallel (quota courtesy per original vite.config)
      const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/${source}/world/2`, { signal: mkAbort(60_000).signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const records = parseFirmsCsv(await r.text());
      if (!records) throw new Error('non-CSV response');
      const filtered = filterFirms24h(records, now);
      sources.push({ source, count: filtered.length, ok: true }); fires.push(...filtered);
    } catch (err) { sources.push({ source, count: 0, ok: false }); }
  }
  if (!sources.some(s => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

async function handleFirms(req, res) {
  const path = (req.url || '').split('?')[0];
  const mapKey = String(process.env.FIRMS_MAP_KEY || '').trim();

  // /api/firms/status
  if (path.endsWith('/status') || path.includes('/firms/status')) {
    if (!mapKey) return sj(res, 200, { hasKey: false, lastFetch: null, count: null, stale: false, ttlMs: 30 * 60_000, transactions: null });
    return sj(res, 200, { hasKey: true, lastFetch: _firmsCache?.at || null, count: _firmsCache?.fires?.length || null, stale: _firmsCache ? Date.now() - _firmsCache.at >= 30 * 60_000 : false, ttlMs: 30 * 60_000, transactions: null });
  }

  if (!mapKey) return sj(res, 503, { error: 'no_key' });

  const now = Date.now();
  const entry = _firmsCache;
  if (entry && now - entry.at < 30 * 60_000) return sj(res, 200, buildFirmsPayload(entry, false));

  if (!_firmsInflight) {
    _firmsInflight = refreshFirms(mapKey)
      .then(fresh => { _firmsCache = fresh; return fresh; })
      .catch(err => { console.warn('[firms] refresh failed:', err.message); return null; })
      .finally(() => { _firmsInflight = null; });
  }
  const fresh = await _firmsInflight;
  if (fresh) return sj(res, 200, buildFirmsPayload(fresh, false));
  if (entry) return sj(res, 200, buildFirmsPayload(entry, true));
  return sj(res, 502, { error: 'firms fetch failed and no cache available' });
}

// ─────────────────────────────────────────────────────────────────────────────
// REGIONAL BRIEF + WEATHER EFFECTS
// ─────────────────────────────────────────────────────────────────────────────
const _briefCache = new Map(), _wxCache = new Map();
function ck(lat, lon) { return `${(Math.round(lat * 10) / 10).toFixed(1)},${(Math.round(lon * 10) / 10).toFixed(1)}`; }

async function handleRegionalBrief(req, res) {
  const url = qurl(req); const latitude = Number(url.searchParams.get('latitude')), longitude = Number(url.searchParams.get('longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return sj(res, 400, { error: 'latitude and longitude required' });
  const k = ck(latitude, longitude), now = Date.now(), cached = _briefCache.get(k);
  if (cached && now - cached.at < 5 * 60_000) return sj(res, 200, { ...cached.payload, status: 'cached' });
  try {
    const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
    wxUrl.searchParams.set('latitude', latitude); wxUrl.searchParams.set('longitude', longitude);
    wxUrl.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m');
    wxUrl.searchParams.set('temperature_unit', 'celsius');
    const [weather, place] = await Promise.allSettled([
      fetch(wxUrl.toString(), { signal: mkAbort(8_000).signal }).then(r => r.ok ? r.json() : null),
      fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: mkAbort(8_000).signal }).then(r => r.ok ? r.json() : null),
    ]);
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: { latitude, longitude }, weather: weather.value ?? null, place: place.value ?? null };
    _briefCache.set(k, { at: now, payload }); if (_briefCache.size > 200) _briefCache.delete(_briefCache.keys().next().value);
    return sj(res, 200, payload);
  } catch { if (cached) return sj(res, 200, { ...cached.payload, status: 'stale' }); return sj(res, 503, { error: 'regional brief unavailable' }); }
}

async function handleWeatherEffects(req, res) {
  const url = qurl(req); const latitude = Number(url.searchParams.get('latitude')), longitude = Number(url.searchParams.get('longitude'));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return sj(res, 400, { error: 'latitude and longitude required' });
  const k = ck(latitude, longitude), now = Date.now(), cached = _wxCache.get(k);
  if (cached && now - cached.at < 3 * 60_000) return sj(res, 200, { ...cached.payload, status: 'cached' });
  try {
    const wxUrl = new URL('https://api.open-meteo.com/v1/forecast');
    wxUrl.searchParams.set('latitude', latitude); wxUrl.searchParams.set('longitude', longitude);
    wxUrl.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,cloud_cover,visibility,precipitation');
    wxUrl.searchParams.set('temperature_unit', 'celsius');
    const r = await fetch(wxUrl.toString(), { signal: mkAbort(8_000).signal });
    if (!r.ok) throw new Error(`Open-Meteo HTTP ${r.status}`);
    const weather = await r.json();
    const payload = { status: 'ready', retrievedAt: new Date().toISOString(), coordinates: { latitude, longitude }, weather };
    _wxCache.set(k, { at: now, payload }); if (_wxCache.size > 500) _wxCache.delete(_wxCache.keys().next().value);
    return sj(res, 200, payload);
  } catch { if (cached) return sj(res, 200, { ...cached.payload, status: 'stale' }); return sj(res, 503, { error: 'weather effects unavailable' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOMTOM — Fixed: correct URL flow/relative/ (not flow/relative0/)
// ─────────────────────────────────────────────────────────────────────────────
const _tileCache = new Map(); let _dailyCount = 0, _dailyDate = '';
function tomtomBudget() { return Number(process.env.TOMTOM_DAILY_TILE_BUDGET) || 40000; }
function tomtomOk() { const d = new Date().toISOString().slice(0, 10); if (_dailyDate !== d) { _dailyDate = d; _dailyCount = 0; } return _dailyCount < tomtomBudget(); }

async function handleTomtom(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  if (/\/tomtom\/status$/.test(urlPath) || urlPath.endsWith('/status')) {
    return sj(res, 200, { hasKey: Boolean(process.env.TOMTOM_API_KEY), dailyCount: _dailyCount, budget: tomtomBudget() });
  }
  const m = urlPath.match(/\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!m) return sj(res, 404, { error: 'not_found' });
  const [, z, x, y] = m;
  if (!process.env.TOMTOM_API_KEY) return sj(res, 503, { error: 'TOMTOM_API_KEY not set' });
  const tileKey = `${z}/${x}/${y}`, now = Date.now(), entry = _tileCache.get(tileKey);
  if (entry && now - entry.at < 120_000) return sr(res, 200, entry.buf, 'application/x-protobuf');
  if (!tomtomOk()) { if (entry) return sr(res, 200, entry.buf, 'application/x-protobuf'); return sj(res, 429, { error: 'budget exhausted' }); }
  try {
    // Fixed URL: flow/relative/ (not flow/relative0/)
    const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(process.env.TOMTOM_API_KEY)}`;
    const r = await fetch(tileUrl, { signal: mkAbort(10_000).signal });
    if (!r.ok) return sj(res, r.status === 401 || r.status === 403 ? r.status : 502, { error: `TomTom upstream error (HTTP ${r.status})` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0) throw new Error('empty tile body');
    _tileCache.set(tileKey, { at: now, buf }); _dailyCount++;
    return sr(res, 200, buf, 'application/x-protobuf');
  } catch (err) { if (entry) return sr(res, 200, entry.buf, 'application/x-protobuf'); return sj(res, 502, { error: `TomTom proxy error: ${err.message}` }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// AIS LIVE
// ─────────────────────────────────────────────────────────────────────────────
async function handleAisLive(req, res) {
  const hasKey = Boolean(process.env.AISSTREAM_API_KEY);
  res.setHeader('Cache-Control', 'no-store');
  if (!hasKey) return sj(res, 503, { rows: [], source: 'AISStream', status: 'no_key', error: 'AISSTREAM_API_KEY not configured', refreshing: false, newestPositionAt: null, lastMessageAt: null });
  return sj(res, 200, { rows: [], source: 'AISStream', status: 'degraded', error: 'AIS requires a persistent WebSocket. Deploy on Railway/Render for full AIS support.', refreshing: true, newestPositionAt: null, lastMessageAt: null });
}

// ─────────────────────────────────────────────────────────────────────────────
// CCTV
// ─────────────────────────────────────────────────────────────────────────────
const _cctvHealth = new Map(); let _cctvSrcs = null, _cctvSrcsAt = 0;
function buildSvgFrame({ cameraId, label, city, status }) {
  const seed = hashSeed(`${cameraId}:${label}:${city}`), hue = seed % 360, hue2 = (hue + 46) % 360;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="hsl(${hue},35%,10%)"/><stop offset="100%" stop-color="hsl(${hue2},42%,6%)"/></linearGradient><pattern id="scan" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="transparent"/><rect y="0" width="8" height="1" fill="rgba(255,255,255,0.08)"/></pattern></defs><rect width="960" height="540" fill="url(#bg)"/><rect width="960" height="540" fill="url(#scan)"/><g fill="#9cefff" font-family="monospace"><text x="74" y="54" font-size="16">CCTV FEED PLACEHOLDER</text><text x="74" y="512" font-size="14">${escXml(label)} · ${escXml(city || 'GLOBAL GRID')}</text><text x="74" y="486" font-size="13">${escXml(status || 'SYNTHETIC')}</text><text x="704" y="54" font-size="14">${escXml(ts)}</text><text x="646" y="512" font-size="13">${escXml(cameraId)}</text></g></svg>`;
}
async function getCctvSources() {
  const now = Date.now();
  if (_cctvSrcs && now - _cctvSrcsAt < 5 * 60_000) return _cctvSrcs;
  try {
    const r = await fetch('https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=100&$select=camera_id,location_latitude,location_longitude,camera_status', { signal: mkAbort(15_000).signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = await r.json();
    _cctvSrcs = rows.filter(row => row.camera_status === 'TURNED_ON' && row.location_latitude && row.location_longitude).slice(0, 36).map(row => ({ id: `austin-${row.camera_id}`, name: `Austin Camera ${row.camera_id}`, city: 'Austin', cityId: 'austin', provider: 'Austin Open Data', lat: parseFloat(row.location_latitude), lon: parseFloat(row.location_longitude), headingDeg: 0, fovDeg: 80, pitchDeg: -10, rangeM: 150, feedType: 'image', sourceKind: 'fallback' }));
    _cctvSrcsAt = now;
  } catch { _cctvSrcs = _cctvSrcs || []; }
  return _cctvSrcs || [];
}
async function handleCctv(req, res) {
  const url = qurl(req); const sub = url.pathname.replace(/^\/api\/cctv\/?/, '');
  try {
    const sources = await getCctvSources(); const sourceById = new Map(sources.map(s => [s.id, s]));
    if (sub === 'sources' || sub === '') { res.setHeader('Cache-Control', 'no-store'); return sj(res, 200, { sources: sources.map(s => ({ id: s.id, name: s.name, city: s.city, cityId: s.cityId, provider: s.provider, lat: s.lat, lon: s.lon, headingDeg: s.headingDeg, pitchDeg: s.pitchDeg, fovDeg: s.fovDeg, rangeM: s.rangeM, feedType: s.feedType || 'image', sourceKind: s.sourceKind || 'fallback' })) }); }
    if (sub === 'health') { res.setHeader('Cache-Control', 'no-store'); return sj(res, 200, { cameras: Array.from(_cctvHealth.values()) }); }
    if (sub.startsWith('stream/')) { const cameraId = decodeURIComponent(sub.replace('stream/', '').trim()); const source = sourceById.get(cameraId); res.setHeader('Cache-Control', 'no-store'); return sj(res, 200, { id: cameraId, feedType: source?.feedType || 'image', mediaUrl: null, frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`, provider: source?.provider || '', sourceKind: source?.sourceKind || 'fallback' }); }
    if (sub.startsWith('frame/')) {
      const cameraId = decodeURIComponent(sub.replace('frame/', '').trim());
      const source = sourceById.get(cameraId);
      const label = url.searchParams.get('label') || source?.name || cameraId;
      const city = url.searchParams.get('city') || source?.city || '';
      const lat = Number(url.searchParams.get('lat') ?? source?.lat);
      const lon_ = Number(url.searchParams.get('lon') ?? source?.lon);
      const heading = Number(url.searchParams.get('heading') ?? source?.headingDeg ?? 0);
      const fov = Number(url.searchParams.get('fov') ?? source?.fovDeg ?? 80);
      const pitch = Number(url.searchParams.get('pitch') ?? source?.pitchDeg ?? -10);
      const svKey = process.env.GOOGLE_MAPS_API_KEY;
      if (svKey && Number.isFinite(lat) && Number.isFinite(lon_)) {
        try {
          const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
          sv.searchParams.set('size', '960x540'); sv.searchParams.set('location', `${lat},${lon_}`);
          sv.searchParams.set('heading', String(Number.isFinite(heading) ? heading : 0));
          sv.searchParams.set('fov', String(Math.max(20, Math.min(120, Number.isFinite(fov) ? fov : 80))));
          sv.searchParams.set('pitch', String(Math.max(-40, Math.min(20, Number.isFinite(pitch) ? pitch : -10))));
          sv.searchParams.set('source', 'outdoor'); sv.searchParams.set('return_error_code', 'true'); sv.searchParams.set('key', svKey);
          const svResp = await fetch(sv.toString(), { headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' }, signal: mkAbort(8_000).signal });
          const svType = svResp.headers.get('content-type') || '';
          if (svResp.ok && svType.startsWith('image/')) {
            _cctvHealth.set(cameraId, { id: cameraId, status: 'degraded', sourceKind: 'streetview', label: 'Google Street View', message: 'Fallback Street View frame', updatedAt: Date.now() });
            res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-CCTV-Source', 'streetview');
            return sr(res, 200, Buffer.from(await svResp.arrayBuffer()), svType);
          }
        } catch { /* fall through to synthetic */ }
      }
      _cctvHealth.set(cameraId, { id: cameraId, status: 'degraded', sourceKind: 'synthetic', label: source?.provider || 'Synthetic', message: 'No source configured', updatedAt: Date.now() });
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-CCTV-Source', 'synthetic');
      return sr(res, 200, buildSvgFrame({ cameraId, label, city, status: 'NO UPSTREAM CONFIGURED' }), 'image/svg+xml');
    }
    if (sub.startsWith('media/')) { res.setHeader('Cache-Control', 'no-store'); return sj(res, 404, { error: 'No media URL configured for this camera' }); }
    return sj(res, 404, { error: `Unknown CCTV route: ${sub}` });
  } catch (err) { console.error('[cctv]', err.message); return sj(res, 500, { error: 'CCTV proxy error' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// GBFS
// ─────────────────────────────────────────────────────────────────────────────
const GBFS_HOSTS = new Set(['gbfs.lyft.com', 'gbfs.baywheels.com', 'gbfs.capitalbikeshare.com', 'gbfs.citibikenyc.com', 'gbfs.divvybikes.com', 'gbfs.bluebikes.com', 'data.lime.bike']);
async function handleGbfs(req, res) {
  const encoded = (req.url || '').replace(/.*\/gbfs\//, '');
  let upstreamUrl; try { upstreamUrl = new URL(decodeURIComponent(encoded)); } catch { return sj(res, 400, { error: 'invalid URL' }); }
  if (upstreamUrl.protocol !== 'https:') return sj(res, 400, { error: 'HTTPS only' });
  const host = upstreamUrl.hostname.toLowerCase();
  if (!GBFS_HOSTS.has(host) && !host.endsWith('.publicbikesystem.net')) return sj(res, 403, { error: 'host not allowlisted' });
  if (!/\/station_(information|status)\.json$/i.test(upstreamUrl.pathname)) return sj(res, 403, { error: 'only station endpoints allowed' });
  try {
    const r = await fetch(upstreamUrl.toString(), { signal: mkAbort(10_000).signal });
    res.setHeader('Cache-Control', /station_information/i.test(upstreamUrl.pathname) ? 'public, max-age=300' : 'no-store');
    return sr(res, r.status, Buffer.from(await r.arrayBuffer()), 'application/json');
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// RADIO — Fixed: acceptedGeneration + catalogInstance required by radio.js
// ─────────────────────────────────────────────────────────────────────────────
const RADIO_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let _radioCatalog = null, _radioAt = 0, _radioGen = 0;
const _radioCatalogInstance = randomUUID(); // stable per process (matches vite.config behaviour)

function cleanRadioText(value, maxLength) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength).trim(); }
function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? '')); const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !h) return null;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return null;
    url.hash = ''; return url.href;
  } catch { return null; }
}

function normalizeStation(raw) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  if (!RADIO_UUID_RE.test(id)) return null;
  if (Number(raw?.lastcheckok) !== 1) return null;
  if (Number(raw?.hls) === 1) return null;
  const lat = raw?.geo_lat === null || raw?.geo_lat === '' ? null : Number(raw?.geo_lat);
  const lon = raw?.geo_long === null || raw?.geo_long === '' ? null : Number(raw?.geo_long);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  if (!/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec)) return null;
  const streamUrl = publicRadioHttpsUrl(raw?.url_resolved || raw?.url);
  if (!streamUrl) return null;
  const name = cleanRadioText(raw?.name, 140); if (!name) return null;
  const tags = String(raw?.tags ?? '').split(',').map(t => cleanRadioText(t, 80).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean).filter((t, i, a) => a.indexOf(t) === i).slice(0, 24);
  const languages = String(raw?.language ?? '').split(',').map(l => cleanRadioText(l, 40)).filter(Boolean).slice(0, 8);
  const countryCode = cleanRadioText(raw?.countrycode, 2).toUpperCase();
  const bitrate = Number(raw?.bitrate);
  return {
    id, name, lat, lon, streamUrl,
    homepage: publicRadioHttpsUrl(raw?.homepage) ?? null,
    tags, languages,
    state: cleanRadioText(raw?.state, 80),
    country: cleanRadioText(raw?.country, 80),
    countryCode,
    metadataTrust: 'untrusted-community',
    codec,
    bitrate: Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024 ? bitrate : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  };
}

async function fetchRadioPath(pathname) {
  const origins = ['https://de1.api.radio-browser.info', 'https://nl1.api.radio-browser.info', 'https://at1.api.radio-browser.info'];
  let lastErr;
  for (const origin of origins) {
    try {
      const r = await fetch(`${origin}${pathname}`, { headers: { 'User-Agent': 'gods-eye-view/1.0', Accept: 'application/json' }, signal: mkAbort(15_000).signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('No Radio Browser mirror available');
}

async function buildRadioCatalog() {
  const queries = [null, 'news', 'talk', 'weather', 'emergency', 'scanner', 'aviation', 'marine', 'traffic'];
  const results = await Promise.allSettled(queries.map(async (tag) => {
    const params = new URLSearchParams({ has_geo_info: 'true', is_https: 'true', hidebroken: 'true', order: 'clickcount', reverse: 'true', limit: tag ? '220' : '1800' });
    if (tag) params.set('tag', tag);
    try { const rows = await fetchRadioPath(`/json/stations/search?${params}`); return Array.isArray(rows) ? rows : []; }
    catch { return []; }
  }));
  const seen = new Set(), selected = [];
  // Specialist queries first, then popularity fill (mirrors vite.config ordering)
  for (const result of results.slice(1)) { if (result.status === 'fulfilled') { for (const raw of result.value.slice(0, 45)) { const s = normalizeStation(raw); if (s && !seen.has(s.id)) { seen.add(s.id); selected.push(s); if (selected.length >= 2000) break; } } } }
  if (results[0].status === 'fulfilled') {
    const sorted = [...results[0].value].sort((a, b) => (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0));
    for (const raw of sorted) { const s = normalizeStation(raw); if (s && !seen.has(s.id)) { seen.add(s.id); selected.push(s); if (selected.length >= 2000) break; } }
  }
  const stations = selected.map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, streamUrl: s.streamUrl, homepage: s.homepage, tags: s.tags, languages: s.languages, state: s.state, country: s.country, countryCode: s.countryCode, metadataTrust: s.metadataTrust, codec: s.codec, bitrate: s.bitrate }));
  return { stations, updatedAt: new Date().toISOString(), stale: false, degraded: false, degradedReason: null, acceptedGeneration: ++_radioGen, catalogInstance: _radioCatalogInstance };
}

let _radioRefreshPromise = null;
async function getRadioCatalog() {
  const now = Date.now();
  if (_radioCatalog && now - _radioAt < 45 * 60_000) return { ..._radioCatalog, stale: false };
  if (!_radioRefreshPromise) {
    _radioRefreshPromise = buildRadioCatalog().then(catalog => { _radioCatalog = catalog; _radioAt = Date.now(); return catalog; }).finally(() => { _radioRefreshPromise = null; });
  }
  if (_radioCatalog) return { ..._radioCatalog, stale: true }; // serve stale while refreshing
  return _radioRefreshPromise;
}

async function handleRadio(req, res) {
  const url = qurl(req); const sub = url.pathname.replace(/^\/api\/radio\/?/, '');

  if (sub === 'stations') {
    if (req.method !== 'GET') return sj(res, 405, { error: 'GET only' });
    try {
      const catalog = await getRadioCatalog();
      res.setHeader('Cache-Control', 'no-store');
      return sj(res, 200, catalog);
    } catch (err) { return sj(res, 503, { error: 'Radio directory temporarily unavailable', degraded: true, degradedReason: err.message }); }
  }

  const clickMatch = sub.match(/^click\/([0-9a-f-]+)$/i);
  if (clickMatch) {
    if (req.method !== 'POST') return sj(res, 405, { error: 'POST only' });
    if (!RADIO_UUID_RE.test(clickMatch[1].toLowerCase())) return sj(res, 404, { error: 'Unknown radio station' });
    void fetchRadioPath(`/json/url/${clickMatch[1].toLowerCase()}`).catch(() => {});
    return res.status(204).end();
  }

  try {
    const fwdPath = url.pathname.replace(/^\/api\/radio/, '') || '/json/stations/topclick';
    const r = await fetch(`https://all.api.radio-browser.info${fwdPath}${url.search}`, { headers: { 'User-Agent': 'gods-eye-view/1.0', Accept: 'application/json' }, signal: mkAbort(10_000).signal });
    res.setHeader('Cache-Control', 'public, max-age=300');
    return sr(res, r.status, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || 'application/json');
  } catch (err) { return sj(res, 502, { error: err.message }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const path = (req.url || '').split('?')[0];

  if (path === '/api/opensky')               return handleOpenSky(req, res);
  if (path === '/api/opensky-track')         return handleOpenSkyTrack(req, res);
  if (path === '/api/adsbdb')                return handleAdsbdb(req, res);
  if (path === '/api/adsblol/mil')           return handleAdsbLolMil(req, res);
  if (path === '/api/adsblol/trace')         return handleAdsbLolTrace(req, res);
  if (path.startsWith('/api/celestrak/'))    return handleCelestrak(req, res);
  if (path === '/api/launches')              return handleLaunches(req, res);
  if (path === '/api/openai/hud-summary')    return handleHudSummary(req, res);
  if (path === '/api/realtime/token')        return handleRealtimeToken(req, res);
  if (path === '/api/realtime/debug-log')    return handleRealtimeDebugLog(req, res);
  if (path === '/api/google/nearby-places')  return handleNearbyPlaces(req, res);
  if (path === '/api/google/text-search')    return handleTextSearch(req, res);
  if (path === '/api/overpass')              return handleOverpass(req, res);
  if (path === '/api/route')                 return handleRoute(req, res);
  if (path === '/api/terrain/heights')       return handleTerrainHeights(req, res);
  if (path === '/api/military-installations') return handleMilitaryInstallations(req, res);
  if (path === '/api/firms' || path.startsWith('/api/firms/')) return handleFirms(req, res);
  if (path === '/api/regional-brief')        return handleRegionalBrief(req, res);
  if (path === '/api/weather-effects')       return handleWeatherEffects(req, res);
  if (path.startsWith('/api/tomtom'))        return handleTomtom(req, res);
  if (path === '/api/ais-live' || path.startsWith('/api/ais-live/')) return handleAisLive(req, res);
  if (path === '/api/cctv' || path.startsWith('/api/cctv/')) return handleCctv(req, res);
  if (path.startsWith('/api/gbfs/'))         return handleGbfs(req, res);
  if (path === '/api/radio' || path.startsWith('/api/radio/')) return handleRadio(req, res);

  return sj(res, 404, { error: `No API handler for ${path}` });
}
