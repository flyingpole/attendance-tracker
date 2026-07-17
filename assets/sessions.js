import { db } from "./firebase.js";
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function initSessionsTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Add a practice / session type</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        These show up in the dropdown on the scan-in kiosk. Keep only the ones happening
        today (or right now) marked <strong>active</strong> so the kiosk list stays short.
      </p>
      <div id="sessionStatus"></div>
      <label for="sessionLabel">Label (e.g. "U14 Team Practice", "Setting Clinic — Coach Mike")</label>
      <input id="sessionLabel" type="text" />
      <button id="addSessionBtn" style="margin-top:1rem;">Add session</button>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">All sessions</h2>
      <table>
        <thead><tr><th>Label</th><th>Active on kiosk?</th><th></th></tr></thead>
        <tbody id="sessionsTableBody"></tbody>
      </table>
    </div>
  `;

  const labelInput = container.querySelector("#sessionLabel");
  const statusEl = container.querySelector("#sessionStatus");
  const tbody = container.querySelector("#sessionsTableBody");

  async function refresh() {
    const snap = await getDocs(collection(db, "sessions"));
    const sessions = [];
    snap.forEach((d) => sessions.push({ id: d.id, ...d.data() }));
    sessions.sort((a, b) => a.label.localeCompare(b.label));

    tbody.innerHTML = "";
    for (const s of sessions) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${s.label}</td>
        <td><input type="checkbox" data-id="${s.id}" ${s.active ? "checked" : ""} /></td>
        <td><button data-id="${s.id}" data-action="delete" class="danger">Delete</button></td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", async () => {
        await updateDoc(doc(db, "sessions", cb.dataset.id), { active: cb.checked });
      });
    });

    tbody.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this session type?")) return;
        await deleteDoc(doc(db, "sessions", btn.dataset.id));
        refresh();
      });
    });
  }

  container.querySelector("#addSessionBtn").addEventListener("click", async () => {
    const label = labelInput.value.trim();
    if (!label) {
      statusEl.innerHTML = `<div class="status-banner error">Enter a label first.</div>`;
      return;
    }
    await addDoc(collection(db, "sessions"), { label, active: true, createdAt: Date.now() });
    labelInput.value = "";
    statusEl.innerHTML = `<div class="status-banner ok">Added "${label}".</div>`;
    refresh();
  });

  refresh();
}
