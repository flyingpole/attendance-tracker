# Florida Conquer — Attendance Tracker

Scan-in kiosk + roster/badge admin + nightly attendance emails, built to run entirely
on free hosting: **GitHub Pages** (frontend) + **Firebase Firestore** (database) +
**GitHub Actions** (nightly report job) + **Gmail SMTP** (email delivery).

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

### 3. Email delivery (Gmail)

No new account needed — this uses a Gmail address you already have. Regular Gmail
passwords don't work for programmatic sending, so you need an **App Password** instead:

1. On the Google account that will send the reports: [myaccount.google.com/security](https://myaccount.google.com/security) → turn on **2-Step Verification** if it isn't already on (required for App Passwords to be available).
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → create a new app password (name it anything, e.g. "Attendance Tracker") → copy the 16-character password it gives you.
3. Add these repo secrets (**Settings → Secrets and variables → Actions → New repository secret**):
   - `GMAIL_USER` — the full Gmail address (e.g. `you@gmail.com`)
   - `GMAIL_APP_PASSWORD` — the 16-character app password from step 2 (not your regular Gmail password)
   - `DIRECTOR_EMAIL` — the director's email address (receives the full daily summary)

Gmail caps regular accounts at 500 sends/day, far more than a club needs. If you'd
rather use a dedicated transactional service instead (e.g. Resend, SendGrid) later,
swap the `nodemailer` transport in `scripts/send-daily-report.js` for their SDK.

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
   practice block. Two entry types:
   - **Recurring** — pick the day(s) of the week, a start/end time, and a **start date**
     (required) and **end date** (optional — leave blank if ongoing). The date range keeps
     old and new seasons from overlapping: when a team's practice days change (e.g. Mon/Tue
     one season, Wed/Thu the next), end the old entry the day the change happens and add a
     new one starting there, rather than editing the old one in place.
   - **Single date** — a one-off event on exactly one date, not part of any recurring
     pattern (a special clinic, a tournament day, etc.).

   Either kind is either a **Team Practice** (matches by the player's team) or a
   **Positional Practice** (open to anyone who scans in during that window — players cross
   over between positional clinics all the time, so it's not restricted by a player's own
   tagged position; the position you pick is just a label). A scan counts starting 15
   minutes before the listed start time, and if more than one entry is active at once (e.g.
   team practice overlapping a positional clinic), one scan checks the player into all of
   them. This is what the kiosk uses to figure out what to record.

   The Week/Month calendar views on this tab show the schedule as it actually applies to
   real dates (respecting each entry's date range). Click any event on the calendar for
   options: **Edit**, **Cancel this date only** (pulls a single occurrence out of a
   recurring series — e.g. a holiday — without ending the whole series; undo it anytime
   from the "Canceled occurrences" list at the bottom of this tab), or **Delete entire
   series**. Dragging an event vertically on the Week view adjusts its time.
4. **Generate badges** (Admin → Badges): pick a team (or a single player), preview,
   then download a printable PDF sized for **Avery Presta® 94107** (2" × 2" square labels,
   12 per sheet) — just print, no cutting needed.
5. On practice days, players just scan in — the kiosk automatically detects which
   practice they're attending from the schedule. For something not worth adding to the
   schedule at all, click **"Switch to manual picker"** on the kiosk and pick from the
   **Practice Sessions** list instead (Admin → Practice Sessions manages that list). If
   nothing matches at scan time, it's still recorded, just labeled "Open/Unscheduled
   Check-in" so nothing gets lost.
6. Every night, the director gets one email with every team's check-ins, and each
   coach with an email on file gets their own team's check-ins.

## Local development / testing

You can build and test this entirely offline using the **Firebase Local Emulator Suite**,
without touching your real Firebase project or sending real email:

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
- `schedule/{scheduleId}` — the master schedule the kiosk uses to auto-detect a practice.
  Two shapes, distinguished by `kind`:
  - Recurring: `{ kind: "recurring", days: [0-6, ...], startDate: "2026-01-05", endDate: "2026-05-20" | null, startTime, endTime, type: "team"|"position", teamId, position, label }`.
    `days` uses JS's `Date.getDay()` numbering (0 = Sunday … 6 = Saturday). `endDate: null`
    means still ongoing. Entries created before this field existed have no `startDate`/`endDate`
    and are treated as unbounded until edited.
  - Single date: `{ kind: "single", date: "2026-03-14", startTime, endTime, type, teamId, position, label }`.
- `scheduleCancellations/{id}` — `{ scheduleId, date }` — pulls one specific date out of a
  recurring `schedule` entry (e.g. a holiday) without ending the whole series.
- `sessions/{sessionId}` — `{ label, active, createdAt }` — the manual-override list
  for one-off events not on the recurring schedule.
- `attendance/{autoId}` — `{ playerId, playerName, teamId, sessionId, sessionLabel, timestamp }`
  (write-only from the client; only the nightly job, using the Admin SDK, can read it).
  A single badge scan can create more than one of these — one per schedule entry that's
  active at scan time.
