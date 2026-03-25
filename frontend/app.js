const REFRESH_INTERVAL = 5 * 60 * 1000;
const IMAGE_CACHE_KEY = 'bird_images';
const IMAGE_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_CONCURRENT_FETCHES = 3;

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
        imageCache[scientificName] = { url, fetchedAt: Date.now() };
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

  card.innerHTML = `
    ${imageHtml}
    <div class="bird-card-body">
      <div class="bird-card-name">${detection.common_name}</div>
      <div class="bird-card-scientific">${detection.scientific_name}</div>
      <div class="bird-card-meta">
        <span>${formatRelativeTime(detection.last_detected_at)}</span>
        <span class="bird-card-count">${detection.detection_count}x</span>
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
