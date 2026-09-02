import assert from 'node:assert/strict';
import test from 'node:test';

import { setupPwaUpdates } from '../src/pwa.js';

function eventTarget(properties = {}) {
  return Object.assign(new EventTarget(), properties);
}

test('PWA updates wait for the Atrium before activating and reload exactly once', async () => {
  let safeToReload = false;
  let reloads = 0;
  let updateChecks = 0;
  let registeredWith = null;
  const updateReadyStates = [];
  const messages = [];
  const timers = new Map();
  let nextTimer = 1;

  const waitingWorker = eventTarget({
    state: 'installed',
    postMessage(message) {
      messages.push(message);
    },
  });
  const registration = eventTarget({
    installing: null,
    waiting: waitingWorker,
    async update() {
      updateChecks += 1;
    },
  });
  const serviceWorker = eventTarget({
    controller: {},
    async register(url, options) {
      registeredWith = { url, options };
      return registration;
    },
  });
  const windowRef = eventTarget({
    location: {
      reload() {
        reloads += 1;
      },
    },
    setInterval(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
  });
  const documentRef = eventTarget({
    hidden: false,
    readyState: 'complete',
  });

  const updater = setupPwaUpdates({
    serviceWorker,
    windowRef,
    documentRef,
    isSafeToReload: () => safeToReload,
    onUpdateReady: ready => updateReadyStates.push(ready),
    now: () => 123456,
  });
  await updater.ready;

  assert.deepEqual(registeredWith, {
    url: './sw.js',
    options: { updateViaCache: 'none' },
  });
  assert.equal(updateChecks, 1);
  assert.equal(updateReadyStates.at(-1), true);
  assert.deepEqual(messages, []);
  assert.equal(reloads, 0);

  safeToReload = true;
  assert.equal(updater.activatePendingUpdate(), true);
  assert.equal(updateReadyStates.at(-1), false);
  assert.deepEqual(messages, [{ type: 'NERF_ARENA_SKIP_WAITING' }]);
  assert.equal(reloads, 0);

  serviceWorker.dispatchEvent(new Event('controllerchange'));
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  assert.equal(reloads, 1);
});
