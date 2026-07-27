/************************************************
 * SOL2 DASHBOARD API — UPDATED
 *
 * ⚠️  REQUIRED SETUP — do this before deploying:
 *  1. Open your Google Sheet
 *  2. Copy the ID from the URL:
 *     https://docs.google.com/spreadsheets/d/ >>>COPY_THIS_PART<<< /edit
 *  3. Paste it below, replacing the placeholder
 *  4. Add two new sheets: STUDENT_DEVOTIONALS and STUDENT_ACTIVITIES
 *     (see headers below)
 *  5. Add a MAKEUP_STATUS column to STUDENT_ATTENDANCE (see note)
 *  6. For video quests (e.g. Level 1's testimony/watch quests): create a
 *     Google Drive folder for testimony videos, copy its ID from the URL
 *     (drive.google.com/drive/folders/ >>>COPY_THIS_PART<<<), and paste it
 *     into VIDEO_FOLDER_ID below. Also add the QUEST_VIDEOS and
 *     STUDENT_VIDEO_SUBMISSIONS sheets (see headers below).
 *  7. Add a new sheet called MAKEUP_WEEK_ASSIGNMENTS with headers:
 *     Record ID | Week No | Assigned To | Updated By | Updated At
 *     This lets a Director/Consultant assign one facilitator to handle
 *     ALL absent students' make-up classes for a given week (see
 *     updateMakeupWeekAssignment below).
 *  8. Deploy → Manage deployments → New deployment
 *     Execute as: Me | Who has access: Anyone
 ************************************************/

const SPREADSHEET_ID = "1zfWtx5dFfyvWSeL1fC_EHLBoK9cejZXdlSdRGyk0-Pk"; // ← REPLACE THIS
const VIDEO_FOLDER_ID = "1io6sIDbwWn-ajM_Hws_5wpJj3Fj1bEBj"; // ← Drive folder for uploaded testimony videos

/************************************************
 * NEW SHEETS REQUIRED IN YOUR GOOGLE SPREADSHEET:
 *
 * Sheet: STUDENT_LESSON_POINTS   (per-lesson Attendance/Participation/Homework/
 *                                  Memory Verse points grid — this is what powers
 *                                  the Faculty "Points" leaderboard AND the
 *                                  Student app's own Current Points total)
 * Headers (Row 1):
 *   Record ID | Student ID | Student Name | Table No | Module No | Lesson No |
 *   Attendance Points | Participation Points | Homework Points | Memory Verse Points |
 *   Date Marked | Marked By
 *   (This sheet already exists in your spreadsheet with the right headers —
 *   it was just never being written to. See the fix notes below.)
 ************************************************/

/************************************************
 * GET REQUESTS
 ************************************************/

