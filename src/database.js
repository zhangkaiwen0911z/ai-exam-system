const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'exam.db');
let db = null;
let SQL = null;

async function init() { SQL = await initSqlJs(); }

function getDb() {
  if (db) return db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let buffer = null;
  if (fs.existsSync(DB_PATH)) buffer = fs.readFileSync(DB_PATH);
  db = new SQL.Database(buffer);
  db.run('PRAGMA foreign_keys = ON');
  initSchema();
  // 迁移：给旧表加 user_id
  const cols = db.exec('PRAGMA table_info(exams)')[0]?.values.map(v => v[1]) || [];
  if (!cols.includes('user_id')) {
    exec('ALTER TABLE exams ADD COLUMN user_id INTEGER REFERENCES users(id)');
    exec('ALTER TABLE questions ADD COLUMN user_id INTEGER REFERENCES users(id)');
  }
  if (!cols.includes('is_public')) {
    exec('ALTER TABLE exams ADD COLUMN is_public INTEGER DEFAULT 0');
  }
  if (!buffer) seedData();
  saveDb();
  return db;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function run(sql, params = []) {
  db.run(sql, params);
  const rid = get('SELECT last_insert_rowid() as id');
  saveDb();
  return rid ? rid.id : null;
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free(); return undefined;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function exec(sql) { db.exec(sql); saveDb(); }

function initSchema() {
  exec(`
    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT '📚',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS grade_levels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stage TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS knowledge_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      grade_id INTEGER REFERENCES grade_levels(id),
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES knowledge_points(id),
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      grade_id INTEGER REFERENCES grade_levels(id),
      type TEXT NOT NULL,
      difficulty INTEGER DEFAULT 3,
      stem TEXT NOT NULL,
      options TEXT,
      answer TEXT NOT NULL,
      explanation TEXT,
      points REAL DEFAULT 5,
      source TEXT DEFAULT 'manual',
      knowledge_point_id INTEGER REFERENCES knowledge_points(id),
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS exams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject_id INTEGER NOT NULL REFERENCES subjects(id),
      grade_id INTEGER REFERENCES grade_levels(id),
      total_points REAL DEFAULT 100,
      duration_min INTEGER DEFAULT 90,
      status TEXT DEFAULT 'draft',
      description TEXT,
      is_public INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      question_id INTEGER NOT NULL REFERENCES questions(id),
      sort_order INTEGER NOT NULL DEFAULT 0,
      points REAL DEFAULT 5,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subject_id INTEGER REFERENCES subjects(id),
      grade_id INTEGER REFERENCES grade_levels(id),
      file_type TEXT DEFAULT 'docx',
      content TEXT,
      question_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS ai_generation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_id INTEGER,
      grade_id INTEGER,
      question_type TEXT,
      count INTEGER,
      prompt TEXT,
      result_question_ids TEXT,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT DEFAULT 'teacher',
      subject_id INTEGER REFERENCES subjects(id),
      grade_id INTEGER REFERENCES grade_levels(id),
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      expires_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_no TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      class_name TEXT,
      grade_id INTEGER REFERENCES grade_levels(id),
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS exam_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exam_id INTEGER NOT NULL REFERENCES exams(id),
      student_id INTEGER NOT NULL REFERENCES students(id),
      score REAL NOT NULL,
      total_points REAL DEFAULT 100,
      date_taken TEXT DEFAULT (date('now','localtime')),
      notes TEXT,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);
}

function seedData() {
  const c = get('SELECT COUNT(*) as c FROM subjects');
  if (c && c.c > 0) return;

  // 学科
  const subs = [
    ['语文', 'YUWEN', '📖'], ['数学', 'SHUXUE', '🔢'], ['英语', 'YINGYU', '🔤'],
    ['物理', 'WULI', '⚡'], ['化学', 'HUAXUE', '🧪'], ['生物', 'SHENGWU', '🧬'],
    ['历史', 'LISHI', '📜'], ['地理', 'DILI', '🌍'], ['道德与法治', 'DAOFA', '⚖️'],
  ];
  for (const s of subs) run('INSERT INTO subjects (name, code, icon) VALUES (?, ?, ?)', s);

  // 年级
  const grades = [];
  for (let i = 1; i <= 6; i++) grades.push([`小学${i}年级`, 'primary', i]);
  for (let i = 7; i <= 9; i++) grades.push([`初中${i-6}年级`, 'middle', i]);
  for (let i = 10; i <= 12; i++) grades.push([`高中${i-9}年级`, 'high', i]);
  for (const g of grades) run('INSERT INTO grade_levels (name, stage, sort_order) VALUES (?, ?, ?)', g);
}

module.exports = { getDb, init, run, get, all, exec };
