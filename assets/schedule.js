import { db } from "./firebase.js";
import {
  collection,
  addDoc,
  deleteDoc,
  doc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { POSITIONS } from "./positions.js";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PX_PER_HOUR = 56;

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeStr(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatTime(t) {
  const [h, m] = t.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
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

function renderCalendar(container, entries, teamNames) {
  if (entries.length === 0) {
    container.innerHTML = `<p style="color:var(--muted);">No schedule entries yet — add one above.</p>`;
    return;
  }

  let rangeStart = Math.min(...entries.map((e) => timeToMinutes(e.startTime)));
  let rangeEnd = Math.max(...entries.map((e) => timeToMinutes(e.endTime)));
  rangeStart = Math.max(0, Math.floor(rangeStart / 60) * 60 - 60);
  rangeEnd = Math.min(24 * 60, Math.ceil(rangeEnd / 60) * 60 + 60);
  const totalHeight = ((rangeEnd - rangeStart) / 60) * PX_PER_HOUR;

  const dayEvents = Array.from({ length: 7 }, () => []);
  for (const e of entries) {
    for (const d of e.days) {
      dayEvents[d].push({
        ...e,
        startMin: timeToMinutes(e.startTime),
        endMin: timeToMinutes(e.endTime),
      });
    }
  }

  let hourLabelsHtml = "";
  for (let m = rangeStart; m < rangeEnd; m += 60) {
    hourLabelsHtml += `<div class="calendar-time-label" style="height:${PX_PER_HOUR}px;">${formatTime(minutesToTimeStr(m))}</div>`;
  }

  const dayColsHtml = dayEvents
    .map((evs) => {
      const placed = assignLanes(evs);
      const blocksHtml = placed
        .map((ev) => {
          const top = ((ev.startMin - rangeStart) / 60) * PX_PER_HOUR;
          const height = Math.max(16, ((ev.endMin - ev.startMin) / 60) * PX_PER_HOUR);
          const widthPct = 100 / ev.laneCount;
          const leftPct = ev.lane * widthPct;
          const matchLabel = ev.type === "team" ? teamNames.get(ev.teamId) || ev.teamId : ev.position;
          return `<div class="calendar-event ${ev.type}" data-id="${ev.id}"
            style="top:${top}px; height:${height}px; left:${leftPct}%; width:calc(${widthPct}% - 3px);"
            title="${ev.label} (${matchLabel}) ${formatTime(ev.startTime)}–${formatTime(ev.endTime)} — click to delete">${ev.label}</div>`;
        })
        .join("");
      const gridLines = `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${PX_PER_HOUR}px)`;
      return `<div class="calendar-day-col" style="height:${totalHeight}px; background-image:${gridLines};">${blocksHtml}</div>`;
    })
    .join("");

  container.innerHTML = `
    <div class="calendar-grid">
      <div class="calendar-header-cell"></div>
      ${DAY_NAMES.map((d) => `<div class="calendar-header-cell">${d}</div>`).join("")}
      <div>${hourLabelsHtml}</div>
      ${dayColsHtml}
    </div>
    <p style="color:var(--muted); font-size:0.8rem; margin-top:0.5rem;">
      Teal = Team Practice, Coral = Positional Practice. Click an event to delete it.
    </p>
  `;

  container.querySelectorAll(".calendar-event").forEach((el) => {
    el.addEventListener("click", async () => {
      if (!confirm("Delete this schedule entry?")) return;
      await deleteDoc(doc(db, "schedule", el.dataset.id));
      // Whoever owns the container is responsible for re-rendering — dispatch
      // a custom event so initScheduleTab's refreshAll can pick it up.
      container.dispatchEvent(new CustomEvent("schedule-changed", { bubbles: true }));
    });
  });
}

export function initScheduleTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Add a master schedule entry</h2>
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

      <label>Days</label>
      <div id="dayCheckboxes" style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-bottom:0.75rem;"></div>

      <div style="display:flex; gap:1rem; flex-wrap:wrap;">
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

      <button id="addScheduleBtn" style="margin-top:1rem;">Add to schedule</button>
    </div>

    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem;">
        <h2 style="margin:0;">Master schedule</h2>
        <div class="tabs" style="margin-bottom:0;">
          <button id="viewListBtn" class="active">List</button>
          <button id="viewCalendarBtn">Calendar</button>
        </div>
      </div>

      <div id="scheduleListView" style="margin-top:1rem;">
        <table>
          <thead><tr><th>Days</th><th>Time</th><th>Type</th><th>Matches</th><th>Label</th><th></th></tr></thead>
          <tbody id="scheduleTableBody"></tbody>
        </table>
      </div>

      <div id="scheduleCalendarView" class="hidden" style="margin-top:1rem; overflow-x:auto;"></div>
    </div>
  `;

  const statusEl = container.querySelector("#scheduleStatus");
  const dayCheckboxes = container.querySelector("#dayCheckboxes");
  const startTimeInput = container.querySelector("#startTime");
  const endTimeInput = container.querySelector("#endTime");
  const typeSelect = container.querySelector("#scheduleType");
  const teamPickerWrap = container.querySelector("#teamPickerWrap");
  const teamSelect = container.querySelector("#scheduleTeam");
  const positionPickerWrap = container.querySelector("#positionPickerWrap");
  const positionSelect = container.querySelector("#schedulePosition");
  const labelInput = container.querySelector("#scheduleLabel");
  const tbody = container.querySelector("#scheduleTableBody");
  const listView = container.querySelector("#scheduleListView");
  const calendarView = container.querySelector("#scheduleCalendarView");
  const viewListBtn = container.querySelector("#viewListBtn");
  const viewCalendarBtn = container.querySelector("#viewCalendarBtn");

  for (let d = 0; d < 7; d++) {
    const wrap = document.createElement("label");
    wrap.style.cssText = "display:flex; align-items:center; gap:0.3rem; font-weight:500;";
    wrap.innerHTML = `<input type="checkbox" value="${d}" class="day-cb" /> ${DAY_NAMES[d]}`;
    dayCheckboxes.appendChild(wrap);
  }

  typeSelect.addEventListener("change", () => {
    const isTeam = typeSelect.value === "team";
    teamPickerWrap.classList.toggle("hidden", !isTeam);
    positionPickerWrap.classList.toggle("hidden", isTeam);
  });

  viewListBtn.addEventListener("click", () => {
    viewListBtn.classList.add("active");
    viewCalendarBtn.classList.remove("active");
    listView.classList.remove("hidden");
    calendarView.classList.add("hidden");
  });
  viewCalendarBtn.addEventListener("click", () => {
    viewCalendarBtn.classList.add("active");
    viewListBtn.classList.remove("active");
    calendarView.classList.remove("hidden");
    listView.classList.add("hidden");
  });

  container.addEventListener("schedule-changed", refreshAll);

  let teamNames = new Map();
  let latestEntries = [];

  async function loadTeams() {
    const snap = await getDocs(collection(db, "teams"));
    teamNames = new Map();
    snap.forEach((d) => teamNames.set(d.id, d.data().name));
    teamSelect.innerHTML = [...teamNames.entries()]
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
      .join("");
  }

  async function refreshAll() {
    const snap = await getDocs(collection(db, "schedule"));
    const entries = [];
    snap.forEach((d) => entries.push({ id: d.id, ...d.data() }));
    entries.sort((a, b) => (Math.min(...a.days) - Math.min(...b.days)) || a.startTime.localeCompare(b.startTime));
    latestEntries = entries;

    tbody.innerHTML = "";
    for (const e of entries) {
      const daysStr = e.days
        .slice()
        .sort((a, b) => a - b)
        .map((d) => DAY_NAMES[d])
        .join(", ");
      const matchStr = e.type === "team" ? teamNames.get(e.teamId) || e.teamId : e.position;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${daysStr}</td>
        <td>${formatTime(e.startTime)} – ${formatTime(e.endTime)}</td>
        <td>${e.type === "team" ? "Team Practice" : "Positional"}</td>
        <td>${matchStr}</td>
        <td>${e.label}</td>
        <td><button data-id="${e.id}" class="danger">Delete</button></td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this schedule entry?")) return;
        await deleteDoc(doc(db, "schedule", btn.dataset.id));
        refreshAll();
      });
    });

    renderCalendar(calendarView, latestEntries, teamNames);
  }

  container.querySelector("#addScheduleBtn").addEventListener("click", async () => {
    const days = [...dayCheckboxes.querySelectorAll(".day-cb:checked")].map((cb) => Number(cb.value));
    const startTime = startTimeInput.value;
    const endTime = endTimeInput.value;
    const type = typeSelect.value;

    if (days.length === 0) {
      statusEl.innerHTML = `<div class="status-banner error">Pick at least one day.</div>`;
      return;
    }
    if (!startTime || !endTime || startTime >= endTime) {
      statusEl.innerHTML = `<div class="status-banner error">Enter a valid start/end time (end must be after start).</div>`;
      return;
    }

    const entry = { days, startTime, endTime, type };
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

    await addDoc(collection(db, "schedule"), entry);
    statusEl.innerHTML = `<div class="status-banner ok">Added "${entry.label}".</div>`;
    labelInput.value = "";
    dayCheckboxes.querySelectorAll(".day-cb").forEach((cb) => (cb.checked = false));
    refreshAll();
  });

  (async () => {
    await loadTeams();
    await refreshAll();
  })();
}
