const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { sql } = require('@vercel/postgres');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.join(ROOT, 'data.json');
const USERS_FILE = path.join(ROOT, 'users.json');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const USE_DB = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);

const SHIFTS = {
  day: {
    label: 'Day Shift',
    times: [
      '10:00 - 11:00', '11:00 - 12:00', '12:00 - 13:00', '13:00 - 14:00', '14:00 - 15:00',
      '15:00 - 16:00', '16:00 - 17:00', '17:00 - 18:00', '18:00 - 19:00', '19:00 - 20:00'
    ],
    away: [3, 3, 3, 3, 3, 3, 3, 2, 2, 2]
  },
  night: {
    label: 'Night Shift',
    times: [
      '23:00 - 00:00', '00:00 - 01:00', '01:00 - 02:00', '02:00 - 03:00', '03:00 - 04:00',
      '04:00 - 05:00', '05:00 - 06:00', '06:00 - 07:00', '07:00 - 08:00'
    ],
    away: [2, 2, 3, 3, 3, 3, 3, 3, 3]
  },
  monday: {
    label: 'Monday Shift',
    times: [
      '10:00 - 11:00', '11:00 - 12:00', '12:00 - 13:00', '13:00 - 14:00', '14:00 - 15:00',
      '15:00 - 16:00', '16:00 - 17:00', '17:00 - 18:00', '18:00 - 19:00', '19:00 - 20:00'
    ],
    away: [2, 2, 3, 3, 3, 3, 3, 3, 3, 3]
  }
};

const TABS = [
  { key: 'break', label: 'Break' },
  { key: 'line2', label: '2nd Line' }
];

const SECTIONS = [
  { key: 's2b', label: 'S2B' },
  { key: 'universal', label: 'Universal' },
  { key: 'betsider', label: 'Betsider' }
];

/* ---------------- storage helpers ---------------- */

const emptySlots = (n) => Array.from({ length: n }, () => '');

function makeDefaultData() {
  const data = {};
  for (const [shiftKey, cfg] of Object.entries(SHIFTS)) {
    data[shiftKey] = {};
    for (const t of TABS) {
      data[shiftKey][t.key] = cfg.times.map((time, i) => ({
        time,
        slots: {
          s2b: emptySlots(cfg.away[i]),
          universal: emptySlots(cfg.away[i]),
          betsider: emptySlots(cfg.away[i])
        }
      }));
    }
  }
  return data;
}

function readJsonFile(file, fallback) {
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      try {
        fs.renameSync(file, file + '.broken-' + Date.now());
      } catch (e2) {}
    }
  }
  return fallback;
}

