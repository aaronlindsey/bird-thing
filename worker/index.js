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

    if (url.pathname.startsWith('/api/species/') && request.method === 'GET') {
      return handleGetSpeciesDetail(url, env);
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
  const is_new_species = body.is_new_species ? 1 : 0;

  if (!common_name || !scientific_name || confidence == null || !detected_at) {
    return json({ error: 'Missing required fields' }, 400);
  }

  await env.DB.prepare(
    `INSERT INTO detections (common_name, scientific_name, confidence, detected_at, latitude, longitude, is_new_species)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    common_name,
    scientific_name,
    Number(confidence),
    detected_at,
    latitude,
    longitude,
    is_new_species,
  ).run();

  return json({ success: true }, 201);
}

const EBIRD_CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

async function getNotableSpecies(env) {
  const cacheUrl = 'https://bird-thing-cache/ebird-notable';
  const cache = caches.default;

  const cached = await cache.match(cacheUrl);
  if (cached) {
    return new Set(await cached.json());
  }

  if (!env.EBIRD_API_KEY || !env.EBIRD_REGION) return new Set();

  try {
    const resp = await fetch(
      `https://api.ebird.org/v2/data/obs/${env.EBIRD_REGION}/recent/notable?back=14`,
      { headers: { 'X-eBirdApiToken': env.EBIRD_API_KEY } },
    );
    if (!resp.ok) return new Set();

    const data = await resp.json();
    const names = [...new Set(data.map((obs) => obs.comName))];

    await cache.put(
      cacheUrl,
      new Response(JSON.stringify(names), {
        headers: { 'Cache-Control': `public, max-age=${EBIRD_CACHE_TTL}` },
      }),
    );

    return new Set(names);
  } catch {
    return new Set();
  }
}

const EBIRD_TAXONOMY_TTL = 7 * 24 * 60 * 60; // 7 days

async function getEbirdTaxonomyMap(env) {
  const cacheUrl = 'https://bird-thing-cache/ebird-taxonomy-map';
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheUrl);
    if (cached) return await cached.json();
  } catch { /* cache miss */ }

  try {
    const resp = await fetch(
      'https://api.ebird.org/v2/ref/taxonomy/ebird?fmt=csv&cat=species',
      { headers: { 'X-eBirdApiToken': env.EBIRD_API_KEY } },
    );
    if (!resp.ok) return {};

    const csv = await resp.text();
    const map = {};
    for (const line of csv.split('\n').slice(1)) {
      // CSV: SCIENTIFIC_NAME,COMMON_NAME,SPECIES_CODE,...
      const cols = line.split(',');
      if (cols.length >= 3) {
        map[cols[0]] = cols[2];
      }
    }

    try {
      await cache.put(
        cacheUrl,
        new Response(JSON.stringify(map), {
          headers: { 'Cache-Control': `public, max-age=${EBIRD_TAXONOMY_TTL}` },
        }),
      );
    } catch { /* cache write failed — fine, we'll refetch next time */ }

    return map;
  } catch {
    return {};
  }
}

async function getEbirdSpeciesCode(scientificName, env) {
  if (!env.EBIRD_API_KEY) return null;

  try {
    const map = await getEbirdTaxonomyMap(env);
    return map[scientificName] || null;
  } catch {
    return null;
  }
}

const XENOCANTO_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

async function getXenoCantoAudio(scientificName, env) {
  if (!env.XENOCANTO_API_KEY) return null;

  const cacheUrl = `https://bird-thing-cache/xenocanto/${encodeURIComponent(scientificName)}`;
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheUrl);
    if (cached) return await cached.json();
  } catch { /* cache miss */ }

  try {
    // v3 API requires gen: and sp: tags for scientific name lookup
    const [genus, species] = scientificName.split(' ');
    const query = `gen:${genus} sp:${species} type:song`;
    const resp = await fetch(
      `https://xeno-canto.org/api/3/recordings?query=${encodeURIComponent(query)}&key=${env.XENOCANTO_API_KEY}`,
    );
    if (!resp.ok) return null;

    const data = await resp.json();
    if (!data.recordings || data.recordings.length === 0) return null;

    // Sort by quality (A best, E worst) and pick the best
    const qOrder = { A: 0, B: 1, C: 2, D: 3, E: 4 };
    data.recordings.sort((a, b) => (qOrder[a.q] ?? 5) - (qOrder[b.q] ?? 5));
    const rec = data.recordings[0];

    const result = {
      url: rec.file,
      recordist: rec.rec,
      recording_url: rec.url.startsWith('//') ? `https:${rec.url}` : rec.url,
    };

    try {
      await cache.put(
        cacheUrl,
        new Response(JSON.stringify(result), {
          headers: { 'Cache-Control': `public, max-age=${XENOCANTO_CACHE_TTL}` },
        }),
      );
    } catch { /* ignore */ }

    return result;
  } catch {
    return null;
  }
}

async function handleGetSpeciesDetail(url, env) {
  const scientificName = decodeURIComponent(url.pathname.replace('/api/species/', ''));

  if (!scientificName) {
    return json({ error: 'Missing scientific name' }, 400);
  }

  const [firstDetected, monthlyCounts, speciesCode, audio] = await Promise.all([
    env.DB.prepare(
      `SELECT MIN(detected_at) as first_detected FROM detections WHERE scientific_name = ?`,
    ).bind(scientificName).first(),
    env.DB.prepare(
      `SELECT strftime('%Y-%m', detected_at) as month, COUNT(*) as count
       FROM detections
       WHERE scientific_name = ?
       GROUP BY month
       ORDER BY month`,
    ).bind(scientificName).all(),
    getEbirdSpeciesCode(scientificName, env),
    getXenoCantoAudio(scientificName, env),
  ]);

  return json({
    first_detected: firstDetected?.first_detected || null,
    monthly_counts: monthlyCounts?.results || [],
    ebird_url: speciesCode ? `https://ebird.org/species/${speciesCode}` : null,
    audio: audio || null,
  });
}

async function handleGetDetections(env) {
  const [{ results }, notableSpecies] = await Promise.all([
    env.DB.prepare(
      `SELECT
         common_name,
         scientific_name,
         MAX(detected_at) AS last_detected_at,
         COUNT(*) AS detection_count,
         MAX(confidence) AS max_confidence,
         MAX(is_new_species) AS is_new_species
       FROM detections
       WHERE detected_at > datetime('now', '-24 hours')
       GROUP BY common_name, scientific_name
       ORDER BY last_detected_at DESC`,
    ).all(),
    getNotableSpecies(env),
  ]);

  const detections = results.map((r) => ({
    ...r,
    is_rare: notableSpecies.has(r.common_name) ? 1 : 0,
  }));

  return json({
    detections,
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
