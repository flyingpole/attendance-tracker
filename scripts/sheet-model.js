// Pure logic (no network) for the team attendance spreadsheets: decides which
// dates count as team practices, who was present, and lays out the cell grid.
// Kept separate from build-team-sheets.js so it can be tested on its own.
import { getEntriesForDate, dateToKey, keyToDate } from "../assets/schedule-matching.js";

export const MISSED = "✗";
export const NOT_YET = "–";

// Layout (1-based sheet rows): 1 title, 2 player names, 3-8 summary (Total Days,
// Days Attended, Days Missed, Miss %, Team Practice Miss %, Positional Miss %),
// 9 divider, 10+ one row per practice date (newest first).
export const SUMMARY_FIRST_ROW = 3;
export const SUMMARY_LAST_ROW = 8;
export const DIVIDER_ROW = 9;
export const FIRST_DATA_ROW = 10;
export const FROZEN_ROWS = 9;
// Positional-clinic rows are labelled "<date> — Positional"; the summary
// formulas split team vs positional by looking for this word in column A.
export const POSITIONAL_LABEL = "Positional";

function toMinutes(t) {
  const [h, m] = String(t || "0:0").split(":").map(Number);
  return h * 60 + (m || 0);
}

function addDays(key, n) {
  const d = keyToDate(key);
  d.setDate(d.getDate() + n);
  return dateToKey(d);
}