function doGet(e) {
  try {
    const action = e.parameter.action;

    switch (action) {

      case "students":
        return output(getSheetData("STUDENTS"));

      case "faculty":
        return output(getSheetData("FACULTY_STAFF"));

      case "lessonWeeks":
        return output(getSheetData("LESSON_WEEKS"));

      case "studentAttendance":
        return output(getSheetData("STUDENT_ATTENDANCE"));

      case "facultyAttendance":
        return output(getSheetData("FACULTY_ATTENDANCE"));

      case "payments":
        return output(getSheetData("PAYMENTS"));

      // Pass ?studentId=... to get only that student's rows (the Student
      // app always does this, so a student's device only ever sees their
      // own points, never a table-mate's). Faculty app calls this with no
      // studentId and still gets everyone, exactly as before.
      case "credits":
        var creditsResult = getSheetData("POINTS_LOG");
        if (e.parameter.studentId) {
          creditsResult.data = creditsResult.data.filter(function (c) {
            return String(c["Student ID"]) === String(e.parameter.studentId);
          });
        }
        return output(creditsResult);

      // FIX: this action was missing entirely, so the front-end's
      // apiGet('lessonPoints') call always failed silently, and the
      // Attendance/Participation/Homework/Memory Verse points grid never
      // loaded any saved data (see toggleLessonPointBox below for the
      // matching write-side fix). Pass ?studentId=... to get only that
      // student's rows (the Student app does this).
      case "lessonPoints":
        var lpResult = getSheetData("STUDENT_LESSON_POINTS");
        if (e.parameter.studentId) {
          lpResult.data = lpResult.data.filter(function (r) {
            return String(r["Student ID"]) === String(e.parameter.studentId);
          });
        }
        return output(lpResult);

      case "qrscans":
        return output(getSheetData("QR_SCANS"));

      case "tableGuides":
        return output(getSheetData("TABLE_GUIDES"));

      case "settings":
        return output(getSheetData("SYSTEM_SETTINGS"));

      case "devotionals":
        return output(getSheetData("STUDENT_DEVOTIONALS"));

      case "activities":
        return output(getSheetData("STUDENT_ACTIVITIES"));

      case "makeupStatus":
        return output(getSheetData("MAKEUP_STATUS"));

      case "makeupWeekAssignments":
        return output(getSheetData("MAKEUP_WEEK_ASSIGNMENTS"));

      case "lessonCompletion":
        return output(getSheetData("STUDENT_LESSON_COMPLETION"));

      case "questProgress":
        return output(getSheetData("STUDENT_QUEST_PROGRESS"));

      case "notifications":
        return output(getSheetData("NOTIFICATIONS"));

      case "questVideos":
        return output(getSheetData("QUEST_VIDEOS"));

      // Student-uploaded testimony videos. Pass ?studentId=... to get
      // only that student's rows (the Student app always does this, so one
      // student's device never receives another student's video links).
      case "videoSubmissions":
        var vsResult = getSheetData("STUDENT_VIDEO_SUBMISSIONS");
        if (e.parameter.studentId) {
          vsResult.data = vsResult.data.filter(function (r) {
            return String(r["Student ID"]) === String(e.parameter.studentId);
          });
        }
        return output(vsResult);

      // ── GAME SHOW STATE (cross-device sync) ──
      case "gameState":
        var gsRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        return output({ state: gsRaw ? JSON.parse(gsRaw) : null });

      case "redeemItems":
        return output(getSheetData("REDEEM_ITEMS"));

      // Redemption log. Pass ?studentId=... to get only that
      // student's rows (the Student app always does this).
      case "redemptions":
        var rdResult = getSheetData("REDEMPTIONS");
        if (e.parameter.studentId) {
          rdResult.data = rdResult.data.filter(function (r) {
            return String(r["Student ID"]) === String(e.parameter.studentId);
          });
        }
        return output(rdResult);

      case "student":
        return output(getStudentById(e.parameter.studentId));

      case "facultyMember":
        return output(getFacultyById(e.parameter.facultyId));

      default:
        return output({
          success: false,
          message: "Invalid action: " + action
        });
    }

  } catch (error) {
    return output({
      success: false,
      error: error.toString()
    });
  }
}

/************************************************
 * POST REQUESTS
 ************************************************/

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    switch (data.action) {

      case "addAttendance":
        return output(addAttendance(data));

      case "addFacultyAttendance":
        return output(addFacultyAttendance(data));

      case "addPayment":
        return output(addPayment(data));

      case "addCredit":
        return output(addCredit(data));

      // FIX: this action was missing entirely, so every time a Faculty/
      // Table Guide tapped a box in the Attendance/Participation/Homework/
      // Memory Verse points grid, the request fell through to the "Unknown
      // action" default case below and nothing was ever saved to
      // STUDENT_LESSON_POINTS. The points only ever existed in that one
      // browser's in-memory state (which is why a leaderboard could show
      // 5,000 pts for a student while their own device — reading fresh
      // from the sheet — showed 0).
      case "toggleLessonPointBox":
        return output(toggleLessonPointBox(data));

      case "addQRScan":
        return output(addQRScan(data));

      case "toggleDevotional":
        return output(toggleDevotional(data));

      case "toggleActivity":
        return output(toggleActivity(data));

      case "toggleQuest":
        return output(toggleQuest(data));

      case "markNotificationRead":
        return output(markNotificationRead(data));

      case "markAllNotificationsRead":
        return output(markAllNotificationsRead(data));

      case "uploadTestimonyVideo":
        return output(uploadTestimonyVideo(data));

      case "saveStudentDevotionals":
        return output(saveStudentDevotionals(data));

      case "saveStudentActivities":
        return output(saveStudentActivities(data));

      case "updateMakeupStatus":
        return output(updateMakeupStatus(data));

      case "updateMakeupWeekAssignment":
        return output(updateMakeupWeekAssignment(data));

      case "toggleLessonCompletion":
        return output(toggleLessonCompletion(data));

      case "saveStudentLessonCompletion":
        return output(saveStudentLessonCompletion(data));

      case "updateStudentStatus":
        return output(updateStudentStatus(data));

      case "addStudent":
        return output(addStudent(data));

      // Student redeems a Redeem Store item. Balance is recomputed
      // server-side (not trusted from the client) so a stale screen or a
      // double-tap can never push a student below zero points.
      case "redeemReward":
        return output(redeemReward(data));

      case "sendAdminNotification":
        return output(sendAdminNotification(data));

      // ── GAME SHOW STATE (cross-device sync) ──
      case "setGameState":
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(data.state));
        return output({ success: true });

      case "appendGameEvent":
        var gsAppRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        var gsAppState = gsAppRaw ? JSON.parse(gsAppRaw) : { events: [] };
        if (!gsAppState.events) gsAppState.events = [];
        gsAppState.events.push(data.event);
        if (gsAppState.events.length > 40) gsAppState.events = gsAppState.events.slice(-40);
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(gsAppState));
        return output({ success: true });

      case "getGameState":
        var gsRaw2 = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        return output({ state: gsRaw2 ? JSON.parse(gsRaw2) : null });

      case "clearGameState":
        PropertiesService.getScriptProperties().deleteProperty("GS_GAME_STATE");
        return output({ success: true });

      default:
        return output({
          success: false,
          message: "Unknown action: " + data.action
        });
    }

  } catch (error) {
    return output({
      success: false,
      error: error.toString()
    });
  }
}

