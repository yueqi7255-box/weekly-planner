const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('./schema');
const { normalizeUsername, validPassword, hashPassword, verifyPassword, tokenHash } = require('./auth');

const root = __dirname;
const publicDir = path.join(root, 'public');
const dbPath = process.env.PLANNER_DB || path.join(root, 'data', 'planner.sqlite3');
const port = Number(process.env.PORT || 4173);
let listenPort = port;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initDb(db);

const colors = new Set(['neutral', 'learning', 'practice', 'work']);
const statuses = new Set(['unset', 'done', 'most', 'small', 'none']);
const weekFields = new Set(['learning', 'practice', 'work', 'status']);
const globalKeys = new Set(['long_term', 'notes']);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const loginAttempts = new Map();
const registerAttempts = new Map();
const sessionAge = 30 * 24 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function assert(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validMonday(value) {
  return validDate(value) && new Date(`${value}T00:00:00Z`).getUTCDay() === 1;
}

function dateAfter(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function textValue(value, limit = 20000) {
  assert(typeof value === 'string', '内容必须是文本');
  assert(value.length <= limit, `内容不能超过 ${limit} 个字符`);
  return value.replace(/\r\n?/g, '\n');
}

function transaction(action) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sendJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(value));
}

async function readJson(req, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    assert(size <= maxBytes, '请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(body && typeof body === 'object' && !Array.isArray(body), '请求格式无效');
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '请求不是有效的 JSON');
  }
}

function taskOutput(row) {
  return { ...row, completed: Boolean(row.completed) };
}

function weekData(start, userId) {
  const week = db.prepare('SELECT learning, practice, work, status FROM user_weeks WHERE user_id = ? AND week_start = ?').get(userId, start)
    || { learning: '', practice: '', work: '', status: 'unset' };
  const globalRows = db.prepare('SELECT key, value FROM user_globals WHERE user_id = ?').all(userId);
  const globals = { long_term: '', notes: '' };
  for (const row of globalRows) globals[row.key] = row.value;
  const end = dateAfter(start, 6);
  const rows = db.prepare(`
    SELECT id, task_date, position, text, color, completed
    FROM user_tasks WHERE user_id = ? AND task_date BETWEEN ? AND ?
    ORDER BY task_date, position, id
  `).all(userId, start, end);
  const tasks = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [dateAfter(start, i), []]));
  for (const row of rows) tasks[row.task_date].push(taskOutput(row));
  return { week_start: start, week, globals, tasks };
}

function reorderDate(userId, date, orderedIds) {
  const update = db.prepare('UPDATE user_tasks SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND task_date = ? AND id = ?');
  orderedIds.forEach((id, index) => update.run(index, userId, date, id));
}

function exportData(userId) {
  return {
    format: 'weekly-planner-backup',
    version: 1,
    exported_at: new Date().toISOString(),
    globals: Object.fromEntries(db.prepare('SELECT key, value FROM user_globals WHERE user_id = ?').all(userId).map(row => [row.key, row.value])),
    weeks: db.prepare('SELECT week_start, learning, practice, work, status FROM user_weeks WHERE user_id = ? ORDER BY week_start').all(userId),
    tasks: db.prepare('SELECT task_date, position, text, color, completed FROM user_tasks WHERE user_id = ? ORDER BY task_date, position, id').all(userId),
  };
}

