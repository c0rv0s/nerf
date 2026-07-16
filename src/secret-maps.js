const SECRET_MAP_IDS = new Set(['olympus', 'prism']);
const UNLOCK_STORAGE_PREFIX = 'nerf-arena-secret-map-unlocked-v1:';

function unlockStorageKey(mapId) {
  return `${UNLOCK_STORAGE_PREFIX}${mapId}`;
}

export function unlockSecretMap(mapId) {
  if (!SECRET_MAP_IDS.has(mapId)) return;
  try {
    localStorage.setItem(unlockStorageKey(mapId), 'true');
  } catch { /* localStorage may be unavailable */ }
}

export function isSecretMapUnlocked(mapId) {
  if (!SECRET_MAP_IDS.has(mapId)) return false;
  try {
    return localStorage.getItem(unlockStorageKey(mapId)) === 'true';
  } catch {
    return false;
  }
}

export function canVoteForMap(map) {
  return !map.secret || isSecretMapUnlocked(map.id);
}
