/**
 * /api/google/text-search — Google Places text search proxy.
 * GET /api/google/text-search?q=...&lat=...&lon=...&radiusM=...
 * Requires GOOGLE_MAPS_API_KEY env var.
 */

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', places: [] });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not set', places: [] });

  const url = new URL(req.url || '', 'http://localhost');
  const textQuery = (url.searchParams.get('q') || '').trim();
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(url.searchParams.get('radiusM')) || 4000));

  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'q, lat and lon are required', places: [] });
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.primaryType,places.types',
      },
      body: JSON.stringify({
        textQuery,
        locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } },
        maxResultCount: 5,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json().catch(() => ({}));
    const places = Array.isArray(data.places) ? data.places
      .map(place => {
        const plat = place.location?.latitude ?? null;
        const plon = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        const vp = place.viewport;
        const viewport = (
          Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.low?.longitude) &&
          Number.isFinite(vp?.high?.latitude) && Number.isFinite(vp?.high?.longitude)
        ) ? { low: { latitude: vp.low.latitude, longitude: vp.low.longitude }, high: { latitude: vp.high.latitude, longitude: vp.high.longitude } } : null;
        return { id: place.id || null, name: place.displayName?.text || null, address: place.formattedAddress || null, latitude: plat, longitude: plon, primaryType: place.primaryType || null, types, viewport };
      })
      .filter(p => p.name) : [];

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(response.ok ? 200 : response.status).json({
      places,
      error: response.ok ? null : data.error?.message || 'Google Places request failed',
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Google text-search proxy error', places: [] });
  }
}
