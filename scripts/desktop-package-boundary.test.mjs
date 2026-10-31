import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DESKTOP_PACKAGE_BOUNDARY, writeDesktopPackageBoundary } from './desktop-package-boundary.mjs';

function createTree(root, name) {
  const resources = join(root, name, 'resources');
  const server = join(resources, 'server');
  const vendor = join(resources, 'node_modules', 'vendor');
  mkdirSync(server, { recursive: true });
  mkdirSync(vendor, { recursive: true });
  writeFileSync(join(server, 'feature.js'), 'export const marker = 42;\n');
  writeFileSync(join(server, 'legacy.cjs'), 'module.exports = { marker: 7 };\n');
  writeFileSync(join(vendor, 'package.json'), JSON.stringify({ name: 'vendor', type: 'commonjs', exports: './index.js' }));
  writeFileSync(join(vendor, 'index.js'), 'module.exports = { marker: 9 };\n');
  writeFileSync(join(server, 'probe.mjs'), `
    import { marker } from './feature.js';
    import legacy from './legacy.cjs';
    import vendor from 'vendor';
    if (marker !== 42 || legacy.marker !== 7 || vendor.marker !== 9) throw Error('Wrong module semantics');
  `);
  writeFileSync(join(server, 'compat.mjs'), `
    import legacy from './legacy.cjs';
    import vendor from 'vendor';
    if (legacy.marker !== 7 || vendor.marker !== 9) throw Error('Wrong vendor semantics');
  `);
  return { resources, server };
}

function run(file, cwd) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [file], {
    cwd, env, encoding: 'utf8', timeout: 10_000,
  });
}

test('bundled package scope stops an incompatible parent from deciding .js semantics', () => {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-package-scope-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}\n');
    const without = createTree(root, 'without');
    const withBoundary = createTree(root, 'with');
    assert.equal(run(join(without.server, 'compat.mjs'), root).status, 0,
      'explicit .cjs and vendor-owned package remain usable without the boundary');
    const inherited = run(join(without.server, 'probe.mjs'), root);
    assert.notEqual(inherited.status, 0, 'without a boundary, parent CommonJS semantics must be observable');
    assert.match(inherited.stderr, /SyntaxError|Unexpected token/);
    assert.equal(writeDesktopPackageBoundary(withBoundary.resources),
      join(withBoundary.resources, 'package.json'));
    assert.equal(readFileSync(join(withBoundary.resources, 'package.json'), 'utf8'), DESKTOP_PACKAGE_BOUNDARY);
    assert.equal(run(join(withBoundary.server, 'probe.mjs'), root).status, 0,
      'new scope loads ESM .js while keeping .cjs and vendor CommonJS semantics');
    assert.throws(() => writeDesktopPackageBoundary(withBoundary.resources), { code: 'EEXIST' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bundled package scope does not parse a malformed ancestor manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'seqivo-package-invalid-'));
  try {
    writeFileSync(join(root, 'package.json'), '{invalid-json');
    const without = createTree(root, 'without');
    const withBoundary = createTree(root, 'with');
    assert.notEqual(run(join(without.server, 'probe.mjs'), root).status, 0);
    writeDesktopPackageBoundary(withBoundary.resources);
    assert.equal(run(join(withBoundary.server, 'probe.mjs'), root).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
