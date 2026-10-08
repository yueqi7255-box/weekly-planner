const els = {
  shell: document.getElementById('app-shell'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  workspace: document.getElementById('workspace'),
  weekViewButton: document.getElementById('week-view-button'),
  listViewButton: document.getElementById('list-view-button'),
  weeklyGoals: document.querySelector('.weekly-goals'),
  dailySection: document.querySelector('.daily-section'),
  weekList: document.getElementById('week-list'),
  weekListScroll: document.getElementById('week-list-scroll'),
  weekListRows: document.getElementById('week-list-rows'),
  longTerm: document.getElementById('long-term'),
  notes: document.getElementById('notes'),
  weekLabel: document.getElementById('week-label'),
  weekPicker: document.getElementById('week-picker'),
  dateButton: document.getElementById('date-button'),
  prevWeek: document.getElementById('prev-week'),
  nextWeek: document.getElementById('next-week'),
  currentWeek: document.getElementById('current-week'),
  goals: {
    learning: document.getElementById('goal-learning'),
    practice: document.getElementById('goal-practice'),
    work: document.getElementById('goal-work'),
  },
  daysGrid: document.getElementById('days-grid'),
  mobileDayRail: document.getElementById('mobile-day-rail'),
  statusButton: document.getElementById('status-button'),
  statusFace: document.getElementById('status-face'),
  statusText: document.getElementById('status-text'),
  statusMenu: document.getElementById('status-menu'),
  colorMenu: document.getElementById('color-menu'),
  moreButton: document.getElementById('more-button'),
  moreMenu: document.getElementById('more-menu'),
  accountName: document.getElementById('account-name'),
  passwordButton: document.getElementById('password-button'),
  logoutButton: document.getElementById('logout-button'),
  passwordDialog: document.getElementById('password-dialog'),
  passwordForm: document.getElementById('password-form'),
  passwordClose: document.getElementById('password-close'),
  passwordError: document.getElementById('password-error'),
  exportButton: document.getElementById('export-button'),
  importButton: document.getElementById('import-button'),
  importFile: document.getElementById('import-file'),
  saveState: document.getElementById('save-state'),
  toast: document.getElementById('toast'),
};

const statusNames = { unset: '未评估', done: '完成', most: '大部分完成', small: '小部分完成', none: '未完成' };
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const goalFields = ['learning', 'practice', 'work'];
const taskClipboardType = 'application/x-weekly-planner-task+json';
const taskColors = new Set(['neutral', 'learning', 'practice', 'work']);
const scheduled = new Map();
const pending = new Set();
const taskSaveTimers = new Set();
let weekStart = startOfWeek(new Date());
let currentStatus = 'unset';
let saveFailure = null;
let openPopover = null;
let colorRow = null;
let loadCounter = 0;
let toastTimer;
let activeView = 'week';
let statusTargetWeek = null;
let listFirstWeek = null;
let listLastWeek = null;
let listGeneration = 0;
let listExtending = false;
let wasMobile = window.innerWidth <= 900;
const listRows = new Map();

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromIso(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12);
}

function dateOffset(value, days) {
  const date = dateFromIso(value);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

function startOfWeek(date) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return localDate(copy);
}

function shortDate(value) {
  const date = dateFromIso(value);
  return `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, '0')}`;
}

function weekLabel(start) {
  const end = dateOffset(start, 6);
  const [year] = start.split('-');
  return `${year}.${shortDate(start)} — ${shortDate(end)}`;
}

function weekNumber(start) {
  const thursday = new Date(`${start}T00:00:00Z`);
  thursday.setUTCDate(thursday.getUTCDate() + 3);
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  return `${year} 第${1 + Math.round((thursday - firstThursday) / 604800000)}周`;
}

function listDateLabel(start) {
  const first = dateFromIso(start);
  const last = dateFromIso(dateOffset(start, 6));
  const end = first.getMonth() === last.getMonth()
    ? `${last.getDate()}日`
    : `${last.getMonth() + 1}月${last.getDate()}日`;
  return `${first.getMonth() + 1}月${first.getDate()}日—${end}`;
}

function visibleWeekLabel(start) {
  const end = dateOffset(start, 6);
  if (window.innerWidth > 900) return weekLabel(start);
  const first = dateFromIso(start);
  const last = dateFromIso(end);
  const firstPart = `${first.getMonth() + 1}/${first.getDate()}`;
  const lastPart = first.getMonth() === last.getMonth()
    ? String(last.getDate())
    : `${last.getMonth() + 1}/${last.getDate()}`;
  return `${firstPart}–${lastPart}`;
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    keepalive: options.keepalive ?? Boolean(options.method && options.method !== 'GET' && url !== '/api/import'),
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) window.location.assign('/login');
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function showToast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.hidden = false;
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 4200);
}

