(() => {
  const WEBSITE_URL = 'https://karurcinemas.com';
  const CACHE_KEY = 'kc_tracker_state_v1';
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
    toastBar: document.getElementById('toast-bar'),
  };

  function isDoomsdayTitle(title) {
    const val = String(title || '');
    return /\bavengers\b/i.test(val) && /\bdoomsday\b/i.test(val);
  }

  function isItemNewActive(item) {
    if (!item) return false;
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

  function createMovieCard(item) {
    const newActive = isItemNewActive(item);
    const doomsday = Boolean(item.isDoomsday || isDoomsdayTitle(item.title));

    const card = document.createElement('article');
    card.className = `movie-card${doomsday ? ' card-doomsday' : ''}`;

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
      newBadge.textContent = doomsday ? 'Doomsday 4D Alert' : 'New 48h';
      badges.appendChild(newBadge);
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
    link.href = item.link || WEBSITE_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Direct Link: karurcinemas.com ↗';
    footer.appendChild(link);

    body.appendChild(footer);
    card.appendChild(body);
    return card;
  }

  function render(data) {
    currentData = {
      lastChecked: data?.lastChecked || null,
      openings: Array.isArray(data?.openings) ? data.openings : [],
    };

    const openings = currentData.openings;
    const newCount = openings.filter((o) => isItemNewActive(o)).length;
    const liveCount = openings.filter((o) => Boolean(o.isLive)).length;

    if (dom.countAll) dom.countAll.textContent = String(openings.length);
    if (dom.countNew) dom.countNew.textContent = String(newCount);
    if (dom.countLive) dom.countLive.textContent = String(liveCount);

    if (dom.lastCheckedText) {
      dom.lastCheckedText.textContent = currentData.lastChecked
        ? `Last Checked: ${formatTimestamp(currentData.lastChecked)}`
        : 'Last Checked: Syncing baseline';
    }

    updateDoomsdayTheme(openings);

    const visible = filterOpenings(openings, activeTab);
    dom.cardsGrid.innerHTML = '';

    if (visible.length === 0) {
      dom.emptyState.classList.remove('hidden');
      if (activeTab === 'new') {
        dom.emptyState.textContent =
          'No brand-new movie or theater openings in the active 48-hour / 4-day window yet.';
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
        render(data);
        return data;
      }
    } catch {
      // Silently preserve rendered state and retry on the next poll.
    } finally {
      clearTimeout(timer);
    }
    return null;
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
      await fetchStatus();
      if (result && result.ok) {
        const added = Number(result.newAdded || 0);
        showToast(
          added > 0
            ? `Scan complete: ${added} new opening(s) detected!`
            : 'Scan complete: Karur Cinemas outer listings are up to date.'
        );
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

  function bindEvents() {
    for (const btn of dom.tabButtons) {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab || 'all';
        for (const other of dom.tabButtons) {
          const isSelected = other === btn;
          other.classList.toggle('active', isSelected);
          other.setAttribute('aria-selected', String(isSelected));
        }
        render(currentData);
      });
    }

    dom.checkNowBtn?.addEventListener('click', runManualCheck);
    dom.enableNotificationsBtn?.addEventListener('click', handleEnableNotifications);
    dom.testAlertBtn?.addEventListener('click', handleTestAlert);
  }

  async function init() {
    bindEvents();
    updateNotificationButtonState();

    // Instant <5ms cache hydration if available, immediately followed by fresh no-store API sync.
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.ok) render(parsed);
      }
    } catch {
      // ignore invalid cache
    }

    ensureServiceWorker().catch(() => {});

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
