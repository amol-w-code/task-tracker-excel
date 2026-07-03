const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const jwt = require('jsonwebtoken');
const { dbAsync, hashPassword, seedMatrixForUser } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-habit-matrix-key-2026';

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication Middleware (identifies user from Bearer token or falls back to demo user 1)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.userId = decoded.userId;
      req.username = decoded.username;
      return next();
    } catch (err) {
      // invalid token
    }
  }
  // Default fallback to User 1 (Demo / Amol account) for ease of local testing
  req.userId = 1;
  req.username = 'AmolKumarSingh';
  next();
}

// Helper: get past N days dates formatted
function getDates(daysCount = 14, refDateStr = '2026-07-03') {
  const dates = [];
  const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const refDate = new Date(refDateStr + 'T12:00:00Z');
  
  for (let i = daysCount - 1; i >= 0; i--) {
    const d = new Date(refDate);
    d.setDate(refDate.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    dates.push({
      date: dateStr,
      dayNum: d.getDate(),
      weekday: weekdays[d.getDay()]
    });
  }
  return dates;
}

// ==========================================
// AUTHENTICATION API ENDPOINTS
// ==========================================

// Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'All fields required' });
    }

    const existing = await dbAsync.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username or email already taken' });
    }

    const { hash, salt } = hashPassword(password);
    const result = await dbAsync.run(
      'INSERT INTO users (username, email, password_hash, salt) VALUES (?, ?, ?, ?)',
      [username, email, hash, salt]
    );

    // Seed default matrix for new user
    seedMatrixForUser(result.id);

    const token = jwt.sign({ userId: result.id, username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: result.id, username, email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) {
      return res.status(400).json({ success: false, error: 'Username/Email and password required' });
    }

    const user = await dbAsync.get('SELECT * FROM users WHERE username = ? OR email = ?', [loginId, loginId]);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const { hash } = hashPassword(password, user.salt);
    if (hash !== user.password_hash) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Current User Info
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  const user = await dbAsync.get('SELECT id, username, email FROM users WHERE id = ?', [req.userId]);
  res.json({ success: true, user: user || { id: 1, username: 'AmolKumarSingh', email: 'demo@taskpulse.com' } });
});

// ==========================================
// HABIT MATRIX & EXCEL ENDPOINTS
// ==========================================

app.use(authMiddleware);

