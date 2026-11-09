import { db, auth } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const REPO = "flyingpole/attendance-tracker";
const JOBS = {
  email: { file: "daily-report.yml", title: "Daily email report" },
  sheets: { file: "team-sheets.yml", title: "Team sheets & director summary" },
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The scheduled jobs run at 2 AM Eastern. On the two nights a year when the
// clocks change, one of the two daily triggers does nothing and finishes in
// seconds; label those so they don't look like real runs.
function describeRun(run) {
  const seconds = (new Date(run.updated_at) - new Date(run.run_started_at || run.created_at)) / 1000;
  if (run.status !== "completed") return { text: run.status === "queued" ? "Queued" : "Running…", cls: "info" };
  if (run.conclusion === "success") {
    if (run.event === "schedule" && seconds < 25) return { text: "Skipped (duplicate trigger)", cls: "muted" };
    return { text: "Succeeded", cls: "ok" };
  }
  if (run.conclusion === "cancelled") return { text: "Cancelled", cls: "muted" };
  return { text: "Failed", cls: "error" };
}

// Buttons here start the GitHub workflows through the Apps Script helper (the
// site can't hold a GitHub key itself). The helper checks the caller's Firebase
// login before starting anything.
export function initReportsTab(container) {
  const generation = (container.__reportsGeneration = (container.__reportsGeneration || 0) + 1);
  const stale = () => container.__reportsGeneration !== generation;

  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Run reports now</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Both jobs already run by themselves every night at 2:00 AM Eastern. Use these buttons
        to re-run one — for example after fixing a schedule or a roster, or if a night's run failed.
      </p>
      <div id="nightlyStatus" style="margin-bottom:1rem;"></div>
      <div id="reportsStatus"></div>

      <h3 style="margin-bottom:0.25rem;">Daily email report</h3>
      <p style="color:var(--muted); margin-top:0;">
        Emails yesterday's attendance to the director and to each coach whose team had check-ins.
      </p>
      <button id="runEmailBtn">Send email report now</button>

      <h3 style="margin:1.5rem 0 0.25rem 0;">Attendance sheets</h3>
      <p style="color:var(--muted); margin-top:0;">
        Rebuilds the Google Sheets from the latest scans, schedule and rosters. Takes a few minutes for all teams.
      </p>
      <button id="runAllSheetsBtn">Rebuild all team sheets + director summary</button>
      <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-top:0.75rem;">
        <select id="reportTeam" style="width:auto; min-width:14rem;"></select>
        <button id="runOneSheetBtn" class="secondary">Rebuild just this team</button>
      </div>

      <details id="helperSetup" style="margin-top:1.5rem;">
        <summary style="cursor:pointer; color:var(--teal-dark); font-weight:600;">Setup: helper address</summary>
        <p style="color:var(--muted);">
          Paste the web app address of the Apps Script helper (the same one saved as the
          <code>SHEET_HELPER_URL</code> secret in GitHub). It needs the GITHUB_TOKEN and FIREBASE_API_KEY
          script properties — see the README, "Run buttons".
        </p>
        <input id="helperUrl" type="text" placeholder="https://script.google.com/macros/s/…/exec" />
        <button id="saveHelperBtn" class="secondary" style="margin-top:0.5rem;">Save address</button>
      </details>
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Recent runs</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Status comes straight from GitHub. <a href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">Open on GitHub</a>
      </p>
      ${Object.entries(JOBS)
        .map(
          ([key, job]) => `
        <h3 style="margin-bottom:0.25rem;">${escapeHtml(job.title)}</h3>
        <div id="runs-${key}" style="margin-bottom:1rem;"><span style="color:var(--muted);">Loading…</span></div>`
        )
        .join("")}
      <button id="refreshRunsBtn" class="secondary">Refresh</button>
    </div>
  `;

  const $ = (sel) => container.querySelector(sel);
  const statusEl = $("#reportsStatus");
  const helperInput = $("#helperUrl");
  let helperUrl = "";
  let pollTimer = null;

  function showStatus(kind, message) {
    statusEl.innerHTML = `<div class="status-banner ${kind}">${escapeHtml(message)}</div>`;
    statusEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // ---- last completed nightly work (written by the jobs to settings/jobStatus) ----
  const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const prettyDay = (key) => new Date(`${key}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const prettyTime = (iso) => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  async function loadNightlyStatus() {
    const el = $("#nightlyStatus");
    let status = {};
    try {
      const snap = await getDoc(doc(db, "settings", "jobStatus"));
      status = (snap.exists() && snap.data()) || {};
    } catch (err) {
      el.innerHTML = "";
      return;
    }
    const now = new Date();
    const dayBack = (n) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    // The jobs start around 2 AM, so from 6 AM on, last night's run should be in.
    const after6 = now.getHours() >= 6;
    const expectedEmail = after6 ? dayBack(1) : dayBack(2); // the day the report covers
    const expectedSheets = after6 ? dayBack(0) : dayBack(1); // the day the rebuild ran

    const line = (label, doneKey, doneAt, expected, what) => {
      const ok = doneKey && doneKey >= expected;
      const text = doneKey
        ? `${label}: ${what} ${prettyDay(doneKey)} — completed ${prettyTime(doneAt)}`
        : `${label}: no nightly run recorded yet`;
      return `<div class="status-banner ${ok ? "ok" : "error"}" style="margin-bottom:0.4rem;">${escapeHtml(text)}${
        ok ? "" : " — <strong>behind schedule.</strong> Use the button below to run it now."
      }</div>`;
    };
    el.innerHTML =
      line("Email report", status.emailSentFor, status.emailSentAt, expectedEmail, "last sent for") +
      line("Attendance sheets", status.sheetsBuiltFor, status.sheetsBuiltAt, expectedSheets, "last fully rebuilt");
  }

  // ---- recent runs ----
  async function loadRuns(key) {
    const el = $(`#runs-${key}`);
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${JOBS[key].file}/runs?per_page=6`);
      if (!res.ok) throw new Error(`GitHub returned ${res.status}${res.status === 403 ? " (too many status checks — wait a few minutes)" : ""}`);
      const { workflow_runs: runs } = await res.json();
      if (stale()) return false;
      if (!runs.length) {
        el.innerHTML = `<span style="color:var(--muted);">No runs yet.</span>`;
        return false;
      }
      el.innerHTML = `<table><thead><tr><th>Started</th><th>Trigger</th><th>Result</th><th></th></tr></thead><tbody>${runs
        .map((r) => {
          const d = describeRun(r);
          const colour = d.cls === "ok" ? "var(--teal-dark)" : d.cls === "error" ? "var(--coral-dark)" : "var(--muted)";
          return `<tr>
            <td>${escapeHtml(new Date(r.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</td>
            <td>${r.event === "schedule" ? "Nightly" : "Manual"}</td>
            <td style="color:${colour}; font-weight:600;">${escapeHtml(d.text)}</td>
            <td><a href="${escapeHtml(r.html_url)}" target="_blank" rel="noopener">Details</a></td>
          </tr>`;
        })
        .join("")}</tbody></table>`;
      return runs.some((r) => r.status !== "completed");
    } catch (err) {
      if (!stale()) el.innerHTML = `<span style="color:var(--coral-dark);">Couldn't load status: ${escapeHtml(err.message)}</span>`;
      return false;
    }
  }

  // Keep checking only the jobs that are still running, and only for a while,
  // so the page stays well inside GitHub's anonymous request limit.
  async function refreshRuns(keys = Object.keys(JOBS), attempt = 0) {
    clearTimeout(pollTimer);
    const active = [];
    for (const key of keys) if (await loadRuns(key)) active.push(key);
    if (active.length && attempt < 45 && !stale()) {
      pollTimer = setTimeout(() => refreshRuns(active, attempt + 1), 20000);
    }
  }

  // ---- starting a job ----
  async function startJob(workflow, inputs, label) {
    if (!helperUrl) {
      $("#helperSetup").open = true;
      showStatus("error", "Paste the helper address under Setup first.");
      return;
    }
    const buttons = container.querySelectorAll("button");
    buttons.forEach((b) => (b.disabled = true));
    try {
      const idToken = await auth.currentUser.getIdToken();
      let result;
      try {
        const res = await fetch(helperUrl, { method: "POST", body: JSON.stringify({ action: "runWorkflow", workflow, inputs, idToken }) });
        result = await res.json();
      } catch {
        throw new Error("Couldn't reach the helper. Check the address under Setup, and that it is deployed with access set to “Anyone”.");
      }
      if (!result.ok) throw new Error(result.error || "The helper refused the request.");
      showStatus("ok", `Started: ${label}. It shows up under Recent runs in a few seconds.`);
      setTimeout(() => refreshRuns([key(workflow)]), 5000);
      setTimeout(loadNightlyStatus, 90000); // pick up the "last completed" line once the job has had time to finish
    } catch (err) {
      showStatus("error", err.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  const key = (workflow) => Object.keys(JOBS).find((k) => JOBS[k].file === workflow);

  $("#runEmailBtn").addEventListener("click", () => {
    if (!confirm("Email yesterday's attendance report to the director and every coach whose team had check-ins now?")) return;
    startJob(JOBS.email.file, {}, "daily email report");
  });
  $("#runAllSheetsBtn").addEventListener("click", () => {
    startJob(
      JOBS.sheets.file,
      { team_ids: "ALL", build_master: "true", share_with_director: "true", share_with_coaches: "true" },
      "rebuild of all team sheets and the director summary"
    );
  });
  $("#runOneSheetBtn").addEventListener("click", () => {
    const teamId = $("#reportTeam").value;
    if (!teamId) return showStatus("error", "Pick a team first.");
    startJob(
      JOBS.sheets.file,
      { team_ids: teamId, build_master: "false", share_with_coaches: "true" },
      `rebuild of the ${teamId} sheet`
    );
  });
  $("#refreshRunsBtn").addEventListener("click", () => refreshRuns());

  $("#saveHelperBtn").addEventListener("click", async () => {
    const url = helperInput.value.trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec$/.test(url)) {
      return showStatus("error", "That doesn't look like an Apps Script web app address (it should end in /exec).");
    }
    try {
      await setDoc(doc(db, "settings", "reports"), { helperUrl: url });
      helperUrl = url;
      showStatus("ok", "Helper address saved.");
    } catch (err) {
      showStatus("error", `Couldn't save: ${err.message}`);
    }
  });

  // ---- initial load ----
  (async () => {
    try {
      const snap = await getDoc(doc(db, "settings", "reports"));
      helperUrl = (snap.exists() && snap.data().helperUrl) || "";
    } catch (err) {
      console.warn("Couldn't load reports setting:", err.message);
    }
    helperInput.value = helperUrl;
    $("#helperSetup").open = !helperUrl;

    try {
      const teamsSnap = await getDocs(collection(db, "teams"));
      const teams = [];
      teamsSnap.forEach((d) => teams.push({ id: d.id, name: d.data().name || d.id }));
      teams.sort((a, b) => a.id.localeCompare(b.id));
      $("#reportTeam").innerHTML = teams.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (${escapeHtml(t.id)})</option>`).join("");
    } catch (err) {
      console.warn("Couldn't load teams:", err.message);
    }
    loadNightlyStatus();
    refreshRuns();
  })();
}
