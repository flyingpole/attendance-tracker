import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  writeBatch,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { POSITIONS } from "./positions.js";

function normalizePosition(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const match = POSITIONS.find((p) => p.toLowerCase() === trimmed.toLowerCase());
  return match || "";
}

function genBadgeCode(existingCodes) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1 (avoids misreads)
  let code;
  do {
    let rand = "";
    for (let i = 0; i < 6; i++) rand += chars[Math.floor(Math.random() * chars.length)];
    code = `FC-${rand}`;
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function downloadTemplate() {
  const csv = `Name,TeamID,Email,Jersey,Position\nJane Smith,U14A,jane@example.com,7,${POSITIONS[0]}\n`;
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "roster-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function initRosterTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Import roster CSV</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Columns: <strong>Name</strong>, <strong>TeamID</strong> (must match an existing team code),
        optional <strong>Email</strong>, <strong>Jersey</strong>, and <strong>Position</strong>
        (one of: ${POSITIONS.join(", ")} — used to auto-assign positional practices on the kiosk).
        Existing players (matched by name + team) are skipped, not duplicated.
      </p>
      <button id="templateBtn" class="secondary">Download CSV template</button>
      <label for="csvFile" style="margin-top:1rem;">Roster CSV file</label>
      <input id="csvFile" type="file" accept=".csv" />
      <div id="rosterStatus" style="margin-top:1rem;"></div>
      <div id="previewWrap" class="hidden">
        <table>
          <thead><tr><th>Name</th><th>Team</th><th>Email</th><th>Jersey</th><th>Position</th><th>Status</th></tr></thead>
          <tbody id="previewBody"></tbody>
        </table>
        <button id="importBtn" style="margin-top:1rem;">Import these players</button>
      </div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Current roster</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Set or fix a player's position here any time — it's used to auto-detect which
        positional practice they're attending on the kiosk.
      </p>
      <table>
        <thead><tr><th>Name</th><th>Team</th><th>Badge code</th><th>Email</th><th>Position</th></tr></thead>
        <tbody id="rosterTableBody"></tbody>
      </table>
    </div>
  `;

  const statusEl = container.querySelector("#rosterStatus");
  const previewWrap = container.querySelector("#previewWrap");
  const previewBody = container.querySelector("#previewBody");
  const rosterBody = container.querySelector("#rosterTableBody");

  container.querySelector("#templateBtn").addEventListener("click", downloadTemplate);

  let parsedRows = [];

  async function refreshRosterTable() {
    const [playersSnap, teamsSnap] = await Promise.all([
      getDocs(collection(db, "players")),
      getDocs(collection(db, "teams")),
    ]);
    const teamNames = new Map();
    teamsSnap.forEach((d) => teamNames.set(d.id, d.data().name));

    const players = [];
    playersSnap.forEach((d) => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => a.name.localeCompare(b.name));

    rosterBody.innerHTML = "";
    for (const p of players) {
      const tr = document.createElement("tr");
      const positionOptions = [`<option value="">-- none --</option>`]
        .concat(POSITIONS.map((pos) => `<option value="${pos}" ${p.position === pos ? "selected" : ""}>${pos}</option>`))
        .join("");
      tr.innerHTML = `
        <td>${p.name}</td>
        <td>${teamNames.get(p.teamId) || p.teamId}</td>
        <td><code>${p.badgeCode}</code></td>
        <td>${p.email || ""}</td>
        <td><select data-id="${p.id}" class="position-select">${positionOptions}</select></td>
      `;
      rosterBody.appendChild(tr);
    }

    rosterBody.querySelectorAll(".position-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        await updateDoc(doc(db, "players", sel.dataset.id), { position: sel.value });
      });
    });
  }

  container.querySelector("#csvFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const [teamsSnap, playersSnap] = await Promise.all([
      getDocs(collection(db, "teams")),
      getDocs(collection(db, "players")),
    ]);
    const validTeamIds = new Set();
    teamsSnap.forEach((d) => validTeamIds.add(d.id));
    const existingKey = new Set();
    playersSnap.forEach((d) => {
      const p = d.data();
      existingKey.add(`${p.teamId}::${p.name.trim().toLowerCase()}`);
    });

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        parsedRows = results.data.map((row) => {
          const name = (row.Name || "").trim();
          const teamId = (row.TeamID || "").trim();
          const email = (row.Email || "").trim();
          const jersey = (row.Jersey || "").trim();
          const position = normalizePosition(row.Position);
          const positionNote = row.Position && !position ? ` (unrecognized: "${row.Position}")` : "";

          let status = "Will import";
          let willImport = true;
          if (!name || !teamId) {
            status = "Skipped — missing Name/TeamID";
            willImport = false;
          } else if (!validTeamIds.has(teamId)) {
            status = `Skipped — unknown team "${teamId}"`;
            willImport = false;
          } else if (existingKey.has(`${teamId}::${name.toLowerCase()}`)) {
            status = "Skipped — already on roster";
            willImport = false;
          } else {
            status += positionNote;
          }

          return { name, teamId, email, jersey, position, status, willImport };
        });

        previewBody.innerHTML = "";
        for (const r of parsedRows) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${r.name}</td><td>${r.teamId}</td><td>${r.email}</td><td>${r.jersey}</td><td>${r.position}</td><td>${r.status}</td>`;
          previewBody.appendChild(tr);
        }
        previewWrap.classList.remove("hidden");
        statusEl.innerHTML = `<div class="status-banner info">Parsed ${parsedRows.length} rows. Review below, then import.</div>`;
      },
    });
  });

  container.querySelector("#importBtn").addEventListener("click", async () => {
    const toImport = parsedRows.filter((r) => r.willImport);
    if (toImport.length === 0) {
      statusEl.innerHTML = `<div class="status-banner error">Nothing new to import.</div>`;
      return;
    }

    const playersSnap = await getDocs(collection(db, "players"));
    const existingCodes = new Set();
    playersSnap.forEach((d) => existingCodes.add(d.data().badgeCode));

    let batch = writeBatch(db);
    let opCount = 0;
    for (const row of toImport) {
      const ref = doc(collection(db, "players"));
      batch.set(ref, {
        name: row.name,
        teamId: row.teamId,
        email: row.email || "",
        jersey: row.jersey || "",
        position: row.position || "",
        badgeCode: genBadgeCode(existingCodes),
        active: true,
      });
      opCount++;
      if (opCount === 400) {
        await batch.commit();
        batch = writeBatch(db);
        opCount = 0;
      }
    }
    if (opCount > 0) await batch.commit();

    statusEl.innerHTML = `<div class="status-banner ok">Imported ${toImport.length} players.</div>`;
    previewWrap.classList.add("hidden");
    parsedRows = [];
    container.querySelector("#csvFile").value = "";
    refreshRosterTable();
  });

  refreshRosterTable();
}
