require('dotenv').config();
const path = require('path');
const express = require('express');
const { STATE_FILE } = require('./src/config');
const { loadStateSync, saveState } = require('./src/stateStore');
const { scanWebsite } = require('./src/scanner');
const { applyScanResults, refreshOpeningFlags } = require('./src/tracker');
const {
  initPushService,
  getPublicKey,
  addSubscription,
  removeSubscription,
  notifyNewOpening,
  sendTestAlert,
} = require('./src/pushService');

function createApp(options = {}) {
  const stateFile = options.stateFile || STATE_FILE;
  const runWebsiteScan = options.scanWebsite || scanWebsite;
  const nowFn = options.nowFn || (() => Date.now());
  const pushNotifier = options.notifyNewOpening || notifyNewOpening;

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  let state = loadStateSync(stateFile);
  let activeScanPromise = null;

  initPushService();

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
      const freshOpenings = (state.openings || []).map((item) =>
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

  return {
    app,
    performScan,
    getState: () => state,
  };
}

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS) || 120000;
  const { app, performScan } = createApp();

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
    server.close(() => process.exit(0));
  });
}

module.exports = { createApp };
