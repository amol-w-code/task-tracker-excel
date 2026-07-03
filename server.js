const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { dbAsync } = require('./src/database');

const app = express();
const PORT = process.env.PORT || 3000;

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// 1. GET Habit Matrix Data
app.get('/api/matrix', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 14;
    const todayStr = req.query.today || '2026-07-03';
    const dates = getDates(days, todayStr);

    const habits = await dbAsync.all('SELECT * FROM habits ORDER BY sort_order ASC, id ASC');
    
    // Fetch logs for these dates
    const startDate = dates[0].date;
    const endDate = dates[dates.length - 1].date;
    const logs = await dbAsync.all(`
      SELECT habit_id, date, completed 
      FROM habit_logs 
      WHERE date >= ? AND date <= ?
    `, [startDate, endDate]);

    // Build lookup
    const logMap = {};
    logs.forEach(row => {
      if (!logMap[row.habit_id]) logMap[row.habit_id] = {};
      logMap[row.habit_id][row.date] = row.completed === 1;
    });

    // Calculate daily progress statistics across the matrix
    const dailyStats = dates.map(dObj => {
      let completedCount = 0;
      habits.forEach(h => {
        if (logMap[h.id] && logMap[h.id][dObj.date]) {
          completedCount++;
        }
      });
      const total = habits.length;
      const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;
      return {
        date: dObj.date,
        completed: completedCount,
        total,
        percentage: pct
      };
    });

    res.json({
      success: true,
      dates,
      habits,
      matrix: logMap,
      dailyStats
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Toggle Habit Checkbox in Matrix
app.patch('/api/matrix/toggle', async (req, res) => {
  try {
    const { habit_id, date } = req.body;
    if (!habit_id || !date) {
      return res.status(400).json({ success: false, error: 'habit_id and date required' });
    }

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

// 3. Add New Habit to Matrix
app.post('/api/matrix/habit', async (req, res) => {
  try {
    const { title, category = 'Personal' } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'Title required' });

    const maxRow = await dbAsync.get('SELECT MAX(sort_order) as maxOrder FROM habits');
    const order = (maxRow && maxRow.maxOrder !== null ? maxRow.maxOrder : 0) + 1;

    const result = await dbAsync.run('INSERT INTO habits (title, category, sort_order) VALUES (?, ?, ?)', [title, category, order]);
    const newHabit = await dbAsync.get('SELECT * FROM habits WHERE id = ?', [result.id]);
    res.json({ success: true, habit: newHabit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Delete Habit from Matrix
app.delete('/api/matrix/habit/:id', async (req, res) => {
  try {
    await dbAsync.run('DELETE FROM habits WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Analytics Summary for Chart.js
app.get('/api/analytics/summary', async (req, res) => {
  try {
    const todayStr = req.query.today || '2026-07-03';
    const dates30 = getDates(30, todayStr);
    const habits = await dbAsync.all('SELECT * FROM habits');
    const totalHabits = habits.length;

    const logs = await dbAsync.all(`
      SELECT date, COUNT(*) as completed
      FROM habit_logs
      WHERE completed = 1 AND date >= ?
      GROUP BY date
    `, [dates30[0].date]);

    const logMap = {};
    logs.forEach(l => logMap[l.date] = l.completed);

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

    // Calculate streak
    let streak = 0;
    for (let i = monthly.length - 1; i >= 0; i--) {
      if (monthly[i].percentage >= 50) streak++;
      else break;
    }

    // Categories breakdown
    const categories = await dbAsync.all(`
      SELECT h.category, COUNT(hl.id) as count
      FROM habits h
      LEFT JOIN habit_logs hl ON h.id = hl.habit_id AND hl.completed = 1
      GROUP BY h.category
    `);

    res.json({ success: true, today, weekly, monthly, categories, streak });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Excel Export EXACTLY Matching Screenshot
app.get('/api/excel/export', async (req, res) => {
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TaskPulse Excel Studio';
    
    // Sheet 1: Habit Matrix Tracker
    const sheet = workbook.addWorksheet('My Habits Tracker', {
      views: [{ state: 'frozen', xSplit: 1, ySplit: 2 }]
    });

    const daysCount = parseInt(req.query.days) || 14;
    const dates = getDates(daysCount, '2026-07-03');
    const habits = await dbAsync.all('SELECT * FROM habits ORDER BY sort_order ASC, id ASC');
    const logs = await dbAsync.all('SELECT habit_id, date, completed FROM habit_logs WHERE completed = 1');
    const completedMap = {};
    logs.forEach(l => {
      completedMap[`${l.habit_id}_${l.date}`] = true;
    });

    // Set Column A width for "My Habits"
    sheet.getColumn(1).width = 34;

    // Row 1: Weekday names across columns B, C, D...
    const row1Values = ['Week ->'];
    dates.forEach(d => row1Values.push(d.weekday));
    const row1 = sheet.addRow(row1Values);
    row1.height = 20;
    row1.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF555555' } };
    row1.alignment = { horizontal: 'center', vertical: 'middle' };

    // Row 2: Header "My Habits" and Day numbers across top
    const row2Values = ['My Habits'];
    dates.forEach(d => row2Values.push(d.dayNum));
    const row2 = sheet.addRow(row2Values);
    row2.height = 28;
    row2.font = { name: 'Arial', size: 12, bold: true, color: { argb: 'FF222222' } };
    row2.alignment = { horizontal: 'center', vertical: 'middle' };
    
    // Style cell A2
    const a2 = sheet.getCell('A2');
    a2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0E0E0' } };
    a2.alignment = { horizontal: 'center', vertical: 'middle' };

    // Set day columns width
    for (let c = 2; c <= dates.length + 1; c++) {
      sheet.getColumn(c).width = 6.5;
    }

    // Add Habit rows
    const startHabitRow = 3;
    habits.forEach((h, idx) => {
      const rowVals = [h.title];
      dates.forEach(d => {
        const isDone = completedMap[`${h.id}_${d.date}`];
        rowVals.push(isDone ? '☑' : '☐');
      });
      const r = sheet.addRow(rowVals);
      r.height = 25;

      // Style Column A (Habit title): Soft sage green fill matching user image!
      const titleCell = r.getCell(1);
      titleCell.font = { name: 'Segoe UI Emoji', size: 11, bold: true, color: { argb: 'FF1B4D3E' } };
      titleCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFC8E6C9' } // Pastel sage green
      };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };

      // Style Checkbox cells
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

    // Blank spacer row
    sheet.addRow([]);

    // Progress Row 1: Percentage
    const progRowIdx = endHabitRow + 2;
    const progPctVals = ['Progress'];
    dates.forEach((d, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx); // B, C, D...
      // Excel formula to count ☑ vs total habits
      progPctVals.push({ formula: `COUNTIF(${colLetter}${startHabitRow}:${colLetter}${endHabitRow}, "☑") / ${habits.length}` });
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

    // Progress Row 2: Count
    const progCountVals = [''];
    dates.forEach((d, cIdx) => {
      const colLetter = String.fromCharCode(66 + cIdx);
      progCountVals.push({ formula: `COUNTIF(${colLetter}${startHabitRow}:${colLetter}${endHabitRow}, "☑")` });
    });
    const countRow = sheet.addRow(progCountVals);
    countRow.height = 22;
    for (let c = 2; c <= dates.length + 1; c++) {
      const cell = countRow.getCell(c);
      cell.font = { name: 'Arial', size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Habit_Matrix_Tracker_${new Date().toISOString().split('T')[0]}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Excel export error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Also keep simple tasks endpoint for compatibility
app.get('/api/tasks', async (req, res) => {
  const tasks = await dbAsync.all('SELECT * FROM tasks');
  res.json({ success: true, tasks });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`TaskPulse Excel Studio server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
