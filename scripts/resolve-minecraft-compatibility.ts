import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const bdsUrl = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json';
const samplesApi = 'https://api.github.com/repos/Mojang/bedrock-samples';
export const stableLines = 2;
const gameChannels = ['stable', 'preview'] as const;
const apiChannels = ['stable', 'rc', 'beta'] as const;
const packageNames = {
  server: '@minecraft/server',
  serverUi: '@minecraft/server-ui',
  gameTest: '@minecraft/server-gametest',
  vanillaData: '@minecraft/vanilla-data',
};

type GameChannel = typeof gameChannels[number];
type ApiChannel = typeof apiChannels[number];
type ApiModule = 'server' | 'serverUi';
type Packages = Record<keyof typeof packageNames, RegistryPackage>;
type ModuleFile = { name: string };

interface RegistryPackage {
  name: string;
  versions: Record<string, { version: string }>;
}

interface BdsIndex {
  linux: { versions: string[]; preview_versions: string[] };
  windows: { versions: string[]; preview_versions: string[] };
}

interface Game {
  gameVersion: string;
  gameChannel: GameChannel;
}

interface Sample extends Game {
  ref: string;
  sha: string;
  modules?: ModuleFile[] | null;
}

interface RuntimeRelease extends Game {
  vanillaData: string;
  gameTest?: string;
  apis: Partial<Record<ApiChannel, Record<ApiModule, string>>>;
}

interface Sources {
  bds: BdsIndex;
  samples: Sample[];
  packages: Packages;
}

interface RuntimeRow extends Game {
  id: string;
  name: string;
  apiChannel: ApiChannel;
  engineVersion: string;
  packages: Record<string, string>;
}

interface LockedRow {
  id: 'locked';
  name: string;
  apiChannel: 'locked';
}

interface Compatibility {
  matrix: { include: (RuntimeRow | LockedRow)[] };
  games: Game[];
  pending: string[];
  sources: string[];
}

const compare = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });
const newest = (values: string[]): string | undefined => values.sort(compare).at(-1);
const isBuildVersion = (version: string): boolean => /^1\.\d+\.\d+\.\d+$/.test(version);
const published = (metadata: RegistryPackage, version: string): boolean => metadata.versions[version]?.version === version;

function releaseLine(version: string): string {
  const [, year, drop] = version.split('.').map(Number);

  return `1.${year}.${Math.floor(drop / 10) * 10}`;
}

const gameName = (game: Game): string => `${game.gameChannel} ${game.gameVersion}`;

function releaseSuffix(game: Game): string {
  return game.gameChannel === 'preview' ? '-preview.' + game.gameVersion.split('.').at(-1) : '-stable';
}

export function manifestVersion(version: string): string {
  const match = /^(\d+\.\d+\.\d+)(?:-(beta|rc)\..+)?$/.exec(version);

  assert(match, `Expected an exact SDK version, got ${version}`);

  return match[1] + (match[2] === 'beta' ? '-beta' : '');
}

export function createMatrix(releases: RuntimeRelease[]): Compatibility['matrix'] {
  const include: (RuntimeRow | LockedRow)[] = releases.flatMap((release) => {
    assert(isBuildVersion(release.gameVersion), 'Use a four-part BDS version');
    assert(gameChannels.includes(release.gameChannel), 'Unknown game channel');

    const { gameChannel, gameVersion } = release;
    const engineVersion = releaseLine(gameVersion);
    const suffix = releaseSuffix(release);

    assert(release.vanillaData === engineVersion + (gameChannel === 'preview' ? suffix : ''), 'Vanilla data must match the game');
    assert(!release.gameTest || release.gameTest === `1.0.0-beta.${engineVersion}${suffix}`, 'GameTest SDK must match the game');

    return apiChannels.flatMap((apiChannel) => {
      const sdk = release.apis[apiChannel];

      if (!sdk) { return []; }

      for (const version of [sdk.server, sdk.serverUi]) {
        manifestVersion(version);
        assert(apiChannel === 'stable' ? /^\d+\.\d+\.\d+$/.test(version) : version.endsWith(`-${apiChannel}.${engineVersion}${suffix}`), 'SDK channel/build mismatch');
      }

      return [{
        id: `${gameVersion}-${gameChannel}-${apiChannel}`,
        name: `Minecraft ${engineVersion.slice(2)} / ${gameChannel} game / ${apiChannel} API`,
        gameVersion, gameChannel, apiChannel, engineVersion,
        packages: {
          '@minecraft/server': sdk.server,
          '@minecraft/server-ui': sdk.serverUi,
          '@minecraft/vanilla-data': release.vanillaData,
          ...(release.gameTest ? { '@minecraft/server-gametest': release.gameTest } : {}),
        },
      }];
    });
  });

  include.push({ id: 'locked', name: 'Locked dependencies', apiChannel: 'locked' });

  return { include };
}

