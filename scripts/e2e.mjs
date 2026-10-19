// End-to-end check in a real browser (Chromium via Playwright).
//   npm run build && npm run test:e2e
// Loads the single-file build with no input at all, strikes it, rolls dice and
// analyses the live AudioWorklet output with an AnalyserNode: one impulse must
// be enough to keep the loops alive, the output must stay below the -1 dBFS
// ceiling and keep the top octave quiet, and Panic / Life 0 must fall silent.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'test-output');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      const req = createRequire(import.meta.url);
      const globalRoot = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules');
      return req(path.join(globalRoot, 'playwright'));
    } catch {
      return null;
    }
  }
}

const pw = await loadPlaywright();
if (!pw) {
  console.log('Playwright not installed: skipping browser test (npm i -D playwright to enable).');
  process.exit(0);
}
const file = path.join(root, 'dist', 'patch-arcade.html');
if (!fs.existsSync(file)) {
  console.error('dist/patch-arcade.html missing: run `npm run build` first.');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));

await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
const strip = await page.evaluate(() => {
  const s = document.querySelector('.strip');
  return { fits: s.scrollWidth <= s.clientWidth + 1, strike: !!document.querySelector('.strike'), knobs: document.querySelectorAll('.strip .gknob').length };
});
// Strike starts audio by itself, then sends the one impulse
await page.click('.strike');
await page.waitForFunction(() => window.patchArcade.audio.running, null, { timeout: 10000 });

// tap the output with an analyser
await page.evaluate(() => {
  const { audio } = window.patchArcade;
  const an = audio.ctx.createAnalyser();
  an.fftSize = 8192;
  an.smoothingTimeConstant = 0;
  audio.node.connect(an);
  window.__an = an;
});

async function measure(seconds) {
  return page.evaluate(async (secs) => {
    const an = window.__an;
    const sr = an.context.sampleRate;
    const time = new Float32Array(an.fftSize);
    const freq = new Float32Array(an.frequencyBinCount);
    let peak = 0, sum = 0, n = 0, hi = 0, all = 0;
    const end = performance.now() + secs * 1000;
    while (performance.now() < end) {
      an.getFloatTimeDomainData(time);
      for (const v of time) {
        peak = Math.max(peak, Math.abs(v));
        sum += v * v;
        n++;
      }
      an.getFloatFrequencyData(freq);
      freq.forEach((db, k) => {
        const p = Math.pow(10, db / 10);
        all += p;
        if ((k * sr) / an.fftSize >= 12000) hi += p;
      });
      await new Promise((r) => setTimeout(r, 90));
    }
    return { peak, rmsDb: 10 * Math.log10(sum / n + 1e-30), hf12Db: 10 * Math.log10((hi + 1e-30) / (all + 1e-30)) };
  }, seconds);
}

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
};

check('device strip fits: Strike and six condition/global knobs', strip.fits && strip.strike && strip.knobs === 6, JSON.stringify(strip));
const sources = await page.evaluate(() => [0, 1, 2].map((i) => document.querySelector(`#src${i}`).value));
check('every input defaults to Impulse only', sources.every((s) => s === 'impulse'), sources.join(','));

await page.waitForTimeout(1500);
let m = await measure(3);
check('one Strike makes sound with no input', m.rmsDb > -50, `rms ${m.rmsDb.toFixed(1)} dBFS`);
check('first patch under ceiling', m.peak <= 0.892, `peak ${m.peak.toFixed(3)}`);
await page.waitForTimeout(15000);
m = await measure(3);
check('still alive 20 s later on that one impulse', m.rmsDb > -50, `rms ${m.rmsDb.toFixed(1)} dBFS`);
check('the living loop keeps the top end calm', m.hf12Db < -24, `>12 kHz ${m.hf12Db.toFixed(1)} dB`);

await page.click('#panic');
await page.waitForTimeout(1500);
m = await measure(2);
check('Panic silences the loops', m.rmsDb < -90, `rms ${m.rmsDb.toFixed(1)} dBFS`);
await page.click('.strike');
await page.waitForTimeout(4000);
m = await measure(2);
check('a new Strike brings them back', m.rmsDb > -50, `rms ${m.rmsDb.toFixed(1)} dBFS`);

for (const h of [1, 2, 3]) await page.click(`.die${h}`);
await page.waitForTimeout(8000);
m = await measure(5);
check('three no-input dice routes are alive', m.rmsDb > -50, `rms ${m.rmsDb.toFixed(1)} dBFS`);
check('three dice routes under ceiling', m.peak <= 0.892, `peak ${m.peak.toFixed(3)}`);
check('three dice routes keep the top end calm', m.hf12Db < -24, `>12 kHz ${m.hf12Db.toFixed(1)} dB`);

// Life 0: nothing holds the loops any more, so the rack must fall completely
// silent (no hiss, no self-sustaining loop)
await page.evaluate(() => window.patchArcade.model.setGlobal('life', 0));
await page.waitForTimeout(18000);
m = await measure(2);
check('silent 18 s after Life goes to 0', m.rmsDb < -90, `rms ${m.rmsDb.toFixed(1)} dBFS`);

await page.screenshot({ path: path.join(outDir, 'rack.png'), fullPage: true });
check('no console errors', problems.length === 0, problems.join(' | '));
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(failed.length ? `\n${failed.length} check(s) failed` : '\nall browser checks passed');
process.exit(failed.length ? 1 : 0);
