// Builds/refreshes one Google Sheet per team showing every player's attendance
// at team practices (players across the top, one row per practice date, summary
// at the top). Runs from GitHub Actions (.github/workflows/team-sheets.yml) using
// the same service account as the nightly email, via the Sheets + Drive APIs.
//
// The service account creates and owns each spreadsheet, then shares it with
// the coach's email (read-only). The spreadsheet ID is remembered in Firestore
// (reportSheets/{teamId}) so later runs update the same sheet in place.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleAuth } from "google-auth-library";
import { appendFileSync } from "node:fs";
import { resolveMx } from "node:dns/promises";
import {
  buildAttendanceModel,
  renderSheetValues,
  renderAllTeamsValues,
  columnLetter,
  FIRST_DATA_ROW,
  FROZEN_ROWS,
  MISS_ALERT,
  SUMMARY_HEADER_ROW,
} from "./sheet-model.js";

const TZ = process.env.REPORT_TIMEZONE || "America/New_York";
const TAB = "Attendance";
// Season in each sheet's name. Normally read from Firestore (settings/season,
// edited on the admin Teams tab); the SEASON_LABEL env var overrides it.
let SEASON = (process.env.SEASON_LABEL || "").trim();
const DEFAULT_SEASON = "2026-2027";
const TEAM_IDS = (process.env.TEAM_IDS || "16T").split(",").map((s) => s.trim()).filter(Boolean);
// BUILD_MASTER also builds the director's all-teams spreadsheet. It always
// refreshes every team first so the master's team tabs match the team sheets.
const BUILD_MASTER = /^true$/i.test(process.env.BUILD_MASTER || "");
const SHARE_WITH_DIRECTOR = /^true$/i.test(process.env.SHARE_WITH_DIRECTOR || "");
const DIRECTOR_EMAIL = (process.env.DIRECTOR_EMAIL || "").trim();
const MASTER_KEY = "MASTER"; // reportSheets doc id / SHEET_IDS key for the director's spreadsheet
// Comma-separated emails that get edit access to every team sheet (optional).
const EDITOR_EMAILS = (process.env.SHARE_EDITORS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("Missing required environment variable: FIREBASE_SERVICE_ACCOUNT");
  process.exit(1);
}
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const googleAuth = new GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
});

async function google(method, url, body, attempt = 1) {
  const client = await googleAuth.getClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // 429 = the Sheets per-minute write quota; the master sheet writes ~25 tabs
    // in a row, so wait it out (up to ~50s total) instead of failing.
    if ((res.status === 429 || res.status >= 500) && attempt < 7) {
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 10000)));
      return google(method, url, body, attempt + 1);
    }
    const err = new Error(`${method} ${url.split("?")[0]} -> ${res.status}: ${text.slice(0, 600)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE = "https://www.googleapis.com/drive/v3/files";

// ---------- date helpers (report timezone) ----------
const localDateKey = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date);
const formatTime = (date) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(date).replace(/\s/g, " ");
const formatDate = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(
    new Date(Date.UTC(y, m - 1, d, 12))
  );
};
function localMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get("hour") * 60 + get("minute");
}

// ---------- Firestore ----------
async function loadTeamData(teamId, scheduleEntries, cancellations, now) {
  const teamSnap = await db.collection("teams").doc(teamId).get();
  if (!teamSnap.exists) throw new Error(`Team "${teamId}" not found in Firestore.`);
  const team = { id: teamId, ...teamSnap.data() };

  const playersSnap = await db.collection("players").where("teamId", "==", teamId).get();
  const players = [];
  playersSnap.forEach((d) => {
    const data = d.data();
    if (data.active === false) return;
    players.push({ id: d.id, name: data.name, joinedDate: data.joinedDate || null });
  });

  // Look scans up by player (not team) so a player who moved onto this team
  // keeps credit for practices they attended before the move.
  const attendance = [];
  for (let i = 0; i < players.length; i += 30) {
    const ids = players.slice(i, i + 30).map((p) => p.id);
    const snap = await db.collection("attendance").where("playerId", "in", ids).get();
    snap.forEach((d) => {
      const r = d.data();
      if (!r.timestamp) return;
      const time = r.timestamp.toDate();
      attendance.push({ playerId: r.playerId, sessionId: r.sessionId, dateKey: localDateKey(time), time });
    });
  }

  const model = buildAttendanceModel({
    teamId,
    players,
    scheduleEntries,
    cancellations,
    attendance,
    todayKey: localDateKey(now),
    nowMinutes: localMinutes(now),
  });
  return { team, model };
}

// ---------- Google Sheets ----------
const rgb = (hex) => ({
  red: parseInt(hex.slice(1, 3), 16) / 255,
  green: parseInt(hex.slice(3, 5), 16) / 255,
  blue: parseInt(hex.slice(5, 7), 16) / 255,
});

// Optional "TEAM=spreadsheetId" pairs for sheets you created yourself and shared
// with the service account as Editor (so you own them, and the robot never has
// to create files).
const PROVIDED_SHEET_IDS = new Map(
  (process.env.SHEET_IDS || "")
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()))
    .filter(([team, id]) => team && id)
);

// Robot accounts have no Drive storage, so new sheets are created by the Apps
// Script helper (apps-script/sheet-helper.gs) inside the director's own Drive.
const HELPER_URL = process.env.SHEET_HELPER_URL;
const HELPER_SECRET = process.env.SHEET_HELPER_SECRET;
// Off by default: coaches get access (and Google's "shared with you" email) only
// when the workflow is run with share_with_coaches ticked.
const SHARE_WITH_COACHES = /^true$/i.test(process.env.SHARE_WITH_COACHES || "");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callHelper(payload) {
  const res = await fetch(HELPER_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...payload, secret: HELPER_SECRET }),
    redirect: "follow",
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Sheet helper returned something other than JSON (HTTP ${res.status}). Check that the web app is deployed with "Who has access: Anyone". Starts with: ${text.slice(0, 200)}`
    );
  }
  if (!data.ok) throw new Error(`Sheet helper refused the request: ${data.error}`);
  return data;
}

