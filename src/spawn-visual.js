// Move a character's rendered mesh before revealing it. Respawns otherwise
// expose the mesh for one frame at its previous position (or at the origin for
// a newly-created remote character) before the normal update loop catches up.
export function showSpawnedMesh(mesh, position, visible = true) {
  if (!mesh) return;
  if (position) mesh.position?.copy?.(position);
  mesh.visible = !!visible;
}
