const INSTALL_DISMISS_KEY = 'nerf-arena-install-dismissed-v1';
const INSTALL_REMINDER_DELAY = 7 * 24 * 60 * 60 * 1000;
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
const UPDATE_CHECK_THROTTLE = 5 * 60 * 1000;
const UPDATE_SAFE_POLL_INTERVAL = 1000;
const ACTIVATE_UPDATE_MESSAGE = 'NERF_ARENA_SKIP_WAITING';

export function isStandaloneApp(win = window, nav = navigator) {
  return nav.standalone === true ||
    win.matchMedia?.('(display-mode: fullscreen)').matches ||
    win.matchMedia?.('(display-mode: standalone)').matches;
}

function isMobileDevice(win = window, nav = navigator) {
  if (new URLSearchParams(win.location.search).get('touch') === '1') return true;
  return (nav.maxTouchPoints || 0) > 0 &&
    (win.matchMedia?.('(pointer: coarse)').matches || /Android|iPhone|iPad|iPod/i.test(nav.userAgent));
}

function recentlyDismissed() {
  try {
    const dismissedAt = Number(localStorage.getItem(INSTALL_DISMISS_KEY));
    return Number.isFinite(dismissedAt) && Date.now() - dismissedAt < INSTALL_REMINDER_DELAY;
  } catch {
    return false;
  }
}

export function setupPwaUpdates({
  serviceWorker = navigator.serviceWorker,
  windowRef = window,
  documentRef = document,
  isSafeToReload = () => true,
  onUpdateReady = () => {},
  now = () => Date.now(),
} = {}) {
  if (!serviceWorker?.register) return null;

  let registration = null;
  let pendingWorker = null;
  let reloadRequested = false;
  let safePollTimer = null;
  let lastUpdateCheck = 0;
  let started = false;

  const clearSafePoll = () => {
    if (safePollTimer == null) return;
    windowRef.clearInterval(safePollTimer);
    safePollTimer = null;
  };

  const activatePendingUpdate = () => {
    if (!pendingWorker) return false;
    if (!isSafeToReload()) {
      onUpdateReady(true);
      if (safePollTimer == null) {
        safePollTimer = windowRef.setInterval(
          activatePendingUpdate,
          UPDATE_SAFE_POLL_INTERVAL,
        );
      }
      return false;
    }

    clearSafePoll();
    onUpdateReady(false);
    reloadRequested = true;
    const worker = pendingWorker;
    pendingWorker = null;
    worker.postMessage({ type: ACTIVATE_UPDATE_MESSAGE });
    return true;
  };

  const queueWaitingWorker = (worker) => {
    if (!worker || !serviceWorker.controller) return;
    pendingWorker = worker;
    activatePendingUpdate();
  };

  const watchInstallingWorker = (worker) => {
    if (!worker) return;
    const handleStateChange = () => {
      if (worker.state === 'installed') {
        queueWaitingWorker(registration?.waiting || worker);
      }
    };
    worker.addEventListener('statechange', handleStateChange);
    handleStateChange();
  };

  const checkForUpdate = async (force = false) => {
    if (!registration) return false;
    activatePendingUpdate();
    const checkedAt = now();
    if (!force && checkedAt - lastUpdateCheck < UPDATE_CHECK_THROTTLE) return false;
    lastUpdateCheck = checkedAt;
    try {
      await registration.update();
      queueWaitingWorker(registration.waiting);
      return true;
    } catch (error) {
      console.warn('PWA update check failed:', error);
      return false;
    }
  };

  const start = async () => {
    if (started) return registration;
    started = true;
    try {
      registration = await serviceWorker.register('./sw.js', {
        updateViaCache: 'none',
      });
      registration.addEventListener('updatefound', () => {
        watchInstallingWorker(registration.installing);
      });
      watchInstallingWorker(registration.installing);
      queueWaitingWorker(registration.waiting);
      await checkForUpdate(true);
      windowRef.setInterval(() => checkForUpdate(), UPDATE_CHECK_INTERVAL);
      return registration;
    } catch (error) {
      started = false;
      registration = null;
      console.warn('PWA service worker could not register:', error);
      return null;
    }
  };

  serviceWorker.addEventListener('controllerchange', () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    windowRef.location.reload();
  });
  documentRef.addEventListener('visibilitychange', () => {
    if (documentRef.hidden) return;
    activatePendingUpdate();
    checkForUpdate();
  });
  windowRef.addEventListener('online', () => {
    if (registration) checkForUpdate(true);
    else start();
  });

  const ready = documentRef.readyState === 'complete'
    ? start()
    : new Promise((resolve) => {
      windowRef.addEventListener('load', () => resolve(start()), { once: true });
    });

  return { ready, checkForUpdate, activatePendingUpdate };
}

export function setupPwaInstall({ isSafeToReload } = {}) {
  const banner = document.getElementById('installPrompt');
  const updateBanner = document.getElementById('updatePrompt');
  let updateReady = false;

  const showUpdateReady = (ready) => {
    updateReady = ready;
    if (updateBanner) updateBanner.hidden = !ready;
    if (ready && banner) banner.hidden = true;
  };

  if ('serviceWorker' in navigator) {
    setupPwaUpdates({ isSafeToReload, onUpdateReady: showUpdateReady });
  }

  const message = document.getElementById('installMessage');
  const installButton = document.getElementById('installButton');
  const dismissButton = document.getElementById('installDismiss');
  if (!banner || !isMobileDevice() || isStandaloneApp() || recentlyDismissed()) return;

  const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  let deferredPrompt = null;
  let revealed = false;

  const reveal = () => {
    if (revealed || updateReady || isStandaloneApp()) return;
    revealed = true;
    banner.hidden = false;
    if (deferredPrompt) {
      installButton.textContent = 'INSTALL';
      message.textContent = 'Install for fullscreen play and quicker launches.';
    } else if (isiOS) {
      installButton.textContent = 'HOW';
      message.textContent = 'Add Nerf Arena to your Home Screen for fullscreen play.';
    } else {
      installButton.textContent = 'HOW';
      message.textContent = 'Install this game from your browser menu for fullscreen play.';
    }
  };

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    reveal();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    banner.hidden = true;
  });

  installButton.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      banner.hidden = true;
      return;
    }
    message.textContent = isiOS
      ? 'Tap Share, then “Add to Home Screen”. Launch the new icon to play fullscreen.'
      : 'Open the browser menu and choose “Install app” or “Add to Home screen”.';
    installButton.hidden = true;
    banner.classList.add('instructions');
  });
  dismissButton.addEventListener('click', () => {
    banner.hidden = true;
    try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch { /* ignore */ }
  });

  window.setTimeout(reveal, 1400);
}
