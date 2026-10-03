const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { sql } = require('@vercel/postgres');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const USE_DB = !!(process.env.POSTGRES_URL || process.env.DATABASE_URL);

function pickStorageDir() {
  try {
    fs.accessSync(ROOT, fs.constants.W_OK);
    return ROOT;
  } catch (e) {
    return os.tmpdir();
  }
}
const STORE_DIR = pickStorageDir();
const DATA_FILE = path.join(STORE_DIR, 'data.json');
const USERS_FILE = path.join(STORE_DIR, 'users.json');

const SHIFTS = {
  day: {
    label: 'Day Shift',
    times: [
      '10:00 - 11:00', '11:00 - 12:00', '12:00 - 13:00', '13:00 - 14:00', '14:00 - 15:00',
      '15:00 - 16:00', '16:00 - 17:00', '17:00 - 18:00', '18:00 - 19:00'
    ],
    away: [3, 3, 3, 3, 3, 3, 3, 2, 2]
  },
  night: {
    label: 'Night Shift',
    times: [
      '23:00 - 00:00', '00:00 - 01:00', '01:00 - 02:00', '02:00 - 03:00', '03:00 - 04:00',
      '04:00 - 05:00', '05:00 - 06:00', '06:00 - 07:00', '07:00 - 08:00'
    ],
    away: [2, 2, 3, 3, 3, 3, 3, 3, 3]
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

const GROUPS = [
  { key: 'shift1', label: 'Shift-1' },
  { key: 'shift2', label: 'Shift-2' },
  { key: 'shift3', label: 'Shift-3' },
  { key: 'shift4', label: 'Shift-4' }
];

const MAX_AWAY = 5;

const TAB_HOURS = {
  line2: {
    day: [0, 1, 2, 3, 4, 5, 6],
    night: [2, 3, 4, 5, 6, 7, 8]
  }
};

const LINE2_EXTRA = {
  day: [7, 8],
  night: [0, 1]
};

/* ---------------- storage helpers ---------------- */

const emptySlots = () => Array.from({ length: MAX_AWAY }, () => '');

function makeGroupData() {
  const group = {};
  for (const [shiftKey, cfg] of Object.entries(SHIFTS)) {
    group[shiftKey] = { away: cfg.away.slice(), line2extra: false };
    for (const t of TABS) {
      group[shiftKey][t.key] = cfg.times.map((time) => ({
        time,
        slots: {
          s2b: emptySlots(),
          universal: emptySlots(),
          betsider: emptySlots()
        }
      }));
    }
  }
  return group;
}

function makeDefaultData() {
  const data = {};
  for (const g of GROUPS) data[g.key] = makeGroupData();
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ConflictError extends Error {}

/* DB mode: the database is the live source of truth. Each serverless instance
   re-reads it before serving or mutating, so no instance can serve stale state
   or overwrite another instance's writes with its old snapshot. */
async function loadData() {
  if (!USE_DB) return data;
  const raw = await dbGet('data');
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = makeDefaultData();
    }
  } else {
    data = makeDefaultData();
  }
  normalizeData();
  if (raw && JSON.stringify(data) !== raw) {
    await dbSet('data', JSON.stringify(data));
  } else if (!raw) {
    await dbSet('data', JSON.stringify(data));
  }
  return data;
}

async function saveData() {
  if (!USE_DB) {
    writeJsonFile(DATA_FILE, data);
    return;
  }
  const next = JSON.stringify(data);
  const r = await sql`SELECT v FROM app_state WHERE k = 'data'`;
  const cur = r.rows && r.rows.length ? r.rows[0].v : null;
  if (cur === next) return;
  const upd = await sql`UPDATE app_state SET v = ${next}, updated_at = now() WHERE k = 'data' AND v = ${cur}`;
  if (upd.rowCount !== 1) throw new ConflictError();
}

async function mutateData(fn) {
  if (!USE_DB) {
    fn(data);
    writeJsonFile(DATA_FILE, data);
    return;
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    await loadData();
    await fn(data);
    try {
      await saveData();
      return;
    } catch (e) {
      if (e instanceof ConflictError) continue;
      throw e;
    }
  }
  throw new HttpError(409, 'Concurrent updates conflict, please retry');
}

async function saveUsers() {
  if (USE_DB) {
    await dbSet('users', JSON.stringify(users));
  } else {
    writeJsonFile(USERS_FILE, users);
  }
}

function normalizeShiftData(sh) {
  for (const key of Object.keys(sh)) {
    if (!SHIFTS[key]) delete sh[key];
  }
  for (const [shiftKey, cfg] of Object.entries(SHIFTS)) {
    const cur = sh[shiftKey];
    if (!cur || typeof cur !== 'object') {
      sh[shiftKey] = makeGroupData()[shiftKey];
      continue;
    }
    if (!Array.isArray(cur.away) || cur.away.length !== cfg.times.length) {
      cur.away = cfg.away.slice();
    }
    cur.line2extra = !!cur.line2extra;
    for (const t of TABS) {
      if (!Array.isArray(cur[t.key])) cur[t.key] = makeGroupData()[shiftKey][t.key];
      const rows = cur[t.key];
      for (let ti = 0; ti < cfg.times.length; ti++) {
        const row = rows[ti];
        if (!row || typeof row !== 'object') {
          rows[ti] = { time: cfg.times[ti], slots: {} };
          continue;
        }
        row.time = cfg.times[ti];
        if (!row.slots || typeof row.slots !== 'object') row.slots = {};
        for (const s of SECTIONS) {
          const src = row.slots[s.key];
          if (!Array.isArray(src) || src.length < MAX_AWAY) {
            const arr = Array.from({ length: MAX_AWAY }, () => '');
            for (let i = 0; i < (src ? src.length : 0); i++) if (src[i]) arr[i] = src[i];
            row.slots[s.key] = arr;
          }
        }
      }
      cur[t.key] = rows.slice(0, cfg.times.length);
    }
  }
}

function normalizeData() {
  const groupKeys = GROUPS.map((g) => g.key);
  if (!groupKeys.some((k) => data[k])) {
    // legacy flat shape (shift at top level) -> move into Shift-1
    const legacy = data;
    data = makeDefaultData();
    for (const shiftKey of Object.keys(SHIFTS)) {
      if (legacy[shiftKey] && typeof legacy[shiftKey] === 'object') {
        data.shift1[shiftKey] = legacy[shiftKey];
      }
    }
  }
  for (const g of GROUPS) {
    if (!data[g.key] || typeof data[g.key] !== 'object') data[g.key] = makeGroupData();
    else normalizeShiftData(data[g.key]);
  }
}

function getAway(group, shift, ti) {
  const sh = data[group] && data[group][shift];
  if (sh && Array.isArray(sh.away) && typeof sh.away[ti] === 'number') return sh.away[ti];
  return SHIFTS[shift].away[ti];
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
    normalizeData();
    const uraw = await dbGet('users');
    if (uraw) {
      try { users = JSON.parse(uraw); } catch (e) { users = {}; }
    }
    if (!users.admin) {
      seedAdminUser();
      await saveUsers();
    }
    await loadTokens();
  } else {
    data = readJsonFile(DATA_FILE, makeDefaultData());
    users = readJsonFile(USERS_FILE, {});
    normalizeData();
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

function pruneTokens() {
  for (const [k, v] of tokens) {
    if (v.exp <= Date.now()) tokens.delete(k);
  }
}

function tokenEntryList() {
  pruneTokens();
  return [...tokens.entries()].map(([k, v]) => [k, v.exp]);
}

async function persistTokens() {
  if (!USE_DB) return;
  await dbSet('tokens', JSON.stringify(tokenEntryList()));
}

async function loadTokens() {
  if (!USE_DB) return;
  const raw = await dbGet('tokens');
  tokens.clear();
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      for (const [k, exp] of arr) {
        tokens.set(k, { user: 'admin', exp: Number(exp) });
      }
    } catch (e) {}
  }
  pruneTokens();
}

