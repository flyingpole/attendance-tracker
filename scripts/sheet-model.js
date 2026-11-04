// Pure logic (no network) for the team attendance spreadsheets: decides which
// dates count as team practices, who was present, and lays out the cell grid.
// Kept separate from build-team-sheets.js so it can be tested on its own.
import { getEntriesForDate, dateToKey, keyToDate } from "../assets/schedule-matching.js";

export const MISSED = "✗";
export const NOT_YET = "–";

// Layout (1-based sheet rows): 1 title, 2 player names, 3-6 summary,
// 7 divider, 8+ one row per practice date (newest first).
export const SUMMARY_FIRST_ROW = 3;
export const FIRST_DATA_ROW = 8;
export const FROZEN_ROWS = 7;

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

// players: [{id, name, joinedDate?}] for the team.
// attendance: [{playerId, sessionId, dateKey, time: Date}] for those players.
//
// A player is "present" on a team-practice date if they scanned that local
// date into this team's practice, an unscheduled check-in, or a manual session.
// Scans into positional clinics or another team's practice don't count, so a
// player who only came to Saturday's clinic isn't credited for Monday.
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
  const entryById = new Map(scheduleEntries.map((e) => [e.id, e]));
  const teamEntryIds = new Set(teamEntries.map((e) => e.id));
  const countsForTeam = (sessionId) =>
    teamEntryIds.has(sessionId) || sessionId === "unscheduled" || !entryById.has(sessionId);

  const credited = attendance.filter((r) => countsForTeam(r.sessionId));

  let firstKey = null;
  for (const e of teamEntries) {
    const k = e.kind === "single" ? e.date : e.startDate;
    if (k && (!firstKey || k < firstKey)) firstKey = k;
  }
  if (!firstKey) {
    for (const r of credited) if (!firstKey || r.dateKey < firstKey) firstKey = r.dateKey;
  }

  const dateKeys = [];
  if (firstKey) {
    let key = firstKey;
    for (let i = 0; i < maxDays && key <= todayKey; i++, key = addDays(key, 1)) {
      const live = getEntriesForDate(keyToDate(key), teamEntries, cancellations);
      if (!live.length) continue;
      // Today only counts once the practice is over, so nobody shows as
      // "missed" while it's still going on.
      if (key === todayKey && nowMinutes < Math.max(...live.map((e) => toMinutes(e.endTime)))) continue;
      dateKeys.push(key);
    }
  }
  dateKeys.reverse(); // newest first

  const firstScan = new Map(); // playerId -> Map(dateKey -> Date)
  for (const r of credited) {
    if (!firstScan.has(r.playerId)) firstScan.set(r.playerId, new Map());
    const byDate = firstScan.get(r.playerId);
    const prev = byDate.get(r.dateKey);
    if (!prev || r.time < prev) byDate.set(r.dateKey, r.time);
  }

  const sortedPlayers = [...players].sort((a, b) => lastNameSortKey(a.name).localeCompare(lastNameSortKey(b.name)));
  const cells = dateKeys.map((key) =>
    sortedPlayers.map((p) => {
      if (p.joinedDate && key < p.joinedDate) return { kind: "na" };
      const t = firstScan.get(p.id)?.get(key);
      return t ? { kind: "present", time: t } : { kind: "missed" };
    })
  );

  return { players: sortedPlayers, dateKeys, cells };
}

// Turns the model into the two blocks written to the sheet: `top` (rows 1-7,
// includes formulas, written USER_ENTERED) and `data` (rows 8+, plain text,
// written RAW so "5:42 PM" stays text instead of becoming a time value).
export function renderSheetValues(model, { title, updatedLabel, formatDate, formatTime }) {
  const n = model.players.length;
  const lastDataRow = FIRST_DATA_ROW + Math.max(model.dateKeys.length, 1) - 1;
  const width = n + 1;
  const pad = (row) => row.concat(Array(Math.max(0, width - row.length)).fill(""));

  const colRange = (c) => `${columnLetter(c)}$${FIRST_DATA_ROW}:${columnLetter(c)}$${lastDataRow}`;
  const perPlayer = (fn) => model.players.map((_, i) => fn(columnLetter(i + 1), colRange(i + 1)));

  const top = [
    pad([`${title} — updated ${updatedLabel}. ${MISSED} = missed, time = arrival, ${NOT_YET} = not yet on team. Team practices only.`]),
    pad(["Player", ...model.players.map((p) => p.name)]),
    pad(["Total Days", ...perPlayer((c, r) => `=COUNTIF(${r},"${MISSED}")+COUNTIF(${r},"*:*")`)]),
    pad(["Days Attended", ...perPlayer((c, r) => `=COUNTIF(${r},"*:*")`)]),
    pad(["Days Missed", ...perPlayer((c, r) => `=COUNTIF(${r},"${MISSED}")`)]),
    pad(["Miss %", ...perPlayer((c) => `=IF(${c}3=0,"",${c}5/${c}3)`)]),
    pad(["Practice date"]),
  ];

  const data = model.dateKeys.map((key, i) =>
    pad([
      formatDate(key),
      ...model.cells[i].map((c) => (c.kind === "present" ? formatTime(c.time) : c.kind === "missed" ? MISSED : NOT_YET)),
    ])
  );

  return { top, data, width, lastDataRow };
}
