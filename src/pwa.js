const INSTALL_DISMISS_KEY = 'nerf-arena-install-dismissed-v1';
const INSTALL_REMINDER_DELAY = 7 * 24 * 60 * 60 * 1000;

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

export function setupPwaInstall() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((error) => {
        console.warn('PWA service worker could not register:', error);
      });
    });
  }

  const banner = document.getElementById('installPrompt');
  const message = document.getElementById('installMessage');
  const installButton = document.getElementById('installButton');
  const dismissButton = document.getElementById('installDismiss');
  if (!banner || !isMobileDevice() || isStandaloneApp() || recentlyDismissed()) return;

  const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  let deferredPrompt = null;
  let revealed = false;

  const reveal = () => {
    if (revealed || isStandaloneApp()) return;
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