/************************************************
 * SHEET CORE
 ************************************************/

function getSheet(sheetName) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error("Sheet not found: " + sheetName);
  }
  return sheet;
}

function getSheetData(sheetName) {
  const sheet  = getSheet(sheetName);
  const values = sheet.getDataRange().getValues();

  if (values.length < 1) {
    return { success: true, data: [] };
  }

  const headers = values.shift(); // first row = column headers

  const data = values.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });

  return {
    success: true,
    data: data
  };
}

/************************************************
 * STUDENT LOOKUP
 ************************************************/

function getStudentById(studentId) {
  const students = getSheetData("STUDENTS").data;
  const student  = students.find(
    s => String(s["Student ID"]) === String(studentId)
  );
  return {
    success: true,
    data: student || null
  };
}

/************************************************
 * FACULTY LOOKUP
 ************************************************/

function getFacultyById(facultyId) {
  const faculty = getSheetData("FACULTY_STAFF").data;
  const person  = faculty.find(
    f => String(f["Faculty ID"]) === String(facultyId)
  );
  return {
    success: true,
    data: person || null
  };
}

/************************************************
 * STUDENT ATTENDANCE
 ************************************************/

function addAttendance(data) {
  const sheet = getSheet("STUDENT_ATTENDANCE");
  sheet.appendRow([
    Utilities.getUuid(),          // Attendance ID
    data.studentId,               // Student ID
    data.studentName,             // Student Name
    data.age        || "",        // Age
    data.gender     || "",        // Gender
    data.lgLeader   || "",        // LG Leader
    data.networkLeader || "",     // Network Leader
    data.tableNo    || "",        // Table No
    data.weekNo,                  // Week No
    data.status,                  // Attendance Status
    new Date(),                   // Scan Time
    data.remarks    || "",        // Remarks
    "Pending"                     // Makeup Status (new column — default Pending for absences)
  ]);
  return {
    success: true,
    message: "Attendance Recorded"
  };
}

/************************************************
 * FACULTY ATTENDANCE
 ************************************************/

function addFacultyAttendance(data) {
  const sheet = getSheet("FACULTY_ATTENDANCE");
  sheet.appendRow([
    Utilities.getUuid(),
    data.facultyId,
    data.facultyName,
    data.role,
    data.weekNo,
    data.status,
    new Date()
  ]);
  return {
    success: true,
    message: "Faculty Attendance Recorded"
  };
}

/************************************************
 * PAYMENTS
 ************************************************/

function addPayment(data) {
  const sheet = getSheet("PAYMENTS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.amountPaid,
    data.balance,
    new Date(),
    data.status
  ]);
  return {
    success: true,
    message: "Payment Added"
  };
}

/************************************************
 * POINTS (manual "Add Points" form — legacy path)
 ************************************************/