const SHEET_META_FIELDS = "spreadsheetId,sheets(properties(sheetId,title),conditionalFormats)";

async function ensureSpreadsheet(teamId, title) {
  const ref = db.collection("reportSheets").doc(teamId);
  const provided = PROVIDED_SHEET_IDS.get(teamId);
  if (provided) {
    try {
      const meta = await google("GET", `${SHEETS}/${provided}?fields=spreadsheetId,sheets(properties(sheetId,title),conditionalFormats)`);
      await ref.set({ spreadsheetId: provided, url: `https://docs.google.com/spreadsheets/d/${provided}/edit`, providedBy: "SHEET_IDS" }, { merge: true });
      return { id: provided, meta, created: false, ref };
    } catch (err) {
      throw new Error(
        `Can't open the sheet you provided for ${teamId} (${provided}): ${err.message}\n` +
          `Open that Google Sheet, click Share, add ${serviceAccount.client_email} as an Editor, and re-run.`
      );
    }
  }
  const existing = (await ref.get()).data();
  if (existing?.spreadsheetId) {
    try {
      const meta = await google("GET", `${SHEETS}/${existing.spreadsheetId}?fields=spreadsheetId,sheets(properties(sheetId,title),conditionalFormats)`);
      return { id: existing.spreadsheetId, meta, created: false, ref };
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      console.warn(`Saved sheet for ${teamId} is no longer reachable (${err.status}); creating a new one.`);
    }
  }
  if (!HELPER_URL || !HELPER_SECRET) {
    throw new Error(
      `No sheet exists for ${teamId} yet, and the sheet helper isn't configured (SHEET_HELPER_URL / SHEET_HELPER_SECRET secrets). ` +
        `Either set up the helper (see README), or create a blank Google Sheet yourself, share it with ${serviceAccount.client_email} as Editor, ` +
        `and re-run with sheet_ids set to ${teamId}=<the ID from its URL>.`
    );
  }

  const made = await callHelper({
    action: "createSheet",
    title,
    editors: [serviceAccount.client_email],
    // Nobody is added at creation: the helper's sharing always emails people.
    // Access is granted later by ensureShared(), silently.
    viewers: [],
  });
  // Save the ID before anything else can fail, so a re-run reuses this sheet
  // instead of creating a duplicate.
  await ref.set({ spreadsheetId: made.spreadsheetId, url: made.url, createdAt: new Date(), providedBy: "helper" });
  if (made.shareErrors?.length) console.warn(`  helper could not share with: ${made.shareErrors.join("; ")}`);

  // The new file can take a few seconds to become visible to the service account.
  let meta;
  for (let attempt = 1; ; attempt++) {
    try {
      meta = await google("GET", `${SHEETS}/${made.spreadsheetId}?fields=${SHEET_META_FIELDS}`);
      break;
    } catch (err) {
      if (attempt >= 6 || (err.status !== 404 && err.status !== 403)) throw err;
      await sleep(3000);
    }
  }
  return { id: made.spreadsheetId, meta, created: true, ref };
}

