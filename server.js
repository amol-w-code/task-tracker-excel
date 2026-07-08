const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { db, hashPassword, comparePassword } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Security: Use env var for JWT secret; generate random fallback for dev only
const JWT_SECRET = process.env.JWT_SECRET || ('dev_fallback_' + crypto.randomBytes(32).toString('hex'));
if (!process.env.JWT_SECRET) {
  console.warn('[SECURITY WARNING] JWT_SECRET not set in environment. Using random dev secret — tokens will not persist across restarts.');
}

// Security: Restrict CORS to known origins
const allowedOrigins = [
  'https://amol-w-code.github.io',
  'http://localhost:3000',
  'http://localhost:5500'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o))) {
      callback(null, true);
    } else if (process.env.VERCEL) {
      callback(null, true); // Allow Vercel preview URLs
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Simple JWT token generator
function generateToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + 86400000 })).toString('base64');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex').slice(0, 32);
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
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex').slice(0, 32);
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
// REAL EMAIL DELIVERY ENGINE (Resend / Nodemailer)
// ==========================================

async function sendVerificationEmail(email, code, username) {
  const htmlTemplate = `
    <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #090e17; color: #f8fafc; padding: 36px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.12);">
      <div style="text-align: center; margin-bottom: 24px;">
        <span style="font-size: 46px;">📊</span>
        <h1 style="color: #6366f1; margin: 10px 0 0; font-size: 26px; font-weight: 800;">TaskPulse Studio</h1>
        <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Daily Habit Matrix & Analytics Engine</p>
      </div>
      <div style="background: rgba(18, 25, 40, 0.85); padding: 28px; border-radius: 14px; border: 1px solid rgba(255,255,255,0.06); text-align: center;">
        <h2 style="font-size: 20px; margin-top: 0; color: #f8fafc;">Verify Your Email Address</h2>
        <p style="color: #cbd5e1; font-size: 15px; line-height: 1.6;">Hello @${username || 'Member'},<br>Use the 6-digit verification code below to confirm your account and unlock your private Habit Matrix:</p>
        <div style="margin: 28px 0; padding: 18px; background: rgba(16, 185, 129, 0.12); border: 2px dashed #10b981; border-radius: 10px;">
          <span style="font-size: 34px; font-weight: 800; letter-spacing: 8px; color: #10b981;">${code}</span>
        </div>
        <p style="color: #64748b; font-size: 13px; margin-bottom: 0;">If you did not initiate this registration, you can safely disregard this email.</p>
      </div>
    </div>
  `;

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'TaskPulse Studio <onboarding@resend.dev>',
          to: [email],
          subject: `🔐 Verify your TaskPulse account (${code})`,
          html: htmlTemplate
        })
      });
      const data = await response.json();
      console.log(`[RESEND EMAIL DISPATCHED] Successfully delivered to ${email} (ID: ${data.id})`);
      return { sent: true, provider: 'Resend' };
    } catch (err) {
      console.error('[Resend Delivery Error]:', err);
    }
  }

  if (process.env.SMTP_HOST || process.env.EMAIL_USER) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT) || 465,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : true,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        }
      });

      await transporter.sendMail({
        from: process.env.EMAIL_FROM || `"TaskPulse Studio" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `🔐 Verify your TaskPulse account (${code})`,
        html: htmlTemplate
      });
      console.log(`[NODEMAILER SMTP DISPATCHED] Real email successfully delivered to ${email}`);
      return { sent: true, provider: 'Nodemailer' };
    } catch (err) {
      console.error('[Nodemailer SMTP Error]:', err.message);
    }
  }

  console.log(`[SIMULATED EMAIL DISPATCH] To: ${email} | Verification Code: ${code}`);
  return { sent: false, provider: 'Simulator' };
}

// ==========================================
// AUTHENTICATION & EMAIL VERIFICATION API
// ==========================================

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long' });
  }

  try {
    const passHash = await hashPassword(password);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    db.run(`INSERT INTO users (username, email, password_hash, is_verified, verification_code) VALUES (?, ?, ?, 0, ?)`,
      [username, email, passHash, verificationCode],
      async function (err) {
        if (err) {
          return res.status(400).json({ error: 'Username or Email already registered' });
        }
        
        const dispatchResult = await sendVerificationEmail(email, verificationCode, username);
        
        return res.json({
          success: true,
          requireVerification: true,
          email,
          emailSent: dispatchResult.sent,
          message: dispatchResult.sent 
            ? `Verification code dispatched to ${email}!`
            : 'A 6-digit verification code has been generated. Check the app for your code.'
        });
      }
    );
  } catch (err) {
    return res.status(500).json({ error: 'Server error during registration' });
  }
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
    if (user.verification_code !== code) {
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

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password) {
    return res.status(400).json({ error: 'Login ID and password required' });
  }

  db.get(`SELECT * FROM users WHERE username = ? OR email = ?`,
    [loginId, loginId],
    async (err, user) => {
      if (err || !user) {
        return res.status(401).json({ error: 'Invalid username/email or password' });
      }

      const isValidPassword = await comparePassword(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid username/email or password' });
      }

      if (user.is_verified === 0) {
        const newCode = Math.floor(100000 + Math.random() * 900000).toString();
        db.run(`UPDATE users SET verification_code = ? WHERE id = ?`, [newCode, user.id]);
        
        const dispatchResult = await sendVerificationEmail(user.email, newCode, user.username);
        
        return res.json({
          success: false,
          requireVerification: true,
          email: user.email,
          emailSent: dispatchResult.sent,
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
  if (!title || title.length > 100) return res.status(400).json({ error: 'Title required (max 100 characters)' });

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
