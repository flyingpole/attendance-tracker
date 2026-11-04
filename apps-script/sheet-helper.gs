// Google Apps Script "helper" that creates the attendance spreadsheets inside
// YOUR Google Drive. Robot (service) accounts have no Drive storage, so the
// nightly job can't create files itself; it asks this script to, then fills
// the sheets in.
//
// Setup is in README.md ("Team attendance sheets"). Paste this whole file into
// a new project at https://script.google.com, set the HELPER_SECRET script
// property, and deploy it as a Web app (Execute as: Me, Who has access: Anyone).
// The secret is what keeps the endpoint private.

var FOLDER_NAME = "Florida Conquer Attendance Sheets";

// Run this once from the editor (Run > setup) to grant Drive access and
// create the folder the sheets will be filed in.
function setup() {
  Logger.log("Folder ready: " + getFolder_().getUrl());
  if (!PropertiesService.getScriptProperties().getProperty("HELPER_SECRET")) {
    Logger.log("Reminder: add a HELPER_SECRET script property (Project Settings > Script properties).");
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
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
