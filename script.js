// To-Do Checklist: plain JavaScript (plus the small SortableJS file for drag-and-drop).
// Runs in two places with the same code:
//   1) as a web app / installed web app (GitHub Pages), and
//   2) inside the Android app (built with Capacitor), where it also uses native
//      scheduled notifications and native storage.
// Tasks are saved in localStorage; the Android app also mirrors them into native storage.
(function () {
  'use strict';

  // Guard: never start twice on one page (that would create duplicate timers and notifications).
  if (window.__todoChecklistStarted) return;
  window.__todoChecklistStarted = true;

  var STORAGE_KEY = 'todo-checklist-v1'; // same key as older versions, so saved tasks still load
  var BACKUP_KEY = 'todo-checklist-v1-unreadable-backup';
  var COLORS = ['green', 'yellow', 'red'];
  var CHECK_EVERY_MS = 10000;             // how often the open app looks for due reminders
  var ON_TIME_WINDOW_MS = 2 * 60 * 1000;  // a reminder up to 2 minutes late still counts as "on time"
  var DESC_MAX = 1000;
  var MAX_NID = 2000000000;               // native notification ids stay below this
  var TEST_NOTIFICATION_ID = 2100000000;  // reserved for the "test notification" button
  var CHANNEL_ID = 'reminders';

  // ---------- Page elements ----------
  var form = document.getElementById('add-form');
  var taskInput = document.getElementById('task-input');
  var descInput = document.getElementById('new-desc');
  var draftSlot = document.getElementById('draft-pills');
  var newColorSlot = document.getElementById('new-color-slot');
  var listEl = document.getElementById('task-list');
  var emptyEl = document.getElementById('empty');
  var remindersEl = document.getElementById('reminders');
  var notifyBar = document.getElementById('notify-bar');

  // ---------- Are we inside the Android app? ----------
  var LN = null;    // native scheduled notifications
  var Prefs = null; // native key/value storage
  try {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' &&
        window.Capacitor.isNativePlatform() && typeof window.Capacitor.registerPlugin === 'function') {
      LN = window.Capacitor.registerPlugin('LocalNotifications');
      Prefs = window.Capacitor.registerPlugin('Preferences');
    }
  } catch (e) {
    LN = null;
    Prefs = null;
  }
  var isNativeApp = !!LN;

  // ---------- Data ----------
  // Each task looks like:
  // { id, nid, text, description, done,
  //   date: 'YYYY-MM-DD' or ''   (empty = undated),
  //   slot: for undated tasks only: where it sits among the date groups.
  //         '^' = above everything, '$' = below everything, 'YYYY-MM-DD' = just above that date's group,
  //   color: 'green' | 'yellow' | 'red' | null,
  //   reminder: 'YYYY-MM-DDTHH:MM' or ''   (your local time),
  //   notified: true once its reminder has been shown or skipped,
  //   order: number; tasks in the same list are shown in ascending order }
  var tasks = [];
  var needsMigrationSave = false;
  var renderedToday = '';
  var dragging = false;
  var sortables = [];
  var lastNotifyError = '';
  var saveWarningShown = false;
  var canSort = typeof Sortable !== 'undefined';
  var booted = false;
  var justAddedId = '';

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

  // Order of the date groups: today, then coming days (soonest first), then earlier days (most recent first).
  function compareDays(a, b) {
    if (a === b) return 0;
    function rank(d) { return d === renderedToday ? 0 : (d > renderedToday ? 1 : 2); }
    var ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 1) return a < b ? -1 : 1;
    return a < b ? 1 : -1;
  }

  // ---------- Header: today's weekday and date ----------
  var heroDay = document.getElementById('hero-day');
  var heroDate = document.getElementById('hero-date');
  function updateHero() {
    var now = new Date();
    if (heroDay) heroDay.textContent = now.toLocaleDateString([], { weekday: 'long' });
    if (heroDate) heroDate.textContent = now.toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // Motion is skipped when the phone asks for reduced motion (and in environments without matchMedia).
  function motionAllowed() {
    try {
      return !!(window.matchMedia && !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
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

  function nextNid() {
    var max = 0;
    tasks.forEach(function (t) { if (t.nid > max) max = t.nid; });
    return max + 1;
  }

  function firstLine(text, max) {
    var line = String(text).split('\n')[0].trim();
    return line.length > max ? line.slice(0, max - 1) + '…' : line;
  }

  // ---------- Where tasks sit ----------
  // Dated tasks live in one group per date. Undated tasks are free to sit anywhere between
  // (or above or below) the date groups. The segments are the gaps around the date groups:
  // segment 0 is above the first group, segment N is below the last one.
  function datedKeys() {
    var seen = {};
    var keys = [];
    tasks.forEach(function (t) {
      if (t.date && !seen[t.date]) { seen[t.date] = true; keys.push(t.date); }
    });
    keys.sort(compareDays);
    return keys;
  }

  // Which segment an undated task currently belongs to. A task whose anchor date has no tasks
  // any more simply sits above the next date group that still exists.
  function segmentIndex(task, keys) {
    if (task.slot === '$') return keys.length;
    if (!isDateString(task.slot)) return 0;
    for (var k = 0; k < keys.length; k++) {
      if (compareDays(keys[k], task.slot) >= 0) return k;
    }
    return keys.length;
  }

  // The anchor to save for a task dropped into segment k.
  function slotForSegment(k, keys) {
    if (k <= 0) return '^';
    if (k >= keys.length) return '$';
    return keys[k];
  }

  // A new or moved task goes to the top of its group / segment.
  function topOrder(date, except) {
    var min = null;
    tasks.forEach(function (t) {
      if (t !== except && t.date === date && (min === null || t.order < min)) min = t.order;
    });
    return min === null ? 0 : min - 1;
  }

  function topOrderFloating(segment, except) {
    var keys = datedKeys();
    var min = null;
    tasks.forEach(function (t) {
      if (t === except || t.date !== '' || segmentIndex(t, keys) !== segment) return;
      if (min === null || t.order < min) min = t.order;
    });
    return min === null ? 0 : min - 1;
  }

  // ---------- Saving and loading ----------
  // Turns saved or imported data into clean task objects. Older versions of the data
  // (no date, no order, no description, ...) are upgraded here without losing anything.
  function normalizeTasks(data) {
    var out = [];
    var seenIds = {};
    var seenNids = {};
    var maxNid = 0;

    data.forEach(function (t) {
      if (!t || typeof t.text !== 'string') return;
      var id = (typeof t.id === 'string' && t.id && !seenIds[t.id]) ? t.id : makeId();
      seenIds[id] = true;

      var nid = (typeof t.nid === 'number' && t.nid >= 1 && t.nid <= MAX_NID && Math.floor(t.nid) === t.nid && !seenNids[t.nid]) ? t.nid : 0;
      if (nid) { seenNids[nid] = true; if (nid > maxNid) maxNid = nid; }

      var date = isDateString(t.date) ? t.date : '';
      var reminder = normalizeReminder(t.reminder);
      var slot = '';
      if (!date) slot = (t.slot === '^' || t.slot === '$' || isDateString(t.slot)) ? t.slot : '^';

      out.push({
        id: id,
        nid: nid,
        text: t.text,
        description: typeof t.description === 'string' ? t.description.slice(0, DESC_MAX) : '',
        done: t.done === true,
        date: date,
        slot: slot,
        color: COLORS.indexOf(t.color) !== -1 ? t.color : null,
        reminder: reminder,
        notified: reminder ? t.notified === true : false,
        // Older tasks had no "order": use their saved position so the order you saw is kept.
        order: (typeof t.order === 'number' && isFinite(t.order)) ? t.order : out.length
      });
    });

    out.forEach(function (t) { if (!t.nid) t.nid = ++maxNid; });
    return out;
  }

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
    needsMigrationSave = true;
    return normalizeTasks(data);
  }

  function saveTasks() {
    var json;
    try {
      json = JSON.stringify(tasks);
      localStorage.setItem(STORAGE_KEY, json);
    } catch (e) {
      if (!saveWarningShown) {
        saveWarningShown = true;
        addBanner('Your browser blocked saving, so tasks will be lost when you close this page.', 'warn');
      }
      return false;
    }
    // Android app: keep a second copy in native storage, and keep the phone's alarms in step.
    if (Prefs) {
      try { Prefs.set({ key: STORAGE_KEY, value: json }).catch(function () { /* the copy in localStorage is still there */ }); } catch (e) { /* ignore */ }
    }
    scheduleNativeSync();
    return true;
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
    var pill = el('label', 'pill kind-' + o.inputType + (o.set ? ' is-set' : '') + (o.overdue ? ' is-overdue' : ''));
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

  // A plain pill-shaped button (used for "Add description").
  function makeButtonPill(text, onClick) {
    var b = el('button', 'pill pill-button kind-note');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
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

  var descButton = makeButtonPill('Add description', function () {
    descInput.hidden = !descInput.hidden;
    if (!descInput.hidden) descInput.focus();
    updateDescButton();
  });
  descButton.setAttribute('aria-controls', 'new-desc');
  descInput.addEventListener('input', updateDescButton);

  function updateDescButton() {
    var has = descInput.value.trim() !== '';
    descButton.textContent = descInput.hidden ? (has ? 'Edit description' : 'Add description') : 'Hide description';
    descButton.classList.toggle('is-set', has);
    descButton.setAttribute('aria-expanded', descInput.hidden ? 'false' : 'true');
  }

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
    draftSlot.appendChild(descButton);
    updateDescButton();
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

    var undated = draft.date === '';
    var task = {
      id: makeId(),
      nid: nextNid(),
      text: text,
      description: descInput.value.trim().slice(0, DESC_MAX),
      done: false,
      date: draft.date,          // stays empty unless you picked a date
      slot: undated ? '^' : '',  // a new undated task goes to the very top
      color: draft.color,
      reminder: reminder,
      notified: false,
      order: undated ? topOrderFloating(0, null) : topOrder(draft.date, null)
    };

    tasks.unshift(task);
    justAddedId = task.id;
    saveTasks();

    taskInput.value = '';
    descInput.value = '';
    descInput.hidden = true;
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
    if (date) {
      task.slot = '';
      task.order = topOrder(date, task); // top of its new group; other tasks keep their order
      if (task.reminder) {
        var shifted = shiftReminder(task.reminder, date);
        if (!shifted) addBanner('The reminder for "' + task.text + '" was removed because that time has already passed on the new date.', 'warn');
        task.reminder = shifted;
        task.notified = false;
      }
    } else {
      task.slot = '^';                    // an undated task goes to the very top
      task.order = topOrderFloating(0, task);
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
    if (task.id === justAddedId) { li.classList.add('enter'); justAddedId = ''; }

    var handle = el('span', 'drag-handle');
    handle.title = 'Drag to reorder';

    var check = el('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', 'Mark task as done');

    var main = el('div', 'task-main');
    var text = el('span', 'task-text');
    text.textContent = task.text;
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.title = 'Tap to edit';
    main.appendChild(text);

    var descEl = null;
    if (task.description) {
      descEl = el('div', 'task-desc');
      descEl.textContent = task.description;
      descEl.tabIndex = 0;
      descEl.setAttribute('role', 'button');
      descEl.title = 'Tap to edit the description';
      main.appendChild(descEl);
    }

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
    if (!task.description) {
      meta.appendChild(makeButtonPill('Add description', function () { startDescEdit(); }));
    }

    li.appendChild(handle);
    li.appendChild(check);
    li.appendChild(main);
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

    var removing = false;
    del.addEventListener('click', function () {
      if (removing) return;
      removing = true;
      tasks = tasks.filter(function (t) { return t.id !== task.id; });
      saveTasks();
      if (!motionAllowed()) { renderAll(); return; }
      // Slide the row out, then redraw. The task is already gone from the saved data.
      li.style.maxHeight = li.offsetHeight + 'px';
      void li.offsetHeight;
      li.classList.add('leaving');
      setTimeout(renderAll, 300);
    });

    // Tap the task name to edit it. Enter or tapping away saves; Escape cancels.
    function startEdit() {
      var input = el('input', 'task-edit');
      input.type = 'text';
      input.value = task.text;
      input.maxLength = 200;
      input.setAttribute('aria-label', 'Edit task');
      main.replaceChild(input, text);
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
        main.replaceChild(text, input);
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

    // Add or edit the description. Save and Cancel are explicit buttons so nothing is lost by accident.
    function startDescEdit() {
      if (main.querySelector('.desc-editor')) return;
      var box = el('div', 'desc-editor');
      var area = el('textarea');
      area.rows = 3;
      area.maxLength = DESC_MAX;
      area.value = task.description;
      area.placeholder = 'Description (optional)';
      area.setAttribute('aria-label', 'Task description');
      var actions = el('div', 'desc-actions');
      var save = el('button', 'desc-save');
      save.type = 'button';
      save.textContent = 'Save';
      var cancel = el('button', 'desc-cancel');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      actions.appendChild(save);
      actions.appendChild(cancel);
      box.appendChild(area);
      box.appendChild(actions);
      if (descEl) descEl.hidden = true;
      main.appendChild(box);
      area.focus();

      function close() {
        box.remove();
        if (descEl) descEl.hidden = false;
      }
      save.addEventListener('click', function () {
        task.description = area.value.trim().slice(0, DESC_MAX);
        saveTasks();
        renderAll();
      });
      cancel.addEventListener('click', close);
      area.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
      });
    }
    if (descEl) {
      descEl.addEventListener('click', startDescEdit);
      descEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startDescEdit(); }
      });
    }

    paintRow();
    return li;
  }

  // ---------- Drawing the whole list ----------
  function updateEmpty() {
    emptyEl.hidden = tasks.length > 0;
  }

  function byOrder(a, b) {
    return (a.order - b.order) || (tasks.indexOf(a) - tasks.indexOf(b));
  }

  function renderAll() {
    if (dragging) return; // never rebuild the list in the middle of a drag

    sortables.forEach(function (s) { try { s.destroy(); } catch (e) { /* ignore */ } });
    sortables = [];
    renderedToday = todayString();
    updateHero();
    listEl.textContent = '';

    var keys = datedKeys();
    var datedBy = {};
    var segments = [];
    for (var s = 0; s <= keys.length; s++) segments.push([]);
    var anyUndated = false;

    tasks.forEach(function (task) {
      if (task.date) {
        (datedBy[task.date] = datedBy[task.date] || []).push(task);
      } else {
        anyUndated = true;
        segments[segmentIndex(task, keys)].push(task);
      }
    });

    for (var k = 0; k <= keys.length; k++) {
      // Undated tasks: one list per gap, so they can be dropped above, between or below the date groups.
      if (anyUndated) listEl.appendChild(renderFloatingSegment(k, segments[k].sort(byOrder), slotForSegment(k, keys)));
      if (k < keys.length) listEl.appendChild(renderDateGroup(keys[k], datedBy[keys[k]].sort(byOrder)));
    }

    updateEmpty();
  }

  function renderDateGroup(date, group) {
    var section = el('section', 'day' + (date === renderedToday ? ' is-today' : ''));
    section.dataset.date = date;

    var heading = el('h2', 'day-title');
    var label = dayLabel(date);
    heading.textContent = label.main;
    if (label.sub) {
      var sub = el('span', 'day-date');
      sub.textContent = label.sub;
      heading.appendChild(sub);
    }

    var list = el('ul', 'task-list');
    group.forEach(function (task) { list.appendChild(renderTask(task)); });
    section.appendChild(heading);
    section.appendChild(list);
    makeSortable(list, 'date-' + date);
    return section;
  }

  function renderFloatingSegment(index, group, slot) {
    var section = el('section', 'floating' + (group.length ? '' : ' is-empty'));
    section.dataset.segment = String(index);
    section.dataset.slot = slot;

    var heading = el('h2', 'day-title seg-title');
    heading.textContent = 'Anytime';
    var none = el('span', 'day-date');
    none.textContent = 'No date';
    heading.appendChild(none);

    var list = el('ul', 'task-list floating-list');
    list.dataset.slot = slot;
    group.forEach(function (task) { list.appendChild(renderTask(task)); });
    section.appendChild(heading);
    section.appendChild(list);
    makeSortable(list, 'floating');
    return section;
  }

  // Dated groups only reorder inside themselves. All the "Anytime" lists share one group name,
  // so an undated task can be dragged from any of them into any other.
  function makeSortable(list, groupName) {
    if (!canSort) return;
    sortables.push(Sortable.create(list, {
      group: groupName,
      draggable: '.task',
      handle: '.drag-handle',   // only the grip starts a drag, so taps elsewhere never move a task
      forceFallback: true,       // same behaviour for mouse and touch
      fallbackOnBody: true,
      fallbackTolerance: 3,
      emptyInsertThreshold: 32,  // lets you drop into an empty gap
      scrollSensitivity: 80,
      animation: 0,
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onStart: function () { dragging = true; document.body.classList.add('is-dragging'); },
      onEnd: onDragEnd
    }));
  }

  // Saves exactly what is on screen: the order of each list that was touched, and for undated
  // tasks the gap they now sit in.
  function onDragEnd(evt) {
    dragging = false;
    document.body.classList.remove('is-dragging');

    var lists = [evt.from];
    if (evt.to && evt.to !== evt.from) lists.push(evt.to);
    lists.forEach(function (list) {
      var slot = list.dataset.slot; // only the "Anytime" lists have one
      Array.prototype.filter.call(list.children, function (c) { return c.classList.contains('task'); })
        .forEach(function (li, i) {
          var task = findTask(li.dataset.id);
          if (!task) return;
          task.order = i;
          if (slot !== undefined && task.date === '') task.slot = slot;
        });
    });
    saveTasks();

    // Moved to a different gap: redraw so headings and empty gaps are right.
    // Done after Sortable has finished with this drag.
    if (evt.to && evt.to !== evt.from) setTimeout(renderAll, 0);
  }

  // ---------- Reminders ----------
  // A reminder is "pending" while the task has a reminder and `notified` is false.
  // Only this one function decides when the open app shows a reminder, and it runs from one timer,
  // so a reminder can never show twice from a re-draw, refresh or edit.
  //
  //  - Reminder time arrives while the app is open: in-app banner (+ a system notification on the web;
  //    in the Android app the phone's own alarm shows the notification).
  //  - Task is done when the time arrives: the reminder is skipped silently and never fires later,
  //    even if you untick the task.
  //  - The time passed while the app was closed: the next time you open it you get one "Missed reminder"
  //    banner (no new system notification for something that old).
  function checkReminders() {
    if (!booted) return;

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
    // 1) In-app reminder: always works while the app is open.
    addBanner('Reminder: ' + task.text + ' (' + reminderLabel(task) + ')');

    // 2) System notification on the web, if permission was granted. Delivery is not guaranteed.
    //    (The Android app does not need this: the phone's own alarm shows the notification.)
    if (!isNativeApp && notificationsSupported() && Notification.permission === 'granted') {
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
  function onResume() {
    checkReminders();
    refreshNotifyStatus();
    scheduleNativeSync();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) onResume(); });
  window.addEventListener('focus', onResume);
  window.addEventListener('pageshow', checkReminders);

  // Another tab changed the tasks: show the latest.
  window.addEventListener('storage', function (e) {
    if (e.key === STORAGE_KEY && booted) {
      tasks = loadTasks();
      renderAll();
    }
  });

  // ---------- Android app: phone alarms for reminders ----------
  // Every pending reminder is registered with the phone's alarm system, so it fires even when the
  // app is completely closed (and again after a reboot). This function makes the phone's list match
  // the tasks exactly: new and changed reminders are scheduled, removed / completed / deleted ones are cancelled.
  var channelPromise = null;
  var syncTimer = null;
  var syncRunning = false;
  var syncAgain = false;

  function ensureChannel() {
    if (!LN) return Promise.resolve(false);
    if (!channelPromise) {
      channelPromise = LN.createChannel({
        id: CHANNEL_ID,
        name: 'Task reminders',
        description: 'Reminders for your tasks',
        importance: 4,
        visibility: 1,
        vibration: true
      }).then(function () { return true; }, function () { return false; });
    }
    return channelPromise;
  }

  function exactAlarmsAllowed() {
    return LN.checkExactNotificationSetting().then(
      function (r) { return !r || r.exact_alarm !== 'denied'; },
      function () { return true; }
    );
  }

  function nativeBody(task) {
    var body = reminderLabel(task);
    if (task.description) body += ' · ' + firstLine(task.description, 100);
    return body;
  }

  function buildNativeNotification(task, due, key, channelOk, exactOk) {
    var n = {
      id: task.nid,
      title: task.text,
      body: nativeBody(task),
      schedule: { at: new Date(due), allowWhileIdle: true },
      smallIcon: 'ic_stat_todo',
      iconColor: '#3B6CF6',
      extra: { key: key, taskId: task.id },
      isExactNotification: exactOk
    };
    if (channelOk) n.channelId = CHANNEL_ID;
    if (task.description) n.largeBody = task.description;
    return n;
  }

  function scheduleNativeSync() {
    if (!LN || !booted) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(runNativeSync, 150);
  }

  function runNativeSync() {
    if (syncRunning) { syncAgain = true; return; }
    syncRunning = true;
    var failure = null;
    nativeSync().catch(function (e) { failure = e; }).then(function () {
      syncRunning = false;
      if (failure) {
        lastNotifyError = 'could not set the phone alarms (' + errText(failure) + ')';
        refreshNotifyStatus();
      } else if (lastNotifyError.indexOf('phone alarms') !== -1) {
        lastNotifyError = '';
        refreshNotifyStatus();
      }
      if (syncAgain) { syncAgain = false; runNativeSync(); }
    });
  }

  function nativeSync() {
    return LN.checkPermissions().then(function (perm) {
      // Never ask for permission from here: that only happens when you press "Enable notifications".
      if (!perm || perm.display !== 'granted') return null;
      return Promise.all([ensureChannel(), exactAlarmsAllowed(), LN.getPending()]).then(function (r) {
        var channelOk = r[0];
        var exactOk = r[1];
        var pending = (r[2] && r[2].notifications) || [];
        var now = Date.now();

        var desired = {};
        var list = [];
        tasks.forEach(function (t) {
          if (!t.reminder || t.done || t.notified) return;
          var due = reminderMs(t.reminder);
          if (isNaN(due) || due <= now + 2000) return;
          var key = [t.id, t.reminder, t.text, t.description].join('|');
          desired[t.nid] = key;
          list.push(buildNativeNotification(t, due, key, channelOk, exactOk));
        });

        var pendingKeys = {};
        var cancelList = [];
        pending.forEach(function (n) {
          pendingKeys[n.id] = n.extra && n.extra.key;
          if (n.id === TEST_NOTIFICATION_ID) return;
          if (!(n.id in desired) || desired[n.id] !== pendingKeys[n.id]) cancelList.push({ id: n.id });
        });
        var scheduleList = list.filter(function (n) { return pendingKeys[n.id] !== n.extra.key; });

        var step = cancelList.length ? LN.cancel({ notifications: cancelList }) : Promise.resolve();
        return step.then(function () {
          return scheduleList.length ? LN.schedule({ notifications: scheduleList }) : null;
        });
      });
    });
  }

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

  // Web: shows a system notification. Phones only allow this through the service worker,
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

  function computeWebNotifyStatus() {
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
          text: 'Notifications are allowed and ready. They can appear while the app is open or running in the background. A fully closed web app cannot send them; the Android app can.'
        };
      }
      return {
        state: 'limited',
        action: 'test',
        text: 'Notifications are allowed, but the notification service is not active yet. Reload once while online. Reminders still appear inside the app.'
      };
    });
  }

  // Android app: status from the phone's real permission and alarm settings.
  function computeNativeNotifyStatus() {
    return LN.checkPermissions().then(function (perm) {
      var display = perm && perm.display;
      if (display === 'denied') {
        return {
          state: 'blocked',
          text: 'Notifications are blocked for this app, so reminders cannot alert you. Open your phone’s Settings → Apps → Cheqlist → Notifications and turn them on, then come back.'
        };
      }
      if (display !== 'granted') {
        return {
          state: 'needs-permission',
          action: 'enable',
          text: 'Notifications are off. Press the button and allow notifications so reminders can alert you, even when the app is closed.'
        };
      }
      if (lastNotifyError) {
        return {
          state: 'error',
          action: 'test',
          text: 'Notifications are allowed, but there was a problem: ' + lastNotifyError + '. Reminders still appear inside the app.'
        };
      }
      return LN.checkExactNotificationSetting().then(
        function (r) { return !r || r.exact_alarm !== 'denied'; },
        function () { return true; }
      ).then(function (exactOk) {
        if (!exactOk) {
          return {
            state: 'limited',
            action: 'exact',
            text: 'Notifications are allowed, but “Alarms & reminders” is off for this app, so reminders can arrive late. Allow it for on-time reminders.'
          };
        }
        return {
          state: 'enabled',
          action: 'test',
          text: 'Notifications are on. Reminders will alert you even when the app is closed.'
        };
      });
    }).catch(function (e) {
      return { state: 'error', text: 'Could not check notifications on this phone (' + errText(e) + '). Reminders still appear inside the app.' };
    });
  }

  function computeNotifyStatus() {
    return isNativeApp ? computeNativeNotifyStatus() : computeWebNotifyStatus();
  }

  function addNotifyButton(label, handler) {
    var b = el('button', 'notify-btn');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', handler);
    notifyBar.appendChild(b);
  }

  function renderNotifyBar(status) {
    notifyBar.textContent = '';
    notifyBar.dataset.state = status.state;

    var msg = el('span', 'notify-msg');
    msg.textContent = status.text;
    notifyBar.appendChild(msg);

    if (status.action === 'enable') addNotifyButton('Enable notifications', requestNotificationPermission);
    else if (status.action === 'exact') addNotifyButton('Allow on-time reminders', allowExactAlarms);
    else if (status.action === 'test') addNotifyButton('Send test notification', sendTestNotification);
  }

  function refreshNotifyStatus() {
    return computeNotifyStatus().then(renderNotifyBar);
  }

  // Only runs when you press the button. The app never asks on its own.
  function requestNotificationPermission() {
    if (isNativeApp) {
      LN.requestPermissions().then(function () {
        scheduleNativeSync();
        return refreshNotifyStatus();
      }, function (e) {
        lastNotifyError = errText(e);
        return refreshNotifyStatus();
      });
      return;
    }
    if (!notificationsSupported()) { refreshNotifyStatus(); return; }
    try {
      Promise.resolve(Notification.requestPermission()).then(refreshNotifyStatus, refreshNotifyStatus);
    } catch (e) {
      lastNotifyError = errText(e);
      refreshNotifyStatus();
    }
  }

  function allowExactAlarms() {
    LN.changeExactNotificationSetting().then(function () {
      scheduleNativeSync();
      return refreshNotifyStatus();
    }, function (e) {
      lastNotifyError = errText(e);
      return refreshNotifyStatus();
    });
  }

  function sendTestNotification() {
    if (isNativeApp) {
      Promise.all([ensureChannel(), exactAlarmsAllowed()]).then(function (r) {
        var n = {
          id: TEST_NOTIFICATION_ID,
          title: 'Test notification',
          body: 'If you can see this, reminders can reach you.',
          schedule: { at: new Date(Date.now() + 3000), allowWhileIdle: true },
          smallIcon: 'ic_stat_todo',
          iconColor: '#3B6CF6',
          isExactNotification: r[1]
        };
        if (r[0]) n.channelId = CHANNEL_ID;
        return LN.schedule({ notifications: [n] });
      }).then(function () {
        lastNotifyError = '';
        addBanner('A test notification will appear in a few seconds. If nothing appears, check this app’s notification settings on your phone.');
        return refreshNotifyStatus();
      }).catch(function (e) {
        lastNotifyError = errText(e);
        return refreshNotifyStatus();
      });
      return;
    }
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

  // Web: keep the status line right if you change the permission in browser settings.
  if (!isNativeApp && navigator.permissions && navigator.permissions.query) {
    try {
      navigator.permissions.query({ name: 'notifications' }).then(function (status) {
        status.onchange = refreshNotifyStatus;
      }).catch(function () { /* not supported: focus/visibility checks still update it */ });
    } catch (e) { /* ignore */ }
  }

  // ---------- Light / dark theme ----------
  // 'auto' follows the phone's setting; 'light' and 'dark' override it. The choice is remembered.
  var THEME_KEY = 'todo-theme';
  var SystemBars = null;
  try { if (isNativeApp) SystemBars = window.Capacitor.registerPlugin('SystemBars'); } catch (e) { SystemBars = null; }
  var themeChoice = 'auto';
  var themeMedia = null;
  try { themeMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null; } catch (e) { themeMedia = null; }

  function effectiveTheme() {
    if (themeChoice === 'light' || themeChoice === 'dark') return themeChoice;
    return themeMedia && themeMedia.matches ? 'dark' : 'light';
  }

  function applyTheme() {
    var root = document.documentElement;
    if (themeChoice === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', themeChoice);

    var dark = effectiveTheme() === 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0b0f1c' : '#eef1fa');
    // Android app: make the status-bar icons readable on the chosen background.
    if (SystemBars) {
      try { SystemBars.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(function () { /* cosmetic only */ }); } catch (e) { /* ignore */ }
    }
    Array.prototype.forEach.call(document.querySelectorAll('#theme-switch button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-theme-choice') === themeChoice ? 'true' : 'false');
    });
  }

  function setTheme(choice) {
    themeChoice = (choice === 'light' || choice === 'dark') ? choice : 'auto';
    try { localStorage.setItem(THEME_KEY, themeChoice); } catch (e) { /* the choice just will not be remembered */ }
    if (Prefs) { try { Prefs.set({ key: THEME_KEY, value: themeChoice }).catch(function () { /* ignore */ }); } catch (e) { /* ignore */ } }
    applyTheme();
  }

  function loadTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
    themeChoice = (saved === 'light' || saved === 'dark') ? saved : 'auto';
    applyTheme();
  }

  Array.prototype.forEach.call(document.querySelectorAll('#theme-switch button'), function (b) {
    b.addEventListener('click', function () { setTheme(b.getAttribute('data-theme-choice')); });
  });
  if (themeMedia && themeMedia.addEventListener) {
    themeMedia.addEventListener('change', function () { if (themeChoice === 'auto') applyTheme(); });
  }

  // ---------- Backup and restore ----------
  var backupCopy = document.getElementById('backup-copy');
  var backupText = document.getElementById('backup-text');
  var backupRestore = document.getElementById('backup-restore');
  var backupMsg = document.getElementById('backup-msg');
  var backupConfirm = document.getElementById('backup-confirm');
  var backupConfirmText = document.getElementById('backup-confirm-text');
  var backupConfirmYes = document.getElementById('backup-confirm-yes');
  var backupConfirmNo = document.getElementById('backup-confirm-no');
  var pendingRestore = null;

  function setBackupMessage(message, isError) {
    backupMsg.textContent = message;
    backupMsg.classList.toggle('is-error', !!isError);
  }

  function makeBackupText() {
    return JSON.stringify({ app: 'todo-checklist', version: 2, exportedAt: new Date().toISOString(), tasks: tasks });
  }

  if (backupCopy) {
    backupCopy.addEventListener('click', function () {
      var text = makeBackupText();
      function fallback() {
        backupText.value = text;
        backupText.focus();
        backupText.select();
        setBackupMessage('Could not copy automatically. The backup is in the box below: select it all and copy it.', true);
      }
      try {
        navigator.clipboard.writeText(text).then(function () {
          setBackupMessage('Backup copied (' + tasks.length + ' tasks). Paste it somewhere safe, or into the other app to move your tasks.', false);
        }, fallback);
      } catch (e) {
        fallback();
      }
    });

    backupRestore.addEventListener('click', function () {
      var raw = backupText.value.trim();
      pendingRestore = null;
      backupConfirm.hidden = true;
      if (!raw) { setBackupMessage('Paste a backup into the box first.', true); return; }

      var data;
      try { data = JSON.parse(raw); } catch (e) { setBackupMessage('That is not a valid backup. Paste the whole text from “Copy backup”.', true); return; }
      if (data && !Array.isArray(data) && Array.isArray(data.tasks)) data = data.tasks;
      if (!Array.isArray(data)) { setBackupMessage('That is not a valid backup. Paste the whole text from “Copy backup”.', true); return; }

      var restored = normalizeTasks(data);
      if (!restored.length && data.length) { setBackupMessage('No usable tasks were found in that backup.', true); return; }
      pendingRestore = restored;
      backupConfirmText.textContent = 'Replace your ' + tasks.length + ' current tasks with the ' + restored.length + ' tasks in this backup?';
      backupConfirm.hidden = false;
      setBackupMessage('', false);
    });

    backupConfirmNo.addEventListener('click', function () {
      pendingRestore = null;
      backupConfirm.hidden = true;
    });

    backupConfirmYes.addEventListener('click', function () {
      if (!pendingRestore) return;
      var now = Date.now();
      // Reminders that already passed were handled before the backup was made: do not announce them again.
      pendingRestore.forEach(function (t) {
        if (t.reminder && reminderMs(t.reminder) <= now) t.notified = true;
      });
      tasks = pendingRestore;
      pendingRestore = null;
      backupConfirm.hidden = true;
      backupText.value = '';
      saveTasks();
      renderAll();
      setBackupMessage('Restored ' + tasks.length + ' tasks.', false);
    });
  }

  // ---------- Offline support (web only) ----------
  if (!isNativeApp && 'serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').then(function () {
        return navigator.serviceWorker.ready;
      }).then(refreshNotifyStatus).catch(function () {
        // Not available (for example, the page was opened as a plain file). The app still works.
      });
    });
  }

  // ---------- Start ----------
  // Android app: if the app's own storage was ever emptied but the native copy is still there, restore it first.
  function restoreFromNativeStore() {
    if (!Prefs) return Promise.resolve();
    var timeout = new Promise(function (resolve) { setTimeout(resolve, 2000); });
    var restoreTheme = Prefs.get({ key: THEME_KEY }).then(function (r) {
      var existing = null;
      try { existing = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
      if (!existing && r && r.value) { try { localStorage.setItem(THEME_KEY, r.value); } catch (e) { /* ignore */ } }
    }).catch(function () { /* default theme */ });
    var restore = restoreTheme.then(function () { return Prefs.get({ key: STORAGE_KEY }); }).then(function (r) {
      var existing = null;
      try { existing = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      if (!existing && r && r.value) {
        try { localStorage.setItem(STORAGE_KEY, r.value); } catch (e) { /* ignore */ }
      }
    }).catch(function () { /* start with what is in localStorage */ });
    return Promise.race([restore, timeout]);
  }

  function start() {
    if (!canSort) document.body.classList.add('no-sort'); // reordering file missing: hide the grips
    loadTheme();
    renderedToday = todayString();
    tasks = loadTasks();
    if (needsMigrationSave && tasks.length) saveTasks(); // stores the added fields for older tasks
    booted = true;
    renderDraftControls();
    renderAll();
    refreshNotifyStatus();
    checkReminders();
    scheduleNativeSync();
    if (LN) ensureChannel();
  }

  renderedToday = todayString();
  if (isNativeApp) restoreFromNativeStore().then(start, start);
  else start();
})();
