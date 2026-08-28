/**
 * /api/realtime/debug-log — Realtime session debug log collector.
 * In serverless, logs to console instead of disk.
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  try {
    const record = JSON.parse(body || '{}');
    console.log('[realtime-debug]', JSON.stringify({ loggedAt: new Date().toISOString(), ...record }));
    return res.status(204).end();
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }
}