function addCredit(data) {
  const sheet = getSheet("POINTS_LOG");
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.reason,
    data.creditsAdded,
    new Date(),
    data.addedBy
  ]);
  return {
    success: true,
    message: "Point Added"
  };
}

/************************************************
 * LESSON POINTS GRID (NEW — this was the missing piece)
 * Sheet: STUDENT_LESSON_POINTS
 * Headers: Record ID | Student ID | Student Name | Table No | Module No |
 *          Lesson No | Attendance Points | Participation Points |
 *          Homework Points | Memory Verse Points | Date Marked | Marked By
 * data: { studentId, studentName, tableNo, moduleNo, lessonNo, category,
 *         points, markedBy }
 * "category" is one of: attendance | participation | homework | memoryVerse
 ************************************************/

function lessonPointsCategoryColumn(categoryKey) {
  switch (categoryKey) {
    case "attendance":    return "Attendance Points";
    case "participation": return "Participation Points";
    case "homework":      return "Homework Points";
    case "memoryVerse":   return "Memory Verse Points";
    default:
      throw new Error("Unknown lesson points category: " + categoryKey);
  }
}

function toggleLessonPointBox(data) {
  const categoryCol = lessonPointsCategoryColumn(data.category);
  const sheet   = getSheet("STUDENT_LESSON_POINTS");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const moduleCol    = headers.indexOf("Module No");
  const lessonCol    = headers.indexOf("Lesson No");
  const catCol       = headers.indexOf(categoryCol);
  const dateCol      = headers.indexOf("Date Marked");
  const markedByCol  = headers.indexOf("Marked By");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][moduleCol]) === Number(data.moduleNo) &&
        Number(values[i][lessonCol]) === Number(data.lessonNo)) {
      sheet.getRange(i + 1, catCol + 1).setValue(Number(data.points) || 0);
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      sheet.getRange(i + 1, markedByCol + 1).setValue(data.markedBy || "");
      return { success: true, message: "Lesson points updated" };
    }
  }

  // No row yet for this student+module+lesson — insert one with the three
  // other categories starting at 0.
  sheet.appendRow([
    Utilities.getUuid(),          // Record ID
    data.studentId,                // Student ID
    data.studentName || "",        // Student Name
    data.tableNo || "",            // Table No
    data.moduleNo,                  // Module No
    data.lessonNo,                  // Lesson No
    data.category === "attendance"    ? (Number(data.points) || 0) : 0,
    data.category === "participation" ? (Number(data.points) || 0) : 0,
    data.category === "homework"      ? (Number(data.points) || 0) : 0,
    data.category === "memoryVerse"   ? (Number(data.points) || 0) : 0,
    new Date(),                     // Date Marked
    data.markedBy || ""             // Marked By
  ]);
  return { success: true, message: "Lesson points recorded" };
}

/************************************************
 * REDEEM POINTS
 * data: { studentId, studentName, tableNo, itemName, pointsCost, redeemedBy }
 * Recomputes the student's available balance from POINTS_LOG + the lesson
 * points grid, minus prior REDEMPTIONS rows (never trusts a balance sent
 * from the client), so this is safe even if two devices try to redeem for
 * the same student at once or the app's cached numbers are out of date.
 ************************************************/

function computeAvailablePoints(studentId) {
  const earned = getSheetData("POINTS_LOG").data
    .filter(function (c) { return String(c["Student ID"]) === String(studentId); })
    .reduce(function (sum, c) { return sum + Number(c["Credits Added"] || 0); }, 0);

  // FIX: this previously left out lesson-grid points entirely, so a
  // student's redeemable balance didn't match the total shown on the
  // Faculty leaderboard.
  const lessonPoints = getSheetData("STUDENT_LESSON_POINTS").data
    .filter(function (r) { return String(r["Student ID"]) === String(studentId); })
    .reduce(function (sum, r) {
      return sum + Number(r["Attendance Points"] || 0)
                 + Number(r["Participation Points"] || 0)
                 + Number(r["Homework Points"] || 0)
                 + Number(r["Memory Verse Points"] || 0);
    }, 0);

  const redeemed = getSheetData("REDEMPTIONS").data
    .filter(function (r) { return String(r["Student ID"]) === String(studentId); })
    .reduce(function (sum, r) { return sum + Number(r["Points Cost"] || 0); }, 0);

  return earned + lessonPoints - redeemed;
}

