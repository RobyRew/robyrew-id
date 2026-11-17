// Astro's type check (what `astro check` runs) on TypeScript 6: TypeScript 7 ships without the JS API Astro's
// checker drives, and @astrojs/check declares typescript ^5 || ^6 as a peer. Exit condition: drop this script and
// the typescript-6 alias once @astrojs/language-server runs on TypeScript 7.
//
// @volar/kit (under @astrojs/language-server) does its own require('typescript') for ts.sys, which resolves to the
// root typescript 7 and fails on `ts.sys` being undefined. The resolve hook points every bare `typescript` request
// in this process at the typescript-6 alias, before the language server loads.
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts6Url = pathToFileURL(require.resolve('typescript-6')).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typescript') return { url: ts6Url, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { AstroCheck } = await import('@astrojs/language-server');
const checker = new AstroCheck(root, require.resolve('typescript-6'), undefined);
const result = await checker.lint({ logErrors: { level: 'hint' } });
console.info(`Result (${result.fileChecked} files, TypeScript ${checker.ts.version}): ${result.errors} errors, ${result.warnings} warnings, ${result.hints} hints`);
process.exitCode = result.errors > 0 ? 1 : 0;