// Sheet names in A1 notation need quotes when they contain spaces.
const quoteTab = (name) => `'${String(name).replace(/'/g, "''")}'`;

// Writes one team's attendance grid into a tab. `title` renames the whole
// spreadsheet (null when the tab lives inside the director's multi-tab sheet).
async function writeSheet({ id, meta }, title, rendered, playerCount, tabName = TAB) {
  // A hand-made sheet is a single "Sheet1"; in a multi-tab sheet the tab must exist.
  const sheet = meta.sheets.find((s) => s.properties.title === tabName) || (meta.sheets.length === 1 ? meta.sheets[0] : null);
  if (!sheet) throw new Error(`Tab "${tabName}" not found in spreadsheet ${id}`);
  const sheetId = sheet.properties.sheetId;
  const existingRules = (sheet.conditionalFormats || []).length;
  const width = rendered.width;
  const totalRows = rendered.lastDataRow;
  const range = (r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });

  // Clear by the tab's current name — a sheet you made by hand is still "Sheet1"
  // here; the batchUpdate below renames it to TAB.
  await google("POST", `${SHEETS}/${id}/values/${encodeURIComponent(quoteTab(sheet.properties.title))}:clear`, {});

  const requests = [
    ...(title ? [{ updateSpreadsheetProperties: { properties: { title }, fields: "title" } }] : []),
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          title: tabName,
          gridProperties: {
            rowCount: Math.max(totalRows + 20, 60),
            columnCount: Math.max(width + 2, 8),
            frozenRowCount: FROZEN_ROWS,
            frozenColumnCount: 1,
          },
        },
        fields: "title,gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
      },
    },
    { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } },
    ...Array.from({ length: existingRules }, () => ({ deleteConditionalFormatRule: { sheetId, index: 0 } })),
    // Title row
    { repeatCell: { range: range(0, 1, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 11 } } }, fields: "userEnteredFormat.textFormat" } },
    // Player-name header
    {
      repeatCell: {
        range: range(1, 2, 0, width),
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb("#0b3d2e"),
            textFormat: { bold: true, foregroundColor: rgb("#ffffff") },
            horizontalAlignment: "CENTER",
            verticalAlignment: "MIDDLE",
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
      },
    },
    // Summary block
    {
      repeatCell: {
        range: range(2, 6, 0, width),
        cell: { userEnteredFormat: { backgroundColor: rgb("#eef4f1"), horizontalAlignment: "CENTER", textFormat: { bold: true } } },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)",
      },
    },
    { repeatCell: { range: range(5, 6, 1, width), cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } }, fields: "userEnteredFormat.numberFormat" } },
    // Divider row
    {
      repeatCell: {
        range: range(6, 7, 0, width),
        cell: { userEnteredFormat: { backgroundColor: rgb("#d5e3dc"), textFormat: { bold: true } } },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    // Data cells centered; date column left-aligned bold
    { repeatCell: { range: range(FIRST_DATA_ROW - 1, totalRows, 1, width), cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" } },
    { repeatCell: { range: range(2, totalRows, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat" } },
    // Column widths / header height
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 170 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: Math.max(width, 2) }, properties: { pixelSize: 105 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 46 }, fields: "pixelSize" } },
  ];

  if (playerCount > 0) {
    const dataRange = range(FIRST_DATA_ROW - 1, totalRows, 1, width);
    const textRule = (type, value, bg, fg) => ({
      addConditionalFormatRule: {
        index: 0,
        rule: {
          ranges: [dataRange],
          booleanRule: { condition: { type, values: [{ userEnteredValue: value }] }, format: { backgroundColor: rgb(bg), textFormat: { foregroundColor: rgb(fg) } } },
        },
      },
    });
    requests.push(
      textRule("TEXT_EQ", "✗", "#f4c7c3", "#9c1c12"),
      textRule("TEXT_CONTAINS", ":", "#d9ead3", "#1e5a2b"),
      textRule("TEXT_EQ", "–", "#eeeeee", "#777777"),
      {
        addConditionalFormatRule: {
          index: 0,
          rule: {
            ranges: [range(5, 6, 1, width)],
            booleanRule: { condition: { type: "NUMBER_GREATER_THAN_EQ", values: [{ userEnteredValue: "0.25" }] }, format: { backgroundColor: rgb("#f4c7c3"), textFormat: { foregroundColor: rgb("#9c1c12") } } },
          },
        },
      }
    );
  }

  await google("POST", `${SHEETS}/${id}:batchUpdate`, { requests });

  const sheetRange = (r0, r1) => `${quoteTab(tabName)}!A${r0}:${columnLetter(width - 1)}${r1}`;
  await google("PUT", `${SHEETS}/${id}/values/${encodeURIComponent(sheetRange(1, rendered.top.length))}?valueInputOption=USER_ENTERED`, {
    values: rendered.top,
  });
  if (rendered.data.length) {
    await google("PUT", `${SHEETS}/${id}/values/${encodeURIComponent(sheetRange(FIRST_DATA_ROW, FIRST_DATA_ROW + rendered.data.length - 1))}?valueInputOption=RAW`, {
      values: rendered.data,
    });
  }
}

// ---------- Director's all-teams spreadsheet ----------
const ALL_TAB = "All Teams";

const getMeta = (id) => google("GET", `${SHEETS}/${id}?fields=${SHEET_META_FIELDS}`);

// Tab names can't contain []*?:/\ and must be unique (case-insensitively).
function teamTabName(team, teamId, used) {
  let name = String(team.name || teamId).replace(/[\[\]*?:\\/]/g, "-").trim().slice(0, 90) || teamId;
  if (used.has(name.toLowerCase()) || name.toLowerCase() === ALL_TAB.toLowerCase()) name = `${name} (${teamId})`;
  used.add(name.toLowerCase());
  return name;
}

// Makes the master spreadsheet's tabs exactly `tabNames`, in that order.
async function syncMasterTabs(id, tabNames) {
  let meta = await getMeta(id);
  const have = new Set(meta.sheets.map((s) => s.properties.title));
  const wanted = new Set(tabNames);
  const adds = tabNames.filter((n) => !have.has(n)).map((n) => ({ addSheet: { properties: { title: n } } }));
  // Deletes come after adds so the spreadsheet never has zero tabs (this also
  // removes the default "Sheet1" and tabs for teams that no longer exist).
  const deletes = meta.sheets
    .filter((s) => !wanted.has(s.properties.title))
    .map((s) => ({ deleteSheet: { sheetId: s.properties.sheetId } }));
  if (adds.length || deletes.length) await google("POST", `${SHEETS}/${id}:batchUpdate`, { requests: [...adds, ...deletes] });

  meta = await getMeta(id);
  const idByTitle = new Map(meta.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
  await google("POST", `${SHEETS}/${id}:batchUpdate`, {
    requests: tabNames.map((n, i) => ({ updateSheetProperties: { properties: { sheetId: idByTitle.get(n), index: i }, fields: "index" } })),
  });
  return getMeta(id);
}

async function writeAllTeamsTab({ id, meta }, rendered) {
  const sheet = meta.sheets.find((s) => s.properties.title === ALL_TAB);
  const sheetId = sheet.properties.sheetId;
  const existingRules = (sheet.conditionalFormats || []).length;
  const lastRow = rendered.lastRow;
  const cols = 13; // A-F players, G gap, H-M teams
  const range = (r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });
  const width = (c0, c1, px) => ({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: c0, endIndex: c1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
  const header = (c0, c1) => ({
    repeatCell: {
      range: range(SUMMARY_HEADER_ROW - 1, SUMMARY_HEADER_ROW, c0, c1),
      cell: {
        userEnteredFormat: {
          backgroundColor: rgb("#0b3d2e"),
          textFormat: { bold: true, foregroundColor: rgb("#ffffff") },
          horizontalAlignment: "CENTER",
          verticalAlignment: "MIDDLE",
          wrapStrategy: "WRAP",
        },
      },
      fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)",
    },
  });
  const center = (c0, c1) => ({
    repeatCell: { range: range(SUMMARY_HEADER_ROW, lastRow, c0, c1), cell: { userEnteredFormat: { horizontalAlignment: "CENTER" } }, fields: "userEnteredFormat.horizontalAlignment" },
  });
  const percent = (c) => ({
    repeatCell: { range: range(SUMMARY_HEADER_ROW, lastRow, c, c + 1), cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } }, fields: "userEnteredFormat.numberFormat" },
  });
  const alertRule = (c) => ({
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(SUMMARY_HEADER_ROW, lastRow, c, c + 1)],
        booleanRule: {
          condition: { type: "NUMBER_GREATER_THAN_EQ", values: [{ userEnteredValue: String(MISS_ALERT) }] },
          format: { backgroundColor: rgb("#f4c7c3"), textFormat: { foregroundColor: rgb("#9c1c12") } },
        },
      },
    },
  });

  await google("POST", `${SHEETS}/${id}/values/${encodeURIComponent(quoteTab(ALL_TAB))}:clear`, {});
  await google("POST", `${SHEETS}/${id}:batchUpdate`, {
    requests: [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { rowCount: Math.max(lastRow + 20, 60), columnCount: cols + 2, frozenRowCount: SUMMARY_HEADER_ROW, frozenColumnCount: 0 } },
          fields: "gridProperties.rowCount,gridProperties.columnCount,gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: "userEnteredFormat" } },
      ...Array.from({ length: existingRules }, () => ({ deleteConditionalFormatRule: { sheetId, index: 0 } })),
      { repeatCell: { range: range(0, 1, 0, 1), cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 11 } } }, fields: "userEnteredFormat.textFormat" } },
      header(0, 6),
      header(7, 13),
      center(2, 6),
      center(9, 13),
      percent(5),
      percent(11),
      width(0, 1, 150), width(1, 2, 175), width(2, 6, 105), width(6, 7, 28), width(7, 8, 150), width(8, 9, 160), width(9, 13, 120),
      { updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: 2 }, properties: { pixelSize: 46 }, fields: "pixelSize" } },
      // Sort/filter arrows on the player table (the team overview beside it is unaffected).
      { setBasicFilter: { filter: { range: range(SUMMARY_HEADER_ROW - 1, lastRow, 0, 6) } } },
      alertRule(5),
      alertRule(11),
    ],
  });
  await google("PUT", `${SHEETS}/${id}/values/${encodeURIComponent(`${quoteTab(ALL_TAB)}!A1:M${lastRow}`)}?valueInputOption=RAW`, {
    values: rendered.rows,
  });
}