function redeemReward(data) {
  if (!data.studentId) return { success: false, message: "Missing studentId." };
  if (!data.itemName)  return { success: false, message: "Missing itemName." };

  const cost = Number(data.pointsCost || 0);
  if (!(cost > 0)) return { success: false, message: "Invalid point cost." };

  const available = computeAvailablePoints(data.studentId);
  if (available < cost) {
    return {
      success: false,
      message: "Not enough points — you have " + available + " but this costs " + cost + "."
    };
  }

  const sheet = getSheet("REDEMPTIONS");
  sheet.appendRow([
    Utilities.getUuid(),          // Redemption ID
    data.studentId,                // Student ID
    data.studentName || "",        // Student Name
    data.tableNo || "",            // Table No
    data.itemName,                 // Item Name
    cost,                          // Points Cost
    new Date()                     // Redeemed At
  ]);

  notifyTableGuideOfRedemption(data, cost);

  return {
    success: true,
    message: data.itemName + " redeemed for " + cost + " pts",
    remainingPoints: available - cost
  };
}

/************************************************
 * QR SCANS
 ************************************************/

function addQRScan(data) {
  const sheet = getSheet("QR_SCANS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.qrCode,
    data.personType,
    data.personId,
    data.name,
    data.weekNo,
    data.scanType,
    new Date()
  ]);
  return {
    success: true,
    message: "QR Logged"
  };
}

/************************************************
 * DEVOTIONALS — Toggle single day
 ************************************************/

function toggleDevotional(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Devotional updated" };
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.dayNo,
    data.completed ? "Yes" : "No",
    new Date(),
    data.markedBy || ""
  ]);
  return { success: true, message: "Devotional recorded" };
}

/************************************************
 * TEAM GAMES — SOL2 Level Challenge
 ************************************************/

function toggleQuest(data) {
  const sheet  = getSheet("STUDENT_QUEST_PROGRESS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const levelNoCol   = headers.indexOf("Level No");
  const questNoCol   = headers.indexOf("Quest No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][levelNoCol]) === Number(data.levelNo) &&
        Number(values[i][questNoCol]) === Number(data.questNo)) {
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      if (data.completed) notifyTableGuideOfQuest(data);
      return { success: true, message: "Quest updated" };
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.levelNo,
    data.questNo,
    data.completed ? "Yes" : "No",
    new Date(),
    data.markedBy || ""
  ]);
  if (data.completed) notifyTableGuideOfQuest(data);
  return { success: true, message: "Quest recorded" };
}

/************************************************
 * VIDEO TESTIMONY UPLOAD
 ************************************************/

function uploadTestimonyVideo(data) {
  if (!data.base64Data) {
    return { success: false, message: "No video data received." };
  }
  if (!VIDEO_FOLDER_ID || VIDEO_FOLDER_ID.indexOf("PASTE_YOUR") === 0) {
    throw new Error("VIDEO_FOLDER_ID is not configured — see the setup notes at the top of this script.");
  }

  const folder = DriveApp.getFolderById(VIDEO_FOLDER_ID);
  const mimeType = data.mimeType || "video/mp4";
  const safeName = String(data.studentId || "student") + "_L" + data.levelNo + "Q" + data.questNo +
                    "_" + (data.fileName || "testimony.mp4");
  const bytes = Utilities.base64Decode(data.base64Data);
  const blob  = Utilities.newBlob(bytes, mimeType, safeName);
  const file  = folder.createFile(blob);

  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (shareErr) {
    // ignore — see comment above
  }

  const videoUrl = "https://drive.google.com/file/d/" + file.getId() + "/view";

  const sheet   = getSheet("STUDENT_VIDEO_SUBMISSIONS");
  const values  = sheet.getDataRange().getValues();
  if (values.length > 1) {
    const headers = values[0];
    const sidCol   = headers.indexOf("Student ID");
    const lvlCol   = headers.indexOf("Level No");
    const questCol = headers.indexOf("Quest No");
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][sidCol]) === String(data.studentId) &&
          Number(values[i][lvlCol]) === Number(data.levelNo) &&
          Number(values[i][questCol]) === Number(data.questNo)) {
        sheet.deleteRow(i + 1);
      }
    }
  }
  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.levelNo,
    data.questNo,
    videoUrl,
    data.fileName || "",
    Math.round(bytes.length / 1024),
    new Date()
  ]);

  toggleQuest({
    studentId: data.studentId,
    studentName: data.studentName,
    tableNo: data.tableNo,
    levelNo: data.levelNo,
    questNo: data.questNo,
    questTitle: data.questTitle || "Video Testimony",
    levelName: data.levelName || "",
    completed: true,
    markedBy: data.markedBy || data.studentName || ""
  });

  return { success: true, message: "Testimony video uploaded", videoUrl: videoUrl };
}

