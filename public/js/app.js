// Chart instances
let weeklyBarChart = null;
let monthlyLineChart = null;
let categoryDonutChart = null;

let currentDaysView = 14;
let currentAuthTab = 'login';
let deferredPrompt = null;

document.addEventListener('DOMContentLoaded', () => {
  // 1. Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.log('SW error:', err));
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('btn-install-pwa');
    if (installBtn) {
      installBtn.style.display = 'flex';
      installBtn.addEventListener('click', () => {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choice) => {
          if (choice.outcome === 'accepted') {
            installBtn.style.display = 'none';
            showToast('Installing Habit Studio app...', 'cyan');
          }
          deferredPrompt = null;
        });
      });
    }
  });

  // 2. Horizon Selection
  const daysSelect = document.getElementById('matrix-days-select');
  if (daysSelect) {
    daysSelect.addEventListener('change', (e) => {
      currentDaysView = parseInt(e.target.value) || 14;
      loadMatrix();
    });
  }

  // 3. Quick Habit Creator Forms (Main page & Center FAB Modal)
  const habitForm = document.getElementById('habit-creator-form');
  if (habitForm) {
    habitForm.addEventListener('submit', (e) => handleAddHabitSubmit(e, 'new-habit-title', 'new-habit-category'));
  }

  const fabForm = document.getElementById('fab-habit-form');
  if (fabForm) {
    fabForm.addEventListener('submit', async (e) => {
      await handleAddHabitSubmit(e, 'fab-habit-title', 'fab-habit-category');
      closeModal('modal-add-habit');
    });
  }

  // 4. Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(`chart-view-${tabId}`).style.display = 'block';
    });
  });

  // 5. Excel Export Button
  const btnExport = document.getElementById('btn-export-excel');
  if (btnExport) {
    btnExport.addEventListener('click', triggerExcelExport);
  }

  // 6. Auth Form Handler
  const authForm = document.getElementById('form-auth');
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailOrUsername = document.getElementById('auth-email').value.trim();
      const password = document.getElementById('auth-password').value.trim();
      const username = document.getElementById('auth-username').value.trim();

      const endpoint = currentAuthTab === 'login' ? '/api/auth/login' : '/api/auth/register';
      const body = currentAuthTab === 'login' 
        ? { loginId: emailOrUsername, password }
        : { username, email: emailOrUsername, password };

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
          localStorage.setItem('taskpulse_token', data.token);
          localStorage.setItem('taskpulse_user', data.user.username);
          document.getElementById('auth-modal').style.display = 'none';
          updateUserBadge();
          showToast(`Welcome to your Habit Matrix, @${data.user.username}!`, 'emerald');
          loadMatrix();
          loadAnalytics();
        } else {
          showToast(data.error || 'Authentication failed', 'rose');
        }
      } catch (err) {
        showToast('Connection error', 'rose');
      }
    });
  }

  initAuth();
});

async function handleAddHabitSubmit(e, titleId, categoryId) {
  e.preventDefault();
  const titleInput = document.getElementById(titleId);
  const category = document.getElementById(categoryId).value;

  if (!titleInput.value.trim()) return;

  try {
    const res = await fetchWithAuth('/api/matrix/habit', {
      method: 'POST',
      body: JSON.stringify({ title: titleInput.value.trim(), category })
    });
    const data = await res.json();
    if (data.success) {
      titleInput.value = '';
      showToast('Habit added to your matrix!', 'emerald');
      loadMatrix();
      loadAnalytics();
    }
  } catch (err) {
    console.error(err);
    showToast('Error adding habit', 'rose');
  }
}

// Navigation Bar Handlers matching user screenshot
function navSwitchTo(view) {
  document.querySelectorAll('.nav-item').forEach((el, idx) => {
    if ((view === 'home' && idx === 0) || (view === 'analytics' && idx === 1)) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  const target = view === 'home' ? document.getElementById('section-matrix') : document.getElementById('section-analytics');
  if (target) {
    target.scrollIntoView({ behavior: 'smooth' });
  }
}

function openAddHabitModal() {
  const modal = document.getElementById('modal-add-habit');
  if (modal) {
    modal.style.display = 'flex';
    setTimeout(() => {
      const input = document.getElementById('fab-habit-title');
      if (input) input.focus();
    }, 100);
  }
}

function openProfileModal() {
  const modal = document.getElementById('modal-profile');
  if (modal) {
    const username = localStorage.getItem('taskpulse_user') || 'AmolKumarSingh';
    document.getElementById('profile-modal-name').textContent = `@${username}`;
    const elStreak = document.getElementById('stat-streak');
    document.getElementById('profile-streak-val').textContent = elStreak ? elStreak.textContent : '0 Days';
    modal.style.display = 'flex';
  }
}

function closeModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) m.style.display = 'none';
}

