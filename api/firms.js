/**
 * /api/firms — NASA FIRMS live active-fire proxy.
 *
 * Routes:
 *   GET /api/firms         → {fetchedAt, stale, sources, count, fires}
 *   GET /api/firms/status  → {hasKey, lastFetch, count}
 *
 * Requires FIRMS_MAP_KEY env var. Without it, returns 503.
 * Merges three VIIRS NRT sources: NOAA-20, NOAA-21, Suomi-NPP.
 * Cached 30 minutes in memory.
 */

const TTL_MS = 30 * 60_000;
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];

let cache = null;

function mapKey() { return (process.env.FIRMS_MAP_KEY || '').trim(); }

function parseFirmsCsv(text) {
  if (!text || !text.includes(',')) return null;
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const latIdx = header.indexOf('latitude');
  const lonIdx = header.indexOf('longitude');
  const acrIdx = header.indexOf('acq_date');
  const atmIdx = header.indexOf('acq_time');
  if (latIdx < 0 || lonIdx < 0) return null;
  return lines.slice(1).map(line => {
    const parts = line.split(',');
    return {
      latitude: parseFloat(parts[latIdx]),
      longitude: parseFloat(parts[lonIdx]),
      acq_date: parts[acrIdx] || '',
      acq_time: parts[atmIdx] || '',
      raw: Object.fromEntries(header.map((h, i) => [h, parts[i]])),
    };
  }).filter(f => Number.isFinite(f.latitude) && Number.isFinite(f.longitude));
}

function filterTrailing24h(fires, now = Date.now()) {
  const cutoff = now - 24 * 3600_000;
  return fires.filter(f => {
    try {
      const timeStr = f.acq_time?.toString().padStart(4, '0') || '0000';
      const dt = new Date(`${f.acq_date}T${timeStr.slice(0, 2)}:${timeStr.slice(2)}:00Z`);
      return dt.getTime() > cutoff;
    } catch { return false; }
  });
}

async function fetchSource(key, source) {
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}/${source}/world/2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const records = parseFirmsCsv(await res.text());
  if (records === null) throw new Error('non-CSV response');
  return records;
}

async function refresh(key) {
  const now = Date.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchSource(key, source), now);
      sources.push({ source, count: records.length, ok: true });
      fires.push(...records);
    } catch (err) {
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some(s => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

export default async function handler(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  const key = mapKey();

  const sendJson = (status, obj) => {
    res.setHeader('Content-Type', 'application/json');
    return res.status(status).json(obj);
  };

  if (urlPath === '/status') {
    return sendJson(200, {
      hasKey: Boolean(key),
      lastFetch: cache?.at || null,
      count: cache?.fires?.length || 0,
      stale: cache ? Date.now() - cache.at > TTL_MS : true,
    });
  }

  if (!key) return sendJson(503, { error: 'no_key' });

  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) {
    const fires = filterTrailing24h(cache.fires, now);
    return sendJson(200, { fetchedAt: cache.at, stale: false, ttlMs: TTL_MS, sources: cache.sources, count: fires.length, fires });
  }

  try {
    cache = await refresh(key);
    const fires = filterTrailing24h(cache.fires, Date.now());
    return sendJson(200, { fetchedAt: cache.at, stale: false, ttlMs: TTL_MS, sources: cache.sources, count: fires.length, fires });
  } catch (err) {
    if (cache) {
      const fires = filterTrailing24h(cache.fires, Date.now());
      return sendJson(200, { fetchedAt: cache.at, stale: true, ttlMs: TTL_MS, sources: cache.sources, count: fires.length, fires });
    }
    return sendJson(502, { error: err.message || 'FIRMS proxy error' });
  }
}
