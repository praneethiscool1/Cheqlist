// Prepares the Android project. Run by the GitHub Actions workflow (and runnable locally):
//   npm ci && node scripts/build-android.js
// It does NOT compile the APK; the workflow runs Gradle afterwards.
//
// What it does:
//   1. Copies the web app into www/ (plus the Capacitor runtime), tweaking index.html for the app.
//   2. Creates the android/ project (npx cap add android) if it does not exist, then syncs plugins.
//   3. Patches the generated project: permissions, version, signing, icons, splash.
// Every patch checks that the text it expects is really there and stops with a clear error if not,
// so a template change can never silently produce a broken app.
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var root = path.resolve(__dirname, '..');
var www = path.join(root, 'www');
var androidDir = path.join(root, 'android');

function log(m) { console.log('[android] ' + m); }
function fail(m) { console.error('[android] ERROR: ' + m); process.exit(1); }
function run(cmd) { log('$ ' + cmd); cp.execSync(cmd, { cwd: root, stdio: 'inherit' }); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s); }

function mustReplace(text, from, to, what) {
  if (typeof from === 'string' ? text.indexOf(from) === -1 : !from.test(text)) fail('could not find ' + what + ' to patch');
  return text.replace(from, to);
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src, { withFileTypes: true }).forEach(function (e) {
    var s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  });
}