/************************************************
 * NOTIFICATIONS
 ************************************************/

function notifyTableGuideOfQuest(data) {
  const sheet = getSheet("NOTIFICATIONS");
  const questLabel = data.questTitle ? data.questTitle : ("Quest " + data.questNo);
  const levelLabel = data.levelName ? data.levelName : ("Level " + data.levelNo);
  const message = (data.studentName || "A student") + " completed \u201c" + questLabel +
                  "\u201d (" + levelLabel + ")";
  sheet.appendRow([
    Utilities.getUuid(),
    data.tableNo,
    data.studentId,
    data.studentName,
    data.levelNo,
    data.questNo,
    message,
    new Date(),
    "No",
    "",
    ""
  ]);
}

function notifyTableGuideOfRedemption(data, cost) {
  const sheet = getSheet("NOTIFICATIONS");
  const message = (data.studentName || "A student") + " redeemed \u201c" + data.itemName +
                  "\u201d (" + cost + " pts) — please prepare it for pickup at Table " + (data.tableNo || "—") + ".";
  sheet.appendRow([
    Utilities.getUuid(),
    data.tableNo,
    data.studentId,
    data.studentName,
    "",
    "",
    message,
    new Date(),
    "No",
    "",
    ""
  ]);
}

function sendAdminNotification(data) {
  if (!data.tableNo) return { success: false, message: "Missing tableNo." };
  const message = String(data.message || "").trim();
  if (!message) return { success: false, message: "Message can't be empty." };

  const sheet = getSheet("NOTIFICATIONS");
  sheet.appendRow([
    Utilities.getUuid(),
    data.tableNo,
    data.studentId || "",
    data.studentName || "",
    "",
    "",
    message,
    new Date(),
    "No",
    "",
    ""
  ]);

  return { success: true, message: "Notification sent to Table " + data.tableNo + "'s guide." };
}

function markNotificationRead(data) {
  const sheet   = getSheet("NOTIFICATIONS");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol      = headers.indexOf("Notification ID");
  const readCol    = headers.indexOf("Read");
  const readByCol  = headers.indexOf("Read By");
  const readAtCol  = headers.indexOf("Read At");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(data.notificationId)) {
      sheet.getRange(i + 1, readCol + 1).setValue("Yes");
      sheet.getRange(i + 1, readByCol + 1).setValue(data.readBy || "");
      sheet.getRange(i + 1, readAtCol + 1).setValue(new Date());
      return { success: true, message: "Notification marked read" };
    }
  }
  return { success: false, message: "Notification not found" };
}

function markAllNotificationsRead(data) {
  const sheet   = getSheet("NOTIFICATIONS");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const tableCol   = headers.indexOf("Table No");
  const readCol    = headers.indexOf("Read");
  const readByCol  = headers.indexOf("Read By");
  const readAtCol  = headers.indexOf("Read At");
  let count = 0;

  for (let i = 1; i < values.length; i++) {
    const matchesTable = data.tableNo === undefined || data.tableNo === null || data.tableNo === "" ||
                          String(values[i][tableCol]) === String(data.tableNo);
    if (matchesTable && String(values[i][readCol]) !== "Yes") {
      sheet.getRange(i + 1, readCol + 1).setValue("Yes");
      sheet.getRange(i + 1, readByCol + 1).setValue(data.readBy || "");
      sheet.getRange(i + 1, readAtCol + 1).setValue(new Date());
      count++;
    }
  }
  return { success: true, message: count + " notification(s) marked read" };
}

/************************************************
 * ACTIVITIES — Toggle single day
 ************************************************/

function toggleActivity(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Activity updated" };
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.dayNo,
    data.completed ? "Yes" : "No",
    new Date(),
    data.markedBy || ""
  ]);
  return { success: true, message: "Activity recorded" };
}

