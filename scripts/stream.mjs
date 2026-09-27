import { webkit } from 'playwright-core';
const b = await webkit.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });
await p.goto('http://127.0.0.1:8731/?perf&tires=gpu'); await p.waitForFunction(() => window.__game?.car && window.__perf, null, {timeout: 30000}); await p.waitForTimeout(4000);
const out = [];
for (const [x, z] of [[300, 0], [600, 200], [900, 400]]) {
  await p.evaluate(([x, z]) => { window.__perf.reset(); window.__game.respawnAt(x, z, 0); }, [x, z]);
  await p.waitForTimeout(6000);
  const s = await p.evaluate(() => window.__perf.summary().series);
  const f = (k) => s[k] ? `${k} avg ${s[k].avg.toFixed(2)} p95 ${s[k].p95.toFixed(2)} max ${s[k].max.toFixed(1)} n ${s[k].n}` : k + ' -';
  out.push(`teleport ${x},${z}\n  ${f('sys.streamTerrain')}\n  ${f('frame.interval')}\n  ${f('frame.js')}\n  ${f('draw')}\n  ${f('scene.ktris')}\n  ${f('scene.drawCalls')}`);
}
console.log(out.join('\n'));
await b.close();
