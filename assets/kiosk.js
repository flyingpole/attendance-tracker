import { db } from "./firebase.js";
import {
  collection,
  onSnapshot,
  query,
  where,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getEntriesForDate } from "./schedule-matching.js";

const scanInput = document.getElementById("scanInput");
const flash = document.getElementById("flash");
const sessionPicker = document.getElementById("sessionPicker");
const clockEl = document.getElementById("clock");
const manualToggleBtn = document.getElementById("manualToggleBtn");
const backToAutoBtn = document.getElementById("backToAutoBtn");
const autoModeStatus = document.getElementById("autoModeStatus");
const manualPickerWrap = document.getElementById("manualPickerWrap");

let teamsById = new Map();
let playersByBadge = new Map();
let scheduleEntries = [];
let scheduleCancellations = [];
let processing = false;
let selectedSession = null; // { id, label } — used only in manual mode
let manualMode = false;

function setFlash(message, kind) {
  flash.textContent = message;
  flash.className = kind;
}

function tickClock() {
  clockEl.textContent = new Date().toLocaleString([], {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}
tickClock();
setInterval(tickClock, 1000 * 30);

function focusInput() {
  scanInput.value = "";
  scanInput.focus();
}

manualToggleBtn.addEventListener("click", () => {
  manualMode = true;
  autoModeStatus.classList.add("hidden");
  manualPickerWrap.classList.remove("hidden");
  focusInput();
});

backToAutoBtn.addEventListener("click", () => {
  manualMode = false;
  autoModeStatus.classList.remove("hidden");
  manualPickerWrap.classList.add("hidden");
  focusInput();
});

// --- Manual override picker (unchanged mechanics — plain buttons, no native
// popup, so refocus is always synchronous and reliable) ---
//
// Data arrives through live listeners (onSnapshot) rather than periodic
// re-reads: after the first load Firestore only sends records that changed, so a
// kiosk left running all day costs a few hundred reads instead of ~130,000 (the
// old 5-minute full reload used up the free daily read quota). Edits the
// director makes also show up on the kiosk immediately.
function listen(source, handler, label) {
  return new Promise((resolve) => {
    onSnapshot(
      source,
      (snap) => {
        handler(snap);
        resolve();
      },
      (err) => {
        // A listener ends on error (e.g. network trouble); keep the last data
        // we have and try again shortly.
        console.error(`Live updates for ${label} stopped:`, err);
        resolve();
        setTimeout(() => listen(source, handler, label), 60 * 1000);
      }
    );
  });
}

function applySessions(snap) {
  const sessions = [];
  snap.forEach((doc) => sessions.push({ id: doc.id, ...doc.data() }));
  sessions.sort((a, b) => a.label.localeCompare(b.label));

  sessionPicker.innerHTML = "";

  if (sessions.length === 0) {
    sessionPicker.innerHTML = `<div style="color:var(--silver);">No manual sessions set up — ask the director to add one on the Practice Sessions tab.</div>`;
    selectedSession = null;
    return;
  }

  if (!selectedSession || !sessions.some((s) => s.id === selectedSession.id)) {
    selectedSession = sessions[0];
  }

  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = s.label;
    btn.className = s.id === selectedSession.id ? "session-btn active" : "session-btn";
    btn.addEventListener("click", () => {
      selectedSession = { id: s.id, label: s.label };
      sessionPicker.querySelectorAll(".session-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      focusInput();
    });
    sessionPicker.appendChild(btn);
  }
}

function applySchedule(snap) {
  scheduleEntries = [];
  snap.forEach((doc) => scheduleEntries.push({ id: doc.id, ...doc.data() }));
}

function applyCancellations(snap) {
  scheduleCancellations = [];
  snap.forEach((doc) => scheduleCancellations.push(doc.data()));
}

function applyTeams(snap) {
  teamsById = new Map();
  snap.forEach((doc) => teamsById.set(doc.id, doc.data()));
}

function applyPlayers(snap) {
  playersByBadge = new Map();
  snap.forEach((doc) => {
    const data = doc.data();
    if (data.active === false) return;
    playersByBadge.set(data.badgeCode, { id: doc.id, ...data });
  });
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Players often arrive a few minutes ahead of the official start — count a
// scan as belonging to a practice if it's within this many minutes early.
const EARLY_ARRIVAL_GRACE_MINUTES = 15;

function isTimeActiveOrUpcoming(entry, nowMinutes) {
  const start = timeToMinutes(entry.startTime) - EARLY_ARRIVAL_GRACE_MINUTES;
  const end = timeToMinutes(entry.endTime);
  return nowMinutes >= start && nowMinutes < end;
}

// A player's tagged position is NOT used to gate which positional practices
// they can check into — players frequently cross over (e.g. a setter sitting
// in on a hitting clinic), so any positional entry that's active/about to
// start is open to whoever scans during that window; they self-select by
// physically showing up. Team-practice entries still only match the player's
// own team. If several entries are live at once (team practice overlapping a
// positional clinic, or two concurrent positional clinics), one scan logs the
// player into all of them. Falls back to a generic label if nothing matches,
// so the scan is never lost.
//
// Which entries are even in play today is resolved by getEntriesForDate,
// which also honors each recurring entry's start/end date range (so a team's
// old Mon/Tue slot from last season doesn't still show up after they moved
// to Wed/Thu this season) and any one-off cancellations for today specifically.
function resolveAutoSessions(player) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todaysEntries = getEntriesForDate(now, scheduleEntries, scheduleCancellations);

  const matches = todaysEntries.filter((e) => {
    if (!isTimeActiveOrUpcoming(e, nowMinutes)) return false;
    return e.type === "team" ? e.teamId === player.teamId : true;
  });

  if (matches.length === 0) {
    return [{ id: "unscheduled", label: "Open/Unscheduled Check-in" }];
  }
  return matches.map((e) => ({ id: e.id, label: e.label }));
}

async function handleScan(code) {
  if (processing) return;
  const trimmed = code.trim();
  if (!trimmed) return;

  if (manualMode && !selectedSession) {
    setFlash("No practice session selected — see the director.", "error");
    focusInput();
    return;
  }

  processing = true;
  focusInput(); // clear + refocus immediately so the next scan isn't blocked

  const player = playersByBadge.get(trimmed);
  if (!player) {
    setFlash(`Badge not recognized: "${trimmed}"`, "error");
    processing = false;
    return;
  }

  const team = teamsById.get(player.teamId);
  const sessionInfos = manualMode ? [selectedSession] : resolveAutoSessions(player);

  try {
    for (const sessionInfo of sessionInfos) {
      await addDoc(collection(db, "attendance"), {
        playerId: player.id,
        playerName: player.name,
        teamId: player.teamId,
        sessionId: sessionInfo.id,
        sessionLabel: sessionInfo.label,
        timestamp: serverTimestamp(),
      });
    }
    const labels = sessionInfos.map((s) => s.label).join(" + ");
    setFlash(`Welcome, ${player.name} — ${team ? team.name : player.teamId} (${labels})`, "ok");
  } catch (err) {
    console.error(err);
    setFlash("Error saving check-in. Try scanning again.", "error");
  } finally {
    processing = false;
  }
}

scanInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleScan(scanInput.value);
  }
});

