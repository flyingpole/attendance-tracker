import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  query,
  where,
  addDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
async function loadSessions() {
  const snap = await getDocs(query(collection(db, "sessions"), where("active", "==", true)));
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

async function loadSchedule() {
  const snap = await getDocs(collection(db, "schedule"));
  scheduleEntries = [];
  snap.forEach((doc) => scheduleEntries.push({ id: doc.id, ...doc.data() }));
}

async function loadRoster() {
  const [teamsSnap, playersSnap] = await Promise.all([
    getDocs(collection(db, "teams")),
    getDocs(collection(db, "players")),
  ]);

  teamsById = new Map();
  teamsSnap.forEach((doc) => teamsById.set(doc.id, doc.data()));

  playersByBadge = new Map();
  playersSnap.forEach((doc) => {
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

function isActiveOrUpcoming(entry, dayOfWeek, nowMinutes) {
  if (!entry.days.includes(dayOfWeek)) return false;
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
function resolveAutoSessions(player) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  const matches = scheduleEntries.filter((e) => {
    if (!isActiveOrUpcoming(e, dayOfWeek, nowMinutes)) return false;
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
  await Promise.all([loadSessions(), loadRoster(), loadSchedule()]);
  setFlash("Ready — scan a badge to check in.", "idle");
  focusInput();
}

init();
// Refresh roster/sessions/schedule periodically in case the director makes changes mid-day.
setInterval(() => {
  loadSessions();
  loadRoster();
  loadSchedule();
}, 5 * 60 * 1000);

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
