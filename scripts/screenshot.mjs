/**
 * Visual smoke test: boots the Vite dev server, opens the demo in headless Chromium
 * (software WebGL), moves the pointer around to trigger cursor bending + flowers, and
 * saves screenshots to ./screenshots. Usage: node scripts/screenshot.mjs [?query] [outName]
 */
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

// Usage: node scripts/screenshot.mjs "?count=20000" name        -> dev server + index.html
//        node scripts/screenshot.mjs "dist:?debug" name          -> static server + demo/embed.html (production bundle)
const arg = process.argv[2] || '';
const name = process.argv[3] || 'field';
const useDist = arg.startsWith('dist:');
const query = useDist ? arg.slice(5) : arg;
const port = 5199 + Number(process.env.PORT_OFFSET || 0);
mkdirSync('screenshots', { recursive: true });

let server, staticProc, url;
if (useDist) {
  staticProc = spawn('npx', ['vite', 'preview', '--outDir', '.', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  url = `http://127.0.0.1:${port}/demo/embed.html${query}`;
} else {
  server = await createServer({ server: { port, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  url = `http://127.0.0.1:${port}/${query}`;
}

const exe = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: Number(process.env.DPR || 1) });
page.setDefaultTimeout(180000); // software GL is slow
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__field && window.__field.ready, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `screenshots/${name}-idle.png` });

// Sweep the pointer across the field, then dwell to bloom flowers.
const pts = [[300, 500], [500, 470], [700, 450], [900, 480], [980, 520]];
await page.mouse.move(pts[0][0], pts[0][1]);
for (const [x, y] of pts) { await page.mouse.move(x, y, { steps: 12 }); await page.waitForTimeout(350); }
await page.waitForTimeout(700);
await page.screenshot({ path: `screenshots/${name}-hover.png` });
await page.mouse.move(640, 430, { steps: 10 });
await page.waitForTimeout(1200);
await page.screenshot({ path: `screenshots/${name}-bloom.png` });
await page.mouse.move(1270, 10, { steps: 10 });
await page.mouse.move(1279, 719);
await page.waitForTimeout(2600);
await page.screenshot({ path: `screenshots/${name}-wilt.png` });

const stats = await page.evaluate(() => {
  const f = window.__field;
  return { blades: f.bladeCount, flowers: f.flowerPool.liveCount, post: !!f.post, lowPower: !!f.lowPower, env: !!f.scene.environment, drawCalls: f.renderer.info.render.calls, tris: f.renderer.info.render.triangles };
});
console.log(JSON.stringify(stats));
const interesting = logs.filter((l) => !/vite|hmr|\[debug\]|useProgram|Feedback loop|too many errors/i.test(l));
for (const l of interesting.slice(0, 6)) console.log(l.slice(0, 4000));
console.log(`(${logs.length} console lines total)`);
await browser.close();
await server?.close();
staticProc?.kill();