// Keep the kiosk input focused no matter what the user clicks on. Session
// buttons handle their own refocus in their click handler above, and this
// fires after that anyway, so there's no ordering issue.
document.addEventListener("click", () => focusInput());

// Belt-and-suspenders: reclaim focus from anything else that steals it.
// There's no native popup on this page anymore (no <select>), so there's no
// reason to exempt any element — always win.
setInterval(() => {
  if (document.activeElement !== scanInput) {
    focusInput();
  }
}, 800);

async function init() {
  setFlash("Loading roster…", "idle");
  // Live listeners: resolves once every collection has delivered its first snapshot.
  await Promise.all([
    listen(query(collection(db, "sessions"), where("active", "==", true)), applySessions, "sessions"),
    listen(collection(db, "teams"), applyTeams, "teams"),
    listen(collection(db, "players"), applyPlayers, "players"),
    listen(collection(db, "schedule"), applySchedule, "schedule"),
    listen(collection(db, "scheduleCancellations"), applyCancellations, "cancellations"),
  ]);
  setFlash("Ready — scan a badge to check in.", "idle");
  focusInput();
}

init();

// --- Soft kiosk deterrents ---
// A web page can't truly block closing the window or navigating away — that's
// by design, browsers don't let sites override it. These just raise the
// friction for an idle click; real lockdown is a browser-launch/OS setting
// (see README).
document.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("beforeunload", (e) => {
  e.preventDefault();
  e.returnValue = "";
});
