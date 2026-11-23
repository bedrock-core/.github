import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import semver from 'semver';
import { minecraftPeerRange, prepareMinecraftUpdate } from '../prepare-minecraft-update.ts';
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
  assert.equal(readJson(path.join(root, 'package.json')).resolutions['@minecraft/vanilla-data'], '1.26.70-preview.23');
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

test('prepares peer ranges and stable pins from the same matrix', (t) => {
  const root = project(t);
  const manifest = path.join(root, 'package.json');
  const library = path.join(root, 'packages/library/package.json');
  const privateProject = path.join(root, 'packages/fixture/package.json');
  const standalone = path.join(root, 'standalone/package.json');
  const peerDependencies = {
    '@minecraft/server': '>=2.9.0 || >=2.10.0-0',
    '@minecraft/server-ui': '*',
    '@minecraft/vanilla-data': '>=1.20.70 || 1.26.70-preview.22',
    '@minecraft/debug-utilities': '1.0.0-beta.1.26.60-preview.30',
    eslint: '^10.3.0',
  };

  writeJson(manifest, {
    private: true, workspaces: ['packages/*'],
    resolutions: {
      '@minecraft/server': '2.10.0',
      '@minecraft/vanilla-data': '1.26.50',
      '@bedrock-core/bds-runner': '0.3.0',
    },
  });
  writeJson(library, { peerDependencies, devDependencies: { '@minecraft/server': '*' } });
  writeJson(privateProject, { private: true, peerDependencies });
  writeJson(standalone, { peerDependencies });
  prepareMinecraftUpdate(root, { include: matrix });

  const updated = readJson(library);

  assert.deepEqual(readJson(manifest).resolutions, {
    '@minecraft/server': '2.11.0',
    '@minecraft/vanilla-data': '1.26.60',
    '@bedrock-core/bds-runner': '0.3.0',
  });
  assert.deepEqual(updated.devDependencies, { '@minecraft/server': '*' });
  assert.equal(updated.peerDependencies.eslint, peerDependencies.eslint);
  assert.equal(updated.peerDependencies['@minecraft/debug-utilities'], peerDependencies['@minecraft/debug-utilities']);
  assert.ok(updated.peerDependencies['@minecraft/server'].startsWith('^2.9.0 || '));
  assert.ok(semver.satisfies('2.9.0', updated.peerDependencies['@minecraft/server']));
  assert.ok(!semver.satisfies('3.0.0', updated.peerDependencies['@minecraft/server']));
  assert.ok(!semver.satisfies('2.13.0-beta.1.26.70-preview.99', updated.peerDependencies['@minecraft/server']));
  const dataRange = updated.peerDependencies['@minecraft/vanilla-data'];

  assert.equal(dataRange, '1.26.50 || 1.26.60 || 1.26.70-preview.23');
  assert.ok(!semver.satisfies('1.26.70', dataRange));
  assert.ok(!semver.satisfies('1.26.70-preview.22', dataRange));

  for (const row of runtime) {
    assert.ok(semver.satisfies(row.packages['@minecraft/server'], updated.peerDependencies['@minecraft/server']));
    assert.ok(semver.satisfies(row.packages['@minecraft/server-ui'], updated.peerDependencies['@minecraft/server-ui']));
    assert.ok(semver.satisfies(row.packages['@minecraft/vanilla-data'], dataRange));
  }

  assert.deepEqual(readJson(privateProject).peerDependencies, peerDependencies);
  assert.deepEqual(readJson(standalone).peerDependencies, peerDependencies);
  const published = readFileSync(library, 'utf8');

  prepareMinecraftUpdate(root, { include: matrix });
  assert.equal(readFileSync(library, 'utf8'), published);

  prepareMinecraftUpdate(root, { include: matrix.filter(row => !('gameChannel' in row) || row.gameChannel === 'stable') });
  assert.equal(readJson(library).peerDependencies['@minecraft/vanilla-data'], dataRange);
});

test('preserves an advertised prerelease track while its new SDK is pending', () => {
  const existing = '^2.9.0 || 2.13.0-beta.1.26.70-preview.23';
  const versions = ['2.11.0', '2.12.0-rc.1.26.70-preview.26'];

  assert.equal(minecraftPeerRange(existing, versions), `${existing} || ${versions[1]}`);
  const stableOnly = minecraftPeerRange('>=2.9.0 || >=2.10.0-0', ['2.11.0']);

  assert.ok(semver.satisfies('2.10.0-beta.1.26.40-stable', stableOnly));
  assert.ok(!semver.satisfies('3.0.0', stableOnly));
});
