/**
 * /api/adsblol/trace — adsb.lol flight trace proxy.
 * GET /api/adsblol/trace?hex=abc123
 * No API key required.
 */

export default async function handler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  const hex = (url.searchParams.get('hex') || '').toLowerCase().trim();

  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return res.status(400).json({ error: 'hex must be a 6-character hex ICAO address' });
  }

  try {
    const upstream = await fetch(`https://api.adsb.lol/v2/icao/${hex}`, {
      headers: { 'User-Agent': 'gods-eye-view-adsblol-proxy/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'adsb.lol trace proxy error' });
  }
}
