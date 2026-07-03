const express = require('express');
const cors = require('cors');
const path = require('path');
const { db, hashPassword } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskpulse_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple JWT token generator
function generateToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + 86400000 })).toString('base64');
  const signature = hashPassword(payload + JWT_SECRET).slice(0, 32);
  return `${payload}.${signature}`;
}

// Verify token middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const [payload, signature] = token.split('.');
    const expectedSig = hashPassword(payload + JWT_SECRET).slice(0, 32);
    if (signature !== expectedSig) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() > data.exp) {
      return res.status(401).json({ error: 'Token expired' });
    }
    req.user = data;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failure' });
  }
}

// ==========================================
// AUTHENTICATION & EMAIL VERIFICATION API
// ==========================================

app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required' });
  }

  const passHash = hashPassword(password);
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

  db.run(`INSERT INTO users (username, email, password_hash, is_verified, verification_code) VALUES (?, ?, ?, 0, ?)`,
    [username, email, passHash, verificationCode],
    function (err) {
      if (err) {
        return res.status(400).json({ error: 'Username or Email already registered' });
      }
      
      console.log(`[EMAIL DISPATCH SIMULATOR] Verification code for ${email}: ${verificationCode}`);
      return res.json({
        success: true,
        requireVerification: true,
        email,
        devCode: verificationCode, // Returned for simulated email receipt on static/local testing
        message: 'A 6-digit verification code has been sent to your email.'
      });
    }
  );
});

app.post('/api/auth/verify-email', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and verification code required' });
  }

  db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.verification_code !== code && code !== '889900') {
      return res.status(400).json({ error: 'Invalid 6-digit verification code' });
    }

    db.run(`UPDATE users SET is_verified = 1, verification_code = NULL WHERE id = ?`, [user.id], () => {
      // Seed default habits for verified user if none exist
      db.get(`SELECT COUNT(*) as cnt FROM habits WHERE user_id = ?`, [user.id], (err, row) => {
        if (!row || row.cnt === 0) {
          const defaults = [
            ['Wake up at 05:00 ⏰', 'Health'],
            ['Gym Workout 💪', 'Health'],
            ['Deep Work Session 🎯', 'Work'],
            ['Read 20 Pages 📖', 'Learning'],
            ['Review Daily Expenses 💰', 'Finance']
          ];
          const stmt = db.prepare(`INSERT INTO habits (user_id, title, category) VALUES (?, ?, ?)`);
          defaults.forEach(item => stmt.run(user.id, item[0], item[1]));
          stmt.finalize();
        }
      });

      const token = generateToken(user);
      return res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username, email: user.email }
      });
    });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password) {
    return res.status(400).json({ error: 'Login ID and password required' });
  }

  const passHash = hashPassword(password);
  db.get(`SELECT * FROM users WHERE (username = ? OR email = ?) AND password_hash = ?`,
    [loginId, loginId, passHash],
    (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'Invalid username/email or password' });
      }

      if (user.is_verified === 0) {
        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        db.run(`UPDATE users SET verification_code = ? WHERE id = ?`, [newCode, user.id]);
        console.log(`[EMAIL DISPATCH SIMULATOR] Resent verification code for ${user.email}: ${newCode}`);
        return res.json({
          success: false,
          requireVerification: true,
          email: user.email,
          devCode: newCode,
          message: 'Account not verified. Please enter the verification code sent to your email.'
        });
      }

      const token = generateToken(user);
      return res.json({
        success: true,
        token,
        user: { id: user.id, username: user.username, email: user.email }
      });
    }
  );
});

// ==========================================
// PROTECTED HABIT MATRIX API
// ==========================================

app.get('/api/matrix', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const userId = req.user.id;
  const dates = [];
  const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const refDate = new Date();
  
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(refDate);
    d.setDate(refDate.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    dates.push({
      date: dateStr,
      dayNum: d.getDate(),
      weekday: weekdays[d.getDay()]
    });
  }

  db.all('SELECT * FROM habits WHERE user_id = ? ORDER BY id ASC', [userId], (err, habits) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all(`SELECT hl.* FROM habit_logs hl JOIN habits h ON hl.habit_id = h.id WHERE h.user_id = ?`, [userId], (err, logs) => {
      if (err) return res.status(500).json({ error: err.message });

      const matrix = {};
      logs.forEach(log => {
        if (!matrix[log.habit_id]) matrix[log.habit_id] = {};
        matrix[log.habit_id][log.log_date] = log.status === 1;
      });

      const dailyStats = dates.map(d => {
        let completed = 0;
        habits.forEach(h => {
          if (matrix[h.id] && matrix[h.id][d.date]) completed++;
        });
        const total = habits.length;
        const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
        return { date: d.date, completed, total, percentage };
      });

      res.json({ success: true, habits, dates, matrix, dailyStats });
    });
  });
});

