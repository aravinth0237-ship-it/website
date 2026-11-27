const {
  WEBSITE_URL,
  NORMAL_NEW_DURATION_MS,
  DOOMSDAY_NEW_DURATION_MS,
  RECENT_FLICKER_GRACE_MS,
  isAvengersDoomsday,
  normalizeMovieKey,
} = require('./config');

/**
 * Computes live dynamic New Updates status on an opening entry against `nowMs`.
 * @param {object} opening
 * @param {number} [nowMs]
 */
function refreshOpeningFlags(opening, nowMs = Date.now()) {
  const newUntilMs = opening.newUntil ? Date.parse(opening.newUntil) : NaN;
  const activeNew = Boolean(opening.newUntil && Number.isFinite(newUntilMs) && newUntilMs > nowMs);
  return {
    ...opening,
    isDoomsday: isAvengersDoomsday(opening.title),
    isNew: activeNew,
    newTheaters: activeNew && Array.isArray(opening.newTheaters) ? opening.newTheaters : [],
  };
}

function getNewDurationMs(title) {
  return isAvengersDoomsday(title) ? DOOMSDAY_NEW_DURATION_MS : NORMAL_NEW_DURATION_MS;
}

function sortOpenings(openings) {
  return [...openings].sort((a, b) => {
    const score = (item) => {
      if (item.isDoomsday && (item.isNew || item.isLive)) return 4;
      if (item.isNew) return 3;
      if (item.isLive) return 2;
      return 1;
    };
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return Date.parse(b.detectedAt || 0) - Date.parse(a.detectedAt || 0);
  });
}

/**
 * Applies a website scan result to persisted state while enforcing:
 * - Initial baseline never enters New Updates and never triggers push notifications.
 * - Normal new movies/theaters stay in New Updates for 48 hours.
 * - Avengers: Doomsday (any theater) stays in New Updates for 96 hours (4 days).
 * - Zero spam: only brand-new movies or newly added theaters trigger once.
 *
 * @param {{ lastChecked: string|null, openings: Array, lastWebsiteMovies: Array }} prevState
 * @param {{ ok: boolean, movies: Array }} scanResult
 * @param {number} [nowMs]
 */
