import assert from 'node:assert/strict';
import test from 'node:test';

import { showSpawnedMesh } from '../src/spawn-visual.js';

test('spawn visuals move to the new position before becoming visible', () => {
  const events = [];
  const mesh = {
    _visible: false,
    position: {
      copy(position) {
        events.push(`position:${position.x},${position.y},${position.z}`);
      },
    },
    set visible(value) {
      events.push(`visible:${value}`);
      this._visible = value;
    },
    get visible() {
      return this._visible;
    },
  };

  showSpawnedMesh(mesh, { x: 12, y: 0.1, z: -8 });

  assert.deepEqual(events, ['position:12,0.1,-8', 'visible:true']);
  assert.equal(mesh.visible, true);
});

test('spawn visuals can synchronize a hidden authoritative state', () => {
  const mesh = {
    visible: true,
    position: { copy(position) { this.value = position; } },
  };
  const position = { x: -4, y: 2, z: 9 };

  showSpawnedMesh(mesh, position, false);

  assert.equal(mesh.position.value, position);
  assert.equal(mesh.visible, false);
});