// The director's email comes from the DIRECTOR_EMAIL secret, which has been
// mistyped before — don't send a share to an address that can't receive mail.
async function usableDirectorEmail() {
  if (!DIRECTOR_EMAIL) {
    console.warn("DIRECTOR_EMAIL isn't set — the summary sheet won't be shared with the director.");
    return "";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(DIRECTOR_EMAIL)) {
    console.warn("DIRECTOR_EMAIL doesn't look like an email address — check the secret.");
    return "";
  }
  try {
    await resolveMx(DIRECTOR_EMAIL.split("@")[1]);
    return DIRECTOR_EMAIL;
  } catch {
    console.warn("DIRECTOR_EMAIL's domain has no mail servers (typo?) — check the secret. Not sharing.");
    return "";
  }
}

async function buildMaster(teamResults, updatedLabel) {
  const title = `All Teams Attendance Summary - Florida Conquer ${SEASON} Season`;
  const directorEmail = SHARE_WITH_DIRECTOR ? await usableDirectorEmail() : "";
  const master = await ensureSpreadsheet(MASTER_KEY, title);

  const used = new Set();
  const tabs = [...teamResults]
    .sort((a, b) => a.team.name.localeCompare(b.team.name, undefined, { numeric: true }))
    .map((r) => ({ ...r, tabName: teamTabName(r.team, r.teamId, used) }));

  await google("POST", `${SHEETS}/${master.id}:batchUpdate`, {
    requests: [{ updateSpreadsheetProperties: { properties: { title }, fields: "title" } }],
  });
  const meta = await syncMasterTabs(master.id, [ALL_TAB, ...tabs.map((t) => t.tabName)]);
  await writeAllTeamsTab({ id: master.id, meta }, renderAllTeamsValues(teamResults, { updatedLabel }));
  for (const t of tabs) {
    await sleep(1000); // stay under the Sheets per-minute write quota
    await writeSheet({ id: master.id, meta }, null, t.rendered, t.model.players.length, t.tabName);
  }

  let sharing = SHARE_WITH_DIRECTOR ? "director email not usable, not shared" : "not shared with director";
  const wanted = new Map(EDITOR_EMAILS.map((e) => [e, "writer"]));
  if (directorEmail) wanted.set(directorEmail.toLowerCase(), "reader");
  if (wanted.size) {
    const failures = await ensureShared(master.id, wanted);
    if (directorEmail) {
      sharing = failures.has(directorEmail.toLowerCase())
        ? `could NOT share with director (${failures.get(directorEmail.toLowerCase())})`
        : "shared with director (no email sent)";
    }
  }

  const url = `https://docs.google.com/spreadsheets/d/${master.id}/edit`;
  console.log(`Master: ${tabs.length} team tabs -> ${url}${master.created ? " (created)" : ""} [${sharing}]`);
  return `- **Director summary** (${tabs.length} team tabs), ${sharing} — [open sheet](${url})`;
}

