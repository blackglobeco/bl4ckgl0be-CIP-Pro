/**
 * /api/opensky — OpenSky Network aircraft state-vector proxy.
 *
 * Supports OAuth (client_credentials), Basic auth, and anonymous access.
 * Auth mode is chosen via OPENSKY_AUTH_MODE env var (oauth | basic | anon | auto).
 * Includes in-memory caching and adaptive TTL to respect OpenSky credit limits.
 */

// ---------------------------------------------------------------------------
// In-memory cache (survives within one function warm instance)
// ---------------------------------------------------------------------------
let _cache = null;
let _cacheAt = 0;
let _cacheTtlMs = 15_000;
let _cacheStatus = 0;
let _cooldownUntil = 0;

// ---------------------------------------------------------------------------
// OAuth token state
// ---------------------------------------------------------------------------
let _token = null;
let _tokenExpiry = 0;
let _tokenPromise = null;

async function getOAuthToken() {
  const now = Date.now();
  if (_token && now < _tokenExpiry - 30_000) return _token;
  if (_tokenPromise) return _tokenPromise;

  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  _tokenPromise = (async () => {
    try {
      const res = await fetch('https://auth.opensky-network.org/realms/opensky-network/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      _token = data.access_token || null;
      _tokenExpiry = now + (data.expires_in || 3600) * 1000;
      return _token;
    } catch {
      return null;
    } finally {
      _tokenPromise = null;
    }
  })();

  return _tokenPromise;
}

export default async function handler(req, res) {
  const now = Date.now();
  const mode = (process.env.OPENSKY_AUTH_MODE || 'oauth').toLowerCase();

  // Serve from cache if fresh or in cooldown
  if (_cache && (now - _cacheAt < _cacheTtlMs || now < _cooldownUntil)) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GEV-Cache', now < _cooldownUntil ? 'COOLDOWN' : 'HIT');
    res.status(_cacheStatus || 200).send(_cache);
    return;
  }

  // Build auth headers
  const headers = { Accept: 'application/json' };

  if (mode === 'oauth' || mode === 'auto') {
    const token = await getOAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (mode === 'auto') {
      const u = process.env.OPENSKY_USERNAME;
      const p = process.env.OPENSKY_PASSWORD;
      if (u && p) headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    }
  } else if (mode === 'basic') {
    const u = process.env.OPENSKY_USERNAME;
    const p = process.env.OPENSKY_PASSWORD;
    if (u && p) headers.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  }
  // mode === 'anon': no auth header

  try {
    const upstream = await fetch('https://opensky-network.org/api/states/all?extended=1', {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    const body = await upstream.text();

    if (upstream.status === 429) {
      const retryAfter = Number(upstream.headers.get('x-rate-limit-retry-after-seconds')) || 120;
      _cooldownUntil = now + Math.min(Math.max(retryAfter * 1000, 30_000), 30 * 60_000);
      if (_cache) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-GEV-Cache', 'STALE-429');
        return res.status(200).send(_cache);
      }
    }

    if (upstream.ok) {
      _cache = body;
      _cacheAt = now;
      _cacheStatus = 200;
      _cooldownUntil = 0;
      const remaining = Number(upstream.headers.get('x-rate-limit-remaining'));
      if (Number.isFinite(remaining) && remaining < 200) {
        _cacheTtlMs = Math.min(60_000, _cacheTtlMs * 2);
      } else {
        _cacheTtlMs = 15_000;
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GEV-Cache', 'MISS');
    return res.status(upstream.status).send(body);
  } catch (err) {
    console.error('[opensky]', err.message);
    if (_cache) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-GEV-Cache', 'STALE-ERR');
      return res.status(200).send(_cache);
    }
    return res.status(502).json({ error: 'OpenSky proxy error' });
  }
}
