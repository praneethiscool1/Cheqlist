// To-Do Checklist: plain JavaScript (plus the small SortableJS file for drag-and-drop).
// Tasks are saved in the browser's localStorage, so they survive refreshes and restarts.
(function () {
  'use strict';

  // Guard: never start twice on one page (that would create duplicate timers and notifications).
  if (window.__todoChecklistStarted) return;
  window.__todoChecklistStarted = true;

  var STORAGE_KEY = 'todo-checklist-v1'; // same key as older versions, so saved tasks still load
  var BACKUP_KEY = 'todo-checklist-v1-unreadable-backup';
  var COLORS = ['green', 'yellow', 'red'];
  var CHECK_EVERY_MS = 10000;          // how often we look for due reminders
  var ON_TIME_WINDOW_MS = 2 * 60 * 1000; // a reminder up to 2 minutes late still counts as "on time"

  // ---------- Page elements ----------
  var form = document.getElementById('add-form');
  var taskInput = document.getElementById('task-input');
  var draftSlot = document.getElementById('draft-pills');
  var newColorSlot = document.getElementById('new-color-slot');
  var listEl = document.getElementById('task-list');
  var emptyEl = document.getElementById('empty');
  var remindersEl = document.getElementById('reminders');
  var notifyBar = document.getElementById('notify-bar');

  // ---------- Data ----------
  // Each task looks like:
  // { id, text, done,
  //   date: 'YYYY-MM-DD' or ''  (empty = undated, shown under "Anytime"),
  //   color: 'green' | 'yellow' | 'red' | null,
  //   reminder: 'YYYY-MM-DDTHH:MM' or ''  (your local time; empty = no reminder),
  //   notified: true once its reminder has been shown or skipped,
  //   order: number; tasks inside one group are shown in ascending order }
  var tasks = [];
  var needsMigrationSave = false;
  var renderedToday = '';
  var dragging = false;
  var sortables = [];
  var lastNotifyError = '';
  var saveWarningShown = false;
  var canSort = typeof Sortable !== 'undefined';

  // The "new task" form keeps its choices here until you press Add.
  var draft = { date: '', reminder: '', color: null };

  // ---------- Date and time helpers ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayString() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isDateString(v) {
    if (typeof v !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }

  function isTimeString(v) {
    return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  }

  // Returns a clean 'YYYY-MM-DDTHH:MM' or '' if the value is not a real date and time.
  function normalizeReminder(v) {
    if (typeof v !== 'string') return '';
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v.trim());
    if (!m || !isDateString(m[1]) || !isTimeString(m[2])) return '';
    return m[1] + 'T' + m[2];
  }

  function datePart(reminder) { return reminder.slice(0, 10); }
  function timePart(reminder) { return reminder.slice(11, 16); }

  // Milliseconds for a local 'YYYY-MM-DDTHH:MM' (NaN if invalid).
  function reminderMs(reminder) {
    var r = normalizeReminder(reminder);
    if (!r) return NaN;
    return new Date(+r.slice(0, 4), +r.slice(5, 7) - 1, +r.slice(8, 10), +r.slice(11, 13), +r.slice(14, 16)).getTime();
  }

  function parseDateString(v) {
    return new Date(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10));
  }

  // "6:30 PM" from "18:30"
  function formatTime12(t) {
    var h = +t.slice(0, 2);
    return ((h % 12) || 12) + ':' + t.slice(3, 5) + ' ' + (h >= 12 ? 'PM' : 'AM');
  }

  // "Wed, 22 Oct" (the year is added only when it is not this year)
  function formatDayShort(date) {
    var d = parseDateString(date);
    var options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
    return d.toLocaleDateString([], options);
  }

  // What a task shows for its reminder.
  // Dated task, reminder on the task's own date: only the time ("6:30 PM").
  // Otherwise the date is shown too, because nothing else on screen tells you which day it is.
  function reminderLabel(item) {
    if (!item.reminder) return '';
    var time = formatTime12(timePart(item.reminder));
    if (item.date && datePart(item.reminder) === item.date) return time;
    return formatDayShort(datePart(item.reminder)) + ', ' + time;
  }

  function dayLabel(date) {
    var diff = Math.round((parseDateString(date) - parseDateString(renderedToday)) / 86400000);
    var full = formatDayShort(date);
    if (diff === 0) return { main: 'Today', sub: full };
    if (diff === 1) return { main: 'Tomorrow', sub: full };
    if (diff === -1) return { main: 'Yesterday', sub: full };
    return { main: full, sub: '' };
  }

  // Order of the groups: "Anytime" (undated) always first, then today,
  // then coming days (soonest first), then earlier days (most recent first).
  function compareDays(a, b) {
    if (a === b) return 0;
    if (a === '') return -1;
    if (b === '') return 1;
    function rank(d) { return d === renderedToday ? 0 : (d > renderedToday ? 1 : 2); }
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return a < b ? -1 : 1;
    return a < b ? 1 : -1;
  }

  // ---------- Small helpers ----------
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function capitalize(word) { return word.charAt(0).toUpperCase() + word.slice(1); }

  function errText(e) { return e && e.message ? e.message : String(e); }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function findTask(id) {
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return tasks[i];
    return null;
  }

  // A new or moved task goes to the top of its group.
  function topOrder(date, except) {
    var min = null;
    tasks.forEach(function (t) {
      if (t !== except && t.date === date && (min === null || t.order < min)) min = t.order;
    });
    return min === null ? 0 : min - 1;
  }

  // ---------- Saving and loading ----------
  function loadTasks() {
    var raw = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return []; }
    if (!raw) return [];

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Unreadable data: keep a copy instead of overwriting it, and start empty.
      try { localStorage.setItem(BACKUP_KEY, raw); } catch (e2) { /* ignore */ }
      return [];
    }
    if (!Array.isArray(data)) return [];

    var out = [];
    data.forEach(function (t) {
      if (!t || typeof t.text !== 'string') return;
      var reminder = normalizeReminder(t.reminder);
      out.push({
        id: typeof t.id === 'string' ? t.id : makeId(),
        text: t.text,
        done: t.done === true,
        date: isDateString(t.date) ? t.date : '', // older tasks without a date stay undated
        color: COLORS.indexOf(t.color) !== -1 ? t.color : null,
        reminder: reminder,
        notified: reminder ? t.notified === true : false,
        // Older tasks had no "order": use their saved position so the order you saw is kept.
        order: (typeof t.order === 'number' && isFinite(t.order)) ? t.order : out.length
      });
    });
    needsMigrationSave = true;
    return out;
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
      return true;
    } catch (e) {
      if (!saveWarningShown) {
        saveWarningShown = true;
        addBanner('Your browser blocked saving, so tasks will be lost when you close this page.', 'warn');
      }
      return false;
    }
  }

  // ---------- Banners (in-app messages) ----------
  function addBanner(message, kind) {
    var box = el('div', 'banner' + (kind ? ' ' + kind : ''));
    var span = el('span');
    span.textContent = message;
    var dismiss = el('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () { box.remove(); });
    box.appendChild(span);
    box.appendChild(dismiss);
    remindersEl.appendChild(box);
  }

  // ---------- Priority color picker ----------
  // Three dots. Click a dot to choose it; click the chosen dot again to clear it.
  function makeColorPicker(selected, onPick) {
    var box = el('span', 'colors');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Priority color');

    var buttons = COLORS.map(function (color) {
      var b = el('button', 'dot dot-' + color);
      b.type = 'button';
      b.title = capitalize(color);
      b.setAttribute('aria-label', capitalize(color));
      b.addEventListener('click', function () {
        selected = (selected === color) ? null : color;
        paint();
        onPick(selected);
      });
      box.appendChild(b);
      return b;
    });

    function paint() {
      buttons.forEach(function (b, i) {
        var on = COLORS[i] === selected;
        b.classList.toggle('selected', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }

    box.reset = function () { selected = null; paint(); };
    paint();
    return box;
  }

  // ---------- Date and reminder "pills" ----------
  // A pill is a rounded button showing a value. The real date/time input sits invisibly on top,
  // so tapping the pill opens the phone's own picker. An optional x button clears the value.
  function makePill(o) {
    var wrap = el('span', 'pill-wrap');
    var pill = el('label', 'pill' + (o.set ? ' is-set' : '') + (o.overdue ? ' is-overdue' : ''));
    var text = el('span', 'pill-text');
    text.textContent = o.text;
    var input = el('input');
    input.type = o.inputType;
    input.value = o.inputValue || '';
    input.setAttribute('aria-label', o.label);
    input.addEventListener('change', function () { o.onChange(input.value); });
    pill.addEventListener('click', function () {
      try { if (input.showPicker) input.showPicker(); } catch (e) { /* the native input still works */ }
    });
    pill.appendChild(text);
    pill.appendChild(input);
    wrap.appendChild(pill);

    if (o.set && o.onClear) {
      var x = el('button', 'pill-x');
      x.type = 'button';
      x.textContent = '×';
      x.title = o.clearLabel;
      x.setAttribute('aria-label', o.clearLabel);
      x.addEventListener('click', o.onClear);
      wrap.appendChild(x);
    }
    return { wrap: wrap, pill: pill };
  }

  // Turns what the reminder input gave us into a full 'YYYY-MM-DDTHH:MM'.
  // Returns '' (cleared), a string (valid) or null (not usable).
  function parseReminderInput(date, value, timeOnly) {
    if (!value) return '';
    if (timeOnly) {
      if (/^\d{2}:\d{2}:\d{2}$/.test(value)) value = value.slice(0, 5);
      if (!date || !isTimeString(value)) return null;
      return date + 'T' + value;
    }
    return normalizeReminder(value) || null;
  }

  // Moves a reminder onto a new date, keeping its time. Returns '' when the result is already in the past.
  function shiftReminder(reminder, newDate) {
    var shifted = newDate + 'T' + timePart(reminder);
    return reminderMs(shifted) > Date.now() ? shifted : '';
  }

  var PAST_MESSAGE = 'That reminder time has already passed, so no reminder was set.';

  // ---------- The "new task" form ----------
  var newColorPicker = makeColorPicker(null, function (color) { draft.color = color; });
  newColorSlot.appendChild(newColorPicker);

  function renderDraftControls() {
    draftSlot.textContent = '';
    var timeOnly = !!draft.date;

    var datePill = makePill({
      text: draft.date ? formatDayShort(draft.date) : 'Add date',
      set: !!draft.date,
      inputType: 'date',
      inputValue: draft.date,
      label: 'Task date (optional)',
      clearLabel: 'Remove date',
      onChange: function (v) { setDraftDate(isDateString(v) ? v : ''); },
      onClear: function () { setDraftDate(''); }
    });

    var reminderPill = makePill({
      text: draft.reminder ? reminderLabel(draft) : 'Add reminder',
      set: !!draft.reminder,
      inputType: timeOnly ? 'time' : 'datetime-local',
      inputValue: draft.reminder ? (timeOnly ? timePart(draft.reminder) : draft.reminder) : '',
      label: timeOnly ? 'Reminder time (optional)' : 'Reminder date and time (optional)',
      clearLabel: 'Remove reminder',
      onChange: function (v) {
        var r = parseReminderInput(draft.date, v, timeOnly);
        if (r === null) { renderDraftControls(); return; }
        if (r && reminderMs(r) <= Date.now()) { addBanner(PAST_MESSAGE, 'warn'); renderDraftControls(); return; }
        draft.reminder = r;
        renderDraftControls();
      },
      onClear: function () { draft.reminder = ''; renderDraftControls(); }
    });

    draftSlot.appendChild(datePill.wrap);
    draftSlot.appendChild(reminderPill.wrap);
  }

  function setDraftDate(date) {
    draft.date = date;
    if (date && draft.reminder) {
      var shifted = shiftReminder(draft.reminder, date);
      if (!shifted) addBanner('The reminder was removed because that time has already passed on the chosen date.', 'warn');
      draft.reminder = shifted;
    }
    renderDraftControls();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = taskInput.value.trim();
    if (!text) {
      taskInput.focus();
      return;
    }

    var reminder = draft.reminder;
    if (reminder && reminderMs(reminder) <= Date.now()) {
      reminder = '';
      addBanner(PAST_MESSAGE, 'warn');
    }

    var task = {
      id: makeId(),
      text: text,
      done: false,
      date: draft.date,          // stays empty unless you picked a date
      color: draft.color,
      reminder: reminder,
      notified: false,
      order: topOrder(draft.date, null)
    };

    tasks.unshift(task);
    saveTasks();

    taskInput.value = '';
    draft = { date: '', reminder: '', color: null };
    newColorPicker.reset();
    renderDraftControls();
    renderAll();
    taskInput.focus();
    checkReminders();
  });

  // ---------- Changing a task ----------
  function changeTaskDate(task, value) {
    var date = isDateString(value) ? value : '';
    if (date === task.date) { renderAll(); return; }

    task.date = date;
    task.order = topOrder(date, task); // goes to the top of its new group; other tasks keep their order
    if (date && task.reminder) {
      var shifted = shiftReminder(task.reminder, date);
      if (!shifted) addBanner('The reminder for "' + task.text + '" was removed because that time has already passed on the new date.', 'warn');
      task.reminder = shifted;
      task.notified = false;
    }
    saveTasks();
    renderAll();
  }

  function changeTaskReminder(task, value, timeOnly) {
    var r = parseReminderInput(task.date, value, timeOnly);
    if (r === null) { renderAll(); return; }
    if (r && reminderMs(r) <= Date.now()) {
      addBanner(PAST_MESSAGE, 'warn');
      renderAll(); // puts the old value back
      return;
    }
    task.reminder = r;
    task.notified = false; // a changed reminder is a new reminder; the old time no longer applies
    saveTasks();
    renderAll();
    checkReminders();
  }

  // ---------- Drawing one task row ----------
  function isOverdue(task) {
    var due = reminderMs(task.reminder);
    return !task.done && !isNaN(due) && due <= Date.now();
  }

  function renderTask(task) {
    var li = el('li', 'task');
    li.dataset.id = task.id;

    var handle = el('span', 'drag-handle');
    handle.title = 'Drag to reorder';

    var check = el('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', 'Mark task as done');

    var text = el('span', 'task-text');
    text.textContent = task.text;
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.title = 'Tap to edit';

    var del = el('button', 'delete-btn');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete task';
    del.setAttribute('aria-label', 'Delete task');

    var meta = el('div', 'meta');
    var picker = makeColorPicker(task.color, function (color) {
      task.color = color;
      saveTasks();
      paintRow();
    });

    var datePill = makePill({
      text: task.date ? 'Change date' : 'Add date',
      set: !!task.date,
      inputType: 'date',
      inputValue: task.date,
      label: 'Task date (optional)',
      clearLabel: 'Remove date',
      onChange: function (v) { changeTaskDate(task, v); },
      onClear: function () { changeTaskDate(task, ''); }
    });

    var timeOnly = !!task.date;
    var reminderPill = makePill({
      text: task.reminder ? reminderLabel(task) : 'Add reminder',
      set: !!task.reminder,
      overdue: isOverdue(task),
      inputType: timeOnly ? 'time' : 'datetime-local',
      inputValue: task.reminder ? (timeOnly ? timePart(task.reminder) : task.reminder) : '',
      label: timeOnly ? 'Reminder time (optional)' : 'Reminder date and time (optional)',
      clearLabel: 'Remove reminder',
      onChange: function (v) { changeTaskReminder(task, v, timeOnly); },
      onClear: function () {
        task.reminder = '';
        task.notified = false;
        saveTasks();
        renderAll();
      }
    });
    var overdueLabel = el('span', 'overdue-label');
    overdueLabel.textContent = 'Overdue';
    reminderPill.wrap.appendChild(overdueLabel);

    meta.appendChild(picker);
    meta.appendChild(datePill.wrap);
    meta.appendChild(reminderPill.wrap);

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(del);
    li.appendChild(meta);

    // Makes the row look like the task's data.
    function paintRow() {
      li.classList.toggle('done', task.done);
      COLORS.forEach(function (c) { li.classList.toggle('p-' + c, task.color === c); });
      var overdue = isOverdue(task);
      reminderPill.pill.classList.toggle('is-overdue', overdue);
      overdueLabel.hidden = !overdue;
    }
    li.paintRow = paintRow;

    check.addEventListener('change', function () {
      task.done = check.checked;
      saveTasks();
      paintRow();
    });

    del.addEventListener('click', function () {
      tasks = tasks.filter(function (t) { return t.id !== task.id; });
      saveTasks();
      renderAll();
    });

    // Tap the task name to edit it. Enter or tapping away saves; Escape cancels.
    function startEdit() {
      var input = el('input', 'task-edit');
      input.type = 'text';
      input.value = task.text;
      input.maxLength = 200;
      input.setAttribute('aria-label', 'Edit task');
      li.replaceChild(input, text);
      input.focus();
      input.select();

      var finished = false;
      function finish(save) {
        if (finished) return;
        finished = true;
        var v = input.value.trim();
        if (save && v && v !== task.text) {
          task.text = v;
          saveTasks();
        }
        text.textContent = task.text;
        li.replaceChild(text, input);
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { finish(false); }
      });
      input.addEventListener('blur', function () { finish(true); });
    }
    text.addEventListener('click', startEdit);
    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startEdit(); }
    });

    paintRow();
    return li;
  }

  // ---------- Drawing the whole list, grouped by date ----------
  function updateEmpty() {
    emptyEl.hidden = tasks.length > 0;
  }

  function renderAll() {
    if (dragging) return; // never rebuild the list in the middle of a drag

    sortables.forEach(function (s) { try { s.destroy(); } catch (e) { /* ignore */ } });
    sortables = [];
    renderedToday = todayString();
    listEl.textContent = '';

    var byDate = {};
    var dates = [];
    tasks.forEach(function (task) {
      if (!byDate[task.date]) {
        byDate[task.date] = [];
        dates.push(task.date);
      }
      byDate[task.date].push(task);
    });
    dates.sort(compareDays);

    dates.forEach(function (date) {
      // Inside a group the order is exactly the order you chose (the saved "order" number).
      var group = byDate[date].slice().sort(function (a, b) {
        return (a.order - b.order) || (tasks.indexOf(a) - tasks.indexOf(b));
      });

      var section = el('section', 'day' + (date === '' ? ' is-anytime' : '') + (date === renderedToday ? ' is-today' : ''));
      section.dataset.date = date;

      var heading = el('h2', 'day-title');
      if (date === '') {
        heading.textContent = 'Anytime';
        var none = el('span', 'day-date');
        none.textContent = 'No date';
        heading.appendChild(none);
      } else {
        var label = dayLabel(date);
        heading.textContent = label.main;
        if (label.sub) {
          var sub = el('span', 'day-date');
          sub.textContent = label.sub;
          heading.appendChild(sub);
        }
      }

      var list = el('ul', 'task-list');
      group.forEach(function (task) { list.appendChild(renderTask(task)); });
      section.appendChild(heading);
      section.appendChild(list);
      listEl.appendChild(section);

      if (canSort) {
        sortables.push(Sortable.create(list, {
          draggable: '.task',
          handle: '.drag-handle',   // only the grip starts a drag, so taps elsewhere never move a task
          forceFallback: true,       // same behaviour for mouse and touch
          fallbackOnBody: true,
          fallbackTolerance: 3,
          animation: 0,
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          onStart: function () { dragging = true; document.body.classList.add('is-dragging'); },
          onEnd: function () {
            dragging = false;
            document.body.classList.remove('is-dragging');
            saveOrderFromList(list);
          }
        }));
      }
    });

    updateEmpty();
  }

  // Saves the order of one group exactly as it now appears on screen.
  function saveOrderFromList(list) {
    Array.prototype.forEach.call(list.querySelectorAll('.task'), function (li, i) {
      var task = findTask(li.dataset.id);
      if (task) task.order = i;
    });
    saveTasks();
  }

  // ---------- Reminders ----------
  // A reminder is "pending" while the task has a reminder and `notified` is false.
  // Only this one function decides when a reminder fires, and it runs from one timer,
  // so a reminder can never fire twice from a re-draw, refresh or edit.
  //
  //  - Reminder time arrives while the app is open: in-app banner (+ system notification if allowed).
  //  - Task is done when the time arrives: the reminder is skipped silently and never fires later,
  //    even if you untick the task.
  //  - App was closed when the time passed: the next time you open it you get one "Missed reminder"
  //    banner (no system notification for something that old).
  function checkReminders() {
    // A new day started while the app was open: refresh the "Today" heading.
    if (todayString() !== renderedToday) renderAll();

    var now = Date.now();
    var changed = false;

    tasks.forEach(function (task) {
      if (!task.reminder || task.notified) return;
      var due = reminderMs(task.reminder);
      if (isNaN(due)) { task.reminder = ''; changed = true; return; }
      if (due > now) return;

      if (task.done) {
        task.notified = true;
        changed = true;
        return;
      }
      if (!claimReminder(task)) {
        task.notified = true; // another open tab already showed it
        return;
      }
      task.notified = true;
      saveTasks(); // mark as shown before showing, so nothing can show it twice
      if (now - due <= ON_TIME_WINDOW_MS) fireReminder(task);
      else showMissedReminder(task);
    });

    if (changed) saveTasks();

    Array.prototype.forEach.call(listEl.querySelectorAll('.task'), function (li) { li.paintRow(); });
  }

  // If two tabs are open, only the first one to claim a reminder shows it.
  function claimReminder(task) {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      for (var i = 0; i < data.length; i++) {
        if (data[i] && data[i].id === task.id) {
          return !(data[i].notified === true && data[i].reminder === task.reminder);
        }
      }
    } catch (e) { /* if storage can't be read, just show it */ }
    return true;
  }

  function fireReminder(task) {
    // 1) In-app reminder: always works while the page is open.
    addBanner('Reminder: ' + task.text + ' (' + reminderLabel(task) + ')');

    // 2) System notification: only if permission was granted. Delivery is not guaranteed.
    if (notificationsSupported() && Notification.permission === 'granted') {
      showSystemNotification('Task reminder', task.text + ' • ' + reminderLabel(task), 'task-' + task.id)
        .then(function () {
          if (lastNotifyError) { lastNotifyError = ''; refreshNotifyStatus(); }
        })
        .catch(function (e) {
          lastNotifyError = errText(e);
          refreshNotifyStatus();
        });
    }
  }

  function showMissedReminder(task) {
    var when = formatDayShort(datePart(task.reminder)) + ', ' + formatTime12(timePart(task.reminder));
    addBanner('Missed reminder: ' + task.text + ' (was due ' + when + ')');
  }

  setInterval(checkReminders, CHECK_EVERY_MS);
  // Phones slow down timers in background tabs, so also check whenever you come back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { checkReminders(); refreshNotifyStatus(); }
  });
  window.addEventListener('focus', function () { checkReminders(); refreshNotifyStatus(); });
  window.addEventListener('pageshow', checkReminders);

  // Another tab changed the tasks: show the latest.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY) {
      tasks = loadTasks();
      renderAll();
    }
  });

  // ---------- Notifications: what the app can really do ----------
  function notificationsSupported() {
    return 'Notification' in window;
  }

  function getSwRegistration() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration()
      .then(function (reg) { return (reg && reg.active && reg.showNotification) ? reg : null; })
      .catch(function () { return null; });
  }

  // Shows a system notification. Phones only allow this through the service worker,
  // so that is tried first; the plain page API is the fallback (desktop browsers).
  function showSystemNotification(title, body, tag) {
    var options = { body: body, icon: 'icon-192.png', tag: tag }; // same tag = replaces, never duplicates
    return getSwRegistration().then(function (reg) {
      if (reg) return reg.showNotification(title, options);
      return new Promise(function (resolve, reject) {
        try { new Notification(title, options); resolve(); } catch (e) { reject(e); }
      });
    });
  }

  function computeNotifyStatus() {
    if (!notificationsSupported()) {
      return Promise.resolve({ state: 'unsupported', text: 'Notifications are not supported in this browser. Reminders will only appear inside the app while it is open.' });
    }
    if (window.isSecureContext === false) {
      return Promise.resolve({ state: 'unsupported', text: 'Notifications need a secure (https) page, which this is not. Reminders will only appear inside the app while it is open.' });
    }
    var permission = Notification.permission;
    if (permission === 'denied') {
      return Promise.resolve({
        state: 'blocked',
        text: 'Notifications are blocked, so reminders only appear inside the app. To allow them: open your browser or phone settings, go to Site settings (or App info) → Notifications, and allow them for this app. Then reopen it.'
      });
    }
    if (permission !== 'granted') {
      return Promise.resolve({
        state: 'needs-permission',
        action: 'enable',
        text: 'Notifications are off. Reminders only appear inside the app until you allow notifications.'
      });
    }
    if (lastNotifyError) {
      return Promise.resolve({
        state: 'error',
        action: 'test',
        text: 'Permission is granted, but the last notification failed (' + lastNotifyError + '). Reminders still appear inside the app.'
      });
    }
    return getSwRegistration().then(function (reg) {
      if (reg) {
        return {
          state: 'enabled',
          action: 'test',
          text: 'Notifications are allowed and ready. They can appear while the app is open or running in the background. A fully closed app cannot send them.'
        };
      }
      return {
        state: 'limited',
        action: 'test',
        text: 'Notifications are allowed, but the notification service is not active yet. Reload once while online. Reminders still appear inside the app.'
      };
    });
  }

  function renderNotifyBar(status) {
    notifyBar.textContent = '';
    notifyBar.dataset.state = status.state;

    var msg = el('span', 'notify-msg');
    msg.textContent = status.text;
    notifyBar.appendChild(msg);

    if (status.action === 'enable') {
      var enable = el('button', 'notify-btn');
      enable.type = 'button';
      enable.textContent = 'Enable notifications';
      enable.addEventListener('click', requestNotificationPermission);
      notifyBar.appendChild(enable);
    } else if (status.action === 'test') {
      var test = el('button', 'notify-btn');
      test.type = 'button';
      test.textContent = 'Send test notification';
      test.addEventListener('click', sendTestNotification);
      notifyBar.appendChild(test);
    }
  }

  function refreshNotifyStatus() {
    return computeNotifyStatus().then(renderNotifyBar);
  }

  // Only runs when you press the button. The app never asks on its own.
  function requestNotificationPermission() {
    if (!notificationsSupported()) { refreshNotifyStatus(); return; }
    try {
      Promise.resolve(Notification.requestPermission()).then(refreshNotifyStatus, refreshNotifyStatus);
    } catch (e) {
      lastNotifyError = errText(e);
      refreshNotifyStatus();
    }
  }

  function sendTestNotification() {
    showSystemNotification('Test notification', 'If you can see this, notifications work on this device.', 'todo-test')
      .then(function () {
        lastNotifyError = '';
        addBanner('Test notification sent. If nothing appeared on your device, check your phone’s notification settings for this app.');
        refreshNotifyStatus();
      })
      .catch(function (e) {
        lastNotifyError = errText(e);
        refreshNotifyStatus();
      });
  }

  // Keep the status line right if you change the permission in browser settings.
  if (navigator.permissions && navigator.permissions.query) {
    try {
      navigator.permissions.query({ name: 'notifications' }).then(function (status) {
        status.onchange = refreshNotifyStatus;
      }).catch(function () { /* not supported: focus/visibility checks still update it */ });
    } catch (e) { /* ignore */ }
  }

  // ---------- Offline support ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function () {
        return navigator.serviceWorker.ready;
      }).then(refreshNotifyStatus).catch(function () {
        // Not available (for example, the page was opened as a plain file). The app still works.
      });
    });
  }

  // ---------- Start ----------
  if (!canSort) document.body.classList.add('no-sort'); // reordering file missing: hide the grips
  tasks = loadTasks();
  if (needsMigrationSave && tasks.length) saveTasks(); // stores the added fields for older tasks
  renderDraftControls();
  renderAll();
  refreshNotifyStatus();
  checkReminders();
})();
