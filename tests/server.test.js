const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('../schema');

const projectDir = path.resolve(__dirname, '..');
const workDir = path.join(os.tmpdir(), 'weekly-planner-tests');

async function startServer(dbPath) {
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: projectDir,
    env: { ...process.env, PORT: '0', PLANNER_DB: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('测试服务器启动超时')), 10000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/Weekly Planner: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`测试服务器提前退出：${code}`));
    });
    child.on('error', reject);
  });
  return { child, url };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function request(base, route, method = 'GET', body, cookie) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('accounts isolate plans, tasks, imports, and sessions', async t => {
  await fs.mkdir(workDir, { recursive: true });
  const folder = await fs.mkdtemp(path.join(workDir, 'planner-test-'));
  const dbPath = path.join(folder, 'planner.sqlite3');
  let server = await startServer(dbPath);
  t.after(async () => {
    await stopServer(server.child);
    await fs.rm(folder, { recursive: true, force: true });
  });

  const start = '2026-10-12';
  assert.equal((await request(server.url, '/api/health')).data.ok, true);
  assert.equal((await request(server.url, `/api/week?start=${start}`)).status, 401);
  const portal = await fetch(server.url);
  assert.equal(portal.status, 200);
  assert.match(await portal.text(), /从想过的一年/);
  const blockedApp = await fetch(`${server.url}/app`, { redirect: 'manual' });
  assert.equal(blockedApp.status, 302);
  assert.equal(blockedApp.headers.get('location'), '/login');
  assert.equal((await fetch(`${server.url}/login?mode=register`)).status, 200);
  const firstUser = await request(server.url, '/api/auth/register', 'POST', { username: 'Planner', password: 'initial-pass-123' });
  assert.equal(firstUser.status, 201);
  const firstCookie = firstUser.cookie;
  assert.equal((await fetch(`${server.url}/app`, { headers: { Cookie: firstCookie } })).status, 200);
  const signedInLogin = await fetch(`${server.url}/login`, { headers: { Cookie: firstCookie }, redirect: 'manual' });
  assert.equal(signedInLogin.headers.get('location'), '/app');
  assert.equal((await request(server.url, '/api/week?start=2026-10-13', 'GET', undefined, firstCookie)).status, 400);
  assert.equal((await request(server.url, `/api/week?start=${start}`, 'GET', undefined, firstCookie)).data.week.status, 'unset');

  await request(server.url, '/api/globals/long_term', 'PUT', { value: '长期方向\n持续学习' }, firstCookie);
  await request(server.url, '/api/globals/notes', 'PUT', { value: '随手记录' }, firstCookie);
  await request(server.url, `/api/weeks/${start}`, 'PUT', { learning: '阅读一本书\n写学习笔记' }, firstCookie);
  await request(server.url, `/api/weeks/${start}`, 'PUT', { practice: '完成原型', work: '周会', status: 'most' }, firstCookie);

  const first = (await request(server.url, '/api/tasks', 'POST', {
    task_date: start, text: '第一项', color: 'learning',
  }, firstCookie)).data;
  const third = (await request(server.url, '/api/tasks', 'POST', {
    task_date: start, text: '第三项', after_id: first.id,
  }, firstCookie)).data;
  const second = (await request(server.url, '/api/tasks', 'POST', {
    task_date: start, text: '第二项', before_id: third.id,
  }, firstCookie)).data;
  assert.deepEqual((await request(server.url, `/api/week?start=${start}`, 'GET', undefined, firstCookie)).data.tasks[start].map(item => item.text),
    ['第一项', '第二项', '第三项']);

  await request(server.url, `/api/tasks/${second.id}`, 'PATCH', { completed: true, color: 'practice' }, firstCookie);
  await request(server.url, `/api/tasks/${third.id}`, 'DELETE', undefined, firstCookie);
  const beforeRestart = (await request(server.url, `/api/week?start=${start}`, 'GET', undefined, firstCookie)).data;
  assert.equal(beforeRestart.globals.long_term, '长期方向\n持续学习');
  assert.equal(beforeRestart.week.learning, '阅读一本书\n写学习笔记');
  assert.equal(beforeRestart.week.status, 'most');
  assert.deepEqual(beforeRestart.tasks[start].map(item => item.position), [0, 1]);
  assert.equal(beforeRestart.tasks[start][1].completed, true);
  assert.equal(beforeRestart.tasks[start][1].color, 'practice');

  const backup = (await request(server.url, '/api/export', 'GET', undefined, firstCookie)).data;
  const secondUser = await request(server.url, '/api/auth/register', 'POST', { username: 'Second', password: 'other-pass-456' });
  assert.equal(secondUser.status, 201);
  const secondCookie = secondUser.cookie;
  const empty = (await request(server.url, `/api/week?start=${start}`, 'GET', undefined, secondCookie)).data;
  assert.equal(empty.week.learning, '');
  assert.equal(empty.globals.long_term, '');
  assert.equal(empty.tasks[start].length, 0);
  assert.equal((await request(server.url, `/api/tasks/${first.id}`, 'PATCH', { text: '越权' }, secondCookie)).status, 404);
  assert.equal((await request(server.url, `/api/tasks/${first.id}`, 'DELETE', undefined, secondCookie)).status, 404);
  assert.equal((await request(server.url, '/api/tasks', 'POST', { task_date: start, text: '越权排序', after_id: first.id }, secondCookie)).status, 400);
  assert.deepEqual((await request(server.url, '/api/export', 'GET', undefined, secondCookie)).data.tasks, []);
  assert.equal((await request(server.url, '/api/import', 'POST', backup, secondCookie)).status, 200);
  await request(server.url, '/api/globals/notes', 'PUT', { value: '第二人便笺' }, secondCookie);
  assert.equal((await request(server.url, `/api/week?start=${start}`, 'GET', undefined, firstCookie)).data.globals.notes, '随手记录');

  const changed = await request(server.url, '/api/auth/password', 'POST', {
    current_password: 'initial-pass-123', new_password: 'new-pass-789',
  }, firstCookie);
  assert.equal(changed.status, 200);
  assert.equal((await request(server.url, '/api/auth/me', 'GET', undefined, firstCookie)).status, 401);
  const changedCookie = changed.cookie;
  assert.equal((await request(server.url, '/api/auth/me', 'GET', undefined, changedCookie)).data.user.username, 'Planner');
  await request(server.url, '/api/auth/logout', 'POST', undefined, changedCookie);
  assert.equal((await request(server.url, '/api/auth/me', 'GET', undefined, changedCookie)).status, 401);

  await stopServer(server.child);
  server = await startServer(dbPath);
  const login = await request(server.url, '/api/auth/login', 'POST', { username: 'planner', password: 'new-pass-789' });
  assert.equal(login.status, 200);
  const persisted = (await request(server.url, `/api/week?start=${start}`, 'GET', undefined, login.cookie)).data;
  assert.equal(persisted.week.practice, '完成原型');
  assert.deepEqual(persisted.tasks[start].map(item => item.text), ['第一项', '第二项']);
});