// 1. GET Habit Matrix Data
app.get('/api/matrix', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const todayStr = req.query.today || '2026-07-03';
    const dates = getDates(days, todayStr);

    const habits = await dbAsync.all('SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order ASC, id ASC', [req.userId]);
    
    const startDate = dates[0].date;
    const endDate = dates[dates.length - 1].date;
    const habitIds = habits.map(h => h.id);

    let logs = [];
    if (habitIds.length > 0) {
      const placeholders = habitIds.map(() => '?').join(',');
      logs = await dbAsync.all(`
        SELECT habit_id, date, completed 
        FROM habit_logs 
        WHERE habit_id IN (${placeholders}) AND date >= ? AND date <= ?
      `, [...habitIds, startDate, endDate]);
    }

    const logMap = {};
    logs.forEach(row => {
      if (!logMap[row.habit_id]) logMap[row.habit_id] = {};
      logMap[row.habit_id][row.date] = row.completed === 1;
    });

    const dailyStats = dates.map(dObj => {
      let completedCount = 0;
      habits.forEach(h => {
        if (logMap[h.id] && logMap[h.id][dObj.date]) completedCount++;
      });
      const total = habits.length;
      return {
        date: dObj.date,
        completed: completedCount,
        total,
        percentage: total > 0 ? Math.round((completedCount / total) * 100) : 0
      };
    });

    res.json({ success: true, dates, habits, matrix: logMap, dailyStats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Toggle Habit Checkbox
app.patch('/api/matrix/toggle', async (req, res) => {
  try {
    const { habit_id, date } = req.body;
    if (!habit_id || !date) return res.status(400).json({ success: false, error: 'habit_id and date required' });

    // Verify habit belongs to user
    const habit = await dbAsync.get('SELECT id FROM habits WHERE id = ? AND user_id = ?', [habit_id, req.userId]);
    if (!habit) return res.status(403).json({ success: false, error: 'Unauthorized habit access' });

    const row = await dbAsync.get('SELECT completed FROM habit_logs WHERE habit_id = ? AND date = ?', [habit_id, date]);
    let newStatus = 1;
    if (row) {
      newStatus = row.completed === 1 ? 0 : 1;
      await dbAsync.run('UPDATE habit_logs SET completed = ? WHERE habit_id = ? AND date = ?', [newStatus, habit_id, date]);
    } else {
      await dbAsync.run('INSERT INTO habit_logs (habit_id, date, completed) VALUES (?, ?, 1)', [habit_id, date]);
      newStatus = 1;
    }

    res.json({ success: true, completed: newStatus === 1 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Add New Habit
app.post('/api/matrix/habit', async (req, res) => {
  try {
    const { title, category = 'Personal' } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Title required' });

    const maxRow = await dbAsync.get('SELECT MAX(sort_order) as maxOrder FROM habits WHERE user_id = ?', [req.userId]);
    const order = (maxRow && maxRow.maxOrder !== null ? maxRow.maxOrder : 0) + 1;

    const result = await dbAsync.run('INSERT INTO habits (user_id, title, category, sort_order) VALUES (?, ?, ?, ?)', [req.userId, title, category, order]);
    const newHabit = await dbAsync.get('SELECT * FROM habits WHERE id = ?', [result.id]);
    res.json({ success: true, habit: newHabit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete Habit
app.delete('/api/matrix/habit/:id', async (req, res) => {
  try {
    await dbAsync.run('DELETE FROM habits WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Analytics Summary
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const todayStr = req.query.today || '2026-07-03';
    const dates30 = getDates(30, todayStr);
    const habits = await dbAsync.all('SELECT id FROM habits WHERE user_id = ?', [req.userId]);
    const totalHabits = habits.length;

    const habitIds = habits.map(h => h.id);
    let logMap = {};
    if (habitIds.length > 0) {
      const placeholders = habitIds.map(() => '?').join(',');
      const logs = await dbAsync.all(`
        SELECT date, COUNT(*) as completed
        FROM habit_logs
        WHERE habit_id IN (${placeholders}) AND completed = 1 AND date >= ?
        GROUP BY date
      `, [...habitIds, dates30[0].date]);
      logs.forEach(l => logMap[l.date] = l.completed);
    }

    const monthly = dates30.map(d => {
      const completed = logMap[d.date] || 0;
      return {
        date: d.date,
        completed,
        total: totalHabits,
        percentage: totalHabits > 0 ? Math.round((completed / totalHabits) * 100) : 0
      };
    });

    const weekly = monthly.slice(-7);
    const today = monthly[monthly.length - 1] || { completed: 0, total: totalHabits, percentage: 0 };

    let streak = 0;
    for (let i = monthly.length - 1; i >= 0; i--) {
      if (monthly[i].percentage >= 50) streak++;
      else break;
    }

    const categories = await dbAsync.all(`
      SELECT h.category, COUNT(hl.id) as count
      FROM habits h
      LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.completed = 1
      WHERE h.user_id = ?
      GROUP BY h.category
    `, [req.userId]);

    res.json({ success: true, today, weekly, monthly, categories, streak });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Excel Export
app.get('/api/excel/export', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = `TaskPulse Excel Studio (@${req.username})`;
    
    const sheet = workbook.addWorksheet('My Habits Tracker', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }]
    });

    const daysCount = parseInt(req.query.days) || 14;
    const dates = getDates(daysCount, '2026-07-03');
    const habits = await dbAsync.all('SELECT * FROM habits WHERE user_id = ? ORDER BY sort_order ASC, id ASC', [req.userId]);
    
    const habitIds = habits.map(h => h.id);
    const completedMap = {};
    if (habitIds.length > 0) {
      const placeholders = habitIds.map(() => '?').join(',');
      const logs = await dbAsync.all(`SELECT habit_id, date FROM habit_logs WHERE habit_id IN (${placeholders}) AND completed = 1`, habitIds);
      logs.forEach(l => completedMap[`${l.habit_id}_${l.date}`] = true);
    }

    sheet.getColumn(1).width = 34;

    const row1Values = ['Week ->'];
    dates.forEach(d => row1Values.push(d.weekday));
    const row1 = sheet.addRow(row1Values);
    row1.height = 20;
    row1.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF555555' } };
    row1.alignment = { horizontal: 'center', vertical: 'middle' };

    const row2Values = [`My Habits (@${req.username})`];
    dates.forEach(d => row2Values.push(d.dayNum));
    const row2 = sheet.addRow(row2Values);
    row2.height = 28;
    row2.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF222222' } };
    row2.alignment = { horizontal: 'center', vertical: 'middle' };
    
    const a2 = sheet.getCell('A2');
    a2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    a2.alignment = { horizontal: 'center', vertical: 'middle' };

    for (let c = 2; c <= dates.length + 1; c++) {
      sheet.getColumn(c).width = 6.5;
    }

    const startHabitRow = 3;
    habits.forEach((h) => {
      const rowVals = [h.title];
      dates.forEach(d => {
        const isDone = completedMap[`${h.id}_${d.date}`];
        rowVals.push(isDone ? '☑' : '☐');
      });
      const r = sheet.addRow(rowVals);
      r.height = 25;

      const titleCell = r.getCell(1);
      titleCell.font = { name: 'Segoe UI Emoji', size: 11, bold: true, color: { argb: 'FF1B4D3E' } };
      titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

      for (let c = 2; c <= dates.length + 1; c++) {
        const cell = r.getCell(c);
        cell.font = { name: 'Segoe UI Symbol', size: 14 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
          left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
          bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
          right: { style: 'thin', color: { argb: 'FFCCCCCC' } }
        };
      }
    });

    const endHabitRow = startHabitRow + habits.length - 1;
    sheet.addRow([]);

    const progPctVals = ['Progress'];
    dates.forEach((d, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx);
      progPctVals.push({ formula: `COUNTIF(${colLetter}${startHabitRow}:${colLetter}${endHabitRow}, "☑") / ${habits.length || 1}` });
    });
    const pctRow = sheet.addRow(progPctVals);
    pctRow.height = 24;
    pctRow.getCell(1).font = { name: 'Arial', size: 11, bold: true, color: { argb: 'FF333333' } };
    pctRow.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    
    for (let c = 2; c <= dates.length + 1; c++) {
      const cell = pctRow.getCell(c);
      cell.numFmt = '0%';
      cell.font = { name: 'Arial', size: 10, bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
    }

    const progCountVals = [''];
    dates.forEach((d, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx);
      progCountVals.push({ formula: `COUNTIF(${colLetter}${startHabitRow}:${colLetter}${endHabitRow}, "☑")` });
    });
    const countRow = sheet.addRow(progCountVals);
    countRow.height = 22;
    for (let c = 2; c <= dates.length + 1; c++) {
      countRow.getCell(c).font = { name: 'Arial', size: 10 };
      countRow.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Habits_${req.username}_${new Date().toISOString().split('T')[0]}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TaskPulse Excel Studio server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