async function hydrateTokens() {
  if (USE_DB) {
    await loadTokens();
  }
}

async function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { user, exp: Date.now() + 8 * 3600 * 1000 });
  await persistTokens();
  return token;
}

async function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  pruneTokens();
  let t = tokens.get(m[1]);
  if (!t && USE_DB) {
    await hydrateTokens();
    pruneTokens();
    t = tokens.get(m[1]);
  }
  return !!t && t.exp > Date.now() && t.user === 'admin';
}

/* ---------------- validation ---------------- */

function tabHourIndices(group, shift, tab) {
  let set = (TAB_HOURS[tab] || {})[shift];
  if (!set) set = SHIFTS[shift].times.map((_, i) => i);
  if (tab !== 'line2') return set;
  const sh = data[group] && data[group][shift];
  const extra = (sh && sh.line2extra) ? (LINE2_EXTRA[shift] || []) : [];
  if (!extra.length) return set;
  return (shift === 'night') ? extra.concat(set) : set.concat(extra);
}

function resolveSlot(body) {
  const { group, shift, tab, timeIdx, section, slotIdx } = body || {};
  if (!GROUPS.some((g) => g.key === group)) return null;
  const cfg = SHIFTS[shift];
  if (!cfg) return null;
  if (!TABS.some((t) => t.key === tab)) return null;
  if (!SECTIONS.some((s) => s.key === section)) return null;
  const ti = Number(timeIdx);
  const si = Number(slotIdx);
  if (!Number.isInteger(ti) || ti < 0 || ti >= cfg.times.length) return null;
  if (!Number.isInteger(si) || si < 0 || si >= MAX_AWAY) return null;
  return { group, shift, tab, ti, si, section };
}

