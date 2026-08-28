/**
 * /api/opensky-track — OpenSky track backfill proxy.
 * Proxies track requests to OpenSky Network.
 */

export default async function handler(req, res) {
  const url = new URL(req.url || '', 'http://localhost');
  const icao24 = url.searchParams.get('icao24');
  const begin = url.searchParams.get('begin');
  const end = url.searchParams.get('end');

  if (!icao24) {
    return res.status(400).json({ error: 'icao24 required' });
  }

  const headers = { Accept: 'application/json' };
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;
  if (clientId && clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  try {
    const upstreamUrl = new URL('https://opensky-network.org/api/tracks/all');
    upstreamUrl.searchParams.set('icao24', icao24);
    if (begin) upstreamUrl.searchParams.set('time', begin);

    const upstream = await fetch(upstreamUrl.toString(), {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'OpenSky track proxy error' });
  }
}
