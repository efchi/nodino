// Release-time build for @efchi/nodino. Run by `npm run build`, and by
// `npm publish` itself through prepublishOnly.
//
// nodino.js, nodino.d.ts and nodino.css stay the only hand-edited sources; this script
// derives the rest of the npm package from them and never touches them:
//
//   nodino.mjs       ESM twin of nodino.js — same code, export statements
//                    instead of the module.exports/window.Nodino tail
//   nodino.d.mts     ESM twin of nodino.d.ts
//   nodino.min.js    minified nodino.js (script tag / CDN / require)
//   nodino.min.mjs   minified nodino.mjs (native ESM from a CDN)
//   nodino.min.css   minified nodino.css
//
// Nothing here is needed to *use* Nodino: the outputs ship pre-built in the
// tarball, so a host still loads plain static files (CLAUDE.md, invariant 5).
// Every rewrite below asserts the exact text it expects and stops the build
// if it is not there, rather than shipping a silently half-converted file.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { minify } from 'terser';
import { transform as transformCss } from 'lightningcss';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, name), 'utf8');
const write = (name, text) => {
  writeFileSync(join(root, name), text);
  console.log('  wrote ' + name + ' (' + (Buffer.byteLength(text) / 1024).toFixed(1) + ' kB)');
};
const fail = (message) => {
  console.error('build: ' + message);
  process.exit(1);
};

// --- Version: package.json is the source, the banner constant must agree.
const version = JSON.parse(read('package.json')).version;
const js = read('nodino.js');
const versionMatch = js.match(/var VERSION = '([^']+)';/);
if (!versionMatch) fail('VERSION constant not found in nodino.js');
if (versionMatch[1] !== version) {
  fail('nodino.js VERSION is ' + versionMatch[1] + ' but package.json says ' + version + ' — bump both');
}

const GENERATED = '// Generated from {src} by scripts/build.mjs — do not edit.\n';

// --- nodino.mjs: the IIFE returns its API instead of exporting it, and the
// module exports what it returned. The comment block explaining the
// either/or tail goes with it, since this file has neither branch.
const TAIL_START = '  // Two ways out, chosen by what the host is';
const TAIL_END = '\n})(typeof window !== \'undefined\' ? window : globalThis);';
const IIFE_START = '\n(function (global) {\n';
const tailFrom = js.indexOf(TAIL_START);
const tailTo = js.indexOf(TAIL_END);
if (tailFrom < 0 || tailTo < 0 || tailTo < tailFrom) fail('export tail not found in nodino.js');
const tail = js.slice(tailFrom, tailTo);
if (!tail.includes('module.exports = { create: create, themes: publicThemes(), defaults: publicDefaults() };') ||
    !tail.includes('global.Nodino = { create: create, themes: publicThemes(), defaults: publicDefaults() };')) {
  fail('export tail in nodino.js no longer has the expected shape');
}
if (js.split(IIFE_START).length !== 2) fail('IIFE opening not found exactly once in nodino.js');

const mjs = GENERATED.replace('{src}', 'nodino.js') +
  js.slice(0, tailFrom).replace(IIFE_START, '\nvar Nodino = (function (global) {\n') +
  '  return { create: create, themes: publicThemes(), defaults: publicDefaults() };' +
  js.slice(tailTo) +
  '\n\nexport var create = Nodino.create;\nexport var themes = Nodino.themes;\nexport var defaults = Nodino.defaults;\nexport default Nodino;\n';

// --- nodino.d.mts: the namespace body, de-indented, plus a default export.
const dts = read('nodino.d.ts');
const BODY = /\n  \/\/ BODY:BEGIN\n([\s\S]*?)\n  \/\/ BODY:END\n/;
const bodyMatch = dts.match(BODY);
if (!bodyMatch) fail('BODY markers not found in nodino.d.ts');
const body = bodyMatch[1].split('\n').map((line) => line.replace(/^ {2}/, '')).join('\n');
const dmts = GENERATED.replace('{src}', 'nodino.d.ts') + '\n' + body +
  '\n\ndeclare const Nodino: { create: typeof create; themes: typeof themes; defaults: typeof defaults };\nexport default Nodino;\n';

// --- Minified builds. Terser's defaults only: no unsafe/unsafe_math, which
// may reorder floating-point arithmetic — the layout's determinism ([D
// Determinism]) would then hold within one file but differ between the
// minified and readable builds.
const preamble = '/*! Nodino v' + version + ' | MIT License | https://github.com/efchi/nodino */';
async function minified(code, isModule) {
  const result = await minify(code, {
    module: isModule,
    compress: true,
    mangle: true,
    format: { preamble, comments: false }
  });
  return result.code + '\n';
}

// --- nodino.min.css. Explicit `targets`, the oldest browsers the library
// itself runs on (<canvas>, Pointer Events, ResizeObserver — README): left
// without any, Lightning CSS assumes current browsers only and drops
// -webkit-backdrop-filter as redundant, which takes the frosted chrome away
// from every Safari before 18. With Safari in the list it keeps the prefix,
// and anything it rewrites for these targets is an equivalent spelling. The
// check below is what caught that, and stays as the guard.
const CSS_TARGETS = { chrome: 90 << 16, edge: 90 << 16, firefox: 90 << 16, safari: 14 << 16, ios_saf: 14 << 16 };
function minifiedCss(code) {
  const result = transformCss({ filename: 'nodino.css', code: Buffer.from(code), minify: true, targets: CSS_TARGETS });
  const out = Buffer.from(result.code).toString('utf8');
  if (code.includes('-webkit-backdrop-filter') && !out.includes('-webkit-backdrop-filter')) {
    fail('minified CSS lost -webkit-backdrop-filter');
  }
  return preamble + '\n' + out + '\n';
}

console.log('build: @efchi/nodino ' + version);
write('nodino.mjs', mjs);
write('nodino.d.mts', dmts);
write('nodino.min.js', await minified(js, false));
write('nodino.min.mjs', await minified(mjs, true));
write('nodino.min.css', minifiedCss(read('nodino.css')));

// --- Smoke checks: every output parses and exposes create(), without a DOM.
const node = process.execPath;
const check = (args) => execFileSync(node, args, { cwd: root, stdio: 'inherit' });
check(['-e', "for (const f of ['./nodino.js', './nodino.min.js']) if (typeof require(f).create !== 'function') throw new Error(f)"]);
check(['--input-type=module', '-e',
  "for (const f of ['./nodino.mjs', './nodino.min.mjs']) { const m = await import(f);" +
  " if (typeof m.create !== 'function' || m.default.create !== m.create || m.default.themes !== m.themes || m.default.defaults !== m.defaults) throw new Error(f); }"]);
console.log('build: ok');
