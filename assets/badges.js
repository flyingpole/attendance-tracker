import { db } from "./firebase.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm";

// Brand palette (matches assets/styles.css)
const COLOR_TEAL = [15, 122, 95];
const COLOR_TEAL_DARK = [11, 90, 70];
const COLOR_CORAL = [232, 80, 44];
const COLOR_BLACK = [10, 10, 10];
const COLOR_MUTED = [107, 114, 128];

// Avery Presta® 94107 — 2" x 2" square labels, 12 per US Letter sheet
// (3 columns x 4 rows). Margins/gaps below match Avery's official die-cut
// layout exactly (0.625" left/right margin + gap, 0.6" top/bottom margin +
// gap) — verified they sum precisely to 8.5" x 11" with symmetric margins.
const TAG_SIZE = 2.0;
const COLS = 3;
const ROWS = 4;
const MARGIN_X = 0.625;
const MARGIN_Y = 0.6;
const GUTTER_X = 0.625;
const GUTTER_Y = 0.6;

async function qrDataUrl(text) {
  return await QRCode.toDataURL(text, { width: 300, margin: 1, color: { dark: "#0a0a0a" } });
}

async function loadLogo() {
  const res = await fetch("assets/logo.png");
  const blob = await res.blob();
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  const dims = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = reject;
    img.src = dataUrl;
  });
  return { dataUrl, aspect: dims.w / dims.h };
}

// jsPDF's text() maxWidth option WRAPS to multiple lines rather than
// truncating — fine for the QR caption, but for the fixed-position name/team
// lines a wrap would collide with whatever's drawn below it. Force a single
// line by trimming with an ellipsis instead.
function fitOneLine(doc, text, maxWidth) {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && doc.getTextWidth(truncated + "…") > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + "…";
}

function drawBadge(doc, x, y, player, teamName, qr, logo) {
  const centerX = x + TAG_SIZE / 2;
  const maxTextWidth = TAG_SIZE - 0.24;

  // Thin brand-colored border (these are die-cut adhesive labels — no
  // cutting needed, this is purely decorative).
  doc.setDrawColor(...COLOR_TEAL);
  doc.setLineWidth(0.015);
  doc.roundedRect(x + 0.03, y + 0.03, TAG_SIZE - 0.06, TAG_SIZE - 0.06, 0.06, 0.06);

  // Logo
  const logoH = 0.38;
  const logoW = logoH * logo.aspect;
  doc.addImage(logo.dataUrl, "PNG", centerX - logoW / 2, y + 0.1, logoW, logoH);

  // Name
  doc.setTextColor(...COLOR_BLACK);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(fitOneLine(doc, player.name, maxTextWidth), centerX, y + 0.66, { align: "center" });

  // Team
  doc.setTextColor(...COLOR_TEAL_DARK);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.text(fitOneLine(doc, teamName, maxTextWidth), centerX, y + 0.8, { align: "center" });

  // Divider
  doc.setDrawColor(...COLOR_CORAL);
  doc.setLineWidth(0.015);
  doc.line(x + 0.3, y + 0.88, x + TAG_SIZE - 0.3, y + 0.88);

  // QR code
  const qrSize = 0.88;
  const qrX = centerX - qrSize / 2;
  const qrY = y + 0.94;
  doc.addImage(qr, "PNG", qrX, qrY, qrSize, qrSize);

  // Badge code (tiny reference text below the QR)
  doc.setTextColor(...COLOR_MUTED);
  doc.setFont("courier", "normal");
  doc.setFontSize(6.5);
  doc.text(player.badgeCode, centerX, qrY + qrSize + 0.13, { align: "center" });
}

async function buildBadgesPdf(players, teamNames) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "in", format: "letter" }); // portrait
  const logo = await loadLogo();

  let col = 0;
  let row = 0;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const x = MARGIN_X + col * (TAG_SIZE + GUTTER_X);
    const y = MARGIN_Y + row * (TAG_SIZE + GUTTER_Y);

    const qr = await qrDataUrl(p.badgeCode);
    drawBadge(doc, x, y, p, teamNames.get(p.teamId) || p.teamId, qr, logo);

    col++;
    if (col === COLS) {
      col = 0;
      row++;
      if (row === ROWS && i < players.length - 1) {
        doc.addPage();
        row = 0;
      }
    }
  }

  return doc;
}

