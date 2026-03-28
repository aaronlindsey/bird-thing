const REFRESH_INTERVAL = 5 * 60 * 1000;
const IMAGE_CACHE_KEY = 'bird_images';
const IMAGE_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CONCURRENT_FETCHES = 3;
const HISTORY_CACHE_KEY = 'bird_history';
const HISTORY_CACHE_MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours

const grid = document.getElementById('bird-grid');
const emptyState = document.getElementById('empty-state');
const lastUpdated = document.getElementById('last-updated');

const BIRD_SVG = `<svg viewBox="0 0 64 64" width="96" height="96">
  <path d="M55 22 L45 18 C42 11 35 9 32 13 C29 17 23 18 17 21 C11 23 7 19 5 15 C3 19 3 24 6 28 C9 33 16 38 26 41 C32 43 38 42 43 37 C48 32 50 26 48 24 Z"
    fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="42" cy="17" r="2.5" fill="currentColor"/>
  <path d="M20 31 Q28 26 39 29" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="25" y1="41" x2="23" y2="52" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="32" y1="42" x2="30" y2="52" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="8" y1="52" x2="52" y2="52" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// --- Image cache ---

function loadImageCache() {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (!raw) return {};
    const cache = JSON.parse(raw);
    const now = Date.now();
    // Prune expired entries
    for (const key of Object.keys(cache)) {
      if (now - cache[key].fetchedAt > IMAGE_CACHE_MAX_AGE) {
        delete cache[key];
      }
    }
    return cache;
  } catch {
    return {};
  }
}

function saveImageCache(cache) {
  try {
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — ignore
  }
}

const imageCache = loadImageCache();

// --- Species detail & history caches ---

function loadCache(key, maxAge) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const cache = JSON.parse(raw);
    const now = Date.now();
    for (const k of Object.keys(cache)) {
      if (now - cache[k].fetchedAt > maxAge) delete cache[k];
    }
    return cache;
  } catch {
    return {};
  }
}

function saveCache(key, cache) {
  try {
    localStorage.setItem(key, JSON.stringify(cache));
  } catch { /* ignore */ }
}

const historyCache = loadCache(HISTORY_CACHE_KEY, HISTORY_CACHE_MAX_AGE);

// --- Wikipedia image fetching with concurrency limit ---

async function fetchBirdImage(scientificName, commonName) {
  if (imageCache[scientificName]) {
    return imageCache[scientificName].url;
  }

  // Try scientific name first, then common name
  for (const name of [scientificName, commonName]) {
    const slug = name.replace(/ /g, '_');
    try {
      const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.thumbnail && data.thumbnail.source) {
        const url = data.thumbnail.source;
        imageCache[scientificName] = { url, extract: data.extract || null, fetchedAt: Date.now() };
        saveImageCache(imageCache);
        return url;
      }
    } catch {
      // Network error — try next
    }
  }

  // No image found — cache null to avoid retrying
  imageCache[scientificName] = { url: null, fetchedAt: Date.now() };
  saveImageCache(imageCache);
  return null;
}

async function fetchImagesWithLimit(detections) {
  const queue = [...detections];
  const results = new Map();
  let active = 0;

  return new Promise((resolve) => {
    function next() {
      if (queue.length === 0 && active === 0) {
        resolve(results);
        return;
      }
      while (active < MAX_CONCURRENT_FETCHES && queue.length > 0) {
        const det = queue.shift();
        active++;
        fetchBirdImage(det.scientific_name, det.common_name).then((url) => {
          results.set(det.scientific_name, url);
          active--;
          // Update the card image as soon as it's ready
          updateCardImage(det.scientific_name, url);
          next();
        });
      }
    }
    next();
  });
}

// --- Species detail fetching ---

async function getWikipediaExtract(scientificName, commonName) {
  if (imageCache[scientificName]?.extract) {
    return imageCache[scientificName].extract;
  }

  // Re-fetch from Wikipedia if extract is missing (old cache entry)
  for (const name of [scientificName, commonName]) {
    const slug = name.replace(/ /g, '_');
    try {
      const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      if (data.extract) {
        imageCache[scientificName] = { ...imageCache[scientificName], extract: data.extract, fetchedAt: Date.now() };
        saveImageCache(imageCache);
        return data.extract;
      }
    } catch { /* ignore */ }
  }
  return null;
}

async function fetchSpeciesHistory(scientificName) {
  const cached = historyCache[scientificName];
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_MAX_AGE) {
    return cached;
  }

  try {
    const resp = await fetch(`/api/species/${encodeURIComponent(scientificName)}`);
    if (!resp.ok) throw new Error();
    const data = await resp.json();
    historyCache[scientificName] = { ...data, fetchedAt: Date.now() };
    saveCache(HISTORY_CACHE_KEY, historyCache);
    return data;
  } catch {
    return null;
  }
}

// --- Relative time formatting ---

function formatRelativeTime(isoString) {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  return 'Over 24h ago';
}

// --- Color from species name ---

function nameToHue(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  // Map to greens, teals, blues, purples (120-280)
  return 120 + (Math.abs(hash) % 160);
}

// --- Card rendering ---

function createCardElement(detection) {
  const card = document.createElement('div');
  card.className = 'bird-card';
  card.dataset.species = detection.scientific_name;

  const cachedUrl = imageCache[detection.scientific_name]?.url;

  let imageHtml;
  if (cachedUrl) {
    imageHtml = `<img class="bird-card-image" src="${cachedUrl}" alt="${detection.common_name}" loading="lazy">`;
  } else if (cachedUrl === null) {
    const hue = nameToHue(detection.common_name);
    imageHtml = `<div class="bird-card-placeholder" style="background: hsl(${hue}, 35%, 45%)">${BIRD_SVG}</div>`;
  } else {
    // Not yet fetched — show placeholder, will be updated
    const hue = nameToHue(detection.common_name);
    imageHtml = `<div class="bird-card-placeholder" style="background: hsl(${hue}, 35%, 45%)">${BIRD_SVG}</div>`;
  }

  let badgesHtml = '';
  if (detection.is_new_species) {
    badgesHtml += '<span class="bird-badge bird-badge-new">NEW</span>';
  }
  if (detection.is_rare) {
    badgesHtml += '<span class="bird-badge bird-badge-rare">RARE</span>';
  }

  card.innerHTML = `
    <div class="bird-card-inner">
      <div class="bird-card-front">
        <div class="bird-card-image-wrap">
          ${imageHtml}
          ${badgesHtml ? `<div class="bird-card-badges">${badgesHtml}</div>` : ''}
        </div>
        <div class="bird-card-body">
          <div class="bird-card-name">${detection.common_name}</div>
          <div class="bird-card-scientific">${detection.scientific_name}</div>
          <div class="bird-card-meta">
            <span>${formatRelativeTime(detection.last_detected_at)}</span>
            <span class="bird-card-count">${detection.detection_count}x</span>
          </div>
        </div>
      </div>
      <div class="bird-card-back">
        <div class="bird-card-back-loading">Loading…</div>
      </div>
    </div>
  `;

  return card;
}

function updateCardImage(scientificName, url) {
  const card = grid.querySelector(`[data-species="${CSS.escape(scientificName)}"]`);
  if (!card) return;

  const existing = card.querySelector('.bird-card-image, .bird-card-placeholder');
  if (!existing) return;

  if (url) {
    const img = document.createElement('img');
    img.className = 'bird-card-image';
    img.src = url;
    img.alt = card.querySelector('.bird-card-name')?.textContent || '';
    img.loading = 'lazy';
    img.onerror = () => {
      // Image failed to load — revert to placeholder
      img.replaceWith(existing);
    };
    existing.replaceWith(img);
  }
}

// --- Card back rendering ---

function buildMonthlyChart(monthlyCounts) {
  if (!monthlyCounts || monthlyCounts.length === 0) return '';

  // Build a map of month → count
  const countMap = new Map(monthlyCounts.map(m => [m.month, m.count]));

  // Generate last 12 months
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleString('en', { month: 'short' });
    months.push({ key, label, count: countMap.get(key) || 0 });
  }

  const max = Math.max(...months.map(m => m.count), 1);

  const bars = months.map(m => {
    const pct = Math.round((m.count / max) * 100);
    return `<div class="bird-card-bar-wrap">
      <div class="bird-card-bar" style="height: ${Math.max(pct, 2)}%" title="${m.label}: ${m.count}"></div>
      <span class="bird-card-bar-label">${m.label[0]}</span>
    </div>`;
  }).join('');

  return `
    <div class="bird-card-back-section">
      <div class="bird-card-frequency-label">Monthly detections</div>
      <div class="bird-card-frequency-chart">${bars}</div>
    </div>`;
}

function renderCardBack({ commonName, scientificName, history, extract }) {
  const audio = history?.audio;
  let html = `
    <div class="bird-card-back-header">
      <div class="bird-card-name">${commonName}</div>
      <div class="bird-card-scientific">${scientificName}</div>
    </div>`;

  // First seen
  if (history?.first_detected) {
    const date = new Date(history.first_detected).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    html += `<div class="bird-card-first-seen">First seen: <strong>${date}</strong></div>`;
  }

  // Description
  if (extract) {
    html += `
      <div class="bird-card-back-section bird-card-description">
        <p>${extract}</p>
        <div class="bird-card-description-credit">Source: <a href="https://en.wikipedia.org/wiki/${encodeURIComponent(scientificName.replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipedia</a></div>
      </div>`;
  }

  // Monthly chart
  html += buildMonthlyChart(history?.monthly_counts);

  // Audio
  if (audio) {
    html += `
      <div class="bird-card-back-section bird-card-audio">
        <div class="bird-card-audio-label">Typical song</div>
        <audio controls preload="none" src="${audio.url}"></audio>
        <div class="bird-card-audio-credit">Sample by ${audio.recordist} · <a href="${audio.recording_url}" target="_blank" rel="noopener">Xeno-canto</a></div>
      </div>`;
  }

  // eBird link
  const ebirdUrl = history?.ebird_url || `https://ebird.org/species`;
  if (history?.ebird_url) {
    html += `
      <div class="bird-card-back-footer">
        <a class="bird-card-ebird-link" href="${ebirdUrl}" target="_blank" rel="noopener">View on eBird ↗</a>
      </div>`;
  }

  return html;
}