// ---------- 1. web files ----------
var WEB_FILES = [
  'index.html', 'style.css', 'script.js', 'sortable.min.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];
log('copying web files to www/');
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
WEB_FILES.forEach(function (f) {
  if (!fs.existsSync(path.join(root, f))) fail('missing web file ' + f);
  fs.copyFileSync(path.join(root, f), path.join(www, f));
});

// Fonts folder (the font file and its licence).
copyDir(path.join(root, 'fonts'), path.join(www, 'fonts'));

var capRuntime = path.join(root, 'node_modules', '@capacitor', 'core', 'dist', 'capacitor.js');
if (!fs.existsSync(capRuntime)) fail('run "npm ci" first (node_modules/@capacitor/core is missing)');
fs.copyFileSync(capRuntime, path.join(www, 'capacitor.js'));

// Tell the app which build it is, so it can notice when a newer one is released.
var buildNumber = parseInt(process.env.VERSION_CODE || '1', 10) || 1;
write(path.join(www, 'build-info.js'),
  'window.APP_BUILD = ' + buildNumber + ';\nwindow.APP_BUILT_AT = ' + JSON.stringify(new Date().toISOString()) + ';\nwindow.APP_VERSION = ' + JSON.stringify(process.env.VERSION_NAME || '1.0') + ';\n' +
  'window.APP_NOTES = ' + JSON.stringify(fs.existsSync(path.join(root, 'release-notes.txt')) ? read(path.join(root, 'release-notes.txt')) : '') + ';\n');

var html = read(path.join(www, 'index.html'));
// Without viewport-fit=cover, Android keeps the page out from under the status and navigation bars.
html = mustReplace(html, ', viewport-fit=cover', '', 'viewport-fit=cover');
// The Capacitor runtime must load before script.js so the app can see the native plugins.
html = mustReplace(html, '<script src="script.js"></script>', '<script src="capacitor.js"></script>\n<script src="build-info.js"></script>\n<script src="script.js"></script>', 'script.js tag');
write(path.join(www, 'index.html'), html);

// ---------- 2. android project ----------
if (!fs.existsSync(androidDir)) run('npx cap add android');
run('npx cap sync android');

// ---------- 3. patches ----------
var main = path.join(androidDir, 'app', 'src', 'main');

// Manifest: let the app schedule exact alarms without a settings detour, and post notifications.
var manifestPath = path.join(main, 'AndroidManifest.xml');
var manifest = read(manifestPath);
if (manifest.indexOf('USE_EXACT_ALARM') === -1) {
  manifest = mustReplace(manifest, '</manifest>',
    '    <uses-permission android:name="android.permission.USE_EXACT_ALARM" />\n' +
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>', '</manifest>');
}
write(manifestPath, manifest);

var APP_SETTINGS_JAVA = [
  "package __PACKAGE__;",
  "",
  "import android.appwidget.AppWidgetManager;",
  "import android.content.ComponentName;",
  "import android.content.Context;",
  "import android.content.Intent;",
  "import android.net.Uri;",
  "import android.os.Build;",
  "import android.provider.Settings;",
  "",
  "import com.getcapacitor.JSObject;",
  "import com.getcapacitor.Plugin;",
  "import com.getcapacitor.PluginCall;",
  "import com.getcapacitor.PluginMethod;",
  "import com.getcapacitor.annotation.CapacitorPlugin;",
  "",
  "/** Opens this app's notification settings screen (falls back to the app's info screen). */",
  "@CapacitorPlugin(name = \"AppSettings\")",
  "public class AppSettingsPlugin extends Plugin {",
  "",
  "    @PluginMethod",
  "    public void openNotificationSettings(PluginCall call) {",
  "        Context context = getContext();",
  "        try {",
  "            Intent intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);",
  "            intent.putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());",
  "            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);",
  "            context.startActivity(intent);",
  "            call.resolve();",
  "        } catch (Exception first) {",
  "            try {",
  "                Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,",
  "                        Uri.fromParts(\"package\", context.getPackageName(), null));",
  "                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);",
  "                context.startActivity(intent);",
  "                call.resolve();",
  "            } catch (Exception second) {",
  "                call.reject(\"Could not open the settings screen\");",
  "            }",
  "        }",
  "    }",
  "",
  "    /** Asks the phone's home screen to place the Today widget (the person picks the spot). started=false when the launcher cannot do this. */",
  "    @PluginMethod",
  "    public void addWidget(PluginCall call) {",
  "        try {",
  "            Context context = getContext();",
  "            AppWidgetManager manager = AppWidgetManager.getInstance(context);",
  "            JSObject ret = new JSObject();",
  "            boolean started = false;",
  "            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.isRequestPinAppWidgetSupported()) {",
  "                started = manager.requestPinAppWidget(new ComponentName(context, TodayWidgetProvider.class), null, null);",
  "            }",
  "            ret.put(\"started\", started);",
  "            call.resolve(ret);",
  "        } catch (Exception e) {",
  "            call.reject(\"Could not ask for the widget\");",
  "        }",
  "    }",
  "",
  "    /** Hands the widget the task list (a small JSON text) and redraws any widget on the home screen. */",
  "    @PluginMethod",
  "    public void setWidgetTasks(PluginCall call) {",
  "        try {",
  "            String tasks = call.getString(\"tasks\", \"[]\");",
  "            getContext().getSharedPreferences(TodayWidgetService.PREFS, Context.MODE_PRIVATE)",
  "                    .edit().putString(TodayWidgetService.KEY_TASKS, tasks).apply();",
  "            TodayWidgetProvider.refreshAll(getContext());",
  "            call.resolve();",
  "        } catch (Exception e) {",
  "            call.reject(\"Could not update the widget\");",
  "        }",
  "    }",
  "",
  "    /** Opens a GitHub release download in the phone's browser, once. Only https GitHub release links are accepted. */",
  "    @PluginMethod",
  "    public void openUrl(PluginCall call) {",
  "        String url = call.getString(\"url\", \"\");",
  "        if (url == null || !url.startsWith(\"https://github.com/\") || !url.contains(\"/releases/download/\")) {",
  "            call.reject(\"Not a GitHub release link\");",
  "            return;",
  "        }",
  "        try {",
  "            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));",
  "            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);",
  "            getContext().startActivity(intent);",
  "            call.resolve();",
  "        } catch (Exception e) {",
  "            call.reject(\"Could not open the download\");",
  "        }",
  "    }",
  "}"
].join('\n') + '\n';

// A tiny native helper so the app can open its own notification settings (used when the phone has stopped
// showing its permission box). If the generated MainActivity does not look as expected, this is skipped with a
// warning and the app falls back to written instructions: the build never breaks over it.
(function addSettingsHelper() {
  var javaRoot = path.join(main, 'java');
  var mainActivity = null;
  (function find(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) find(p); else if (e.name === 'MainActivity.java') mainActivity = p;
    });
  })(javaRoot);
  if (!mainActivity) { log('WARNING: MainActivity.java not found; skipping the "Open settings" helper'); return; }
  var src = read(mainActivity);
  var pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(src);
  var emptyClass = /public class MainActivity extends BridgeActivity\s*\{\s*\}/;
  if (src.indexOf('AppSettingsPlugin') !== -1) return; // already patched
  if (!pkg || !emptyClass.test(src)) { log('WARNING: unexpected MainActivity.java; skipping the "Open settings" helper'); return; }
  var template = APP_SETTINGS_JAVA;
  write(path.join(path.dirname(mainActivity), 'AppSettingsPlugin.java'), template.replace('__PACKAGE__', pkg[1]));
  src = src.replace(emptyClass,
    'public class MainActivity extends BridgeActivity {\n' +
    '    @Override\n' +
    '    public void onCreate(android.os.Bundle savedInstanceState) {\n' +
    '        registerPlugin(AppSettingsPlugin.class);\n' +
    '        super.onCreate(savedInstanceState);\n' +
    '    }\n' +
    '}');
  write(mainActivity, src);
  log('added the "Open settings" helper to ' + pkg[1]);
})();

