/**
 * /api/adsbdb — adsbdb.com aircraft enrichment proxy.
 *
 * GET /api/adsbdb?kind=route&key=UAL123
 * GET /api/adsbdb?kind=aircraft&key=a1b2c3
 *
 * Free community API. Cached 24h in memory. No API key required.
 */

const TTL_MS = 24 * 3600_000;
const cache = { routes: new Map(), aircraft: new Map() };

async function lookup(kind, key) {
  const store = kind === 'route' ? cache.routes : cache.aircraft;
  const entry = store.get(key);
  const now = Date.now();
  if (entry && now - entry.at < TTL_MS) return entry.data;

  const url = kind === 'route'
    ? `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(key)}`
    : `https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(key)}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (res.status === 404) {
    store.set(key, { at: now, data: null });
    return null;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();

  let data = null;
  if (kind === 'route') {
    const fr = json?.response?.flightroute;
    if (fr?.origin && fr?.destination) {
      const airport = a => ({
        code: a.iata_code || a.icao_code || '',
        name: a.municipality || a.name || '',
        lat: Number.isFinite(a.latitude) ? a.latitude : null,
        lon: Number.isFinite(a.longitude) ? a.longitude : null,
      });
      data = { airline: fr.airline?.name || null, origin: airport(fr.origin), destination: airport(fr.destination) };
    }
  } else {
    const a = json?.response?.aircraft;
    if (a) {
      data = {
        typeCode: a.icao_type || null,
        typeName: a.manufacturer && a.type ? `${a.manufacturer} ${a.type}` : (a.type || null),
        registration: a.registration || null,
      };
    }
  }

  store.set(key, { at: now, data });
  return data;
}

export default async function handler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  const kind = url.searchParams.get('kind');
  const key = (url.searchParams.get('key') || '').trim();

  if (!['route', 'aircraft'].includes(kind) || !key) {
    return res.status(400).json({ error: 'kind (route|aircraft) and key are required' });
  }

  try {
    const data = await lookup(kind, key);
    return res.status(200).json({ data });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'adsbdb proxy error' });
  }
}
