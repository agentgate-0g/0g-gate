// Renders the AgentGate demo video frame-by-frame with headless Chrome + CDP.
// No X server, no screen capture — deterministic, and it never touches the real desktop.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const FPS  = Number(process.env.FPS || 30);
const OUT  = process.env.OUT || 'frames';
const DASH = process.env.DASH_URL;
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SKIP_SHOTS = process.env.SKIP_SHOTS === '1';
const PORT = 9333;
if (!DASH) throw new Error('DASH_URL required');

const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--window-size=1920,1080',
  '--font-render-hinting=none', '--disable-features=IsolateOrigins,site-per-process',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/agchrome-render', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++msgId; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
      const p = list.find(t => t.type === 'page');
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error('chrome CDP never came up');
}

ws = new WebSocket(await wsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
await send('Page.enable'); await send('Runtime.enable');

const evalv = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('page JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// ── pre-pass: full-page stills of the LIVE dashboard ────────────────────────
const data = JSON.parse(readFileSync('data.json', 'utf8'));
const SHOT_W = 1728;
mkdirSync('shots', { recursive: true });

async function fullPageShot(path, file) {
  await send('Emulation.setDeviceMetricsOverride', { width: SHOT_W, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: DASH + path });
  await sleep(6000);                                        // let the 0G reads land + fonts settle
  const h = Math.ceil(await evalv('document.documentElement.scrollHeight'));
  const capH = Math.min(h, 4200);
  await send('Emulation.setDeviceMetricsOverride', { width: SHOT_W, height: capH, deviceScaleFactor: 1, mobile: false });
  await sleep(2500);
  const { data: b64 } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`shots/${file}`, Buffer.from(b64, 'base64'));
  console.log(`  shot ${path} → shots/${file} (${SHOT_W}x${capH})`);
  return capH;
}

if (!SKIP_SHOTS) {
  console.log('capturing live dashboard stills…');
  data.hLanding  = await fullPageShot('/', 'landing.png');
  data.hActivity = await fullPageShot('/activity', 'activity.png');
  writeFileSync('shot-heights.json', JSON.stringify({ hLanding: data.hLanding, hActivity: data.hActivity }));
} else {
  Object.assign(data, JSON.parse(readFileSync('shot-heights.json', 'utf8')));
}

// ── build the render page with data injected ────────────────────────────────
data.dashUrl = DASH;
writeFileSync('render.built.html', readFileSync('render.html', 'utf8')
  .replace('<script>\nconst D = window.__DATA__',
           `<script>window.__DATA__=${JSON.stringify(data)};</script>\n<script>\nconst D = window.__DATA__`));

await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + process.cwd() + '/render.built.html' });
await sleep(2000);

const SCENES = JSON.parse(await evalv('JSON.stringify(window.__SCENES)'));
console.log('scenes:', SCENES.map(s => `${s.id}:${s.dur}s`).join(' '));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let n = 0; const t0 = Date.now(); const manifest = [];
for (let i = 0; i < SCENES.length; i++) {
  const s = SCENES[i];
  if (ONLY && !ONLY.includes(s.id)) continue;
  const frames = Math.round(s.dur * FPS), startFrame = n;
  await evalv(`window.__render(${i}, 0)`);
  await sleep(700);                                          // decode the still / settle layout
  for (let f = 0; f < frames; f++) {
    const t = frames === 1 ? 0 : f / (frames - 1);
    await evalv(`window.__render(${i}, ${t})`);
    const { data: b64 } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    writeFileSync(`${OUT}/${String(n).padStart(6, '0')}.png`, Buffer.from(b64, 'base64'));
    n++;
    if (n % 300 === 0) {
      const el = (Date.now() - t0) / 1000;
      console.log(`  ${n} frames · ${el.toFixed(0)}s · ${(n / el).toFixed(1)} fps · eta ${(((SCENES.reduce((a, x) => a + x.dur, 0) * FPS) - n) / (n / el) / 60).toFixed(1)}m`);
    }
  }
  manifest.push({ id: s.id, dur: s.dur, startFrame, frames });
  console.log(`✓ ${s.id} — ${frames} frames (${s.dur}s)`);
}

writeFileSync('manifest.json', JSON.stringify({ fps: FPS, total: n, scenes: manifest }, null, 2));
console.log(`\ndone: ${n} frames @ ${FPS}fps = ${(n / FPS).toFixed(1)}s in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
ws.close(); chrome.kill(); process.exit(0);
