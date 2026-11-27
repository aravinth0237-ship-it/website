const cheerio = require('cheerio');
const {
  WEBSITE_URL,
  BROWSER_HEADERS,
  extractTheaterNames,
  inferTheaterFromPosterUrl,
  normalizeMovieKey,
} = require('./config');
const { readPosterWithAI } = require('./posterOcr');

const PLACEHOLDER_TITLES = new Set([
  'movie',
  'movies',
  'poster',
  'image',
  'untitled',
  'coming soon',
  'new release',
  'book a ticket',
  'now showing',
]);

function isPlaceholderTitle(title) {
  const clean = String(title || '').trim().toLowerCase();
  return !clean || PLACEHOLDER_TITLES.has(clean);
}

function resolveUrl(rawUrl, baseUrl = WEBSITE_URL) {
  if (!rawUrl) return '';
  try {
    return new URL(String(rawUrl).trim(), baseUrl).href;
  } catch {
    return String(rawUrl).trim();
  }
}

/**
 * Extracts raw movie card descriptors from outer Karur Cinemas landing page HTML.
 * Never crawls inner booking pages.
 * @param {string} html
 * @returns {Array<{ title: string, screenText: string, theaters: string[], poster: string }>}
 */
function parseOuterMoviesHtml(html) {
  const $ = cheerio.load(html);
  const cards = $('.movie-container');
  const rawItems = [];

  const elements = cards.length > 0 ? cards : $('.movie-preview, .film-card');
  elements.each((_, el) => {
    const node = $(el);
    const img = node.find('.film-img img, img').first();
    const rawPoster = img.attr('src') || img.attr('data-src') || '';
    const poster = resolveUrl(rawPoster, WEBSITE_URL);

    const h3Text = node.find('.film-info h3, h3, h2').first().text().trim();
    const imgAlt = (img.attr('alt') || '').trim();
    const title = !isPlaceholderTitle(h3Text) ? h3Text : imgAlt;

    const rawScreenNode = node.find('.film-info h5').first();
    const fallbackScreenNode = rawScreenNode.length ? rawScreenNode : node.find('h5, h4').first();
    const screenSource = fallbackScreenNode.length
      ? fallbackScreenNode.text()
      : node.find('.film-info').text();

    const screenText = screenSource
      .replace(/\s+/g, ' ')
      .replace(/^\[?\s*Screen\s*:\s*/i, '')
      .replace(/\]\s*$/i, '')
      .trim();

    const combinedText = `${screenText} ${node.find('.film-info').text()}`;
    const theaters = extractTheaterNames(combinedText);

    if (title || poster) {
      rawItems.push({
        title: title.trim(),
        screenText,
        theaters,
        poster,
      });
    }
  });

  return rawItems;
}

/**
 * Groups duplicate outer cards for the same movie across multiple screens/theaters.
 * @param {Array<{ title: string, screenText: string, theaters: string[], poster: string }>} items
 */
function mergeMovieEntries(items) {
  const map = new Map();

  for (const item of items) {
    const cleanTitle = String(item.title || '').trim();
    if (!cleanTitle) continue;
    const key = normalizeMovieKey(cleanTitle);
    if (!key) continue;

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        title: cleanTitle,
        theaters: [...item.theaters],
        screens: item.screenText ? [item.screenText] : [],
        poster: item.poster || '',
        link: WEBSITE_URL,
      });
      continue;
    }

    const existing = map.get(key);
    for (const theater of item.theaters) {
      if (!existing.theaters.includes(theater)) {
        existing.theaters.push(theater);
      }
    }
    if (item.screenText && !existing.screens.includes(item.screenText)) {
      existing.screens.push(item.screenText);
    }
    if (!existing.poster && item.poster) {
      existing.poster = item.poster;
    }
  }

  return Array.from(map.values());
}

/**
 * Fetches ONLY the outer landing page (https://karurcinemas.com) with browser User-Agent headers,
 * parses outer movie entries, and runs the 3 parallel AI/OCR engines via Promise.any whenever needed.
 * @param {object} [options]
 */
async function scanWebsite(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const ocrRunner = options.readPosterWithAI || readPosterWithAI;
  const fetchedAt = new Date().toISOString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const res = await fetchImpl(WEBSITE_URL, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, movies: [], fetchedAt };
    }

    const html = await res.text();
    if (!html || html.length < 200) {
      return { ok: false, error: 'Empty outer HTML response', movies: [], fetchedAt };
    }

    const parsed = parseOuterMoviesHtml(html);
    if (parsed.length === 0) {
      // Distinguish valid zero-movie layout vs broken shell HTML
      const looksLikeSite = /karur\s*cinemas/i.test(html);
      if (!looksLikeSite) {
        return { ok: false, error: 'Unexpected HTML shell from website', movies: [], fetchedAt };
      }
    }

    const enriched = await Promise.all(
      parsed.map(async (item) => {
        let title = item.title;
        let theaters = [...item.theaters];

        const needsPosterRead =
          Boolean(item.poster) && (isPlaceholderTitle(title) || theaters.length === 0);

        if (needsPosterRead) {
          const ocrResult = await ocrRunner(item.poster, options);
          if (ocrResult) {
            if (isPlaceholderTitle(title) && ocrResult.title) {
              title = ocrResult.title;
            }
            for (const theater of ocrResult.theaters || []) {
              if (!theaters.includes(theater)) {
                theaters.push(theater);
              }
            }
          }
        }

        if (theaters.length === 0 && item.poster) {
          theaters = inferTheaterFromPosterUrl(item.poster);
        }

        return {
          title: title || 'Karur Cinemas Release',
          screenText: item.screenText,
          theaters,
          poster: item.poster,
        };
      })
    );

    const movies = mergeMovieEntries(enriched);
    return { ok: true, movies, fetchedAt };
  } catch (err) {
    return { ok: false, error: err?.message || 'Scan failed', movies: [], fetchedAt };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  isPlaceholderTitle,
  resolveUrl,
  parseOuterMoviesHtml,
  mergeMovieEntries,
  scanWebsite,
};
