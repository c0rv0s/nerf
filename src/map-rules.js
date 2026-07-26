// Match-size rules shared by the browser client and authoritative server.
// Vote lobbies still hold eight people; a smaller map can only be selected
// when the current lobby fits its match limit.
export const DEFAULT_MAP_PLAYER_LIMIT = 8;

const MAP_PLAYER_LIMITS = Object.freeze({
  bloom: 4,
});

export function mapPlayerLimit(mapOrId, fallback = DEFAULT_MAP_PLAYER_LIMIT) {
  const id = typeof mapOrId === 'string' ? mapOrId : mapOrId?.id;
  return MAP_PLAYER_LIMITS[id] ?? fallback;
}
