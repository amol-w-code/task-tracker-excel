const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

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

function initDb() {
  db.serialize(() => {
    // Habits table defines the rows of our matrix
    db.run(`
      CREATE TABLE IF NOT EXISTS habits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT UNIQUE NOT NULL,
        category TEXT DEFAULT 'Personal',
        sort_order INTEGER DEFAULT 0
      )
    `);

    // Habit logs table records completion per day
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
      if (!err) seedMatrix();
    });

    // General daily tasks table
    db.run(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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

function seedMatrix() {
  db.get('SELECT COUNT(*) as count FROM habits', [], (err, row) => {
    if (err) return console.error(err.message);
    if (row && row.count === 0) {
      console.log('Seeding Habit Matrix exactly matching user design...');
      
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

      const insertHabit = db.prepare('INSERT OR IGNORE INTO habits (title, category, sort_order) VALUES (?, ?, ?)');
      defaultHabits.forEach((h, idx) => {
        insertHabit.run(h.title, h.category, idx);
      });
      insertHabit.finalize(() => {
        // Now seed logs for the past 30 days up to today
        db.all('SELECT id, title FROM habits', [], (err, habits) => {
          if (err || !habits) return;
          const insertLog = db.prepare('INSERT OR IGNORE INTO habit_logs (habit_id, date, completed) VALUES (?, ?, ?)');
          
          const today = new Date('2026-07-03T12:00:00Z');
          for (let i = 29; i >= 0; i--) {
            const d = new Date(today);
            d.setDate(today.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            
            habits.forEach((habit, hIdx) => {
              // Create realistic patterns (some habits more completed than others)
              let isCompleted = 0;
              if (i === 0) {
                // Today: set first 3 completed like in screenshot!
                isCompleted = hIdx < 3 ? 1 : 0;
              } else {
                isCompleted = (hIdx * 3 + i) % 3 !== 0 ? 1 : 0;
              }
              insertLog.run(habit.id, dateStr, isCompleted);
            });
          }
          insertLog.finalize(() => {
            console.log('Habit matrix seeded successfully!');
          });
        });
      });
    }
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

module.exports = { db, dbAsync };
