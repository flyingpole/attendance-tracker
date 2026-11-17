// Runs nightly via .github/workflows/daily-report.yml using the Firebase Admin SDK
// (trusted server-side access — bypasses firestore.rules) to read the previous day's
// scans and email a summary to the director and each team's coach.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import { POSITIONAL_PRACTICES, isPositionalCheckIn, positionalKeyForSession } from "../assets/positional.js";

const TZ = process.env.REPORT_TIMEZONE || "America/New_York";
// The director's address is normally the one saved in the admin console
// (Teams tab -> Director email, stored in Firestore settings/director); the
// DIRECTOR_EMAIL secret in GitHub is the fallback if none is saved there.
let DIRECTOR_EMAIL = (process.env.DIRECTOR_EMAIL || "").trim();
// DIRECTOR_ONLY re-sends just the director's copy (used for catch-ups).
const DIRECTOR_ONLY = /^true$/i.test(process.env.DIRECTOR_ONLY || "");
const FROM_NAME = process.env.FROM_NAME || "Florida Conquer Attendance";

for (const required of ["FIREBASE_SERVICE_ACCOUNT", "GMAIL_USER", "GMAIL_APP_PASSWORD"]) {
  if (!process.env[required]) {
    console.error(`Missing required environment variable: ${required}`);
    process.exit(1);
  }
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function sendEmail({ to, subject, html }) {
  await transporter.sendMail({
    from: `"${FROM_NAME}" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
  });
}

function localDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(date); // YYYY-MM-DD
}

function localTimeStr(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(date);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderTeamTable(teamRecords) {
  const rows = teamRecords
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.playerName)}</td><td>${escapeHtml(r.sessionLabel)}</td><td>${localTimeStr(r.time)}</td></tr>`
    )
    .join("");
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr><th>Player</th><th>Session</th><th>Arrival</th></tr>
    ${rows}
  </table>`;
}

// Headcount for the positional practices on one day: how many distinct players
// checked into each, plus Saturday check-ins that weren't under any positional.
// Anyone checking in on a Saturday counts as being at a positional.
function positionalHeadcount(records, targetDate, positionalEntries) {
  const positionNameById = new Map(positionalEntries.map((e) => [e.id, e.position]));
  const entryIds = new Set(positionalEntries.map((e) => e.id));
  const isSaturday = new Date(`${targetDate}T12:00:00Z`).getUTCDay() === 6;
  const byKey = new Map(POSITIONAL_PRACTICES.map((p) => [p.key, new Map()])); // key -> playerId -> record
  const unassigned = new Map(); // players at a positional day with no specific positional named
  const anyone = new Map();
  for (const r of records) {
    const positional = isPositionalCheckIn(r, entryIds);
    if (!positional && !isSaturday) continue;
    const who = r.playerId || r.playerName;
    if (!anyone.has(who)) anyone.set(who, r);
    const key = positionalKeyForSession(r, positionNameById);
    if (key) {
      if (!byKey.get(key).has(who)) byKey.get(key).set(who, r);
    } else if (!unassigned.has(who)) {
      unassigned.set(who, r);
    }
  }
  return { byKey, unassigned, anyone, any: anyone.size > 0 };
}

function renderPositionalHeadcount(h) {
  const rows = POSITIONAL_PRACTICES.map((p) => {
    const recs = [...h.byKey.get(p.key).values()].sort((a, b) => a.time - b.time);
    const times = recs.length ? `${localTimeStr(recs[0].time)} – ${localTimeStr(recs[recs.length - 1].time)}` : "—";
    return `<tr><td>${escapeHtml(p.name)}</td><td style="text-align:center">${recs.length}</td><td>${times}</td></tr>`;
  });
  if (h.unassigned.size) {
    rows.push(`<tr><td>No positional chosen (checked in on a Saturday)</td><td style="text-align:center">${h.unassigned.size}</td><td></td></tr>`);
  }
  return `<h3>Positional practices — players checked in</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;">
    <tr><th>Positional</th><th>Players</th><th>Check-in times</th></tr>
    ${rows.join("")}
    <tr><td><b>Distinct players at any positional</b></td><td style="text-align:center"><b>${h.anyone.size}</b></td><td></td></tr>
  </table>
  <p style="color:#666">A player who attended more than one positional is counted once in each, and once in the total.</p>`;
}

async function main() {
  const directorDoc = await db.collection("settings").doc("director").get();
  const savedEmail = directorDoc.exists ? String(directorDoc.data().email || "").trim() : "";
  if (savedEmail) DIRECTOR_EMAIL = savedEmail;
  if (!DIRECTOR_EMAIL) {
    throw new Error("No director email: set it on the admin Teams tab, or add the DIRECTOR_EMAIL secret in GitHub.");
  }
  console.log(`Director email source: ${savedEmail ? "admin console setting" : "DIRECTOR_EMAIL secret"}`);

  const now = new Date();
  // REPORT_DATE (YYYY-MM-DD) re-sends the report for a specific past day, e.g. to
  // catch up after missed nights; otherwise it's always "yesterday".
  const reportDateOverride = /^\d{4}-\d{2}-\d{2}$/.test(process.env.REPORT_DATE || "") ? process.env.REPORT_DATE : "";
  const targetDate = reportDateOverride || localDateStr(new Date(now.getTime() - 24 * 60 * 60 * 1000));

  // GitHub starts scheduled runs hours late and may fire several triggers per day, so
  // scheduled/nightly runs only send if this day's report hasn't already gone out.
  const statusRef = db.collection("settings").doc("jobStatus");
  if (!reportDateOverride && /^true$/i.test(process.env.SKIP_IF_DONE || "")) {
    const status = (await statusRef.get()).data() || {};
    if (status.emailSentFor === targetDate) {
      console.log(`The report for ${targetDate} was already sent (${status.emailSentAt || "earlier"}); nothing to do.`);
      return;
    }
  }

  // Coarse Firestore range filter; exact day filtering happens below via
  // local-date-string comparison so we don't have to hand-roll timezone/DST math.
  // Normally the last 48h; for a REPORT_DATE catch-up, a window around that day.
  const windowStart = reportDateOverride
    ? new Date(new Date(`${reportDateOverride}T12:00:00Z`).getTime() - 36 * 60 * 60 * 1000)
    : new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const cutoff = Timestamp.fromDate(windowStart);
  const snap = await db.collection("attendance").where("timestamp", ">=", cutoff).get();

  const records = [];
  snap.forEach((doc) => {
    const data = doc.data();
    const time = data.timestamp.toDate();
    if (localDateStr(time) === targetDate) records.push({ ...data, time });
  });
  records.sort((a, b) => a.time - b.time);

  const teamsSnap = await db.collection("teams").get();
  const teams = new Map();
  teamsSnap.forEach((d) => teams.set(d.id, d.data()));

  const byTeam = new Map();
  for (const r of records) {
    if (!byTeam.has(r.teamId)) byTeam.set(r.teamId, []);
    byTeam.get(r.teamId).push(r);
  }

  const dateHeading = new Date(`${targetDate}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const scheduleSnap = await db.collection("schedule").get();
  const positionalEntries = [];
  scheduleSnap.forEach((d) => {
    const e = d.data();
    if (e.type === "position") positionalEntries.push({ id: d.id, position: e.position });
  });
  const headcount = positionalHeadcount(records, targetDate, positionalEntries);
  if (headcount.any) {
    console.log(`Positional headcount for ${targetDate}:`);
    for (const p of POSITIONAL_PRACTICES) {
      const recs = [...headcount.byKey.get(p.key).values()].sort((a, b) => a.time - b.time);
      console.log(`  ${p.name}: ${recs.length} player(s)`);
    }
    console.log(`  No positional chosen: ${headcount.unassigned.size}; distinct players at any positional: ${headcount.anyone.size}`);
    // Every check-in (not just each player's first) in half-hour windows, for "who was there around 10 AM?" questions.
    const windows = new Map();
    for (const r of records) {
      const mins = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(r.time).replace(":", "")) ;
      const h = Math.floor(mins / 100), m = mins % 100;
      const label = `${String(h).padStart(2, "0")}:${m < 30 ? "00" : "30"}`;
      if (!windows.has(label)) windows.set(label, new Set());
      windows.get(label).add(r.playerId || r.playerName);
    }
    console.log("  Players checking in per half hour (all sessions): " + [...windows.entries()].sort().map(([k, v]) => `${k}=${v.size}`).join("  "));
    for (const r of [...headcount.anyone.values()].sort((a, b) => a.time - b.time)) {
      console.log(`    ${localTimeStr(r.time)}  ${r.playerName}  [${r.sessionLabel}]  ${teams.get(r.teamId)?.name || r.teamId}`);
    }
  }

  // --- Director email: every team, every session ---
  let directorBody = `<h2>Attendance Summary — ${dateHeading}</h2>`;
  if (headcount.any) directorBody += renderPositionalHeadcount(headcount);
  if (records.length === 0) {
    directorBody += `<p>No check-ins recorded.</p>`;
  } else {
    for (const [teamId, teamRecords] of byTeam.entries()) {
      const teamName = teams.get(teamId)?.name || teamId;
      directorBody += `<h3>${escapeHtml(teamName)} (${teamRecords.length} check-ins)</h3>${renderTeamTable(teamRecords)}`;
    }
  }

  await sendEmail({
    to: DIRECTOR_EMAIL,
    subject: `Attendance Summary — ${dateHeading}`,
    html: directorBody,
  });

  // --- Per-coach emails: only their team, only if they had check-ins ---
  let coachEmailsSent = 0;
  for (const [teamId, teamRecords] of DIRECTOR_ONLY ? [] : byTeam.entries()) {
    const team = teams.get(teamId);
    if (!team?.coachEmail) {
      console.warn(`Skipping coach email for team "${teamId}" — no coachEmail on file.`);
      continue;
    }
    const body = `<h2>${escapeHtml(team.name)} Attendance — ${dateHeading}</h2>${renderTeamTable(teamRecords)}`;
    await sendEmail({
      to: team.coachEmail,
      subject: `${team.name} Attendance — ${dateHeading}`,
      html: body,
    });
    coachEmailsSent++;
  }

  console.log(
    `Report for ${targetDate}: ${records.length} check-ins across ${byTeam.size} teams. Sent director email + ${coachEmailsSent} coach emails.`
  );

  // Remember it (shown on the admin Reports tab, and used to skip duplicate triggers).
  // A catch-up for an older date doesn't change the nightly record.
  if (!reportDateOverride) {
    await statusRef.set({ emailSentFor: targetDate, emailSentAt: new Date().toISOString() }, { merge: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
