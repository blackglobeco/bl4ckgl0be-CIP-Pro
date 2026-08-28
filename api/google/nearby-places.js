/**
 * /api/google/nearby-places — Google Places API nearby search proxy.
 * GET /api/google/nearby-places?lat=...&lon=...&radiusM=...
 * Requires GOOGLE_MAPS_API_KEY env var.
 */

function approxDistanceM(lat1, lon1, lat2, lon2) {
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return Infinity;
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed', places: [] });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not set', places: [] });

  const url = new URL(req.url || '', 'http://localhost');
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(url.searchParams.get('radiusM')) || 250));

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'Valid lat and lon required', places: [] });
  }

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.types',
      },
      body: JSON.stringify({
        maxResultCount: 20,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: { center: { latitude, longitude }, radius: radiusM },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json().catch(() => ({}));
    const seen = new Set();
    const places = Array.isArray(data.places) ? data.places
      .map(place => {
        const plat = place.location?.latitude ?? null;
        const plon = place.location?.longitude ?? null;
        const types = Array.isArray(place.types) ? place.types.slice(0, 8) : [];
        return {
          id: place.id || null,
          name: place.displayName?.text || null,
          address: place.shortFormattedAddress || place.formattedAddress || null,
          latitude: plat, longitude: plon,
          distanceM: approxDistanceM(latitude, longitude, plat, plon),
          primaryType: place.primaryTypeDisplayName?.text || place.primaryType || null,
          types,
        };
      })
      .filter(p => {
        const key = `${p.name}:${p.address || ''}`.toLowerCase();
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, 20) : [];

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(response.ok ? 200 : response.status).json({
      places,
      error: response.ok ? null : data.error?.message || 'Google Places request failed',
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Google Places proxy error', places: [] });
  }
}
