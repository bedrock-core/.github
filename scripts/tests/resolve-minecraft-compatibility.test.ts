import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCompatibility } from '../resolve-minecraft-compatibility.ts';
import releases from './compatibility-releases.json' with { type: 'json' };

type Sources = Parameters<typeof resolveCompatibility>[0];
type GameChannel = Sources['samples'][number]['gameChannel'];
type SdkModule = keyof Sources['packages'];

function install(sources: Sources, module: SdkModule, version: string): void {
  sources.packages[module].versions[version] = { version };
}

function addBuild(sources: Sources, version: string, channel: GameChannel = 'stable'): void {
  const key = channel === 'stable' ? 'versions' : 'preview_versions';

  sources.bds.linux[key].push(version);
  sources.bds.windows[key].push(version);
}

function sources(): Sources {
  const inputs: Sources = {
    bds: { linux: { versions: [], preview_versions: [] }, windows: { versions: [], preview_versions: [] } },
    samples: [],
    packages: {
      server: { name: '@minecraft/server', versions: {} },
      serverUi: { name: '@minecraft/server-ui', versions: {} },
      gameTest: { name: '@minecraft/server-gametest', versions: {} },
      vanillaData: { name: '@minecraft/vanilla-data', versions: {} },
    },
  };

  for (const release of releases) {
    const { gameVersion, gameChannel, vanillaData, gameTest, apis } = release;

    assert(gameChannel === 'stable' || gameChannel === 'preview', 'Invalid fixture game channel');

    const releaseVersion = gameChannel === 'stable' ? vanillaData + '.1' : gameVersion;
    const sample = {
      gameVersion: releaseVersion,
      gameChannel,
      ref: 'v' + releaseVersion + (gameChannel === 'preview' ? '-preview' : ''),
      sha: 'a'.repeat(40),
      modules: [] as { name: string }[],
    } satisfies Sources['samples'][number];

    addBuild(inputs, gameVersion, gameChannel);
    install(inputs, 'vanillaData', vanillaData);
    install(inputs, 'gameTest', gameTest);

    for (const [channel, { server, serverUi }] of Object.entries(apis)) {
      install(inputs, 'server', server);
      install(inputs, 'serverUi', serverUi);
      sample.modules.push({ name: 'server_' + server.split('-')[0] + (channel === 'beta' ? '-beta' : '') + '.json' });
      sample.modules.push({ name: 'server-ui_' + serverUi.split('-')[0] + (channel === 'beta' ? '-beta' : '') + '.json' });
    }

    inputs.samples.push(sample);
  }

  return inputs;
}

test('the stable lines use the latest hotfix with their own tagged SDKs', () => {
  const inputs = sources();

  addBuild(inputs, '1.26.66.1');
  const result = resolveCompatibility(inputs);
  const stable = result.matrix.include.find(row => row.id === '1.26.66.1-stable-stable');

  assert.deepEqual(result.games.map(game => game.gameVersion), ['1.26.66.1', '1.26.52.3', '1.26.70.23']);
  assert(stable && 'packages' in stable);
  assert.equal(stable.packages['@minecraft/server'], '2.11.0');
});

test('exact Preview RC and Beta SDKs can run before the Mojang sample tag arrives', () => {
  const inputs = sources();
  const suffix = '1.26.70-preview.26';

  addBuild(inputs, '1.26.70.26', 'preview');
  install(inputs, 'server', '2.12.0-rc.' + suffix);
  install(inputs, 'serverUi', '2.4.0-rc.' + suffix);
  install(inputs, 'server', '2.13.0-beta.' + suffix);
  install(inputs, 'serverUi', '2.5.0-beta.' + suffix);
  install(inputs, 'vanillaData', suffix);
  install(inputs, 'gameTest', '1.0.0-beta.' + suffix);

  const result = resolveCompatibility(inputs);
  const preview = result.matrix.include.filter(row => 'gameChannel' in row).filter(row => row.gameChannel === 'preview');

  assert.deepEqual(preview.map(row => row.id), ['1.26.70.26-preview-rc', '1.26.70.26-preview-beta']);
  assert(result.pending.some(reason => reason.includes('stable SDK selection waiting')));
});

test('a late GameTest package leaves build-only compatibility available', () => {
  const inputs = sources();

  delete inputs.packages.gameTest.versions['1.0.0-beta.1.26.70-preview.23'];
  const result = resolveCompatibility(inputs);
  const preview = result.matrix.include.filter(row => 'gameChannel' in row).filter(row => row.gameChannel === 'preview');
  const native = resolveCompatibility(inputs, { requireGameTest: true });

  assert.equal(preview.length, 3);
  assert(preview.every(row => !row.packages['@minecraft/server-gametest']));
  assert(result.pending.some(reason => reason.includes('native suites waiting')));
  assert.deepEqual(native.matrix.include,
    result.matrix.include.filter(row => row.apiChannel === 'locked' || row.gameChannel === 'stable'));
  assert.deepEqual(native.games, result.games);
});

test('the previous stable lines stay testable while a new stable line waits', () => {
  const inputs = sources();

  addBuild(inputs, '1.26.41.1');
  install(inputs, 'vanillaData', '1.26.40');
  install(inputs, 'gameTest', '1.0.0-beta.1.26.40-stable');
  install(inputs, 'server', '2.9.0');
  install(inputs, 'serverUi', '2.1.0');
  inputs.samples.push({
    gameVersion: '1.26.40.1',
    gameChannel: 'stable',
    ref: 'v1.26.40.1',
    sha: 'b'.repeat(40),
    modules: [{ name: 'server_2.9.0.json' }, { name: 'server-ui_2.1.0.json' }],
  });

  delete inputs.packages.vanillaData.versions['1.26.60'];
  let result = resolveCompatibility(inputs);

  assert.deepEqual(result.games.map(game => game.gameVersion), ['1.26.61.1', '1.26.52.3', '1.26.70.23']);
  assert(result.matrix.include.some(row => row.id === '1.26.41.1-stable-stable'));
  assert(result.matrix.include.some(row => row.id === '1.26.52.3-stable-stable'));

  install(inputs, 'vanillaData', '1.26.60');
  result = resolveCompatibility(inputs);

  assert(result.matrix.include.some(row => row.id === '1.26.61.1-stable-stable'));
  assert(!result.matrix.include.some(row => row.id === '1.26.41.1-stable-stable'));
});

test('one-platform BDS updates retain the last shared build', () => {
  const inputs = sources();

  inputs.bds.linux.versions.push('1.26.66.1');
  const result = resolveCompatibility(inputs);

  assert.equal(result.games[0].gameVersion, '1.26.61.1');
  assert(result.pending.some(reason => reason.includes('1.26.66.1')));
});
