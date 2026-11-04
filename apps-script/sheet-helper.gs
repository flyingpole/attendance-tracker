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
    if (body.action !== "createSheet" || !body.title) return reply_({ ok: false, error: "bad request" });

    var spreadsheet = SpreadsheetApp.create(body.title);
    var file = DriveApp.getFileById(spreadsheet.getId());
    getFolder_().addFile(file);
    DriveApp.getRootFolder().removeFile(file);

    var shareErrors = [];
    (body.editors || []).forEach(function (email) {
      try { file.addEditor(email); } catch (err) { shareErrors.push(email + ": " + err); }
    });
    (body.viewers || []).forEach(function (email) {
      try { file.addViewer(email); } catch (err) { shareErrors.push(email + ": " + err); }
    });

    return reply_({ ok: true, spreadsheetId: spreadsheet.getId(), url: spreadsheet.getUrl(), shareErrors: shareErrors });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  }
}

function getFolder_() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(FOLDER_NAME);
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
