// To-Do Checklist: plain JavaScript, no libraries.
// Tasks are saved in the browser's localStorage, so they survive refreshes.
(function () {
  'use strict';

  var STORAGE_KEY = 'todo-checklist-v1';
  var COLORS = ['green', 'yellow', 'red'];
  var CHECK_EVERY_MS = 15000; // how often we look for due reminders

  // ---------- Page elements ----------
  var form = document.getElementById('add-form');
  var taskInput = document.getElementById('task-input');
  var newDate = document.getElementById('new-date');
  var newReminder = document.getElementById('new-reminder');
  var newColorSlot = document.getElementById('new-color-slot');
  var listEl = document.getElementById('task-list');
  var emptyEl = document.getElementById('empty');
  var remindersEl = document.getElementById('reminders');
  var notifyBar = document.getElementById('notify-bar');

  // Each task looks like:
  // { id, text, done, date: 'YYYY-MM-DD', color: 'green' | 'yellow' | 'red' | null,
  //   reminder: 'YYYY-MM-DDTHH:MM' or '', notified: true/false }
  var renderedToday = ''; // the day that "Today" meant the last time the list was drawn
  var tasks = loadTasks();
  saveTasks(); // stores the date given to older tasks that had none
  var newColor = null; // priority chosen in the "add" form (none until you pick one)
  var saveWarningShown = false;

  // ---------- Saving and loading ----------
  function loadTasks() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      var data = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(data)) return [];
      return data
        .filter(function (t) { return t && typeof t.text === 'string'; })
        .map(function (t) {
          return {
            id: typeof t.id === 'string' ? t.id : makeId(),
            text: t.text,
            done: t.done === true,
            date: isDateString(t.date) ? t.date : todayString(),
            color: COLORS.indexOf(t.color) !== -1 ? t.color : null,
            reminder: typeof t.reminder === 'string' ? t.reminder : '',
            notified: t.notified === true
          };
        });
    } catch (e) {
      return [];
    }
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch (e) {
      if (!saveWarningShown) {
        saveWarningShown = true;
        addBanner('Your browser blocked saving, so tasks will be lost when you close this page.', 'warn');
      }
    }
  }

  function makeId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Small helpers ----------
  function el(tag, className) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // Today's date as "YYYY-MM-DD" in your local time zone.
  function todayString() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isDateString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  function parseDateString(value) {
    var p = value.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  // Heading text for a day: "Today", "Tomorrow", "Yesterday" or the weekday and date.
  function dayLabel(date, today) {
    var d = parseDateString(date);
    var options = { weekday: 'short', day: 'numeric', month: 'short' };
    if (d.getFullYear() !== parseDateString(today).getFullYear()) options.year = 'numeric';
    var full = d.toLocaleDateString([], options);
    var diff = Math.round((d - parseDateString(today)) / 86400000);
    if (diff === 0) return { main: 'Today', sub: full };
    if (diff === 1) return { main: 'Tomorrow', sub: full };
    if (diff === -1) return { main: 'Yesterday', sub: full };
    return { main: full, sub: '' };
  }

  // Order of the day headings: today first, then coming days (soonest first),
  // then earlier days (most recent first).
  function compareDays(a, b) {
    function group(d) { return d === renderedToday ? 0 : (d > renderedToday ? 1 : 2); }
    var ga = group(a), gb = group(b);
    if (ga !== gb) return ga - gb;
    if (ga === 1) return a < b ? -1 : 1;
    return a < b ? 1 : -1;
  }

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function dueTime(task) {
    if (!task.reminder) return NaN;
    return new Date(task.reminder).getTime(); // "YYYY-MM-DDTHH:MM" is read as local time
  }

  function isOverdue(task) {
    var due = dueTime(task);
    return !task.done && !isNaN(due) && due <= Date.now();
  }

  function formatDateTime(value) {
    var d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString([], {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit'
    });
  }

  // ---------- Color (priority) picker ----------
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

  var newColorPicker = makeColorPicker(null, function (color) { newColor = color; });
  newColorSlot.appendChild(newColorPicker);

  // ---------- Drawing one task row ----------
  function renderTask(task) {
    var li = el('li', 'task');
    li.dataset.id = task.id;

    var check = el('input');
    check.type = 'checkbox';
    check.checked = task.done;
    check.setAttribute('aria-label', 'Mark task as done');

    var text = el('span', 'task-text');
    text.textContent = task.text;

    var del = el('button', 'delete-btn');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Delete task';
    del.setAttribute('aria-label', 'Delete task');

    var meta = el('div', 'meta');

    // Priority color
    var picker = makeColorPicker(task.color, function (color) {
      task.color = color;
      saveTasks();
      paintRow();
    });

    // The day this task belongs to
    var dateInput = el('input');
    dateInput.type = 'date';
    dateInput.value = task.date;
    dateInput.setAttribute('aria-label', 'Task date');

    // Optional reminder
    var reminderBox = el('span', 'reminder');
    var reminderInput = el('input');
    reminderInput.type = 'datetime-local';
    reminderInput.value = task.reminder;
    reminderInput.setAttribute('aria-label', 'Reminder date and time (optional)');
    var overdueLabel = el('span', 'overdue-label');
    overdueLabel.textContent = 'Overdue';
    var clearReminder = el('button', 'clear-reminder');
    clearReminder.type = 'button';
    clearReminder.textContent = 'Remove reminder';
    reminderBox.appendChild(reminderInput);
    reminderBox.appendChild(overdueLabel);
    reminderBox.appendChild(clearReminder);

    meta.appendChild(picker);
    meta.appendChild(dateInput);
    meta.appendChild(reminderBox);
    li.appendChild(check);
    li.appendChild(text);
    li.appendChild(del);
    li.appendChild(meta);

    // Updates how the row looks to match the task's data.
    function paintRow() {
      li.classList.toggle('done', task.done);
      COLORS.forEach(function (c) { li.classList.toggle('p-' + c, task.color === c); });
      var overdue = isOverdue(task);
      reminderBox.classList.toggle('overdue', overdue);
      overdueLabel.hidden = !overdue;
      clearReminder.hidden = !task.reminder;
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

    dateInput.addEventListener('change', function () {
      task.date = isDateString(dateInput.value) ? dateInput.value : todayString();
      saveTasks();
      renderAll(); // the task moves under its new date heading
    });

    reminderInput.addEventListener('change', function () {
      task.reminder = reminderInput.value; // '' if cleared
      task.notified = false;
      saveTasks();
      paintRow();
      checkReminders(); // if the time you picked is already past, tell you right away
    });

    clearReminder.addEventListener('click', function () {
      task.reminder = '';
      task.notified = false;
      reminderInput.value = '';
      saveTasks();
      paintRow();
    });

    paintRow();
    return li;
  }

  function updateEmpty() {
    emptyEl.hidden = tasks.length > 0;
  }

  // Draws every task, grouped under a heading for its date.
  function renderAll() {
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
      var section = el('section', 'day' + (date === renderedToday ? ' is-today' : ''));
      var label = dayLabel(date, renderedToday);
      var heading = el('h2', 'day-title');
      heading.textContent = label.main;
      if (label.sub) {
        var sub = el('span', 'day-date');
        sub.textContent = label.sub;
        heading.appendChild(sub);
      }
      var list = el('ul', 'task-list');
      byDate[date].forEach(function (task) { list.appendChild(renderTask(task)); });
      section.appendChild(heading);
      section.appendChild(list);
      listEl.appendChild(section);
    });

    updateEmpty();
  }

  // ---------- Adding a task ----------
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var text = taskInput.value.trim();
    if (!text) {
      taskInput.focus();
      return;
    }

    var task = {
      id: makeId(),
      text: text,
      done: false,
      date: isDateString(newDate.value) ? newDate.value : todayString(),
      color: newColor,
      reminder: newReminder.value,
      notified: false
    };

    tasks.unshift(task); // newest task goes on top
    saveTasks();
    renderAll();

    taskInput.value = '';
    newReminder.value = '';
    newColor = null;
    newColorPicker.reset();
    taskInput.focus();

    checkReminders();
  });

  // ---------- Reminders ----------
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

  function notificationsAllowed() {
    return 'Notification' in window && Notification.permission === 'granted';
  }

  function fireReminder(task) {
    // 1) In-app reminder (always works while the page is open)
    addBanner('Reminder: ' + task.text + ' (' + formatDateTime(task.reminder) + ')');

    // 2) Browser notification (only if you allowed it)
    if (notificationsAllowed()) showSystemNotification(task);
  }

  // Phones (Android Chrome) only allow notifications through the service worker,
  // so try that first and fall back to the plain Notification API.
  function showSystemNotification(task) {
    var options = { body: task.text, icon: 'icon-192.png' };

    function plain() {
      try {
        new Notification('Task reminder', options);
      } catch (e) {
        // Not allowed here; the in-app reminder still showed.
      }
    }

    if ('serviceWorker' in navigator && navigator.serviceWorker.getRegistration) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg && reg.showNotification) {
          return reg.showNotification('Task reminder', options);
        }
        plain();
      }).catch(plain);
    } else {
      plain();
    }
  }

  // Looks for reminders whose time has arrived and that we haven't announced yet.
  function checkReminders() {
    // A new day started while the app was open: refresh the "Today" heading.
    if (todayString() !== renderedToday) {
      var oldToday = renderedToday;
      renderAll();
      if (newDate.value === oldToday) newDate.value = renderedToday;
    }

    var now = Date.now();
    var changed = false;

    tasks.forEach(function (task) {
      if (!task.reminder || task.done || task.notified) return;
      var due = dueTime(task);
      if (isNaN(due) || due > now) return;

      task.notified = true;
      changed = true;
      fireReminder(task);
    });

    if (changed) saveTasks();

    // Refresh the "Overdue" look of rows that are on screen.
    Array.prototype.forEach.call(listEl.querySelectorAll('.task'), function (li) { li.paintRow(); });
  }

  setInterval(checkReminders, CHECK_EVERY_MS);
  // Browsers slow down timers in background tabs, so also check when you come back.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) checkReminders();
  });
  window.addEventListener('focus', checkReminders);

  // ---------- Notification permission message ----------
  function updateNotifyBar() {
    notifyBar.textContent = '';

    if (!('Notification' in window)) {
      notifyBar.textContent = 'Browser notifications are not available here. Reminders will appear inside this page while it is open.';
      return;
    }

    if (Notification.permission === 'granted') {
      notifyBar.textContent = 'Browser notifications are on.';
    } else if (Notification.permission === 'denied') {
      notifyBar.textContent = 'Browser notifications are blocked here, so reminders will only appear inside this page.';
    } else {
      var btn = el('button', 'link-btn');
      btn.type = 'button';
      btn.textContent = 'Try turning on browser notifications';
      btn.addEventListener('click', function () {
        try {
          Promise.resolve(Notification.requestPermission()).then(updateNotifyBar, updateNotifyBar);
        } catch (e) {
          updateNotifyBar();
        }
      });
      notifyBar.appendChild(btn);
    }
  }

  // ---------- Offline support (lets the app be installed and open without internet) ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {
        // Not available (for example, the page was opened as a plain file). The app still works.
      });
    });
  }

  // ---------- Start ----------
  newDate.value = todayString();
  renderAll();
  updateNotifyBar();
  checkReminders();
})();
