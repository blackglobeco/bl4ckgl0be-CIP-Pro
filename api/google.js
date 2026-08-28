/**
 * /api/google — Google Places proxies.
 *
 * Routes:
 *   GET /api/google/nearby-places  → Places API nearby search
 *   GET /api/google/text-search    → Places API text search
 */

function approxDistanceM(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function handleNearbyPlaces(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not set', places: [] });

  const url = new URL(req.url, 'http://localhost');
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(25, Math.min(5000, Number(url.searchParams.get('radiusM')) || 250));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'Valid lat and lon required', places: [] });

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.primaryType,places.primaryTypeDisplayName,places.types' },
      body: JSON.stringify({ maxResultCount: 20, rankPreference: 'DISTANCE', locationRestriction: { circle: { center: { latitude, longitude }, radius: radiusM } } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    const seen = new Set();
    const places = Array.isArray(data.places) ? data.places
      .map(p => ({ id: p.id || null, name: p.displayName?.text || null, address: p.shortFormattedAddress || p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, distanceM: approxDistanceM(latitude, longitude, p.location?.latitude, p.location?.longitude), primaryType: p.primaryTypeDisplayName?.text || p.primaryType || null, types: Array.isArray(p.types) ? p.types.slice(0, 8) : [] }))
      .filter(p => { const k = `${p.name}:${p.address || ''}`.toLowerCase(); if (!p.name || seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => a.distanceM - b.distanceM).slice(0, 20) : [];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(response.ok ? 200 : response.status).json({ places, error: response.ok ? null : data.error?.message || 'Google Places failed' });
  } catch (err) { return res.status(502).json({ error: err.message, places: [] }); }
}

async function handleTextSearch(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed', places: [] });
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'GOOGLE_MAPS_API_KEY not set', places: [] });

  const url = new URL(req.url, 'http://localhost');
  const textQuery = (url.searchParams.get('q') || '').trim();
  const latitude = Number(url.searchParams.get('lat'));
  const longitude = Number(url.searchParams.get('lon'));
  const radiusM = Math.max(50, Math.min(50000, Number(url.searchParams.get('radiusM')) || 4000));
  if (!textQuery || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'q, lat and lon required', places: [] });

  try {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.viewport,places.primaryType,places.types' },
      body: JSON.stringify({ textQuery, locationBias: { circle: { center: { latitude, longitude }, radius: radiusM } }, maxResultCount: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    const places = Array.isArray(data.places) ? data.places.map(p => {
      const vp = p.viewport;
      return { id: p.id || null, name: p.displayName?.text || null, address: p.formattedAddress || null, latitude: p.location?.latitude ?? null, longitude: p.location?.longitude ?? null, primaryType: p.primaryType || null, types: Array.isArray(p.types) ? p.types.slice(0, 8) : [], viewport: (Number.isFinite(vp?.low?.latitude) && Number.isFinite(vp?.high?.latitude)) ? { low: { latitude: vp.low.latitude, longitude: vp.low.longitude }, high: { latitude: vp.high.latitude, longitude: vp.high.longitude } } : null };
    }).filter(p => p.name) : [];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=300');
    return res.status(response.ok ? 200 : response.status).json({ places, error: response.ok ? null : data.error?.message || 'Google Places failed' });
  } catch (err) { return res.status(502).json({ error: err.message, places: [] }); }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  const path = (req.url || '').split('?')[0];
  if (path.endsWith('/nearby-places')) return handleNearbyPlaces(req, res);
  if (path.endsWith('/text-search')) return handleTextSearch(req, res);
  return res.status(404).json({ error: 'not found', places: [] });
}
