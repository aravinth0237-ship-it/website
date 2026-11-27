const webPush = require('web-push');
const {
  loadSubscriptionsSync,
  saveSubscriptions,
  loadVapidSync,
  saveVapidSync,
} = require('./stateStore');
const { WEBSITE_URL } = require('./config');

let initialized = false;
let cachedPublicKey = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function initPushService() {
  if (initialized && cachedPublicKey) return cachedPublicKey;

  let publicKey = process.env.VAPID_PUBLIC_KEY || '';
  let privateKey = process.env.VAPID_PRIVATE_KEY || '';

  if (!publicKey || !privateKey) {
    const stored = loadVapidSync();
    if (stored) {
      publicKey = stored.publicKey;
      privateKey = stored.privateKey;
    } else {
      const generated = webPush.generateVAPIDKeys();
      publicKey = generated.publicKey;
      privateKey = generated.privateKey;
      saveVapidSync({ publicKey, privateKey });
    }
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:alerts@karurcinemas-tracker.local';
  webPush.setVapidDetails(subject, publicKey, privateKey);
  cachedPublicKey = publicKey;
  initialized = true;
  return publicKey;
}

function getPublicKey() {
  return initPushService();
}

async function addSubscription(subscription) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Invalid push subscription payload');
  }
  const current = loadSubscriptionsSync();
  const filtered = current.filter((item) => item.endpoint !== subscription.endpoint);
  filtered.push(subscription);
  await saveSubscriptions(filtered);
  return filtered.length;
}

async function removeSubscription(endpoint) {
  if (!endpoint) return loadSubscriptionsSync().length;
  const current = loadSubscriptionsSync();
  const filtered = current.filter((item) => item.endpoint !== endpoint);
  await saveSubscriptions(filtered);
  return filtered.length;
}

async function sendNotificationToAll(payload, options = {}) {
  initPushService();
  const sender = options.sendNotification || webPush.sendNotification.bind(webPush);
  const subscriptions = options.subscriptions || loadSubscriptionsSync();
  if (subscriptions.length === 0) {
    return { sent: 0, failed: 0, total: 0 };
  }

  const bodyString = JSON.stringify(payload);
  const expiredEndpoints = new Set();
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await sender(sub, bodyString);
        sent += 1;
      } catch (err) {
        failed += 1;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          expiredEndpoints.add(sub.endpoint);
        }
      }
    })
  );

  if (expiredEndpoints.size > 0 && !options.subscriptions) {
    const remaining = subscriptions.filter((sub) => !expiredEndpoints.has(sub.endpoint));
    await saveSubscriptions(remaining);
  }

  return { sent, failed, total: subscriptions.length };
}

/**
 * Triggers Web Push notifications ONLY when a brand-new movie/theater enters New Updates:
 * - Avengers: Doomsday -> 5 separate urgent push notifications, 2 seconds apart.
 * - Normal new movies -> 1 clean push notification.
 */
async function notifyNewOpening({ movie, addedTheaters, isDoomsday }, options = {}) {
  const theatersList =
    addedTheaters && addedTheaters.length > 0 ? addedTheaters : movie.theaters || [];
  const theaterText = theatersList.length > 0 ? theatersList.join(', ') : 'Karur Cinemas';
  const batchId = Date.now();

  if (isDoomsday) {
    const delayMs = options.doomsdayDelayMs ?? 2000;
    const results = [];
    for (let i = 1; i <= 5; i += 1) {
      const payload = {
        title: `🚨 URGENT (${i}/5): ${movie.title} — Bookings LIVE!`,
        body: `${movie.title} open at ${theaterText} in Karur! Book now at karurcinemas.com`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `doomsday-${movie.id}-${batchId}-${i}`,
        renotify: true,
        requireInteraction: true,
        urgent: true,
        url: WEBSITE_URL,
      };
      results.push(await sendNotificationToAll(payload, options));
      if (i < 5 && delayMs > 0) {
        await sleep(delayMs);
      }
    }
    return { count: 5, results };
  }

  const payload = {
    title: `🎬 New Tickets Open: ${movie.title}`,
    body: `Now booking at ${theaterText} • Karur Cinemas`,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `opening-${movie.id}-${batchId}`,
    renotify: true,
    requireInteraction: false,
    urgent: false,
    url: WEBSITE_URL,
  };
  const result = await sendNotificationToAll(payload, options);
  return { count: 1, results: [result] };
}

async function sendTestAlert(options = {}) {
  const payload = {
    title: '🎟️ Karur Cinemas Ticket Tracker — Test Alert',
    body: 'Push alerts are active! You will be notified immediately when new bookings open in Karur.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: `test-alert-${Date.now()}`,
    renotify: true,
    requireInteraction: false,
    urgent: false,
    url: WEBSITE_URL,
  };
  const delivery = await sendNotificationToAll(payload, options);
  return { payload, ...delivery };
}

module.exports = {
  initPushService,
  getPublicKey,
  addSubscription,
  removeSubscription,
  sendNotificationToAll,
  notifyNewOpening,
  sendTestAlert,
};