export function initBadgesTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0;">Generate badges</h2>
      <p style="color:var(--muted); margin-top:-0.5rem;">
        Sized for <strong>Avery Presta® 94107</strong> (2" × 2" square labels, 12 per sheet) —
        just load the sheet in your printer and print, no cutting needed.
      </p>
      <label for="teamFilter">Team</label>
      <select id="teamFilter"></select>
      <label for="playerFilter" style="margin-top:0.75rem;">Single player (optional — leave blank to generate the whole team/all)</label>
      <select id="playerFilter"><option value="">-- Whole selection above --</option></select>
      <div style="margin-top:1rem; display:flex; gap:0.5rem;">
        <button id="previewBtn">Preview</button>
        <button id="downloadPdfBtn" class="secondary">Download printable PDF</button>
      </div>
      <div id="badgeStatus" style="margin-top:1rem;"></div>
      <div id="badgePreview" class="badge-grid"></div>
    </div>
  `;

  const teamFilter = container.querySelector("#teamFilter");
  const playerFilter = container.querySelector("#playerFilter");
  const statusEl = container.querySelector("#badgeStatus");
  const previewEl = container.querySelector("#badgePreview");

  let allPlayers = [];
  let teamNames = new Map();

  async function loadData() {
    const [playersSnap, teamsSnap] = await Promise.all([
      getDocs(collection(db, "players")),
      getDocs(collection(db, "teams")),
    ]);
    teamNames = new Map();
    teamsSnap.forEach((d) => teamNames.set(d.id, d.data().name));

    allPlayers = [];
    playersSnap.forEach((d) => allPlayers.push({ id: d.id, ...d.data() }));
    allPlayers.sort((a, b) => a.name.localeCompare(b.name));

    teamFilter.innerHTML = `<option value="">-- All teams --</option>`;
    for (const [id, name] of teamNames.entries()) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = name;
      teamFilter.appendChild(opt);
    }

    refreshPlayerOptions();
  }

  function refreshPlayerOptions() {
    const teamId = teamFilter.value;
    const filtered = teamId ? allPlayers.filter((p) => p.teamId === teamId) : allPlayers;
    playerFilter.innerHTML = `<option value="">-- Whole selection above --</option>`;
    for (const p of filtered) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.name} (${teamNames.get(p.teamId) || p.teamId})`;
      playerFilter.appendChild(opt);
    }
  }

  teamFilter.addEventListener("change", refreshPlayerOptions);

  function getSelection() {
    if (playerFilter.value) {
      return allPlayers.filter((p) => p.id === playerFilter.value);
    }
    const teamId = teamFilter.value;
    return teamId ? allPlayers.filter((p) => p.teamId === teamId) : allPlayers;
  }

  container.querySelector("#previewBtn").addEventListener("click", async () => {
    const selection = getSelection();
    if (selection.length === 0) {
      statusEl.innerHTML = `<div class="status-banner error">No players match that selection.</div>`;
      return;
    }
    statusEl.innerHTML = `<div class="status-banner info">Rendering ${selection.length} badge(s)…</div>`;
    previewEl.innerHTML = "";
    for (const p of selection) {
      const dataUrl = await qrDataUrl(p.badgeCode);
      const card = document.createElement("div");
      card.className = "badge-card";
      card.innerHTML = `
        <img src="${dataUrl}" alt="QR code" />
        <div>
          <div class="name">${p.name}</div>
          <div class="team">${teamNames.get(p.teamId) || p.teamId}</div>
          <div class="team">${p.badgeCode}</div>
        </div>
      `;
      previewEl.appendChild(card);
    }
    statusEl.innerHTML = `<div class="status-banner ok">Showing ${selection.length} badge(s). Download the PDF to see the full decorative design.</div>`;
  });

  container.querySelector("#downloadPdfBtn").addEventListener("click", async () => {
    const selection = getSelection();
    if (selection.length === 0) {
      statusEl.innerHTML = `<div class="status-banner error">No players match that selection.</div>`;
      return;
    }
    statusEl.innerHTML = `<div class="status-banner info">Building PDF for ${selection.length} badge(s)…</div>`;
    const pdf = await buildBadgesPdf(selection, teamNames);
    pdf.save("badges.pdf");
    statusEl.innerHTML = `<div class="status-banner ok">Downloaded badges.pdf (${selection.length} badge(s)).</div>`;
  });

  loadData();
}
