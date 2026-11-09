// Google Apps Script "helper" that creates the attendance spreadsheets inside
// YOUR Google Drive. Robot (service) accounts have no Drive storage, so the
// nightly job can't create files itself; it asks this script to, then fills
// the sheets in.
//
// Setup is in README.md ("Team attendance sheets"). Paste this whole file into
// a new project at https://script.google.com, set the HELPER_SECRET script
// property, and deploy it as a Web app (Execute as: Me, Who has access: Anyone).
// The secret is what keeps the sheet-creating endpoints private; the "run now"
// buttons are protected by the caller's Firebase login instead (see below).

var FOLDER_NAME = "Florida Conquer Attendance Sheets";

// Run this once from the editor (Run > setup) to grant Drive access and
// create the folder the sheets will be filed in.
function setup() {
  Logger.log("Folder ready: " + getFolder_().getUrl());
  if (!PropertiesService.getScriptProperties().getProperty("HELPER_SECRET")) {
    Logger.log("Reminder: add a HELPER_SECRET script property (Project Settings > Script properties).");
  }
}

// ---- "Run now" buttons in the admin console ----------------------------------
// The console can't hold a GitHub key (the site is public), so it asks this
// script to start the GitHub workflows. The request must carry the caller's
// Firebase login token, which is checked with Google before anything starts.
//
// Script properties needed for this (Project Settings > Script properties):
//   GITHUB_TOKEN     fine-grained GitHub token, this repo only, "Actions: Read and write"
//   FIREBASE_API_KEY the apiKey value from assets/firebase-config.js (it's public)
var GITHUB_REPO = "flyingpole/attendance-tracker";
var GITHUB_BRANCH = "master";
// Which workflows may be started, and which inputs each accepts.
var ALLOWED_WORKFLOWS = {
  "daily-report.yml": ["skip_if_done"],
  "team-sheets.yml": ["team_ids", "build_master", "share_with_director", "share_with_coaches", "skip_if_done"],
};

function runWorkflow_(body) {
  var props = PropertiesService.getScriptProperties();
  var githubToken = props.getProperty("GITHUB_TOKEN");
  var apiKey = props.getProperty("FIREBASE_API_KEY");
  if (!githubToken || !apiKey) {
    return reply_({ ok: false, error: "Not set up yet: add the GITHUB_TOKEN and FIREBASE_API_KEY script properties." });
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_WORKFLOWS, body.workflow)) {
    return reply_({ ok: false, error: "That job isn't allowed." });
  }
  if (!verifyFirebaseUser_(body.idToken, apiKey)) {
    return reply_({ ok: false, error: "You're not signed in as an admin. Reload the admin page and log in again." });
  }

  var allowedInputs = ALLOWED_WORKFLOWS[body.workflow];
  var inputs = {};
  var given = body.inputs || {};
  for (var i = 0; i < allowedInputs.length; i++) {
    var key = allowedInputs[i];
    if (given[key] === undefined) continue;
    var value = String(given[key]);
    if (key === "team_ids" && !/^[A-Za-z0-9,_ -]{1,200}$/.test(value)) {
      return reply_({ ok: false, error: "Invalid team list." });
    }
    if (key !== "team_ids" && value !== "true" && value !== "false") {
      return reply_({ ok: false, error: "Invalid value for " + key + "." });
    }
    inputs[key] = value;
  }

  // One start per job per minute, so a double-click can't queue duplicates.
  var cache = CacheService.getScriptCache();
  var lockKey = "run:" + body.workflow;
  if (cache.get(lockKey)) {
    return reply_({ ok: false, error: "That job was just started. Give it a minute before starting it again." });
  }

  var code = dispatchWorkflow_(body.workflow, inputs, githubToken);
  if (code === 204) {
    cache.put(lockKey, "1", 60);
    return reply_({ ok: true });
  }
  var hint = "";
  if (code === 401) hint = " The GitHub token is invalid or expired; make a new one and update GITHUB_TOKEN.";
  if (code === 403 || code === 404) hint = " The GitHub token needs 'Actions: Read and write' on this repository.";
  return reply_({ ok: false, error: "GitHub refused (HTTP " + code + ")." + hint });
}

// Starts a GitHub workflow; returns the HTTP status (204 = started). Retries
// briefly on GitHub-side errors (5xx).
function dispatchWorkflow_(workflow, inputs, githubToken) {
  var code = 0;
  for (var attempt = 1; attempt <= 3; attempt++) {
    var response = UrlFetchApp.fetch(
      "https://api.github.com/repos/" + GITHUB_REPO + "/actions/workflows/" + workflow + "/dispatches",
      {
        method: "post",
        contentType: "application/json",
        headers: {
          Authorization: "Bearer " + githubToken,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "florida-conquer-attendance",
        },
        payload: JSON.stringify({ ref: GITHUB_BRANCH, inputs: inputs }),
        muteHttpExceptions: true,
      }
    );
    code = response.getResponseCode();
    if (code < 500) break;
    Utilities.sleep(5000 * attempt);
  }
  return code;
}

