import { db, auth } from "./firebase.js";
import {
  collection,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getEntriesForDate, dateToKey, keyToDate } from "./schedule-matching.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatClock(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Manual attendance for when the scanner is down or a practice went
// unscanned. Writes the same attendance records a kiosk scan would (so the
// nightly emails, team sheets and calendar popup all pick them up), with the
// arrival time the director chooses, tagged manual: true.
export function initManualAttendanceTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Manual attendance</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Use this when the scanner was down or players weren't scanned. Pick the date and
        practice, tick who attended, set each arrival time, and save. Players who already
        checked in for that practice are shown and can't be added twice. To mark a date as
        <em>no practice at all</em>, cancel it on the Master Schedule tab instead.
      </p>
      <div id="maStatus"></div>
      <label for="maDate">Date</label>
      <input id="maDate" type="date" />
      <label for="maPractice" style="margin-top:0.75rem;">Practice</label>
      <select id="maPractice"></select>
      <div id="maTeamWrap" class="hidden">
        <label for="maTeam" style="margin-top:0.75rem;">Show players from team</label>
        <select id="maTeam"></select>
        <p style="color:var(--muted); font-size:0.85rem; margin:0.4rem 0 0 0;">
          Positional practices are open to any team — your ticks are kept when you switch teams.
        </p>
      </div>
    </div>

    <div class="card hidden" id="maListCard">
      <h2 style="margin-top:0;" id="maListTitle">Players</h2>
      <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
        <button id="maAllBtn" class="secondary">Mark everyone present</button>
        <button id="maNoneBtn" class="secondary">Clear all</button>
      </div>
      <table>
        <thead><tr><th>Present</th><th>Player</th><th>Arrival time</th><th></th></tr></thead>
        <tbody id="maBody"></tbody>
      </table>
      <p id="maSelectedCount" style="color:var(--muted); margin:0.75rem 0 0 0;"></p>
      <button id="maSaveBtn" style="margin-top:0.75rem;">Save attendance</button>
    </div>
  `;

  const $ = (sel) => container.querySelector(sel);
  const statusEl = $("#maStatus");
  const dateInput = $("#maDate");
  const practiceSelect = $("#maPractice");
  const teamWrap = $("#maTeamWrap");
  const teamSelect = $("#maTeam");
  const listCard = $("#maListCard");
  const bodyEl = $("#maBody");
  const saveBtn = $("#maSaveBtn");

  let teams = new Map(); // id -> team doc
  let players = []; // all active players
  let scheduleEntries = [];
  let cancellations = [];
  let todaysEntries = [];
  let current = null; // the schedule entry being edited
  let existing = new Map(); // playerId -> Date of earliest check-in already on file
  let selected = new Map(); // playerId -> { player, time: "HH:MM" }

  function showStatus(kind, message) {
    statusEl.innerHTML = `<div class="status-banner ${kind}">${escapeHtml(message)}</div>`;
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function loadBase() {
    const [teamsSnap, playersSnap, scheduleSnap, cancelSnap] = await Promise.all([
      getDocs(collection(db, "teams")),
      getDocs(collection(db, "players")),
      getDocs(collection(db, "schedule")),
      getDocs(collection(db, "scheduleCancellations")),
    ]);
    teams = new Map();
    teamsSnap.forEach((d) => teams.set(d.id, d.data()));
    players = [];
    playersSnap.forEach((d) => {
      if (d.data().active !== false) players.push({ id: d.id, ...d.data() });
    });
    players.sort((a, b) => a.name.localeCompare(b.name));
    scheduleEntries = [];
    scheduleSnap.forEach((d) => scheduleEntries.push({ id: d.id, ...d.data() }));
    cancellations = [];
    cancelSnap.forEach((d) => cancellations.push(d.data()));

    teamSelect.innerHTML = [...teams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, t]) => `<option value="${escapeHtml(id)}">${escapeHtml(t.name)} (${escapeHtml(id)})</option>`)
      .join("");
  }

  function entryLabel(e) {
    const who = e.type === "team" ? teams.get(e.teamId)?.name || e.teamId : e.position;
    return `${e.label} — ${who} (${e.startTime}–${e.endTime})`;
  }

  function refreshPractices() {
    const dateKey = dateInput.value;
    selected = new Map();
    existing = new Map();
    current = null;
    listCard.classList.add("hidden");
    teamWrap.classList.add("hidden");
    if (!dateKey) {
      practiceSelect.innerHTML = "";
      return;
    }
    todaysEntries = getEntriesForDate(keyToDate(dateKey), scheduleEntries, cancellations).sort((a, b) =>
      String(a.startTime).localeCompare(String(b.startTime))
    );
    if (todaysEntries.length === 0) {
      practiceSelect.innerHTML = `<option value="">Nothing scheduled on this date</option>`;
      showStatus(
        "info",
        "Nothing is scheduled for that date. If a practice was cancelled by mistake, restore it under \"Canceled occurrences\" on the Master Schedule tab; otherwise add the practice to the schedule first."
      );
      return;
    }
    statusEl.innerHTML = "";
    practiceSelect.innerHTML = todaysEntries
      .map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(entryLabel(e))}</option>`)
      .join("");
    onPracticeChange();
  }

  async function loadExisting() {
    existing = new Map();
    const snap = await getDocs(query(collection(db, "attendance"), where("sessionId", "==", current.id)));
    snap.forEach((d) => {
      const r = d.data();
      if (!r.timestamp) return;
      const time = r.timestamp.toDate();
      if (dateToKey(time) !== dateInput.value) return;
      const prev = existing.get(r.playerId);
      if (!prev || time < prev) existing.set(r.playerId, time);
    });
  }

  async function onPracticeChange() {
    current = todaysEntries.find((e) => e.id === practiceSelect.value) || null;
    selected = new Map();
    if (!current) {
      listCard.classList.add("hidden");
      return;
    }
    const isTeam = current.type === "team";
    teamWrap.classList.toggle("hidden", isTeam);
    if (isTeam) teamSelect.value = current.teamId;

    try {
      await loadExisting();
    } catch (err) {
      showStatus("error", `Couldn't load existing check-ins: ${err.message}`);
      return;
    }
    renderList();
  }

  function visiblePlayers() {
    const teamId = current.type === "team" ? current.teamId : teamSelect.value;
    return players.filter((p) => p.teamId === teamId);
  }

  function renderList() {
    if (!current) return;
    const list = visiblePlayers();
    const teamName = teams.get(current.type === "team" ? current.teamId : teamSelect.value)?.name || "";
    $("#maListTitle").textContent = `${current.label} — ${teamName}`;
    listCard.classList.remove("hidden");

    bodyEl.innerHTML = list.length
      ? list
          .map((p) => {
            const already = existing.get(p.id);
            const sel = selected.get(p.id);
            return `<tr>
              <td><input type="checkbox" data-id="${p.id}" ${sel ? "checked" : ""} ${already ? "disabled" : ""} /></td>
              <td>${escapeHtml(p.name)}</td>
              <td>${already ? "" : `<input type="time" class="ma-time" data-id="${p.id}" value="${sel ? sel.time : current.startTime}" ${sel ? "" : "disabled"} style="width:auto;" />`}</td>
              <td>${already ? `<span style="color:var(--teal-dark);">Already checked in at ${formatClock(already)}</span>` : ""}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="4" style="color:var(--muted);">No players on this team.</td></tr>`;

    bodyEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const player = players.find((p) => p.id === cb.dataset.id);
        const timeInput = bodyEl.querySelector(`.ma-time[data-id="${cb.dataset.id}"]`);
        if (cb.checked) {
          selected.set(player.id, { player, time: timeInput.value || current.startTime });
          timeInput.disabled = false;
        } else {
          selected.delete(player.id);
          timeInput.disabled = true;
        }
        updateCount();
      });
    });
    bodyEl.querySelectorAll(".ma-time").forEach((ti) => {
      ti.addEventListener("input", () => {
        const entry = selected.get(ti.dataset.id);
        if (entry) entry.time = ti.value;
      });
    });
    updateCount();
  }

  function updateCount() {
    const n = selected.size;
    $("#maSelectedCount").textContent = n ? `${n} player${n === 1 ? "" : "s"} selected.` : "No players selected yet.";
    saveBtn.disabled = n === 0;
  }

  $("#maAllBtn").addEventListener("click", () => {
    for (const p of visiblePlayers()) {
      if (!existing.has(p.id) && !selected.has(p.id)) selected.set(p.id, { player: p, time: current.startTime });
    }
    renderList();
  });
  $("#maNoneBtn").addEventListener("click", () => {
    selected = new Map();
    renderList();
  });

  dateInput.addEventListener("change", refreshPractices);
  practiceSelect.addEventListener("change", onPracticeChange);
  teamSelect.addEventListener("change", renderList);

  saveBtn.addEventListener("click", async () => {
    if (!current || selected.size === 0) return;
    const badTime = [...selected.values()].find((s) => !/^\d{2}:\d{2}$/.test(s.time));
    if (badTime) {
      showStatus("error", `Set an arrival time for ${badTime.player.name}.`);
      return;
    }

    saveBtn.disabled = true;
    try {
      // Re-check just before writing so a scan that landed in the meantime
      // isn't duplicated.
      await loadExisting();
      const toWrite = [...selected.values()].filter((s) => !existing.has(s.player.id));
      const skipped = selected.size - toWrite.length;

      const enteredBy = auth.currentUser?.email || "";
      let batch = writeBatch(db);
      let ops = 0;
      for (const { player, time } of toWrite) {
        batch.set(doc(collection(db, "attendance")), {
          playerId: player.id,
          playerName: player.name,
          teamId: player.teamId,
          sessionId: current.id,
          sessionLabel: current.label,
          timestamp: new Date(`${dateInput.value}T${time}:00`),
          manual: true,
          enteredBy,
        });
        if (++ops === 400) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();

      selected = new Map();
      await loadExisting();
      renderList();
      showStatus(
        "ok",
        `Saved ${toWrite.length} check-in${toWrite.length === 1 ? "" : "s"} for ${current.label} on ${dateInput.value}.` +
          (skipped ? ` ${skipped} already had a check-in and ${skipped === 1 ? "was" : "were"} skipped.` : "") +
          " The team sheet and reports will include them the next time they run."
      );
    } catch (err) {
      const hint =
        err.code === "permission-denied"
          ? " The database rules may not allow manual entries yet — publish the latest firestore.rules in the Firebase console — or you may have been signed out."
          : "";
      showStatus("error", `Couldn't save: ${String(err.message).replace(/\.$/, "")}.${hint}`);
    } finally {
      saveBtn.disabled = selected.size === 0;
    }
  });

  // Default to today; future dates can't have attendance yet.
  const today = dateToKey(new Date());
  dateInput.value = today;
  dateInput.max = today;

  loadBase()
    .then(refreshPractices)
    .catch((err) => showStatus("error", `Couldn't load schedule data: ${err.message}`));
}
