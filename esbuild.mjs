import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');

/**
 * Build-time tools. Each one imports the pure core so the artefact it produces cannot
 * describe a state the code is not in; each is bundled to `.build/<name>.mjs` and run
 * by an npm script (see package.json) or by a workflow.
 */
const TOOLS = {
  docs: 'scripts/gen-docs.ts',
  roadmap: 'scripts/gen-roadmap.ts',
  sync: 'scripts/backlog-sync.ts',
  icon: 'scripts/make-icon.ts',
  site: 'scripts/build-site.ts',
};
const tool = Object.keys(TOOLS).find((name) => process.argv.includes(`--${name}`));

/** The CommonJS globals the ESM bundles need back: require() and __dirname. */
const nodeBanner = [
  "import { createRequire } from 'module';",
  "import { dirname } from 'path';",
  "import { fileURLToPath } from 'url';",
  'const require = createRequire(import.meta.url);',
  'const __dirname = dirname(fileURLToPath(import.meta.url));',
].join('\n');

/** @type {esbuild.BuildOptions} */
const base = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

if (test) {
  // The test bundle is ESM so it can be run directly with node; the banner restores
  // the CommonJS globals the test source uses — require() for node builtins and
  // __dirname to find the fixtures, which ESM does not define.
  await esbuild.build({
    ...base,
    entryPoints: ['test/run.ts'],
    outfile: '.test/run.mjs',
    format: 'esm',
    banner: { js: nodeBanner },
    // src/extension.ts imports 'vscode', which only exists inside an extension host.
    // Aliasing it to a fake is what lets the glue be tested at all: the alternative is
    // @vscode/test-electron, which downloads a copy of VS Code — a network dependency
    // in a suite that is offline by rule.
    alias: { vscode: './test/vscode-stub.ts' },
  });
} else if (tool) {
  // The generators import from the same source the extension ships (the rule catalogue,
  // the backlog parser), so a reference cannot describe rules that do not exist and the
  // sync cannot mirror a backlog format the tests do not cover.
  const entry = TOOLS[tool];
  await esbuild.build({
    ...base,
    entryPoints: [entry],
    outfile: `.build/${entry.replace(/^scripts\//, '').replace(/\.ts$/, '')}.mjs`,
    format: 'esm',
    banner: { js: nodeBanner },
  });
} else {
  const ctx = await esbuild.context({
    ...base,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: !watch,
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
