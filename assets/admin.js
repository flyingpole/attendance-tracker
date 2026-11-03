import { auth } from "./firebase.js";
import {
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initTeamsTab } from "./teams.js";
import { initRosterTab } from "./roster.js";
import { initSessionsTab } from "./sessions.js";
import { initScheduleTab } from "./schedule.js";
import { initBadgesTab } from "./badges.js";

const loginSection = document.getElementById("loginSection");
const adminSection = document.getElementById("adminSection");
const loginStatus = document.getElementById("loginStatus");
const logoutBtn = document.getElementById("logoutBtn");

document.getElementById("loginBtn").addEventListener("click", async () => {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  loginStatus.innerHTML = "";
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginStatus.innerHTML = `<div class="status-banner error">${err.message}</div>`;
  }
});

// Emails a reset link via Firebase. The success message is deliberately the
// same whether or not the address has an account, so this can't be used to
// discover which emails are admins.
document.getElementById("forgotPasswordLink").addEventListener("click", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  if (!email) {
    loginStatus.innerHTML = `<div class="status-banner error">Type your email address in the Email box first, then click "Forgot password?" again.</div>`;
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    const safeEmail = email.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    loginStatus.innerHTML = `<div class="status-banner ok">If an account exists for ${safeEmail}, a password reset link is on its way. Check your inbox (and spam folder).</div>`;
  } catch (err) {
    const message =
      err.code === "auth/invalid-email"
        ? "That doesn't look like a valid email address."
        : err.code === "auth/too-many-requests"
        ? "Too many attempts — wait a few minutes and try again."
        : `Couldn't send the reset email: ${err.message}`;
    loginStatus.innerHTML = `<div class="status-banner error">${message}</div>`;
  }
});

logoutBtn.addEventListener("click", () => signOut(auth));

const tabInitializers = {
  teams: () => initTeamsTab(document.getElementById("tab-teams")),
  roster: () => initRosterTab(document.getElementById("tab-roster")),
  schedule: () => initScheduleTab(document.getElementById("tab-schedule")),
  sessions: () => initSessionsTab(document.getElementById("tab-sessions")),
  badges: () => initBadgesTab(document.getElementById("tab-badges")),
};

let listenersWired = false;
function wireTabsOnce() {
  if (listenersWired) return;
  listenersWired = true;

  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
      // Re-run the tab's init/data-load every time it's opened, so edits made
      // in one tab (e.g. importing a roster) show up immediately in another
      // (e.g. the Badges player list) without needing a full page reload.
      tabInitializers[btn.dataset.tab]();
    });
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    loginSection.classList.add("hidden");
    adminSection.classList.remove("hidden");
    logoutBtn.classList.remove("hidden");
    wireTabsOnce();
    tabInitializers.teams(); // the default active tab on login
  } else {
    loginSection.classList.remove("hidden");
    adminSection.classList.add("hidden");
    logoutBtn.classList.add("hidden");
  }
});
