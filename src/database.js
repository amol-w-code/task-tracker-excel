const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const isVercel = process.env.VERCEL || process.env.LAMBDA_TASK_ROOT;
const dbDir = isVercel ? '/tmp' : path.join(__dirname, '../database');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'tasks.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    initDb();
  }
});

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function initDb() {
  db.serialize(() => {
    // Users table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Habits table with user_id
    db.run(`
      CREATE TABLE IF NOT EXISTS habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 1,
        title TEXT NOT NULL,
        category TEXT DEFAULT 'Personal',
        sort_order INTEGER DEFAULT 0,
        UNIQUE(user_id, title)
      )
    `);

    // Ensure user_id column exists if upgrading from v1 schema
    db.run(`ALTER TABLE habits ADD COLUMN user_id INTEGER DEFAULT 1`, (err) => {
      // Ignore error if column already exists
    });

    // Habit logs table records completion per day per habit
    db.run(`
      CREATE TABLE IF NOT EXISTS habit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        habit_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        UNIQUE(habit_id, date),
        FOREIGN KEY(habit_id) REFERENCES habits(id) ON DELETE CASCADE
      )
    `, (err) => {
      seedDefaultUserAndMatrix();
    });

    // General daily tasks table
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER DEFAULT 1,
        title TEXT NOT NULL,
        category TEXT DEFAULT 'Work',
        priority TEXT DEFAULT 'Medium',
        date TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        notes TEXT DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });
}

function seedDefaultUserAndMatrix() {
  db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
    if (err || (row && row.count > 0)) return;

    console.log('Seeding default authenticated user (AmolKumarSingh / demo@taskpulse.com)...');
    const { hash, salt } = hashPassword('password123');
    db.run(`
      INSERT INTO users (id, username, email, password_hash, salt)
      VALUES (1, 'AmolKumarSingh', 'demo@taskpulse.com', ?, ?)
    `, [hash, salt], (err) => {
      if (!err) seedMatrixForUser(1);
    });
  });
}

function seedMatrixForUser(userId) {
  const defaultHabits = [
    { title: 'Wake up at 05:00 ⏰', category: 'Health' },
    { title: 'Gym 💪', category: 'Health' },
    { title: 'Stop Watching Porn 🌊', category: 'Personal' },
    { title: 'Reading / Learning 📖', category: 'Learning' },
    { title: 'Budget Tracking 💰', category: 'Finance' },
    { title: 'Project Work 🎯', category: 'Work' },
    { title: 'No Alcohol 🍹', category: 'Health' },
    { title: 'Social Media Detox 🌿', category: 'Personal' },
    { title: 'Goal Journaling 📓', category: 'Learning' },
    { title: 'Cold Shower 🚿', category: 'Health' }
  ];

  const insertHabit = db.prepare('INSERT OR IGNORE INTO habits (user_id, title, category, sort_order) VALUES (?, ?, ?, ?)');
  defaultHabits.forEach((h, idx) => {
    insertHabit.run(userId, h.title, h.category, idx);
  });
  insertHabit.finalize(() => {
    db.all('SELECT id FROM habits WHERE user_id = ?', [userId], (err, habits) => {
      if (err || !habits) return;
      const insertLog = db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, date, completed) VALUES (?, ?, ?)');
      const today = new Date('2026-07-03T12:00:00Z');
      for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        habits.forEach((habit, hIdx) => {
          let isCompleted = i === 0 ? (hIdx < 3 ? 1 : 0) : ((hIdx * 3 + i) % 3 !== 0 ? 1 : 0);
          insertLog.run(habit.id, dateStr, isCompleted);
        });
      }
      insertLog.finalize(() => console.log(`Seeded habit matrix for User ID ${userId}`));
    });
  });
}

const dbAsync = {
  all: (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  }),
  get: (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  }),
  run: (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  })
};

module.exports = { db, dbAsync, hashPassword, seedMatrixForUser };