function updateSaveState() {
  const busy = scheduled.size > 0 || taskSaveTimers.size > 0 || pending.size > 0;
  els.saveState.textContent = saveFailure ? '保存失败' : busy ? '保存中' : '已保存';
  els.saveState.classList.toggle('error', Boolean(saveFailure));
}

function track(promise, dot) {
  if (dot) dot.classList.add('pending');
  const task = Promise.resolve(promise)
    .then(value => {
      if (dot) dot.classList.remove('pending', 'error');
      return value;
    })
    .catch(error => {
      saveFailure = error;
      if (dot) dot.classList.add('error');
      showToast(`保存失败：${error.message}`);
      throw error;
    });
  pending.add(task);
  updateSaveState();
  task.finally(() => {
    pending.delete(task);
    updateSaveState();
  }).catch(() => {});
  return task;
}

function schedule(key, action, dot, delay = 500) {
  const existing = scheduled.get(key);
  if (existing) clearTimeout(existing.timer);
  saveFailure = null;
  if (dot) dot.classList.add('pending');
  const item = { action, dot, timer: null };
  item.timer = setTimeout(() => {
    scheduled.delete(key);
    track(action(), dot).catch(() => {});
    updateSaveState();
  }, delay);
  scheduled.set(key, item);
  updateSaveState();
}

async function flushSaves() {
  els.daysGrid.querySelectorAll('.task-row:not(.draft)').forEach(row => {
    if (!row.querySelector('.task-text').textContent.trim()) removeTaskRow(row, false);
  });
  for (const [key, item] of scheduled) {
    clearTimeout(item.timer);
    scheduled.delete(key);
    track(item.action(), item.dot).catch(() => {});
  }
  for (const row of taskSaveTimers) {
    clearTimeout(row._saveTimer);
    row._saveTimer = null;
    taskSaveTimers.delete(row);
    persistRow(row).catch(() => {});
  }
  const results = await Promise.allSettled([...pending]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure || saveFailure) throw failure?.reason || saveFailure;
  updateSaveState();
}

function dotFor(key) {
  return document.getElementById(`${key.replace('_', '-')}-dot`);
}

function bindTextEditors() {
  for (const [key, element] of [['long_term', els.longTerm], ['notes', els.notes]]) {
    element.addEventListener('input', () => {
      schedule(`global:${key}`, () => api(`/api/globals/${key}`, {
        method: 'PUT', body: JSON.stringify({ value: element.value }),
      }), dotFor(key));
    });
  }
  for (const [key, element] of Object.entries(els.goals)) {
    element.addEventListener('input', () => {
      const start = weekStart;
      const listEditor = listRows.get(start)?.querySelector(`[data-field="${key}"]`);
      if (listEditor) {
        listEditor.value = element.value;
        sizeListGoal(listEditor);
      }
      schedule(`week:${start}:${key}`, () => api(`/api/weeks/${start}`, {
        method: 'PUT', body: JSON.stringify({ [key]: element.value }),
      }), dotFor(key));
    });
  }
}

function setStatus(status) {
  currentStatus = status;
  els.statusFace.dataset.status = status;
  els.statusText.textContent = statusNames[status] || '未评估';
  els.statusButton.setAttribute('aria-label', `本周完成度：${els.statusText.textContent}`);
  els.statusMenu.querySelectorAll('[data-status-choice]').forEach(button => {
    if (button.dataset.statusChoice !== 'unset') {
      button.setAttribute('aria-checked', String(button.dataset.statusChoice === status));
    }
  });
}

function setListRowStatus(start, status) {
  const row = listRows.get(start);
  if (!row) return;
  row.dataset.status = status;
  const button = row.querySelector('.week-list-status');
  button.querySelector('.face').dataset.status = status;
  button.setAttribute('aria-label', `${weekNumber(start)}完成度：${statusNames[status]}`);
  button.title = `完成度：${statusNames[status]}`;
}

function positionPopover(popover, anchor, align = 'right') {
  popover.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth;
  const height = popover.offsetHeight;
  const left = align === 'left' ? rect.left : rect.right - width;
  const top = rect.bottom + 6 + height > window.innerHeight ? rect.top - height - 6 : rect.bottom + 6;
  popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}