// ---------- Drive sharing ----------
// Adds people to a sheet WITHOUT emailing them — the same as unticking "Notify
// people" in Google's Share dialog. Returns a Map of email -> reason for anyone
// it couldn't add (Google only allows silent sharing with Google accounts).
async function ensureShared(fileId, wanted) {
  const failures = new Map();
  let have = new Map();
  try {
    const { permissions = [] } = await google("GET", `${DRIVE}/${fileId}/permissions?fields=permissions(id,emailAddress,role,type)`);
    have = new Map(permissions.filter((p) => p.emailAddress).map((p) => [p.emailAddress.toLowerCase(), p]));
  } catch (err) {
    console.warn(`  could not read current sharing: ${err.message.slice(0, 200)}`);
  }
  for (const [email, role] of wanted) {
    const current = have.get(email);
    try {
      if (current) {
        if (current.role === "reader" && role === "writer") {
          await google("PATCH", `${DRIVE}/${fileId}/permissions/${current.id}`, { role });
          console.log(`  upgraded ${email} to ${role}`);
        }
        continue;
      }
      await google("POST", `${DRIVE}/${fileId}/permissions?sendNotificationEmail=false`, { type: "user", role, emailAddress: email });
      console.log(`  shared with ${email} (${role}, no email sent)`);
    } catch (err) {
      let reason = err.message;
      try {
        reason = JSON.parse(err.body).error.message;
      } catch {}
      failures.set(email, reason);
      console.warn(`  could not share with ${email}: ${reason}`);
    }
  }
  return failures;
}

