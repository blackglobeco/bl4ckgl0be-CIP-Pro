/**
 * /api/radio — Radio Browser public station directory proxy.
 * Forwards requests to all.api.radio-browser.info.
 * No API key required.
 */

const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_PATHS = new Set(['/json/stations/bycountry', '/json/stations/search', '/json/servers', '/json/stations/topclick', '/json/stations/topvote']);

export default async function handler(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  const queryString = (req.url || '').includes('?') ? '?' + req.url.split('?')[1] : '';

  // Allow /json/stations/* paths broadly
  if (!urlPath.startsWith('/json/') && !urlPath.startsWith('/api/radio')) {
    return res.status(404).json({ error: 'not_found' });
  }

  const cleanPath = urlPath; // already stripped of /api/radio prefix by Vercel routing

  try {
    const upstream = await fetch(`https://all.api.radio-browser.info${cleanPath}${queryString}`, {
      headers: {
        'User-Agent': 'gods-eye-view/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    const buf = await upstream.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return res.status(502).json({ error: 'response too large' });

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(upstream.status).send(Buffer.from(buf));
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Radio Browser proxy error' });
  }
}
