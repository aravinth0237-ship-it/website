(() => {
  const WEBSITE_URL = 'https://karurcinemas.com';
  const CACHE_KEY = 'kc_tracker_state_v1';
  const DOOMSDAY_TEST_DONE_KEY = 'kc_doomsday_test_completed_v1';
  const DOOMSDAY_TEST_EXPIRES_KEY = 'kc_doomsday_test_expires_v1';
  const FALLBACK_POSTER =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
        <rect width="300" height="400" fill="#0f172a"/>
        <rect x="20" y="20" width="260" height="360" rx="14" fill="#1e293b" stroke="#475569"/>
        <text x="150" y="195" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="20" font-weight="bold">KARUR CINEMAS</text>
        <text x="150" y="225" text-anchor="middle" fill="#94a3b8" font-family="sans-serif" font-size="13">Poster Preview</text>
      </svg>`
    );

  let activeTab = 'all';
  let currentData = { lastChecked: null, openings: [] };
  let toastTimer = null;
  let toastTargetTab = null;
  let testCleanupTimer = null;
  let testCountdownInterval = null;
  let activeTestExpiresAt = 0;
  let localTestPushTimers = [];
  let localReleasePushTimers = [];
  let eventsSource = null;
  const notifiedReleaseKeys = new Set();

  const dom = {
    doomsdayBanner: document.getElementById('doomsday-banner'),
    metaThemeColor: document.getElementById('meta-theme-color'),
    lastCheckedText: document.getElementById('last-checked-text'),
    cardsGrid: document.getElementById('cards-grid'),
    emptyState: document.getElementById('empty-state'),
    countAll: document.getElementById('count-all'),
    countNew: document.getElementById('count-new'),
    countLive: document.getElementById('count-live'),
    tabButtons: Array.from(document.querySelectorAll('.tab-btn')),
    checkNowBtn: document.getElementById('check-now-btn'),
    enableNotificationsBtn: document.getElementById('enable-notifications-btn'),
    testAlertBtn: document.getElementById('test-alert-btn'),
    testDoomsdayBtn: document.getElementById('test-doomsday-btn'),
    toastBar: document.getElementById('toast-bar'),
  };

  function isDebugMode() {
    try {
      return new URLSearchParams(window.location.search).get('debug') === '1';
    } catch {
      return false;
    }
  }

  function syncDoomsdayTestButtonVisibility() {
    if (!dom.testDoomsdayBtn) return;
    if (isDebugMode()) {
      dom.testDoomsdayBtn.classList.remove('hidden');
      return;
    }
    let completed = false;
    try {
      const pendingExpires = Number(localStorage.getItem(DOOMSDAY_TEST_EXPIRES_KEY));
      if (Number.isFinite(pendingExpires) && pendingExpires > 0 && pendingExpires <= Date.now()) {
        localStorage.setItem(DOOMSDAY_TEST_DONE_KEY, '1');
        localStorage.removeItem(DOOMSDAY_TEST_EXPIRES_KEY);
      }
      completed = localStorage.getItem(DOOMSDAY_TEST_DONE_KEY) === '1';
    } catch {
      completed = false;
    }
    dom.testDoomsdayBtn.classList.toggle('hidden', completed);
  }

  function isDoomsdayTitle(title) {
    const val = String(title || '');
    return /\bavengers\b/i.test(val) && /\bdoomsday\b/i.test(val);
  }

  function isItemActive(item) {
    if (!item) return false;
    if (item.expiresAt !== undefined && item.expiresAt !== null) {
      const expMs = Number(item.expiresAt);
      if (Number.isFinite(expMs) && expMs <= Date.now()) return false;
    }
    return true;
  }

  function isItemNewActive(item) {
    if (!isItemActive(item)) return false;
    if (item.newUntil) {
      const untilMs = Date.parse(item.newUntil);
      if (Number.isFinite(untilMs)) return untilMs > Date.now();
    }
    return Boolean(item.isNew);
  }

  function formatTimestamp(iso) {
    if (!iso) return 'Just initialized';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Recently';
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function formatRelativeTime(iso) {
    if (!iso) return '';
    const diffMs = Date.now() - Date.parse(iso);
    if (!Number.isFinite(diffMs) || diffMs < 0) return 'just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function showToast(message) {
    if (!dom.toastBar) return;
    dom.toastBar.textContent = message;
    dom.toastBar.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toastBar.classList.add('hidden');
    }, 5000);
  }

  function updateDoomsdayTheme(openings) {
    const activeDoomsday = (openings || []).some(
      (item) =>
        (item.isDoomsday || isDoomsdayTitle(item.title)) &&
        (isItemNewActive(item) || Boolean(item.isLive))
    );

    if (activeDoomsday) {
      document.documentElement.classList.add('theme-doomsday');
      dom.doomsdayBanner?.classList.remove('hidden');
      if (dom.metaThemeColor) dom.metaThemeColor.setAttribute('content', '#064e3b');
    } else {
      document.documentElement.classList.remove('theme-doomsday');
      dom.doomsdayBanner?.classList.add('hidden');
      if (dom.metaThemeColor) dom.metaThemeColor.setAttribute('content', '#e50914');
    }
  }

  function filterOpenings(openings, tab) {
    if (tab === 'new') return openings.filter((item) => isItemNewActive(item));
    if (tab === 'live') return openings.filter((item) => Boolean(item.isLive));
    return openings;
  }

  function getBookingUrl(item) {
    const raw = (item && (item.bookingUrl || item.link)) || WEBSITE_URL;
    try {
      const parsed = new URL(String(raw).trim(), WEBSITE_URL);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'karurcinemas.com' && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
          return WEBSITE_URL;
        }
        return parsed.href;
      }
    } catch {
      // Fall back to the generic home page if a stored URL is malformed.
    }
    return WEBSITE_URL;
  }

  function createMovieCard(item) {
    const newActive = isItemNewActive(item);
    const doomsday = Boolean(item.isDoomsday || isDoomsdayTitle(item.title));
    const bookingUrl = getBookingUrl(item);

    const card = document.createElement('article');
    card.className = `movie-card${doomsday ? ' card-doomsday' : ''}`;
    card.dataset.bookingUrl = bookingUrl;
    card.addEventListener('click', (event) => {
      if (event.target && event.target.closest('a, button')) {
        return;
      }
      window.open(bookingUrl, '_blank', 'noopener,noreferrer');
    });

    const posterWrap = document.createElement('div');
    posterWrap.className = 'poster-wrap';

    const img = document.createElement('img');
    img.className = 'poster-img';
    img.alt = `${item.title || 'Movie'} poster`;
    img.loading = 'lazy';
    img.src = item.poster || FALLBACK_POSTER;
    img.addEventListener('error', () => {
      if (img.src !== FALLBACK_POSTER) img.src = FALLBACK_POSTER;
    });
    posterWrap.appendChild(img);

    const badges = document.createElement('div');
    badges.className = 'card-badges';

    if (item.isLive) {
      const liveBadge = document.createElement('span');
      liveBadge.className = 'badge badge-live';
      liveBadge.textContent = 'Website Live';
      badges.appendChild(liveBadge);
    } else {
      const archiveBadge = document.createElement('span');
      archiveBadge.className = 'badge badge-archive';
      archiveBadge.textContent = 'Archived';
      badges.appendChild(archiveBadge);
    }

    if (newActive) {
      const newBadge = document.createElement('span');
      newBadge.className = 'badge badge-new';
      newBadge.textContent = doomsday ? 'Doomsday Alert' : 'New';
      badges.appendChild(newBadge);
    }

    if (item.isTest) {
      const testBadge = document.createElement('span');
      testBadge.className = 'badge badge-test';
      testBadge.textContent = 'Test Simulation (1m)';
      badges.appendChild(testBadge);
    }

    posterWrap.appendChild(badges);
    card.appendChild(posterWrap);

    const body = document.createElement('div');
    body.className = 'card-body';

    const titleEl = document.createElement('h2');
    titleEl.className = 'movie-title';
    titleEl.textContent = item.title || 'Karur Cinemas Release';
    body.appendChild(titleEl);

    const theatersRow = document.createElement('div');
    theatersRow.className = 'theaters-row';
    const theaters = Array.isArray(item.theaters) && item.theaters.length > 0
      ? item.theaters
      : ['Karur Cinemas'];
    const newTheaterSet = new Set(Array.isArray(item.newTheaters) ? item.newTheaters : []);

    for (const theater of theaters) {
      const pill = document.createElement('span');
      pill.className = `theater-pill${newActive && newTheaterSet.has(theater) ? ' theater-new' : ''}`;
      pill.textContent = theater;
      theatersRow.appendChild(pill);
    }
    body.appendChild(theatersRow);

    if (Array.isArray(item.screens) && item.screens.length > 0) {
      const screenEl = document.createElement('p');
      screenEl.className = 'screen-detail';
      screenEl.textContent = item.screens.join(' • ');
      body.appendChild(screenEl);
    }

    const detectedEl = document.createElement('p');
    detectedEl.className = 'detected-time';
    const relative = formatRelativeTime(item.detectedAt);
    detectedEl.textContent = `Detected: ${formatTimestamp(item.detectedAt)}${relative ? ` (${relative})` : ''}`;
    body.appendChild(detectedEl);

    const footer = document.createElement('div');
    footer.className = 'card-footer';

    const link = document.createElement('a');
    link.className = 'book-link';
    link.href = bookingUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Book Ticket ↗';
    link.setAttribute('aria-label', `Book Ticket for ${item.title || 'Karur Cinemas Release'}`);
    footer.appendChild(link);

    body.appendChild(footer);
    card.appendChild(body);
    return card;
  }

  function clearLocalTestPushTimers() {
    for (const timerId of localTestPushTimers) {
      clearTimeout(timerId);
    }
    localTestPushTimers = [];
  }

  function clearTestTimers() {
    if (testCleanupTimer) {
      clearTimeout(testCleanupTimer);
      testCleanupTimer = null;
    }
    if (testCountdownInterval) {
      clearInterval(testCountdownInterval);
      testCountdownInterval = null;
    }
  }

  function updateDoomsdayButtonCountdown(expiresAt) {
    if (!dom.testDoomsdayBtn) return;
    const remainingSec = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (remainingSec > 0) {
      dom.testDoomsdayBtn.disabled = true;
      dom.testDoomsdayBtn.textContent = `Testing Doomsday (${remainingSec}s)`;
    } else {
      dom.testDoomsdayBtn.disabled = false;
      dom.testDoomsdayBtn.textContent = 'Test Doomsday (1m)';
    }
  }

  function completeDoomsdayTest() {
    clearTestTimers();
    clearLocalTestPushTimers();
    activeTestExpiresAt = 0;
    try {
      localStorage.setItem(DOOMSDAY_TEST_DONE_KEY, '1');
      localStorage.removeItem(DOOMSDAY_TEST_EXPIRES_KEY);
    } catch {
      // ignore storage errors
    }
    if (dom.testDoomsdayBtn) {
      dom.testDoomsdayBtn.disabled = false;
      dom.testDoomsdayBtn.textContent = 'Test Doomsday (1m)';
    }
    syncDoomsdayTestButtonVisibility();
  }

  function scheduleTestDoomsdayAutoRevert(expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      completeDoomsdayTest();
      return;
    }
    if (
      testCleanupTimer &&
      activeTestExpiresAt > Date.now() &&
      Math.abs(activeTestExpiresAt - expiresAt) < 5000
    ) {
      return;
    }

    clearTestTimers();
    activeTestExpiresAt = expiresAt;
    try {
      localStorage.setItem(DOOMSDAY_TEST_EXPIRES_KEY, String(expiresAt));
    } catch {
      // ignore storage errors
    }
    updateDoomsdayButtonCountdown(expiresAt);

    testCountdownInterval = setInterval(() => {
      if (Date.now() >= expiresAt) {
        clearInterval(testCountdownInterval);
        testCountdownInterval = null;
        return;
      }
      updateDoomsdayButtonCountdown(expiresAt);
    }, 1000);

    const delayMs = Math.max(50, expiresAt - Date.now() + 120);
    testCleanupTimer = setTimeout(async () => {
      completeDoomsdayTest();
      render(currentData, { fromNetwork: false });
      await fetchStatus();
      showToast('Doomsday simulation completed — reverted to normal theme.');
    }, delayMs);
  }

  function render(data, options = {}) {
    const rawOpenings = Array.isArray(data?.openings) ? data.openings : [];
    const openings = rawOpenings.filter(isItemActive);

    currentData = {
      lastChecked: data?.lastChecked || null,
      openings,
    };

    const newCount = openings.filter((o) => isItemNewActive(o)).length;
    const liveCount = openings.filter((o) => Boolean(o.isLive)).length;

    if (dom.countAll) dom.countAll.textContent = String(openings.length);
    if (dom.countNew) dom.countNew.textContent = String(newCount);
    if (dom.countLive) dom.countLive.textContent = String(liveCount);

    const newTabBtn = dom.tabButtons.find((btn) => btn.dataset.tab === 'new');
    if (newTabBtn) {
      newTabBtn.classList.toggle('tab-has-new', newCount > 0);
    }

    if (dom.lastCheckedText) {
      dom.lastCheckedText.textContent = currentData.lastChecked
        ? `Last Checked: ${formatTimestamp(currentData.lastChecked)}`
        : 'Last Checked: Syncing baseline';
    }

    updateDoomsdayTheme(openings);

    const activeTestItem = openings.find((o) => o && o.isTest && Number(o.expiresAt) > Date.now());
    if (activeTestItem) {
      const serverExpires = Number(activeTestItem.expiresAt);
      const localExpiresAt =
        Number.isFinite(options.localExpiresAt) && options.localExpiresAt > Date.now()
          ? options.localExpiresAt
          : serverExpires;
      scheduleTestDoomsdayAutoRevert(localExpiresAt);
    } else if (options.fromNetwork) {
      let hadPending = false;
      try {
        hadPending = Boolean(localStorage.getItem(DOOMSDAY_TEST_EXPIRES_KEY));
      } catch {
        hadPending = false;
      }
      if (hadPending || activeTestExpiresAt > 0) {
        completeDoomsdayTest();
      }
    }

    const visible = filterOpenings(openings, activeTab);
    dom.cardsGrid.innerHTML = '';

    if (visible.length === 0) {
      dom.emptyState.classList.remove('hidden');
      if (activeTab === 'new') {
        dom.emptyState.textContent =
          'No new movie releases detected yet. Monitoring live...';
      } else if (activeTab === 'live') {
        dom.emptyState.textContent =
          'No live listings currently detected on https://karurcinemas.com. Click Check Now to scan.';
      } else {
        dom.emptyState.textContent =
          'Baseline scan initialized. Movie openings from https://karurcinemas.com appear here automatically.';
      }
      return;
    }

    dom.emptyState.classList.add('hidden');
    const frag = document.createDocumentFragment();
    for (const item of visible) {
      frag.appendChild(createMovieCard(item));
    }
    dom.cardsGrid.appendChild(frag);
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i += 1) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  async function fetchStatus() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch('/api/status', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.ok) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify(data));
        } catch {
          // ignore storage quota limits
        }
        render(data, { fromNetwork: true });
        return data;
      }
    } catch {
      // Silently preserve rendered state and retry on the next poll.
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  function setActiveTab(tab) {
    const targetTab = tab || 'all';
    activeTab = targetTab;
    for (const btn of dom.tabButtons) {
      const isSelected = (btn.dataset.tab || 'all') === targetTab;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));
    }
    render(currentData, { fromNetwork: false });
  }

  async function showBrowserNotification(title, options) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker?.ready : null;
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
    } catch {
      // Fall back to Notification constructor if Service Worker showNotification is unavailable.
    }
    try {
      new Notification(title, options);
    } catch {
      // Ignore environments where window.Notification constructor is disallowed.
    }
  }

  function triggerLocalReleaseNotification(release) {
    if (!release) return;
    const theatersList = Array.isArray(release.addedTheaters) ? release.addedTheaters : [];
    const releaseKey = `${release.id || release.title || ''}::${theatersList.join(',')}::${release.detectedAt || ''}`;
    if (notifiedReleaseKeys.has(releaseKey)) return;
    notifiedReleaseKeys.add(releaseKey);

    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const title = release.title || 'Karur Cinemas Release';
    const theaterText = theatersList.length > 0 ? theatersList.join(', ') : 'Karur Cinemas';
    const targetUrl = getBookingUrl(release);
    const batchId = Date.now();

    if (release.isDoomsday) {
      for (let i = 1; i <= 5; i += 1) {
        const timerId = setTimeout(() => {
          showBrowserNotification(`🚨 URGENT (${i}/5): ${title} — Bookings LIVE!`, {
            body: `${title} open at ${theaterText} in Karur! Book now at karurcinemas.com`,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: `doomsday-release-${batchId}-${i}`,
            renotify: true,
            requireInteraction: true,
            data: { url: targetUrl },
          });
        }, (i - 1) * 2000);
        localReleasePushTimers.push(timerId);
      }
      return;
    }

    showBrowserNotification(`🎬 New Tickets Open: ${title}`, {
      body: `Now booking at ${theaterText} • Karur Cinemas`,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `opening-release-${release.id || batchId}-${batchId}`,
      renotify: true,
      requireInteraction: false,
      data: { url: targetUrl },
    });
  }

  function handleNewReleasesDetected(newReleases, options = {}) {
    if (!Array.isArray(newReleases) || newReleases.length === 0) return;
    const summary = newReleases
      .map((item) => {
        const theaters =
          Array.isArray(item.addedTheaters) && item.addedTheaters.length > 0
            ? ` (${item.addedTheaters.join(', ')})`
            : '';
        return `${item.title || 'New Movie'}${theaters}`;
      })
      .join(' • ');
    showToast(`New update in Karur: ${summary}`);
    if (options.triggerLocalNotification) {
      for (const release of newReleases) {
        triggerLocalReleaseNotification(release);
      }
    }
  }

  function connectEventsStream() {
    if (typeof EventSource === 'undefined' || eventsSource) return;
    try {
      eventsSource = new EventSource('/api/events');
      eventsSource.addEventListener('scan-update', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (!payload || !payload.ok) return;
          try {
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                ok: true,
                lastChecked: payload.lastChecked || null,
                openings: payload.openings || [],
              })
            );
          } catch {
            // ignore storage quota limits
          }
          render(payload, { fromNetwork: true });
          if (Number(payload.newAdded || 0) > 0 && Array.isArray(payload.newReleases)) {
            handleNewReleasesDetected(payload.newReleases, { triggerLocalNotification: false });
          }
        } catch {
          // ignore malformed event payload
        }
      });
      eventsSource.addEventListener('local-notification-fallback', (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload && Array.isArray(payload.newReleases)) {
            handleNewReleasesDetected(payload.newReleases, { triggerLocalNotification: true });
          }
        } catch {
          // ignore malformed event payload
        }
      });
    } catch {
      eventsSource = null;
    }
  }

  async function runManualCheck() {
    if (!dom.checkNowBtn) return;
    dom.checkNowBtn.disabled = true;
    dom.checkNowBtn.textContent = 'Checking...';
    try {
      const res = await fetch('/api/check-now', {
        method: 'POST',
        cache: 'no-store',
      });
      const result = await res.json().catch(() => null);
      if (result && result.ok && Array.isArray(result.openings)) {
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({
              ok: true,
              lastChecked: result.lastChecked || null,
              openings: result.openings,
            })
          );
        } catch {
          // ignore storage quota limits
        }
        render(result, { fromNetwork: true });
      } else {
        await fetchStatus();
      }
      if (result && result.ok) {
        const added = Number(result.newAdded || 0);
        if (added > 0 && Array.isArray(result.newReleases) && result.newReleases.length > 0) {
          handleNewReleasesDetected(result.newReleases, {
            triggerLocalNotification: Number(result.subscribedCount || 0) === 0,
          });
        } else {
          showToast(
            added > 0
              ? `Scan complete: ${added} new opening(s) detected!`
              : 'Scan complete: Karur Cinemas outer listings are up to date.'
          );
        }
      }
    } catch {
      showToast('Scan queued — refreshing status.');
    } finally {
      dom.checkNowBtn.disabled = false;
      dom.checkNowBtn.textContent = 'Check Now';
    }
  }

  async function ensureServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    await navigator.serviceWorker.register('/sw.js');
    return navigator.serviceWorker.ready;
  }

  async function syncPushSubscription() {
    if (!('Notification' in window) || !('PushManager' in window)) {
      return { supported: false, subscription: null };
    }
    const reg = await ensureServiceWorker();
    if (!reg) return { supported: false, subscription: null };

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      const keyRes = await fetch('/api/vapid-public-key', { cache: 'no-store' });
      const keyData = await keyRes.json();
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
    }

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });

    return { supported: true, subscription };
  }

  async function updateNotificationButtonState() {
    if (!dom.enableNotificationsBtn || !('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      dom.enableNotificationsBtn.textContent = 'Notifications Enabled';
    } else if (Notification.permission === 'denied') {
      dom.enableNotificationsBtn.textContent = 'Notifications Blocked';
    } else {
      dom.enableNotificationsBtn.textContent = 'Enable Notifications';
    }
  }

  async function handleEnableNotifications() {
    if (!('Notification' in window)) {
      showToast('This browser does not support Web Push notifications.');
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      await updateNotificationButtonState();
      if (permission !== 'granted') {
        showToast('Please allow notifications in browser settings to receive live ticket alerts.');
        return;
      }

      const { supported } = await syncPushSubscription();
      if (supported) {
        showToast('Notifications enabled! You will receive instant Karur Cinemas alerts.');
      } else {
        showToast('Notification permission granted.');
      }
    } catch {
      showToast('Could not complete push registration on this origin.');
    }
  }

  async function handleTestAlert() {
    if (!dom.testAlertBtn) return;
    dom.testAlertBtn.disabled = true;
    try {
      let currentSub = null;
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const synced = await syncPushSubscription();
          currentSub = synced.subscription;
        } catch {
          // ignore if PushManager unavailable in local preview
        }
      }

      const res = await fetch('/api/push/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: currentSub }),
      });
      const data = await res.json().catch(() => ({}));

      if (data.sent > 0) {
        showToast(`Test alert sent via Web Push (${data.sent} active device${data.sent > 1 ? 's' : ''})!`);
      } else if ('Notification' in window && Notification.permission === 'granted') {
        const reg = await navigator.serviceWorker?.ready;
        if (reg && reg.showNotification) {
          await reg.showNotification(data.payload?.title || 'Karur Cinemas Test Alert', {
            body: data.payload?.body || 'Push notifications are ready!',
            icon: '/icons/icon-192.png',
          });
        }
        showToast('Test alert displayed!');
      } else {
        showToast('Click "Enable Notifications" first to receive real Web Push alerts.');
      }
    } catch {
      showToast('Test alert triggered.');
    } finally {
      dom.testAlertBtn.disabled = false;
    }
  }

  async function triggerLocalFallbackDoomsdayNotifications(opening) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.ready;
    if (!reg || !reg.showNotification) return;
    const theaterText =
      Array.isArray(opening?.theaters) && opening.theaters.length > 0
        ? opening.theaters.join(', ')
        : 'Ajantha 4K Dolby Atmos';
    const batchId = Date.now();
    clearLocalTestPushTimers();
    for (let i = 1; i <= 5; i += 1) {
      const timerId = setTimeout(() => {
        reg
          .showNotification(`🚨 URGENT (${i}/5): Avengers: Doomsday — Bookings LIVE!`, {
            body: `Avengers: Doomsday open at ${theaterText} in Karur! Book now at karurcinemas.com`,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: `doomsday-local-${batchId}-${i}`,
            renotify: true,
            requireInteraction: true,
            data: { url: getBookingUrl(opening) },
          })
          .catch(() => {});
      }, (i - 1) * 2000);
      localTestPushTimers.push(timerId);
    }
  }

  async function handleTestDoomsday() {
    if (!dom.testDoomsdayBtn) return;
    dom.testDoomsdayBtn.disabled = true;
    try {
      let currentSub = null;
      if ('Notification' in window && Notification.permission === 'granted') {
        try {
          const synced = await syncPushSubscription();
          currentSub = synced.subscription;
        } catch {
          // ignore if PushManager unavailable in local preview
        }
      }

      const res = await fetch('/api/test-doomsday', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ subscription: currentSub }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        dom.testDoomsdayBtn.disabled = false;
        showToast('Could not start Doomsday simulation.');
        return;
      }

      const durationMs = Number(data.durationMs) || 60000;
      const localExpiresAt = Date.now() + durationMs;
      try {
        localStorage.removeItem(DOOMSDAY_TEST_DONE_KEY);
        localStorage.setItem(DOOMSDAY_TEST_EXPIRES_KEY, String(localExpiresAt));
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            ok: true,
            lastChecked: data.lastChecked || null,
            openings: data.openings || [],
          })
        );
      } catch {
        // ignore storage quota limits
      }

      render(data, { fromNetwork: true, localExpiresAt });

      if (Number(data.subscribedCount || 0) > 0) {
        showToast('Doomsday simulation active (1m)! Sending 5 urgent Web Push alerts (2s apart)...');
      } else if ('Notification' in window && Notification.permission === 'granted') {
        await triggerLocalFallbackDoomsdayNotifications(data.opening);
        showToast('Doomsday simulation active (1m)! Displaying 5 urgent alerts (2s apart)...');
      } else {
        showToast('Doomsday simulation active (1m)! Enable Notifications for 5x Web Push alerts.');
      }
    } catch {
      dom.testDoomsdayBtn.disabled = false;
      showToast('Could not start Doomsday simulation.');
    }
  }

  function bindEvents() {
    for (const btn of dom.tabButtons) {
      btn.addEventListener('click', () => {
        setActiveTab(btn.dataset.tab || 'all');
      });
    }

    dom.checkNowBtn?.addEventListener('click', runManualCheck);
    dom.enableNotificationsBtn?.addEventListener('click', handleEnableNotifications);
    dom.testAlertBtn?.addEventListener('click', handleTestAlert);
    dom.testDoomsdayBtn?.addEventListener('click', handleTestDoomsday);
  }

  async function init() {
    bindEvents();
    syncDoomsdayTestButtonVisibility();
    updateNotificationButtonState();

    // Instant <5ms cache hydration if available, immediately followed by fresh no-store API sync.
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.ok) render(parsed, { fromNetwork: false });
      }
    } catch {
      // ignore invalid cache
    }

    if ('Notification' in window && Notification.permission === 'granted') {
      syncPushSubscription().catch(() => {});
    } else {
      ensureServiceWorker().catch(() => {});
    }

    connectEventsStream();

    const status = await fetchStatus();
    if (status && status.lastChecked === null) {
      // If server booted milliseconds ago and baseline is still finishing, sync quickly.
      let retries = 0;
      const quickSync = async () => {
        retries += 1;
        const next = await fetchStatus();
        if ((!next || next.lastChecked === null) && retries < 6) {
          setTimeout(quickSync, 500);
        }
      };
      setTimeout(quickSync, 500);
    }

    setInterval(fetchStatus, 30000);
  }

  init();
})();