/************************************************
 * DEVOTIONALS — Bulk save
 ************************************************/

function saveStudentDevotionals(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  const completedDays = new Set(data.days || []);
  for (let day = 1; day <= 63; day++) {
    sheet.appendRow([
      Utilities.getUuid(),
      data.studentId,
      data.studentName,
      data.tableNo,
      day,
      completedDays.has(day) ? "Yes" : "No",
      new Date(),
      data.markedBy || ""
    ]);
  }
  return { success: true, message: "Devotionals saved" };
}

/************************************************
 * MODULE/LESSON COMPLETION
 ************************************************/

function toggleLessonCompletion(data) {
  const sheet   = getSheet("STUDENT_LESSON_COMPLETION");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const moduleCol    = headers.indexOf("Module No");
  const lessonCol    = headers.indexOf("Lesson No");
  const statusCol    = headers.indexOf("Status");
  const dateCol      = headers.indexOf("Date Marked");
  const markedByCol  = headers.indexOf("Marked By");

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][moduleCol]) === Number(data.moduleNo) &&
        Number(values[i][lessonCol]) === Number(data.lessonNo)) {
      sheet.getRange(i + 1, statusCol + 1).setValue(data.status || "");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      sheet.getRange(i + 1, markedByCol + 1).setValue(data.markedBy || "");
      return { success: true, message: "Lesson status updated" };
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.studentId,
    data.studentName,
    data.tableNo,
    data.moduleNo,
    data.lessonNo,
    data.status || "",
    new Date(),
    data.markedBy || ""
  ]);
  return { success: true, message: "Lesson status recorded" };
}

function saveStudentLessonCompletion(data) {
  const sheet   = getSheet("STUDENT_LESSON_COMPLETION");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  const statusMap = {};
  (data.lessons || []).forEach(function (l) {
    statusMap[l.module + "-" + l.lesson] = l.status || "";
  });

  const TOTAL_MODULES = 2;
  const LESSONS_PER_MODULE = 10;
  for (let m = 1; m <= TOTAL_MODULES; m++) {
    for (let l = 1; l <= LESSONS_PER_MODULE; l++) {
      sheet.appendRow([
        Utilities.getUuid(),
        data.studentId,
        data.studentName,
        data.tableNo,
        m,
        l,
        statusMap[m + "-" + l] || "",
        new Date(),
        data.markedBy || ""
      ]);
    }
  }
  return { success: true, message: "Module/Lesson completion saved" };
}

/************************************************
 * ACTIVITIES — Bulk save
 ************************************************/

function saveStudentActivities(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  const completedDays = new Set(data.days || []);
  for (let day = 1; day <= 63; day++) {
    sheet.appendRow([
      Utilities.getUuid(),
      data.studentId,
      data.studentName,
      data.tableNo,
      day,
      completedDays.has(day) ? "Yes" : "No",
      new Date(),
      data.markedBy || ""
    ]);
  }
  return { success: true, message: "Activities saved" };
}

/************************************************
 * MAKEUP STATUS
 ************************************************/

function updateMakeupStatus(data) {
  const sheet  = getSheet("MAKEUP_STATUS");
  const values = sheet.getDataRange().getValues();

  if (values.length > 1) {
    const headers     = values[0];
    const attIdCol    = headers.indexOf("Attendance ID");
    const statusCol   = headers.indexOf("Status");
    const updByCol    = headers.indexOf("Updated By");
    const updAtCol    = headers.indexOf("Updated At");
    const notesCol    = headers.indexOf("Notes");

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][attIdCol]) === String(data.attendanceId)) {
        sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
        sheet.getRange(i + 1, updByCol + 1).setValue(data.updatedBy || "");
        sheet.getRange(i + 1, updAtCol + 1).setValue(new Date());
        sheet.getRange(i + 1, notesCol + 1).setValue(data.notes || "");
        return { success: true, message: "Makeup status updated to " + data.status };
      }
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.attendanceId,
    data.studentId,
    data.studentName,
    data.weekNo,
    data.tableNo,
    data.status,
    data.updatedBy || "",
    new Date(),
    data.notes || ""
  ]);
  return { success: true, message: "Makeup status set to " + data.status };
}

