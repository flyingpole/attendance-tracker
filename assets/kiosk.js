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
import { POSITIONAL_PRACTICES, SATURDAY, positionalKeyFor, positionalSessionId } from "./positional.js";

const scanInput = document.getElementById("scanInput");
const flash = document.getElementById("flash");
const sessionPicker = document.getElementById("sessionPicker");
const clockEl = document.getElementById("clock");
const manualToggleBtn = document.getElementById("manualToggleBtn");
const backToAutoBtn = document.getElementById("backToAutoBtn");
const autoModeStatus = document.getElementById("autoModeStatus");
const manualPickerWrap = document.getElementById("manualPickerWrap");
const positionalPanel = document.getElementById("positionalPanel");
const positionalPicker = document.getElementById("positionalPicker");
const positionalHint = document.getElementById("positionalHint");

let teamsById = new Map();
let playersByBadge = new Map();
let scheduleEntries = [];
let scheduleCancellations = [];
let processing = false;
let selectedSession = null; // { id, label } — used only in manual mode
let manualMode = false;
const selectedPositionals = new Set(); // keys from POSITIONAL_PRACTICES the next scan will log into
let selectionTimer = null;

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
  renderPositionalPanel();
  autoModeStatus.classList.add("hidden");
  manualPickerWrap.classList.remove("hidden");
  focusInput();
});

backToAutoBtn.addEventListener("click", () => {
  manualMode = false;
  renderPositionalPanel();
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
  renderPositionalPanel();
}

function applyCancellations(snap) {
  scheduleCancellations = [];
  snap.forEach((doc) => scheduleCancellations.push(doc.data()));
  renderPositionalPanel();
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

// Which practice(s) a scan belongs to:
//  - TEAM practice: detected automatically from the master schedule (the
//    player's own team, within the check-in window).
//  - POSITIONAL practices: chosen on screen. Players aren't tagged with a
//    position — any player can attend any positional, several in a day — so on
//    positional days (Saturdays, or any day a positional is scheduled) they tap
//    each practice they attended, then scan; each becomes its own check-in.
//    There's no schedule or time check for positionals: whether they were held
//    that day is worked out later from whether anyone checked in.
// Scans with nothing to log: on a positional day the player is asked to choose
// one first; otherwise it's recorded as an open/unscheduled check-in so the scan
// is never lost.
//
// Which team entries are in play today is resolved by getEntriesForDate, which
// honors each entry's start/end date range and one-off cancellations.
function todaysEntries(now = new Date()) {
  return getEntriesForDate(now, scheduleEntries, scheduleCancellations);
}

function isPositionalDay(now = new Date()) {
  return now.getDay() === SATURDAY || todaysEntries(now).some((e) => e.type === "position");
}

function resolveAutoSessions(player) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todays = todaysEntries(now);

  const sessions = todays
    .filter((e) => e.type === "team" && e.teamId === player.teamId && isTimeActiveOrUpcoming(e, nowMinutes))
    .map((e) => ({ id: e.id, label: e.label }));

  for (const practice of POSITIONAL_PRACTICES.filter((p) => selectedPositionals.has(p.key))) {
    // Link to today's scheduled entry when there is one (keeps the calendar's
    // "who attended" popup working); otherwise use the practice's own id.
    const scheduled = todays.find((e) => e.type === "position" && positionalKeyFor(e.position) === practice.key);
    // The label always uses the current name ("Right Side Hitter", "Libero/Defense"),
    // even when the schedule entry still says "Opposite" / "Libero".
    sessions.push({ id: scheduled ? scheduled.id : positionalSessionId(practice.key), label: `${practice.name} Positional` });
  }

  if (sessions.length) return { sessions };
  if (isPositionalDay(now)) return { sessions: [], needsPositionalChoice: true };
  return { sessions: [{ id: "unscheduled", label: "Open/Unscheduled Check-in" }] };
}

// --- Positional picker (multi-select toggles) ---
function clearPositionalSelection() {
  selectedPositionals.clear();
  clearTimeout(selectionTimer);
  renderPositionalPanel();
}

function renderPositionalPanel() {
  const show = !manualMode && isPositionalDay();
  positionalPanel.classList.toggle("hidden", !show);
  if (!show) {
    selectedPositionals.clear();
    return;
  }
  positionalPicker.innerHTML = "";
  for (const practice of POSITIONAL_PRACTICES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = practice.name;
    btn.className = selectedPositionals.has(practice.key) ? "session-btn active" : "session-btn";
    btn.addEventListener("click", () => {
      if (selectedPositionals.has(practice.key)) selectedPositionals.delete(practice.key);
      else selectedPositionals.add(practice.key);
      // Don't leave one player's choices sitting there for the next person.
      clearTimeout(selectionTimer);
      if (selectedPositionals.size) selectionTimer = setTimeout(clearPositionalSelection, 60 * 1000);
      renderPositionalPanel();
      focusInput();
    });
    positionalPicker.appendChild(btn);
  }
  const names = POSITIONAL_PRACTICES.filter((p) => selectedPositionals.has(p.key)).map((p) => p.name);
  positionalHint.textContent = names.length ? `Selected: ${names.join(" + ")} — now scan your badge.` : "";
}
// Picks up midnight rollover (a Friday kiosk becoming a Saturday one) without a reload.
setInterval(renderPositionalPanel, 60 * 1000);

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
  let sessionInfos;
  if (manualMode) {
    sessionInfos = [selectedSession];
  } else {
    const resolved = resolveAutoSessions(player);
    if (resolved.needsPositionalChoice) {
      setFlash(`Hi ${player.name} — tap the positional practice(s) you're attending above, then scan again.`, "error");
      processing = false;
      return;
    }
    sessionInfos = resolved.sessions;
  }

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
    clearPositionalSelection();
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
