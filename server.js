// TopReview — QR por camarero → valoración → reseña en Google, con dashboard en tiempo real.
process.removeAllListeners('warning');
const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'topreview';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Base de datos ----------
// La base de datos se llamaba cinestar.db: si existe, se renombra para no perder datos.
const DB_FILE = path.join(DATA_DIR, 'topreview.db');
const OLD_DB_FILE = path.join(DATA_DIR, 'cinestar.db');
if (!fs.existsSync(DB_FILE) && fs.existsSync(OLD_DB_FILE)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(OLD_DB_FILE + ext)) fs.renameSync(OLD_DB_FILE + ext, DB_FILE + ext);
}
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS waiters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    token TEXT UNIQUE NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waiter_id INTEGER NOT NULL REFERENCES waiters(id),
    type TEXT NOT NULL,            -- scan | rating | google_click
    stars INTEGER,
    comment TEXT,
    visitor TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_w ON events(waiter_id, type, created_at);
`);

const DEFAULT_SETTINGS = {
  business_name: process.env.BUSINESS_NAME || 'Mi Restaurante',
  google_review_url: process.env.GOOGLE_REVIEW_URL || '',
  bonus_5: '2', bonus_4: '1', bonus_3: '0', bonus_2: '0', bonus_1: '0',
  redirect_min_stars: '4',
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(k, v);
}
const getSettings = () =>
  Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));

// ---------- Tiempo real (SSE) ----------
const clients = new Set();
function broadcast(event) {
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- Utilidades ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const slugify = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'camarero';
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

function visitorId(req, res) {
  const m = /(?:^|;\s*)ts_v=([a-f0-9]{32})/.exec(req.headers.cookie || '');
  if (m) return m[1];
  const id = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `ts_v=${id}; Path=/; Max-Age=31536000; SameSite=Lax`);
  return id;
}

function addEvent(waiterId, type, extra = {}) {
  const r = db
    .prepare('INSERT INTO events (waiter_id, type, stars, comment, visitor) VALUES (?, ?, ?, ?, ?)')
    .run(waiterId, type, extra.stars ?? null, extra.comment ?? null, extra.visitor ?? null);
  const w = db.prepare('SELECT name FROM waiters WHERE id = ?').get(waiterId);
  broadcast({ id: Number(r.lastInsertRowid), waiter_id: waiterId, waiter: w?.name, type, stars: extra.stars ?? null, created_at: new Date().toISOString() });
  return Number(r.lastInsertRowid);
}

function requireAdmin(req, res, next) {
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, ...p] = Buffer.from(encoded, 'base64').toString().split(':');
    if (u === ADMIN_USER && p.join(':') === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="TopReview"').status(401).send('Acceso restringido');
}

// Estadísticas por camarero en un rango de fechas (UTC, formato SQLite)
function computeStats(from, to) {
  const s = getSettings();
  const bonus = [0, +s.bonus_1 || 0, +s.bonus_2 || 0, +s.bonus_3 || 0, +s.bonus_4 || 0, +s.bonus_5 || 0];
  const rows = db.prepare(`
    SELECT w.id, w.name, w.slug, w.token, w.active,
      SUM(e.type = 'scan') AS scans,
      SUM(e.type = 'rating') AS ratings,
      SUM(e.type = 'google_click') AS google_clicks,
      SUM(e.type = 'rating' AND e.stars = 5) AS s5,
      SUM(e.type = 'rating' AND e.stars = 4) AS s4,
      SUM(e.type = 'rating' AND e.stars = 3) AS s3,
      SUM(e.type = 'rating' AND e.stars = 2) AS s2,
      SUM(e.type = 'rating' AND e.stars = 1) AS s1,
      AVG(CASE WHEN e.type = 'rating' THEN e.stars END) AS avg
    FROM waiters w
    LEFT JOIN events e ON e.waiter_id = w.id AND e.created_at >= ? AND e.created_at < ?
    GROUP BY w.id ORDER BY w.active DESC, w.name`).all(from, to);
  return rows.map((r) => {
    const n = (k) => Number(r[k] || 0);
    const earned = [1, 2, 3, 4, 5].reduce((acc, k) => acc + n('s' + k) * bonus[k], 0);
    return {
      id: r.id, name: r.name, slug: r.slug, token: r.token, active: !!r.active,
      scans: n('scans'), ratings: n('ratings'), google_clicks: n('google_clicks'),
      stars: { 5: n('s5'), 4: n('s4'), 3: n('s3'), 2: n('s2'), 1: n('s1') },
      avg: r.avg ? Math.round(r.avg * 100) / 100 : null,
      bonus: Math.round(earned * 100) / 100,
    };
  });
}

function rangeFromQuery(q) {
  const pad = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  const now = new Date();
  let from;
  switch (q.period) {
    case 'today': from = new Date(now); from.setHours(0, 0, 0, 0); break;
    case 'week': from = new Date(now); from.setDate(now.getDate() - ((now.getDay() + 6) % 7)); from.setHours(0, 0, 0, 0); break;
    case 'all': from = new Date(0); break;
    case 'month': default: from = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  if (q.from) from = new Date(q.from);
  const to = q.to ? new Date(new Date(q.to).getTime() + 86400000) : new Date(now.getTime() + 60000);
  return [pad(from), pad(to)];
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json());

// ---- Página pública del cliente (lo que abre el QR) ----
app.get('/r/:slug', (req, res) => {
  const w = db.prepare('SELECT * FROM waiters WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!w) return res.status(404).send(page('No encontrado', '<p class="center">Este código ya no está activo.</p>'));
  const visitor = visitorId(req, res);
  addEvent(w.id, 'scan', { visitor });
  const s = getSettings();
  res.send(page(`Valora a ${w.name}`, reviewBody(w, s)));
});

app.post('/api/r/:slug/rate', (req, res) => {
  const w = db.prepare('SELECT * FROM waiters WHERE slug = ? AND active = 1').get(req.params.slug);
  const stars = Math.round(Number(req.body?.stars));
  if (!w || !(stars >= 1 && stars <= 5)) return res.status(400).json({ error: 'Datos no válidos' });
  const visitor = visitorId(req, res);
  // Antifraude básico: un voto por dispositivo y camarero cada 12 h (se actualiza en lugar de duplicar)
  const prev = db.prepare(`SELECT id FROM events WHERE waiter_id = ? AND type = 'rating' AND visitor = ?
    AND created_at >= datetime('now', '-12 hours') ORDER BY id DESC LIMIT 1`).get(w.id, visitor);
  let id;
  if (prev) {
    db.prepare('UPDATE events SET stars = ? WHERE id = ?').run(stars, prev.id);
    id = prev.id;
    broadcast({ type: 'refresh' });
  } else {
    id = addEvent(w.id, 'rating', { stars, visitor });
  }
  const s = getSettings();
  res.json({ id, redirect: stars >= Number(s.redirect_min_stars) && !!s.google_review_url });
});

app.post('/api/r/:slug/comment', (req, res) => {
  const visitor = visitorId(req, res);
  const comment = String(req.body?.comment || '').slice(0, 1000).trim();
  const r = db.prepare("UPDATE events SET comment = ? WHERE id = ? AND visitor = ? AND type = 'rating'").run(comment, Number(req.body?.id), visitor);
  if (r.changes) broadcast({ type: 'refresh' });
  res.json({ ok: !!r.changes });
});

// Registra el clic y redirige a Google
app.get('/go/:slug', (req, res) => {
  const w = db.prepare('SELECT * FROM waiters WHERE slug = ?').get(req.params.slug);
  const s = getSettings();
  if (!w || !s.google_review_url) return res.redirect('/');
  addEvent(w.id, 'google_click', { visitor: visitorId(req, res) });
  res.redirect(s.google_review_url);
});

// ---- Panel personal del camarero (enlace secreto) ----
app.get('/me/:token', (req, res) => {
  const w = db.prepare('SELECT * FROM waiters WHERE token = ?').get(req.params.token);
  if (!w) return res.status(404).send(page('No encontrado', '<p class="center">Enlace no válido.</p>'));
  const [from, to] = rangeFromQuery({ period: 'month' });
  const st = computeStats(from, to).find((x) => x.id === w.id);
  const qr = `/qr/${w.slug}.png`;
  res.send(page(`Hola ${w.name}`, `
    <div class="card center">
      <div class="brand">Top<span>Review</span></div>
      <h1>Hola, ${esc(w.name)} 👋</h1>
      <p class="muted">Tu código personal. Enséñalo al cliente al traer la cuenta.</p>
      <img class="qr" src="${qr}" alt="Tu QR">
      <div class="grid3">
        <div><b>${st.avg ?? '–'}</b><small>media ★</small></div>
        <div><b>${st.ratings}</b><small>valoraciones</small></div>
        <div><b>${st.bonus.toFixed(2)} €</b><small>bonus del mes</small></div>
      </div>
      <p class="muted">5★ ${st.stars[5]} · 4★ ${st.stars[4]} · 3★ ${st.stars[3]} · 2★ ${st.stars[2]} · 1★ ${st.stars[1]}</p>
      <p class="small"><a href="/">¿Cómo funciona TopReview?</a></p>
    </div>`));
});

// ---- QR ----
app.get('/qr/:slug.png', async (req, res) => {
  const w = db.prepare('SELECT slug FROM waiters WHERE slug = ?').get(req.params.slug);
  if (!w) return res.sendStatus(404);
  const buf = await QRCode.toBuffer(`${baseUrl(req)}/r/${w.slug}`, { width: 600, margin: 1, color: { dark: '#0b1f3a' } });
  res.type('png').send(buf);
});

// ---- Admin ----
app.use(['/admin', '/api/admin'], requireAdmin);
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/admin/card/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM waiters WHERE id = ?').get(Number(req.params.id));
  if (!w) return res.sendStatus(404);
  const s = getSettings();
  const num = String(w.id).padStart(4, '0');
  const bulbs = '<i></i>'.repeat(11);
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR ${esc(w.name)} · TopReview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@700;900&family=DM+Sans:wght@400;500;700&display=swap">
<style>
  /* Tarjeta de mesa A6 (105 × 148 mm), centrada en un A4 con línea de corte. Misma paleta que la web: crema, blanco, azul Klein y azul navío; amarillo solo en estrellas y bombillas. */
  :root { --cream:#f7f1e3; --navy:#0b1f3a; --klein:#002fa7; --klein-light:#9fb4ee; --star:#f2b705; --muted:#4b5a73; --line:#e3d9c4;
    --display:"Big Shoulders Display", Impact, "Arial Narrow", sans-serif; --body:"DM Sans", system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { margin:0; min-height:100vh; background:var(--cream); font-family:var(--body); color:var(--navy);
    display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; padding:24px 16px; }
  .cut { padding:5mm; border:1px dashed #b9ae95; border-radius:3mm; background:#fff; }
  .card { width:105mm; height:148mm; background:var(--cream); border-radius:4mm; overflow:hidden; display:flex; flex-direction:column; position:relative; }
  .top { background:var(--navy); color:#fff; text-align:center; padding:7mm 6mm 6mm; position:relative; }
  .bulbs { position:absolute; left:5mm; right:5mm; bottom:-1.6mm; display:flex; justify-content:space-between; }
  .bulbs i { width:3.2mm; height:3.2mm; border-radius:50%; background:var(--star); box-shadow:0 0 0 .6mm var(--navy); }
  .brand { font-family:var(--display); font-weight:900; font-size:11mm; line-height:1; letter-spacing:.02em; text-transform:uppercase; }
  .brand span { color:var(--klein-light); }
  .now { margin-top:2.4mm; font-size:2.6mm; letter-spacing:.32em; text-transform:uppercase; color:#c9d3e6; font-weight:700; }
  .body { flex:1; display:flex; flex-direction:column; align-items:center; text-align:center; padding:7mm 7mm 0; }
  .ask { font-family:var(--display); font-weight:700; font-size:6.2mm; line-height:1; text-transform:uppercase; letter-spacing:.02em; }
  .name { font-family:var(--display); font-weight:900; font-size:11mm; line-height:.95; text-transform:uppercase; color:var(--klein); margin-top:1mm; text-wrap:balance; max-width:100%; overflow-wrap:anywhere; }
  .qrbox { margin-top:4.5mm; background:#fff; border:1.2mm solid var(--klein); border-radius:4mm; padding:2.5mm; width:46mm; height:46mm; }
  .qrbox img { width:100%; height:100%; display:block; }
  .stars { margin-top:3.5mm; font-size:7mm; letter-spacing:1.4mm; color:var(--star); line-height:1; }
  .scan { margin-top:2.4mm; font-weight:700; font-size:3.6mm; }
  .fine { margin-top:.8mm; font-size:2.8mm; color:var(--muted); }
  .stub { margin-top:auto; border-top:.5mm dashed #b9ae95; display:flex; justify-content:space-between; align-items:center; padding:3mm 6mm 3.5mm;
    font-family:var(--display); font-weight:700; font-size:3.4mm; letter-spacing:.18em; text-transform:uppercase; color:var(--navy); position:relative; }
  .stub::before, .stub::after { content:""; position:absolute; top:-2.6mm; width:5mm; height:5mm; border-radius:50%; background:#fff; }
  .stub::before { left:-2.5mm; } .stub::after { right:-2.5mm; }
  .stub b { color:var(--klein); }
  .actions { display:flex; flex-direction:column; align-items:center; gap:8px; }
  .btn { border:0; border-radius:12px; padding:14px 28px; font:700 16px var(--body); background:var(--klein); color:#fff; cursor:pointer; }
  .btn:hover { background:#00227a; }
  .tip { font-size:13px; color:var(--muted); max-width:340px; text-align:center; margin:0; }
  @page { size:A4; margin:0; }
  @media print { body { background:#fff; min-height:auto; height:297mm; padding:0; } .actions { display:none; } }
</style></head><body>
  <div class="cut"><div class="card">
    <div class="top">
      <div class="brand">Top<span>Review</span></div>
      <div class="now">Ahora en cartel · ${esc(s.business_name)}</div>
      <div class="bulbs">${bulbs}</div>
    </div>
    <div class="body">
      <div class="ask">¿Te ha atendido bien</div>
      <div class="name">${esc(w.name)}?</div>
      <div class="qrbox"><img src="/qr/${w.slug}.png" alt="QR de ${esc(w.name)}"></div>
      <div class="stars">★★★★★</div>
      <div class="scan">Escanea y valóralo en 10 segundos</div>
      <div class="fine">Sin descargar nada · Solo con la cámara del móvil</div>
    </div>
    <div class="stub"><span>Entrada nº <b>${num}</b></span><span>Valoración de sala</span></div>
  </div></div>
  <div class="actions">
    <button class="btn" onclick="print()">Imprimir tarjeta</button>
    <p class="tip">Tamaño A6, para un portacartas de mesa. En la ventana de impresión elige <b>Color</b> y escala <b>100 %</b>, y recorta por la línea discontinua.</p>
  </div>
</body></html>`);
});