test('legacy data migrates to the initial account only', async t => {
  await fs.mkdir(workDir, { recursive: true });
  const folder = await fs.mkdtemp(path.join(workDir, 'planner-migration-'));
  const dbPath = path.join(folder, 'planner.sqlite3');
  const db = new DatabaseSync(dbPath);
  initDb(db);
  db.prepare('INSERT INTO globals(key, value) VALUES(?, ?)').run('long_term', '旧目标');
  db.prepare('INSERT INTO weeks(week_start, learning) VALUES(?, ?)').run('2026-10-12', '旧学习');
  db.prepare('INSERT INTO tasks(task_date, position, text) VALUES(?, ?, ?)').run('2026-10-12', 0, '旧任务');
  db.close();
  execFileSync(process.execPath, ['--no-warnings', 'scripts/bootstrap-legacy.js', dbPath], {
    cwd: projectDir, input: JSON.stringify({ username: 'planner', password: 'original-pass-123' }),
  });
  const server = await startServer(dbPath);
  t.after(async () => {
    await stopServer(server.child);
    await fs.rm(folder, { recursive: true, force: true });
  });
  const login = await request(server.url, '/api/auth/login', 'POST', { username: 'planner', password: 'original-pass-123' });
  assert.equal(login.status, 200);
  const migrated = (await request(server.url, '/api/week?start=2026-10-12', 'GET', undefined, login.cookie)).data;
  assert.equal(migrated.globals.long_term, '旧目标');
  assert.equal(migrated.week.learning, '旧学习');
  assert.equal(migrated.tasks['2026-10-12'][0].text, '旧任务');
  const other = await request(server.url, '/api/auth/register', 'POST', { username: 'another', password: 'another-pass-123' });
  assert.equal((await request(server.url, '/api/week?start=2026-10-12', 'GET', undefined, other.cookie)).data.tasks['2026-10-12'].length, 0);
});
