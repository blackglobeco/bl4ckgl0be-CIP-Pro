/**
 * /api/aircraft — All aircraft-related proxies in one function.
 *
 * Routes (matched by X-GEV-Route header or path suffix):
 *   GET /api/aircraft/opensky        → OpenSky live state vectors
 *   GET /api/aircraft/opensky-track  → OpenSky flight track
 *   GET /api/aircraft/adsbdb         → adsbdb.com route/aircraft enrichment
 *   GET /api/aircraft/adsblol-mil    → adsb.lol military aircraft
 *   GET /api/aircraft/adsblol-trace  → adsb.lol flight trace
 */

// ---------------------------------------------------------------------------
// OpenSky state
// ---------------------------------------------------------------------------
let _osCache = null, _osCacheAt = 0, _osTtlMs = 15_000, _osCooldownUntil = 0;
let _osToken = null, _osTokenExpiry = 0, _osTokenPromise = null;

async function getOAuthToken() {
  const now = Date.now();
  if (_osToken && now < _osTokenExpiry - 30_000) return _osToken;
  if (_osTokenPromise) return _osTokenPromise;
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  _osTokenPromise = (async () => {
    try {
      const r = await fetch('https://auth.opensky-network.org/realms/opensky-network/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
        signal: AbortSignal.timeout(10_000),
      });
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
  const mode = (process.env.OPENSKY_AUTH_MODE || 'oauth').toLowerCase();
  if (_osCache && (now - _osCacheAt < _osTtlMs || now < _osCooldownUntil)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GEV-Cache', now < _osCooldownUntil ? 'COOLDOWN' : 'HIT');
    return res.status(200).send(_osCache);
  }
  const headers = { Accept: 'application/json' };
  if (mode === 'oauth' || mode === 'auto') {
    const token = await getOAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (mode === 'auto') {
      const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD;
      if (u && p) headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    }
  } else if (mode === 'basic') {
    const u = process.env.OPENSKY_USERNAME, p = process.env.OPENSKY_PASSWORD;
    if (u && p) headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  }
  try {
    const upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', { headers, signal: AbortSignal.timeout(20_000) });
    const body = await upstream.text();
    if (upstream.status === 429) {
      _osCooldownUntil = now + 120_000;
      if (_osCache) { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-GEV-Cache', 'STALE-429'); return res.status(200).send(_osCache); }
    }
    if (upstream.ok) { _osCache = body; _osCacheAt = now; _osCooldownUntil = 0; _osTtlMs = 15_000; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GEV-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    if (_osCache) { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-GEV-Cache', 'STALE-ERR'); return res.status(200).send(_osCache); }
    return res.status(502).json({ error: 'OpenSky proxy error' });
  }
}

async function handleOpenSkyTrack(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const icao24 = url.searchParams.get('icao24');
  if (!icao24) return res.status(400).json({ error: 'icao24 required' });
  const headers = { Accept: 'application/json' };
  const cid = process.env.OPENSKY_CLIENT_ID, cs = process.env.OPENSKY_CLIENT_SECRET;
  if (cid && cs) headers.Authorization = `Basic ${Buffer.from(`${cid}:${cs}`).toString('base64')}`;
  try {
    const u = new URL('https://opensky-network.org/api/tracks/all');
    u.searchParams.set('icao24', icao24);
    const begin = url.searchParams.get('begin');
    if (begin) u.searchParams.set('time', begin);
    const upstream = await fetch(u.toString(), { headers, signal: AbortSignal.timeout(15_000) });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body);
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// adsbdb cache
// ---------------------------------------------------------------------------
const _adsbdbCache = { routes: new Map(), aircraft: new Map() };
const ADSBDB_TTL = 24 * 3600_000;

async function handleAdsbdb(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const kind = url.searchParams.get('kind');
  const key = (url.searchParams.get('key') || '').trim();
  if (!['route', 'aircraft'].includes(kind) || !key) return res.status(400).json({ error: 'kind and key required' });
  const store = kind === 'route' ? _adsbdbCache.routes : _adsbdbCache.aircraft;
  const entry = store.get(key);
  const now = Date.now();
  if (entry && now - entry.at < ADSBDB_TTL) return res.status(200).json({ data: entry.data });
  try {
    const upUrl = kind === 'route' ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}` : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;
    const r = await fetch(upUrl, { signal: AbortSignal.timeout(8_000) });
    if (r.status === 404) { store.set(key, { at: now, data: null }); return res.status(200).json({ data: null }); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const json = await r.json();
    let data = null;
    if (kind === 'route') {
      const fr = json?.response?.flightroute;
      if (fr?.origin && fr?.destination) {
        const ap = a => ({ code: a.iata_code || a.icao_code || '', name: a.municipality || a.name || '', lat: Number.isFinite(a.latitude) ? a.latitude : null, lon: Number.isFinite(a.longitude) ? a.longitude : null });
        data = { airline: fr.airline?.name || null, origin: ap(fr.origin), destination: ap(fr.destination) };
      }
    } else {
      const a = json?.response?.aircraft;
      if (a) data = { typeCode: a.icao_type || null, typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null), registration: a.registration || null };
    }
    store.set(key, { at: now, data });
    return res.status(200).json({ data });
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// adsb.lol
// ---------------------------------------------------------------------------
let _milCache = null, _milCacheAt = 0;
const MIL_CACHE_MS = 30_000;

async function handleAdsbLolMil(req, res) {
  const now = Date.now();
  if (_milCache && now - _milCacheAt < MIL_CACHE_MS) {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-ADS-B-Cache', 'HIT');
    return res.status(200).send(_milCache);
  }
  try {
    const upstream = await fetch('https://api.adsb.lol/v2/mil', { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(10_000) });
    const body = await upstream.text();
    if (upstream.ok) { _milCache = body; _milCacheAt = now; }
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-ADS-B-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    if (_milCache) { res.setHeader('Content-Type', 'application/json'); res.setHeader('X-ADS-B-Cache', 'STALE'); return res.status(200).send(_milCache); }
    return res.status(502).json({ error: 'adsb.lol proxy error' });
  }
}

async function handleAdsbLolTrace(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const hex = (url.searchParams.get('hex') || '').toLowerCase().trim();
  if (!/^[0-9a-f]{6}$/.test(hex)) return res.status(400).json({ error: 'hex must be 6-char ICAO' });
  try {
    const upstream = await fetch(`https://api.adsb.lol/v2/icao/${hex}`, { headers: { 'User-Agent': 'gods-eye-view/1.0' }, signal: AbortSignal.timeout(10_000) });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body);
  } catch (err) { return res.status(502).json({ error: err.message }); }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/opensky-track')) return handleOpenSkyTrack(req, res);
  if (path.endsWith('/adsbdb')) return handleAdsbdb(req, res);
  if (path.endsWith('/adsblol-mil')) return handleAdsbLolMil(req, res);
  if (path.endsWith('/adsblol-trace')) return handleAdsbLolTrace(req, res);
  return handleOpenSky(req, res); // default: /opensky
}
