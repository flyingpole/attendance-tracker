// Runs nightly via .github/workflows/daily-report.yml using the Firebase Admin SDK
// (trusted server-side access — bypasses firestore.rules) to read the previous day's
// scans and email a summary to the director and each team's coach.
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import nodemailer from "nodemailer";

const TZ = process.env.REPORT_TIMEZONE || "America/New_York";
// The director's address is normally the one saved in the admin console
// (Teams tab -> Director email, stored in Firestore settings/director); the
// DIRECTOR_EMAIL secret in GitHub is the fallback if none is saved there.
let DIRECTOR_EMAIL = (process.env.DIRECTOR_EMAIL || "").trim();
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

  // --- Director email: every team, every session ---
  let directorBody = `<h2>Attendance Summary — ${dateHeading}</h2>`;
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
  for (const [teamId, teamRecords] of byTeam.entries()) {
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
