const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  WEBSITE_URL,
  THEATERS,
  NORMAL_NEW_DURATION_MS,
  DOOMSDAY_NEW_DURATION_MS,
  extractTheaterNames,
  isAvengersDoomsday,
} = require('../src/config');
const { loadStateSync } = require('../src/stateStore');
const { parseOuterMoviesHtml, mergeMovieEntries, scanWebsite } = require('../src/scanner');
const { readPosterWithAI, posterCache } = require('../src/posterOcr');
const { applyScanResults } = require('../src/tracker');
const { notifyNewOpening } = require('../src/pushService');
const { createApp } = require('../server');

const SAMPLE_KARUR_HTML = `
<!doctype html>
<html>
<body>
  <section class="container">
    <div class="movie-container">
      <div class="film-img"><div class="img-container">
        <img src="https://www.elloracinema.com/uploads/movie/1.jpg" alt="Delivery Boy" />
      </div></div>
      <div class="film-details"><div class="film-info">
        <h3>Delivery Boy</h3>
        <h5>[Screen : Ellora 4K Dolby Atmos]</h5>
        <a href="https://www.karurcinemas.com/movies/abc">Book a ticket</a>
      </div></div>
    </div>
    <div class="movie-container">
      <div class="film-img"><div class="img-container">
        <img src="https://www.amuthatheatres.com/uploads/movie/2.jpg" alt="Niram" />
      </div></div>
      <div class="film-details"><div class="film-info">
        <h3>Niram</h3>
        <h5>[Screen : PonAmutha Dolby Atmos]</h5>
      </div></div>
    </div>
    <div class="movie-container">
      <div class="film-img"><div class="img-container">
        <img src="https://www.ajanthacinema.com/uploads/movie/3.jpg" alt="O.M" />
      </div></div>
      <div class="film-details"><div class="film-info">
        <h3>O.M</h3>
        <h5>[Screen : Ajantha 4K Dolby Atmos]</h5>
      </div></div>
    </div>
    <div class="movie-container">
      <div class="film-img"><div class="img-container">
        <img src="https://www.thinnappatheatre.com/uploads/movie/4.jpg" alt="O.M" />
      </div></div>
      <div class="film-details"><div class="film-info">
        <h3>O.M</h3>
        <h5>[Screen : Thinnappa Screen-1 4K Dolby Atmos]</h5>
      </div></div>
    </div>
    <div class="movie-container">
      <div class="film-img"><div class="img-container">
        <img src="https://s2.thinnappatheatre.com/uploads/movie/5.jpg" alt="Ramayana" />
      </div></div>
      <div class="film-details"><div class="film-info">
        <h3>Ramayana</h3>
        <h5>[Screen : Amutha 4K Dolby Atmos, Thinnappa Screen-2 RGB Laser Atmos]</h5>
      </div></div>
    </div>
  </section>
</body>
</html>`;

test('Theater extraction distinguishes PonAmutha from Amutha and detects all 7 theaters', () => {
  assert.deepEqual(extractTheaterNames('[Screen : PonAmutha Dolby Atmos]'), ['PonAmutha']);
  assert.deepEqual(extractTheaterNames('[Screen : Amutha 4K Dolby Atmos, Thinnappa Screen-2]'), [
    'Thinnappa',
    'Amutha',
  ]);
  assert.deepEqual(
    extractTheaterNames('Ajantha, Ellora, Thinnappa, Amutha, PonAmutha, Kalaiarangam, Kavithalaya'),
    ['PonAmutha', 'Ajantha', 'Ellora', 'Thinnappa', 'Amutha', 'Kalaiarangam', 'Kavithalaya']
  );
  assert.equal(THEATERS.length, 7);
});

