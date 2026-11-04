import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  updateDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Firestore batches hold at most 500 writes.
async function deleteRefs(db, refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = writeBatch(db);
    refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

export function initTeamsTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Add / edit a team</h2>
      <div id="teamStatus"></div>
      <label for="teamId">Team code (short, unique — e.g. U14A)</label>
      <input id="teamId" type="text" />
      <label for="teamName" style="margin-top:0.75rem;">Team name</label>
      <input id="teamName" type="text" />
      <label for="coachName" style="margin-top:0.75rem;">Coach name</label>
      <input id="coachName" type="text" />
      <label for="coachEmail" style="margin-top:0.75rem;">Coach email (for daily reports)</label>
      <input id="coachEmail" type="email" />
      <div style="margin-top:1rem; display:flex; gap:0.5rem;">
        <button id="saveTeamBtn">Save team</button>
        <button id="clearTeamBtn" class="secondary">Clear</button>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Teams</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">Click a team to see its roster and coach.</p>
      <table>
        <thead><tr><th></th><th>Code</th><th>Name</th><th>Coach</th><th>Coach email</th><th>Attendance sheet</th><th></th></tr></thead>
        <tbody id="teamsTableBody"></tbody>
      </table>
    </div>
  `;

  const teamIdInput = container.querySelector("#teamId");
  const teamNameInput = container.querySelector("#teamName");
  const coachNameInput = container.querySelector("#coachName");
  const coachEmailInput = container.querySelector("#coachEmail");
  const statusEl = container.querySelector("#teamStatus");
  const tbody = container.querySelector("#teamsTableBody");

  let editingExisting = false;
  let allTeams = [];

  function showStatus(kind, message) {
    statusEl.innerHTML = `<div class="status-banner ${kind}">${escapeHtml(message)}</div>`;
    // The banner is in the form card, above a long team list — make sure it's seen.
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function clearForm() {
    teamIdInput.value = "";
    teamNameInput.value = "";
    coachNameInput.value = "";
    coachEmailInput.value = "";
    teamIdInput.disabled = false;
    editingExisting = false;
  }

  async function toggleRoster(tr, team) {
    const existing = tr.nextElementSibling;
    if (existing && existing.classList.contains("roster-detail")) {
      existing.remove();
      tr.querySelector(".expand-arrow").textContent = "▸";
      return;
    }

    // Only one roster expanded at a time.
    tbody.querySelectorAll(".roster-detail").forEach((el) => el.remove());
    tbody.querySelectorAll(".expand-arrow").forEach((el) => (el.textContent = "▸"));
    tr.querySelector(".expand-arrow").textContent = "▾";

    const detailTr = document.createElement("tr");
    detailTr.className = "roster-detail";
    const td = document.createElement("td");
    td.colSpan = 7;
    td.innerHTML = `<div style="padding:0.5rem 0.25rem; color:var(--muted);">Loading roster…</div>`;
    detailTr.appendChild(td);
    tr.after(detailTr);

    await loadRoster(td, team);
  }

  async function loadRoster(td, team) {
    const playersSnap = await getDocs(query(collection(db, "players"), where("teamId", "==", team.id)));
    const players = [];
    playersSnap.forEach((d) => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => a.name.localeCompare(b.name));

    const coachLine =
      team.coachName || team.coachEmail
        ? `<strong>Coach:</strong> ${escapeHtml(team.coachName) || "(no name)"}${team.coachEmail ? ` — ${escapeHtml(team.coachEmail)}` : ""}`
        : `<em>No coach assigned yet.</em>`;

    const moveOptions = [`<option value="">Move to…</option>`]
      .concat(
        allTeams
          .filter((t) => t.id !== team.id)
          .map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.id)} — ${escapeHtml(t.name)}</option>`)
      )
      .join("");

    const rosterRows = players.length
      ? players
          .map(
            (p) =>
              `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.position)}</td><td><code>${escapeHtml(p.badgeCode)}</code></td><td>${escapeHtml(p.jersey)}</td><td>${escapeHtml(p.email)}</td><td><select class="move-select" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${moveOptions}</select></td></tr>`
          )
          .join("")
      : `<tr><td colspan="6" style="color:var(--muted);">No players imported for this team yet.</td></tr>`;

    td.innerHTML = `
      <div style="padding:0.75rem 0.25rem;">
        <div style="margin-bottom:0.6rem;">${coachLine}</div>
        <table>
          <thead><tr><th>Player</th><th>Position</th><th>Badge code</th><th>Jersey</th><th>Email</th><th>Reassign</th></tr></thead>
          <tbody>${rosterRows}</tbody>
        </table>
      </div>
    `;

    td.querySelectorAll(".move-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        const targetId = sel.value;
        if (!targetId) return;
        const target = allTeams.find((t) => t.id === targetId);
        const targetLabel = target ? `${target.id} — ${target.name}` : targetId;
        if (!confirm(`Move ${sel.dataset.name} to ${targetLabel}?`)) {
          sel.value = "";
          return;
        }
        try {
          await updateDoc(doc(db, "players", sel.dataset.id), { teamId: targetId });
          showStatus("ok", `Moved ${sel.dataset.name} to ${targetLabel}. Their badge code is unchanged; reprint their tag if you want it to show the new team.`);
          await loadRoster(td, team);
        } catch (err) {
          sel.value = "";
          showStatus("error", `Couldn't move ${sel.dataset.name}: ${err.message}`);
        }
      });
    });
  }

  async function refreshTable() {
    const snap = await getDocs(collection(db, "teams"));
    const teams = [];
    snap.forEach((d) => teams.push({ id: d.id, ...d.data() }));
    teams.sort((a, b) => a.id.localeCompare(b.id));
    allTeams = teams;

    // Sheet links are written by the Team Attendance Sheets workflow. If the
    // rules that allow reading them aren't published yet, just show no links.
    const sheetUrls = new Map();
    try {
      const sheetsSnap = await getDocs(collection(db, "reportSheets"));
      sheetsSnap.forEach((d) => {
        const id = d.data().spreadsheetId;
        if (id) sheetUrls.set(d.id, `https://docs.google.com/spreadsheets/d/${id}/edit`);
      });
    } catch (err) {
      console.warn("Couldn't load attendance sheet links:", err.message);
    }

    tbody.innerHTML = "";
    for (const t of teams) {
      const tr = document.createElement("tr");
      tr.className = "team-row";
      const sheetUrl = sheetUrls.get(t.id);
      const sheetCell = sheetUrl
        ? `<a href="${escapeHtml(sheetUrl)}" target="_blank" rel="noopener">Open sheet</a>
           <div style="margin-top:0.35rem; display:flex; gap:0.35rem; flex-wrap:wrap;">
             <button data-action="copy-sheet" data-url="${escapeHtml(sheetUrl)}" class="secondary">Copy link</button>
             <button data-action="email-sheet" data-id="${escapeHtml(t.id)}" data-url="${escapeHtml(sheetUrl)}" class="secondary" ${t.coachEmail ? "" : 'disabled title="No coach email on file"'}>Email to coach</button>
           </div>`
        : `<span style="color:var(--muted);">Not created yet</span>`;
      tr.innerHTML = `
        <td class="expand-arrow">▸</td>
        <td>${escapeHtml(t.id)}</td>
        <td>${escapeHtml(t.name)}</td>
        <td>${escapeHtml(t.coachName)}</td>
        <td>${escapeHtml(t.coachEmail)}</td>
        <td>${sheetCell}</td>
        <td>
          <button data-action="edit" data-id="${t.id}" class="secondary">Edit</button>
          <button data-action="delete" data-id="${t.id}" class="danger">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);

      tr.addEventListener("click", (e) => {
        if (e.target.closest("button, a")) return;
        toggleRoster(tr, t);
      });
    }

    tbody.querySelectorAll('button[data-action="copy-sheet"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.url);
          btn.textContent = "Copied!";
        } catch {
          window.prompt("Copy this link:", btn.dataset.url);
          return;
        }
        setTimeout(() => (btn.textContent = "Copy link"), 1500);
      });
    });

    // Opens a ready-to-send Gmail draft addressed to the coach; the director
    // reviews it and clicks Send, so it goes out from their own account.
    tbody.querySelectorAll('button[data-action="email-sheet"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = teams.find((x) => x.id === btn.dataset.id);
        const subject = `${t.name} attendance sheet`;
        const greeting = t.coachName ? `Hi ${t.coachName.split(" ")[0]},` : "Hi,";
        const body =
          `${greeting}\n\nHere is the attendance sheet for ${t.name}:\n${btn.dataset.url}\n\n` +
          `It shows each player's attendance at team practices, with total days, days missed and miss % at the top. ` +
          `It updates automatically each morning. It's view-only; open it while signed in to ${t.coachEmail}.`;
        const url =
          "https://mail.google.com/mail/?view=cm&fs=1" +
          `&to=${encodeURIComponent(t.coachEmail)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        window.open(url, "_blank", "noopener");
      });
    });

    tbody.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
      btn.addEventListener("click", () => {
        const t = teams.find((x) => x.id === btn.dataset.id);
        teamIdInput.value = t.id;
        teamIdInput.disabled = true;
        teamNameInput.value = t.name || "";
        coachNameInput.value = t.coachName || "";
        coachEmailInput.value = t.coachEmail || "";
        editingExisting = true;
        statusEl.innerHTML = "";
      });
    });

    tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        const teamId = btn.dataset.id;
        try {
          const [playersSnap, scheduleSnap] = await Promise.all([
            getDocs(query(collection(db, "players"), where("teamId", "==", teamId))),
            getDocs(query(collection(db, "schedule"), where("teamId", "==", teamId))),
          ]);
          const playerCount = playersSnap.size;
          const scheduleCount = scheduleSnap.size;

          const lines = [`Delete team "${teamId}"?`];
          if (playerCount || scheduleCount) lines.push("");
          if (playerCount) lines.push(`• ${playerCount} player(s) on its roster will be removed (move them to another team first if you want to keep them).`);
          if (scheduleCount) lines.push(`• ${scheduleCount} master-schedule entr${scheduleCount === 1 ? "y" : "ies"} for this team will be removed.`);
          if (playerCount || scheduleCount) lines.push("• Past attendance records are kept.");
          lines.push("", "This cannot be undone.");
          if (!confirm(lines.join("\n"))) return;

          const refs = [];
          playersSnap.forEach((d) => refs.push(d.ref));
          for (const entry of scheduleSnap.docs) {
            const cancelSnap = await getDocs(query(collection(db, "scheduleCancellations"), where("scheduleId", "==", entry.id)));
            cancelSnap.forEach((d) => refs.push(d.ref));
            refs.push(entry.ref);
          }
          refs.push(doc(db, "teams", teamId));
          await deleteRefs(db, refs);

          showStatus("ok", `Deleted team "${teamId}"${playerCount ? ` and its ${playerCount} player(s)` : ""}.`);
          refreshTable();
        } catch (err) {
          const hint = err.code === "permission-denied" ? " You may have been signed out — reload this page and log in again." : "";
          showStatus("error", `Couldn't delete "${teamId}": ${String(err.message).replace(/\.$/, "")}.${hint}`);
        }
      });
    });
  }

  container.querySelector("#saveTeamBtn").addEventListener("click", async () => {
    const teamId = teamIdInput.value.trim();
    const name = teamNameInput.value.trim();
    const coachName = coachNameInput.value.trim();
    const coachEmail = coachEmailInput.value.trim();

    if (!teamId || !name) {
      statusEl.innerHTML = `<div class="status-banner error">Team code and name are required.</div>`;
      return;
    }

    await setDoc(doc(db, "teams", teamId), { name, coachName, coachEmail }, { merge: true });
    statusEl.innerHTML = `<div class="status-banner ok">Saved "${teamId}".</div>`;
    clearForm();
    refreshTable();
  });

  container.querySelector("#clearTeamBtn").addEventListener("click", clearForm);

  refreshTable();
}