app.get('/api/admin/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/api/admin/stats', (req, res) => {
  const [from, to] = rangeFromQuery(req.query);
  const waiters = computeStats(from, to);
  const feed = db.prepare(`SELECT e.id, e.type, e.stars, e.comment, e.created_at, w.name AS waiter
    FROM events e JOIN waiters w ON w.id = e.waiter_id
    WHERE e.created_at >= ? AND e.created_at < ? AND e.type IN ('rating','google_click')
    ORDER BY e.id DESC LIMIT 40`).all(from, to);
  const daily = db.prepare(`SELECT date(created_at) AS day, COUNT(*) AS n, AVG(stars) AS avg
    FROM events WHERE type = 'rating' AND created_at >= ? AND created_at < ?
    GROUP BY day ORDER BY day`).all(from, to);
  res.json({ from, to, settings: getSettings(), waiters, feed, daily, base: baseUrl(req) });
});

app.post('/api/admin/waiters', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
  let slug = slugify(name), i = 1;
  while (db.prepare('SELECT 1 FROM waiters WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${++i}`;
  const token = crypto.randomBytes(12).toString('hex');
  const r = db.prepare('INSERT INTO waiters (name, slug, token) VALUES (?, ?, ?)').run(name, slug, token);
  broadcast({ type: 'refresh' });
  res.json({ id: Number(r.lastInsertRowid), name, slug, token });
});

app.patch('/api/admin/waiters/:id', (req, res) => {
  const { name, active } = req.body || {};
  if (name !== undefined) db.prepare('UPDATE waiters SET name = ? WHERE id = ?').run(String(name).trim().slice(0, 60), Number(req.params.id));
  if (active !== undefined) db.prepare('UPDATE waiters SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(req.params.id));
  broadcast({ type: 'refresh' });
  res.json({ ok: true });
});

app.put('/api/admin/settings', (req, res) => {
  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (req.body?.[k] !== undefined) stmt.run(String(req.body[k]).trim(), k);
  broadcast({ type: 'refresh' });
  res.json(getSettings());
});

app.get('/api/admin/export.csv', (req, res) => {
  const [from, to] = rangeFromQuery(req.query);
  const rows = computeStats(from, to);
  const csv = ['Camarero;Escaneos;Valoraciones;5★;4★;3★;2★;1★;Media;Clics Google;Bonus €']
    .concat(rows.map((r) => [r.name, r.scans, r.ratings, r.stars[5], r.stars[4], r.stars[3], r.stars[2], r.stars[1], r.avg ?? '', r.google_clicks, r.bonus.toFixed(2).replace('.', ',')].join(';')))
    .join('\n');
  res.type('text/csv; charset=utf-8').attachment('topreview-informe.csv').send('﻿' + csv);
});

// Portada pública para explicar TopReview a los camareros
const landing = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
app.get('/', (req, res) => res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${landing}</body></html>`));
app.get('/api/public/info', (req, res) => {
  const s = getSettings();
  res.set('Access-Control-Allow-Origin', '*'); // la web de camareros en GitHub Pages lee estos datos
  res.json({ business_name: s.business_name, bonus_5: s.bonus_5, bonus_4: s.bonus_4, bonus_3: s.bonus_3, bonus_2: s.bonus_2, bonus_1: s.bonus_1 });
});

// ---------- Plantillas ----------
function page(title, body) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · TopReview</title>
<link rel="stylesheet" href="/static/public.css"></head><body>${body}</body></html>`;
}

function reviewBody(w, s) {
  return `
  <div class="card center" id="app">
    <div class="brand">Top<span>Review</span></div>
    <p class="muted">${esc(s.business_name)}</p>
    <div class="avatar">${esc(w.name.charAt(0).toUpperCase())}</div>
    <h1>¿Qué tal te ha atendido <br><span class="hl">${esc(w.name)}</span>?</h1>
    <div class="stars" id="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" aria-label="${n} estrellas">★</button>`).join('')}</div>
    <p class="muted" id="hint">Toca las estrellas</p>
  </div>
  <script>
    const slug = ${JSON.stringify(w.slug)}, name = ${JSON.stringify(w.name)};
    const hasGoogle = ${JSON.stringify(!!s.google_review_url)};
    const app = document.getElementById('app');
    const btns = [...document.querySelectorAll('#stars button')];
    btns.forEach(b => {
      b.onmouseenter = () => paint(+b.dataset.n);
      b.onclick = () => rate(+b.dataset.n);
    });
    document.getElementById('stars').onmouseleave = () => paint(0);
    function paint(n){ btns.forEach(b => b.classList.toggle('on', +b.dataset.n <= n)); }
    async function rate(n){
      paint(n); btns.forEach(b => b.disabled = true);
      const r = await fetch('/api/r/' + slug + '/rate', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({stars:n})}).then(r => r.json());
      const g = hasGoogle ? '<a class="btn google" href="/go/' + slug + '">Escribir reseña en Google</a>' : '';
      if (r.redirect) {
        app.innerHTML = '<div class="brand">Top<span>Review</span></div><div class="big">🎉</div><h1>¡Gracias!</h1>' +
          '<p>¿Nos ayudas con una reseña en Google? <br><b>Menciona a ' + esc(name) + '</b> 🙌</p>' + g +
          '<p class="muted small">Te llevamos a Google en un momento…</p>';
        setTimeout(() => location.href = '/go/' + slug, 2500);
      } else {
        app.innerHTML = '<div class="brand">Top<span>Review</span></div><h1>Gracias por tu sinceridad</h1>' +
          '<p>¿Qué podríamos mejorar? Solo lo leerá la dirección.</p>' +
          '<textarea id="c" rows="4" placeholder="Cuéntanos…"></textarea>' +
          '<button class="btn" id="send">Enviar</button>' +
          (g ? '<p class="muted small">También puedes dejar tu opinión pública:</p>' + g.replace('btn google', 'btn ghost') : '');
        document.getElementById('send').onclick = async () => {
          await fetch('/api/r/' + slug + '/comment', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:r.id, comment: document.getElementById('c').value})});
          app.innerHTML = '<div class="brand">Top<span>Review</span></div><div class="big">🙏</div><h1>¡Recibido!</h1><p>Gracias por ayudarnos a mejorar.</p>';
        };
      }
    }
    function esc(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
  </script>`;
}

app.use('/static', express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`TopReview en http://localhost:${PORT}  (admin: ${ADMIN_USER} / ${ADMIN_PASSWORD === 'topreview' ? 'topreview  ← cámbiala con ADMIN_PASSWORD' : '********'})`);
});
