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
  'window.APP_BUILD = ' + buildNumber + ';\nwindow.APP_VERSION = ' + JSON.stringify(process.env.VERSION_NAME || '1.0') + ';\n');

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
