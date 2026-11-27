require('dotenv').config();
const path = require('path');
const express = require('express');
const { STATE_FILE, WEBSITE_URL } = require('./src/config');
const { loadStateSync, saveState, loadSubscriptionsSync } = require('./src/stateStore');
const { scanWebsite } = require('./src/scanner');
const {
  applyScanResults,
  refreshOpeningFlags,
  isOpeningExpired,
  pruneExpiredOpenings,
  sortOpenings,
} = require('./src/tracker');
const {
  initPushService,
  getPublicKey,
  addSubscription,
  removeSubscription,
  notifyNewOpening,
  sendTestAlert,
} = require('./src/pushService');

const DOOMSDAY_TEST_DURATION_MS = 60000;
const DOOMSDAY_TEST_POSTER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
      <defs>
        <linearGradient id="doomBg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#022c22"/>
          <stop offset="55%" stop-color="#065f46"/>
          <stop offset="100%" stop-color="#03120a"/>
        </linearGradient>
      </defs>
      <rect width="300" height="400" fill="url(#doomBg)"/>
      <rect x="16" y="16" width="268" height="368" rx="16" fill="none" stroke="#eab308" stroke-width="3"/>
      <text x="150" y="95" text-anchor="middle" fill="#facc15" font-family="sans-serif" font-size="14" font-weight="800" letter-spacing="2">VIP SIMULATION</text>
      <text x="150" y="175" text-anchor="middle" fill="#ecfdf5" font-family="sans-serif" font-size="26" font-weight="900">AVENGERS:</text>
      <text x="150" y="212" text-anchor="middle" fill="#fde047" font-family="sans-serif" font-size="28" font-weight="900">DOOMSDAY</text>
      <text x="150" y="268" text-anchor="middle" fill="#a7f3d0" font-family="sans-serif" font-size="14" font-weight="700">Ajantha 4K Dolby Atmos</text>
      <text x="150" y="318" text-anchor="middle" fill="#fef08a" font-family="sans-serif" font-size="12" font-weight="700">AUTO-CLEANUP IN 60s</text>
    </svg>`
  );

function createApp(options = {}) {
  const stateFile = options.stateFile || STATE_FILE;
  const runWebsiteScan = options.scanWebsite || scanWebsite;
  const nowFn = options.nowFn || (() => Date.now());
  const pushNotifier = options.notifyNewOpening || notifyNewOpening;

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  let state = loadStateSync(stateFile);
  const startupCleanOpenings = pruneExpiredOpenings(state.openings, nowFn());
  if (startupCleanOpenings.length !== (state.openings || []).length) {
    state = { ...state, openings: startupCleanOpenings };
    saveState(state, stateFile).catch(() => {});
  }
  let activeScanPromise = null;
  let testDoomsdayTimer = null;
  let activeTestPushPromise = null;

  initPushService();

  function clearTestDoomsdayEntries(nowMs = nowFn()) {
    const prevOpenings = state.openings || [];
    const remaining = prevOpenings.filter(
      (item) => Boolean(item) && !item.isTest && !isOpeningExpired(item, nowMs)
    );
    if (remaining.length !== prevOpenings.length) {
      state = { ...state, openings: remaining };
      return saveState(state, stateFile).catch((err) => {
        console.error('[TEST-DOOMSDAY CLEANUP ERROR]', err?.message || err);
      });
    }
    return Promise.resolve();
  }

  async function performScan(trigger = 'background') {
    if (activeScanPromise) {
      console.log('[SCAN]', new Date().toISOString(), 'Scan already in progress, reusing active run', { trigger });
      return activeScanPromise;
    }

    activeScanPromise = (async () => {
      console.log('[SCAN]', new Date().toISOString(), 'Checking Karur Cinemas website...', { trigger });
      const scanResult = await runWebsiteScan(options.scannerOptions);
      if (!scanResult?.ok) {
        console.warn('[SCAN WARN]', new Date().toISOString(), scanResult?.error || 'Website scan returned non-ok status');
      }

      const { state: nextState, newNotifications, isBaseline } = applyScanResults(
        state,
        scanResult,
        nowFn()
      );
      state = nextState;
      await saveState(state, stateFile);

      console.log(
        '[SCAN RESULT]',
        new Date().toISOString(),
        state.openings.length,
        'movies found',
        {
          liveMovies: Array.isArray(scanResult?.movies) ? scanResult.movies.length : 0,
          newAdded: newNotifications.length,
          isBaseline,
          lastChecked: state.lastChecked,
        }
      );

      if (newNotifications.length > 0) {
        console.log(
          '[PUSH TRIGGER]',
          new Date().toISOString(),
          'Sending push notifications for:',
          newNotifications.map((n) => `${n.movie.title} (${(n.addedTheaters || []).join(', ')})`)
        );
        // Trigger push alerts once per newly added movie/theater without blocking HTTP response.
        Promise.allSettled(
          newNotifications.map((event) =>
            pushNotifier(event, options.pushOptions).catch((err) => {
              console.error('Push notification error:', err.message);
            })
          )
        );
      }

      return { state, newAdded: newNotifications.length, scanOk: Boolean(scanResult?.ok) };
    })();

    try {
      return await activeScanPromise;
    } finally {
      activeScanPromise = null;
    }
  }

  function noStoreHeaders(res) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'Surrogate-Control': 'no-store',
    });
  }

  // Always returns HTTP 200 with { ok: true, lastChecked, openings } and no-store caching.
  app.get('/api/status', (req, res) => {
    noStoreHeaders(res);
    try {
      const nowMs = nowFn();
      const prevOpenings = state.openings || [];
      const activeOpenings = pruneExpiredOpenings(prevOpenings, nowMs);
      if (activeOpenings.length !== prevOpenings.length) {
        state = { ...state, openings: activeOpenings };
        saveState(state, stateFile).catch(() => {});
      }
      const freshOpenings = activeOpenings.map((item) =>
        refreshOpeningFlags(item, nowMs)
      );
      return res.status(200).json({
        ok: true,
        lastChecked: state.lastChecked || null,
        openings: freshOpenings,
      });
    } catch {
      return res.status(200).json({
        ok: true,
        lastChecked: null,
        openings: [],
      });
    }
  });

  // Supports both GET and POST, updating lastChecked in data/state.json and returning { ok: true, lastChecked }.
  app.all('/api/check-now', async (req, res) => {
    noStoreHeaders(res);
    console.log('[CHECK-NOW]', new Date().toISOString(), `${req.method} /api/check-now triggered`);
    try {
      const result = await performScan('check-now');
      console.log(
        '[CHECK-NOW RESULT]',
        new Date().toISOString(),
        result.state.openings.length,
        'movies in state,',
        result.newAdded,
        'new added'
      );
      return res.status(200).json({
        ok: true,
        lastChecked: result.state.lastChecked,
        newAdded: result.newAdded,
      });
    } catch (err) {
      console.error('[CHECK-NOW ERROR]', new Date().toISOString(), err?.message || 'Scan failed');
      const fallbackIso = new Date(nowFn()).toISOString();
      state = { ...state, lastChecked: fallbackIso };
      await saveState(state, stateFile).catch(() => {});
      return res.status(200).json({
        ok: true,
        lastChecked: state.lastChecked,
      });
    }
  });

  app.get('/api/vapid-public-key', (req, res) => {
    noStoreHeaders(res);
    res.status(200).json({ ok: true, publicKey: getPublicKey() });
  });

  app.post('/api/push/subscribe', async (req, res) => {
    try {
      const subscribedCount = await addSubscription(req.body);
      res.status(200).json({ ok: true, subscribedCount });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/push/unsubscribe', async (req, res) => {
    try {
      const subscribedCount = await removeSubscription(req.body?.endpoint);
      res.status(200).json({ ok: true, subscribedCount });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/push/test', async (req, res) => {
    try {
      if (req.body && req.body.subscription && req.body.subscription.endpoint) {
        await addSubscription(req.body.subscription);
      }
      const result = await sendTestAlert();
      res.status(200).json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/test-doomsday', async (req, res) => {
    noStoreHeaders(res);
    try {
      if (req.body && req.body.subscription && req.body.subscription.endpoint) {
        await addSubscription(req.body.subscription);
      }

      const nowMs = nowFn();
      const durationMs = Number(options.testDoomsdayDurationMs) || DOOMSDAY_TEST_DURATION_MS;
      const expiresAt = nowMs + durationMs;
      const nowIso = new Date(nowMs).toISOString();
      const expiresIso = new Date(expiresAt).toISOString();

      const testOpening = {
        id: 'test-avengers-doomsday',
        title: 'Avengers: Doomsday',
        theaters: ['Ajantha 4K Dolby Atmos'],
        screens: ['Ajantha 4K Dolby Atmos'],
        poster: DOOMSDAY_TEST_POSTER,
        bookingUrl: WEBSITE_URL,
        link: WEBSITE_URL,
        detectedAt: nowIso,
        lastSeenAt: nowIso,
        isLive: true,
        isNew: true,
        newUntil: expiresIso,
        newTheaters: ['Ajantha 4K Dolby Atmos'],
        isDoomsday: true,
        notifiedTheaters: ['Ajantha 4K Dolby Atmos'],
        isTest: true,
        expiresAt,
      };

      const baseOpenings = (state.openings || []).filter(
        (item) => Boolean(item) && !item.isTest && !isOpeningExpired(item, nowMs)
      );
      state = {
        ...state,
        openings: sortOpenings([testOpening, ...baseOpenings]),
      };
      await saveState(state, stateFile);

      if (testDoomsdayTimer) {
        clearTimeout(testDoomsdayTimer);
        testDoomsdayTimer = null;
      }
      testDoomsdayTimer = setTimeout(() => {
        testDoomsdayTimer = null;
        clearTestDoomsdayEntries(nowFn());
      }, durationMs);
      if (typeof testDoomsdayTimer.unref === 'function') {
        testDoomsdayTimer.unref();
      }

      const subscribedCount = Array.isArray(options.pushOptions?.subscriptions)
        ? options.pushOptions.subscriptions.length
        : loadSubscriptionsSync().length;

      activeTestPushPromise = Promise.resolve(
        pushNotifier(
          {
            movie: { ...testOpening },
            addedTheaters: [...testOpening.theaters],
            isDoomsday: true,
          },
          options.pushOptions
        )
      ).catch((err) => {
        console.error('[TEST-DOOMSDAY PUSH ERROR]', err?.message || err);
        return { count: 0, results: [] };
      });

      const freshOpenings = state.openings.map((item) => refreshOpeningFlags(item, nowMs));
      return res.status(200).json({
        ok: true,
        opening: refreshOpeningFlags(testOpening, nowMs),
        lastChecked: state.lastChecked || null,
        openings: freshOpenings,
        expiresAt,
        durationMs,
        subscribedCount,
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err?.message || 'Test Doomsday failed' });
    }
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js') || filePath.endsWith('manifest.json')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    })
  );

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  function clearTimers() {
    if (testDoomsdayTimer) {
      clearTimeout(testDoomsdayTimer);
      testDoomsdayTimer = null;
    }
  }

  return {
    app,
    performScan,
    getState: () => state,
    clearTimers,
    awaitTestPush: () => activeTestPushPromise,
  };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 120000;
  const { app, performScan, clearTimers } = createApp();

  const server = app.listen(PORT, () => {
    console.log(`Karur Cinemas Ticket Tracker listening on http://localhost:${PORT} (interval: ${SCAN_INTERVAL_MS}ms)`);
    setImmediate(() => {
      performScan('startup').catch((err) => console.error('Initial scan error:', err.message));
    });
  });

  const intervalId = setInterval(() => {
    performScan('scheduled').catch((err) => console.error('Scheduled scan error:', err.message));
  }, SCAN_INTERVAL_MS);
  intervalId.unref();

  process.on('SIGINT', () => {
    clearInterval(intervalId);
    clearTimers();
    server.close(() => process.exit(0));
  });
}

module.exports = { createApp };
