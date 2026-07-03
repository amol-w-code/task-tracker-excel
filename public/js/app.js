// Chart instances
let weeklyBarChart = null;
let monthlyLineChart = null;
let categoryDonutChart = null;

let currentDaysView = 14;

document.addEventListener('DOMContentLoaded', () => {
  const daysSelect = document.getElementById('matrix-days-select');
  if (daysSelect) {
    daysSelect.addEventListener('change', (e) => {
      currentDaysView = parseInt(e.target.value) || 14;
      loadMatrix();
    });
  }

  // Quick Habit Creator Form
  const habitForm = document.getElementById('habit-creator-form');
  if (habitForm) {
    habitForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const titleInput = document.getElementById('new-habit-title');
      const category = document.getElementById('new-habit-category').value;

      if (!titleInput.value.trim()) return;

      try {
        const res = await fetch('/api/matrix/habit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: titleInput.value.trim(), category })
        });
        const data = await res.json();
        if (data.success) {
          titleInput.value = '';
          showToast('Habit added to your spreadsheet!', 'emerald');
          loadMatrix();
          loadAnalytics();
        }
      } catch (err) {
        console.error(err);
        showToast('Error adding habit', 'rose');
      }
    });
  }

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(`chart-view-${tabId}`).style.display = 'block';
    });
  });

  // Excel Export
  const btnExport = document.getElementById('btn-export-excel');
  if (btnExport) {
    btnExport.addEventListener('click', () => {
      showToast('Generating Excel (.xlsx) Report matching screenshot...', 'cyan');
      window.location.href = `/api/excel/export?days=${currentDaysView}`;
    });
  }

  // Initial load
  loadMatrix();
  loadAnalytics();
});

// Load Habit Matrix Grid
async function loadMatrix() {
  const thead = document.getElementById('matrix-thead');
  const tbody = document.getElementById('matrix-tbody');
  const tfoot = document.getElementById('matrix-tfoot');

  if (!thead || !tbody || !tfoot) return;

  try {
    const res = await fetch(`/api/matrix?days=${currentDaysView}`);
    const data = await res.json();
    if (!data.success) return;

    // 1. Build Header Row
    let headHtml = `<tr>
      <th class="habit-header" style="min-width: 240px;">My Habits</th>`;
    
    data.dates.forEach(d => {
      headHtml += `
        <th title="${d.date}">
          <span class="day-header-wk">${d.weekday}</span>
          <span class="day-header-num">${d.dayNum}</span>
        </th>`;
    });
    headHtml += `</tr>`;
    thead.innerHTML = headHtml;

    // 2. Build Habit Rows (with Sage Green background matching user image)
    let bodyHtml = '';
    data.habits.forEach(habit => {
      bodyHtml += `<tr>
        <td class="habit-cell-sage">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span onclick="deleteHabit(${habit.id})" style="cursor:pointer; font-size: 0.8rem; opacity: 0.6;" title="Delete habit">🗑️</span>
            <span>${escapeHtml(habit.title)}</span>
          </div>
        </td>`;

      data.dates.forEach(d => {
        const isChecked = data.matrix[habit.id] && data.matrix[habit.id][d.date];
        bodyHtml += `
          <td>
            <div class="matrix-check-btn ${isChecked ? 'checked' : ''}" 
                 onclick="toggleCell(${habit.id}, '${d.date}')">
              ${isChecked ? '✓' : ''}
            </div>
          </td>`;
      });
      bodyHtml += `</tr>`;
    });
    tbody.innerHTML = bodyHtml;

    // 3. Build Progress Footer Rows matching image!
    let pctRowHtml = `<tr class="progress-row-pct">
      <td style="text-align: left; padding-left: 16px; font-weight:800; color: #f8fafc;">Progress (%)</td>`;
    let countRowHtml = `<tr class="progress-row-cnt">
      <td style="text-align: left; padding-left: 16px; font-weight:600;">Completed Count</td>`;

    data.dailyStats.forEach(s => {
      pctRowHtml += `<td>${s.percentage}%</td>`;
      countRowHtml += `<td>${s.completed} / ${s.total}</td>`;
    });

    pctRowHtml += `</tr>`;
    countRowHtml += `</tr>`;
    tfoot.innerHTML = pctRowHtml + countRowHtml;

  } catch (err) {
    console.error('Error loading matrix:', err);
  }
}