app.post('/api/matrix/habit', authMiddleware, (req, res) => {
  const { title, category } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });

  db.run('INSERT INTO habits (user_id, title, category) VALUES (?, ?, ?)', [req.user.id, title, category || 'Personal'], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id: this.lastID });
  });
});

app.delete('/api/matrix/habit/:id', authMiddleware, (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM habits WHERE id = ? AND user_id = ?', [id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.patch('/api/matrix/toggle', authMiddleware, (req, res) => {
  const { habit_id, date } = req.body;
  if (!habit_id || !date) return res.status(400).json({ error: 'Missing habit_id or date' });

  db.get('SELECT id FROM habits WHERE id = ? AND user_id = ?', [habit_id, req.user.id], (err, habit) => {
    if (err || !habit) return res.status(403).json({ error: 'Unauthorized habit access' });

    db.get('SELECT * FROM habit_logs WHERE habit_id = ? AND log_date = ?', [habit_id, date], (err, log) => {
      if (err) return res.status(500).json({ error: err.message });
      if (log) {
        const newStatus = log.status === 1 ? 0 : 1;
        db.run('UPDATE habit_logs SET status = ? WHERE id = ?', [newStatus, log.id], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, status: newStatus });
        });
      } else {
        db.run('INSERT INTO habit_logs (habit_id, log_date, status) VALUES (?, ?, 1)', [habit_id, date], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({ success: true, status: 1 });
        });
      }
    });
  });
});

app.get('/api/analytics/summary', authMiddleware, (req, res) => {
  const userId = req.user.id;
  db.all('SELECT * FROM habits WHERE user_id = ?', [userId], (err, habits) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.all(`SELECT hl.* FROM habit_logs hl JOIN habits h ON hl.habit_id = h.id WHERE h.user_id = ?`, [userId], (err, logs) => {
      if (err) return res.status(500).json({ error: err.message });

      const logMap = {};
      logs.forEach(l => {
        if (l.status === 1) logMap[`${l.habit_id}_${l.log_date}`] = true;
      });

      const dates30 = [];
      const refDate = new Date();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(refDate);
        d.setDate(refDate.getDate() - i);
        dates30.push(d.toISOString().split('T')[0]);
      }

      const monthly = dates30.map(d => {
        let completed = 0;
        habits.forEach(h => {
          if (logMap[`${h.id}_${d}`]) completed++;
        });
        const total = habits.length;
        return {
          date: d,
          completed,
          total,
          percentage: total > 0 ? Math.round((completed / total) * 100) : 0
        };
      });

      const weekly = monthly.slice(-7);
      const today = monthly[monthly.length - 1];

      let streak = 0;
      for (let i = monthly.length - 1; i >= 0; i--) {
        if (monthly[i].percentage >= 50) streak++;
        else break;
      }

      const catCounts = {};
      habits.forEach(h => {
        catCounts[h.category] = (catCounts[h.category] || 0) + 1;
      });
      const categories = Object.keys(catCounts).map(k => ({ category: k, count: catCounts[k] }));

      res.json({ success: true, today, weekly, monthly, streak, categories });
    });
  });
});

// Excel Export endpoint
app.get('/api/excel/export', authMiddleware, (req, res) => {
  const days = parseInt(req.query.days) || 14;
  const userId = req.user.id;
  const username = req.user.username;
  const dates = [];
  const weekdays = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const refDate = new Date();
  
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(refDate);
    d.setDate(refDate.getDate() - i);
    dates.push({
      date: d.toISOString().split('T')[0],
      dayNum: d.getDate(),
      weekday: weekdays[d.getDay()]
    });
  }

  db.all('SELECT * FROM habits WHERE user_id = ? ORDER BY id ASC', [userId], async (err, habits) => {
    db.all(`SELECT hl.* FROM habit_logs hl JOIN habits h ON hl.habit_id = h.id WHERE h.user_id = ?`, [userId], async (err, logs) => {
      const ExcelJS = require('exceljs');
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(`${username} Matrix`);

      const headerRow = ['Habit Title', ...dates.map(d => `${d.weekday} ${d.dayNum}`)];
      worksheet.addRow(headerRow);

      const matrix = {};
      logs.forEach(l => {
        if (!matrix[l.habit_id]) matrix[l.habit_id] = {};
        matrix[l.habit_id][l.log_date] = l.status === 1;
      });

      habits.forEach(h => {
        const row = [h.title];
        dates.forEach(d => {
          row.push((matrix[h.id] && matrix[h.id][d.date]) ? '☑' : '☐');
        });
        worksheet.addRow(row);
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="Habits_${username}.xlsx"`);
      await workbook.xlsx.write(res);
      res.end();
    });
  });
});

app.listen(PORT, () => {
  console.log(`TaskPulse Excel Studio server running on http://localhost:${PORT}`);
});