function selectGames(bds: BdsIndex): { games: Record<GameChannel, Game[]>; pending: string[] } {
  const pending: string[] = [];
  const games = { stable: [], preview: [] } as Record<GameChannel, Game[]>;

  for (const gameChannel of gameChannels) {
    const field = gameChannel === 'stable' ? 'versions' : 'preview_versions';
    const linux = bds.linux?.[field];
    const windows = bds.windows?.[field];

    assert(Array.isArray(linux) && Array.isArray(windows), `BDS index is missing Linux or Windows ${field}`);

    const latestPerLine = new Map<string, string>();
    const readyPerLine = new Map<string, string>();
    const builds = [...new Set([...linux, ...windows])].filter(isBuildVersion).sort((a, b) => compare(b, a));
    const available = new Set(windows);

    for (const version of builds) {
      const line = releaseLine(version);

      if (!latestPerLine.has(line)) { latestPerLine.set(line, version); }

      if (!readyPerLine.has(line) && available.has(version) && linux.includes(version)) { readyPerLine.set(line, version); }
    }

    const latest = [...latestPerLine.entries()].slice(0, gameChannel === 'stable' ? stableLines : 1);

    for (const [line, version] of latest) {
      if (readyPerLine.get(line) !== version) {
        pending.push(`${gameChannel} ${version}: waiting for Linux and Windows BDS builds.`);
      }
    }

    // One older stable line can still be tested during a staged release.
    const ready = [...readyPerLine.values()].slice(0, gameChannel === 'stable' ? stableLines + 1 : 1);

    games[gameChannel] = ready.map(gameVersion => ({ gameVersion, gameChannel }));
  }

  return { games, pending };
}

function sampleFor(game: Game, samples: Sample[]): Sample | undefined {
  return samples.filter(sample => sample.gameChannel === game.gameChannel
    && (game.gameChannel === 'preview'
      ? sample.gameVersion === game.gameVersion
      : sample.gameVersion.startsWith(releaseLine(game.gameVersion) + '.')
        && compare(sample.gameVersion, game.gameVersion) <= 0))
    .sort((a, b) => compare(b.gameVersion, a.gameVersion))[0];
}

function prerelease(pack: RegistryPackage, channel: 'rc' | 'beta', suffix: string): string | undefined {
  const ending = `-${channel}.${suffix}`;
  const base = newest(Object.keys(pack.versions).filter(version => version.endsWith(ending)
    && /^\d+\.\d+\.\d+$/.test(version.slice(0, -ending.length)) && published(pack, version))
    .map(version => version.slice(0, -ending.length)));

  return base && base + ending;
}

function stableApi(pack: RegistryPackage, sample: Sample | undefined, name: string, suffix: string): string | undefined {
  const moduleName = new RegExp(`^${name}_(\\d+\\.\\d+\\.\\d+)\\.json$`);

  return newest((sample?.modules ?? []).flatMap(({ name: filename }) => {
    const version = moduleName.exec(filename)?.[1];

    return version && published(pack, version) && !published(pack, `${version}-rc.${suffix}`) ? [version] : [];
  }));
}

function resolveGame(game: Game, { samples, packages }: Sources, pending: string[], evidence: Set<string>): RuntimeRelease | undefined {
  const sample = sampleFor(game, samples);
  const line = releaseLine(game.gameVersion);
  const suffix = line + releaseSuffix(game);
  const vanillaData = game.gameChannel === 'stable' ? line : suffix;
  const gameTest = `1.0.0-beta.${suffix}`;
  const missingGameTest = !published(packages.gameTest, gameTest);
  const apis: RuntimeRelease['apis'] = {};

  const wait = (reason: string): void => { pending.push(`${gameName(game)}: ${reason}.`); };

  if (!published(packages.vanillaData, vanillaData)) {
    wait(`waiting for ${packageNames.vanillaData}@${vanillaData}`);

    return;
  }

  if (missingGameTest) { wait(`native suites waiting for ${packageNames.gameTest}@${gameTest}`); }

  if (sample?.modules) { evidence.add(`https://github.com/Mojang/bedrock-samples/tree/${sample.sha}/metadata/script_modules/%40minecraft`); }

  for (const channel of apiChannels) {
    const server = channel === 'stable' ? stableApi(packages.server, sample, 'server', suffix) : prerelease(packages.server, channel, suffix);
    const serverUi = channel === 'stable' ? stableApi(packages.serverUi, sample, 'server-ui', suffix) : prerelease(packages.serverUi, channel, suffix);

    if (server && serverUi) { apis[channel] = { server, serverUi }; } else if (channel === 'stable') {
      wait(sample?.modules ? 'waiting for the tagged stable npm SDK pair' : 'stable SDK selection waiting for matching Mojang module metadata');
    } else if (server || serverUi || (sample?.modules ?? []).some(module => module.name.endsWith(`-${channel}.json`))) {
      wait(`waiting for the exact ${channel} server and server-ui SDK pair`);
    }
  }

  return { ...game, vanillaData, gameTest: missingGameTest ? undefined : gameTest, apis };
}

