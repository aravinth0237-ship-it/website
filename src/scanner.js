const cheerio = require('cheerio');
const {
  WEBSITE_URL,
  BROWSER_HEADERS,
  extractTheaterNames,
  inferTheaterFromPosterUrl,
  normalizeMovieKey,
  normalizeBookingUrl,
  resolvePreferredBookingUrl,
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

function extractCardBookingUrl($, node) {
  const anchors = node.find('a[href]').toArray();
  const scored = [];

  for (const anchor of anchors) {
    const $a = $(anchor);
    const resolved = normalizeBookingUrl($a.attr('href'), WEBSITE_URL);
    if (!resolved) continue;

    const text = $a.text().replace(/\s+/g, ' ').trim();
    const isBookText = /\bbook(\s+a)?\s+ticket\b|\bbook\s+now\b|\bbook\b/i.test(text);
    const isBookClassOrWrap =
      $a.is('.common-button, .pk-common-button, .book-link, .book-btn') ||
      $a.closest('.movie-footer, .film-button').length > 0;
    const specificBoost = resolved === WEBSITE_URL ? 0 : 10;

    let priority = 1;
    if (isBookText) priority = 3;
    else if (isBookClassOrWrap) priority = 2;

    scored.push({ url: resolved, score: specificBoost + priority });
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored[0].url;
  }

  const wrapperHref =
    (node.is('a[href]') && node.attr('href')) ||
    node.closest('a[href]').attr('href') ||
    node.attr('data-booking-url') ||
    node.attr('data-href') ||
    node.attr('data-url') ||
    node.find('[data-booking-url]').first().attr('data-booking-url') ||
    node.find('[data-href]').first().attr('data-href') ||
    node.find('[data-url]').first().attr('data-url');

  return normalizeBookingUrl(wrapperHref, WEBSITE_URL) || WEBSITE_URL;
}

/**
 * Extracts raw movie card descriptors from outer Karur Cinemas landing page HTML.
 * Never crawls inner booking pages.
 * @param {string} html
 * @returns {Array<{ title: string, screenText: string, theaters: string[], poster: string, bookingUrl: string }>}
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
    const bookingUrl = extractCardBookingUrl($, node);

    if (title || poster) {
      rawItems.push({
        title: title.trim(),
        screenText,
        theaters,
        poster,
        bookingUrl,
      });
    }
  });

  return rawItems;
}

/**
 * Groups duplicate outer cards for the same movie across multiple screens/theaters.
 * @param {Array<{ title: string, screenText: string, theaters: string[], poster: string, bookingUrl?: string, link?: string }>} items
 */
function mergeMovieEntries(items) {
  const map = new Map();

  for (const item of items) {
    const cleanTitle = String(item.title || '').trim();
    if (!cleanTitle) continue;
    const key = normalizeMovieKey(cleanTitle);
    if (!key) continue;

    const itemBookingUrl = resolvePreferredBookingUrl(item.bookingUrl, item.link);

    if (!map.has(key)) {
      map.set(key, {
        id: key,
        title: cleanTitle,
        theaters: [...item.theaters],
        screens: item.screenText ? [item.screenText] : [],
        poster: item.poster || '',
        bookingUrl: itemBookingUrl,
        link: itemBookingUrl,
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
    if (
      (!existing.bookingUrl || existing.bookingUrl === WEBSITE_URL) &&
      itemBookingUrl !== WEBSITE_URL
    ) {
      existing.bookingUrl = itemBookingUrl;
      existing.link = itemBookingUrl;
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

  console.log('[SCANNER]', fetchedAt, 'Fetching outer page:', WEBSITE_URL);

  try {
    const res = await fetchImpl(WEBSITE_URL, {
      method: 'GET',
      headers: BROWSER_HEADERS,
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn('[SCANNER ERROR]', new Date().toISOString(), `HTTP ${res.status} from ${WEBSITE_URL}`);
      return { ok: false, error: `HTTP ${res.status}`, movies: [], fetchedAt };
    }

    const html = await res.text();
    if (!html || html.length < 200) {
      console.warn('[SCANNER ERROR]', new Date().toISOString(), 'Empty outer HTML response');
      return { ok: false, error: 'Empty outer HTML response', movies: [], fetchedAt };
    }

    const parsed = parseOuterMoviesHtml(html);
    if (parsed.length === 0) {
      // Distinguish valid zero-movie layout vs broken shell HTML
      const looksLikeSite = /karur\s*cinemas/i.test(html);
      if (!looksLikeSite) {
        console.warn('[SCANNER ERROR]', new Date().toISOString(), 'Unexpected HTML shell from website');
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
          console.log('[SCANNER OCR]', new Date().toISOString(), 'Running parallel Gemini/Groq/OCR.space on poster:', item.poster);
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
          bookingUrl: item.bookingUrl || WEBSITE_URL,
        };
      })
    );

    const movies = mergeMovieEntries(enriched);
    console.log('[SCANNER RESULT]', new Date().toISOString(), movies.length, 'movies found on', WEBSITE_URL);
    return { ok: true, movies, fetchedAt };
  } catch (err) {
    console.warn('[SCANNER ERROR]', new Date().toISOString(), err?.message || 'Scan failed');
    return { ok: false, error: err?.message || 'Scan failed', movies: [], fetchedAt };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  isPlaceholderTitle,
  resolveUrl,
  extractCardBookingUrl,
  parseOuterMoviesHtml,
  mergeMovieEntries,
  scanWebsite,
};