function rowFilled(row) {
  let n = 0;
  for (const s of SECTIONS) {
    for (const v of row.slots[s.key]) {
      if (v) n++;
    }
  }
  return n;
}

function hourUsed(group, shift, ti) {
  let n = 0;
  for (const t of TABS) {
    if (tabHourIndices(group, shift, t.key).includes(ti)) {
      n += rowFilled(data[group][shift][t.key][ti]);
    }
  }
  return n;
}

function nameConflict(group, shift, tab, ti, name) {
  const lower = String(name).toLowerCase();
  for (const t of TABS) {
    const rows = data[group][shift][t.key];
    for (let r = 0; r < rows.length; r++) {
      for (const s of SECTIONS) {
        for (const v of rows[r].slots[s.key]) {
          if (v && v.toLowerCase() === lower) {
            const found = { tab: t.key, timeIdx: r, section: s.key };
            if (t.key === tab) return Object.assign({ reason: 'sameShift' }, found);
            if (r === ti) return Object.assign({ reason: 'sameHour' }, found);
            if (Math.abs(r - ti) === 1) return Object.assign({ reason: 'adjacentHour' }, found);
          }
        }
      }
    }
  }
  return null;
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
        await loadData();
        return send(res, 200, { config: { groups: GROUPS, shifts: SHIFTS, tabs: TABS, sections: SECTIONS }, data });
      }

      if (url === '/api/me' && method === 'GET') {
        if (!await isAdmin(req)) return send(res, 401, { error: 'Invalid session' });
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
        return send(res, 200, { token: await issueToken(String(body.username)) });
      }

      if (url === '/api/slot' && method === 'POST') {
        const name = String(body.name || '').trim().slice(0, 60);
        const slot = resolveSlot(body);
        if (!slot) return send(res, 400, { error: 'Invalid slot' });
        if (name === '') return send(res, 400, { error: 'Invalid name' });
        const admin = await isAdmin(req);
        await mutateData((d) => {
          const row = d[slot.group][slot.shift][slot.tab][slot.ti];
          const cell = row.slots[slot.section][slot.si];
          if (cell !== '' && !admin) throw new HttpError(403, 'Slot is locked');
          if (cell === '' && name !== '') {
            const conflict = nameConflict(slot.group, slot.shift, slot.tab, slot.ti, name);
            const tabLabel = (TABS.find((x) => x.key === slot.tab) || {}).label || slot.tab;
            if (conflict) {
              const at = SHIFTS[slot.shift].times[slot.ti] || '';
              const foundLabel = (TABS.find((x) => x.key === conflict.tab) || {}).label || conflict.tab;
              const foundAt = SHIFTS[slot.shift].times[conflict.timeIdx] || '';
              const foundSection = (SECTIONS.find((x) => x.key === conflict.section) || {}).label || conflict.section;
              const foundSlot = foundLabel + ' ' + foundAt + ', ' + foundSection;
              const msg = conflict.reason === 'sameShift'
                ? name + ' already has a slot (' + foundSlot + ')'
                : conflict.reason === 'adjacentHour'
                  ? name + ' can\u2019t take ' + tabLabel + ' at ' + at + ' \u2014 they already have a slot at the adjacent hour (' + foundSlot + '). Break and 2nd Line can\u2019t be consecutive'
                  : name + ' is already booked on the other table (' + foundSlot + ')';
              throw new HttpError(403, msg);
            }
            if (!tabHourIndices(slot.group, slot.shift, slot.tab).includes(slot.ti)) {
              throw new HttpError(403, 'This time is not open on ' + tabLabel);
            }
            const capacity = getAway(slot.group, slot.shift, slot.ti);
            if (hourUsed(slot.group, slot.shift, slot.ti) >= capacity) {
              throw new HttpError(403, 'This hour is already at capacity (' + capacity + ')');
            }
            if (capacity <= 2 && rowFilled(row) >= 1) {
              throw new HttpError(403, 'Capacity ' + capacity + ': one agent per table this hour');
            }
          }
          row.slots[slot.section][slot.si] = name;
        });
        return send(res, 200, { ok: true });
      }

      if (url === '/api/clearSlot' && method === 'POST') {
        if (!await isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        const slot = resolveSlot(body);
        if (!slot) return send(res, 400, { error: 'Invalid slot' });
        await mutateData((d) => {
          d[slot.group][slot.shift][slot.tab][slot.ti].slots[slot.section][slot.si] = '';
        });
        return send(res, 200, { ok: true });
      }

      if (url === '/api/clearAll' && method === 'POST') {
        if (!await isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        const { group, shift } = body || {};
        if (!GROUPS.some((g) => g.key === group)) return send(res, 400, { error: 'Invalid group' });
        if (!SHIFTS[shift]) return send(res, 400, { error: 'Invalid shift' });
        await mutateData((d) => {
          if (!d[group] || !d[group][shift]) throw new HttpError(409, 'Target missing, please retry');
          d[group][shift] = makeGroupData()[shift];
        });
        return send(res, 200, { ok: true });
      }

      if (url === '/api/capacity' && method === 'POST') {
        if (!await isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        if (!GROUPS.some((g) => g.key === body.group)) return send(res, 400, { error: 'Invalid group' });
        const cfg = SHIFTS[body.shift];
        if (!cfg) return send(res, 400, { error: 'Invalid shift' });
        const ti = Number(body.timeIdx);
        const delta = Number(body.delta);
        if (!Number.isInteger(ti) || ti < 0 || ti >= cfg.times.length) return send(res, 400, { error: 'Invalid time' });
        if (!Number.isInteger(delta)) return send(res, 400, { error: 'Invalid delta' });
        let nextAway;
        await mutateData((d) => {
          const sh = d[body.group][body.shift];
          if (!Array.isArray(sh.away) || sh.away.length !== cfg.times.length) sh.away = cfg.away.slice();
          nextAway = Math.max(1, Math.min(MAX_AWAY, Number(sh.away[ti] || 0) + delta));
          sh.away[ti] = nextAway;
        });
        return send(res, 200, { group: body.group, shift: body.shift, timeIdx: ti, away: nextAway });
      }

      if (url === '/api/line2extra' && method === 'POST') {
        if (!await isAdmin(req)) return send(res, 401, { error: 'Admin required' });
        const { group, shift } = body;
        if (!GROUPS.some((g) => g.key === group)) return send(res, 400, { error: 'Invalid group' });
        if (shift !== 'day' && shift !== 'night') return send(res, 400, { error: 'Extra slots not supported for this shift' });
        let resultExtra;
        await mutateData((d) => {
          const sh = d[group][shift];
          const extra = LINE2_EXTRA[shift];
          const cur = !!(sh && sh.line2extra);
          if (cur) {
            for (const ti of extra) {
              const row = sh.line2[ti];
              for (const s of SECTIONS) {
                if (row.slots[s.key].some((v) => v)) {
                  throw new HttpError(409, 'Clear the extra 2nd Line slots first');
                }
              }
            }
            sh.line2extra = false;
          } else {
            sh.line2extra = true;
          }
          resultExtra = sh.line2extra;
        });
        return send(res, 200, { group, shift, line2extra: resultExtra });
      }

      return send(res, 404, { error: 'Unknown API' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
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
