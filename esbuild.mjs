import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const test = process.argv.includes('--test');
const docs = process.argv.includes('--docs');

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
  });
} else if (docs) {
  // The documentation generator imports the rule catalogue from the same source the
  // extension ships, so the reference cannot describe rules that do not exist.
  await esbuild.build({
    ...base,
    entryPoints: ['scripts/gen-docs.ts'],
    outfile: '.build/gen-docs.mjs',
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
