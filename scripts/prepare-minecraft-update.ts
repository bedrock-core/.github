import assert from 'node:assert/strict';
import { globSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { stableLines, type createMatrix } from './resolve-minecraft-compatibility.ts';

type Matrix = ReturnType<typeof createMatrix>;

const vanillaDataPackage = '@minecraft/vanilla-data';

interface PackageManifest {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  resolutions?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function minecraftPeerRange(current: string, versions: readonly string[]): string {
  const stable: string[] = [];
  for (const version of versions.filter(version => !semver.prerelease(version)).sort(semver.compare)) {
    if (!stable.some(range => semver.satisfies(version, range))) { stable.push(`~${version}`); }
  }

  if (!stable.length) { return current; }

  const previousPreview = current.split('||').map(clause => clause.trim())
    .filter(version => /-(rc|beta)\.\d+\.\d+\.\d+-preview\.\d+$/.test(version) && semver.valid(version))
    .sort(semver.rcompare);
  const preview = ['rc', 'beta'].flatMap(track => {
    const matchesTrack = (version: string): boolean => semver.prerelease(version)?.[0] === track;
    const version = versions.find(matchesTrack) ?? previousPreview.find(matchesTrack);

    return version ? [version] : [];
  }).sort(semver.compare);
  const range = [...stable, ...preview].join(' || ');

  assert(versions.every(version => semver.satisfies(version, range)), `Peer range ${range} does not cover ${versions.join(', ')}`);

  return range;
}

function vanillaDataPeerRange(current: string, versions: readonly string[]): string {
  const tracks = new Set(versions.map(version => semver.prerelease(version)?.[0]));
  const retained = current.split('||').map(version => version.trim())
    .filter(version => semver.valid(version) && !tracks.has(semver.prerelease(version)?.[0]));

  return [...new Set([...versions, ...retained])].sort(semver.compare).join(' || ');
}

export function prepareMinecraftUpdate(root: string, matrix: Matrix): void {
  const rootManifest = path.join(root, 'package.json');
  const project = JSON.parse(readFileSync(rootManifest, 'utf8')) as PackageManifest;
  const targets = matrix.include.filter(row => 'packages' in row)
    .sort((a, b) => b.gameVersion.localeCompare(a.gameVersion, 'en', { numeric: true }));
  const stableTargets = targets
    .filter(row => row.gameChannel === 'stable' && row.apiChannel === 'stable')
    .slice(0, stableLines);
  const stable = stableTargets[0];
  const previewTargets = ['rc', 'beta'].flatMap(channel => {
    const target = targets.find(row => row.gameChannel === 'preview' && row.apiChannel === channel);

    return target ? [target] : [];
  });
  const sdkTargets = [...stableTargets, ...previewTargets];
  const files = new Set([
    'package.json',
    ...globSync((project.workspaces ?? []).map(workspace => path.join(workspace, 'package.json')), { cwd: root }),
  ]);

  for (const file of files) {
    const manifest = path.join(root, file);
    const source = readFileSync(manifest, 'utf8');
    const pkg = JSON.parse(source) as PackageManifest;
    let changed = false;

    if (file === 'package.json' && stable && pkg.resolutions) {
      for (const [name, version] of Object.entries(stable.packages)) {
        if (pkg.resolutions[name] && pkg.resolutions[name] !== version) {
          pkg.resolutions[name] = version;
          changed = true;
        }
      }
    }

    if (!pkg.private && pkg.peerDependencies) {
      for (const name of ['@minecraft/server', '@minecraft/server-ui', vanillaDataPackage]) {
        const current = pkg.peerDependencies[name];

        if (!current) { continue; }

        const peerTargets = name === vanillaDataPackage ? targets : sdkTargets;
        const versions = peerTargets.flatMap(row => row.packages[name] ? [row.packages[name]] : []);

        if (!versions.length) { continue; }

        const range = name === vanillaDataPackage
          ? vanillaDataPeerRange(current, versions)
          : minecraftPeerRange(current, versions);

        if (current !== range) {
          pkg.peerDependencies[name] = range;
          changed = true;
        }
      }
    }

    if (changed) {
      const indent = source.match(/^[\t ]+(?=")/m)?.[0] ?? '  ';
      const eol = source.includes('\r\n') ? '\r\n' : '\n';

      writeFileSync(manifest, JSON.stringify(pkg, null, indent).replaceAll('\n', eol) + eol);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = JSON.parse(process.env.COMPATIBILITY_MATRIX ?? 'null') as Matrix | null;

  assert(matrix && Array.isArray(matrix.include), 'COMPATIBILITY_MATRIX must contain the resolved Minecraft matrix');
  prepareMinecraftUpdate(process.cwd(), matrix);
}
