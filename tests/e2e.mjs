// End-to-end: 3 tabs play a full game (3 rounds). Uses tests/fake-peer.js (offline).
// Serve on :5175 first, then `node tests/e2e.mjs`.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:5175/';
const SHOTS = process.env.SHOTS || 'test-shots';
mkdirSync(SHOTS, { recursive: true });
const fake = readFileSync(new URL('./fake-peer.js', import.meta.url), 'utf8');
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await ctx.addInitScript(fake);
await ctx.route(/unpkg\.com|jsdelivr\.net|fonts\.g/, (r) => r.abort());
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (n) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  p.on('dialog', (d) => d.accept());
  return p;
};
const phase = (p) => p.evaluate(() => document.getElementById('app').dataset.phase || 'home');
const shot = (p, n) => p.screenshot({ path: `${SHOTS}/${n}.png`, fullPage: true });
const host = await open('host');
await host.goto(BASE);
await shot(host, '01-home');
await host.fill('#name', 'Edwin');
await host.click('[data-intent="create"]');
await host.waitForSelector('.plate-code');
const code = (await host.textContent('.plate-code')).trim();
const pages = [host];
for (const n of ['Amina', 'Kofi']) {
  const p = await open(n);
  await p.goto(`${BASE}?join=${code}`);
  await p.fill('#name', n);
  await p.click('[data-intent="join"]');
  await p.waitForSelector('.plate-code');
  pages.push(p);
}
await shot(host, '02-lobby');
await host.click('[data-act="start"]');
const seen = new Set();
const t0 = Date.now();
let caughtOnce = false;
while (Date.now() - t0 < 200000) {
  const ph = await phase(host);
  if (ph === 'final') break;
  // fast-forward timers on the host to keep the test short
  if (['reveal', 'result'].includes(ph)) await host.evaluate(() => { window.__rmHost.state.phaseEndsAt = Date.now(); });
  for (const [i, p] of pages.entries()) {
    const pp = await phase(p);
    const k = pp + i + ':' + (await p.evaluate(() => document.querySelector('.tb-round')?.textContent));
    if (!seen.has(k) && ['whisper', 'reveal', 'debate', 'vote', 'guess', 'result'].includes(pp)) {
      seen.add(k);
      if (k.includes('Round 1')) await shot(p, `10-${pp}-p${i}`);
    }
    try {
      if (pp === 'whisper' && (await p.$('#whisperForm'))) {
        await p.click('[data-pick] >> nth=0');
        await p.fill('#whisperText', ['you can find it near water', 'it makes people happy', 'kids love this one'][i]);
        await p.click('#whisperForm [type=submit]');
      } else if (pp === 'debate' && (await p.$('[data-act="ready"]:not([disabled])'))) await p.click('[data-act="ready"]');
      else if (pp === 'vote' && (await p.$('[data-act="vote"]'))) {
        const g = await host.evaluate(() => window.__rmHost.state.gossipId);
        const me = await p.evaluate(() => JSON.parse(sessionStorage.getItem('rm-session')).id);
        const target = me !== g ? g : null;
        if (target) await p.click(`[data-act="vote"][data-id="${target}"]`);
        else await p.click('[data-act="vote"] >> nth=0');
      } else if (pp === 'guess' && (await p.$('[data-act="guess"]'))) {
        caughtOnce = true;
        await p.click('[data-act="guess"] >> nth=0');
      }
    } catch { /* re-rendered mid-click */ }
  }
  await sleep(300);
}
console.log('final:', await Promise.all(pages.map(phase)), 'gossip caught + guessed at least once:', caughtOnce);
await sleep(1200);
await shot(host, '30-final');
await host.setViewportSize({ width: 1280, height: 900 });
await host.click('[data-act="playAgain"]');
await sleep(400);
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
