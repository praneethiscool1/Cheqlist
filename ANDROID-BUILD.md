# Building the Android app

The Android app is the same Cheqlist app wrapped as a real Android app (Capacitor). It keeps its own storage,
so clearing Chrome's data does not touch it, and it schedules reminders with the phone's alarm system,
so they arrive even when the app is closed.

## One-time setup (about 10 minutes)
1. Upload everything in this folder to your GitHub repo `Cheqlist`, keeping the folder structure:
   `index.html, style.css, script.js, sw.js, package.json, capacitor.config.json, .gitignore, ANDROID-BUILD.md,`
   `scripts/build-android.js, android-res/ (whole folder), .github/workflows/build-android.yml`
   (On a computer: drag the unzipped contents into GitHub's "Add file > Upload files".
   Hidden folders like `.github` may need GitHub Desktop or `git`; or create the file with
   "Add file > Create new file" and type the path `.github/workflows/build-android.yml`.)
2. Repo > Settings > Actions > General > Workflow permissions: choose "Read and write permissions", Save.
3. Repo > Actions > "Build Android app" > Run workflow. Takes about 5 to 10 minutes.
4. When it finishes, open the repo's Releases page, and download `cheqlist.apk` on your phone.
   Open it; Android will ask to allow installs from your browser or Files app. Allow it, install.
5. Open the app and press "Enable notifications". Allow notifications (and "Alarms & reminders" if asked).

## Moving your existing tasks into the app
In the old web app: Backup and restore > Copy backup. In the new app: Backup and restore > paste into the box >
Restore from pasted backup > Replace.

## Updating later
1. Upload the changed files to the repo. The build starts by itself (Actions tab shows it) and publishes a new release.
2. Next time anyone opens the installed app (and is online), it shows "A new version of Cheqlist is available".
   Tap Download, open the downloaded file and tap Install. It installs over the old one and keeps the tasks.
Android does not allow apps to install updates silently, so that one Install tap is always needed.
The app checks at most once every 6 hours. The version number is shown at the bottom of Backup and restore.
Updates only install over the old app if every build is signed with the same key (see below).

## Signing key (important)
- Without secrets, builds use the key in `android-res/todo-fallback.keystore`. It is public in your repo, so
  it is convenient but is not proof the APK came from you. Fine for a personal app.
- Better: create your own key and add four repository secrets (ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD,
  ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD). In GitHub Codespaces (has Java):
  `keytool -genkeypair -keystore my.keystore -alias todo -keyalg RSA -keysize 2048 -validity 36500`
  then `base64 -w0 my.keystore` for the first secret. Keep a copy of the keystore and passwords safe.
- Do this BEFORE you rely on the app. Switching keys later means uninstalling the app (export a backup first).

## If reminders do not arrive
Settings > Apps > Cheqlist > Battery > Unrestricted (some brands, e.g. Xiaomi, Oppo, Vivo, OnePlus, also have
an "Autostart" switch). Check Settings > Apps > Cheqlist > Notifications is on.

## What is and is not verified
Verified here: the app logic against mocked phone plugins, the real drag-and-drop in a browser, and that the
build script generates a valid Android project. NOT verified here: compiling the APK and notification delivery
on a real phone, because this environment cannot reach Android's build servers. The first workflow run is the
first real build; if it fails, open the failed run's log and send me the red lines.

## Home-screen widget

The build also adds a small "Cheqlist: today" widget (files in `android-widget/` and the `widget_*` / `today_widget*` files in `android-res/`). It only displays today's tasks; the app hands it the list whenever tasks change. Add it with the "Add widget" button inside the app, or long-press the home screen, open Widgets and add "Cheqlist: today".