// ---- Nightly start at 2 AM Eastern ------------------------------------------
// GitHub's own scheduler has been starting scheduled runs 7-10 hours late, so
// THIS is what starts the nightly jobs on time. (GitHub's schedule stays as a
// backup; both jobs skip if the day's work is already done.)
//
// Run installNightlyTrigger ONCE from the editor (it also asks for permission to
// email you if the nightly start ever fails). Needs the GITHUB_TOKEN property.
var NIGHTLY_HOUR = 2;
var NIGHTLY_TIMEZONE = "America/New_York";
var NIGHTLY_JOBS = [
  ["daily-report.yml", { skip_if_done: "true" }],
  ["team-sheets.yml", { team_ids: "ALL", build_master: "true", share_with_director: "true", share_with_coaches: "true", skip_if_done: "true" }],
];

function installNightlyTrigger() {
  removeNightlyTrigger();
  ScriptApp.newTrigger("nightlyKick")
    .timeBased()
    .inTimezone(NIGHTLY_TIMEZONE)
    .atHour(NIGHTLY_HOUR)
    .nearMinute(5)
    .everyDays(1)
    .create();
  // Touching MailApp here makes Google ask for the email permission now, not at 2 AM.
  Logger.log("Nightly trigger installed (about 2:05 AM " + NIGHTLY_TIMEZONE + "). Failure alerts go to " + Session.getEffectiveUser().getEmail() + ". Emails left today: " + MailApp.getRemainingDailyQuota());
}

function removeNightlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "nightlyKick") ScriptApp.deleteTrigger(trigger);
  });
}

function nightlyKick() {
  var githubToken = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  var problems = [];
  if (!githubToken) {
    problems.push("The GITHUB_TOKEN script property is missing.");
  } else {
    NIGHTLY_JOBS.forEach(function (job) {
      var code = dispatchWorkflow_(job[0], job[1], githubToken);
      if (code !== 204) {
        problems.push(job[0] + ": GitHub refused to start it (HTTP " + code + ")." + (code === 401 ? " The GitHub token has probably expired." : ""));
      }
    });
  }
  if (problems.length) {
    // Tell the owner, since nothing else would. GitHub's backup schedule may still run late.
    MailApp.sendEmail(
      Session.getEffectiveUser().getEmail(),
      "Attendance nightly start failed",
      "The 2 AM attendance jobs could not be started:\n\n" + problems.join("\n") +
        "\n\nGitHub's own backup schedule may still run them, but later. To fix an expired token: create a new one and update the GITHUB_TOKEN script property."
    );
  }
}

// Asks Google whether this Firebase login token is genuine and current.
function verifyFirebaseUser_(idToken, apiKey) {
  if (!idToken) return null;
  var response = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(apiKey), {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) return null;
  var data = JSON.parse(response.getContentText());
  return data.users && data.users[0] ? data.users[0] : null;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // Console buttons authenticate with a Firebase login token, not the shared secret.
    if (body.action === "runWorkflow") return runWorkflow_(body);

    var secret = PropertiesService.getScriptProperties().getProperty("HELPER_SECRET");
    if (!secret || body.secret !== secret) return reply_({ ok: false, error: "unauthorized" });

    if (body.action === "ping") return reply_({ ok: true });

    // Gives people access to an existing sheet (used to share with coaches
    // later, once the sheets have been reviewed).
    if (body.action === "share") {
      if (!body.spreadsheetId) return reply_({ ok: false, error: "bad request" });
      var existingFile = DriveApp.getFileById(body.spreadsheetId);
      return reply_({ ok: true, shareErrors: share_(existingFile, body.editors, body.viewers) });
    }

    if (body.action !== "createSheet" || !body.title) return reply_({ ok: false, error: "bad request" });

    var spreadsheet = SpreadsheetApp.create(body.title);
    var file = DriveApp.getFileById(spreadsheet.getId());
    getFolder_().addFile(file);
    DriveApp.getRootFolder().removeFile(file);

    var shareErrors = share_(file, body.editors, body.viewers);
    return reply_({ ok: true, spreadsheetId: spreadsheet.getId(), url: spreadsheet.getUrl(), shareErrors: shareErrors });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  }
}

// Adds editors/viewers, skipping anyone who already has access (including the
// owner) so a re-run doesn't re-send Google's notification email.
function share_(file, editors, viewers) {
  var errors = [];
  var have = {};
  var owner = file.getOwner();
  if (owner) have[owner.getEmail().toLowerCase()] = true;
  file.getEditors().concat(file.getViewers()).forEach(function (user) {
    have[user.getEmail().toLowerCase()] = true;
  });
  (editors || []).forEach(function (email) {
    if (have[email.toLowerCase()]) return;
    try { file.addEditor(email); } catch (err) { errors.push(email + ": " + err); }
  });
  (viewers || []).forEach(function (email) {
    if (have[email.toLowerCase()]) return;
    try { file.addViewer(email); } catch (err) { errors.push(email + ": " + err); }
  });
  return errors;
}

function getFolder_() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