export function resolveCompatibility(sources: Sources, { requireGameTest = false } = {}): Compatibility {
  for (const [key, name] of Object.entries(packageNames)) {
    const pack = sources.packages[key as keyof Packages];

    assert(pack?.name === name && pack.versions && typeof pack.versions === 'object', `Invalid npm metadata for ${name}`);
  }

  const { games, pending } = selectGames(sources.bds);
  const evidence = new Set<string>();
  const stable = games.stable.slice(0, stableLines);
  const selected = [...stable, ...games.preview].map(game => resolveGame(game, sources, pending, evidence))
    .filter((release): release is RuntimeRelease => release !== undefined);
  const previous = games.stable[stableLines];

  if (previous && selected.filter(release => release.gameChannel === 'stable' && release.apis.stable && release.gameTest).length < stableLines) {
    const fallback = resolveGame(previous, sources, pending, evidence);

    if (fallback?.apis.stable && fallback.gameTest) { selected.push(fallback); }
  }

  return {
    matrix: createMatrix(requireGameTest ? selected.filter(release => release.gameTest) : selected),
    games: [...stable, ...games.preview],
    pending,
    sources: [...evidence],
  };
}

export async function fetchSources({ fetchImpl = fetch, githubToken = process.env.GH_TOKEN } = {}): Promise<Sources> {
  async function json<T>(url: string): Promise<T>;
  async function json<T>(url: string, allowMissing: true): Promise<T | null>;

  async function json<T>(url: string, allowMissing = false): Promise<T | null> {
    const headers = new Headers({ accept: 'application/json' });

    if (githubToken && new URL(url).origin === 'https://api.github.com') { headers.set('authorization', 'Bearer ' + githubToken); }

    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) });

    if (allowMissing && response.status === 404) { return null; }

    assert(response.ok, `GET ${url} returned HTTP ${response.status}`);

    return await response.json() as T;
  }

  const [bds, publisherPackages] = await Promise.all([
    json<BdsIndex>(bdsUrl),
    Promise.all(Object.entries(packageNames).map(async ([key, name]) => [key, await json<RegistryPackage>(`https://registry.npmjs.org/${name}`)] as const)),
  ]);
  const { games } = selectGames(bds);
  const years = new Set(Object.values(games).flat().map(game => game.gameVersion.split('.')[1]));
  const tags = (await Promise.all([...years].map(year => json<{ ref: string; object: { sha: string } }[]>(`${samplesApi}/git/matching-refs/tags/v1.${year}.`)))).flat();
  const samples: Sample[] = tags.flatMap(({ ref, object }) => {
    const match = /^refs\/tags\/v(1\.\d+\.\d+\.\d+)(-preview)?$/.exec(ref);

    return match
      ? [{
          gameVersion: match[1], gameChannel: match[2] ? 'preview' : 'stable', ref: ref.slice(10), sha: object.sha,
        }]
      : [];
  });
  const needed = new Set(Object.values(games).flat().map(game => sampleFor(game, samples)));

  needed.delete(undefined);
  await Promise.all([...needed].map(async (sample) => {
    assert(sample && /^[\da-f]{40}$/.test(sample.sha), 'Invalid Mojang Samples tag');

    // Resolve annotated tags to a commit before reading the directory.
    const commit = await json<{ sha: string }>(`${samplesApi}/commits/${encodeURIComponent(sample.ref)}`);

    assert(/^[\da-f]{40}$/.test(commit.sha), 'Invalid Mojang Samples commit');
    sample.sha = commit.sha;
    sample.modules = await json<ModuleFile[]>(`${samplesApi}/contents/metadata/script_modules/%40minecraft?ref=${sample.sha}`, true);
    assert(sample.modules === null || (Array.isArray(sample.modules) && sample.modules.every(module => typeof module.name === 'string')), 'Invalid Mojang module directory');
  }));

  return { bds, samples, packages: Object.fromEntries(publisherPackages) as Packages };
}

function formatSummary(result: Compatibility): string {
  const rows = result.matrix.include.filter(row => 'packages' in row);
  const ready = rows.map(row =>
    `| ${row.gameVersion} | ${row.gameChannel} | ${row.apiChannel} | ${row.packages['@minecraft/server']} | ${row.packages['@minecraft/server-ui']} | ${row.packages['@minecraft/server-gametest'] ? 'Ready' : 'Waiting'} |`);

  return [
    '## Minecraft compatibility inputs', '',
    '| BDS build | Game | SDK track | Server SDK | Server UI SDK | GameTest SDK |',
    '| --- | --- | --- | --- | --- | --- |',
    ...ready, '',
    ...(result.pending.length ? ['### Waiting for upstream inputs', '', ...result.pending.map(reason => '- ' + reason), ''] : []),
    ...result.sources.map((url, index) => `[Mojang module metadata ${index + 1}](${url})`),
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'require-gametest': { type: 'boolean' } } });
  const result = resolveCompatibility(await fetchSources(), { requireGameTest: values['require-gametest'] });
  const snapshot = JSON.stringify(result);

  if (values.output) { await writeFile(values.output, JSON.stringify(result, null, 2) + '\n'); }

  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(result.matrix)}\ngames=${JSON.stringify(result.games)}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) { await appendFile(process.env.GITHUB_STEP_SUMMARY, formatSummary(result)); }

  console.info(snapshot);
}
