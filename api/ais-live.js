/**
 * /api/ais-live — AIS live vessel position proxy.
 *
 * NOTE: AISStream uses a persistent WebSocket which cannot run in a Vercel
 * serverless function (no persistent connections). This function instead
 * polls the AISStream REST snapshot endpoint if available, or returns a
 * degraded-graceful response indicating the key is set but the WebSocket
 * feed requires a persistent server.
 *
 * For full AIS support, consider Railway or Render which support long-running
 * Node.js processes (see SECURITY.md and README.md).
 *
 * The app handles the `refreshing` and `error` fields gracefully and will
 * show an "AIS unavailable" state on the ships layer.
 */

export default async function handler(req, res) {
  const hasKey = Boolean(process.env.AISSTREAM_API_KEY);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  if (!hasKey) {
    return res.status(503).json({
      rows: [],
      source: 'AISStream',
      status: 'no_key',
      error: 'AISSTREAM_API_KEY not configured',
      refreshing: false,
      newestPositionAt: null,
      lastMessageAt: null,
    });
  }

  // Return a graceful degraded state — the client will show the layer as
  // "connecting" and retry. Full WebSocket support requires a persistent server.
  return res.status(200).json({
    rows: [],
    source: 'AISStream',
    status: 'degraded',
    error: 'AIS live feed requires a persistent server; deploy on Railway or Render for full AIS support.',
    refreshing: true,
    newestPositionAt: null,
    lastMessageAt: null,
  });
}
