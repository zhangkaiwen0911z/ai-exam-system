const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { getDb, init, run, get, all, exec } = require('./database');

const app = express();
const PORT = process.env.PORT || 3501;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

(async () => { await init(); getDb(); console.log('✅ 考试系统数据库初始化完成'); })();

// ==================== 认证中间件 ====================
function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'exam-salt-2024').digest('hex');
}

function generateToken() {
  return crypto.randomUUID() + '-' + crypto.randomUUID();
}

function authRequired(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: '请先登录' });
  const session = get('SELECT s.*, u.username, u.display_name, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND (s.expires_at IS NULL OR s.expires_at > datetime(\'now\', \'localtime\'))', [token]);
  if (!session) return res.status(401).json({ error: '登录已过期，请重新登录' });
  req.user = session;
  next();
}

function optionalAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.query.token;
  if (token) {
    const session = get('SELECT s.*, u.username, u.display_name, u.role FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?', [token]);
    if (session) req.user = session;
  }
  next();
}

// ==================== 认证路由 ====================
app.post('/api/auth/register', (req, res) => {
  const { username, password, display_name, role, subject_id, grade_id } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (username.length < 2) return res.status(400).json({ error: '用户名至少2个字符' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
  try {
    // 第一个注册的用户自动成为管理员
    const userCount = get('SELECT COUNT(*) as c FROM users')?.c || 0;
    const userRole = userCount === 0 ? 'admin' : (role || 'teacher');
    const hash = hashPassword(password);
    const id = run('INSERT INTO users (username, password_hash, display_name, role, subject_id, grade_id) VALUES (?, ?, ?, ?, ?, ?)',
      [username, hash, display_name || username, userRole, subject_id || null, grade_id || null]);
    const token = generateToken();
    run('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime(\'now\', \'+30 days\'))', [id, token]);
    res.json({ id, token, username, display_name: display_name || username, role: userRole, message: '注册成功' });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const user = get('SELECT * FROM users WHERE username = ? AND active = 1', [username]);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  if (user.password_hash !== hashPassword(password)) return res.status(401).json({ error: '用户名或密码错误' });
  const token = generateToken();
  run('INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime(\'now\', \'+30 days\'))', [user.id, token]);
  res.json({ id: user.id, token, username: user.username, display_name: user.display_name, role: user.role, message: '登录成功' });
});

app.post('/api/auth/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '') || req.body?.token;
  if (token) run('DELETE FROM sessions WHERE token = ?', [token]);
  res.json({ message: '已退出登录' });
});

app.get('/api/auth/me', optionalAuth, (req, res) => {
  if (!req.user) return res.json({ logged_in: false });
  res.json({ logged_in: true, id: req.user.user_id, username: req.user.username, display_name: req.user.display_name, role: req.user.role });
});

app.get('/api/users', authRequired, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可查看' });
  res.json(all('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY id'));
});

app.post('/api/users', authRequired, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { username, password, display_name, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  const hash = crypto.createHash('sha256').update(password + 'exam-salt-2024').digest('hex');
  try {
    const id = run('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)',
      [username, hash, display_name || username, role || 'teacher']);
    res.json({ id, message: '用户已创建' });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '用户名已存在' });
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/users/:id', authRequired, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { display_name, role, password, active } = req.body;
  const updates = [];
  const params = [];
  if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
  if (role !== undefined) { updates.push('role = ?'); params.push(role); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (password) {
    const hash = crypto.createHash('sha256').update(password + 'exam-salt-2024').digest('hex');
    updates.push('password_hash = ?');
    params.push(hash);
  }
  if (updates.length === 0) return res.status(400).json({ error: '没有要更新的字段' });
  params.push(req.params.id);
  run('UPDATE users SET ' + updates.join(', ') + ' WHERE id = ?', params);
  res.json({ message: '已更新' });
});

app.delete('/api/users/:id', authRequired, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const id = parseInt(req.params.id);
  if (id === req.user.user_id) return res.status(400).json({ error: '不能删除自己' });
  run('DELETE FROM sessions WHERE user_id = ?', [id]);
  run('DELETE FROM users WHERE id = ?', [id]);
  res.json({ message: '用户已删除' });
});

// ==================== 公共API（无需登录）====================
app.get('/api/public/students', (req, res) => {
  res.json(all('SELECT id, student_no, name, class_name FROM students ORDER BY name'));
});

