const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { initDb } = require('../schema');
const { normalizeUsername, validPassword, hashPassword } = require('../auth');

const dbPath = process.argv[2] || process.env.PLANNER_DB;
if (!dbPath) throw new Error('需要指定数据库路径');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const account = normalizeUsername(input.username);
if (!account || !validPassword(input.password)) throw new Error('账号或密码格式无效');

const db = new DatabaseSync(dbPath);
initDb(db);
db.exec('BEGIN IMMEDIATE');
try {
  if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count) throw new Error('已存在账号，不能重复迁移');
  const result = db.prepare('INSERT INTO users(username, username_key, password_hash) VALUES(?, ?, ?)')
    .run(account.username, account.key, hashPassword(input.password));
  const userId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO user_globals(user_id, key, value) SELECT ?, key, value FROM globals').run(userId);
  db.prepare(`INSERT INTO user_weeks(user_id, week_start, learning, practice, work, status, updated_at)
    SELECT ?, week_start, learning, practice, work, status, updated_at FROM weeks`).run(userId);
  db.prepare(`INSERT INTO user_tasks(user_id, task_date, position, text, color, completed, updated_at)
    SELECT ?, task_date, position, text, color, completed, updated_at FROM tasks`).run(userId);
  db.exec('COMMIT');
  console.log(JSON.stringify({ username: account.username,
    weeks: db.prepare('SELECT COUNT(*) AS count FROM user_weeks WHERE user_id = ?').get(userId).count,
    tasks: db.prepare('SELECT COUNT(*) AS count FROM user_tasks WHERE user_id = ?').get(userId).count }));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