test('Outer scanner fetches ONLY WEBSITE_URL with browser User-Agent and merges duplicate movie cards', async () => {
  const requestedUrls = [];
  let seenUserAgent = '';

  const mockFetch = async (url, init) => {
    requestedUrls.push(url);
    seenUserAgent = init?.headers?.['User-Agent'] || '';
    return {
      ok: true,
      status: 200,
      text: async () => SAMPLE_KARUR_HTML,
    };
  };

  const result = await scanWebsite({ fetchImpl: mockFetch });
  assert.equal(result.ok, true);
  assert.deepEqual(requestedUrls, [WEBSITE_URL]); // Never crawls inner booking pages!
  assert.match(seenUserAgent, /Mozilla\/5\.0/);

  assert.equal(result.movies.length, 4);
  const deliveryBoy = result.movies.find((m) => m.title === 'Delivery Boy');
  assert.deepEqual(deliveryBoy.screens, ['Ellora 4K Dolby Atmos']);
  const om = result.movies.find((m) => m.title === 'O.M');
  assert.deepEqual(om.theaters, ['Ajantha', 'Thinnappa']);
  const niram = result.movies.find((m) => m.title === 'Niram');
  assert.deepEqual(niram.theaters, ['PonAmutha']);
  assert.equal(niram.link, WEBSITE_URL);
});

test('Parallel 3-engine AI/OCR (Promise.any) calls Gemini, Groq Vision, and OCR.space concurrently', async () => {
  posterCache.clear();
  const calledEndpoints = [];

  const mockFetch = async (url) => {
    calledEndpoints.push(url);
    if (url.includes('generativelanguage.googleapis.com')) {
      return { ok: false, status: 500 }; // Simulate Gemini transient failure
    }
    if (url.includes('api.groq.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"title":"Avengers: Doomsday","theaters":["Ajantha","Ellora"]}' } }],
        }),
      };
    }
    if (url.includes('api.ocr.space')) {
      return { ok: false, status: 429 }; // Simulate OCR.space rate limit
    }
    // Poster image download
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => Buffer.from('fake-jpeg-bytes'),
    };
  };

  const extracted = await readPosterWithAI('https://karurcinemas.com/uploads/poster.jpg', {
    fetchImpl: mockFetch,
    geminiApiKey: 'test-gem',
    groqApiKey: 'test-groq',
    ocrSpaceApiKey: 'test-ocr',
    bypassCache: true,
  });

  assert.ok(extracted);
  assert.equal(extracted.engine, 'groq');
  assert.equal(extracted.title, 'Avengers: Doomsday');
  assert.deepEqual(extracted.theaters, ['Ajantha', 'Ellora']);
  assert.ok(calledEndpoints.some((u) => u.includes('generativelanguage.googleapis.com')));
  assert.ok(calledEndpoints.some((u) => u.includes('api.groq.com')));
  assert.ok(calledEndpoints.some((u) => u.includes('api.ocr.space')));
});