export function columnLetter(index) {
  // 0 -> A, 25 -> Z, 26 -> AA
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function lastNameSortKey(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return `${parts[parts.length - 1]} ${parts.join(" ")}`.toLowerCase();
}

// players: [{id, name, position?, joinedDate?}] for the team.
// attendance: [{playerId, sessionId, dateKey, time: Date}] for those players.
//
// Two kinds of rows, newest first:
//  - TEAM practice dates (the team's own schedule). A player is "present" if they
//    scanned that local date into this team's practice, an unscheduled check-in,
//    or a manual session. Scans into positional clinics or another team's
//    practice don't count, so someone who only came to Saturday's clinic isn't
//    credited for Monday.
//  - POSITIONAL dates (Saturday clinics etc.). Each player is required to attend
//    the clinic for their own position (player.position). They're "present" if
//    they scanned into it, otherwise "missed". A player with no position set, or
//    whose position has no clinic that day, isn't counted; if they attended some
//    other clinic anyway it shows as an "extra" note and isn't counted either.
export function buildAttendanceModel({
  teamId,
  players,
  scheduleEntries,
  cancellations,
  attendance,
  todayKey,
  nowMinutes,
  maxDays = 800,
}) {
  const teamEntries = scheduleEntries.filter((e) => e.type === "team" && e.teamId === teamId);
  const positionalEntries = scheduleEntries.filter((e) => e.type === "position");
  const positionalIds = new Set(positionalEntries.map((e) => e.id));
  const entryById = new Map(scheduleEntries.map((e) => [e.id, e]));
  const teamEntryIds = new Set(teamEntries.map((e) => e.id));
  const countsForTeam = (sessionId) =>
    teamEntryIds.has(sessionId) || sessionId === "unscheduled" || !entryById.has(sessionId);

  const credited = attendance.filter((r) => countsForTeam(r.sessionId));

  // ---- team practice rows ----
  let firstKey = null;
  for (const e of teamEntries) {
    const k = e.kind === "single" ? e.date : e.startDate;
    if (k && (!firstKey || k < firstKey)) firstKey = k;
  }
  if (!firstKey) {
    for (const r of credited) if (!firstKey || r.dateKey < firstKey) firstKey = r.dateKey;
  }

  const teamDateKeys = [];
  if (firstKey) {
    let key = firstKey;
    for (let i = 0; i < maxDays && key <= todayKey; i++, key = addDays(key, 1)) {
      const live = getEntriesForDate(keyToDate(key), teamEntries, cancellations);
      if (!live.length) continue;
      // Today only counts once the practice is over, so nobody shows as
      // "missed" while it's still going on.
      if (key === todayKey && nowMinutes < Math.max(...live.map((e) => toMinutes(e.endTime)))) continue;
      teamDateKeys.push(key);
    }
  }

  const firstScan = new Map(); // playerId -> Map(dateKey -> Date)
  for (const r of credited) {
    if (!firstScan.has(r.playerId)) firstScan.set(r.playerId, new Map());
    const byDate = firstScan.get(r.playerId);
    const prev = byDate.get(r.dateKey);
    if (!prev || r.time < prev) byDate.set(r.dateKey, r.time);
  }

  const sortedPlayers = [...players].sort((a, b) => lastNameSortKey(a.name).localeCompare(lastNameSortKey(b.name)));
  const teamRows = teamDateKeys.map((dateKey) => ({
    dateKey,
    kind: "team",
    cells: sortedPlayers.map((p) => {
      if (p.joinedDate && dateKey < p.joinedDate) return { kind: "na" };
      const t = firstScan.get(p.id)?.get(dateKey);
      return t ? { kind: "present", time: t } : { kind: "missed" };
    }),
  }));

  // ---- positional clinic rows ----
  // playerId -> dateKey -> sessionId -> earliest scan time
  const scansBySession = new Map();
  for (const r of attendance) {
    if (!positionalIds.has(r.sessionId)) continue;
    if (!scansBySession.has(r.playerId)) scansBySession.set(r.playerId, new Map());
    const byDate = scansBySession.get(r.playerId);
    if (!byDate.has(r.dateKey)) byDate.set(r.dateKey, new Map());
    const bySession = byDate.get(r.dateKey);
    const prev = bySession.get(r.sessionId);
    if (!prev || r.time < prev) bySession.set(r.sessionId, r.time);
  }

  let firstPositionalKey = null;
  for (const e of positionalEntries) {
    const k = e.kind === "single" ? e.date : e.startDate;
    if (k && (!firstPositionalKey || k < firstPositionalKey)) firstPositionalKey = k;
  }

  const positionalRows = [];
  if (firstPositionalKey) {
    let key = firstPositionalKey;
    for (let i = 0; i < maxDays && key <= todayKey; i++, key = addDays(key, 1)) {
      const live = getEntriesForDate(keyToDate(key), positionalEntries, cancellations);
      if (!live.length) continue;
      if (key === todayKey && nowMinutes < Math.max(...live.map((e) => toMinutes(e.endTime)))) continue;

      const cells = sortedPlayers.map((p) => {
        if (p.joinedDate && key < p.joinedDate) return { kind: "na" };
        const scans = scansBySession.get(p.id)?.get(key);
        const required = p.position ? live.filter((e) => e.position === p.position) : [];
        if (required.length) {
          const times = required.map((e) => scans?.get(e.id)).filter(Boolean);
          return times.length ? { kind: "present", time: times.reduce((a, b) => (a < b ? a : b)) } : { kind: "missed" };
        }
        // Not required to attend a clinic today (no position set, or none for
        // their position): note any clinic they came to anyway, uncounted.
        const attended = live.filter((e) => scans && scans.has(e.id)).sort((a, b) => scans.get(a.id) - scans.get(b.id));
        return attended.length ? { kind: "extra", label: attended[0].position } : { kind: "na" };
      });
      // A clinic date nobody on this team has anything to show for is just clutter.
      if (cells.every((c) => c.kind === "na")) continue;
      positionalRows.push({ dateKey: key, kind: "positional", cells });
    }
  }

  // Newest first; on the same date the team practice sits above the clinics.
  const rows = [...teamRows, ...positionalRows].sort((a, b) => {
    if (a.dateKey !== b.dateKey) return a.dateKey < b.dateKey ? 1 : -1;
    if (a.kind === b.kind) return 0;
    return a.kind === "team" ? -1 : 1;
  });

  return {
    players: sortedPlayers,
    rows,
    cells: rows.map((r) => r.cells),
    dateKeys: rows.map((r) => r.dateKey),
    teamPracticeCount: teamRows.length,
    positionalCount: positionalRows.length,
  };
}

// Turns the model into the two blocks written to the sheet: `top` (rows 1-9,
// includes formulas, written USER_ENTERED) and `data` (rows 10+, plain text,
// written RAW so "5:42 PM" stays text instead of becoming a time value).
export function renderSheetValues(model, { title, updatedLabel, formatDate, formatTime }) {
  const n = model.players.length;
  const lastDataRow = FIRST_DATA_ROW + Math.max(model.rows.length, 1) - 1;
  const width = n + 1;
  const pad = (row) => row.concat(Array(Math.max(0, width - row.length)).fill(""));

  const colRange = (c) => `${columnLetter(c)}$${FIRST_DATA_ROW}:${columnLetter(c)}$${lastDataRow}`;
  const labelRange = `$A$${FIRST_DATA_ROW}:$A$${lastDataRow}`;
  const perPlayer = (fn) => model.players.map((_, i) => fn(columnLetter(i + 1), colRange(i + 1)));
  const isPositional = `"*${POSITIONAL_LABEL}*"`;
  // Positional days missed / attended for one player column.
  const posMissed = (r) => `COUNTIFS(${labelRange},${isPositional},${r},"${MISSED}")`;
  const posAttended = (r) => `COUNTIFS(${labelRange},${isPositional},${r},"*:*")`;

  const top = [
    pad([
      `${title} — updated ${updatedLabel}. ${MISSED} = missed, time = arrival, ${NOT_YET} = not required / not yet on team, ` +
        `+Position = attended another position's clinic (not counted). Positional clinics count only for players with a position set.`,
    ]),
    pad(["Player", ...model.players.map((p) => p.name)]),
    pad(["Total Days", ...perPlayer((c, r) => `=COUNTIF(${r},"${MISSED}")+COUNTIF(${r},"*:*")`)]),
    pad(["Days Attended", ...perPlayer((c, r) => `=COUNTIF(${r},"*:*")`)]),
    pad(["Days Missed", ...perPlayer((c, r) => `=COUNTIF(${r},"${MISSED}")`)]),
    pad(["Miss %", ...perPlayer((c) => `=IF(${c}3=0,"",${c}5/${c}3)`)]),
    pad([
      "Team Practice Miss %",
      ...perPlayer(
        (c, r) =>
          `=IF((${c}3-(${posMissed(r)}+${posAttended(r)}))=0,"",(${c}5-${posMissed(r)})/(${c}3-(${posMissed(r)}+${posAttended(r)})))`
      ),
    ]),
    pad([
      "Positional Miss %",
      ...perPlayer((c, r) => `=IF((${posMissed(r)}+${posAttended(r)})=0,"",${posMissed(r)}/(${posMissed(r)}+${posAttended(r)}))`),
    ]),
    pad(["Practice date"]),
  ];

  const data = model.rows.map((row) =>
    pad([
      row.kind === "positional" ? `${formatDate(row.dateKey)} — ${POSITIONAL_LABEL}` : formatDate(row.dateKey),
      ...row.cells.map((c) =>
        c.kind === "present" ? formatTime(c.time) : c.kind === "missed" ? MISSED : c.kind === "extra" ? `+${c.label}` : NOT_YET
      ),
    ])
  );

  return { top, data, width, lastDataRow };
}

// ---------- Director summary ("All Teams" tab) ----------

// Miss % at or above this is highlighted red.
export const MISS_ALERT = 0.25;
export const SUMMARY_HEADER_ROW = 2; // 1-based; title is row 1

// Per-player totals for one team's model, in the same order as model.players.
export function playerTotals(model) {
  return model.players.map((player, j) => {
    let attended = 0;
    let missed = 0;
    for (const row of model.cells) {
      if (row[j].kind === "present") attended++;
      else if (row[j].kind === "missed") missed++;
    }
    const total = attended + missed;
    return { player, attended, missed, total, missPct: total ? missed / total : null };
  });
}

// teamResults: [{ team: {name, coachName}, model }]. Returns a grid for the
// "All Teams" tab: a player table in columns A-F (sortable/filterable) and a
// per-team overview in columns H-M beside it.
export function renderAllTeamsValues(teamResults, { updatedLabel }) {
  const sorted = [...teamResults].sort((a, b) => a.team.name.localeCompare(b.team.name, undefined, { numeric: true }));
  const playerRows = [];
  const teamRows = [];
  for (const { team, model } of sorted) {
    let attended = 0;
    let missed = 0;
    let flagged = 0;
    for (const t of playerTotals(model)) {
      attended += t.attended;
      missed += t.missed;
      if (t.missPct !== null && t.missPct >= MISS_ALERT) flagged++;
      playerRows.push([team.name, t.player.name, t.total, t.attended, t.missed, t.missPct ?? ""]);
    }
    const all = attended + missed;
    teamRows.push([team.name, team.coachName || "", model.players.length, model.rows.length, all ? missed / all : "", flagged]);
  }

  const blank = () => Array(6).fill("");
  const body = Math.max(playerRows.length, teamRows.length, 1);
  const rows = [
    [`All teams — attendance summary (team practices only), updated ${updatedLabel}`, ...Array(12).fill("")],
    [
      "Team", "Player", "Total Days", "Days Attended", "Days Missed", "Miss %", "",
      "Team", "Coach", "Players", "Practices Held", "Team Miss %", `Players ≥${Math.round(MISS_ALERT * 100)}% Missed`,
    ],
  ];
  for (let i = 0; i < body; i++) rows.push([...(playerRows[i] || blank()), "", ...(teamRows[i] || blank())]);
  return { rows, playerCount: playerRows.length, teamCount: teamRows.length, lastRow: rows.length };
}
