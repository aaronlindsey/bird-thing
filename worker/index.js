export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/api/detections') {
      if (request.method === 'POST') return handleWebhook(request, env);
      if (request.method === 'GET') return handleGetDetections(env);
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function handleWebhook(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.WEBHOOK_TOKEN}`) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  console.log('Webhook payload:', JSON.stringify(body));

  const common_name = body.metadata?.species ?? body.common_name;
  const scientific_name = body.metadata?.scientific_name ?? body.scientific_name;
  const confidence = body.metadata?.confidence ?? body.confidence;
  const detected_at = body.timestamp ?? body.detected_at;
  const latitude = body.metadata?.bg_latitude ?? body.latitude ?? null;
  const longitude = body.metadata?.bg_longitude ?? body.longitude ?? null;

  if (!common_name || !scientific_name || confidence == null || !detected_at) {
    return json({ error: 'Missing required fields' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO detections (common_name, scientific_name, confidence, detected_at, latitude, longitude)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    common_name,
    scientific_name,
    Number(confidence),
    detected_at,
    latitude,
    longitude,
  ).run();

  return json({ success: true }, 201);
}

async function handleGetDetections(env) {
  const { results } = await env.DB.prepare(
    `SELECT
       common_name,
       scientific_name,
       MAX(detected_at) AS last_detected_at,
       COUNT(*) AS detection_count,
       MAX(confidence) AS max_confidence
     FROM detections
     WHERE detected_at > datetime('now', '-24 hours')
     GROUP BY common_name, scientific_name
     ORDER BY last_detected_at DESC`
  ).all();

  return json({
    detections: results,
    generated_at: new Date().toISOString(),
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
      ...corsHeaders(),
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