// Toggle Matrix Checkbox
async function toggleCell(habitId, dateStr) {
  try {
    const res = await fetch('/api/matrix/toggle', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ habit_id: habitId, date: dateStr })
    });
    const data = await res.json();
    if (data.success) {
      loadMatrix();
      loadAnalytics();
    }
  } catch (err) {
    console.error(err);
  }
}

// Delete Habit
async function deleteHabit(habitId) {
  if (!confirm('Remove this habit from your tracking matrix?')) return;
  try {
    await fetch(`/api/matrix/habit/${habitId}`, { method: 'DELETE' });
    showToast('Habit removed', 'rose');
    loadMatrix();
    loadAnalytics();
  } catch (err) {
    console.error(err);
  }
}

// Load Analytics Charts
async function loadAnalytics() {
  try {
    const res = await fetch('/api/analytics/summary');
    const data = await res.json();
    if (!data.success) return;

    // Update Pills
    const today = data.today;
    const elPct = document.getElementById('stat-today-pct');
    if (elPct) elPct.textContent = `${today.percentage}%`;
    const elCnt = document.getElementById('stat-today-count');
    if (elCnt) elCnt.textContent = `(${today.completed}/${today.total})`;
    const elBar = document.getElementById('stat-today-bar');
    if (elBar) elBar.style.width = `${today.percentage}%`;
    const elStr = document.getElementById('stat-streak');
    if (elStr) elStr.textContent = `${data.streak} Days`;

    renderWeeklyChart(data.weekly);
    renderMonthlyChart(data.monthly);
    renderCategoryChart(data.categories);
  } catch (err) {
    console.error('Error loading analytics:', err);
  }
}

function renderWeeklyChart(weeklyData) {
  const canvas = document.getElementById('weeklyBarChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const labels = weeklyData.map(d => formatDateShort(d.date));
  const completedData = weeklyData.map(d => d.completed);
  const pendingData = weeklyData.map(d => Math.max(0, d.total - d.completed));

  if (weeklyBarChart) weeklyBarChart.destroy();

  weeklyBarChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Habits Completed',
          data: completedData,
          backgroundColor: '#10b981',
          borderRadius: 6,
          stack: 'stack0'
        },
        {
          label: 'Pending Habits',
          data: pendingData,
          backgroundColor: 'rgba(255, 255, 255, 0.12)',
          borderRadius: 6,
          stack: 'stack0'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#94a3b8', font: { family: 'Inter' } } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#94a3b8' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8', stepSize: 1 } }
      }
    }
  });
}

function renderMonthlyChart(monthlyData) {
  const canvas = document.getElementById('monthlyLineChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const labels = monthlyData.map(d => formatDateShort(d.date));
  const pctData = monthlyData.map(d => d.percentage);

  const gradient = ctx.createLinearGradient(0, 0, 0, 250);
  gradient.addColorStop(0, 'rgba(6, 182, 212, 0.45)');
  gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

  if (monthlyLineChart) monthlyLineChart.destroy();

  monthlyLineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Daily Completion Rate (%)',
        data: pctData,
        borderColor: '#06b6d4',
        borderWidth: 3,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#06b6d4'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b', maxTicksLimit: 10 } },
        y: { beginAtZero: true, max: 100, grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#94a3b8', callback: (val) => `${val}%` } }
      }
    }
  });
}

function renderCategoryChart(categoriesData) {
  const canvas = document.getElementById('categoryDonutChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  const labels = categoriesData.map(c => c.category);
  const data = categoriesData.map(c => c.count);
  const colors = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b', '#f43f5e'];

  if (categoryDonutChart) categoryDonutChart.destroy();

  categoryDonutChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: data.length > 0 ? data : [1],
        backgroundColor: data.length > 0 ? colors : ['#334155'],
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#94a3b8', font: { family: 'Inter', size: 12 } } }
      },
      cutout: '70%'
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatDateShort(dateStr) {
  const parts = dateStr.split('-');
  return `${parts[1]}/${parts[2]}`;
}

function showToast(message, type = 'emerald') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  
  let borderColor = '#10b981';
  if (type === 'cyan') borderColor = '#06b6d4';
  if (type === 'rose') borderColor = '#f43f5e';
  
  toast.style.borderLeftColor = borderColor;
  toast.innerHTML = `<span>⚡</span> <span>${message}</span>`;
  
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}
