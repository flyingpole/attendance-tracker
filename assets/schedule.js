import { db } from "./firebase.js";
import {
  collection,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { POSITIONS } from "./positions.js";
import { dateToKey, keyToDate, getEntriesForDate } from "./schedule-matching.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PX_PER_HOUR = 56;
const DRAG_THRESHOLD_PX = 8; // a real click's mousedown/mouseup rarely land at the exact same pixel
const SNAP_MINUTES = 5;
// Must match EARLY_ARRIVAL_GRACE_MINUTES in kiosk.js — the kiosk starts
// accepting check-ins this many minutes before the official start time, so
// attendance can exist before the "official" start.
const EARLY_ARRIVAL_GRACE_MINUTES = 15;

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(mins) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, mins));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDateKeyPretty(key) {
  if (!key) return "";
  return keyToDate(key).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function getSundayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, n) {
  return new Date(date.getFullYear(), date.getMonth() + n, 1);
}

function isSameDate(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatShortDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Assigns overlapping same-day entries to side-by-side "lanes" so they don't
// visually collide — same approach most calendar UIs use for double-booked slots.
function assignLanes(events) {
  const sorted = events.slice().sort((a, b) => a.startMin - b.startMin);
  const laneEnds = [];
  const placed = [];
  for (const ev of sorted) {
    let laneIdx = laneEnds.findIndex((end) => end <= ev.startMin);
    if (laneIdx === -1) {
      laneIdx = laneEnds.length;
      laneEnds.push(ev.endMin);
    } else {
      laneEnds[laneIdx] = ev.endMin;
    }
    placed.push({ ...ev, lane: laneIdx });
  }
  const laneCount = laneEnds.length || 1;
  return placed.map((p) => ({ ...p, laneCount }));
}

export function initScheduleTab(container) {
  const todayKey = dateToKey(new Date());

  container.innerHTML = `
    <div class="card">
      <h2 id="scheduleFormTitle" style="margin-top:0;">Add a master schedule entry</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        The kiosk uses this to automatically figure out which practice a player is checking
        into — no need to pick it manually. <strong>Team Practice</strong> entries match by the
        player's team. <strong>Positional Practice</strong> entries are open to <em>anyone</em>
        who scans in during that window, regardless of team or their own primary position —
        players often cross over (a setter sitting in on a hitting clinic, for example), so
        they self-select just by physically showing up. The position you pick below is only
        a label for the entry. A scan counts up to 15 minutes before the start time, and if
        more than one entry is active at once, one scan checks the player into all of them.
      </p>
      <div id="scheduleStatus"></div>

      <label for="entryKind">Entry type</label>
      <select id="entryKind">
        <option value="recurring">Recurring (repeats weekly, within a date range)</option>
        <option value="single">Single date (one-off event)</option>
      </select>

      <div id="recurringFieldsWrap" style="margin-top:0.75rem;">
        <label>Days</label>
        <div id="dayCheckboxes" style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.75rem;"></div>

        <div style="display:flex; gap:1rem; flex-wrap:wrap;">
          <div style="flex:1; min-width:160px;">
            <label for="seriesStartDate">Starts on</label>
            <input id="seriesStartDate" type="date" />
          </div>
          <div style="flex:1; min-width:160px;">
            <label for="seriesEndDate">Ends on (optional — leave blank if ongoing)</label>
            <input id="seriesEndDate" type="date" />
          </div>
        </div>
        <p style="color:var(--muted); font-size:0.8rem; margin-top:0.4rem; margin-bottom:0;">
          Set an end date when a team's schedule changes for a new season instead of editing the
          old entry — add a new one for the new days/times starting when the old one ends, so
          history stays accurate.
        </p>
      </div>

      <div id="singleDateFieldWrap" class="hidden" style="margin-top:0.75rem;">
        <label for="singleDate">Date</label>
        <input id="singleDate" type="date" />
      </div>

      <div style="display:flex; gap:1rem; flex-wrap:wrap; margin-top:0.75rem;">
        <div style="flex:1; min-width:140px;">
          <label for="startTime">Start time</label>
          <input id="startTime" type="time" value="18:00" />
        </div>
        <div style="flex:1; min-width:140px;">
          <label for="endTime">End time</label>
          <input id="endTime" type="time" value="20:00" />
        </div>
      </div>

      <label for="scheduleType" style="margin-top:0.75rem;">Type</label>
      <select id="scheduleType">
        <option value="team">Team Practice</option>
        <option value="position">Positional Practice</option>
      </select>

      <div id="teamPickerWrap" style="margin-top:0.75rem;">
        <label for="scheduleTeam">Team</label>
        <select id="scheduleTeam"></select>
      </div>

      <div id="positionPickerWrap" style="margin-top:0.75rem;" class="hidden">
        <label for="schedulePosition">Position</label>
        <select id="schedulePosition">${POSITIONS.map((p) => `<option value="${p}">${p}</option>`).join("")}</select>
      </div>

      <label for="scheduleLabel" style="margin-top:0.75rem;">Label (optional — auto-filled if left blank)</label>
      <input id="scheduleLabel" type="text" placeholder="e.g. OH Positional Clinic" />

      <div style="margin-top:1rem; display:flex; gap:0.5rem;">
        <button id="addScheduleBtn">Add to schedule</button>
        <button id="cancelEditBtn" class="secondary hidden">Cancel edit</button>
      </div>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <h2 style="margin:0;">Master schedule</h2>
        <div class="tabs" style="margin-bottom:0;">
          <button id="viewListBtn" class="active">List</button>
          <button id="viewWeekBtn">Week</button>
          <button id="viewMonthBtn">Month</button>
        </div>
      </div>

      <div id="scheduleListView" style="margin-top:1rem; overflow-x:auto;">
        <table>
          <thead><tr><th>Days</th><th>Dates</th><th>Time</th><th>Type</th><th>Matches</th><th>Label</th><th></th></tr></thead>
          <tbody id="scheduleTableBody"></tbody>
        </table>
      </div>

      <div id="scheduleWeekView" class="hidden" style="margin-top:1rem;">
        <div class="calendar-nav">
          <button id="weekPrevBtn" class="secondary">‹ Prev</button>
          <div id="weekRangeLabel" class="calendar-nav-label"></div>
          <button id="weekTodayBtn" class="secondary">Today</button>
          <button id="weekNextBtn" class="secondary">Next ›</button>
        </div>
        <div id="weekGridWrap" style="overflow-x:auto;"></div>
        <p style="color:var(--muted); font-size:0.8rem; margin-top:0.5rem;">
          Drag an event vertically to change its time. Click an event for more options.
          Teal = Team Practice, Coral = Positional.
        </p>
      </div>

      <div id="scheduleMonthView" class="hidden" style="margin-top:1rem;">
        <div class="calendar-nav">
          <button id="monthPrevBtn" class="secondary">‹ Prev</button>
          <div id="monthRangeLabel" class="calendar-nav-label"></div>
          <button id="monthTodayBtn" class="secondary">Today</button>
          <button id="monthNextBtn" class="secondary">Next ›</button>
        </div>
        <div id="monthGridWrap" style="overflow-x:auto;"></div>
      </div>

      <p style="color:var(--muted); font-size:0.8rem; margin-top:0.75rem;">
        Recurring entries only show up on dates inside their start/end range, so old and new
        season schedules don't overlap into the future. Week/Month views reflect real
        cancellations and one-off single-date events for the specific dates shown.
      </p>
    </div>

    <div class="card hidden" id="cancellationsCard">
      <h2 style="margin-top:0;">Canceled occurrences</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Single dates pulled out of a recurring series (e.g. a holiday). Restore removes the
        cancellation so that date goes back to normal.
      </p>
      <table>
        <thead><tr><th>Series</th><th>Canceled date</th><th></th></tr></thead>
        <tbody id="cancellationsTableBody"></tbody>
      </table>
    </div>

    <div id="entryPopupOverlay" class="modal-overlay hidden">
      <div class="modal-box">
        <h3 id="entryPopupTitle" style="margin-top:0;"></h3>
        <p id="entryPopupDetails" style="color:var(--muted);"></p>
        <div id="entryPopupAttendanceWrap" class="hidden" style="margin-top:0.75rem; margin-bottom:0.5rem;">
          <h4 id="entryPopupAttendanceTitle" style="margin-bottom:0.4rem;"></h4>
          <div id="entryPopupAttendanceList"></div>
        </div>
        <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:1rem;">
          <button id="entryPopupEditBtn">Edit</button>
          <button id="entryPopupCancelOccurrenceBtn" class="danger">Cancel this date only</button>
          <button id="entryPopupDeleteBtn" class="danger">Delete</button>
          <button id="entryPopupCloseBtn" class="secondary">Close</button>
        </div>
      </div>
    </div>
  `;

  const formTitle = container.querySelector("#scheduleFormTitle");
  const statusEl = container.querySelector("#scheduleStatus");
  const entryKindSelect = container.querySelector("#entryKind");
  const recurringFieldsWrap = container.querySelector("#recurringFieldsWrap");
  const singleDateFieldWrap = container.querySelector("#singleDateFieldWrap");
  const singleDateInput = container.querySelector("#singleDate");
  const dayCheckboxes = container.querySelector("#dayCheckboxes");
  const seriesStartDateInput = container.querySelector("#seriesStartDate");
  const seriesEndDateInput = container.querySelector("#seriesEndDate");
  const startTimeInput = container.querySelector("#startTime");
  const endTimeInput = container.querySelector("#endTime");
  const typeSelect = container.querySelector("#scheduleType");
  const teamPickerWrap = container.querySelector("#teamPickerWrap");
  const teamSelect = container.querySelector("#scheduleTeam");
  const positionPickerWrap = container.querySelector("#positionPickerWrap");
  const positionSelect = container.querySelector("#schedulePosition");
  const labelInput = container.querySelector("#scheduleLabel");
  const addScheduleBtn = container.querySelector("#addScheduleBtn");
  const cancelEditBtn = container.querySelector("#cancelEditBtn");
  const tbody = container.querySelector("#scheduleTableBody");

  const viewListBtn = container.querySelector("#viewListBtn");
  const viewWeekBtn = container.querySelector("#viewWeekBtn");
  const viewMonthBtn = container.querySelector("#viewMonthBtn");
  const listView = container.querySelector("#scheduleListView");
  const weekView = container.querySelector("#scheduleWeekView");
  const monthView = container.querySelector("#scheduleMonthView");
  const weekGridWrap = container.querySelector("#weekGridWrap");
  const weekRangeLabel = container.querySelector("#weekRangeLabel");
  const monthGridWrap = container.querySelector("#monthGridWrap");
  const monthRangeLabel = container.querySelector("#monthRangeLabel");

  const cancellationsCard = container.querySelector("#cancellationsCard");
  const cancellationsTableBody = container.querySelector("#cancellationsTableBody");

  const entryPopupOverlay = container.querySelector("#entryPopupOverlay");
  const entryPopupTitle = container.querySelector("#entryPopupTitle");
  const entryPopupDetails = container.querySelector("#entryPopupDetails");
  const entryPopupAttendanceWrap = container.querySelector("#entryPopupAttendanceWrap");
  const entryPopupAttendanceTitle = container.querySelector("#entryPopupAttendanceTitle");
  const entryPopupAttendanceList = container.querySelector("#entryPopupAttendanceList");
  const entryPopupEditBtn = container.querySelector("#entryPopupEditBtn");
  const entryPopupCancelOccurrenceBtn = container.querySelector("#entryPopupCancelOccurrenceBtn");
  const entryPopupDeleteBtn = container.querySelector("#entryPopupDeleteBtn");
  const entryPopupCloseBtn = container.querySelector("#entryPopupCloseBtn");

  for (let d = 0; d < 7; d++) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex; align-items:center; gap:0.3rem; font-weight:500;";
    wrap.innerHTML = `<input type="checkbox" value="${d}" class="day-cb" /> ${DAY_NAMES[d]}`;
    dayCheckboxes.appendChild(wrap);
  }

  seriesStartDateInput.value = todayKey;
  singleDateInput.value = todayKey;

  entryKindSelect.addEventListener("change", () => {
    const isRecurring = entryKindSelect.value === "recurring";
    recurringFieldsWrap.classList.toggle("hidden", !isRecurring);
    singleDateFieldWrap.classList.toggle("hidden", isRecurring);
  });

  typeSelect.addEventListener("change", () => {
    const isTeam = typeSelect.value === "team";
    teamPickerWrap.classList.toggle("hidden", !isTeam);
    positionPickerWrap.classList.toggle("hidden", isTeam);
  });

  let teamNames = new Map();
  let latestEntries = [];
  let latestCancellations = [];
  let editingEntryId = null;
  let weekAnchor = getSundayOf(new Date());
  let monthAnchor = firstOfMonth(new Date());
  let currentWeekRangeStart = 0; // minutes; set by renderWeekView, used by drag math
  let popupEntry = null;
  let popupOccurrenceDate = null;

  // --- View switching ---
  function setView(mode) {
    viewListBtn.classList.toggle("active", mode === "list");
    viewWeekBtn.classList.toggle("active", mode === "week");
    viewMonthBtn.classList.toggle("active", mode === "month");
    listView.classList.toggle("hidden", mode !== "list");
    weekView.classList.toggle("hidden", mode !== "week");
    monthView.classList.toggle("hidden", mode !== "month");
    if (mode === "week") renderWeekView();
    if (mode === "month") renderMonthView();
  }
  viewListBtn.addEventListener("click", () => setView("list"));
  viewWeekBtn.addEventListener("click", () => setView("week"));
  viewMonthBtn.addEventListener("click", () => setView("month"));

  container.querySelector("#weekPrevBtn").addEventListener("click", () => {
    weekAnchor = addDays(weekAnchor, -7);
    renderWeekView();
  });
  container.querySelector("#weekNextBtn").addEventListener("click", () => {
    weekAnchor = addDays(weekAnchor, 7);
    renderWeekView();
  });
  container.querySelector("#weekTodayBtn").addEventListener("click", () => {
    weekAnchor = getSundayOf(new Date());
    renderWeekView();
  });
  container.querySelector("#monthPrevBtn").addEventListener("click", () => {
    monthAnchor = addMonths(monthAnchor, -1);
    renderMonthView();
  });
  container.querySelector("#monthNextBtn").addEventListener("click", () => {
    monthAnchor = addMonths(monthAnchor, 1);
    renderMonthView();
  });
  container.querySelector("#monthTodayBtn").addEventListener("click", () => {
    monthAnchor = firstOfMonth(new Date());
    renderMonthView();
  });

  // --- Entry popup (Edit / Cancel-this-date / Delete-series / past-occurrence attendance) ---
  async function fetchAttendanceFor(sessionId, date) {
    const snap = await getDocs(query(collection(db, "attendance"), where("sessionId", "==", sessionId)));
    const records = [];
    snap.forEach((d) => {
      const data = d.data();
      const ts = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate() : new Date(data.timestamp);
      if (isSameDate(ts, date)) records.push({ ...data, time: ts });
    });
    records.sort((a, b) => a.time - b.time);
    return records;
  }

  async function showAttendanceForOccurrence(entry, occurrenceDate, inProgress) {
    entryPopupAttendanceWrap.classList.remove("hidden");
    const dateLabel = occurrenceDate.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    entryPopupAttendanceTitle.textContent = inProgress
      ? `Checked in so far — ${dateLabel} (in progress)`
      : `Who attended — ${dateLabel}`;
    entryPopupAttendanceList.innerHTML = `<p style="color:var(--muted); margin:0;">Loading…</p>`;
    try {
      const records = await fetchAttendanceFor(entry.id, occurrenceDate);
      if (records.length === 0) {
        entryPopupAttendanceList.innerHTML = `<p style="color:var(--muted); margin:0;">No check-ins recorded for this date.</p>`;
        return;
      }
      entryPopupAttendanceList.innerHTML = `
        <table>
          <thead><tr><th>Player</th><th>Arrival</th></tr></thead>
          <tbody>
            ${records
              .map(
                (r) =>
                  `<tr><td>${r.playerName}</td><td>${r.time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</td></tr>`
              )
              .join("")}
          </tbody>
        </table>
      `;
    } catch (err) {
      entryPopupAttendanceList.innerHTML = `<p style="color:var(--coral-dark); margin:0;">Couldn't load attendance: ${err.message}</p>`;
    }
  }

  function openEntryPopup(entry, occurrenceDate) {
    popupEntry = entry;
    popupOccurrenceDate = occurrenceDate;
    const isRecurring = entry.kind !== "single";
    const matchLabel = entry.type === "team" ? teamNames.get(entry.teamId) || entry.teamId : entry.position;

    let whenStr;
    if (isRecurring) {
      const daysStr = (entry.days || [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d])
        .join(", ");
      const rangeStr = `${entry.startDate ? formatDateKeyPretty(entry.startDate) : "no start set"} – ${entry.endDate ? formatDateKeyPretty(entry.endDate) : "ongoing"}`;
      whenStr = `${daysStr} (${rangeStr})`;
    } else {
      whenStr = `One-off — ${formatDateKeyPretty(entry.date)}`;
    }

    entryPopupTitle.textContent = entry.label;
    entryPopupDetails.innerHTML = `
      ${entry.type === "team" ? "Team Practice" : "Positional Practice"} — ${matchLabel}<br>
      ${whenStr}<br>
      ${formatTime(entry.startTime)} – ${formatTime(entry.endTime)}
    `;

    entryPopupCancelOccurrenceBtn.classList.toggle("hidden", !isRecurring || !occurrenceDate);
    entryPopupDeleteBtn.textContent = isRecurring ? "Delete entire series" : "Delete";

    // Show attendance once the check-in window has opened (same 15-minute
    // early-arrival grace the kiosk uses) — covers a session that's
    // currently in progress, not just ones that have fully wrapped up.
    let checkInsPossible = false;
    let stillInProgress = false;
    if (occurrenceDate) {
      const [startH, startM] = entry.startTime.split(":").map(Number);
      const [endH, endM] = entry.endTime.split(":").map(Number);
      const occurrenceStart = new Date(occurrenceDate);
      occurrenceStart.setHours(startH, startM, 0, 0);
      const checkInWindowStart = new Date(occurrenceStart.getTime() - EARLY_ARRIVAL_GRACE_MINUTES * 60000);
      const occurrenceEnd = new Date(occurrenceDate);
      occurrenceEnd.setHours(endH, endM, 0, 0);
      const now = new Date();
      checkInsPossible = checkInWindowStart <= now;
      stillInProgress = checkInsPossible && now < occurrenceEnd;
    }

    if (checkInsPossible) {
      showAttendanceForOccurrence(entry, occurrenceDate, stillInProgress);
    } else {
      entryPopupAttendanceWrap.classList.add("hidden");
    }

    entryPopupOverlay.classList.remove("hidden");
  }
  function closeEntryPopup() {
    popupEntry = null;
    popupOccurrenceDate = null;
    entryPopupOverlay.classList.add("hidden");
  }
  entryPopupCloseBtn.addEventListener("click", closeEntryPopup);
  entryPopupOverlay.addEventListener("click", (e) => {
    if (e.target === entryPopupOverlay) closeEntryPopup();
  });
  entryPopupCancelOccurrenceBtn.addEventListener("click", async () => {
    if (!popupEntry || !popupOccurrenceDate) return;
    const dateLabel = popupOccurrenceDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    if (!confirm(`Cancel just the ${dateLabel} occurrence of "${popupEntry.label}"? The rest of the series is unaffected.`)) return;
    await addDoc(collection(db, "scheduleCancellations"), {
      scheduleId: popupEntry.id,
      date: dateToKey(popupOccurrenceDate),
    });
    closeEntryPopup();
    refreshAll();
  });
  entryPopupDeleteBtn.addEventListener("click", async () => {
    if (!popupEntry) return;
    const isRecurring = popupEntry.kind !== "single";
    const msg = isRecurring
      ? `Delete the ENTIRE recurring series "${popupEntry.label}"? This removes every past and future occurrence, not just this one. This cannot be undone.`
      : `Delete "${popupEntry.label}"? This cannot be undone.`;
    if (!confirm(msg)) return;
    await deleteDoc(doc(db, "schedule", popupEntry.id));
    closeEntryPopup();
    refreshAll();
  });
  entryPopupEditBtn.addEventListener("click", () => {
    if (!popupEntry) return;
    startEditing(popupEntry);
    closeEntryPopup();
  });

  // --- Edit mode on the add form ---
  function startEditing(entry) {
    editingEntryId = entry.id;
    const kind = entry.kind === "single" ? "single" : "recurring";
    entryKindSelect.value = kind;
    entryKindSelect.dispatchEvent(new Event("change"));

    if (kind === "recurring") {
      dayCheckboxes.querySelectorAll(".day-cb").forEach((cb) => (cb.checked = (entry.days || []).includes(Number(cb.value))));
      seriesStartDateInput.value = entry.startDate || todayKey;
      seriesEndDateInput.value = entry.endDate || "";
    } else {
      singleDateInput.value = entry.date || todayKey;
    }

    startTimeInput.value = entry.startTime;
    endTimeInput.value = entry.endTime;
    typeSelect.value = entry.type;
    typeSelect.dispatchEvent(new Event("change"));
    if (entry.type === "team") teamSelect.value = entry.teamId;
    else positionSelect.value = entry.position;
    labelInput.value = entry.label;
    formTitle.textContent = `Editing "${entry.label}"`;
    addScheduleBtn.textContent = "Save changes";
    cancelEditBtn.classList.remove("hidden");
    container.querySelector(".card").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function stopEditing() {
    editingEntryId = null;
    formTitle.textContent = "Add a master schedule entry";
    addScheduleBtn.textContent = "Add to schedule";
    cancelEditBtn.classList.add("hidden");
    entryKindSelect.value = "recurring";
    entryKindSelect.dispatchEvent(new Event("change"));
    dayCheckboxes.querySelectorAll(".day-cb").forEach((cb) => (cb.checked = false));
    seriesStartDateInput.value = todayKey;
    seriesEndDateInput.value = "";
    singleDateInput.value = todayKey;
    labelInput.value = "";
  }
  cancelEditBtn.addEventListener("click", stopEditing);

  // --- Week view rendering + drag-to-move ---
  function renderWeekView() {
    const weekEnd = addDays(weekAnchor, 6);
    weekRangeLabel.textContent =
      weekAnchor.getMonth() === weekEnd.getMonth()
        ? `${formatShortDate(weekAnchor)} – ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
        : `${formatShortDate(weekAnchor)} – ${formatShortDate(weekEnd)}, ${weekEnd.getFullYear()}`;

    if (latestEntries.length === 0) {
      weekGridWrap.innerHTML = `<p style="color:var(--muted);">No schedule entries yet — add one above.</p>`;
      return;
    }

    let rangeStart = Math.min(...latestEntries.map((e) => timeToMinutes(e.startTime)));
    let rangeEnd = Math.max(...latestEntries.map((e) => timeToMinutes(e.endTime)));
    rangeStart = Math.max(0, Math.floor(rangeStart / 60) * 60 - 60);
    rangeEnd = Math.min(24 * 60, Math.ceil(rangeEnd / 60) * 60 + 60);
    currentWeekRangeStart = rangeStart;
    const totalHeight = ((rangeEnd - rangeStart) / 60) * PX_PER_HOUR;

    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekAnchor, i));
    const today = new Date();

    let hourLabelsHtml = "";
    for (let m = rangeStart; m < rangeEnd; m += 60) {
      hourLabelsHtml += `<div class="calendar-time-label" style="height:${PX_PER_HOUR}px;">${formatTime(minutesToTimeStr(m))}</div>`;
    }

    const dayColsHtml = weekDates
      .map((date) => {
        const evs = getEntriesForDate(date, latestEntries, latestCancellations).map((e) => ({
          ...e,
          startMin: timeToMinutes(e.startTime),
          endMin: timeToMinutes(e.endTime),
        }));
        const placed = assignLanes(evs);
        const blocksHtml = placed
          .map((ev) => {
            const top = ((ev.startMin - rangeStart) / 60) * PX_PER_HOUR;
            const height = Math.max(16, ((ev.endMin - ev.startMin) / 60) * PX_PER_HOUR);
            const widthPct = 100 / ev.laneCount;
            const leftPct = ev.lane * widthPct;
            const matchLabel = ev.type === "team" ? teamNames.get(ev.teamId) || ev.teamId : ev.position;
            return `<div class="calendar-event ${ev.type}" data-id="${ev.id}" data-date="${dateToKey(date)}"
              style="top:${top}px; height:${height}px; left:${leftPct}%; width:calc(${widthPct}% - 3px);"
              title="${ev.label} (${matchLabel}) ${formatTime(ev.startTime)}–${formatTime(ev.endTime)}">${ev.label}</div>`;
          })
          .join("");
        const gridLines = `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${PX_PER_HOUR}px)`;
        const todayClass = isSameDate(date, today) ? " today-col" : "";
        return `<div class="calendar-day-col${todayClass}" style="height:${totalHeight}px; background-image:${gridLines};">${blocksHtml}</div>`;
      })
      .join("");

    weekGridWrap.innerHTML = `
      <div class="calendar-grid">
        <div class="calendar-header-cell"></div>
        ${weekDates.map((d) => `<div class="calendar-header-cell">${DAY_NAMES[d.getDay()]}<br>${d.getDate()}</div>`).join("")}
        <div>${hourLabelsHtml}</div>
        ${dayColsHtml}
      </div>
    `;

    wireWeekEventInteractions();
  }

  function wireWeekEventInteractions() {
    weekGridWrap.querySelectorAll(".calendar-event").forEach((el) => {
      let dragging = false;
      let moved = false;
      let startY = 0;
      let originalTop = 0;
      let durationMin = 0;

      function onMove(e) {
        const dy = e.clientY - startY;
        if (Math.abs(dy) > DRAG_THRESHOLD_PX) moved = true;
        if (!moved) return;
        el.classList.add("dragging");
        const dayCol = el.parentElement;
        const maxTop = dayCol.clientHeight - el.offsetHeight;
        const newTop = Math.min(Math.max(0, originalTop + dy), Math.max(0, maxTop));
        el.style.top = `${newTop}px`;
      }

      async function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        dragging = false;
        el.classList.remove("dragging");

        const id = el.dataset.id;
        if (!moved) {
          const entry = latestEntries.find((x) => x.id === id);
          const occurrenceDate = el.dataset.date ? keyToDate(el.dataset.date) : null;
          if (entry) openEntryPopup(entry, occurrenceDate);
          return;
        }

        const finalTop = parseFloat(el.style.top);
        const rawMinutes = currentWeekRangeStart + (finalTop / PX_PER_HOUR) * 60;
        const snappedStart = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES;
        const newEnd = snappedStart + durationMin;

        try {
          await updateDoc(doc(db, "schedule", id), {
            startTime: minutesToTimeStr(snappedStart),
            endTime: minutesToTimeStr(newEnd),
          });
          statusEl.innerHTML = `<div class="status-banner ok">Updated time for "${el.textContent}".</div>`;
        } catch (err) {
          statusEl.innerHTML = `<div class="status-banner error">Couldn't update: ${err.message}</div>`;
        }
        refreshAll();
      }

      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const entry = latestEntries.find((x) => x.id === el.dataset.id);
        if (!entry) return;
        dragging = true;
        moved = false;
        startY = e.clientY;
        originalTop = parseFloat(el.style.top);
        durationMin = timeToMinutes(entry.endTime) - timeToMinutes(entry.startTime);
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    });
  }

  // --- Month view rendering ---
  function renderMonthView() {
    monthRangeLabel.textContent = monthAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });

    const firstDow = monthAnchor.getDay();
    const daysInMonth = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0).getDate();
    const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;
    const gridStart = addDays(monthAnchor, -firstDow);
    const today = new Date();

    let cellsHtml = "";
    for (let i = 0; i < totalCells; i++) {
      const cellDate = addDays(gridStart, i);
      const inMonth = cellDate.getMonth() === monthAnchor.getMonth();
      const evs = getEntriesForDate(cellDate, latestEntries, latestCancellations)
        .slice()
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

      const pillsHtml = evs
        .map((e) => {
          const matchLabel = e.type === "team" ? teamNames.get(e.teamId) || e.teamId : e.position;
          return `<div class="month-event-pill ${e.type}" data-id="${e.id}" data-date="${dateToKey(cellDate)}" title="${e.label} (${matchLabel}) ${formatTime(e.startTime)}–${formatTime(e.endTime)}">${formatTime(e.startTime)} ${e.label}</div>`;
        })
        .join("");

      const classes = ["month-day-cell"];
      if (!inMonth) classes.push("other-month");
      if (isSameDate(cellDate, today)) classes.push("today");

      cellsHtml += `<div class="${classes.join(" ")}">
        <div class="month-day-number"><span>${cellDate.getDate()}</span></div>
        ${pillsHtml}
      </div>`;
    }

    monthGridWrap.innerHTML = `
      <div class="month-grid">
        ${DAY_NAMES.map((d) => `<div class="month-header-cell">${d}</div>`).join("")}
        ${cellsHtml}
      </div>
    `;

    monthGridWrap.querySelectorAll(".month-event-pill").forEach((el) => {
      el.addEventListener("click", () => {
        const entry = latestEntries.find((x) => x.id === el.dataset.id);
        const occurrenceDate = el.dataset.date ? keyToDate(el.dataset.date) : null;
        if (entry) openEntryPopup(entry, occurrenceDate);
      });
    });
  }

  // --- Cancellations management ---
  function renderCancellations() {
    if (latestCancellations.length === 0) {
      cancellationsCard.classList.add("hidden");
      return;
    }
    cancellationsCard.classList.remove("hidden");
    const sorted = latestCancellations.slice().sort((a, b) => a.date.localeCompare(b.date));
    cancellationsTableBody.innerHTML = sorted
      .map((c) => {
        const parent = latestEntries.find((e) => e.id === c.scheduleId);
        const label = parent ? parent.label : "(deleted series)";
        return `<tr><td>${label}</td><td>${formatDateKeyPretty(c.date)}</td><td><button data-id="${c.id}" class="secondary">Restore</button></td></tr>`;
      })
      .join("");
    cancellationsTableBody.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await deleteDoc(doc(db, "scheduleCancellations", btn.dataset.id));
        refreshAll();
      });
    });
  }

  // --- Data loading ---
  async function loadTeams() {
    const snap = await getDocs(collection(db, "teams"));
    teamNames = new Map();
    snap.forEach((d) => teamNames.set(d.id, d.data().name));
    teamSelect.innerHTML = [...teamNames.entries()]
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
      .join("");
  }

  function sortKeyFor(e) {
    return e.kind === "single" ? e.date || "" : e.startDate || "";
  }

  async function refreshAll() {
    const [scheduleSnap, cancelSnap] = await Promise.all([
      getDocs(collection(db, "schedule")),
      getDocs(collection(db, "scheduleCancellations")),
    ]);

    const entries = [];
    scheduleSnap.forEach((d) => entries.push({ id: d.id, ...d.data() }));
    entries.sort((a, b) => sortKeyFor(a).localeCompare(sortKeyFor(b)) || a.startTime.localeCompare(b.startTime));
    latestEntries = entries;

    latestCancellations = [];
    cancelSnap.forEach((d) => latestCancellations.push({ id: d.id, ...d.data() }));

    tbody.innerHTML = "";
    for (const e of entries) {
      const isRecurring = e.kind !== "single";
      const daysStr = isRecurring
        ? (e.days || [])
            .slice()
            .sort((a, b) => a - b)
            .map((d) => DAY_NAMES[d])
            .join(", ")
        : "One-off";
      const datesStr = isRecurring
        ? `${e.startDate ? formatDateKeyPretty(e.startDate) : "(no start set)"} – ${e.endDate ? formatDateKeyPretty(e.endDate) : "ongoing"}`
        : formatDateKeyPretty(e.date);
      const matchStr = e.type === "team" ? teamNames.get(e.teamId) || e.teamId : e.position;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${daysStr}</td>
        <td>${datesStr}</td>
        <td>${formatTime(e.startTime)} – ${formatTime(e.endTime)}</td>
        <td>${e.type === "team" ? "Team Practice" : "Positional"}</td>
        <td>${matchStr}</td>
        <td>${e.label}</td>
        <td>
          <button data-action="edit" data-id="${e.id}" class="secondary">Edit</button>
          <button data-action="delete" data-id="${e.id}" class="danger">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = latestEntries.find((x) => x.id === btn.dataset.id);
        if (entry) startEditing(entry);
      });
    });
    tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entry = latestEntries.find((x) => x.id === btn.dataset.id);
        const isRecurring = entry?.kind !== "single";
        const msg = isRecurring
          ? `Delete the entire recurring series "${entry ? entry.label : "this entry"}"? This cannot be undone.`
          : `Delete "${entry ? entry.label : "this entry"}"? This cannot be undone.`;
        if (!confirm(msg)) return;
        await deleteDoc(doc(db, "schedule", btn.dataset.id));
        refreshAll();
      });
    });

    renderCancellations();

    if (!weekView.classList.contains("hidden")) renderWeekView();
    if (!monthView.classList.contains("hidden")) renderMonthView();
  }

  addScheduleBtn.addEventListener("click", async () => {
    const kind = entryKindSelect.value;
    const startTime = startTimeInput.value;
    const endTime = endTimeInput.value;
    const type = typeSelect.value;

    if (!startTime || !endTime || startTime >= endTime) {
      statusEl.innerHTML = `<div class="status-banner error">Enter a valid start/end time (end must be after start).</div>`;
      return;
    }

    const entry = { kind, startTime, endTime, type };

    if (kind === "recurring") {
      const days = [...dayCheckboxes.querySelectorAll(".day-cb:checked")].map((cb) => Number(cb.value));
      if (days.length === 0) {
        statusEl.innerHTML = `<div class="status-banner error">Pick at least one day.</div>`;
        return;
      }
      if (!seriesStartDateInput.value) {
        statusEl.innerHTML = `<div class="status-banner error">Pick a start date for the series.</div>`;
        return;
      }
      if (seriesEndDateInput.value && seriesEndDateInput.value < seriesStartDateInput.value) {
        statusEl.innerHTML = `<div class="status-banner error">End date can't be before the start date.</div>`;
        return;
      }
      entry.days = days;
      entry.startDate = seriesStartDateInput.value;
      entry.endDate = seriesEndDateInput.value || null;
    } else {
      if (!singleDateInput.value) {
        statusEl.innerHTML = `<div class="status-banner error">Pick a date.</div>`;
        return;
      }
      entry.date = singleDateInput.value;
    }

    let defaultLabel;
    if (type === "team") {
      if (!teamSelect.value) {
        statusEl.innerHTML = `<div class="status-banner error">Add a team first (Teams tab).</div>`;
        return;
      }
      entry.teamId = teamSelect.value;
      defaultLabel = `${teamNames.get(teamSelect.value) || teamSelect.value} Team Practice`;
    } else {
      entry.position = positionSelect.value;
      defaultLabel = `${positionSelect.value} Positional`;
    }
    entry.label = labelInput.value.trim() || defaultLabel;

    if (editingEntryId) {
      // Full overwrite (not merge) so switching kind during an edit doesn't
      // leave stale fields from the other kind (e.g. old `days` sticking
      // around on an entry just converted to a single date).
      await setDoc(doc(db, "schedule", editingEntryId), entry);
      statusEl.innerHTML = `<div class="status-banner ok">Updated "${entry.label}".</div>`;
      stopEditing();
    } else {
      await addDoc(collection(db, "schedule"), entry);
      statusEl.innerHTML = `<div class="status-banner ok">Added "${entry.label}".</div>`;
      dayCheckboxes.querySelectorAll(".day-cb").forEach((cb) => (cb.checked = false));
      seriesStartDateInput.value = todayKey;
      seriesEndDateInput.value = "";
      singleDateInput.value = todayKey;
      labelInput.value = "";
    }
    refreshAll();
  });

  (async () => {
    await loadTeams();
    await refreshAll();
  })();
}
