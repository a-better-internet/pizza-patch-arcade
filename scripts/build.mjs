// Builds dist/patch-arcade.html: one self-contained file (CSS, UI and the
// AudioWorklet engine inlined). Open it straight from disk or host it anywhere.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.join(root, p);

async function bundle(entry) {
  const out = await build({
    entryPoints: [rel(entry)],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    target: ['es2020'],
    legalComments: 'none',
    define: { 'import.meta.url': 'undefined' },
    logLevel: 'warning',
  });
  return out.outputFiles[0].text;
}

const worklet = await bundle('src/dsp/worklet.js');
const app = await bundle('src/main.js');
const css = fs.readFileSync(rel('src/ui/styles.css'), 'utf8');
let html = fs.readFileSync(rel('index.html'), 'utf8');

const safe = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const cssTag = '<link rel="stylesheet" href="src/ui/styles.css" />';
const jsTag = '<script type="module" src="src/main.js"></script>';
if (!html.includes(cssTag) || !html.includes(jsTag)) throw new Error('index.html markers not found');
html = html.replace(cssTag, () => `<style>\n${css}\n</style>`);
html = html.replace(jsTag, () => `<script>globalThis.__PA_WORKLET_SOURCE__ = ${safe(JSON.stringify(worklet))};</script>\n<script>${safe(app)}</script>`);
html = html.replace('<!--PA:INLINE-->', '<!-- Patch Arcade single-file build. Source: https://github.com/a-better-internet/pizza-patch-arcade -->');

fs.mkdirSync(rel('dist'), { recursive: true });
fs.writeFileSync(rel('dist/patch-arcade.html'), html);
console.log(`dist/patch-arcade.html  ${(html.length / 1024).toFixed(1)} KB  (worklet ${(worklet.length / 1024).toFixed(1)} KB, app ${(app.length / 1024).toFixed(1)} KB)`);
