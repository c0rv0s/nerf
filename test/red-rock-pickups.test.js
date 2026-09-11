import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('Red Rock has no authored point pickup before an elimination', async () => {
  const source = await readFile(resolve(ROOT, 'src/maps.js'), 'utf8');
  const start = source.indexOf('function buildOldWest(');
  const end = source.indexOf('function buildFortress(', start);

  assert.ok(start >= 0 && end > start, 'could not isolate the Red Rock map builder');
  assert.doesNotMatch(source.slice(start, end), /\[\s*['"]points['"]\s*,/);
});