function importData(body, userId) {
  assert(body.format === 'weekly-planner-backup' && body.version === 1, '备份格式或版本不受支持');
  assert(body.globals && typeof body.globals === 'object' && !Array.isArray(body.globals), '备份缺少长期目标和便笺');
  assert(Array.isArray(body.weeks) && Array.isArray(body.tasks), '备份数据不完整');
  assert(body.weeks.length <= 10000 && body.tasks.length <= 200000, '备份数据过大');

  const globals = {};
  for (const key of globalKeys) globals[key] = textValue(body.globals[key] ?? '');
  const weeks = body.weeks.map(week => {
    assert(week && validMonday(week.week_start), '备份包含无效周次');
    assert(statuses.has(week.status), '备份包含无效完成度');
    return {
      week_start: week.week_start,
      learning: textValue(week.learning),
      practice: textValue(week.practice),
      work: textValue(week.work),
      status: week.status,
    };
  });
  const tasks = body.tasks.map(task => {
    assert(task && validDate(task.task_date), '备份包含无效日期');
    assert(colors.has(task.color), '备份包含无效任务颜色');
    assert(typeof task.completed === 'boolean' || task.completed === 0 || task.completed === 1, '备份包含无效完成状态');
    assert(Number.isInteger(task.position) && task.position >= 0, '备份包含无效任务顺序');
    return {
      task_date: task.task_date,
      position: task.position,
      text: textValue(task.text, 5000),
      color: task.color,
      completed: Number(task.completed),
    };
  });

  transaction(() => {
    db.prepare('DELETE FROM user_tasks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_weeks WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_globals WHERE user_id = ?').run(userId);
    const putGlobal = db.prepare('INSERT INTO user_globals(user_id, key, value) VALUES(?, ?, ?)');
    for (const [key, value] of Object.entries(globals)) putGlobal.run(userId, key, value);
    const putWeek = db.prepare('INSERT INTO user_weeks(user_id, week_start, learning, practice, work, status) VALUES(?, ?, ?, ?, ?, ?)');
    for (const week of weeks) putWeek.run(userId, week.week_start, week.learning, week.practice, week.work, week.status);
    const putTask = db.prepare('INSERT INTO user_tasks(user_id, task_date, position, text, color, completed) VALUES(?, ?, ?, ?, ?, ?)');
    for (const task of tasks) putTask.run(userId, task.task_date, task.position, task.text, task.color, task.completed);
  });
  return { weeks: weeks.length, tasks: tasks.length };
}

function sessionToken(req) {
  return req.headers.cookie?.match(/(?:^|;\s*)planner_session=([a-f0-9]{64})(?:;|$)/)?.[1] || null;
}

function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.username FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?`)
    .get(tokenHash(token), Date.now()) || null;
}

function sessionCookie(req, token, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `planner_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function issueSession(req, res, user, status = 200) {
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES(?, ?, ?)')
    .run(tokenHash(token), user.id, Date.now() + sessionAge);
  return sendJson(res, status, { user: { id: user.id, username: user.username } },
    { 'Set-Cookie': sessionCookie(req, token, Math.floor(sessionAge / 1000)) });
}