test('48-hour & 4-day New Updates rule with zero-spam baseline and theater additions', () => {
  const t0 = Date.parse('2026-11-27T06:00:00.000Z');
  const parsed = mergeMovieEntries(parseOuterMoviesHtml(SAMPLE_KARUR_HTML));

  // 1. Initial baseline scan: ZERO New Updates, ZERO notifications
  const initial = { lastChecked: null, openings: [], lastWebsiteMovies: [] };
  const afterBaseline = applyScanResults(initial, { ok: true, movies: parsed }, t0);
  assert.equal(afterBaseline.isBaseline, true);
  assert.equal(afterBaseline.newNotifications.length, 0);
  assert.equal(afterBaseline.state.openings.filter((o) => o.isNew).length, 0);

  // 2. Repeat scan with identical movies: ZERO spam
  const t1 = t0 + 5 * 60 * 1000;
  const repeat = applyScanResults(afterBaseline.state, { ok: true, movies: parsed }, t1);
  assert.equal(repeat.newNotifications.length, 0);

  // 3. Add a normal new movie AND a brand-new theater for Delivery Boy
  const t2 = t0 + 10 * 60 * 1000;
  const updatedMovies = [
    ...parsed.map((m) =>
      m.title === 'Delivery Boy' ? { ...m, theaters: ['Ellora', 'Kavithalaya'] } : m
    ),
    {
      id: 'coolie',
      title: 'Coolie',
      theaters: ['Kalaiarangam'],
      screens: ['Kalaiarangam 4K Dolby Atmos'],
      poster: 'https://www.kcineplex.in/coolie.jpg',
      link: WEBSITE_URL,
    },
  ];
  const afterNormal = applyScanResults(repeat.state, { ok: true, movies: updatedMovies }, t2);
  assert.equal(afterNormal.newNotifications.length, 2);
  const coolie = afterNormal.state.openings.find((o) => o.title === 'Coolie');
  assert.equal(coolie.isNew, true);
  assert.equal(Date.parse(coolie.newUntil) - t2, NORMAL_NEW_DURATION_MS);

  // 4. Add Avengers: Doomsday at Thinnappa -> 96h (4 days)
  const t3 = t2 + 1000;
  const withDoomsday = [
    ...updatedMovies,
    {
      id: 'avengers-doomsday',
      title: 'Avengers: Doomsday',
      theaters: ['Thinnappa'],
      screens: ['Thinnappa Screen-1 4K Dolby Atmos'],
      poster: 'https://www.thinnappatheatre.com/doomsday.jpg',
      link: WEBSITE_URL,
    },
  ];
  const afterDoomsday = applyScanResults(afterNormal.state, { ok: true, movies: withDoomsday }, t3);
  const doomsday = afterDoomsday.state.openings.find((o) => isAvengersDoomsday(o.title));
  assert.equal(doomsday.isNew, true);
  assert.equal(doomsday.isDoomsday, true);
  assert.equal(Date.parse(doomsday.newUntil) - t3, DOOMSDAY_NEW_DURATION_MS);

  // 5. After 49 hours: Coolie expires from New Updates, Avengers: Doomsday remains active!
  const t49h = t3 + 49 * 60 * 60 * 1000;
  const at49h = applyScanResults(afterDoomsday.state, { ok: true, movies: withDoomsday }, t49h);
  assert.equal(at49h.state.openings.find((o) => o.title === 'Coolie').isNew, false);
  assert.equal(at49h.state.openings.find((o) => o.title === 'Avengers: Doomsday').isNew, true);
  assert.equal(at49h.newNotifications.length, 0);

  // 6. After 97 hours: Avengers: Doomsday expires from New Updates too
  const t97h = t3 + 97 * 60 * 60 * 1000;
  const at97h = applyScanResults(at49h.state, { ok: true, movies: withDoomsday }, t97h);
  assert.equal(at97h.state.openings.find((o) => o.title === 'Avengers: Doomsday').isNew, false);
});

test('Push notifications send 5x (2s interval option) for Avengers: Doomsday and 1x for normal movies', async () => {
  const sentPayloads = [];
  const fakeSender = async (sub, bodyStr) => {
    sentPayloads.push({ endpoint: sub.endpoint, payload: JSON.parse(bodyStr), at: Date.now() });
  };
  const subs = [{ endpoint: 'https://push.example/sub1', keys: { p256dh: 'a', auth: 'b' } }];

  const doomsdayRes = await notifyNewOpening(
    {
      movie: { id: 'avengers-doomsday', title: 'Avengers: Doomsday', theaters: ['Ajantha'] },
      addedTheaters: ['Ajantha'],
      isDoomsday: true,
    },
    { subscriptions: subs, sendNotification: fakeSender, doomsdayDelayMs: 10 }
  );
  assert.equal(doomsdayRes.count, 5);
  assert.equal(sentPayloads.length, 5);
  const uniqueTags = new Set(sentPayloads.map((s) => s.payload.tag));
  assert.equal(uniqueTags.size, 5);
  assert.match(sentPayloads[0].payload.body, /Ajantha/);
  assert.match(sentPayloads[0].payload.title, /Avengers: Doomsday/);

  sentPayloads.length = 0;
  const normalRes = await notifyNewOpening(
    {
      movie: { id: 'coolie', title: 'Coolie', theaters: ['Ellora'] },
      addedTheaters: ['Ellora'],
      isDoomsday: false,
    },
    { subscriptions: subs, sendNotification: fakeSender }
  );
  assert.equal(normalRes.count, 1);
  assert.equal(sentPayloads.length, 1);
  assert.match(sentPayloads[0].payload.body, /Ellora/);
});