function closePopovers() {
  for (const popover of [els.statusMenu, els.colorMenu, els.moreMenu]) popover.hidden = true;
  els.statusButton.setAttribute('aria-expanded', 'false');
  els.moreButton.setAttribute('aria-expanded', 'false');
  document.querySelectorAll('.week-list-status[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  document.querySelectorAll('.color-trigger[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  openPopover = null;
  colorRow = null;
}

function togglePopover(popover, anchor, align = 'right') {
  if (openPopover === popover) return closePopovers();
  closePopovers();
  positionPopover(popover, anchor, align);
  openPopover = popover;
  anchor.setAttribute('aria-expanded', 'true');
}

function selectionParts(editable) {
  const selection = window.getSelection();
  const full = editable.textContent || '';
  if (!selection || !selection.rangeCount || !editable.contains(selection.anchorNode)) return [full, ''];
  const range = selection.getRangeAt(0);
  const before = range.cloneRange();
  before.selectNodeContents(editable);
  before.setEnd(range.startContainer, range.startOffset);
  const after = range.cloneRange();
  after.selectNodeContents(editable);
  after.setStart(range.endContainer, range.endOffset);
  return [before.toString(), after.toString()];
}

function focusAt(editable, end = true) {
  editable.focus();
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(!end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function queueRowWrite(row, action) {
  const previous = row._write || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  row._write = next;
  return track(next);
}

function persistRow(row) {
  if (row._deleted) return Promise.resolve();
  clearTimeout(row._saveTimer);
  row._saveTimer = null;
  taskSaveTimers.delete(row);
  updateSaveState();
  const text = row.querySelector('.task-text').textContent.replace(/\r?\n/g, ' ').trim();
  if (!text) return Promise.resolve();
  const color = row.dataset.color;
  const completed = row.querySelector('input[type="checkbox"]').checked;
  return queueRowWrite(row, async () => {
    if (row._deleted) return;
    if (row.dataset.id) {
      await api(`/api/tasks/${row.dataset.id}`, {
        method: 'PATCH', body: JSON.stringify({ text, color, completed }),
      });
      return;
    }
    let previous = row.previousElementSibling;
    while (previous && previous.classList.contains('draft')) previous = previous.previousElementSibling;
    if (previous && !previous.dataset.id && previous.querySelector('.task-text').textContent.trim()) {
      await persistRow(previous);
    } else if (previous?._write) {
      await previous._write.catch(() => {});
    }
    const afterId = previous?.dataset.id ? Number(previous.dataset.id) : null;
    let following = row.nextElementSibling;
    while (following && !following.dataset.id) following = following.nextElementSibling;
    const beforeId = afterId === null && following?.dataset.id ? Number(following.dataset.id) : null;
    const date = row.closest('.day')?.dataset.date;
    if (!date) return;
    const created = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ task_date: date, text, color: row.dataset.color, after_id: afterId, before_id: beforeId }),
    });
    row.dataset.id = String(created.id);
    if (!row._deleted) {
      const latest = row.querySelector('.task-text').textContent.replace(/\r?\n/g, ' ').trim();
      const latestColor = row.dataset.color;
      const latestCompleted = row.querySelector('input[type="checkbox"]').checked;
      if (latest && (latest !== text || latestColor !== color || latestCompleted)) {
        await api(`/api/tasks/${created.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ text: latest, color: latestColor, completed: latestCompleted }),
        });
      }
    }
  });
}

function scheduleRowSave(row) {
  clearTimeout(row._saveTimer);
  taskSaveTimers.add(row);
  row._saveTimer = setTimeout(() => {
    taskSaveTimers.delete(row);
    persistRow(row).catch(() => {});
    row._saveTimer = null;
  }, 450);
  updateSaveState();
}

function promoteDraft(row) {
  if (!row.classList.contains('draft')) return;
  row.classList.remove('draft');
  row.querySelector('input[type="checkbox"]').disabled = false;
  row.querySelector('.task-text').removeAttribute('data-placeholder');
  row.parentElement.append(createTaskRow(null, row.closest('.day').dataset.date, true));
}

function removeTaskRow(row, focusAdjacent = true) {
  if (row._deleted || row.classList.contains('draft')) return;
  row._deleted = true;
  clearTimeout(row._saveTimer);
  taskSaveTimers.delete(row);
  const adjacent = row.previousElementSibling || row.nextElementSibling;
  row.remove();
  if (focusAdjacent && adjacent) focusAt(adjacent.querySelector('.task-text'));
  if (row.dataset.id || row._write) {
    queueRowWrite(row, async () => {
      if (row.dataset.id) await api(`/api/tasks/${row.dataset.id}`, { method: 'DELETE' });
    }).catch(() => {});
  }
}

function createTaskRow(task, date, draft = false) {
  const row = document.createElement('div');
  row.className = `task-row${draft ? ' draft' : ''}${task?.completed ? ' completed' : ''}`;
  row.dataset.color = task?.color || 'neutral';
  if (task?.id) row.dataset.id = String(task.id);

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(task?.completed);
  checkbox.disabled = draft;
  checkbox.setAttribute('aria-label', `${date}任务完成状态`);

  const editable = document.createElement('div');
  editable.className = 'task-text';
  editable.contentEditable = 'plaintext-only';
  editable.role = 'textbox';
  editable.setAttribute('aria-label', `${date}日计划任务`);
  editable.setAttribute('aria-multiline', 'false');
  editable.spellcheck = false;
  editable.textContent = task?.text || '';
  if (draft) editable.dataset.placeholder = '输入计划';

  const colorButton = document.createElement('button');
  colorButton.className = 'color-trigger';
  colorButton.type = 'button';
  colorButton.textContent = '◐';
  colorButton.setAttribute('aria-label', '设置任务文字颜色');
  colorButton.setAttribute('aria-haspopup', 'menu');
  colorButton.setAttribute('aria-expanded', 'false');
  colorButton.title = '任务文字颜色';

  row.append(checkbox, editable, colorButton);

  checkbox.addEventListener('change', () => {
    const completed = checkbox.checked;
    row.classList.toggle('completed', completed);
    persistRow(row).catch(() => {
      checkbox.checked = !completed;
      row.classList.toggle('completed', !completed);
    });
  });

  editable.addEventListener('input', event => {
    if (row.classList.contains('draft') && editable.textContent.trim()) promoteDraft(row);
    if (!row.classList.contains('draft')) scheduleRowSave(row);
  });

  editable.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!editable.textContent.trim()) return;
      const [before, after] = selectionParts(editable);
      if (!before.trim()) {
        const newRow = createTaskRow(null, date);
        row.before(newRow);
        focusAt(newRow.querySelector('.task-text'), false);
        return;
      }
      editable.textContent = before;
      if (before.trim()) {
        if (row.classList.contains('draft')) promoteDraft(row);
        persistRow(row).catch(() => {});
      }
      let next = row.nextElementSibling;
      if (!next || !next.classList.contains('draft') || after.trim()) {
        next = createTaskRow(null, date, !after.trim() && !row.nextElementSibling);
        row.after(next);
        if (after.trim()) {
          next.querySelector('.task-text').textContent = after;
          promoteDraft(next);
          scheduleRowSave(next);
        }
      }
      focusAt(next.querySelector('.task-text'), false);
      return;
    }
    if (event.key === 'Backspace' && !editable.textContent) {
      event.preventDefault();
      if (row.classList.contains('draft')) {
        const previous = row.previousElementSibling;
        if (previous) focusAt(previous.querySelector('.task-text'));
      } else {
        removeTaskRow(row);
      }
    }
  });

  function copyWholeTask(event) {
    const text = editable.textContent;
    const selection = window.getSelection();
    const [before, after] = selectionParts(editable);
    if (!text.trim() || !selection || (!selection.isCollapsed && (before || after))) return false;
    event.clipboardData?.setData('text/plain', text);
    event.clipboardData?.setData(taskClipboardType, JSON.stringify({ version: 1, text,
      color: row.dataset.color, completed: checkbox.checked }));
    event.preventDefault();
    return true;
  }

  editable.addEventListener('copy', copyWholeTask);
  editable.addEventListener('cut', event => {
    if (copyWholeTask(event)) removeTaskRow(row);
  });

  editable.addEventListener('paste', event => {
    let copiedTask;
    try { copiedTask = JSON.parse(event.clipboardData?.getData(taskClipboardType) || 'null'); }
    catch { copiedTask = null; }
    if (copiedTask?.version === 1 && typeof copiedTask.text === 'string' &&
        !copiedTask.text.includes('\n') && taskColors.has(copiedTask.color) &&
        typeof copiedTask.completed === 'boolean') {
      const [before, after] = selectionParts(editable);
      if (!before.trim() && !after.trim()) {
        event.preventDefault();
        editable.textContent = copiedTask.text;
        row.dataset.color = copiedTask.color;
        checkbox.checked = copiedTask.completed;
        row.classList.toggle('completed', copiedTask.completed);
        promoteDraft(row);
        scheduleRowSave(row);
        focusAt(editable);
        return;
      }
    }
    const value = event.clipboardData?.getData('text/plain')?.replace(/\r\n?/g, '\n');
    if (!value?.includes('\n')) return;
    event.preventDefault();
    const lines = value.split('\n');
    const [before, after] = selectionParts(editable);
    editable.textContent = before + lines.shift();
    if (editable.textContent.trim()) promoteDraft(row);
    scheduleRowSave(row);
    let anchor = row;
    lines.forEach((line, index) => {
      const next = createTaskRow(null, date);
      next.querySelector('.task-text').textContent = line + (index === lines.length - 1 ? after : '');
      anchor.after(next);
      if (next.querySelector('.task-text').textContent.trim()) scheduleRowSave(next);
      anchor = next;
    });
    focusAt(anchor.querySelector('.task-text'));
  });

  editable.addEventListener('blur', () => {
    if (row.classList.contains('draft')) return;
    if (!editable.textContent.trim()) removeTaskRow(row, false);
    else persistRow(row).catch(() => {});
  });

  colorButton.addEventListener('click', event => {
    event.stopPropagation();
    togglePopover(els.colorMenu, colorButton, 'left');
    if (!els.colorMenu.hidden) {
      colorRow = row;
      els.colorMenu.querySelectorAll('[data-color-choice]').forEach(button => {
        button.setAttribute('aria-checked', String(button.dataset.colorChoice === row.dataset.color));
      });
    }
  });
  return row;
}

function renderDays(tasks) {
  els.daysGrid.replaceChildren();
  els.mobileDayRail.replaceChildren();
  const today = localDate(new Date());
  for (let index = 0; index < 7; index += 1) {
    const date = dateOffset(weekStart, index);
    const day = document.createElement('article');
    day.className = `day${date === today ? ' today' : ''}`;
    day.dataset.date = date;
    day.id = `day-${date}`;
    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span class="weekday">${weekdays[index]}</span><span class="date">${shortDate(date)}</span>`;
    const editor = document.createElement('div');
    editor.className = 'day-editor';
    editor.setAttribute('aria-label', `${date}日计划`);
    for (const task of tasks[date] || []) editor.append(createTaskRow(task, date));
    editor.append(createTaskRow(null, date, true));
    editor.addEventListener('click', event => {
      if (event.target === editor) focusAt(editor.lastElementChild.querySelector('.task-text'));
    });
    day.append(header, editor);
    els.daysGrid.append(day);

    const railButton = document.createElement('button');
    railButton.type = 'button';
    railButton.textContent = `${weekdays[index].slice(1)} ${shortDate(date)}`;
    railButton.dataset.date = date;
    railButton.classList.toggle('active', index === 0);
    railButton.classList.toggle('today', date === today);
    if (date === today) railButton.setAttribute('aria-label', `今天，${weekdays[index]} ${shortDate(date)}`);
    railButton.addEventListener('click', () => {
      day.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
      setActiveMobileDay(date);
    });
    els.mobileDayRail.append(railButton);
  }
}

function setActiveMobileDay(date) {
  els.mobileDayRail.querySelectorAll('button').forEach(button => {
    button.classList.toggle('active', button.dataset.date === date);
  });
}

function sizeListGoal(element) {
  element.style.height = 'auto';
  element.style.height = `${Math.max(96, element.scrollHeight)}px`;
}

function createListRow(start, week) {
  const row = document.createElement('article');
  row.className = 'week-list-row';
  row.dataset.start = start;

  const weekCell = document.createElement('div');
  weekCell.className = 'week-list-week';
  const weekButton = document.createElement('button');
  weekButton.className = 'week-list-week-button';
  weekButton.type = 'button';
  weekButton.textContent = weekNumber(start);
  weekButton.title = '选中这一周';
  weekButton.addEventListener('click', () => loadWeek(start));

  const statusButton = document.createElement('button');
  statusButton.className = 'week-list-status';
  statusButton.type = 'button';
  statusButton.setAttribute('aria-haspopup', 'menu');
  statusButton.setAttribute('aria-expanded', 'false');
  const face = document.createElement('span');
  face.className = 'face';
  face.setAttribute('aria-hidden', 'true');
  statusButton.append(face);
  statusButton.addEventListener('click', event => {
    event.stopPropagation();
    statusTargetWeek = start;
    togglePopover(els.statusMenu, statusButton, 'left');
    if (!els.statusMenu.hidden) {
      els.statusMenu.querySelectorAll('[data-status-choice]').forEach(button => {
        if (button.dataset.statusChoice !== 'unset') {
          button.setAttribute('aria-checked', String(button.dataset.statusChoice === row.dataset.status));
        }
      });
    }
  });
  weekCell.append(weekButton, statusButton);
  row.append(weekCell);

  const dates = document.createElement('div');
  dates.className = 'week-list-date';
  dates.textContent = listDateLabel(start);
  row.append(dates);

  for (const field of goalFields) {
    const editor = document.createElement('textarea');
    editor.className = 'week-list-goal';
    editor.dataset.field = field;
    editor.rows = 3;
    editor.value = week[field] || '';
    editor.placeholder = `填写${{ learning: '学习', practice: '实践', work: '工作' }[field]}目标`;
    editor.setAttribute('aria-label', `${weekNumber(start)}${{ learning: '学习', practice: '实践', work: '工作' }[field]}目标`);
    editor.spellcheck = false;
    editor.addEventListener('input', () => {
      const value = editor.value;
      sizeListGoal(editor);
      if (start === weekStart) els.goals[field].value = value;
      schedule(`week:${start}:${field}`, () => api(`/api/weeks/${start}`, {
        method: 'PUT', body: JSON.stringify({ [field]: value }),
      }));
    });
    row.append(editor);
  }
  listRows.set(start, row);
  setListRowStatus(start, week.status || 'unset');
  return row;
}

function selectListWeek(start) {
  for (const [key, row] of listRows) row.classList.toggle('selected', key === start);
  if (activeView === 'list' && window.innerWidth > 900) {
    const row = listRows.get(start);
    if (row) {
      const headerHeight = els.weekListScroll.querySelector('.week-list-header').offsetHeight;
      const targetY = els.weekListScroll.getBoundingClientRect().top + headerHeight + (row.previousElementSibling?.offsetHeight || 0);
      els.weekListScroll.scrollTop += row.getBoundingClientRect().top - targetY;
    }
  }
}

async function renderListAround(start) {
  const generation = ++listGeneration;
  listRows.clear();
  listFirstWeek = null;
  listLastWeek = null;
  const loading = document.createElement('div');
  loading.className = 'week-list-message';
  loading.textContent = '正在读取周目标…';
  els.weekListRows.replaceChildren(loading);
  const starts = Array.from({ length: 13 }, (_, index) => dateOffset(start, (index - 5) * 7));
  try {
    const data = await Promise.all(starts.map(value => api(`/api/week?start=${value}`)));
    if (generation !== listGeneration) return;
    const fragment = document.createDocumentFragment();
    data.forEach((item, index) => fragment.append(createListRow(starts[index], item.week)));
    els.weekListRows.replaceChildren(fragment);
    listFirstWeek = starts[0];
    listLastWeek = starts.at(-1);
    els.weekListRows.querySelectorAll('.week-list-goal').forEach(sizeListGoal);
    selectListWeek(start);
  } catch (error) {
    if (generation !== listGeneration) return;
    loading.textContent = '周目标读取失败';
    showToast(`读取失败：${error.message}`);
  }
}

async function extendList(direction) {
  if (listExtending || !listFirstWeek || !listLastWeek) return;
  listExtending = true;
  const generation = listGeneration;
  const edge = direction === 'older' ? listFirstWeek : listLastWeek;
  const starts = Array.from({ length: 5 }, (_, index) =>
    dateOffset(edge, (direction === 'older' ? index - 5 : index + 1) * 7));
  try {
    const data = await Promise.all(starts.map(value => api(`/api/week?start=${value}`)));
    if (generation !== listGeneration) return;
    const beforeHeight = els.weekListScroll.scrollHeight;
    const fragment = document.createDocumentFragment();
    data.forEach((item, index) => fragment.append(createListRow(starts[index], item.week)));
    if (direction === 'older') {
      els.weekListRows.prepend(fragment);
      listFirstWeek = starts[0];
    } else {
      els.weekListRows.append(fragment);
      listLastWeek = starts.at(-1);
    }
    starts.forEach(value => listRows.get(value).querySelectorAll('.week-list-goal').forEach(sizeListGoal));
    if (direction === 'older') els.weekListScroll.scrollTop += els.weekListScroll.scrollHeight - beforeHeight;
  } catch (error) {
    showToast(`读取失败：${error.message}`);
  } finally {
    listExtending = false;
  }
}

async function focusListWeek(start, week) {
  if (!listRows.has(start)) {
    await renderListAround(start);
    return;
  }
  if (week) refreshListRow(start, week);
  selectListWeek(start);
}

function refreshListRow(start, week) {
  const row = listRows.get(start);
  if (!row) return;
  for (const field of goalFields) {
    const editor = row.querySelector(`[data-field="${field}"]`);
    editor.value = week[field] || '';
    sizeListGoal(editor);
  }
  setListRowStatus(start, week.status || 'unset');
}

function applyView() {
  const listVisible = activeView === 'list' && window.innerWidth > 900;
  els.weeklyGoals.hidden = listVisible;
  els.dailySection.hidden = listVisible;
  els.weekList.hidden = !listVisible;
  els.workspace.classList.toggle('list-mode', listVisible);
  els.weekViewButton.classList.toggle('active', !listVisible);
  els.listViewButton.classList.toggle('active', listVisible);
  els.weekViewButton.setAttribute('aria-pressed', String(!listVisible));
  els.listViewButton.setAttribute('aria-pressed', String(listVisible));
  if (listVisible) els.weekListRows.querySelectorAll('.week-list-goal').forEach(sizeListGoal);
  document.title = `${weekLabel(weekStart)} · ${listVisible ? '周目标列表' : '周计划'}`;
}

async function switchView(next) {
  if (activeView === next || window.innerWidth <= 900) return;
  try { await flushSaves(); }
  catch (error) { showToast('当前内容未保存，无法切换视图'); return; }
  closePopovers();
  activeView = next;
  if (next === 'week') listGeneration += 1;
  applyView();
  await loadWeek(weekStart, false);
}

function renderWeek(data) {
  weekStart = data.week_start;
  els.weekLabel.textContent = visibleWeekLabel(weekStart);
  els.weekPicker.value = weekStart;
  els.longTerm.value = data.globals.long_term || '';
  els.notes.value = data.globals.notes || '';
  for (const key of Object.keys(els.goals)) els.goals[key].value = data.week[key] || '';
  setStatus(data.week.status || 'unset');
  refreshListRow(weekStart, data.week);
  renderDays(data.tasks);
  applyView();
}

async function loadWeek(start, flush = true) {
  if (flush) {
    try { await flushSaves(); }
    catch (error) { showToast('当前内容未保存，已留在本周'); return; }
  }
  const request = ++loadCounter;
  try {
    const data = await api(`/api/week?start=${encodeURIComponent(start)}`);
    if (request === loadCounter) {
      renderWeek(data);
      if (activeView === 'list' && window.innerWidth > 900) await focusListWeek(start, data.week);
    }
  } catch (error) {
    showToast(`读取失败：${error.message}`);
  }
}

function bindControls() {
  els.weekViewButton.addEventListener('click', () => switchView('week'));
  els.listViewButton.addEventListener('click', () => switchView('list'));
  els.weekListScroll.addEventListener('scroll', () => {
    if (activeView !== 'list' || window.innerWidth <= 900) return;
    if (els.weekListScroll.scrollTop < 240) extendList('older');
    else if (els.weekListScroll.scrollHeight - els.weekListScroll.clientHeight - els.weekListScroll.scrollTop < 300) extendList('newer');
  }, { passive: true });
  els.prevWeek.addEventListener('click', () => loadWeek(dateOffset(weekStart, -7)));
  els.nextWeek.addEventListener('click', () => loadWeek(dateOffset(weekStart, 7)));
  els.currentWeek.addEventListener('click', () => loadWeek(startOfWeek(new Date())));
  els.dateButton.addEventListener('click', () => {
    els.weekPicker.value = weekStart;
    if (typeof els.weekPicker.showPicker === 'function') els.weekPicker.showPicker();
    else els.weekPicker.click();
  });
  els.weekPicker.addEventListener('change', () => {
    if (els.weekPicker.value) loadWeek(startOfWeek(dateFromIso(els.weekPicker.value)));
  });

  els.statusButton.addEventListener('click', event => {
    event.stopPropagation();
    statusTargetWeek = weekStart;
    togglePopover(els.statusMenu, els.statusButton);
  });
  els.statusMenu.querySelectorAll('[data-status-choice]').forEach(button => {
    button.addEventListener('click', () => {
      const start = statusTargetWeek || weekStart;
      const previous = start === weekStart ? currentStatus : listRows.get(start)?.dataset.status || 'unset';
      const next = button.dataset.statusChoice;
      if (start === weekStart) setStatus(next);
      setListRowStatus(start, next);
      closePopovers();
      track(api(`/api/weeks/${start}`, { method: 'PUT', body: JSON.stringify({ status: next }) }))
        .catch(() => {
          if (start === weekStart) setStatus(previous);
          setListRowStatus(start, previous);
        });
    });
  });

  els.colorMenu.querySelectorAll('[data-color-choice]').forEach(button => {
    button.addEventListener('click', () => {
      const row = colorRow;
      if (!row) return;
      const previous = row.dataset.color;
      const next = button.dataset.colorChoice;
      row.dataset.color = next;
      closePopovers();
      persistRow(row).catch(() => { row.dataset.color = previous; });
      focusAt(row.querySelector('.task-text'));
    });
  });

  els.moreButton.addEventListener('click', event => {
    event.stopPropagation();
    togglePopover(els.moreMenu, els.moreButton);
  });
  els.passwordButton.addEventListener('click', () => {
    closePopovers();
    els.passwordForm.reset();
    els.passwordError.hidden = true;
    els.passwordDialog.showModal();
  });
  els.passwordClose.addEventListener('click', () => els.passwordDialog.close());
  els.passwordForm.addEventListener('submit', async event => {
    event.preventDefault();
    els.passwordError.hidden = true;
    const button = els.passwordForm.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/auth/password', { method: 'POST', body: JSON.stringify({
        current_password: els.passwordForm.elements.current_password.value,
        new_password: els.passwordForm.elements.new_password.value,
      }) });
      els.passwordDialog.close();
      showToast('密码已更新');
    } catch (error) {
      els.passwordError.textContent = error.message;
      els.passwordError.hidden = false;
    } finally { button.disabled = false; }
  });
  els.logoutButton.addEventListener('click', async () => {
    closePopovers();
    try {
      await flushSaves();
      await api('/api/auth/logout', { method: 'POST' });
      window.location.assign('/login');
    } catch (error) { showToast(`退出失败：${error.message}`); }
  });
  els.exportButton.addEventListener('click', async () => {
    closePopovers();
    try {
      await flushSaves();
      const backup = await api('/api/export');
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `weekly-planner-${localDate(new Date())}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { showToast(`导出失败：${error.message}`); }
  });
  els.importButton.addEventListener('click', () => {
    closePopovers();
    els.importFile.click();
  });
  els.importFile.addEventListener('change', async () => {
    const file = els.importFile.files[0];
    els.importFile.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!window.confirm('导入备份会替换当前账号的所有计划、长期目标和便笺。确定继续吗？')) return;
      await flushSaves();
      await api('/api/import', { method: 'POST', body: JSON.stringify(backup) });
      listGeneration += 1;
      listRows.clear();
      listFirstWeek = null;
      listLastWeek = null;
      els.weekListRows.replaceChildren();
      await loadWeek(weekStart, false);
      showToast('数据备份已导入');
    } catch (error) { showToast(`导入失败：${error.message}`); }
  });

  document.addEventListener('click', event => {
    if (openPopover && !openPopover.contains(event.target)) closePopovers();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      closePopovers();
      closeSidebar();
    }
  });
  window.addEventListener('resize', () => {
    const isMobile = window.innerWidth <= 900;
    closePopovers();
    els.weekLabel.textContent = visibleWeekLabel(weekStart);
    applyView();
    if (wasMobile && !isMobile && activeView === 'list') loadWeek(weekStart);
    wasMobile = isMobile;
  });
  els.daysGrid.addEventListener('scroll', () => {
    if (window.innerWidth > 900) return;
    const days = [...els.daysGrid.children];
    const closest = days.reduce((best, day) =>
      Math.abs(day.getBoundingClientRect().left - els.daysGrid.getBoundingClientRect().left) <
      Math.abs(best.getBoundingClientRect().left - els.daysGrid.getBoundingClientRect().left) ? day : best, days[0]);
    if (closest) setActiveMobileDay(closest.dataset.date);
  }, { passive: true });

  els.sidebarToggle.addEventListener('click', () => {
    els.shell.classList.add('sidebar-open');
    els.sidebarBackdrop.hidden = false;
    els.longTerm.focus();
  });
  els.sidebarBackdrop.addEventListener('click', closeSidebar);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSaves().catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    flushSaves().catch(() => {});
  });
}

function closeSidebar() {
  els.shell.classList.remove('sidebar-open');
  els.sidebarBackdrop.hidden = true;
}

api('/api/auth/me').then(({ user }) => {
  els.accountName.textContent = user.username;
  bindTextEditors();
  bindControls();
  applyView();
  loadWeek(weekStart, false);
}).catch(() => {});