function explainApiError(err) {
  const text = `${err.body || ""} ${err.message}`;
  if (/SERVICE_DISABLED|has not been used in project|is disabled/i.test(text)) {
    const project = serviceAccount.project_id;
    console.error(
      `\nA Google API is not enabled for project "${project}". Enable both, wait a minute, and re-run:\n` +
        `  https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=${project}\n` +
        `  https://console.cloud.google.com/apis/library/drive.googleapis.com?project=${project}\n`
    );
  }
}

// Prints who the robot is and whether Drive responds, so a permission error
// can be traced without guessing. Never fails the run.
async function preflight() {
  console.log(`Service account: ${serviceAccount.client_email} (project ${serviceAccount.project_id})`);
  try {
    const about = await google("GET", "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)");
    console.log(`Drive API: OK (storage used ${about.storageQuota?.usage ?? "?"} of ${about.storageQuota?.limit ?? "unlimited/unknown"} bytes)`);
  } catch (err) {
    console.warn(`Drive API check failed: ${err.message.slice(0, 400)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Service account to share sheets with (Editor): \`${serviceAccount.client_email}\`\n\n`);
  }
}

async function main() {
  await preflight();
  if (!SEASON) {
    const seasonDoc = await db.collection("settings").doc("season").get();
    SEASON = (seasonDoc.exists && String(seasonDoc.data().label || "").trim()) || DEFAULT_SEASON;
  }
  console.log(`Season: ${SEASON}`);
  const now = new Date();
  const [scheduleSnap, cancelSnap] = await Promise.all([db.collection("schedule").get(), db.collection("scheduleCancellations").get()]);
  const scheduleEntries = scheduleSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const cancellations = cancelSnap.docs.map((d) => d.data());

  const updatedLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(now);
  const summaryLines = [];
  let failed = 0;

  let teamIds = TEAM_IDS;
  const doAll = BUILD_MASTER || (teamIds.length === 1 && teamIds[0].toUpperCase() === "ALL");
  if (doAll) teamIds = (await db.collection("teams").get()).docs.map((d) => d.id).sort();
  const teamResults = []; // feeds the director's summary sheet

  for (const [index, teamId] of teamIds.entries()) {
    if (index > 0) await sleep(1500); // stay under the Sheets API per-minute write limit
    try {
      console.log(`Team ${teamId}`);
      const { team, model } = await loadTeamData(teamId, scheduleEntries, cancellations, now);
      if (doAll && model.players.length === 0) {
        console.log("  no players on this team — skipped");
        summaryLines.push(`- **${team.name}** (${teamId}): skipped, no players`);
        continue;
      }
      // Team name first so it's visible in Google's truncated "Open" list.
      const title = `${team.name} Attendance - Florida Conquer ${SEASON} Season`;
      const rendered = renderSheetValues(model, { title: team.name, updatedLabel, formatDate, formatTime });
      const sheet = await ensureSpreadsheet(teamId, title);
      await writeSheet(sheet, title, rendered, model.players.length);
      teamResults.push({ teamId, team, model, rendered });

      // Coaches are only given access when the run is started with
      // share_with_coaches on, so sheets can be reviewed first. Sharing is
      // silent (no Google email); use "Email to coach" on the Teams tab to tell them.
      const wanted = new Map();
      for (const e of EDITOR_EMAILS) wanted.set(e, "writer");
      const coachEmail = (team.coachEmail || "").trim().toLowerCase();
      let sharing = "not shared with coach yet";
      if (SHARE_WITH_COACHES) {
        if (coachEmail) wanted.set(coachEmail, "reader");
        else sharing = "no coach email on file";
      }
      if (wanted.size) {
        const failures = await ensureShared(sheet.id, wanted);
        if (SHARE_WITH_COACHES && coachEmail) {
          sharing = failures.has(coachEmail) ? `could NOT share with coach (${failures.get(coachEmail)})` : "shared with coach (no email sent)";
        }
      }

      const url = `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
      console.log(`  ${model.players.length} players, ${model.dateKeys.length} practice dates -> ${url}${sheet.created ? " (created)" : ""} [${sharing}]`);
      summaryLines.push(`- **${team.name}** (${teamId}): ${model.players.length} players, ${model.dateKeys.length} practice dates, ${sharing} — [open sheet](${url})`);
    } catch (err) {
      failed++;
      console.error(`Team ${teamId} failed: ${err.message}`);
      explainApiError(err);
      summaryLines.push(`- **${teamId}**: FAILED — ${err.message}`);
    }
  }

  if (BUILD_MASTER) {
    try {
      console.log("Director summary sheet");
      if (failed) console.warn(`  ${failed} team(s) failed above and are left out of the summary.`);
      summaryLines.unshift(await buildMaster(teamResults, updatedLabel));
    } catch (err) {
      failed++;
      console.error(`Director summary sheet failed: ${err.message}`);
      explainApiError(err);
      summaryLines.unshift(`- **Director summary**: FAILED — ${err.message}`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Team attendance sheets\n\n${summaryLines.join("\n")}\n`);
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  explainApiError(err);
  process.exit(1);
});
