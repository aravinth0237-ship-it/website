const { BROWSER_HEADERS, extractTheaterNames } = require('./config');

const posterCache = new Map();
const MAX_CACHE_ENTRIES = 100;

const VISION_PROMPT =
  'Read this movie poster carefully. Extract the movie title and any Karur theater names visible ' +
  '(Ajantha, Ellora, Thinnappa, Amutha, PonAmutha, Kalaiarangam, Kavithalaya). ' +
  'Reply ONLY with strict JSON: {"title":"Movie Title","theaters":["Theater1"]}.';

function setCache(key, value) {
  if (posterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = posterCache.keys().next().value;
    posterCache.delete(oldestKey);
  }
  posterCache.set(key, value);
}

/**
 * Parses either structured JSON or free-form text returned by Gemini, Groq, or OCR.space.
 * @param {string} rawText
 * @returns {{ title: string, theaters: string[], rawText: string }}
 */
function parsePosterExtraction(rawText) {
  const text = String(rawText || '').trim();
  if (!text) return { title: '', theaters: [], rawText: '' };

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
      const rawTheaters = Array.isArray(parsed.theaters)
        ? parsed.theaters.join(', ')
        : String(parsed.theaters || '');
      const theaters = extractTheaterNames(`${rawTheaters} ${text}`);
      if (title || theaters.length > 0) {
        return { title, theaters, rawText: text };
      }
    } catch {
      // Fall through to plain-text heuristics below.
    }
  }

  const theaters = extractTheaterNames(text);
  const firstMeaningfulLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 2 && line.length <= 80 && !/^screen\s*:/i.test(line));

  return {
    title: firstMeaningfulLine || '',
    theaters,
    rawText: text,
  };
}

async function downloadPosterAsBase64(posterUrl, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetchImpl(posterUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Poster fetch HTTP ${res.status}`);
    }
    const contentType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');
    if (!base64) {
      throw new Error('Empty poster image payload');
    }
    return { base64, mimeType: contentType.startsWith('image/') ? contentType : 'image/jpeg' };
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeWithGemini(imageData, options = {}) {
  const apiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured');
  }
  const model = options.geminiModel || process.env.GEMINI_VISION_MODEL || 'gemini-2.5-flash';
  const fetchImpl = options.fetchImpl || fetch;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: imageData.mimeType, data: imageData.base64 } },
            { text: VISION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini Vision HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';
  const extracted = parsePosterExtraction(text);
  if (!extracted.title && extracted.theaters.length === 0) {
    throw new Error('Gemini returned no poster details');
  }
  return { engine: 'gemini', ...extracted };
}

async function analyzeWithGroqVision(imageData, options = {}) {
  const apiKey = options.groqApiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured');
  }
  const model =
    options.groqModel || process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  const fetchImpl = options.fetchImpl || fetch;

  const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            {
              type: 'image_url',
              image_url: { url: `data:${imageData.mimeType};base64,${imageData.base64}` },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Groq Vision HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const extracted = parsePosterExtraction(text);
  if (!extracted.title && extracted.theaters.length === 0) {
    throw new Error('Groq Vision returned no poster details');
  }
  return { engine: 'groq', ...extracted };
}

async function analyzeWithOcrSpace(imageData, options = {}) {
  const apiKey = options.ocrSpaceApiKey ?? process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    throw new Error('OCR_SPACE_API_KEY not configured');
  }
  const fetchImpl = options.fetchImpl || fetch;

  const form = new URLSearchParams();
  form.set('apikey', apiKey);
  form.set('base64Image', `data:${imageData.mimeType};base64,${imageData.base64}`);
  form.set('language', 'eng');
  form.set('OCREngine', '2');

  const res = await fetchImpl('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`OCR.space HTTP ${res.status}`);
  }
  const data = await res.json();
  const text = data?.ParsedResults?.map((r) => r.ParsedText || '').join('\n') || '';
  const extracted = parsePosterExtraction(text);
  if (!extracted.title && extracted.theaters.length === 0) {
    throw new Error('OCR.space returned no poster details');
  }
  return { engine: 'ocr.space', ...extracted };
}

/**
 * Runs Gemini + Groq Vision + OCR.space in parallel via Promise.any whenever a poster needs reading.
 * Gracefully resolves to null if no API keys are set or all engines fail.
 * @param {string} posterUrl
 * @param {object} [options]
 * @returns {Promise<{ engine: string, title: string, theaters: string[], rawText: string } | null>}
 */
async function readPosterWithAI(posterUrl, options = {}) {
  if (!posterUrl) return null;
  if (!options.bypassCache && posterCache.has(posterUrl)) {
    return posterCache.get(posterUrl);
  }

  const hasAnyKey = Boolean(
    (options.geminiApiKey ?? process.env.GEMINI_API_KEY) ||
      (options.groqApiKey ?? process.env.GROQ_API_KEY) ||
      (options.ocrSpaceApiKey ?? process.env.OCR_SPACE_API_KEY)
  );
  if (!hasAnyKey) {
    return null;
  }

  try {
    const fetchImpl = options.fetchImpl || fetch;
    const imageData = options.imageData || (await downloadPosterAsBase64(posterUrl, fetchImpl));

    const winner = await Promise.any([
      analyzeWithGemini(imageData, options),
      analyzeWithGroqVision(imageData, options),
      analyzeWithOcrSpace(imageData, options),
    ]);

    if (!options.bypassCache) {
      setCache(posterUrl, winner);
    }
    return winner;
  } catch {
    return null;
  }
}

module.exports = {
  parsePosterExtraction,
  downloadPosterAsBase64,
  analyzeWithGemini,
  analyzeWithGroqVision,
  analyzeWithOcrSpace,
  readPosterWithAI,
  posterCache,
};