function clientIp(req) {
  return req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

function checkRate(map, key, limit, windowMs) {
  const now = Date.now();
  if (map.size > 10000) {
    for (const [entry, value] of map) if (value.until < now) map.delete(entry);
  }
  const current = map.get(key);
  const next = current && current.until > now ? current : { count: 0, until: now + windowMs };
  next.count += 1;
  map.set(key, next);
  assert(next.count <= limit, '尝试次数过多，请稍后再试', 429);
}

function checkOrigin(req) {
  if (!req.headers.origin) return;
  const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
  let origin;
  try { origin = new URL(req.headers.origin); }
  catch { throw new HttpError(403, '请求来源无效'); }
  assert(origin.protocol === protocol && origin.host === req.headers.host, '请求来源无效', 403);
}

async function handleAuth(req, res, route) {
  if (req.method === 'GET' && route === '/api/auth/me') {
    const user = currentUser(req);
    assert(user, '请先登录', 401);
    return sendJson(res, 200, { user });
  }
  if (req.method === 'POST' && route === '/api/auth/register') {
    checkRate(registerAttempts, clientIp(req), 8, 60 * 60 * 1000);
    const body = await readJson(req);
    const account = normalizeUsername(body.username);
    assert(account, '用户名需为 3–32 个字母、数字、下划线或连字符');
    assert(validPassword(body.password), '密码需为 8–128 个字符');
    assert(!db.prepare('SELECT id FROM users WHERE username_key = ?').get(account.key), '用户名已被使用', 409);
    const result = db.prepare('INSERT INTO users(username, username_key, password_hash) VALUES(?, ?, ?)')
      .run(account.username, account.key, hashPassword(body.password));
    return issueSession(req, res, { id: Number(result.lastInsertRowid), username: account.username }, 201);
  }
  if (req.method === 'POST' && route === '/api/auth/login') {
    const body = await readJson(req);
    const account = normalizeUsername(body.username);
    const key = `${clientIp(req)}:${account?.key || ''}`;
    checkRate(loginAttempts, key, 10, 15 * 60 * 1000);
    const user = account && db.prepare('SELECT id, username, password_hash FROM users WHERE username_key = ?').get(account.key);
    if (!user || !verifyPassword(body.password, user.password_hash)) throw new HttpError(401, '用户名或密码错误');
    loginAttempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    return issueSession(req, res, user);
  }
  if (req.method === 'POST' && route === '/api/auth/logout') {
    const token = sessionToken(req);
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (req.method === 'POST' && route === '/api/auth/password') {
    const user = currentUser(req);
    assert(user, '请先登录', 401);
    const body = await readJson(req);
    assert(validPassword(body.new_password), '新密码需为 8–128 个字符');
    const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    assert(verifyPassword(body.current_password, stored.password_hash), '当前密码不正确', 403);
    transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.new_password), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    return issueSession(req, res, user);
  }
  throw new HttpError(404, '接口不存在');
}

async function handleApi(req, res, url) {
  const route = url.pathname;
  if (req.method === 'GET' && route === '/api/health') return sendJson(res, 200, { ok: true });
  if (route.startsWith('/api/auth/')) return handleAuth(req, res, route);
  const user = currentUser(req);
  assert(user, '请先登录', 401);
  const userId = user.id;
  if (req.method === 'GET' && route === '/api/week') {
    const start = url.searchParams.get('start');
    assert(validMonday(start), '请选择有效的周一日期');
    return sendJson(res, 200, weekData(start, userId));
  }
  if (req.method === 'PUT' && /^\/api\/globals\/(long_term|notes)$/.test(route)) {
    const key = route.split('/').at(-1);
    assert(globalKeys.has(key), '字段不存在');
    const body = await readJson(req);
    const value = textValue(body.value);
    db.prepare(`INSERT INTO user_globals(user_id, key, value) VALUES(?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(userId, key, value);
    return sendJson(res, 200, { key, value });
  }
  if (req.method === 'PUT' && /^\/api\/weeks\/\d{4}-\d{2}-\d{2}$/.test(route)) {
    const start = route.split('/').at(-1);
    assert(validMonday(start), '请选择有效的周一日期');
    const body = await readJson(req);
    const keys = Object.keys(body);
    assert(keys.length > 0 && keys.every(key => weekFields.has(key)), '周计划字段无效');
    const old = db.prepare('SELECT learning, practice, work, status FROM user_weeks WHERE user_id = ? AND week_start = ?').get(userId, start)
      || { learning: '', practice: '', work: '', status: 'unset' };
    const next = { ...old };
    for (const key of keys) {
      if (key === 'status') {
        assert(statuses.has(body.status), '完成度无效');
        next.status = body.status;
      } else {
        next[key] = textValue(body[key]);
      }
    }
    db.prepare(`
      INSERT INTO user_weeks(user_id, week_start, learning, practice, work, status)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, week_start) DO UPDATE SET
        learning = excluded.learning, practice = excluded.practice,
        work = excluded.work, status = excluded.status, updated_at = CURRENT_TIMESTAMP
    `).run(userId, start, next.learning, next.practice, next.work, next.status);
    return sendJson(res, 200, next);
  }
  if (req.method === 'POST' && route === '/api/tasks') {
    const body = await readJson(req);
    assert(validDate(body.task_date), '任务日期无效');
    const value = textValue(body.text, 5000).trim();
    assert(value.length > 0, '任务内容不能为空');
    const color = body.color ?? 'neutral';
    assert(colors.has(color), '任务颜色无效');
    const afterId = body.after_id == null ? null : Number(body.after_id);
    const beforeId = body.before_id == null ? null : Number(body.before_id);
    assert(afterId === null || (Number.isInteger(afterId) && afterId > 0), '任务位置无效');
    assert(beforeId === null || (Number.isInteger(beforeId) && beforeId > 0), '任务位置无效');
    assert(afterId === null || beforeId === null, '只能指定一个插入位置');
    const task = transaction(() => {
      const existing = db.prepare('SELECT id FROM user_tasks WHERE user_id = ? AND task_date = ? ORDER BY position, id').all(userId, body.task_date).map(row => row.id);
      let index = existing.length;
      if (afterId !== null) {
        index = existing.indexOf(afterId) + 1;
        assert(index > 0, '插入位置不存在');
      } else if (beforeId !== null) {
        index = existing.indexOf(beforeId);
        assert(index >= 0, '插入位置不存在');
      }
      const result = db.prepare('INSERT INTO user_tasks(user_id, task_date, position, text, color) VALUES(?, ?, ?, ?, ?)')
        .run(userId, body.task_date, existing.length, value, color);
      const id = Number(result.lastInsertRowid);
      existing.splice(index, 0, id);
      reorderDate(userId, body.task_date, existing);
      return db.prepare('SELECT id, task_date, position, text, color, completed FROM user_tasks WHERE user_id = ? AND id = ?').get(userId, id);
    });
    return sendJson(res, 201, taskOutput(task));
  }
  if (/^\/api\/tasks\/\d+$/.test(route)) {
    const id = Number(route.split('/').at(-1));
    const old = db.prepare('SELECT * FROM user_tasks WHERE user_id = ? AND id = ?').get(userId, id);
    assert(old, '任务不存在', 404);
    if (req.method === 'DELETE') {
      transaction(() => {
        db.prepare('DELETE FROM user_tasks WHERE user_id = ? AND id = ?').run(userId, id);
        const ordered = db.prepare('SELECT id FROM user_tasks WHERE user_id = ? AND task_date = ? ORDER BY position, id').all(userId, old.task_date).map(row => row.id);
        reorderDate(userId, old.task_date, ordered);
      });
      return sendJson(res, 200, { deleted: id });
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const keys = Object.keys(body);
      assert(keys.length > 0 && keys.every(key => ['text', 'color', 'completed'].includes(key)), '任务字段无效');
      const next = { text: old.text, color: old.color, completed: old.completed };
      if ('text' in body) {
        next.text = textValue(body.text, 5000).trim();
        assert(next.text, '任务内容不能为空');
      }
      if ('color' in body) {
        assert(colors.has(body.color), '任务颜色无效');
        next.color = body.color;
      }
      if ('completed' in body) {
        assert(typeof body.completed === 'boolean', '完成状态无效');
        next.completed = Number(body.completed);
      }
      db.prepare('UPDATE user_tasks SET text = ?, color = ?, completed = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id = ?')
        .run(next.text, next.color, next.completed, userId, id);
      const task = db.prepare('SELECT id, task_date, position, text, color, completed FROM user_tasks WHERE user_id = ? AND id = ?').get(userId, id);
      return sendJson(res, 200, taskOutput(task));
    }
  }
  if (req.method === 'GET' && route === '/api/export') {
    const data = exportData(userId);
    return sendJson(res, 200, data, {
      'Content-Disposition': `attachment; filename="weekly-planner-${new Date().toISOString().slice(0, 10)}.json"`,
    });
  }
  if (req.method === 'POST' && route === '/api/import') {
    const body = await readJson(req, 16 * 1024 * 1024);
    return sendJson(res, 200, importData(body, userId));
  }
  throw new HttpError(404, '接口不存在');
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'portal.html' : pathname === '/app' ? 'index.html' : pathname === '/login' ? 'login.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(publicDir, relative);
  assert(file.startsWith(`${publicDir}${path.sep}`) && fs.existsSync(file) && fs.statSync(file).isFile(), '页面不存在', 404);
  res.writeHead(200, {
    'Content-Type': mimeTypes[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!['GET', 'HEAD'].includes(req.method)) checkOrigin(req);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET') {
      if ((url.pathname === '/app' || url.pathname === '/index.html') && !currentUser(req)) {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
      } else if (url.pathname === '/login' && currentUser(req)) {
        res.writeHead(302, { Location: '/app', 'Cache-Control': 'no-store' });
        res.end();
      } else await serveStatic(res, url.pathname);
    }
    else throw new HttpError(405, '不支持的请求方法');
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    if (!error.status) console.error(error);
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && listenPort < port + 20) {
    listenPort += 1;
    server.listen(listenPort, '127.0.0.1');
    return;
  }
  console.error(error);
  db.close();
  process.exit(1);
});

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`Weekly Planner: http://127.0.0.1:${server.address().port}`);
  console.log(`SQLite: ${dbPath}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
