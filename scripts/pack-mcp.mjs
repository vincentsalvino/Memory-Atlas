import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const lock = readJson(join(root, 'package-lock.json')).packages;
const { version, dependencies } = readJson(join(root, 'packages/mcp/package.json'));
const visualizerDependencies = readJson(join(root, 'packages/visualizer/package.json')).dependencies ?? {};
const name = '@beanvincentcat/memory-atlas';
const output = resolve(process.argv[2] ?? join(root, '.release'));
const artifactName = name.replace(/^@/, '').replace('/', '-');
const tarball = join(output, `${artifactName}-${version}.tgz`);
if (process.argv.length > 3) throw new Error('Usage: npm run package:mcp -- [output-directory]');
if (!process.env.npm_execpath) throw new Error('Run this script through npm run package:mcp');
if (existsSync(tarball)) throw new Error(`Release already exists: ${tarball}`);

// Find the runtime workspace graph and pin only its external npm dependencies.
// Native modules and platform-specific optional dependencies stay with npm.
const workspaces = new Map();
const external = new Map();
function visit(deps) {
  for (const spec of Object.keys(deps ?? {})) {
    if (workspaces.has(spec) || external.has(spec)) continue;
    const entry = lock[`node_modules/${spec}`];
    if (!entry) throw new Error(`Missing lock entry for ${spec}`);
    if (entry.link && spec.startsWith('@brain/')) {
      const directory = join(root, entry.resolved);
      workspaces.set(spec, join(directory, 'src/index.ts'));
      visit(readJson(join(directory, 'package.json')).dependencies);
    } else {
      if (!entry.version) throw new Error(`Cannot package external dependency ${spec}`);
      external.set(spec, entry.version);
    }
  }
}
visit(dependencies);
// Include only @brain/* workspace dependencies from @brain/visualizer's server runtime;
// browser packages (react, react-dom, d3-force) are pre-bundled into packages/visualizer/dist/ui.
visit(Object.fromEntries(Object.entries(visualizerDependencies).filter(([spec]) => spec.startsWith('@brain/'))));

const visualizerUiDir = join(root, 'packages/visualizer/dist/ui');
if (!existsSync(join(visualizerUiDir, 'index.html'))) {
  const built = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
    cwd: root, encoding: 'utf8',
  });
  if (built.error) throw built.error;
  if (built.status !== 0) throw new Error(built.stderr || built.stdout || 'Failed to build @brain/visualizer UI assets');
}

const tempRoot = realpathSync(tmpdir());
const stage = mkdtempSync(join(tempRoot, 'brainded-pack-'));
try {
  mkdirSync(output, { recursive: true });
  mkdirSync(join(stage, 'dist'));
  mkdirSync(join(stage, 'migrations'));
  const migrations = join(root, 'packages/storage/migrations');
  for (const file of readdirSync(migrations).filter(file => /^\d+_[\w-]+\.sql$/.test(file))) {
    copyFileSync(join(migrations, file), join(stage, 'migrations', file));
  }
  cpSync(visualizerUiDir, join(stage, 'ui'), { recursive: true });
  copyFileSync(join(root, 'scripts/installer-readme.md'), join(stage, 'README.md'));
  writeFileSync(join(stage, 'package.json'), JSON.stringify({
    name, version, description: 'Memory Atlas: shared local memory and context for AI coding agents', type: 'module',
    bin: { 'brain-mcp': './dist/cli.js', 'brain-visualize': './dist/visualize.js' }, engines: { node: '>=24' },
    repository: { type: 'git', url: 'git+https://github.com/vincentsalvino/Memory-Atlas.git' },
    homepage: 'https://github.com/vincentsalvino/Memory-Atlas#readme',
    bugs: { url: 'https://github.com/vincentsalvino/Memory-Atlas/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/' },
    files: ['dist/*.js', 'ui/**', 'migrations/*.sql', 'npm-shrinkwrap.json'],
    dependencies: Object.fromEntries([...external].sort(([a], [b]) => a.localeCompare(b))),
    overrides: readJson(join(root, 'package.json')).overrides,
  }, null, 2) + '\n');

  // Pin the complete production graph without executing dependency install scripts.
  const locked = spawnSync(process.execPath, [process.env.npm_execpath, 'install', '--package-lock-only', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: stage, encoding: 'utf8',
  });
  if (locked.error) throw locked.error;
  if (locked.status !== 0) throw new Error(locked.stderr || 'Dependency lock generation failed');
  const releaseLock = readJson(join(stage, 'package-lock.json'));
  // npm's global installer otherwise invents a node-gyp build for prebuilt SQLite.
  for (const [dependency, pinnedVersion] of external) {
    const manifest = readJson(join(root, 'node_modules', dependency, 'package.json'));
    if (manifest.version !== pinnedVersion) throw new Error(`Installed dependency differs from lock: ${dependency}`);
    if (manifest.gypfile === false) releaseLock.packages[`node_modules/${dependency}`].gypfile = false;
  }
  writeFileSync(join(stage, 'npm-shrinkwrap.json'), JSON.stringify(releaseLock, null, 2) + '\n');
  const audited = spawnSync(process.execPath, [process.env.npm_execpath, 'audit', '--omit=dev', '--audit-level=high', '--json'], {
    cwd: stage, encoding: 'utf8',
  });
  if (audited.error) throw audited.error;
  const audit = JSON.parse(audited.stdout || '{}');
  if (audited.status !== 0 || !audit.metadata?.vulnerabilities) throw new Error('Release dependency audit failed; inspect advisories before packaging');
  writeFileSync(join(output, `${artifactName}-${version}.audit.json`), JSON.stringify({
    package: name, version, checkedAt: new Date().toISOString(), scope: 'production dependency graph',
    vulnerabilities: audit.metadata.vulnerabilities,
    limitation: 'Advisory snapshot, not proof of absence of vulnerabilities; dependency install scripts may run during npm installation.',
  }, null, 2) + '\n');

  const workspacePlugin = {
    name: 'workspace-source',
    setup(builder) {
      builder.onResolve({ filter: /^@brain\// }, ({ path }) => {
        const entry = workspaces.get(path);
        if (!entry) throw new Error(`Undeclared workspace import ${path}`);
        return { path: entry };
      });
    },
  };

  const commonBuild = {
    bundle: true, platform: 'node', target: 'node24', format: 'esm', minify: true,
    external: [...external.keys()],
    plugins: [workspacePlugin],
  };

  await Promise.all([
    build({
      ...commonBuild,
      entryPoints: [join(root, 'packages/mcp/src/cli.ts')],
      outfile: join(stage, 'dist/cli.js'),
    }),
    build({
      ...commonBuild,
      entryPoints: [join(root, 'packages/mcp/src/visualize-bin.ts')],
      outfile: join(stage, 'dist/visualize.js'),
    }),
    build({
      ...commonBuild,
      entryPoints: [join(root, 'packages/visualizer/src/server/server.ts')],
      outfile: join(stage, 'dist/visualizer-server.js'),
    }),
  ]);

  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--pack-destination', output], {
    cwd: stage, encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'npm pack failed');
  const [pack] = JSON.parse(result.stdout);
  console.log(JSON.stringify({ tarball, bytes: pack.size, files: pack.files.map(file => file.path) }, null, 2));
} finally {
  const relativeStage = relative(tempRoot, realpathSync(stage));
  if (!isAbsolute(relativeStage) && /^brainded-pack-[^/\\]+$/.test(relativeStage)) {
    rmSync(stage, { recursive: true, force: true });
  }
}
