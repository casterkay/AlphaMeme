import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_POINTS = ['src/host/main.mjs', 'scripts/backup.mjs', 'scripts/import-export.mjs'];
// Static `import`/`export … from`, side-effect imports, and literal dynamic imports.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;

function localImportGraph(entryPoints) {
  const files = new Set();
  const visit = file => {
    if (files.has(file)) return;
    files.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
      if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier));
    }
  };
  entryPoints.forEach(entry => visit(resolve(ROOT, entry)));
  return [...files].map(file => relative(ROOT, file));
}

// A path is in the image when a Dockerfile COPY names it or a directory holding it,
// and .dockerignore (which excludes everything) re-includes it the same way.
const covers = (paths, file) => paths.some(path => file === path || file.startsWith(`${path}/`));
const strip = path => path.replace(/^\.\//, '').replace(/\/$/, '');

test('the Docker image contains every local module the host and its scripts import', () => {
  const copied = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8').split('\n')
    .filter(line => /^COPY\s/.test(line))
    .flatMap(line => line.trim().split(/\s+/).slice(1, -1).map(strip));
  const included = readFileSync(resolve(ROOT, '.dockerignore'), 'utf8').split('\n')
    .filter(line => line.startsWith('!'))
    .map(line => strip(line.slice(1)));
  const graph = localImportGraph(ENTRY_POINTS);
  assert.ok(graph.includes('src/radar-agent.mjs'), 'the walk follows the dynamic import of the host');
  assert.deepEqual(graph.filter(file => !covers(copied, file) || !covers(included, file)), []);
});
