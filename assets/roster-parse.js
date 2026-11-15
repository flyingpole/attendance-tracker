// Pure parsing/validation helpers for the roster CSV import (no DOM, no
// Firestore) so the rules can be unit-tested on their own.
import { POSITIONS } from "./positions.js";

// Common abbreviations coaches type in a spreadsheet -> the canonical position.
const POSITION_ALIASES = {
  s: "Setter",
  set: "Setter",
  oh: "Outside Hitter",
  outside: "Outside Hitter",
  "outside hitter": "Outside Hitter",
  mb: "Middle Blocker",
  middle: "Middle Blocker",
  "middle blocker": "Middle Blocker",
  opp: "Opposite",
  rs: "Opposite",
  "right side": "Opposite",
  l: "Libero",
  lib: "Libero",
  ds: "Defensive Specialist",
  def: "Defensive Specialist",
  defensive: "Defensive Specialist",
  "defensive specialist": "Defensive Specialist",
};

export function normalizePosition(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase().replace(/\s+/g, " ");
  const exact = POSITIONS.find((p) => p.toLowerCase() === lower);
  if (exact) return exact;
  const alias = POSITION_ALIASES[lower.replace(/[./]/g, "")];
  return alias && POSITIONS.includes(alias) ? alias : "";
}

// Spreadsheet headers vary ("Team ID", "Player Name", "teamid", "Jersey #") —
// compare them with case, spaces and punctuation stripped.
function squash(header) {
  return String(header)
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/#/g, "number") // "Jersey #" and "#" both mean "number"
    .replace(/[^a-z0-9]/g, "");
}

const ALIASES = {
  name: ["name", "playername", "player", "fullname", "athlete"],
  team: ["teamid", "teamcode", "team", "code", "teamname"],
  email: ["email", "emailaddress", "parentemail"],
  jersey: ["jersey", "jerseynumber", "jerseyno", "number", "num", "no"],
  position: ["position", "pos"],
};

export function readRow(row) {
  const lookup = new Map();
  for (const [key, value] of Object.entries(row)) {
    lookup.set(squash(key), value == null ? "" : String(value).trim());
  }
  const pick = (names) => {
    for (const n of names) {
      const v = lookup.get(n);
      if (v) return v;
    }
    return "";
  };
  return {
    name: pick(ALIASES.name),
    team: pick(ALIASES.team),
    email: pick(ALIASES.email),
    jersey: pick(ALIASES.jersey),
    position: pick(ALIASES.position),
  };
}

// Accept the team's code ("14SB") or its full name ("14 State Black"),
// ignoring case. Returns the canonical team code, or null if no match.
export function resolveTeamId(raw, teams) {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return null;
  for (const id of teams.keys()) {
    if (id.toLowerCase() === t) return id;
  }
  for (const [id, team] of teams) {
    if ((team.name || "").trim().toLowerCase() === t) return id;
  }
  return null;
}

// The downloadable template ships with one placeholder row; never import it.
function isExampleRow(name) {
  return /^example\b/i.test(name);
}

export function rosterKey(teamId, name) {
  return `${teamId}::${String(name || "").trim().toLowerCase()}`;
}

// teams: Map(teamCode -> team doc). existingKeys: Set of rosterKey() values
// already in the database. Returns one entry per CSV row with a status and
// `reason` (null when the row will import).
export function classifyRows(rows, teams, existingKeys) {
  const seen = new Set(existingKeys);
  return rows.map((row) => {
    const f = readRow(row);
    const teamId = resolveTeamId(f.team, teams);
    const position = normalizePosition(f.position);
    const base = { name: f.name, teamRaw: f.team, teamId, email: f.email, jersey: f.jersey, position };

    if (!f.name || !f.team) {
      return { ...base, reason: "missing", status: "Skipped — missing name or team", willImport: false };
    }
    if (isExampleRow(f.name)) {
      return { ...base, reason: "example", status: "Skipped — template example row", willImport: false };
    }
    if (!teamId) {
      return { ...base, reason: "unknownTeam", status: `Skipped — unknown team "${f.team}"`, willImport: false };
    }
    const key = rosterKey(teamId, f.name);
    if (seen.has(key)) {
      return {
        ...base,
        reason: "duplicate",
        status: "Skipped — already on roster (or repeated in this file)",
        willImport: false,
      };
    }
    seen.add(key);
    const note = f.position && !position ? ` (position "${f.position}" not recognized — left blank)` : "";
    return { ...base, reason: null, status: `Will import${note}`, willImport: true };
  });
}

// Plain-language explanation for when no row can be imported.
export function describeNothingToImport(rows) {
  if (rows.length === 0) {
    return "No rows were found in that file. It needs a header row (Name, TeamID, …) followed by one player per row.";
  }
  const count = (reason) => rows.filter((r) => r.reason === reason).length;
  const parts = [];
  if (count("missing")) parts.push(`${count("missing")} missing a name or team`);
  if (count("unknownTeam")) {
    const bad = [...new Set(rows.filter((r) => r.reason === "unknownTeam").map((r) => r.teamRaw))];
    const shown = bad.slice(0, 5).join(", ") + (bad.length > 5 ? ", …" : "");
    parts.push(`${count("unknownTeam")} with a team that doesn't exist (${shown}) — use a code from the list above`);
  }
  if (count("duplicate")) parts.push(`${count("duplicate")} already on the roster`);
  if (count("example")) parts.push(`${count("example")} template example row (replace it with real players)`);
  return `Nothing to import — of ${rows.length} row(s): ${parts.join("; ")}.`;
}

// Plans position updates from an edited roster CSV against the players already
// in the database (matched by team + name). Only the position is ever changed;
// a blank Position cell leaves the player as they are.
// players: [{id, name, teamId, position}]; teams: Map(teamCode -> team doc).
export function classifyPositionUpdates(rows, teams, players) {
  const byKey = new Map(players.map((p) => [rosterKey(p.teamId, p.name), p]));
  const seen = new Set();
  return rows.map((row) => {
    const f = readRow(row);
    const teamId = resolveTeamId(f.team, teams);
    const base = { name: f.name, teamRaw: f.team, teamId, rawPosition: f.position, playerId: null, oldPosition: "", newPosition: "" };

    if (!f.name || !f.team) return { ...base, reason: "missing", status: "Skipped — missing name or team", willUpdate: false };
    if (!teamId) return { ...base, reason: "unknownTeam", status: `Skipped — unknown team "${f.team}"`, willUpdate: false };
    const key = rosterKey(teamId, f.name);
    const player = byKey.get(key);
    if (!player) return { ...base, reason: "notFound", status: "Skipped — not on the roster (use Add a player)", willUpdate: false };
    const withPlayer = { ...base, playerId: player.id, oldPosition: player.position || "" };
    if (seen.has(key)) return { ...withPlayer, reason: "duplicate", status: "Skipped — repeated in this file", willUpdate: false };
    seen.add(key);
    if (!f.position) return { ...withPlayer, reason: "blank", status: "No change (position blank)", willUpdate: false };
    const position = normalizePosition(f.position);
    if (!position) {
      return { ...withPlayer, reason: "badPosition", status: `Skipped — "${f.position}" isn't a recognized position`, willUpdate: false };
    }
    if (position === (player.position || "")) return { ...withPlayer, newPosition: position, reason: "same", status: "No change", willUpdate: false };
    return {
      ...withPlayer,
      newPosition: position,
      reason: null,
      status: player.position ? `Change ${player.position} → ${position}` : `Set to ${position}`,
      willUpdate: true,
    };
  });
}