async function triggerExcelExport() {
  showToast('Generating personalized Excel (.xlsx) Report...', 'cyan');
  const token = localStorage.getItem('taskpulse_token');
  const res = await fetch(`/api/excel/export?days=${currentDaysView}`, {
    headers: token ? { 'Authorization': `Bearer ${token}` } : {}
  });
  if (res.ok) {
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Habits_${localStorage.getItem('taskpulse_user') || 'AmolKumarSingh'}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

async function fetchWithAuth(url, options = {}) {
  const token = localStorage.getItem('taskpulse_token');
  const headers = options.headers || {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { ...options, headers });
}

function initAuth() {
  const token = localStorage.getItem('taskpulse_token');
  const username = localStorage.getItem('taskpulse_user');
  if (!token || !username) {
    document.getElementById('auth-modal').style.display = 'flex';
  } else {
    updateUserBadge();
    loadMatrix();
    loadAnalytics();
  }
}

function switchAuthTab(tab) {
  currentAuthTab = tab;
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('field-username').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('label-email').textContent = tab === 'register' ? 'Email Address' : 'Email or Username';
  document.getElementById('btn-auth-submit').textContent = tab === 'register' ? 'Create My Account & Matrix' : 'Sign In to Matrix';
}

async function loginAsDemo() {
  document.getElementById('auth-email').value = 'demo@taskpulse.com';
  document.getElementById('auth-password').value = 'password123';
  document.getElementById('btn-auth-submit').click();
}

function updateUserBadge() {
  const badge = document.getElementById('user-display-name');
  const username = localStorage.getItem('taskpulse_user') || 'AmolKumarSingh';
  if (badge) badge.textContent = `@${username}`;
}

function logoutUser() {
  localStorage.removeItem('taskpulse_token');
  localStorage.removeItem('taskpulse_user');
  document.getElementById('auth-modal').style.display = 'flex';
  showToast('Signed out successfully', 'cyan');
}

async function loadMatrix() {
  const thead = document.getElementById('matrix-thead');
  const tbody = document.getElementById('matrix-tbody');
  const tfoot = document.getElementById('matrix-tfoot');

  if (!thead || !tbody || !tfoot) return;

  try {
    const res = await fetchWithAuth(`/api/matrix?days=${currentDaysView}`);
    if (res.status === 401) return logoutUser();
    
    const data = await res.json();
    if (!data.success) return;

    let headHtml = `<tr>
      <th class="habit-header" style="min-width: 220px;">My Habits (@${localStorage.getItem('taskpulse_user') || 'Amol'})</th>`;
    
    data.dates.forEach(d => {
      headHtml += `
        <th title="${d.date}">
          <span class="day-header-wk">${d.weekday}</span>
          <span class="day-header-num">${d.dayNum}</span>
        </th>`;
    });
    headHtml += `</tr>`;
    thead.innerHTML = headHtml;

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

async function toggleCell(habitId, dateStr) {
  try {
    const res = await fetchWithAuth('/api/matrix/toggle', {
      method: 'PATCH',
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

async function deleteHabit(habitId) {
  if (!confirm('Remove this habit from your private matrix?')) return;
  try {
    await fetchWithAuth(`/api/matrix/habit/${habitId}`, { method: 'DELETE' });
    showToast('Habit removed', 'rose');
    loadMatrix();
    loadAnalytics();
  } catch (err) {
    console.error(err);
  }
}

async function loadAnalytics() {
  try {
    const res = await fetchWithAuth('/api/analytics/summary');
    const data = await res.json();
    if (!data.success) return;

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
        { label: 'Habits Completed', data: completedData, backgroundColor: '#10b981', borderRadius: 6, stack: 'stack0' },
        { label: 'Pending Habits', data: pendingData, backgroundColor: 'rgba(255, 255, 255, 0.12)', borderRadius: 6, stack: 'stack0' }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top', labels: { color: '#94a3b8', font: { family: 'Inter' } } } },
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
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.45)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.0)');

  if (monthlyLineChart) monthlyLineChart.destroy();

  monthlyLineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Daily Completion Rate (%)',
        data: pctData,
        borderColor: '#6366f1',
        borderWidth: 3,
        backgroundColor: gradient,
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointHoverRadius: 6,
        pointBackgroundColor: '#6366f1'
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
  const colors = ['#10b981', '#6366f1', '#8b5cf6', '#f59e0b', '#f43f5e'];

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
      plugins: { legend: { position: 'right', labels: { color: '#94a3b8', font: { family: 'Inter', size: 12 } } } },
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
  if (type === 'cyan') borderColor = '#6366f1';
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
