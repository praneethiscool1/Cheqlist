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
  var newReminder = document.getElementById('new-reminder');
  var newColorSlot = document.getElementById('new-color-slot');
  var listEl = document.getElementById('task-list');
  var emptyEl = document.getElementById('empty');
  var remindersEl = document.getElementById('reminders');
  var notifyBar = document.getElementById('notify-bar');

  // Each task looks like:
  // { id, text, done, color: 'green' | 'yellow' | 'red' | null,
  //   reminder: 'YYYY-MM-DDTHH:MM' or '', notified: true/false }
  var tasks = loadTasks();
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
      li.remove();
      updateEmpty();
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

  function renderAll() {
    listEl.textContent = '';
    tasks.forEach(function (task) { listEl.appendChild(renderTask(task)); });
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
      color: newColor,
      reminder: newReminder.value,
      notified: false
    };

    tasks.unshift(task); // newest task goes on top
    saveTasks();
    listEl.insertBefore(renderTask(task), listEl.firstChild);
    updateEmpty();

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
    Array.prototype.forEach.call(listEl.children, function (li) { li.paintRow(); });
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
  renderAll();
  updateNotifyBar();
  checkReminders();
})();