function writeJsonFile(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

let data = makeDefaultData();
let users = {};
let booted = false;

function seedAdminUser() {
  const pwd = process.env.ADMIN_PASSWORD || 'admin123';
  const salt = crypto.randomBytes(16).toString('hex');
  users.admin = { salt, hash: hashPassword(pwd, salt) };
  return users.admin;
}

async function initDb() {
  await sql`CREATE TABLE IF NOT EXISTS app_state (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

async function dbGet(key) {
  const r = await sql`SELECT v FROM app_state WHERE k = ${key}`;
  return r.rows && r.rows.length ? r.rows[0].v : null;
}

async function dbSet(key, value) {
  await sql`INSERT INTO app_state (k, v) VALUES (${key}, ${value})
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`;
}

async function saveData() {
  if (USE_DB) {
    await dbSet('data', JSON.stringify(data));
  } else {
    writeJsonFile(DATA_FILE, data);
  }
}

async function saveUsers() {
  if (USE_DB) {
    await dbSet('users', JSON.stringify(users));
  } else {
    writeJsonFile(USERS_FILE, users);
  }
}

async function boot() {
  if (booted) return;
  booted = true;
  if (USE_DB) {
    await initDb();
    const raw = await dbGet('data');
    if (raw) {
      try { data = JSON.parse(raw); } catch (e) { data = makeDefaultData(); }
    } else {
      await dbSet('data', JSON.stringify(data));
    }
    const uraw = await dbGet('users');
    if (uraw) {
      try { users = JSON.parse(uraw); } catch (e) { users = {}; }
    }
    if (!users.admin) {
      seedAdminUser();
      await saveUsers();
    }
  } else {
    data = readJsonFile(DATA_FILE, makeDefaultData());
    users = readJsonFile(USERS_FILE, {});
    if (!users.admin) {
      seedAdminUser();
      writeJsonFile(USERS_FILE, users);
    }
  }
}

/* ---------------- admin auth ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const tokens = new Map();

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { user, exp: Date.now() + 8 * 3600 * 1000 });
  return token;
}

function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const t = tokens.get(m[1]);
  return !!t && t.exp > Date.now() && t.user === 'admin';
}

/* ---------------- validation ---------------- */

function resolveSlot(body) {
  const { shift, tab, timeIdx, section, slotIdx } = body || {};
  const cfg = SHIFTS[shift];
  if (!cfg) return null;
  if (!TABS.some((t) => t.key === tab)) return null;
  if (!SECTIONS.some((s) => s.key === section)) return null;
  const ti = Number(timeIdx);
  const si = Number(slotIdx);
  if (!Number.isInteger(ti) || ti < 0 || ti >= cfg.times.length) return null;
  if (!Number.isInteger(si) || si < 0 || si >= cfg.away[ti]) return null;
  return { shift, tab, ti, si, section, away: cfg.away[ti] };
}

function isTabTimeLocked(row) {
  for (const s of SECTIONS) {
    for (const v of row.slots[s.key]) {
      if (v) return true;
    }
  }
  return false;
}

function groupAtHour(shift, ti, section) {
  for (const t of TABS) {
    const row = data[shift][t.key][ti];
    if (row.slots[section].some((v) => v)) return true;
  }
  return false;
}

function nameInShift(shift, name) {
  const lower = name.toLowerCase();
  for (const t of TABS) {
    for (const row of data[shift][t.key]) {
      for (const s of SECTIONS) {
        if (row.slots[s.key].some((v) => v && v.toLowerCase() === lower)) return true;
      }
    }
  }
  return false;
}

/* ---------------- http helpers ---------------- */

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(urlPath, res) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ---------------- request handler ---------------- */

async function handleRequest(req, res) {
  const url = req.url || '/';
  const method = req.method || 'GET';

  if (url.startsWith('/api/')) {
    try {
      await boot();

      if (url === '/api/data' && method === 'GET') {
        return send(res, 200, { config: { shifts: SHIFTS, tabs: TABS, sections: SECTIONS }, data });
      }

      if (url === '/api/me' && method === 'GET') {
        if (!isAdmin(req)) return send(res, 401, { error: 'Invalid session' });
        return send(res, 200, { ok: true });
      }

      let body = {};
      try {
        body = await readJson(req);
      } catch (e) {
        return send(res, 400, { error: 'Invalid JSON' });
      }

      if (url === '/api/login' && method === 'POST') {
        const u = users[String(body.username || '')];
        if (!u) return send(res, 401, { error: 'Invalid credentials' });
        const hash = hashPassword(String(body.password || ''), u.salt);
        if (hash !== u.hash) return send(res, 401, { error: 'Invalid credentials' });
        return send(res, 200, { token: issueToken(String(body.username)) });
      }

      if (url === '/api/slot' && method === 'POST') {
        const slot = resolveSlot(body);
        if (!slot) return send(res, 400, { error: 'Invalid slot' });
        const name = String(body.name || '').trim().slice(0, 60);
        const admin = isAdmin(req);
        const row = data[slot.shift][slot.tab][slot.ti];
        const cell = row.slots[slot.section][slot.si];
        if (cell !== '' && !admin) return send(res, 403, { error: 'Slot is locked' });
        if (cell === '' && name !== '') {
          if (nameInShift(slot.shift, name)) {
            return send(res, 403, { error: name + ' already signed up for this shift' });
          }
          if (isTabTimeLocked(row)) {
            return send(res, 403, { error: 'This time is already taken' });
          }
          if (groupAtHour(slot.shift, slot.ti, slot.section)) {
            return send(res, 403, { error: 'Your group already has someone this hour' });
          }
        }
        row.slots[slot.section][slot.si] = name;
        await saveData();
        return send(res, 200, { ok: true });
      }

      if (url === '/api/clearSlot' && method === 'POST') {
        if (!isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        const slot = resolveSlot(body);
        if (!slot) return send(res, 400, { error: 'Invalid slot' });
        data[slot.shift][slot.tab][slot.ti].slots[slot.section][slot.si] = '';
        await saveData();
        return send(res, 200, { ok: true });
      }

      if (url === '/api/clearAll' && method === 'POST') {
        if (!isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        data = makeDefaultData();
        await saveData();
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'Unknown API' });
    } catch (e) {
      return send(res, 500, { error: 'Server error: ' + e.message });
    }
  }

  serveStatic(url, res);
}

module.exports = { handleRequest, boot };

/* ---------------- local entry point ---------------- */

if (require.main === module) {
  if (process.argv.includes('--set-password')) {
    const idx = process.argv.indexOf('--set-password');
    const pwd = process.argv[idx + 1];
    if (!pwd) {
      console.log('Usage: node server.js --set-password NEWPASSWORD');
      process.exit(1);
    }
    boot().then(() => {
      const salt = crypto.randomBytes(16).toString('hex');
      users.admin = { salt, hash: hashPassword(pwd, salt) };
      return saveUsers();
    }).then(() => {
      console.log('Admin password updated.');
      process.exit(0);
    }).catch((e) => {
      console.error('Failed:', e.message);
      process.exit(1);
    });
  } else {
    boot().then(() => {
      const server = http.createServer(handleRequest);
      server.listen(PORT, HOST, () => {
        console.log('');
        console.log('  Shift Schedule server is running.');
        console.log('  Local:    http://localhost:' + PORT);
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const iface of ifaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
              console.log('  Network:  http://' + iface.address + ':' + PORT);
            }
          }
        }
        console.log('  Admin:    username admin  /  password admin123');
        console.log('            change with:  node server.js --set-password YOURNEWPASS');
        console.log('');
      });
    }).catch((e) => {
      console.error('Failed to start:', e.message);
      process.exit(1);
    });
  }
}