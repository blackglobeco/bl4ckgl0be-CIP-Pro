/**
 * /api/gbfs/[encoded-url] — GBFS bike-share station proxy.
 * GET /api/gbfs/<encoded-upstream-URL>
 * Allowlists known GBFS providers. No API key required.
 */

const ALLOWED_HOSTS = new Set([
  'gbfs.lyft.com', 'gbfs.baywheels.com', 'gbfs.capitalbikeshare.com',
  'gbfs.citibikenyc.com', 'gbfs.divvybikes.com', 'gbfs.bluebikes.com',
  'gbfs.bcycle.com', 'gbfs.spinbike.com', 'data.lime.bike',
  'toronto-c1.publicbikesystem.net', 'vancouver-c1.publicbikesystem.net',
]);

function isAllowedHost(hostname) {
  const h = (hostname || '').toLowerCase().trim();
  if (ALLOWED_HOSTS.has(h)) return true;
  return h.endsWith('.publicbikesystem.net');
}

function isAllowedPath(pathname) {
  return /\/station_(information|status)\.json$/i.test(pathname || '');
}

const MAX_BYTES = 5 * 1024 * 1024;

export default async function handler(req, res) {
  // URL is the part after /api/gbfs/ — decode it
  const encoded = (req.url || '').replace(/^\//, '');
  let upstreamUrl;
  try {
    upstreamUrl = new URL(decodeURIComponent(encoded));
  } catch {
    return res.status(400).json({ error: 'invalid URL' });
  }

  if (upstreamUrl.protocol !== 'https:') return res.status(400).json({ error: 'HTTPS only' });
  if (!isAllowedHost(upstreamUrl.hostname)) return res.status(403).json({ error: 'host not allowlisted' });
  if (!isAllowedPath(upstreamUrl.pathname)) return res.status(403).json({ error: 'only station_information/status endpoints allowed' });

  try {
    const upstream = await fetch(upstreamUrl.toString(), { signal: AbortSignal.timeout(10_000) });
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return res.status(502).json({ error: 'response too large' });

    const cacheControl = /station_information/i.test(upstreamUrl.pathname)
      ? 'public, max-age=300'
      : 'no-store';

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', cacheControl);
    return res.status(upstream.status).send(Buffer.from(buf));
  } catch (err) {
    return res.status(502).json({ error: err.message || 'GBFS proxy error' });
  }
}
