/**
 * /api/tomtom — TomTom live traffic flow tile proxy.
 *
 * Routes:
 *   GET /api/tomtom/status          → {hasKey, dailyCount, budget}
 *   GET /api/tomtom/flow/z/x/y.pbf  → protobuf tile
 *
 * Requires TOMTOM_API_KEY env var. Without it, returns 503.
 * In-memory tile cache (TTL 30s). Budget governor via TOMTOM_DAILY_TILE_BUDGET.
 */

const TILE_TTL_MS = 30_000;
const mem = new Map();
let dailyCount = 0;
let dailyDate = '';

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getBudget() {
  return Number(process.env.TOMTOM_DAILY_TILE_BUDGET) || 40000;
}

function isOverBudget() {
  const d = today();
  if (dailyDate !== d) { dailyDate = d; dailyCount = 0; }
  return dailyCount >= getBudget();
}

export default async function handler(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  const sendJson = (status, obj) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(status).json(obj);
  };

  if (urlPath === '/status') {
    return sendJson(200, {
      hasKey: Boolean(process.env.TOMTOM_API_KEY),
      dailyCount,
      budget: getBudget(),
      date: today(),
    });
  }

  const m = urlPath.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
  if (!m) return sendJson(404, { error: 'not_found' });

  const [, z, x, y] = m;
  if (!process.env.TOMTOM_API_KEY) return sendJson(503, { error: 'no_key' });

  const key = `${z}/${x}/${y}`;
  const now = Date.now();
  const entry = mem.get(key);

  if (entry && now - entry.at < TILE_TTL_MS) {
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-tomtom-cache', 'HIT');
    return res.status(200).send(entry.buf);
  }

  if (isOverBudget()) {
    if (entry) {
      res.setHeader('Content-Type', 'application/x-protobuf');
      res.setHeader('x-tomtom-cache', 'STALE-BUDGET');
      return res.status(200).send(entry.buf);
    }
    return sendJson(429, { error: 'budget' });
  }

  try {
    const tileUrl = `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.pbf?key=${process.env.TOMTOM_API_KEY}&thickness=10`;
    const upstream = await fetch(tileUrl, { signal: AbortSignal.timeout(10_000) });

    if (!upstream.ok) return sendJson(502, { error: 'upstream' });

    const buf = Buffer.from(await upstream.arrayBuffer());
    mem.set(key, { at: now, buf });
    dailyCount++;

    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('x-tomtom-cache', 'MISS');
    return res.status(200).send(buf);
  } catch (err) {
    if (entry) {
      res.setHeader('Content-Type', 'application/x-protobuf');
      res.setHeader('x-tomtom-cache', 'STALE-ERR');
      return res.status(200).send(entry.buf);
    }
    return sendJson(502, { error: 'proxy' });
  }
}