/************************************************
 * MAKEUP WEEK ASSIGNMENT
 * Sheet: MAKEUP_WEEK_ASSIGNMENTS
 * Headers: Record ID | Week No | Assigned To | Updated By | Updated At
 *
 * One row per week. Assigns a single facilitator to handle ALL absent
 * students' make-up classes for that week, rather than assigning
 * per-student. Create this sheet (with those headers) if it doesn't
 * exist yet.
 ************************************************/

function updateMakeupWeekAssignment(data) {
  const sheet  = getSheet("MAKEUP_WEEK_ASSIGNMENTS");
  const values = sheet.getDataRange().getValues();

  if (values.length > 1) {
    const headers    = values[0];
    const weekCol     = headers.indexOf("Week No");
    const assignedCol = headers.indexOf("Assigned To");
    const updByCol    = headers.indexOf("Updated By");
    const updAtCol    = headers.indexOf("Updated At");

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][weekCol]) === String(data.weekNo)) {
        sheet.getRange(i + 1, assignedCol + 1).setValue(data.assignedTo || "");
        sheet.getRange(i + 1, updByCol + 1).setValue(data.updatedBy || "");
        sheet.getRange(i + 1, updAtCol + 1).setValue(new Date());
        return { success: true, message: "Week " + data.weekNo + " make-up class assigned to " + (data.assignedTo || "nobody") };
      }
    }
  }

  sheet.appendRow([
    Utilities.getUuid(),
    data.weekNo,
    data.assignedTo || "",
    data.updatedBy || "",
    new Date()
  ]);
  return { success: true, message: "Week " + data.weekNo + " make-up class assigned to " + (data.assignedTo || "nobody") };
}

/************************************************
 * STUDENT STATUS
 ************************************************/

function updateStudentStatus(data) {
  const sheet  = getSheet("STUDENTS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol     = headers.indexOf("Student ID");
  const statusCol = headers.indexOf("Status");
  const notesCol  = headers.indexOf("Drop Notes");

  if (idCol < 0 || statusCol < 0) {
    throw new Error("STUDENTS sheet missing 'Student ID' or 'Status' column.");
  }

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(data.studentId)) {
      sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
      if (notesCol >= 0 && data.notes) {
        sheet.getRange(i + 1, notesCol + 1).setValue(data.notes);
      }
      return {
        success: true,
        message: data.studentName + " status updated to " + data.status
      };
    }
  }
  return {
    success: false,
    message: "Student not found: " + data.studentId
  };
}

/************************************************
 * ADD STUDENT
 ************************************************/

function addStudent(data) {
  const sheet   = getSheet("STUDENTS");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol   = headers.indexOf("Student ID");

  if (idCol < 0) {
    throw new Error("STUDENTS sheet missing 'Student ID' column.");
  }
  if (!data.fullName) {
    return { success: false, message: "Full Name is required." };
  }

  let maxNum = 0;
  for (let i = 1; i < values.length; i++) {
    const idStr = String(values[i][idCol] || "");
    const m = idStr.match(/(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  const nextNum = maxNum + 1;
  const newId   = "STUDENT-" + ("0000" + nextNum).slice(-4);

  let facilitatorName = "";
  const tableGuides = getSheetData("TABLE_GUIDES").data;
  const guide = tableGuides.find(function (g) {
    return String(g["Table No"]) === String(data.tableNo);
  });
  if (guide) facilitatorName = guide["Facilitator Name"] || "";

  const registrationDate = new Date();
  const status = "Active";

  sheet.appendRow([
    newId,
    data.fullName || "",
    data.age || "",
    data.gender || "",
    data.lgLeader || "",
    data.networkLeader || "",
    data.tableNo || "",
    facilitatorName,
    data.contactNo || "",
    status,
    registrationDate
  ]);

  return {
    success: true,
    message: data.fullName + " added as " + newId,
    data: {
      "Student ID": newId,
      "Full Name": data.fullName || "",
      "Age": data.age || "",
      "Gender": data.gender || "",
      "LG Leader": data.lgLeader || "",
      "Network Leader": data.networkLeader || "",
      "Table No": data.tableNo || "",
      "Facilitator": facilitatorName,
      "Contact No": data.contactNo || "",
      "Status": status,
      "Registration Date": registrationDate
    }
  };
}

/************************************************
 * OUTPUT
 ************************************************/

function output(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