function applyScanResults(prevState, scanResult, nowMs = Date.now()) {
  const nowIso = new Date(nowMs).toISOString();
  const isBaseline =
    prevState.lastChecked === null &&
    (!Array.isArray(prevState.openings) || prevState.openings.length === 0) &&
    (!Array.isArray(prevState.lastWebsiteMovies) || prevState.lastWebsiteMovies.length === 0);

  const refreshedExisting = (prevState.openings || []).map((item) =>
    refreshOpeningFlags(item, nowMs)
  );

  // If the outer fetch failed, update lastChecked without wiping lastWebsiteMovies or openings.
  if (!scanResult || !scanResult.ok) {
    return {
      state: {
        lastChecked: nowIso,
        openings: sortOpenings(refreshedExisting),
        lastWebsiteMovies: prevState.lastWebsiteMovies || [],
      },
      newNotifications: [],
      isBaseline: false,
    };
  }

  const scannedMovies = scanResult.movies || [];

  // Initial baseline scan: record live movies without New Updates flags or notifications.
  if (isBaseline) {
    const baselineOpenings = scannedMovies.map((movie) => ({
      id: movie.id || normalizeMovieKey(movie.title),
      title: movie.title,
      theaters: [...(movie.theaters || [])],
      screens: [...(movie.screens || [])],
      poster: movie.poster || '',
      link: WEBSITE_URL,
      detectedAt: nowIso,
      lastSeenAt: nowIso,
      isLive: true,
      isNew: false,
      newUntil: null,
      newTheaters: [],
      isDoomsday: isAvengersDoomsday(movie.title),
      notifiedTheaters: [...(movie.theaters || [])],
    }));

    return {
      state: {
        lastChecked: nowIso,
        openings: sortOpenings(baselineOpenings),
        lastWebsiteMovies: scannedMovies,
      },
      newNotifications: [],
      isBaseline: true,
    };
  }

  const openingMap = new Map();
  for (const item of refreshedExisting) {
    const key = item.id || normalizeMovieKey(item.title);
    openingMap.set(key, {
      ...item,
      id: key,
      isLive: false,
      theaters: Array.isArray(item.theaters) ? [...item.theaters] : [],
      screens: Array.isArray(item.screens) ? [...item.screens] : [],
      newTheaters: Array.isArray(item.newTheaters) ? [...item.newTheaters] : [],
      notifiedTheaters: Array.isArray(item.notifiedTheaters) ? [...item.notifiedTheaters] : [],
    });
  }

  const prevLiveMap = new Map();
  for (const prevMovie of prevState.lastWebsiteMovies || []) {
    const key = prevMovie.id || normalizeMovieKey(prevMovie.title);
    prevLiveMap.set(key, new Set(prevMovie.theaters || []));
  }

  const newNotifications = [];

  for (const movie of scannedMovies) {
    const key = movie.id || normalizeMovieKey(movie.title);
    const doomsday = isAvengersDoomsday(movie.title);
    const durationMs = getNewDurationMs(movie.title);
    const currentTheaters = Array.isArray(movie.theaters) ? movie.theaters : [];
    const currentScreens = Array.isArray(movie.screens) ? movie.screens : [];

    const existing = openingMap.get(key);

    if (!existing) {
      const entry = {
        id: key,
        title: movie.title,
        theaters: [...currentTheaters],
        screens: [...currentScreens],
        poster: movie.poster || '',
        link: WEBSITE_URL,
        detectedAt: nowIso,
        lastSeenAt: nowIso,
        isLive: true,
        isNew: true,
        newUntil: new Date(nowMs + durationMs).toISOString(),
        newTheaters: [...currentTheaters],
        isDoomsday: doomsday,
        notifiedTheaters: [...currentTheaters],
      };
      openingMap.set(key, entry);
      newNotifications.push({
        movie: entry,
        addedTheaters: [...currentTheaters],
        isDoomsday: doomsday,
      });
      continue;
    }

    const prevLiveTheaters = prevLiveMap.get(key) || new Set();
    const lastSeenMs = existing.lastSeenAt ? Date.parse(existing.lastSeenAt) : 0;
    const returnedAfterLongAbsence =
      !prevLiveMap.has(key) && nowMs - lastSeenMs > RECENT_FLICKER_GRACE_MS;

    const knownTheaters = new Set([
      ...existing.theaters,
      ...existing.notifiedTheaters,
      ...prevLiveTheaters,
    ]);

    const addedTheaters = returnedAfterLongAbsence
      ? [...currentTheaters]
      : currentTheaters.filter((t) => !knownTheaters.has(t));

    // Merge current theaters and screens cleanly.
    const mergedTheaters = [...existing.theaters];
    for (const theater of currentTheaters) {
      if (!mergedTheaters.includes(theater)) {
        mergedTheaters.push(theater);
      }
    }

    const mergedScreens = [...existing.screens];
    for (const screen of currentScreens) {
      if (!mergedScreens.includes(screen)) {
        mergedScreens.push(screen);
      }
    }

    existing.theaters = mergedTheaters;
    existing.screens = mergedScreens;
    if (movie.poster) existing.poster = movie.poster;
    existing.link = WEBSITE_URL;
    existing.lastSeenAt = nowIso;
    existing.isLive = true;
    existing.isDoomsday = doomsday;

    if (addedTheaters.length > 0) {
      const mergedNewTheaters = [...existing.newTheaters];
      for (const theater of addedTheaters) {
        if (!mergedNewTheaters.includes(theater)) {
          mergedNewTheaters.push(theater);
        }
        if (!existing.notifiedTheaters.includes(theater)) {
          existing.notifiedTheaters.push(theater);
        }
      }
      existing.detectedAt = nowIso;
      existing.isNew = true;
      existing.newUntil = new Date(nowMs + durationMs).toISOString();
      existing.newTheaters = mergedNewTheaters;

      newNotifications.push({
        movie: { ...existing },
        addedTheaters,
        isDoomsday: doomsday,
      });
    }
  }

  return {
    state: {
      lastChecked: nowIso,
      openings: sortOpenings(Array.from(openingMap.values())),
      lastWebsiteMovies: scannedMovies,
    },
    newNotifications,
    isBaseline: false,
  };
}

module.exports = {
  refreshOpeningFlags,
  getNewDurationMs,
  sortOpenings,
  applyScanResults,
};