// --- Card click handler ---

grid.addEventListener('click', async (e) => {
  const card = e.target.closest('.bird-card');
  if (!card) return;

  // Don't flip when interacting with audio controls or links
  if (e.target.closest('audio, a')) return;

  card.classList.toggle('flipped');

  // Pause audio when flipping back to front
  if (!card.classList.contains('flipped')) {
    card.querySelector('audio')?.pause();
    return;
  }

  // Load back-side data on first flip
  if (!card.dataset.loaded) {
    card.dataset.loaded = '1';
    const scientificName = card.dataset.species;
    const commonName = card.querySelector('.bird-card-name')?.textContent || '';
    const backEl = card.querySelector('.bird-card-back');

    const [history, extract] = await Promise.all([
      fetchSpeciesHistory(scientificName),
      getWikipediaExtract(scientificName, commonName),
    ]);

    backEl.innerHTML = renderCardBack({ commonName, scientificName, history, extract });
  }
});

function showSkeletons(count = 6) {
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'skeleton-card';
    el.innerHTML = `
      <div class="skeleton-image"></div>
      <div class="skeleton-body">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
      </div>
    `;
    grid.appendChild(el);
  }
  emptyState.classList.add('hidden');
}

// --- Main fetch & render ---

async function fetchAndRender() {
  try {
    const resp = await fetch('/api/detections');
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    const data = await resp.json();

    const detections = data.detections || [];

    if (detections.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
    } else {
      emptyState.classList.add('hidden');
      grid.innerHTML = '';
      for (const det of detections) {
        grid.appendChild(createCardElement(det));
      }
      // Fetch images in background with rate limiting
      fetchImagesWithLimit(detections);
    }

    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error('Failed to fetch detections:', err);
    // Don't clear existing cards on error — keep showing stale data
    lastUpdated.textContent = `Update failed — retrying in 5 min`;
  }
}

// --- Init ---

showSkeletons();
fetchAndRender();
setInterval(fetchAndRender, REFRESH_INTERVAL);
