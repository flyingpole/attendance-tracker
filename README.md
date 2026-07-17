# Florida Conquer — Attendance Tracker

Scan-in kiosk + roster/badge admin + nightly attendance emails, built to run entirely
on free hosting: **GitHub Pages** (frontend) + **Firebase Firestore** (database) +
**GitHub Actions** (nightly report job) + **Resend** (email delivery).

## How it works

- **`index.html`** — the kiosk page. Put this on the lobby PC, plug in the USB QR
  scanner (it types the scanned code + Enter, just like a keyboard — no drivers
  needed), and leave the page open. Players scan their badge to check in. Which
  practice they're attending is detected **automatically** from the master
  schedule (their team + the time of day, or their position for a mixed-team
  positional clinic) — no one has to pick anything on the kiosk day to day.
- **`admin.html`** — the director's console (behind a login). Manage teams, import
  rosters from CSV (including each player's position), set up the master
  schedule, and generate printable QR badges.
- **GitHub Actions** runs every night, reads the previous day's scans straight from
  Firestore, and emails a summary to the director (all teams) and each coach (their
  team only).

## One-time setup

### 1. Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (the free Spark plan is enough, no credit card required).
2. **Build → Firestore Database → Create database** (start in production mode).
3. **Build → Authentication → Sign-in method → Email/Password** → enable it.
4. **Authentication → Users → Add user** — create yourself as the one director/admin login.
5. **Project settings (gear icon) → General → Your apps → Add app → Web app**. Copy
   the `firebaseConfig` object it gives you into [`assets/firebase-config.js`](assets/firebase-config.js),
   replacing the placeholder values.
6. **Firestore Database → Rules** → paste in the contents of [`firestore.rules`](firestore.rules) → Publish.

### 2. Service account (for the nightly report job)

1. **Project settings → Service accounts → Generate new private key**. This downloads a JSON file — keep it secret, don't commit it.
2. In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Value: the entire contents of that JSON file.

### 3. Email delivery (Resend)

1. Create a free account at [resend.com](https://resend.com) (100 emails/day free).
2. Verify a sending domain or use their onboarding test address, then create an API key.
3. Add these repo secrets (same **Settings → Secrets and variables → Actions** page):
   - `RESEND_API_KEY` — your Resend API key
   - `DIRECTOR_EMAIL` — the director's email address (receives the full daily summary)
   - `FROM_EMAIL` — the "from" address to send as (must be on your verified Resend domain)

### 4. GitHub Pages

1. **Settings → Pages → Source** → deploy from the `main` branch, root folder.
2. Your kiosk will be live at `https://<your-username>.github.io/<repo-name>/`.
3. Bookmark that URL full-screen on the lobby PC. Bookmark `.../admin.html` for yourself.

### 5. Nightly report timing

Edit the cron line in [`.github/workflows/daily-report.yml`](.github/workflows/daily-report.yml)
if 11:00 UTC (~6–7am US Eastern) doesn't suit you — GitHub Actions cron is always UTC.
You can also trigger it manually any time from the **Actions** tab (`workflow_dispatch`).

> Note: GitHub auto-disables scheduled workflows after 60 days with no repo activity.
> If your emails stop, re-enable the workflow under the **Actions** tab.

### 6. Locking down the lobby PC (true kiosk mode)

A web page cannot block someone from closing the window, opening a new tab, or
navigating away — browsers intentionally don't let sites override that. The
kiosk page does the small things it *can* do (right-click disabled, a "leave
this page?" confirmation on close), but real lockdown has to happen one level
up, at the browser or Windows level:

**Chrome/Edge kiosk launch mode** — create a desktop shortcut the lobby PC
uses to open the kiosk, with a target like:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --edge-kiosk-type=fullscreen --noerrdialogs --disable-pinch "http://localhost:8000/index.html"
```

(swap `chrome.exe` for `msedge.exe` if using Edge). This launches full-screen
with no address bar, tabs, or window chrome, and blocks most keyboard
shortcuts for switching away. Put this shortcut in the Windows **Startup**
folder so it launches automatically on boot.

**Windows Assigned Access (kiosk mode)** — for the strongest lockdown, go to
**Settings → Accounts → Family & other users → Set up a kiosk** and assign a
dedicated Windows account that can only run Chrome/Edge with the `--kiosk`
flag above. This prevents access to the desktop, taskbar, and other apps
entirely — the PC boots straight into the scan-in screen.

## Day-to-day use

1. **Add teams** (Admin → Teams): a short team code, name, coach name, and coach email.
2. **Import rosters** (Admin → Roster Import): download the CSV template, fill in
   `Name` + `TeamID` (must match a team code you created) + optional `Email`/`Jersey`/`Position`,
   upload it. Each new player gets a unique badge code automatically. You can also set or
   fix a player's position any time from the roster table itself, without re-importing.
3. **Set up the master schedule** (Admin → Master Schedule): add an entry for each
   recurring practice block — pick the day(s) of the week, a start/end time, and either
   a **Team Practice** (matches by the player's team) or a **Positional Practice**
   (matches by the player's position, for clinics that mix players from different teams).
   This is what the kiosk uses to figure out what to record — set it up once and it repeats
   every week.
4. **Generate badges** (Admin → Badges): pick a team (or a single player), preview,
   then download a printable PDF (2 badges per row, 6 per page) sized for a standard
   luggage-tag holder.
5. On practice days, players just scan in — the kiosk automatically detects which
   practice they're attending from the schedule. For a one-off event not on the
   recurring schedule (tournament, makeup practice), click **"Switch to manual picker"**
   on the kiosk and pick from the **Practice Sessions** list instead (Admin → Practice
   Sessions manages that list). If nothing on the schedule matches at scan time, it's
   still recorded, just labeled "Open/Unscheduled Check-in" so nothing gets lost.
6. Every night, the director gets one email with every team's check-ins, and each
   coach with an email on file gets their own team's check-ins.

## Local development / testing

You can build and test this entirely offline using the **Firebase Local Emulator Suite**,
without touching your real Firebase project or Resend quota:

```sh
npm install -g firebase-tools
firebase login
firebase init emulators   # choose Firestore + Authentication
firebase emulators:start
```

Then serve the site locally (e.g. `npx serve .`) and open:

- `http://localhost:3000/index.html?emulator=1` — kiosk, talking to the local emulator
- `http://localhost:3000/admin.html?emulator=1` — admin console, talking to the local emulator

The `?emulator=1` query param is what tells `assets/firebase.js` to connect to
`127.0.0.1` instead of your real Firebase project — drop it (or just don't add it)
for production.

To test the nightly report script locally against the emulator, point `firebase-admin`
at the emulator via the `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` environment variable
before running `node scripts/send-daily-report.js`.

## Data model (Firestore)

- `teams/{teamId}` — `{ name, coachName, coachEmail }`
- `players/{playerId}` — `{ name, teamId, badgeCode, email, jersey, position, active }`
- `schedule/{scheduleId}` — `{ days: [0-6, ...], startTime: "18:00", endTime: "20:00", type: "team"|"position", teamId, position, label }`
  — the master schedule the kiosk uses to auto-detect a practice. `days` uses
  JS's `Date.getDay()` numbering (0 = Sunday … 6 = Saturday).
- `sessions/{sessionId}` — `{ label, active, createdAt }` — the manual-override list
  for one-off events not on the recurring schedule.
- `attendance/{autoId}` — `{ playerId, playerName, teamId, sessionId, sessionLabel, timestamp }`
  (write-only from the client; only the nightly job, using the Admin SDK, can read it)
