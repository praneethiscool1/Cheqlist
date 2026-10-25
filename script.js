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
  var TEST_NOTIFICATION_ID = 2100000000;  // reserved id (never used for a task alert)
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

  // ---------- Are we inside the Android app? ----------
  var LN = null;    // native scheduled notifications
  var Prefs = null; // native key/value storage
  var AppSettings = null; // opens this app's notification settings in the phone (small native helper)
  try {
    if (window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' &&
        window.Capacitor.isNativePlatform() && typeof window.Capacitor.registerPlugin === 'function') {
      LN = window.Capacitor.registerPlugin('LocalNotifications');
      Prefs = window.Capacitor.registerPlugin('Preferences');
      try { AppSettings = window.Capacitor.registerPlugin('AppSettings'); } catch (e2) { AppSettings = null; }
    }
  } catch (e) {
    LN = null;
    Prefs = null;
    AppSettings = null;
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
  //   notified: true once its overdue alert (at the reminder time, or at midnight after its date) has been shown or skipped,
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

  // The moment a task becomes overdue: its reminder time if it has one, otherwise 12:00 am on the day after its date.
  // NaN when it has neither (an undated task with no reminder never becomes overdue).
  function deadlineMs(task) {
    if (task.reminder) return reminderMs(task.reminder);
    if (task.date) {
      var d = parseDateString(task.date);
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    }
    return NaN;
  }

  // The earliest time that can still be chosen: the next whole minute from now.
  function nextMinuteDate() { return new Date(Math.ceil((Date.now() + 1) / 60000) * 60000); }
  function localTimeString(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function localDateString(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

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

  // "Wed, 22 Oct" or "Wed, 22 Oct, 6:30 PM": when a task was due.
  function deadlineLabel(task) {
    if (task.reminder) return formatDayShort(datePart(task.reminder)) + ', ' + formatTime12(timePart(task.reminder));
    return task.date ? formatDayShort(task.date) : '';
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

  // ---------- Header: the app name ----------
  var heroDay = document.getElementById('hero-day');
  function updateHero() { fitHero(); }

  // Tapping the title plays a small animation. The letters are wrapped one by one; three effects take turns.
  if (heroDay) {
    var wordEl = heroDay.querySelector('.brand-word') || heroDay;
    var titleWord = wordEl.textContent;
    heroDay.setAttribute('aria-label', titleWord);
    wordEl.textContent = '';
    titleWord.split('').forEach(function (ch, i) {
      var s = document.createElement('span');
      s.className = 'ch';
      s.style.setProperty('--i', String(i));
      s.setAttribute('aria-hidden', 'true');
      s.textContent = ch;
      wordEl.appendChild(s);
    });
    var titleEffects = ['t-wave', 't-flip', 't-jelly'];
    var titleNext = 0;
    var titleTimer = null;
    var logoEffects = ['l-pop', 'l-spin', 'l-draw'];
    var logoNext = 0;
    var logoTimer = null;
    var logoEl = heroDay.querySelector('.brand-logo');
    function playLogo() {
      if (!logoEl || !motionAllowed()) return;
      logoEffects.forEach(function (c) { logoEl.classList.remove(c); });
      void logoEl.getBoundingClientRect(); // lets the same effect restart if you tap quickly
      logoEl.classList.add(logoEffects[logoNext % logoEffects.length]);
      logoNext++;
      clearTimeout(logoTimer);
      logoTimer = setTimeout(function () { logoEffects.forEach(function (c) { logoEl.classList.remove(c); }); }, 1100);
    }
    heroDay.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.brand-logo')) { playLogo(); return; }
      if (!motionAllowed()) return;
      titleEffects.forEach(function (c) { heroDay.classList.remove(c); });
      void heroDay.offsetWidth; // lets the same effect restart if you tap quickly
      heroDay.classList.add(titleEffects[titleNext % titleEffects.length]);
      titleNext++;
      clearTimeout(titleTimer);
      titleTimer = setTimeout(function () { titleEffects.forEach(function (c) { heroDay.classList.remove(c); }); }, 1200);
    });
  }

  // The title is big. On narrow screens or with large system text, shrink it until it fits on one line.
  function fitHero() {
    if (!heroDay) return;
    heroDay.style.fontSize = '';
    var size = parseFloat(window.getComputedStyle(heroDay).fontSize) || 0;
    var guard = 0;
    while (size > 18 && heroDay.scrollWidth > heroDay.clientWidth + 1 && guard++ < 40) {
      size -= 2;
      heroDay.style.fontSize = size + 'px';
    }
  }
  window.addEventListener('resize', fitHero);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitHero, function () { /* ignore */ });

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
        notified: (reminder || date) ? t.notified === true : false,
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

  // ---------- Date and time pickers (in-app sheets) ----------
  // Tapping "Add date" or "Add reminder" opens a bottom sheet drawn by the app itself, so it follows the
  // light/dark theme and the app's animations (the phone's own dialog cannot be styled). The pill still owns a
  // hidden <input> that holds the value, so everything downstream works exactly as before.
  var picker = (function () {
    var root = null, sheet = null, body = null;
    var isOpen = false, closeTimer = null, pushed = false, ignorePop = false, opener = null;

    function calmMotion() { return !motionAllowed(); }

    function build() {
      root = el('div', 'sheet-root');
      root.hidden = true;
      var backdrop = el('div', 'sheet-backdrop');
      sheet = el('div', 'sheet');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      body = el('div', 'sheet-body');
      sheet.appendChild(el('div', 'sheet-grab'));
      sheet.appendChild(body);
      root.appendChild(backdrop);
      root.appendChild(sheet);
      document.body.appendChild(root);
      backdrop.addEventListener('click', close);
      document.addEventListener('keydown', function (e) { if (isOpen && e.key === 'Escape') close(); });
      // The phone's back button closes the sheet instead of leaving the app.
      window.addEventListener('popstate', function () {
        if (ignorePop) { ignorePop = false; return; }
        if (isOpen) { pushed = false; hide(); }
      });
    }

    function hide() {
      if (!isOpen) return;
      isOpen = false;
      root.classList.remove('open');
      clearTimeout(closeTimer);
      closeTimer = setTimeout(function () { root.hidden = true; body.textContent = ''; }, calmMotion() ? 0 : 320);
      var back = opener;
      opener = null;
      if (back && back.focus && document.contains(back)) { try { back.focus(); } catch (e) { /* ignore */ } }
    }

    function close() {
      if (!isOpen) return;
      hide();
      if (pushed) {
        pushed = false;
        ignorePop = true;
        setTimeout(function () { ignorePop = false; }, 600);
        try { history.back(); } catch (e) { ignorePop = false; }
      }
    }

    function show(opts, render) {
      if (!root) build();
      clearTimeout(closeTimer);
      opener = document.activeElement;
      body.textContent = '';
      var title = el('h2', 'sheet-title');
      title.textContent = opts.title;
      body.appendChild(title);
      if (opts.sub) {
        var sub = el('p', 'sheet-sub');
        sub.textContent = opts.sub;
        body.appendChild(sub);
      }
      var afterShown = render(body);
      root.hidden = false;
      void root.offsetWidth; // so the slide-in animation runs from the closed position
      root.classList.add('open');
      if (!isOpen && !pushed) {
        try { history.pushState({ sheet: 1 }, ''); pushed = true; } catch (e) { pushed = false; }
      }
      isOpen = true;
      if (typeof afterShown === 'function') afterShown();
      var first = body.querySelector('.sheet-chip.is-selected, .cal-day.is-selected, .cal-day.is-today, .tp-seg.is-selected, button:not([disabled])');
      if (first && first.focus) { try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }

    function button(cls, text, onClick) {
      var b = el('button', cls);
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', onClick);
      return b;
    }

    // ----- calendar -----
    var MONTH_FMT = { month: 'long', year: 'numeric' };
    function addDays(dateStr, n) {
      var d = parseDateString(dateStr);
      d.setDate(d.getDate() + n);
      return localDateString(d);
    }

    function openDate(opts) {
      show(opts, function (box) {
        var today = todayString();
        var min = opts.min || '';
        var selected = isDateString(opts.value) ? opts.value : '';
        var base = (selected && selected >= today) ? selected : today;
        var viewY = +base.slice(0, 4), viewM = +base.slice(5, 7) - 1;

        function choose(date, btn) {
          if (min && date < min) return;
          if (btn) btn.classList.add('is-picked');
          var done = function () { close(); opts.onPick(date); };
          if (calmMotion()) done(); else setTimeout(done, 170);
        }

        var chips = el('div', 'sheet-chips');
        [['Today', today], ['Tomorrow', addDays(today, 1)]].forEach(function (c) {
          var b = button('sheet-chip' + (selected === c[1] ? ' is-selected' : ''), c[0], function () { choose(c[1], b); });
          chips.appendChild(b);
        });
        box.appendChild(chips);

        var head = el('div', 'cal-head');
        var prev = button('cal-nav cal-prev', '', function () { viewM--; if (viewM < 0) { viewM = 11; viewY--; } paint(true); });
        prev.setAttribute('aria-label', 'Previous month');
        var label = el('div', 'cal-month');
        label.setAttribute('aria-live', 'polite');
        var next = button('cal-nav cal-next', '', function () { viewM++; if (viewM > 11) { viewM = 0; viewY++; } paint(true); });
        next.setAttribute('aria-label', 'Next month');
        head.appendChild(prev); head.appendChild(label); head.appendChild(next);
        box.appendChild(head);

        var dow = el('div', 'cal-dow');
        ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach(function (d) { var s = el('span'); s.textContent = d; dow.appendChild(s); });
        box.appendChild(dow);
        var grid = el('div', 'cal-grid');
        box.appendChild(grid);

        function paint(animate) {
          label.textContent = new Date(viewY, viewM, 1).toLocaleDateString('en-GB', MONTH_FMT);
          var minYM = min ? +min.slice(0, 4) * 12 + (+min.slice(5, 7) - 1) : -1;
          prev.disabled = minYM >= 0 && viewY * 12 + viewM <= minYM;
          grid.textContent = '';
          var first = new Date(viewY, viewM, 1).getDay();
          var count = new Date(viewY, viewM + 1, 0).getDate();
          for (var i = 0; i < first; i++) grid.appendChild(el('span', 'cal-blank'));
          for (var day = 1; day <= count; day++) {
            var ds = viewY + '-' + pad2(viewM + 1) + '-' + pad2(day);
            var b = el('button', 'cal-day' + (ds === today ? ' is-today' : '') + (ds === selected ? ' is-selected' : ''));
            b.type = 'button';
            b.textContent = String(day);
            b.dataset.date = ds;
            b.setAttribute('aria-label', formatDayShort(ds));
            if (ds === selected) b.setAttribute('aria-pressed', 'true');
            if (min && ds < min) b.disabled = true;
            else (function (date, btn) { btn.addEventListener('click', function () { choose(date, btn); }); })(ds, b);
            grid.appendChild(b);
          }
          if (animate && !calmMotion()) {
            grid.classList.remove('swap');
            void grid.offsetWidth;
            grid.classList.add('swap');
          }
        }
        paint(false);

        var actions = el('div', 'sheet-actions');
        if (selected && opts.onClear) actions.appendChild(button('sheet-btn sheet-btn-danger', 'Clear', function () { close(); opts.onClear(); }));
        var spacer = el('span', 'sheet-spacer');
        actions.appendChild(spacer);
        actions.appendChild(button('sheet-btn', 'Close', close));
        box.appendChild(actions);
      });
    }

    // ----- time -----
    // Two rollers (hour, minute) that you spin with a finger, and an AM / PM choice.
    var WHEEL_ITEM = 54; // px, must match .wheel-item in the stylesheet

    function makeWheel(labels, start, ariaLabel, onChange) {
      var wheel = el('div', 'wheel');
      wheel.setAttribute('role', 'listbox');
      wheel.setAttribute('aria-label', ariaLabel);
      wheel.tabIndex = 0;
      var index = start;
      var items = labels.map(function (text, i) {
        var it = el('div', 'wheel-item');
        it.setAttribute('role', 'option');
        it.textContent = text;
        it.addEventListener('click', function () { choose(i, true); });
        wheel.appendChild(it);
        return it;
      });
      function paint() {
        items.forEach(function (it, i) {
          it.classList.toggle('is-selected', i === index);
          it.setAttribute('aria-selected', i === index ? 'true' : 'false');
        });
      }
      function scrollTo(i, smooth) {
        var top = i * WHEEL_ITEM;
        try {
          if (smooth && typeof wheel.scrollTo === 'function' && motionAllowed()) wheel.scrollTo({ top: top, behavior: 'smooth' });
          else wheel.scrollTop = top;
        } catch (e) { wheel.scrollTop = top; }
      }
      function choose(i, scroll) {
        i = Math.max(0, Math.min(labels.length - 1, i));
        var changed = i !== index;
        index = i;
        paint();
        if (scroll) scrollTo(i, true);
        if (changed) onChange(i);
      }
      // Spinning the roller: the item resting in the middle is the chosen one.
      wheel.addEventListener('scroll', function () {
        var i = Math.round(wheel.scrollTop / WHEEL_ITEM);
        i = Math.max(0, Math.min(labels.length - 1, i));
        if (i !== index) { index = i; paint(); onChange(i); }
      });
      wheel.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); choose(index + 1, true); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); choose(index - 1, true); }
      });
      paint();
      return { el: wheel, get: function () { return index; }, place: function () { scrollTo(index, false); } };
    }

    function openTime(opts) {
      show(opts, function (box) {
        var min = opts.min || '';
        var h = 9, m = 0, pm = false;
        if (isTimeString(opts.value)) {
          var h24 = +opts.value.slice(0, 2);
          pm = h24 >= 12; h = (h24 % 12) || 12; m = +opts.value.slice(3, 5);
        } else {
          var d = new Date(Date.now() + 30 * 60000);       // a sensible start: about half an hour from now
          d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
          var hh = d.getHours();
          pm = hh >= 12; h = (hh % 12) || 12; m = d.getMinutes();
        }
        function value24() { return pad2((h % 12) + (pm ? 12 : 0)) + ':' + pad2(m); }

        var roller = el('div', 'tp-roller');
        var hourLabels = [], minuteLabels = [];
        for (var i = 1; i <= 12; i++) hourLabels.push(String(i));
        for (var k = 0; k < 60; k++) minuteLabels.push(pad2(k));
        var hourWheel = makeWheel(hourLabels, h - 1, 'Hour', function (idx) { h = idx + 1; paint(); });
        var minuteWheel = makeWheel(minuteLabels, m, 'Minute', function (idx) { m = idx; paint(); });
        hourWheel.el.classList.add('wheel-hour');
        minuteWheel.el.classList.add('wheel-minute');
        var colon = el('span', 'tp-colon');
        colon.textContent = ':';
        var seg = el('div', 'tp-ampm');
        var am = button('tp-seg', 'AM', function () { pm = false; paint(); });
        var pmBtn = button('tp-seg', 'PM', function () { pm = true; paint(); });
        seg.appendChild(am); seg.appendChild(pmBtn);
        var wheels = el('div', 'tp-wheels');
        wheels.appendChild(hourWheel.el);
        wheels.appendChild(colon);
        wheels.appendChild(minuteWheel.el);
        roller.appendChild(wheels);
        roller.appendChild(seg);
        box.appendChild(roller);

        var hint = el('p', 'tp-hint');
        hint.setAttribute('aria-live', 'polite');
        box.appendChild(hint);

        var actions = el('div', 'sheet-actions');
        if (isTimeString(opts.value) && opts.onClear) actions.appendChild(button('sheet-btn sheet-btn-danger', 'Clear', function () { close(); opts.onClear(); }));
        actions.appendChild(el('span', 'sheet-spacer'));
        actions.appendChild(button('sheet-btn', 'Cancel', close));
        var set = button('sheet-btn sheet-btn-primary', 'Set', function () {
          var v = value24();
          if (min && v < min) return;
          close();
          opts.onPick(v);
        });
        actions.appendChild(set);
        box.appendChild(actions);

        function paint() {
          am.classList.toggle('is-selected', !pm); pmBtn.classList.toggle('is-selected', pm);
          am.setAttribute('aria-pressed', pm ? 'false' : 'true'); pmBtn.setAttribute('aria-pressed', pm ? 'true' : 'false');
          var bad = !!min && value24() < min;
          set.disabled = bad;
          hint.textContent = bad ? 'That time has already passed. Pick one that is still ahead.' : '';
          hint.classList.toggle('is-bad', bad);
        }
        paint();
        // The rollers can only be positioned once the sheet is on screen.
        return function afterShown() { hourWheel.place(); minuteWheel.place(); };
      });
    }

    return {
      open: function (opts) { if (opts.kind === 'date') openDate(opts); else openTime(opts); },
      close: close,
      isOpen: function () { return isOpen; }
    };
  })();

  // ---------- Date and reminder "pills" ----------
  // A pill is a rounded button showing a value. The real date/time input sits invisibly on top,
  // so tapping the pill opens the phone's own picker. An optional x button clears the value.
  function makePill(o) {
    var wrap = el('span', 'pill-wrap');
    var pill = el('span', 'pill kind-' + o.inputType + (o.set ? ' is-set' : '') + (o.overdue ? ' is-overdue' : ''));
    pill.setAttribute('role', 'button');
    pill.tabIndex = 0;
    pill.setAttribute('aria-label', o.label);
    var text = el('span', 'pill-text');
    text.textContent = o.text;
    // Holds the value (a date "2026-10-25" or a time "18:30"). Never shown: the app's own sheet is the picker.
    var input = el('input');
    input.type = o.inputType;
    input.value = o.inputValue || '';
    input.hidden = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.addEventListener('change', function () { o.onChange(input.value); });
    function openPicker() {
      picker.open({
        kind: o.inputType,
        title: o.sheetTitle,
        sub: o.sub ? o.sub() : '',
        value: input.value,
        min: o.min ? o.min() : '',
        onPick: function (v) { input.value = v; o.onChange(v); },
        onClear: o.set && o.onClear ? o.onClear : null
      });
    }
    pill.addEventListener('click', openPicker);
    pill.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });
    pill.appendChild(text);
    pill.appendChild(input);
    wrap.appendChild(pill);

    if (o.set && o.onClear) {
      var x = el('button', 'pill-x');
      x.type = 'button';
      x.textContent = '\u00d7';
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

  // Turns what the reminder picker gave us (a time like "18:30") into a full 'YYYY-MM-DDTHH:MM'.
  // With a task date the reminder is on that date. Without one it is the next time the clock shows that time:
  // today if it is still ahead, otherwise tomorrow. Returns '' (cleared), a string (valid) or null (not usable).
  function parseReminderInput(date, value) {
    if (!value) return '';
    if (/^\d{2}:\d{2}:\d{2}$/.test(value)) value = value.slice(0, 5);
    if (isTimeString(value)) {
      if (date) return date + 'T' + value;
      var today = todayString() + 'T' + value;
      if (reminderMs(today) > Date.now()) return today;
      var t = new Date();
      t.setDate(t.getDate() + 1);
      return localDateString(t) + 'T' + value;
    }
    return normalizeReminder(value) || null; // a full date and time is still accepted
  }

  // Moves a reminder onto a new date, keeping its time. Returns '' when the result is already in the past.
  function shiftReminder(reminder, newDate) {
    var shifted = newDate + 'T' + timePart(reminder);
    return reminderMs(shifted) > Date.now() ? shifted : '';
  }

  function reminderSub(date) {
    return date ? 'On ' + formatDayShort(date) : 'The next time the clock shows it (today, or tomorrow if it has passed)';
  }
  var PAST_MESSAGE = 'That time has already passed. Pick a time that is still ahead.';
  var PAST_DATE_MESSAGE = 'You can only pick today or a later date.';
  function isPastDate(date) { return !!date && date < todayString(); }
  function minDate() { return todayString(); }
  // Reminder inputs: with a task date, only a time (and for today only a time still ahead);
  // without one, a date and time that are still ahead.
  function minTimeFor(date) { return date === todayString() ? localTimeString(nextMinuteDate()) : ''; }

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

    var datePill = makePill({
      text: draft.date ? formatDayShort(draft.date) : 'Add date',
      set: !!draft.date,
      inputType: 'date',
      inputValue: draft.date,
      label: 'Task date (optional)',
      sheetTitle: 'Pick a date',
      clearLabel: 'Remove date',
      min: minDate,
      onChange: function (v) { setDraftDate(isDateString(v) ? v : ''); },
      onClear: function () { setDraftDate(''); }
    });

    var reminderPill = makePill({
      text: draft.reminder ? reminderLabel(draft) : 'Add reminder',
      set: !!draft.reminder,
      inputType: 'time',
      inputValue: draft.reminder ? timePart(draft.reminder) : '',
      label: 'Reminder time (optional)',
      sheetTitle: 'Reminder time',
      sub: function () { return reminderSub(draft.date); },
      clearLabel: 'Remove reminder',
      min: function () { return minTimeFor(draft.date); },
      onChange: function (v) {
        var r = parseReminderInput(draft.date, v);
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
    if (isPastDate(date)) { addBanner(PAST_DATE_MESSAGE, 'warn'); renderDraftControls(); return; }
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

    if (isPastDate(draft.date)) { // the day changed while the form was open
      addBanner(PAST_DATE_MESSAGE, 'warn');
      draft.date = '';
      draft.reminder = '';
      renderDraftControls();
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
    if (isPastDate(date)) { addBanner(PAST_DATE_MESSAGE, 'warn'); renderAll(); return; }

    task.date = date;
    task.notified = false; // a new date is a new deadline
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

  function changeTaskReminder(task, value) {
    var r = parseReminderInput(task.date, value);
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
  // "5 min late", "3 h late", "2 days late"
  function lateText(ms) {
    var min = Math.max(1, Math.floor(ms / 60000));
    if (min < 60) return min + ' min late';
    var hrs = Math.floor(min / 60);
    if (hrs < 24) return hrs + ' h late';
    var days = Math.floor(hrs / 24);
    return days + (days === 1 ? ' day late' : ' days late');
  }

  function isOverdue(task) {
    var due = deadlineMs(task);
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
      sheetTitle: 'Pick a date',
      clearLabel: 'Remove date',
      min: minDate,
      onChange: function (v) { changeTaskDate(task, v); },
      onClear: function () { changeTaskDate(task, ''); }
    });

    var reminderPill = makePill({
      text: task.reminder ? reminderLabel(task) : 'Add reminder',
      set: !!task.reminder,
      overdue: isOverdue(task),
      sheetTitle: 'Reminder time',
      sub: function () { return reminderSub(task.date); },
      min: function () { return minTimeFor(task.date); },
      inputType: 'time',
      inputValue: task.reminder ? timePart(task.reminder) : '',
      label: 'Reminder time (optional)',
      clearLabel: 'Remove reminder',
      onChange: function (v) { changeTaskReminder(task, v); },
      onClear: function () {
        task.reminder = '';
        task.notified = false;
        saveTasks();
        renderAll();
      }
    });
    var overdueBadge = el('span', 'overdue-badge');
    overdueBadge.textContent = 'Overdue';
    overdueBadge.hidden = true;
    main.insertBefore(overdueBadge, text);

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
      li.classList.toggle('overdue', overdue);
      reminderPill.pill.classList.toggle('is-overdue', overdue);
      datePill.pill.classList.toggle('is-overdue', overdue);
      overdueBadge.hidden = !overdue;
      if (overdue) overdueBadge.textContent = 'Overdue \u00b7 ' + lateText(Date.now() - deadlineMs(task));
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

  // ---------- Overdue alerts ----------
  // A task's deadline is its reminder time, or (with only a date) 12:00 am on the day after that date.
  // When the deadline passes and the task is not ticked, it is marked "Overdue" and one alert is sent.
  // The alert is "pending" while `notified` is false. Only this one function decides when the open app
  // shows it, and it runs from one timer, so an alert can never show twice from a re-draw, refresh or edit.
  //
  //  - Deadline passes while the app is open: in-app banner (+ a system notification on the web;
  //    in the Android app the phone's own alarm shows the notification).
  //  - Task is ticked before the deadline: the alert is skipped silently and never fires later,
  //    even if you untick the task (it is still marked Overdue, because it is).
  //  - The deadline passed while the app was closed: on the next open you get one "Overdue" banner
  //    (several at once are combined into one); no new system notification for something that old.
  function checkReminders() {
    if (!booted) return;

    // A new day started while the app was open: refresh the "Today" heading and the earliest allowed date.
    if (todayString() !== renderedToday) { renderAll(); renderDraftControls(); }

    var now = Date.now();
    var changed = false;
    var missed = [];

    tasks.forEach(function (task) {
      if (task.notified) return;
      if (!task.reminder && !task.date) return;
      var due = deadlineMs(task);
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
      if (now - due <= ON_TIME_WINDOW_MS) fireOverdue(task);
      else missed.push(task);
    });

    if (changed) saveTasks();
    showMissedOverdue(missed);

    Array.prototype.forEach.call(listEl.querySelectorAll('.task'), function (li) { li.paintRow(); });
  }

  // If two tabs are open, only the first one to claim a reminder shows it.
  function claimReminder(task) {
    try {
      var data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      for (var i = 0; i < data.length; i++) {
        if (data[i] && data[i].id === task.id) {
          return !(data[i].notified === true && data[i].reminder === task.reminder && data[i].date === task.date);
        }
      }
    } catch (e) { /* if storage can't be read, just show it */ }
    return true;
  }

  function fireOverdue(task) {
    // 1) In-app message: always works while the app is open.
    addBanner('Overdue: ' + task.text + ' (was due ' + deadlineLabel(task) + ')', 'warn');

    // 2) System notification on the web, if permission was granted and notifications are on. Delivery is not guaranteed.
    //    (The Android app does not need this: the phone's own alarm shows the notification.)
    if (!isNativeApp && notificationsSupported() && Notification.permission === 'granted' && !notifyMuted()) {
      showSystemNotification('Overdue: ' + task.text, 'Was due ' + deadlineLabel(task), 'task-' + task.id)
        .then(function () {
          if (lastNotifyError) { lastNotifyError = ''; refreshNotifyStatus(); }
        })
        .catch(function (e) {
          lastNotifyError = errText(e);
          refreshNotifyStatus();
        });
    }
  }

  function showMissedOverdue(missed) {
    if (!missed.length) return;
    if (missed.length === 1) {
      addBanner('Overdue: ' + missed[0].text + ' (was due ' + deadlineLabel(missed[0]) + ')', 'warn');
      return;
    }
    var names = missed.slice(0, 3).map(function (t) { return '"' + firstLine(t.text, 30) + '"'; }).join(', ');
    addBanner(missed.length + ' tasks are overdue: ' + names + (missed.length > 3 ? ' and ' + (missed.length - 3) + ' more' : '') + '.', 'warn');
  }

  setInterval(checkReminders, CHECK_EVERY_MS);
  // Phones slow down timers in background tabs, so also check whenever you come back.
  function onResume() {
    handleSettingsReturn();
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
    var body = 'Was due ' + deadlineLabel(task);
    if (task.description) body += ' · ' + firstLine(task.description, 100);
    return body;
  }

  function buildNativeNotification(task, due, key, channelOk, exactOk) {
    var n = {
      id: task.nid,
      title: 'Overdue: ' + task.text,
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
      var muted = notifyMuted();
      return Promise.all([ensureChannel(), exactAlarmsAllowed(), LN.getPending()]).then(function (r) {
        var channelOk = r[0];
        var exactOk = r[1];
        var pending = (r[2] && r[2].notifications) || [];
        var now = Date.now();

        var desired = {};
        var list = [];
        tasks.forEach(function (t) {
          if (muted || (!t.reminder && !t.date) || t.done || t.notified) return;
          var due = deadlineMs(t);
          if (isNaN(due) || due <= now + 2000) return;
          var key = [t.id, t.reminder, t.date, t.text, t.description].join('|');
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

  // The bell switch in the top corner. It is ON when the phone allows notifications for the app and you have not
  // turned them off here. Turning it off keeps the permission but stops the app from sending alerts
  // (the phone's alarms are cancelled); turning it on again re-schedules them.
  var NOTIFY_OFF_KEY = 'todo-notify-off';
  var notifyToggle = document.getElementById('notify-toggle');

  function notifyMuted() {
    try { return localStorage.getItem(NOTIFY_OFF_KEY) === '1'; } catch (e) { return false; }
  }
  function setNotifyMuted(muted) {
    try {
      if (muted) localStorage.setItem(NOTIFY_OFF_KEY, '1');
      else localStorage.removeItem(NOTIFY_OFF_KEY);
    } catch (e) { /* the choice just will not be remembered */ }
  }

  // 'granted' | 'denied' | 'default' (not asked yet) | 'unsupported' | 'error'
  function notifyPermission() {
    if (isNativeApp) {
      return LN.checkPermissions().then(function (p) {
        var d = p && p.display;
        return d === 'granted' ? 'granted' : (d === 'denied' ? 'denied' : 'default');
      }, function () { return 'error'; });
    }
    if (!notificationsSupported() || window.isSecureContext === false) return Promise.resolve('unsupported');
    var p = Notification.permission;
    return Promise.resolve(p === 'granted' ? 'granted' : (p === 'denied' ? 'denied' : 'default'));
  }

  function refreshNotifyStatus() {
    if (!notifyToggle) return Promise.resolve();
    return notifyPermission().then(function (p) {
      var on = p === 'granted' && !notifyMuted();
      notifyToggle.setAttribute('aria-checked', on ? 'true' : 'false');
      notifyToggle.classList.toggle('is-on', on);
      notifyToggle.disabled = p === 'unsupported';
      notifyToggle.dataset.state = lastNotifyError ? 'error' : p;
      notifyToggle.title = lastNotifyError ? 'Notifications: problem (' + lastNotifyError + ')'
        : on ? 'Notifications are on. Tap to turn them off.'
        : p === 'denied' ? 'Notifications are blocked in your phone settings.'
        : p === 'unsupported' ? 'Notifications are not available here.'
        : 'Notifications are off. Tap to turn them on.';
    });
  }

  // When the phone no longer shows its permission box, the only way is its settings screen.
  // One message with an "Open settings" button (Android app); it replaces any earlier copy instead of piling up.
  var MANUAL_SETTINGS_TEXT = 'Android will not show the permission box again. Open your phone\u2019s Settings \u2192 Apps \u2192 Cheqlist \u2192 Notifications, turn them on, then come back.';
  var waitingForSettings = false;

  function removeBlockedBanner() {
    var old = document.getElementById('notify-help');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  function showBlockedBanner() {
    removeBlockedBanner();
    var box = el('div', 'banner warn');
    box.id = 'notify-help';
    var span = el('span');
    var actions = el('span', 'banner-actions');
    if (isNativeApp && AppSettings) {
      span.textContent = 'Notifications are turned off for Cheqlist in your phone settings. Tap Open settings, switch Notifications on, then come back.';
      var open = el('button');
      open.type = 'button';
      open.textContent = 'Open settings';
      open.addEventListener('click', function () {
        waitingForSettings = true;
        var failed = function () { waitingForSettings = false; span.textContent = MANUAL_SETTINGS_TEXT; open.remove(); };
        try { AppSettings.openNotificationSettings().catch(failed); } catch (e) { failed(); }
      });
      actions.appendChild(open);
    } else {
      span.textContent = isNativeApp ? MANUAL_SETTINGS_TEXT
        : 'Notifications are blocked for this site. Allow them in your browser\u2019s site settings, then reload.';
    }
    var dismiss = el('button');
    dismiss.type = 'button';
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', function () { box.remove(); });
    actions.appendChild(dismiss);
    box.appendChild(span);
    box.appendChild(actions);
    remindersEl.appendChild(box);
  }

  // Back from the phone's settings screen: if notifications were switched on there, switch the bell on too.
  function handleSettingsReturn() {
    if (!waitingForSettings) return;
    notifyPermission().then(function (p) {
      if (p !== 'granted') return;
      waitingForSettings = false;
      setNotifyMuted(false);
      removeBlockedBanner();
      if (isNativeApp) askExactAlarms();
      return notifyChanged();
    });
  }

  function notifyChanged() {
    scheduleNativeSync();
    return refreshNotifyStatus();
  }

  // Runs only when you tap the switch. The app never asks on its own.
  function onNotifyToggle() {
    notifyPermission().then(function (p) {
      if (p === 'granted') {
        var turnOff = !notifyMuted();
        setNotifyMuted(turnOff);
        if (!turnOff && isNativeApp) askExactAlarms();
        return notifyChanged();
      }
      if (p === 'unsupported') { addBanner('Notifications are not available in this browser. Alerts still appear inside the app.', 'warn'); return refreshNotifyStatus(); }
      // Not asked yet, or denied before: always ask again. If the phone has stopped showing its permission box
      // (it only allows that a couple of times), the answer comes back "denied" at once and we explain where to turn it on.
      return requestNotificationPermission();
    });
  }

  function afterPermissionAnswer(result) {
    if (result === 'granted') {
      setNotifyMuted(false);
      if (isNativeApp) askExactAlarms();
    } else if (result === 'denied') {
      showBlockedBanner();
    }
    return notifyChanged();
  }

  function requestNotificationPermission() {
    if (isNativeApp) {
      return LN.requestPermissions().then(function (r) {
        return afterPermissionAnswer(r && r.display);
      }, function (e) {
        lastNotifyError = errText(e);
        return refreshNotifyStatus();
      });
    }
    try {
      return Promise.resolve(Notification.requestPermission()).then(afterPermissionAnswer, function (e) {
        lastNotifyError = errText(e);
        return refreshNotifyStatus();
      });
    } catch (e) {
      lastNotifyError = errText(e);
      return refreshNotifyStatus();
    }
  }

  // Android 12+ can switch exact alarms off per app; if so, ask once (it opens the phone's own setting).
  function askExactAlarms() {
    exactAlarmsAllowed().then(function (ok) {
      if (ok) return null;
      return LN.changeExactNotificationSetting().then(scheduleNativeSync, function () { /* alerts may arrive a little late */ });
    });
  }

  if (notifyToggle) notifyToggle.addEventListener('click', onNotifyToggle);

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

  // ---------- Android app: "update available" notice ----------
  // The app cannot install updates silently (Android requires you to tap Install), but it can tell you.
  // On open it asks GitHub (public information, no login or key) whether a newer build was released.
  var UPDATE_OWNER = 'praneethiscool1';
  var UPDATE_REPO = UPDATE_OWNER + '/Cheqlist';
  // Downloads are only accepted from this GitHub account's release pages. (Checking the account, not the
  // repository name, means renaming the repository again does not break update checks.)
  var UPDATE_URL_PREFIX = 'https://github.com/' + UPDATE_OWNER + '/';
  var RESUME_CHECK_MS = 10 * 60 * 1000; // when the app is brought back from the background, at most every 10 minutes
  var currentBuild = parseInt(window.APP_BUILD, 10) || 0;

  function updateInfoFromRelease(data) {
    if (!data || typeof data.tag_name !== 'string') return null;
    var m = /^android-v(\d+)$/.exec(data.tag_name);
    if (!m) return null;
    var asset = null;
    (data.assets || []).forEach(function (a) {
      if (!asset && a && typeof a.browser_download_url === 'string' && /\.apk$/.test(a.browser_download_url) &&
          a.browser_download_url.indexOf(UPDATE_URL_PREFIX) === 0 &&
          a.browser_download_url.indexOf('/releases/download/') !== -1) asset = a.browser_download_url;
    });
    return asset ? { build: parseInt(m[1], 10), url: asset, notes: typeof data.body === 'string' ? data.body : '', date: typeof data.published_at === 'string' ? data.published_at : '' } : null;
  }

  // "24 October 2026" in the phone's own time zone, from an ISO timestamp. '' when the value is not a real date.
  function formatLongDate(iso) {
    var d = new Date(iso);
    if (typeof iso !== 'string' || isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function setDateLine(id, prefix, iso) {
    var p = document.getElementById(id);
    if (!p) return;
    var text = formatLongDate(iso);
    p.textContent = text ? prefix + text : '';
    p.hidden = !text;
  }

  // Release notes are plain lines ("- something changed"). They are shown as text, never as HTML.
  function renderNotes(listEl, text) {
    listEl.textContent = '';
    String(text || '').split('\n').map(function (l) { return l.replace(/^\s*[-\u2022*]\s*/, '').trim(); })
      .filter(function (l) { return l; }).slice(0, 6).forEach(function (line) {
        var li = el('li');
        li.textContent = line.length > 160 ? line.slice(0, 159) + '\u2026' : line;
        listEl.appendChild(li);
      });
    listEl.hidden = !listEl.firstChild;
  }

  // The Updates section card for a newer version.
  function showUpdateDetails(info) {
    var box = document.getElementById('update-new');
    if (!box) return;
    document.getElementById('update-new-title').textContent = 'Version 1.' + info.build + ' is available';
    setDateLine('update-new-date', 'Released ', info.date);
    renderNotes(document.getElementById('notes-new'), info.notes);
    var dl = document.getElementById('update-download');
    dl.href = info.url;
    if (!dl.dataset.wired) {
      dl.dataset.wired = '1';
      dl.addEventListener('click', function (e) { e.preventDefault(); startUpdateDownload(dl); });
    }
    box.hidden = false;
  }

  // Download: always exactly one download, and always of the newest release. The link itself never navigates
  // (so the phone cannot start a second download); instead the newest release is asked for once more and its
  // file is opened in the phone's browser a single time. Taps while that is in progress are ignored.
  var downloadBusy = false;
  var latestKnown = null;
  function openDownload(url) {
    if (typeof url !== 'string' || url.indexOf(UPDATE_URL_PREFIX) !== 0 || url.indexOf('/releases/download/') === -1) {
      setUpdateMessage('That download link did not look right, so it was not opened.', true);
      return;
    }
    function viaPage() { try { window.open(url, '_system'); } catch (e) { window.location.href = url; } }
    if (AppSettings && AppSettings.openUrl) {
      try { AppSettings.openUrl({ url: url }).catch(viaPage); } catch (e) { viaPage(); }
    } else viaPage();
  }
  function startUpdateDownload(button) {
    if (downloadBusy) return;
    downloadBusy = true;
    if (button) button.classList.add('is-busy');
    function done() { setTimeout(function () { downloadBusy = false; if (button) button.classList.remove('is-busy'); }, 4000); }
    function go(info) { openDownload(info.url); setUpdateMessage('Download started: open the file when it finishes and tap Install.', false); done(); }
    var fallback = latestKnown;
    if (typeof fetch !== 'function') { if (fallback) go(fallback); else done(); return; }
    fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var info = updateInfoFromRelease(data);
        if (!info) throw new Error('no release');
        if (info.build <= currentBuild) { setUpdateMessage('You already have the latest version.', false); done(); return; }
        latestKnown = info;
        go(info);
      })
      .catch(function () {
        if (fallback) go(fallback);
        else { setUpdateMessage('Could not reach GitHub to start the download. Try again.', true); done(); }
      });
  }

  function showUpdateBanner(info) {
    showUpdateDetails(info);
    var old = document.getElementById('update-banner');
    if (old) old.remove();
    var box = el('div', 'banner update');
    box.id = 'update-banner';
    var span = el('span');
    span.textContent = 'A new version of Cheqlist is available. Download it, open the file and tap Install: your tasks stay.';
    var actions = el('span', 'banner-actions');
    var link = el('a', 'banner-link');
    link.href = info.url;
    link.textContent = 'Download';
    link.addEventListener('click', function (e) { e.preventDefault(); startUpdateDownload(link); });
    var later = el('button');
    later.type = 'button';
    later.textContent = 'Later';
    later.addEventListener('click', function () { box.remove(); });
    actions.appendChild(link);
    actions.appendChild(later);
    box.appendChild(span);
    box.appendChild(actions);
    remindersEl.insertBefore(box, remindersEl.firstChild);
  }

  var updateMsg = document.getElementById('update-msg');
  function setUpdateMessage(text, isError) {
    if (!updateMsg) return;
    updateMsg.textContent = text;
    updateMsg.classList.toggle('is-error', !!isError);
    updateMsg.classList.toggle('is-ok', !!text && !isError);
  }

  // Asks GitHub for the newest release every time the app is opened (and when it comes back from the
  // background, at most every 10 minutes). A newer version shows the notice at the top every time until installed.
  var lastUpdateCheck = 0;
  function checkForUpdate() {
    if (!isNativeApp || !currentBuild || typeof fetch !== 'function') return;
    lastUpdateCheck = Date.now();
    setUpdateMessage('Checking for updates\u2026', false);
    fetch('https://api.github.com/repos/' + UPDATE_REPO + '/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        var info = updateInfoFromRelease(data);
        if (!info) { setUpdateMessage('Could not read the latest release.', true); return; }
        if (info.build <= currentBuild) {
          setUpdateMessage('You have the latest version' + (window.APP_VERSION ? ' (' + window.APP_VERSION + ')' : '') + '.', false);
          return;
        }
        latestKnown = info;
        showUpdateBanner(info);
        setUpdateMessage('A newer version is available.', false);
      })
      .catch(function () { setUpdateMessage('Could not check for updates (no internet?).', true); });
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastUpdateCheck > RESUME_CHECK_MS) checkForUpdate();
  });

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
    backupMsg.classList.toggle('is-ok', !!message && !isError);
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

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
      backupConfirmText.textContent = tasks.length
        ? 'Replace your ' + plural(tasks.length, 'current task') + ' with the ' + plural(restored.length, 'task') + ' in this backup?'
        : 'Restore ' + plural(restored.length, 'task') + ' from this backup?';
      backupConfirmYes.textContent = tasks.length ? 'Replace' : 'Restore';
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
        var dm = deadlineMs(t);
        if (!isNaN(dm) && dm <= now) t.notified = true;
      });
      tasks = pendingRestore;
      pendingRestore = null;
      backupConfirm.hidden = true;
      backupText.value = '';
      saveTasks();
      renderAll();
      setBackupMessage('Restored ' + plural(tasks.length, 'task') + '.', false);
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
    var updatesEl = document.getElementById('updates');
    if (updatesEl && isNativeApp && window.APP_VERSION) {
      document.getElementById('app-version').textContent = 'Cheqlist ' + window.APP_VERSION;
      setDateLine('app-date', 'Updated ', window.APP_BUILT_AT);
      renderNotes(document.getElementById('notes-current'), window.APP_NOTES);
      updatesEl.hidden = false;
    }
    checkForUpdate();
  }

  // The opening screen hides itself with CSS; this only removes it from the page afterwards.
  setTimeout(function () { var s = document.getElementById('splash'); if (s && s.parentNode) s.parentNode.removeChild(s); }, 3200);

  renderedToday = todayString();
  if (isNativeApp) restoreFromNativeStore().then(start, start);
  else start();
})();
