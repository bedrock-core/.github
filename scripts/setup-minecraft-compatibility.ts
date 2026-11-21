import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestVersion, type createMatrix } from './resolve-minecraft-compatibility.ts';

type Target = ReturnType<typeof createMatrix>['include'][number];
type ResolvedTarget = Exclude<Target, { apiChannel: 'locked' }>;

interface Manifest {
  header?: { min_engine_version?: string | number[] };
  dependencies?: { module_name?: string; version?: string }[];
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function retargetManifests(directory: string, target: ResolvedTarget): void {
  if (!existsSync(directory)) { return; }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      retargetManifests(file, target);
    } else if (entry.isFile() && /^manifest(?:\.[\w-]+)?\.json$/.test(entry.name)) {
      const manifest = readJson<Manifest>(file);

      if (manifest.header?.min_engine_version) {
        manifest.header.min_engine_version = Array.isArray(manifest.header.min_engine_version)
          ? target.engineVersion.split('.').map(Number)
          : target.engineVersion;
      }

      for (const dependency of manifest.dependencies ?? []) {
        const version = dependency.module_name && target.packages[dependency.module_name];

        if (version) { dependency.version = manifestVersion(version); }
      }

      writeJson(file, manifest);
    }
  }
}

export function prepareProject(root: string, target: Target, fixtures: readonly string[] = []): void {
  if (target.apiChannel === 'locked') { return; }

  const manifest = path.join(root, 'package.json');
  const pkg = readJson<{ resolutions?: Record<string, string> }>(manifest);

  pkg.resolutions = { ...pkg.resolutions, ...target.packages };
  writeJson(manifest, pkg);

  for (const fixture of fixtures) {
    const fixtureRoot = path.join(root, fixture);
    const configPath = path.join(fixtureRoot, 'config.json');

    if (existsSync(configPath)) {
      const config = readJson<{ targetVersion?: string }>(configPath);

      config.targetVersion = target.engineVersion;
      writeJson(configPath, config);
    }

    retargetManifests(path.join(fixtureRoot, 'packs'), target);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = JSON.parse(process.env.COMPATIBILITY_ROW ?? 'null') as Target | null;

  assert(target?.id, 'COMPATIBILITY_ROW must contain the resolved matrix row');

  const fixtures = (process.env.COMPATIBILITY_FIXTURES ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  prepareProject(process.cwd(), target, fixtures);
}
