import { db } from "./firebase.js";
import {
  collection,
  getDocs,
  doc,
  writeBatch,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { POSITIONS } from "./positions.js";
import { classifyRows, describeNothingToImport, rosterKey } from "./roster-parse.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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

// The single placeholder row uses a real team code from the database so the
// file passes through the importer end to end, but it's flagged EXAMPLE and
// never actually imported.
function downloadTemplate(sampleTeamCode) {
  const csv = `Name,TeamID,Email,Jersey,Position\nEXAMPLE - delete this row,${sampleTeamCode},jane@example.com,7,${POSITIONS[0]}\n`;
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
        Columns: <strong>Name</strong> and <strong>TeamID</strong> (a team code from the list below —
        capitalization doesn't matter, and the team's full name works too), plus optional
        <strong>Email</strong>, <strong>Jersey</strong>, and <strong>Position</strong>
        (one of: ${POSITIONS.join(", ")}). Header names are flexible — "Team ID", "Team" and
        "Player Name" all work. Players already on the roster (same name + team) are skipped,
        and the template's EXAMPLE row is never imported.
      </p>
      <p style="margin-bottom:0.25rem;"><strong>Team codes in use:</strong></p>
      <div id="teamCodesReference" style="margin-bottom:1rem; color:var(--muted); font-size:0.9rem;"></div>
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
  const teamCodesReference = container.querySelector("#teamCodesReference");

  let sampleTeamCode = "TEAMCODE";
  container.querySelector("#templateBtn").addEventListener("click", () => downloadTemplate(sampleTeamCode));

  let parsedRows = [];

  async function refreshRosterTable() {
    const [playersSnap, teamsSnap] = await Promise.all([
      getDocs(collection(db, "players")),
      getDocs(collection(db, "teams")),
    ]);
    const teamNames = new Map();
    teamsSnap.forEach((d) => teamNames.set(d.id, d.data().name));
    if (teamNames.size) sampleTeamCode = [...teamNames.keys()].sort()[0];

    teamCodesReference.innerHTML = teamNames.size
      ? [...teamNames.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([code, name]) => `<code>${code}</code> — ${name}`)
          .join("<br>")
      : `No teams yet — add one on the Teams tab first.`;

    const players = [];
    playersSnap.forEach((d) => players.push({ id: d.id, ...d.data() }));
    players.sort((a, b) => a.name.localeCompare(b.name));

    rosterBody.innerHTML = "";
    for (const p of players) {
      const tr = document.createElement("tr");
      const positionOptions = [`<option value="">-- none --</option>`]
        .concat(POSITIONS.map((pos) => `<option value="${pos}" ${p.position === pos ? "selected" : ""}>${pos}</option>`))
        .join("");
      const teamLabel = teamNames.has(p.teamId) ? `${teamNames.get(p.teamId)} (${p.teamId})` : p.teamId;
      tr.innerHTML = `
        <td>${p.name}</td>
        <td>${teamLabel}</td>
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

  const csvInput = container.querySelector("#csvFile");
  const importBtn = container.querySelector("#importBtn");

  function showError(message) {
    statusEl.innerHTML = `<div class="status-banner error">${escapeHtml(message)}</div>`;
  }

  csvInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Clear the input right away: browsers ignore picking the *same* file
    // again, so without this a corrected file with the same name never loads.
    csvInput.value = "";
    parsedRows = [];
    previewWrap.classList.add("hidden");
    statusEl.innerHTML = `<div class="status-banner info">Reading ${escapeHtml(file.name)}…</div>`;

    let teams;
    let existingKeys;
    try {
      const [teamsSnap, playersSnap] = await Promise.all([
        getDocs(collection(db, "teams")),
        getDocs(collection(db, "players")),
      ]);
      teams = new Map();
      teamsSnap.forEach((d) => teams.set(d.id, d.data()));
      existingKeys = new Set();
      playersSnap.forEach((d) => existingKeys.add(rosterKey(d.data().teamId, d.data().name)));
    } catch (err) {
      showError(`Couldn't reach the database: ${err.message}`);
      return;
    }

    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      error: (err) => showError(`Couldn't read that file: ${err.message}`),
      complete: (results) => {
        parsedRows = classifyRows(results.data, teams, existingKeys);
        const importable = parsedRows.filter((r) => r.willImport).length;

        previewBody.innerHTML = "";
        for (const r of parsedRows) {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.teamId || r.teamRaw)}</td><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.jersey)}</td><td>${escapeHtml(r.position)}</td><td>${escapeHtml(r.status)}</td>`;
          previewBody.appendChild(tr);
        }
        previewWrap.classList.toggle("hidden", parsedRows.length === 0);
        importBtn.disabled = importable === 0;

        if (importable === 0) {
          let message = describeNothingToImport(parsedRows);
          if (parsedRows.length > 0 && parsedRows.every((r) => r.reason === "missing")) {
            message += ` Columns found in your file: ${(results.meta.fields || []).join(", ") || "(none)"} — it needs a Name column and a TeamID (or Team) column.`;
          }
          showError(message);
        } else {
          const skipped = parsedRows.length - importable;
          statusEl.innerHTML = `<div class="status-banner info">${importable} of ${parsedRows.length} row(s) ready to import${skipped ? ` (${skipped} skipped — see Status below)` : ""}. Review, then click Import.</div>`;
        }
      },
    });
  });

  importBtn.addEventListener("click", async () => {
    const toImport = parsedRows.filter((r) => r.willImport);
    if (toImport.length === 0) {
      showError(describeNothingToImport(parsedRows));
      return;
    }

    importBtn.disabled = true;
    try {
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
      refreshRosterTable();
    } catch (err) {
      const hint = err.code === "permission-denied" ? " You may have been signed out — reload this page and log in again." : "";
      showError(`Import failed: ${String(err.message).replace(/\.$/, "")}.${hint}`);
    } finally {
      importBtn.disabled = false;
    }
  });

  refreshRosterTable();
}
