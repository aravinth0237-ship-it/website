const path = require('path');

const WEBSITE_URL = 'https://karurcinemas.com';

// Canonical list of Karur theaters; PonAmutha must always be checked before Amutha.
const THEATERS = [
  'Ajantha',
  'Ellora',
  'Thinnappa',
  'Amutha',
  'PonAmutha',
  'Kalaiarangam',
  'Kavithalaya',
];

const NORMAL_NEW_DURATION_MS = 48 * 60 * 60 * 1000; // 2 days (48 hours)
const DOOMSDAY_NEW_DURATION_MS = 96 * 60 * 60 * 1000; // 4 days (96 hours)
const RECENT_FLICKER_GRACE_MS = 12 * 60 * 60 * 1000; // 12 hours anti-flicker window

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SUBSCRIPTIONS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
};

/**
 * Checks whether a movie title corresponds to Avengers: Doomsday.
 * @param {string} title
 * @returns {boolean}
 */
function isAvengersDoomsday(title) {
  const value = String(title || '');
  return /\bavengers\b/i.test(value) && /\bdoomsday\b/i.test(value);
}

/**
 * Normalizes a movie title into a deterministic comparison key.
 * @param {string} title
 * @returns {string}
 */
function normalizeMovieKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extracts canonical Karur theater names from screen/poster text.
 * Checks PonAmutha before Amutha so PonAmutha never falsely matches Amutha.
 * @param {string} text
 * @returns {string[]}
 */
function extractTheaterNames(text) {
  if (!text) return [];
  const source = String(text);
  const found = [];

  if (/\bpon[\s_-]*amutha\b/i.test(source)) {
    found.push('PonAmutha');
  }
  const withoutPonAmutha = source.replace(/\bpon[\s_-]*amutha\b/gi, ' ');

  const patterns = [
    { name: 'Ajantha', regex: /\bajantha\b/i },
    { name: 'Ellora', regex: /\bellora\b/i },
    { name: 'Thinnappa', regex: /\bthinnappa\b/i },
    { name: 'Amutha', regex: /\bamutha\b/i },
    { name: 'Kalaiarangam', regex: /\bkalaiarangam\b/i },
    { name: 'Kavithalaya', regex: /\bkavithalaya\b/i },
  ];

  for (const { name, regex } of patterns) {
    if (regex.test(withoutPonAmutha) && !found.includes(name)) {
      found.push(name);
    }
  }

  return found;
}

/**
 * Fallback theater inference from poster CDN hostnames only when HTML and OCR yield none.
 * @param {string} posterUrl
 * @returns {string[]}
 */
function inferTheaterFromPosterUrl(posterUrl) {
  if (!posterUrl) return [];
  const lower = String(posterUrl).toLowerCase();
  if (lower.includes('ponamutha')) return ['PonAmutha'];
  if (lower.includes('amuthatheatres')) return ['Amutha'];
  if (lower.includes('ajanthacinema')) return ['Ajantha'];
  if (lower.includes('elloracinema')) return ['Ellora'];
  if (lower.includes('thinnappatheatre')) return ['Thinnappa'];
  if (lower.includes('kcineplex') || lower.includes('kalaiarangam')) return ['Kalaiarangam'];
  if (lower.includes('kavithalaya')) return ['Kavithalaya'];
  return [];
}

/**
 * Checks whether a URL points only to the generic karurcinemas.com homepage.
 * @param {string} url
 * @returns {boolean}
 */
function isGenericHomeUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed, WEBSITE_URL);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'karurcinemas.com' && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  } catch {
    return trimmed.replace(/\/+$/, '') === WEBSITE_URL;
  }
}

/**
 * Resolves a raw href/URL against WEBSITE_URL, rejecting placeholders/non-HTTP schemes.
 * Normalizes generic homepage URLs to WEBSITE_URL and returns '' when invalid.
 * @param {string} rawHref
 * @param {string} [baseUrl]
 * @returns {string}
 */
function normalizeBookingUrl(rawHref, baseUrl = WEBSITE_URL) {
  const trimmed = String(rawHref || '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return '';
  }
  if (/^(javascript|mailto|tel|data):/i.test(trimmed)) {
    return '';
  }
  try {
    const parsed = new URL(trimmed, baseUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return isGenericHomeUrl(parsed.href) ? WEBSITE_URL : parsed.href;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Picks the first specific HTTP(S) booking URL from candidates, falling back to WEBSITE_URL.
 * @param {...string} candidates
 * @returns {string}
 */
function resolvePreferredBookingUrl(...candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeBookingUrl(candidate, WEBSITE_URL);
    if (normalized && normalized !== WEBSITE_URL) {
      return normalized;
    }
  }
  return WEBSITE_URL;
}

module.exports = {
  WEBSITE_URL,
  THEATERS,
  NORMAL_NEW_DURATION_MS,
  DOOMSDAY_NEW_DURATION_MS,
  RECENT_FLICKER_GRACE_MS,
  ROOT_DIR,
  DATA_DIR,
  STATE_FILE,
  SUBSCRIPTIONS_FILE,
  VAPID_FILE,
  BROWSER_HEADERS,
  isAvengersDoomsday,
  normalizeMovieKey,
  extractTheaterNames,
  inferTheaterFromPosterUrl,
  isGenericHomeUrl,
  normalizeBookingUrl,
  resolvePreferredBookingUrl,
};
