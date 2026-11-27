const fs = require('fs');
const path = require('path');
const { DATA_DIR, STATE_FILE, SUBSCRIPTIONS_FILE, VAPID_FILE } = require('./config');

const DEFAULT_STATE = Object.freeze({
  lastChecked: null,
  openings: [],
  lastWebsiteMovies: [],
});

let writeQueue = Promise.resolve();

function ensureDataDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object') {
    return { lastChecked: null, openings: [], lastWebsiteMovies: [] };
  }
  return {
    lastChecked: typeof raw.lastChecked === 'string' ? raw.lastChecked : null,
    openings: Array.isArray(raw.openings) ? raw.openings : [],
    lastWebsiteMovies: Array.isArray(raw.lastWebsiteMovies) ? raw.lastWebsiteMovies : [],
  };
}

function readJsonSyncSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.trim()) return fallback;
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function writeJsonAtomicSync(filePath, data) {
  ensureDataDir(path.dirname(filePath));
  const payload = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, payload, 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Fallback for Windows file-lock contention during concurrent reads.
    fs.writeFileSync(filePath, payload, 'utf8');
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
  }
}

function loadStateSync(stateFile = STATE_FILE) {
  ensureDataDir(path.dirname(stateFile));
  const parsed = readJsonSyncSafe(stateFile, null);
  const clean = sanitizeState(parsed);
  if (!fs.existsSync(stateFile)) {
    writeJsonAtomicSync(stateFile, clean);
  }
  return clean;
}

function saveState(state, stateFile = STATE_FILE) {
  // Strictly persist only { lastChecked, openings, lastWebsiteMovies } in data/state.json.
  const clean = sanitizeState(state);
  writeQueue = writeQueue.then(() => {
    writeJsonAtomicSync(stateFile, clean);
    return clean;
  });
  return writeQueue;
}

function loadSubscriptionsSync(subsFile = SUBSCRIPTIONS_FILE) {
  ensureDataDir(path.dirname(subsFile));
  const parsed = readJsonSyncSafe(subsFile, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveSubscriptions(subscriptions, subsFile = SUBSCRIPTIONS_FILE) {
  const list = Array.isArray(subscriptions) ? subscriptions : [];
  writeQueue = writeQueue.then(() => {
    writeJsonAtomicSync(subsFile, list);
    return list;
  });
  return writeQueue;
}

function loadVapidSync(vapidFile = VAPID_FILE) {
  ensureDataDir(path.dirname(vapidFile));
  const parsed = readJsonSyncSafe(vapidFile, null);
  if (parsed && parsed.publicKey && parsed.privateKey) {
    return parsed;
  }
  return null;
}

function saveVapidSync(keys, vapidFile = VAPID_FILE) {
  writeJsonAtomicSync(vapidFile, keys);
  return keys;
}

module.exports = {
  DEFAULT_STATE,
  ensureDataDir,
  sanitizeState,
  loadStateSync,
  saveState,
  loadSubscriptionsSync,
  saveSubscriptions,
  loadVapidSync,
  saveVapidSync,
};