app.get('/api/public/exams', (req, res) => {
  res.json(all(`SELECT e.id, e.title, e.duration_min, e.total_points,
    s.name as subject_name, g.name as grade_name
    FROM exams e
    LEFT JOIN subjects s ON e.subject_id = s.id
    LEFT JOIN grade_levels g ON e.grade_id = g.id
    WHERE e.status = 'published'`));
});

// ==================== 所有后续路由需要登录 ====================
app.use('/api', authRequired);

// ==================== 学科 ====================
app.get('/api/subjects', (req, res) => res.json(all('SELECT * FROM subjects ORDER BY id')));

// ==================== 年级 ====================
app.get('/api/grades', (req, res) => res.json(all('SELECT * FROM grade_levels ORDER BY sort_order')));
app.get('/api/grades/stage/:stage', (req, res) =>
  res.json(all('SELECT * FROM grade_levels WHERE stage = ? ORDER BY sort_order', [req.params.stage])));

// ==================== 知识点 ====================
app.get('/api/knowledge-points', (req, res) => {
  const { subject_id } = req.query;
  let sql = 'SELECT kp.*, s.name as subject_name FROM knowledge_points kp JOIN subjects s ON kp.subject_id = s.id';
  const params = [];
  if (subject_id) { sql += ' WHERE kp.subject_id = ?'; params.push(subject_id); }
  sql += ' ORDER BY kp.subject_id, kp.name';
  res.json(all(sql, params));
});
app.post('/api/knowledge-points', (req, res) => {
  const { subject_id, grade_id, name, parent_id } = req.body;
  try {
    const id = run('INSERT INTO knowledge_points (subject_id, grade_id, name, parent_id) VALUES (?, ?, ?, ?)',
      [subject_id, grade_id || null, name, parent_id || null]);
    res.json({ id, message: '知识点已添加' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ==================== 题目 ====================
app.get('/api/questions', (req, res) => {
  const { subject_id, grade_id, type, difficulty, source, limit } = req.query;
  let sql = `SELECT q.*, s.name as subject_name, g.name as grade_name, kp.name as kp_name
    FROM questions q
    LEFT JOIN subjects s ON q.subject_id = s.id
    LEFT JOIN grade_levels g ON q.grade_id = g.id
    LEFT JOIN knowledge_points kp ON q.knowledge_point_id = kp.id WHERE 1=1`;
  const params = [];
  // 用户隔离：管理员看全部，普通用户看自己的+共享的
  if (req.user.role !== 'admin') {
    sql += ' AND (q.user_id = ? OR q.user_id IS NULL)';
    params.push(req.user.user_id);
  }
  if (subject_id) { sql += ' AND q.subject_id = ?'; params.push(subject_id); }
  if (grade_id) { sql += ' AND q.grade_id = ?'; params.push(grade_id); }
  if (type) { sql += ' AND q.type = ?'; params.push(type); }
  if (difficulty) { sql += ' AND q.difficulty = ?'; params.push(difficulty); }
  if (source) { sql += ' AND q.source = ?'; params.push(source); }
  sql += ' ORDER BY q.created_at DESC';
  if (limit) sql += ' LIMIT ' + parseInt(limit);
  res.json(all(sql, params));
});

app.get('/api/questions/:id', (req, res) => {
  const q = get(`SELECT q.*, s.name as subject_name, g.name as grade_name, kp.name as kp_name
    FROM questions q
    LEFT JOIN subjects s ON q.subject_id = s.id
    LEFT JOIN grade_levels g ON q.grade_id = g.id
    LEFT JOIN knowledge_points kp ON q.knowledge_point_id = kp.id
    WHERE q.id = ?`, [req.params.id]);
  if (!q) return res.status(404).json({ error: '题目不存在' });
  // 验证权限
  if (req.user.role !== 'admin' && q.user_id && q.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权访问此题' });
  }
  res.json(q);
});

app.post('/api/questions', (req, res) => {
  const { subject_id, grade_id, type, difficulty, stem, options, answer, explanation, points, knowledge_point_id, source } = req.body;
  try {
    const id = run(`INSERT INTO questions (subject_id, grade_id, type, difficulty, stem, options, answer, explanation, points, knowledge_point_id, source, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [subject_id, grade_id || null, type, difficulty || 3, stem, options ? JSON.stringify(options) : null, answer, explanation || null, points || 5, knowledge_point_id || null, source || 'manual', req.user.user_id]);
    res.json({ id, message: '题目已添加' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/questions/:id', (req, res) => {
  const { subject_id, grade_id, type, difficulty, stem, options, answer, explanation, points, knowledge_point_id } = req.body;
  run(`UPDATE questions SET subject_id=?, grade_id=?, type=?, difficulty=?, stem=?, options=?, answer=?, explanation=?, points=?, knowledge_point_id=? WHERE id=?`,
    [subject_id, grade_id, type, difficulty, stem, options ? JSON.stringify(options) : null, answer, explanation, points, knowledge_point_id, req.params.id]);
  res.json({ message: '已更新' });
});

app.delete('/api/questions/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可删除题目' });
  run('DELETE FROM exam_questions WHERE question_id = ?', [req.params.id]);
  run('DELETE FROM questions WHERE id = ?', [req.params.id]);
  res.json({ message: '已删除' });
});

// ==================== 系统设置 ====================
app.get('/api/settings/:key', (req, res) => {
  const s = get('SELECT * FROM settings WHERE key = ?', [req.params.key]);
  res.json({ key: req.params.key, value: s ? s.value : null });
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\', \'localtime\'))', [key, value]);
  res.json({ message: '已保存' });
});

// ==================== AI 生成题目 ====================
app.post('/api/ai/generate', async (req, res) => {
  const { subject_id, grade_id, question_type, count, difficulty, knowledge_point, subject_name, grade_name } = req.body;
  const num = Math.min(count || 5, 20);
  const subName = subject_name || get('SELECT name FROM subjects WHERE id = ?', [subject_id])?.name || '未知';
  const grdName = grade_name || (grade_id ? get('SELECT name FROM grade_levels WHERE id = ?', [grade_id])?.name : '') || '通用';

  const typeMap = { single_choice: '单选题', multiple_choice: '多选题', fill_blank: '填空题', true_false: '判断题', short_answer: '简答题', essay: '作文题' };
  const typeName = typeMap[question_type] || '混合题型';

  // 判断是否需要选项
  const needsOptions = ['single_choice','multiple_choice','true_false'].includes(question_type);

  // 获取API Key
  const apiKey = process.env.DEEPSEEK_API_KEY || (get('SELECT value FROM settings WHERE key = ?', ['deepseek_api_key'])?.value) || '';

  const jsonTemplate = needsOptions
    ? '[\n  {\n    "stem": "题目内容",\n    "options": ["A选项","B选项","C选项","D选项"],\n    "answer": "正确答案",\n    "explanation": "详细解析",\n    "difficulty": ' + (difficulty || 3) + '\n  }\n]'
    : '[\n  {\n    "stem": "题目内容",\n    "answer": "参考答案",\n    "explanation": "详细解析",\n    "difficulty": ' + (difficulty || 3) + '\n  }\n]';

  const prompt = '你是一位资深' + subName + '教师，正在为' + grdName + '学生出题。' +
    '请生成' + num + '道' + typeName + '，难度' + (difficulty || 3) + '/5级。' +
    '要求：\n1. 每道题包含：题目、答案、解析\n2. 答案必须准确\n3. 解析要详细\n' +
    (needsOptions ? '4. 每道题必须包含4个选项，选项内容只写文字本身，不要带A.B.C.D.或AA.BB.CC.DD.等字母前缀\n' : question_type==='fill_blank' ? '4. 题目中只使用下划线____表示填空位置，不要在题目中透露答案（不得在____前后加括号提示词或直接写出答案）\n' : '4. 不要选项，直接出问答题\n') +
    (knowledge_point ? '5. 知识点范围：' + knowledge_point + '\n' : '') +
    '请以JSON数组格式返回，不要加markdown代码块标记，直接输出纯JSON：\n' +
    jsonTemplate;

  try {
    if (!apiKey) throw new Error('NO_API_KEY');

    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个专业的中国中小学出题教师。请严格按照要求的JSON格式返回题目，不要包含任何其他文字。题目必须符合中国国家课程标准。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.8,
        max_tokens: 4096
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      let errMsg = 'API请求失败';
      try { const e = JSON.parse(errBody); errMsg = e.error?.message || errMsg; } catch(_) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content || '';

    // 智能JSON提取：去掉markdown代码块标记
    content = content.replace(/```json\s*/gi, '').replace(/```\s*$/gm, '').trim();

    // 找到最外层数组的始末位置（处理嵌套[]）
    function extractOuterArray(str) {
      const start = str.indexOf('[');
      if (start === -1) return null;
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < str.length; i++) {
        const ch = str[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (!inString) {
          if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) return str.substring(start, i + 1); }
        }
      }
      return null;
    }

    const jsonStr = extractOuterArray(content);
    if (!jsonStr) throw new Error('无法从AI返回中提取JSON数组');

    let questions;
    try { questions = JSON.parse(jsonStr); } catch(e) {
      throw new Error('JSON解析失败: ' + e.message + '。原始内容前200字: ' + content.substring(0, 200));
    }
    if (!Array.isArray(questions)) throw new Error('返回数据不是数组');

    const ids = [];
    const savedStems = []; // 本批次已存题目，用于去重
    // 预加载该学科同题型的已有题目用于去重
    const existingStems = new Set(
      all('SELECT stem FROM questions WHERE subject_id = ? AND type = ?', [subject_id, question_type])
        .map(r => (r.stem || '').trim().replace(/\s+/g, '').toLowerCase().slice(0, 40))
        .filter(Boolean)
    );
    for (const q of questions) {
      // 非选择题型的选项置空；选择题清洗选项中的字母前缀
      let opts = q.options;
      if(needsOptions && opts && Array.isArray(opts)){
        opts = opts.map(o => o.replace(/^[A-Z]+[.、）)\s]*/g, '').trim());
      }
      const qOptions = (needsOptions && opts) ? JSON.stringify(opts) : null;
      // 填空题清洗：去掉括号提示词和紧跟在____后的答案词
      let stem = q.stem;
      if(question_type === 'fill_blank'){
        stem = stem.replace(/[_]+\s*[（(][^）)]*[）)]/g, '____');
        const ans = (q.answer || '').trim();
        if(ans){
          stem = stem.replace(new RegExp('____\\s+' + ans.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s*)', 'gi'), '____$1');
        }
      }
      // 去重检查：归一化后对比已有题目和本批题目
      const norm = stem.trim().replace(/\s+/g, '').toLowerCase().slice(0, 40);
      if(!norm || norm.length < 5) continue;
      if(existingStems.has(norm) || savedStems.includes(norm)) continue;
      savedStems.push(norm);
      const id = run('INSERT INTO questions (subject_id, grade_id, type, difficulty, stem, options, answer, explanation, source, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [subject_id, grade_id || null, question_type || 'single_choice', q.difficulty || difficulty || 3, stem, qOptions, q.answer, q.explanation || null, 'ai', null]);
      ids.push(id);
    }

    run('INSERT INTO ai_generation_log (subject_id, grade_id, question_type, count, prompt, result_question_ids) VALUES (?, ?, ?, ?, ?, ?)',
      [subject_id, grade_id || null, question_type, num, prompt.substring(0,200), ids.join(',')]);

    res.json({ count: ids.length, question_ids: ids, questions, api_source: 'deepseek' });
  } catch (e) {
    if (e.message === 'NO_API_KEY') {
      res.json({ count: 0, questions: [], error: 'NO_API_KEY', message: '请先在系统设置中配置 DeepSeek API Key' });
    } else {
      res.json({ count: 0, questions: [], error: e.message, message: 'AI生成失败: ' + e.message });
    }
  }
});

// ==================== 试卷 ====================
app.get('/api/exams', (req, res) => {
  const { subject_id, grade_id } = req.query;
  let sql = `SELECT e.*, s.name as subject_name, s.icon as subject_icon, g.name as grade_name,
    (SELECT COUNT(*) FROM exam_questions eq WHERE eq.exam_id = e.id) as question_count
    FROM exams e
    LEFT JOIN subjects s ON e.subject_id = s.id
    LEFT JOIN grade_levels g ON e.grade_id = g.id WHERE 1=1`;
  const params = [];
  // 用户隔离：管理员全部可见；普通用户见自己的+公开的
  if (req.user.role !== 'admin') {
    sql += ' AND (e.user_id = ? OR e.is_public = 1)';
    params.push(req.user.user_id);
  }
  if (subject_id) { sql += ' AND e.subject_id = ?'; params.push(subject_id); }
  if (grade_id) { sql += ' AND e.grade_id = ?'; params.push(grade_id); }
  sql += ' ORDER BY e.created_at DESC';
  res.json(all(sql, params));
});

app.get('/api/exams/:id', (req, res) => {
  const exam = get(`SELECT e.*, s.name as subject_name, s.icon as subject_icon, g.name as grade_name
    FROM exams e
    LEFT JOIN subjects s ON e.subject_id = s.id
    LEFT JOIN grade_levels g ON e.grade_id = g.id WHERE e.id = ?`, [req.params.id]);
  if (!exam) return res.status(404).json({ error: '试卷不存在' });
  // 权限检查：非管理员且非本人且非公开则拒绝
  if (req.user.role !== 'admin' && exam.user_id && exam.user_id !== req.user.user_id && !exam.is_public) {
    return res.status(403).json({ error: '无权访问此试卷' });
  }

  exam.questions = all(`SELECT eq.id as eq_id, eq.sort_order, eq.points as exam_points,
    q.*, kp.name as kp_name,
    s.name as subject_name, s.icon as subject_icon,
    g.name as grade_name
    FROM exam_questions eq
    JOIN questions q ON eq.question_id = q.id
    LEFT JOIN knowledge_points kp ON q.knowledge_point_id = kp.id
    LEFT JOIN subjects s ON q.subject_id = s.id
    LEFT JOIN grade_levels g ON q.grade_id = g.id
    WHERE eq.exam_id = ?
    ORDER BY eq.sort_order`, [req.params.id]);
  res.json(exam);
});

app.post('/api/exams', (req, res) => {
  const { title, subject_id, grade_id, total_points, duration_min, description, is_public } = req.body;
  try {
    const id = run('INSERT INTO exams (title, subject_id, grade_id, total_points, duration_min, description, user_id, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [title, subject_id, grade_id || null, total_points || 100, duration_min || 90, description || null, req.user.user_id, 1]);
    res.json({ id, message: '试卷已创建' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/exams/:id', (req, res) => {
  const { title, subject_id, grade_id, total_points, duration_min, status, description, is_public } = req.body;
  // 获取现有数据，只更新提供的字段
  const existing = get('SELECT * FROM exams WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: '试卷不存在' });
  // 仅管理员或创建者可编辑
  if (req.user.role !== 'admin' && existing.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权编辑此试卷' });
  }

  const newTitle = title !== undefined ? title : existing.title;
  const newSubj = subject_id !== undefined ? subject_id : existing.subject_id;
  const newGrade = grade_id !== undefined ? grade_id : existing.grade_id;
  const newTotal = total_points !== undefined ? total_points : existing.total_points;
  const newDur = duration_min !== undefined ? duration_min : existing.duration_min;
  const newStatus = status !== undefined ? status : existing.status;
  const newDesc = description !== undefined ? description : existing.description;
  const newPublic = is_public !== undefined ? (is_public ? 1 : 0) : existing.is_public;

  run('UPDATE exams SET title=?, subject_id=?, grade_id=?, total_points=?, duration_min=?, status=?, description=?, is_public=?, updated_at=datetime(\'now\',\'localtime\') WHERE id=?',
    [newTitle, newSubj, newGrade, newTotal, newDur, newStatus, newDesc, newPublic, req.params.id]);
  res.json({ message: '已更新' });
});

app.delete('/api/exams/:id', (req, res) => {
  const exam = get('SELECT * FROM exams WHERE id = ?', [req.params.id]);
  if (!exam) return res.status(404).json({ error: '试卷不存在' });
  if (req.user.role !== 'admin' && exam.user_id !== req.user.user_id) {
    return res.status(403).json({ error: '无权删除此试卷' });
  }
  run('DELETE FROM exam_questions WHERE exam_id = ?', [req.params.id]);
  run('DELETE FROM exams WHERE id = ?', [req.params.id]);
  res.json({ message: '已删除' });
});

// --- 试卷加题 ---
app.post('/api/exams/:id/questions', (req, res) => {
  const { question_ids } = req.body;
  if (!question_ids || !Array.isArray(question_ids)) return res.status(400).json({ error: '请提供question_ids数组' });
  const maxOrder = get('SELECT MAX(sort_order) as mo FROM exam_questions WHERE exam_id = ?', [req.params.id]);
  let order = (maxOrder?.mo || 0) + 1;
  try {
    for (const qid of question_ids) {
      const q = get('SELECT points FROM questions WHERE id = ?', [qid]);
      run('INSERT INTO exam_questions (exam_id, question_id, sort_order, points) VALUES (?, ?, ?, ?)',
        [req.params.id, qid, order++, q?.points || 5]);
    }
    res.json({ message: `已添加 ${question_ids.length} 道题` });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/exams/:examId/questions/:eqId', (req, res) => {
  run('DELETE FROM exam_questions WHERE id = ?', [req.params.eqId]);
  res.json({ message: '已移除' });
});

// ==================== 资源导入 ====================
app.post('/api/resources/import-text', (req, res) => {
  const { title, subject_id, grade_id, content } = req.body;
  if (!content) return res.status(400).json({ error: '内容为空' });
  try {
    const id = run('INSERT INTO resources (title, subject_id, grade_id, file_type, content, question_count) VALUES (?, ?, ?, ?, ?, ?)',
      [title || '导入资源', subject_id || null, grade_id || null, 'text', content, 0]);
    res.json({ id, message: '资源已导入' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/resources', (req, res) => {
  res.json(all(`SELECT r.*, s.name as subject_name, g.name as grade_name
    FROM resources r LEFT JOIN subjects s ON r.subject_id = s.id
    LEFT JOIN grade_levels g ON r.grade_id = g.id
    ORDER BY r.created_at DESC`));
});

app.get('/api/resources/:id', (req, res) => {
  const r = get('SELECT * FROM resources WHERE id = ?', [req.params.id]);
  if (!r) return res.status(404).json({ error: '资源不存在' });
  res.json(r);
});

app.delete('/api/resources/:id', (req, res) => {
  run('DELETE FROM resources WHERE id = ?', [req.params.id]);
  res.json({ message: '已删除' });
});

// ==================== 统计 ====================
app.get('/api/stats', (req, res) => {
  const userId = req.user.user_id;
  const isAdmin = req.user.role === 'admin';
  const userFilter = isAdmin ? '' : ' WHERE user_id = ' + userId + ' OR user_id IS NULL';
  const examFilter = isAdmin ? '' : ' WHERE e.user_id = ' + userId + ' OR e.user_id IS NULL';
  res.json({
    total_questions: get('SELECT COUNT(*) as c FROM questions' + userFilter),
    total_exams: get('SELECT COUNT(*) as c FROM exams' + userFilter.replace(/e\./g, '')),
    by_source: all("SELECT source, COUNT(*) as c FROM questions" + userFilter + " GROUP BY source"),
    by_type: all("SELECT type, COUNT(*) as c FROM questions" + userFilter + " GROUP BY type"),
    recent_exams: all(`SELECT e.*, s.name as subject_name, s.icon as subject_icon FROM exams e
      JOIN subjects s ON e.subject_id = s.id${examFilter} ORDER BY e.created_at DESC LIMIT 5`),
  });
});

// ==================== 学员管理 ====================
app.get('/api/students', (req, res) => {
  const { grade_id, class_name } = req.query;
  let sql = `SELECT s.*, g.name as grade_name, (SELECT COUNT(*) FROM exam_scores WHERE student_id = s.id) as exam_count FROM students s LEFT JOIN grade_levels g ON s.grade_id = g.id WHERE 1=1`;
  const params = [];
  if (grade_id) { sql += ' AND s.grade_id = ?'; params.push(grade_id); }
  if (class_name) { sql += ' AND s.class_name = ?'; params.push(class_name); }
  sql += ' ORDER BY s.class_name, s.name';
  res.json(all(sql, params));
});

app.get('/api/students/:id', (req, res) => {
  const s = get('SELECT s.*, g.name as grade_name FROM students s LEFT JOIN grade_levels g ON s.grade_id = g.id WHERE s.id = ?', [req.params.id]);
  if (!s) return res.status(404).json({ error: '学员不存在' });
  // 附带该学员的所有考试成绩
  s.scores = all(`SELECT es.*, e.title as exam_title, s2.name as subject_name
    FROM exam_scores es
    JOIN exams e ON es.exam_id = e.id
    LEFT JOIN subjects s2 ON e.subject_id = s2.id
    WHERE es.student_id = ?
    ORDER BY es.date_taken DESC`, [req.params.id]);
  res.json(s);
});

app.post('/api/students', (req, res) => {
  const { student_no, name, class_name, grade_id } = req.body;
  if (!student_no || !name) return res.status(400).json({ error: '学号和姓名必填' });
  try {
    const id = run('INSERT INTO students (student_no, name, class_name, grade_id) VALUES (?, ?, ?, ?)',
      [student_no, name, class_name || null, grade_id || null]);
    res.json({ id, message: '学员已添加' });
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: '学号已存在' });
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/students/:id', (req, res) => {
  const { name, class_name, grade_id } = req.body;
  run('UPDATE students SET name=?, class_name=?, grade_id=? WHERE id=?',
    [name, class_name || null, grade_id || null, req.params.id]);
  res.json({ message: '已更新' });
});

app.delete('/api/students/:id', (req, res) => {
  run('DELETE FROM exam_scores WHERE student_id = ?', [req.params.id]);
  run('DELETE FROM students WHERE id = ?', [req.params.id]);
  res.json({ message: '已删除' });
});

// ==================== 考试成绩 ====================
app.get('/api/scores', (req, res) => {
  const { exam_id, student_id, class_name, grade_id } = req.query;
  let sql = `SELECT es.*, stu.name as student_name, stu.student_no, stu.class_name as stu_class,
    e.title as exam_title, e.total_points as exam_total, s.name as subject_name
    FROM exam_scores es
    JOIN students stu ON es.student_id = stu.id
    JOIN exams e ON es.exam_id = e.id
    LEFT JOIN subjects s ON e.subject_id = s.id WHERE 1=1`;
  const params = [];
  if (exam_id) { sql += ' AND es.exam_id = ?'; params.push(exam_id); }
  if (student_id) { sql += ' AND es.student_id = ?'; params.push(student_id); }
  if (class_name) { sql += ' AND stu.class_name = ?'; params.push(class_name); }
  if (grade_id) { sql += ' AND stu.grade_id = ?'; params.push(grade_id); }
  sql += ' ORDER BY es.date_taken DESC, stu.class_name, stu.name';
  res.json(all(sql, params));
});

app.post('/api/scores', (req, res) => {
  const { exam_id, student_id, score, total_points, date_taken, notes } = req.body;
  if (!exam_id || !student_id || score === undefined) return res.status(400).json({ error: '试卷、学员和分数必填' });
  try {
    const id = run('INSERT INTO exam_scores (exam_id, student_id, score, total_points, date_taken, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [exam_id, student_id, score, total_points || 100, date_taken || null, notes || null]);
    res.json({ id, message: '成绩已记录' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/scores/:id', (req, res) => {
  const { score, total_points, date_taken, notes } = req.body;
  run('UPDATE exam_scores SET score=?, total_points=?, date_taken=?, notes=? WHERE id=?',
    [score, total_points || 100, date_taken || null, notes || null, req.params.id]);
  res.json({ message: '已更新' });
});

app.delete('/api/scores/:id', (req, res) => {
  run('DELETE FROM exam_scores WHERE id = ?', [req.params.id]);
  res.json({ message: '已删除' });
});

// ==================== 成绩统计 ====================
app.get('/api/stats/scores', (req, res) => {
  const { exam_id, grade_id, class_name } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (exam_id) { where += ' AND es.exam_id = ?'; params.push(exam_id); }
  if (grade_id) { where += ' AND stu.grade_id = ?'; params.push(grade_id); }
  if (class_name) { where += ' AND stu.class_name = ?'; params.push(class_name); }

  const summary = get(`SELECT
    COUNT(*) as student_count,
    ROUND(AVG(es.score), 1) as avg_score,
    ROUND(MAX(es.score), 1) as max_score,
    ROUND(MIN(es.score), 1) as min_score,
    ROUND(AVG(es.score * 100.0 / es.total_points), 1) as avg_pct
    FROM exam_scores es
    JOIN students stu ON es.student_id = stu.id ${where}`, params);

  const distribution = all(`SELECT
    CASE
      WHEN es.score * 100.0 / es.total_points >= 90 THEN 'A (90-100)'
      WHEN es.score * 100.0 / es.total_points >= 80 THEN 'B (80-89)'
      WHEN es.score * 100.0 / es.total_points >= 70 THEN 'C (70-79)'
      WHEN es.score * 100.0 / es.total_points >= 60 THEN 'D (60-69)'
      ELSE 'E (<60)'
    END as level,
    COUNT(*) as count
    FROM exam_scores es
    JOIN students stu ON es.student_id = stu.id ${where}
    GROUP BY level
    ORDER BY level`, params);

  res.json({ summary, distribution });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📝 考试系统已启动: http://0.0.0.0:${PORT}`);
  console.log(`📋 打开浏览器访问 http://localhost:${PORT}`);
});
