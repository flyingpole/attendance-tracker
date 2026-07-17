import { db } from "./firebase.js";
import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  query,
  where,
  limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
        <thead><tr><th></th><th>Code</th><th>Name</th><th>Coach</th><th>Coach email</th><th></th></tr></thead>
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
    td.colSpan = 6;
    td.innerHTML = `<div style="padding:0.5rem 0.25rem; color:var(--muted);">Loading roster…</div>`;
    detailTr.appendChild(td);
    tr.after(detailTr);

    const playersSnap = await getDocs(query(collection(db, "players"), where("teamId", "==", team.id)));
    const players = [];
    playersSnap.forEach((d) => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => a.name.localeCompare(b.name));

    const coachLine =
      team.coachName || team.coachEmail
        ? `<strong>Coach:</strong> ${team.coachName || "(no name)"}${team.coachEmail ? ` — ${team.coachEmail}` : ""}`
        : `<em>No coach assigned yet.</em>`;

    const rosterRows = players.length
      ? players
          .map(
            (p) =>
              `<tr><td>${p.name}</td><td>${p.position || ""}</td><td><code>${p.badgeCode}</code></td><td>${p.jersey || ""}</td><td>${p.email || ""}</td></tr>`
          )
          .join("")
      : `<tr><td colspan="5" style="color:var(--muted);">No players imported for this team yet.</td></tr>`;

    td.innerHTML = `
      <div style="padding:0.75rem 0.25rem;">
        <div style="margin-bottom:0.6rem;">${coachLine}</div>
        <table>
          <thead><tr><th>Player</th><th>Position</th><th>Badge code</th><th>Jersey</th><th>Email</th></tr></thead>
          <tbody>${rosterRows}</tbody>
        </table>
      </div>
    `;
  }

  async function refreshTable() {
    const snap = await getDocs(collection(db, "teams"));
    const teams = [];
    snap.forEach((d) => teams.push({ id: d.id, ...d.data() }));
    teams.sort((a, b) => a.id.localeCompare(b.id));

    tbody.innerHTML = "";
    for (const t of teams) {
      const tr = document.createElement("tr");
      tr.className = "team-row";
      tr.innerHTML = `
        <td class="expand-arrow">▸</td>
        <td>${t.id}</td>
        <td>${t.name || ""}</td>
        <td>${t.coachName || ""}</td>
        <td>${t.coachEmail || ""}</td>
        <td>
          <button data-action="edit" data-id="${t.id}" class="secondary">Edit</button>
          <button data-action="delete" data-id="${t.id}" class="danger">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);

      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        toggleRoster(tr, t);
      });
    }

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
        const playersSnap = await getDocs(
          query(collection(db, "players"), where("teamId", "==", teamId), limit(1))
        );
        if (!playersSnap.empty) {
          statusEl.innerHTML = `<div class="status-banner error">Can't delete "${teamId}" — it still has players on the roster.</div>`;
          return;
        }
        if (!confirm(`Delete team "${teamId}"? This cannot be undone.`)) return;
        await deleteDoc(doc(db, "teams", teamId));
        refreshTable();
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