// Home-screen widget "Today": two small Java files (android-widget/), its layouts and colours (android-res/), and the
// receiver + service entries in the manifest. The widget is optional for the person (they add it from the home screen's
// widget list); the Java files are always added because the app's helper refers to them. Only the manifest entry
// is guarded: if the manifest does not look as expected the widget simply will not appear in the list.
(function addWidget() {
  var javaRoot = path.join(main, 'java');
  var dir = null;
  (function find(d) {
    if (!fs.existsSync(d)) return;
    fs.readdirSync(d, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(d, e.name);
      if (e.isDirectory()) find(p); else if (e.name === 'MainActivity.java') dir = d;
    });
  })(javaRoot);
  if (!dir) fail('could not find MainActivity.java for the widget');
  var pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(read(path.join(dir, 'MainActivity.java')));
  if (!pkg) fail('could not read the package name for the widget');
  ['TodayWidgetProvider.java', 'TodayWidgetService.java'].forEach(function (f) {
    var src = path.join(root, 'android-widget', f);
    if (!fs.existsSync(src)) fail('missing android-widget/' + f);
    write(path.join(dir, f), read(src).replace('__PACKAGE__', pkg[1]));
  });
  var mp = path.join(main, 'AndroidManifest.xml');
  var mf = read(mp);
  if (mf.indexOf('TodayWidgetProvider') !== -1) return;
  if (mf.indexOf('</application>') === -1) { log('WARNING: unexpected manifest; the home-screen widget will not be offered'); return; }
  mf = mf.replace('</application>',
    '    <receiver\n' +
    '            android:name=".TodayWidgetProvider"\n' +
    '            android:label="@string/widget_name"\n' +
    '            android:exported="true">\n' +
    '            <intent-filter>\n' +
    '                <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />\n' +
    '                <action android:name="android.intent.action.DATE_CHANGED" />\n' +
    '                <action android:name="android.intent.action.TIME_SET" />\n' +
    '                <action android:name="android.intent.action.TIMEZONE_CHANGED" />\n' +
    '            </intent-filter>\n' +
    '            <meta-data android:name="android.appwidget.provider" android:resource="@xml/today_widget_info" />\n' +
    '        </receiver>\n' +
    '        <service\n' +
    '            android:name=".TodayWidgetService"\n' +
    '            android:exported="false"\n' +
    '            android:permission="android.permission.BIND_REMOTEVIEWS" />\n' +
    '    </application>');
  write(mp, mf);
  log('added the "Today" home-screen widget');
})();

// Resources: icons, status-bar icon, splash colour.
var resSrc = path.join(root, 'android-res');
var resDst = path.join(main, 'res');
// The template's splash images would override our plain splash; remove them.
fs.readdirSync(resDst).forEach(function (d) {
  var f = path.join(resDst, d, 'splash.png');
  if (/^drawable/.test(d) && fs.existsSync(f)) fs.rmSync(f);
});
copyDir(resSrc, resDst);
fs.rmSync(path.join(resDst, 'todo-fallback.keystore'), { force: true });

// Window background: the strips behind the status and navigation bars. Match the app's paper colour
// (light by day, dark at night) instead of Android's default grey.
var stylesPath = path.join(resDst, 'values', 'styles.xml');
var styles = read(stylesPath);
if (styles.indexOf('window_bg') === -1) {
  styles = mustReplace(styles, '<item name="android:background">@null</item>',
    '<item name="android:background">@null</item>\n        <item name="android:windowBackground">@color/window_bg</item>', 'NoActionBar style item');
  write(stylesPath, styles);
}

// Version: every workflow run gets a higher versionCode so each build installs over the last one.
var versionCode = parseInt(process.env.VERSION_CODE || '1', 10);
if (!(versionCode >= 1)) fail('VERSION_CODE must be a positive number');
var versionName = process.env.VERSION_NAME || '1.0';
var gradlePath = path.join(androidDir, 'app', 'build.gradle');
var gradle = read(gradlePath);
if (gradle.indexOf('// todo-patched') === -1) {
  gradle = mustReplace(gradle, /versionCode\s+\d+/, 'versionCode ' + versionCode, 'versionCode');
  gradle = mustReplace(gradle, /versionName\s+"[^"]*"/, 'versionName "' + versionName + '"', 'versionName');

  // Signing: Android only installs an update over an app if both were signed with the SAME key.
  // The key and passwords come from the environment (GitHub secrets), never from this file.
  var signing =
    '    // todo-patched\n' +
    '    signingConfigs {\n' +
    '        todoRelease {\n' +
    '            storeFile file(System.getenv("TODO_KEYSTORE_PATH") ?: "../todo.keystore")\n' +
    '            storePassword System.getenv("TODO_KEYSTORE_PASSWORD")\n' +
    '            keyAlias System.getenv("TODO_KEY_ALIAS")\n' +
    '            keyPassword System.getenv("TODO_KEY_PASSWORD")\n' +
    '        }\n' +
    '    }\n';
  gradle = mustReplace(gradle, 'android {\n', 'android {\n' + signing, 'android { block');
  gradle = mustReplace(gradle, /release\s*\{\n/, function (m) { return m + '            signingConfig signingConfigs.todoRelease\n'; }, 'release build type');
  write(gradlePath, gradle);
}

log('done. Next: cd android && ./gradlew assembleRelease');