test('Express API persists exact state.json shape, /api/status returns 200 no-store, and /api/check-now supports GET & POST', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-tracker-'));
  const stateFile = path.join(tmpDir, 'state.json');

  const { app } = createApp({
    stateFile,
    scanWebsite: async () => ({
      ok: true,
      movies: mergeMovieEntries(parseOuterMoviesHtml(SAMPLE_KARUR_HTML)),
    }),
    notifyNewOpening: async () => ({ count: 0 }),
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/status always returns 200 with { ok: true, lastChecked, openings } and no-store
    const statusRes1 = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes1.status, 200);
    assert.match(statusRes1.headers.get('cache-control') || '', /no-store/i);
    const statusJson1 = await statusRes1.json();
    assert.equal(statusJson1.ok, true);
    assert.ok(Array.isArray(statusJson1.openings));

    // 2. GET /api/check-now
    const checkGetRes = await fetch(`${baseUrl}/api/check-now`, { method: 'GET' });
    assert.equal(checkGetRes.status, 200);
    const checkGetJson = await checkGetRes.json();
    assert.equal(checkGetJson.ok, true);
    assert.ok(checkGetJson.lastChecked);

    // 3. POST /api/check-now
    const checkPostRes = await fetch(`${baseUrl}/api/check-now`, { method: 'POST' });
    assert.equal(checkPostRes.status, 200);
    const checkPostJson = await checkPostRes.json();
    assert.equal(checkPostJson.ok, true);
    assert.ok(checkPostJson.lastChecked);

    // 4. Verify state.json on disk contains ONLY { lastChecked, openings, lastWebsiteMovies }
    const diskState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(Object.keys(diskState).sort(), [
      'lastChecked',
      'lastWebsiteMovies',
      'openings',
    ]);
    assert.equal(diskState.openings.length, 4);

    // 5. GET /api/status reflects updated openings
    const statusRes2 = await fetch(`${baseUrl}/api/status`);
    const statusJson2 = await statusRes2.json();
    assert.equal(statusJson2.ok, true);
    assert.equal(statusJson2.openings.length, 4);
    assert.ok(loadStateSync(stateFile).lastChecked);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Frontend UI & PWA files enforce 3-tab UI, zero Instagram/RSS, no Loading.../Connection error, and Doomsday theme', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.json'), 'utf8'));

  // Exactly 3 tabs
  const tabMatches = html.match(/role="tab"/g) || [];
  assert.equal(tabMatches.length, 3);
  assert.match(html, /All Updates/);
  assert.match(html, /New Updates/);
  assert.match(html, /Website Live/);

  // Required push buttons & banner
  assert.match(html, /Enable Notifications/);
  assert.match(html, /Test Alert/);
  assert.match(html, /🚨 AVENGERS: DOOMSDAY BOOKINGS LIVE IN KARUR! 🚨/);
  assert.match(css, /\.theme-doomsday/);

  // Never stuck on Loading... or Connection error
  assert.doesNotMatch(html + js, /Loading\.\.\./);
  assert.doesNotMatch(html + js, /Connection error/);

  // Zero Instagram or RSS references across all source & public files
  const filesToCheck = [
    path.join(__dirname, '..', 'server.js'),
    path.join(__dirname, '..', 'src', 'config.js'),
    path.join(__dirname, '..', 'src', 'scanner.js'),
    path.join(__dirname, '..', 'src', 'tracker.js'),
    path.join(__dirname, '..', 'src', 'posterOcr.js'),
    path.join(__dirname, '..', 'src', 'pushService.js'),
    path.join(__dirname, '..', 'src', 'stateStore.js'),
    path.join(publicDir, 'index.html'),
    path.join(publicDir, 'app.js'),
    path.join(publicDir, 'sw.js'),
    path.join(publicDir, 'styles.css'),
  ];
  for (const file of filesToCheck) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /instagram|\brss\b/i, `Forbidden reference found in ${file}`);
  }

  assert.equal(manifest.name, 'Karur Cinemas Ticket Tracker');
  assert.ok(fs.existsSync(path.join(publicDir, 'sw.js')));
});
