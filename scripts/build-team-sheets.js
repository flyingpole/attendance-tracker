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
import {
  buildAttendanceModel,
  renderSheetValues,
  columnLetter,
  FIRST_DATA_ROW,
  FROZEN_ROWS,
} from "./sheet-model.js";

const TZ = process.env.REPORT_TIMEZONE || "America/New_York";
const TAB = "Attendance";
const TEAM_IDS = (process.env.TEAM_IDS || "16T").split(",").map((s) => s.trim()).filter(Boolean);
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
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
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
  let created;
  try {
    created = await google("POST", SHEETS, {
      properties: { title },
      sheets: [{ properties: { title: TAB } }],
    });
  } catch (err) {
    if (err.status === 403) {
      err.message +=
        `\n\nThe service account was not allowed to create a spreadsheet. Workaround: create a blank Google Sheet yourself,` +
        ` share it with ${serviceAccount.client_email} as Editor, and re-run with sheet_ids set to ${teamId}=<the ID from its URL>.`;
    }
    throw err;
  }
  const meta = await google("GET", `${SHEETS}/${created.spreadsheetId}?fields=spreadsheetId,sheets(properties(sheetId,title),conditionalFormats)`);
  await ref.set({ spreadsheetId: created.spreadsheetId, url: created.spreadsheetUrl, createdAt: new Date() });
  return { id: created.spreadsheetId, meta, created: true, ref };
}

async function writeSheet({ id, meta, ref }, title, rendered, playerCount) {
  const sheet = meta.sheets.find((s) => s.properties.title === TAB) || meta.sheets[0];
  const sheetId = sheet.properties.sheetId;
  const existingRules = (sheet.conditionalFormats || []).length;
  const width = rendered.width;
  const totalRows = rendered.lastDataRow;
  const range = (r0, r1, c0, c1) => ({ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 });

  await google("POST", `${SHEETS}/${id}/values/${encodeURIComponent(TAB)}:clear`, {});

  const requests = [
    { updateSpreadsheetProperties: { properties: { title }, fields: "title" } },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          title: TAB,
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

  const sheetRange = (r0, r1) => `${TAB}!A${r0}:${columnLetter(width - 1)}${r1}`;
  await google("PUT", `${SHEETS}/${id}/values/${encodeURIComponent(sheetRange(1, rendered.top.length))}?valueInputOption=USER_ENTERED`, {
    values: rendered.top,
  });
  if (rendered.data.length) {
    await google("PUT", `${SHEETS}/${id}/values/${encodeURIComponent(sheetRange(FIRST_DATA_ROW, FIRST_DATA_ROW + rendered.data.length - 1))}?valueInputOption=RAW`, {
      values: rendered.data,
    });
  }
}

// ---------- Drive sharing ----------
async function ensureShared(fileId, wanted) {
  const { permissions = [] } = await google("GET", `${DRIVE}/${fileId}/permissions?fields=permissions(id,emailAddress,role,type)`);
  const have = new Map(permissions.filter((p) => p.emailAddress).map((p) => [p.emailAddress.toLowerCase(), p]));
  for (const [email, role] of wanted) {
    const current = have.get(email);
    if (current) {
      if (current.role === "reader" && role === "writer") {
        await google("PATCH", `${DRIVE}/${fileId}/permissions/${current.id}`, { role });
        console.log(`  upgraded ${email} to ${role}`);
      }
      continue;
    }
    try {
      await google("POST", `${DRIVE}/${fileId}/permissions?sendNotificationEmail=true&emailMessage=${encodeURIComponent("Florida Conquer attendance sheet — updated automatically each morning.")}`, {
        type: "user",
        role,
        emailAddress: email,
      });
      console.log(`  shared with ${email} (${role})`);
    } catch (err) {
      console.warn(`  could not share with ${email}: ${err.message}`);
    }
  }
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
  const now = new Date();
  const [scheduleSnap, cancelSnap] = await Promise.all([db.collection("schedule").get(), db.collection("scheduleCancellations").get()]);
  const scheduleEntries = scheduleSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const cancellations = cancelSnap.docs.map((d) => d.data());

  const updatedLabel = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(now);
  const summaryLines = [];
  let failed = 0;

  for (const teamId of TEAM_IDS) {
    try {
      console.log(`Team ${teamId}`);
      const { team, model } = await loadTeamData(teamId, scheduleEntries, cancellations, now);
      const title = `Florida Conquer — ${team.name} Attendance`;
      const rendered = renderSheetValues(model, { title: team.name, updatedLabel, formatDate, formatTime });
      const sheet = await ensureSpreadsheet(teamId, title);
      await writeSheet(sheet, title, rendered, model.players.length);

      const wanted = new Map();
      if (team.coachEmail) wanted.set(team.coachEmail.trim().toLowerCase(), "reader");
      for (const e of EDITOR_EMAILS) wanted.set(e, "writer");
      await ensureShared(sheet.id, wanted);

      const url = `https://docs.google.com/spreadsheets/d/${sheet.id}/edit`;
      console.log(`  ${model.players.length} players, ${model.dateKeys.length} practice dates -> ${url}${sheet.created ? " (created)" : ""}`);
      summaryLines.push(`- **${team.name}** (${teamId}): ${model.players.length} players, ${model.dateKeys.length} practice dates — [open sheet](${url})`);
    } catch (err) {
      failed++;
      console.error(`Team ${teamId} failed: ${err.message}`);
      explainApiError(err);
      summaryLines.push(`- **${teamId}**: FAILED — ${err.message}`);
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
