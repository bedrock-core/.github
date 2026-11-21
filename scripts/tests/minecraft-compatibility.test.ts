import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { createMatrix, manifestVersion } from '../resolve-minecraft-compatibility.ts';
import { prepareProject } from '../setup-minecraft-compatibility.ts';
import fixtureReleases from './compatibility-releases.json' with { type: 'json' };

type Release = Parameters<typeof createMatrix>[0][number];

const releases = fixtureReleases.map<Release>((release) => {
  const { gameChannel } = release;

  assert(gameChannel === 'stable' || gameChannel === 'preview');

  return { ...release, gameChannel };
});
const matrix = createMatrix(releases).include;
const runtime = matrix.filter(row => row.apiChannel !== 'locked');
const target = runtime.find(row => row.gameChannel === 'preview' && row.apiChannel === 'beta');
const baseline = matrix.at(-1);

assert(target && baseline);

const fixtures = ['packages/test-fixtures'];
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

function writeJson(file: string, data: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data));
}

function project(t: TestContext): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mc-compatibility-'));

  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, 'package.json'), { scripts: {}, resolutions: { unrelated: '1.0.0' } });

  return root;
}

test('the matrix separates game channels from API tracks and retains the locked baseline', () => {
  assert.equal(matrix.length, 8);
  assert.deepEqual([...new Set(runtime.filter(row => row.gameChannel === 'stable').map(row => row.engineVersion))], ['1.26.50', '1.26.60']);
  assert.deepEqual(runtime.filter(row => row.gameChannel === 'preview').map(row => row.apiChannel), ['stable', 'rc', 'beta']);
  assert.equal(baseline.id, 'locked');
});

test('rejects a Beta SDK from another game build and an unpinned SDK', () => {
  const invalid = structuredClone(releases);
  const beta = invalid[2].apis.beta;

  assert(beta);
  beta.server = '2.13.0-beta.1.26.70-preview.22';
  assert.throws(() => createMatrix(invalid), /SDK channel\/build mismatch/);
  beta.server = 'latest';
  assert.throws(() => createMatrix(invalid), /exact SDK version/);
});

test('maps npm packages to native manifest versions', () => {
  assert.equal(manifestVersion('2.11.0'), '2.11.0');
  assert.equal(manifestVersion('2.12.0-rc.1.26.70-preview.23'), '2.12.0');
  assert.equal(manifestVersion('2.13.0-beta.1.26.70-preview.23'), '2.13.0-beta');
});

test('retargets fixture manifests and build targets while preserving pack identity and entrypoints', (t) => {
  const root = project(t);
  const fixture = path.join(root, 'packages/test-fixtures');
  const manifest = {
    header: { uuid: 'pack-id', min_engine_version: [1, 26, 50] },
    modules: [{ type: 'script', entry: 'scripts/gametest.js', uuid: 'module-id' }],
    dependencies: [{ module_name: '@minecraft/server', version: '2.10.0' }, { uuid: 'peer', version: '1.0.0' }],
  };

  writeJson(path.join(fixture, 'config.json'), { targetVersion: '1.26.50', packs: { behaviorPack: './packs/BP' } });
  writeJson(path.join(fixture, 'packs/BP/manifest.json'), manifest);
  writeJson(path.join(fixture, 'packs/BP/manifest.test.json'), { extends: './manifest.json', dependencies: [{ module_name: '@minecraft/server-gametest', version: 'old' }] });
  writeJson(path.join(root, 'unrelated/manifest.json'), manifest);
  prepareProject(root, target, fixtures);

  const selected = readJson(path.join(fixture, 'packs/BP/manifest.json'));

  assert.equal(selected.header.uuid, 'pack-id');
  assert.deepEqual(selected.header.min_engine_version, [1, 26, 70]);
  assert.deepEqual(selected.modules, manifest.modules);
  assert.deepEqual(selected.dependencies[1], manifest.dependencies[1]);
  assert.equal(selected.dependencies[0].version, '2.13.0-beta');
  assert.equal(readJson(path.join(fixture, 'packs/BP/manifest.test.json')).dependencies[0].version, '1.0.0-beta');
  assert.equal(readJson(path.join(fixture, 'config.json')).targetVersion, '1.26.70');
  assert.deepEqual(readJson(path.join(root, 'unrelated/manifest.json')), manifest);
  assert.equal(readJson(path.join(root, 'package.json')).resolutions.unrelated, '1.0.0');
});

test('the locked baseline changes no dependencies or fixture files', (t) => {
  const root = project(t);
  const before = readFileSync(path.join(root, 'package.json'), 'utf8');

  prepareProject(root, baseline, fixtures);
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), before);
});

test('preserves the published Builder and BDS Runner dependencies', (t) => {
  const root = project(t);
  const manifest = path.join(root, 'package.json');
  const fixtureFile = path.join(root, 'packages/test-fixtures/package.json');
  const fixture = {
    scripts: { build: 'bc-builder build config.json test', typecheck: 'tsc --noEmit' },
    devDependencies: { '@bedrock-core/builder': '0.2.0' },
  };

  writeJson(manifest, {
    resolutions: { '@bedrock-core/bds-runner': '0.3.0' },
    devDependencies: { '@bedrock-core/bds-runner': '^0.3.0' },
  });
  writeJson(fixtureFile, fixture);
  prepareProject(root, target, fixtures);

  const pkg = readJson(manifest);

  assert.deepEqual(readJson(fixtureFile), fixture);
  assert.equal(pkg.resolutions['@bedrock-core/bds-runner'], '0.3.0');
  assert.equal(pkg.devDependencies['@bedrock-core/bds-runner'], '^0.3.0');
});
