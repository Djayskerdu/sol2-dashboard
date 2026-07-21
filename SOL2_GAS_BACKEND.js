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
 *  6. Deploy → Manage deployments → New deployment
 *     Execute as: Me | Who has access: Anyone
 ************************************************/

const SPREADSHEET_ID = "1zfWtx5dFfyvWSeL1fC_EHLBoK9cejZXdlSdRGyk0-Pk"; // ← REPLACE THIS

/************************************************
 * NEW SHEETS REQUIRED IN YOUR GOOGLE SPREADSHEET:
 *
 * Sheet: STUDENT_DEVOTIONALS
 * Headers (Row 1):
 *   Devotional ID | Student ID | Student Name | Table No | Day No | Completed | Date Marked | Marked By
 *
 * Sheet: STUDENT_ACTIVITIES
 * Headers (Row 1):
 *   Activity ID | Student ID | Student Name | Table No | Day No | Completed | Date Marked | Marked By
 *
 * Sheet: STUDENT_LESSON_COMPLETION   (Module/Lesson certificate tracker)
 * Headers (Row 1):
 *   Completion ID | Student ID | Student Name | Table No | Module No | Lesson No | Status | Date Marked | Marked By
 *   Status = "Done" (✓ completed) | "Makeup" (✗ needs make-up class) | "" (not yet marked)
 *   SOL2 has 2 Modules, 10 Lessons each (20 total). A student is Certificate-Eligible
 *   only when all 20 rows for that student are "Done".
 *
 * Sheet: TABLE_GUIDES
 * Headers (Row 1):
 *   Table No | Facilitator ID | Facilitator Name | Table Name | Total Students | Notes
 *   ↑ Add "Table Name" column (Column D) — e.g. "Glorious Warrior"
 *   The dashboard will display "Name | Table X" everywhere a table is shown.
 * Headers (Row 1):
 *   Makeup ID | Attendance ID | Student ID | Student Name | Week No | Table No | Status | Updated By | Updated At | Notes
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

      case "credits":
        return output(getSheetData("LC_CREDITS"));

      case "qrscans":
        return output(getSheetData("QR_SCANS"));

      case "tableGuides":
        return output(getSheetData("TABLE_GUIDES"));

      case "settings":
        return output(getSheetData("SYSTEM_SETTINGS"));

      // NEW: Devotionals
      case "devotionals":
        return output(getSheetData("STUDENT_DEVOTIONALS"));

      // NEW: Activities
      case "activities":
        return output(getSheetData("STUDENT_ACTIVITIES"));

      // NEW: Makeup status records
      case "makeupStatus":
        return output(getSheetData("MAKEUP_STATUS"));

      // NEW: Module/Lesson completion records (drives Certificate eligibility)
      case "lessonCompletion":
        return output(getSheetData("STUDENT_LESSON_COMPLETION"));

      // ── GAME SHOW STATE (cross-device sync) ──
      case "gameState":
        var gsRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        return output({ state: gsRaw ? JSON.parse(gsRaw) : null });

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

      case "addQRScan":
        return output(addQRScan(data));

      // NEW: Toggle a single devotional day for a student
      case "toggleDevotional":
        return output(toggleDevotional(data));

      // NEW: Toggle a single activity day for a student
      case "toggleActivity":
        return output(toggleActivity(data));

      // NEW: Bulk-save all devotional days for a student (replaces existing rows)
      case "saveStudentDevotionals":
        return output(saveStudentDevotionals(data));

      // NEW: Bulk-save all activity days for a student (replaces existing rows)
      case "saveStudentActivities":
        return output(saveStudentActivities(data));

      // NEW: Update makeup status for an absence record
      case "updateMakeupStatus":
        return output(updateMakeupStatus(data));

      // NEW: Set a single lesson's status ("Done" / "Makeup" / "") for a student
      case "toggleLessonCompletion":
        return output(toggleLessonCompletion(data));

      // NEW: Bulk-save all 20 module/lesson statuses for a student (replaces existing rows)
      case "saveStudentLessonCompletion":
        return output(saveStudentLessonCompletion(data));

      // NEW: Update student status (Active / Dropped)
      case "updateStudentStatus":
        return output(updateStudentStatus(data));

      // NEW: Add a new student (Director / Consultant / Record only —
      // front-end already gates this behind login before it's reachable)
      case "addStudent":
        return output(addStudent(data));
      // ── GAME SHOW STATE (cross-device sync) ──
      case "setGameState":
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(data.state));
        return output({ success: true });

      // appendGameEvent — used by phones to add a single event (buzz) without
      // overwriting the host's full event queue
      case "appendGameEvent":
        var gsAppRaw = PropertiesService.getScriptProperties().getProperty("GS_GAME_STATE");
        var gsAppState = gsAppRaw ? JSON.parse(gsAppRaw) : { events: [] };
        if (!gsAppState.events) gsAppState.events = [];
        gsAppState.events.push(data.event);
        if (gsAppState.events.length > 40) gsAppState.events = gsAppState.events.slice(-40);
        PropertiesService.getScriptProperties().setProperty("GS_GAME_STATE", JSON.stringify(gsAppState));
        return output({ success: true });

      // getGameState via POST — avoids GAS GET CDN caching on mobile devices
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
 * POINTS
 ************************************************/

function addCredit(data) {
  const sheet = getSheet("LC_CREDITS");
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
 * data: { studentId, studentName, tableNo, dayNo, completed, markedBy }
 ************************************************/

function toggleDevotional(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  // Check if row already exists for this student + day
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      // Update existing row
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Devotional updated" };
    }
  }

  // Insert new row
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
 * ACTIVITIES — Toggle single day
 * data: { studentId, studentName, tableNo, dayNo, completed, markedBy }
 ************************************************/

function toggleActivity(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");
  const dayNoCol     = headers.indexOf("Day No");
  const completedCol = headers.indexOf("Completed");
  const dateCol      = headers.indexOf("Date Marked");

  // Check if row already exists for this student + day
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][studentIdCol]) === String(data.studentId) &&
        Number(values[i][dayNoCol]) === Number(data.dayNo)) {
      // Update existing row
      sheet.getRange(i + 1, completedCol + 1).setValue(data.completed ? "Yes" : "No");
      sheet.getRange(i + 1, dateCol + 1).setValue(new Date());
      return { success: true, message: "Activity updated" };
    }
  }

  // Insert new row
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
 * DEVOTIONALS — Bulk save all days for a student
 * data: { studentId, studentName, tableNo, days: number[], markedBy }
 * "days" = array of day numbers that are completed
 ************************************************/

function saveStudentDevotionals(data) {
  const sheet  = getSheet("STUDENT_DEVOTIONALS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  // Delete all existing rows for this student (go bottom-up)
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  // Re-insert all completed days
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
 * MODULE/LESSON COMPLETION — Toggle a single lesson
 * data: { studentId, studentName, tableNo, moduleNo, lessonNo, status, markedBy }
 * status: "Done" | "Makeup" | "" (clears the mark)
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

/************************************************
 * MODULE/LESSON COMPLETION — Bulk save all 20 lessons for a student
 * data: { studentId, studentName, tableNo, lessons: [{module, lesson, status}], markedBy }
 * "lessons" only needs to include entries with a non-blank status; any
 * module/lesson not included is saved as "" (not yet marked).
 ************************************************/

function saveStudentLessonCompletion(data) {
  const sheet   = getSheet("STUDENT_LESSON_COMPLETION");
  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  // Delete all existing rows for this student (go bottom-up)
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  // Build a lookup of provided statuses
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
 * ACTIVITIES — Bulk save all days for a student
 ************************************************/

function saveStudentActivities(data) {
  const sheet  = getSheet("STUDENT_ACTIVITIES");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const studentIdCol = headers.indexOf("Student ID");

  // Delete all existing rows for this student
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][studentIdCol]) === String(data.studentId)) {
      sheet.deleteRow(i + 1);
    }
  }

  // Re-insert all completed days
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
 * MAKEUP STATUS — Update status on an absence record
 * Statuses: Pending | Scheduled | Done
 * data: { attendanceId, studentId, studentName, weekNo, tableNo, status, updatedBy, notes }
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

    // Update if existing row found
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

  // Insert new row
  sheet.appendRow([
    Utilities.getUuid(),          // Makeup ID
    data.attendanceId,            // Attendance ID (links back to STUDENT_ATTENDANCE)
    data.studentId,               // Student ID
    data.studentName,             // Student Name
    data.weekNo,                  // Week No
    data.tableNo,                 // Table No
    data.status,                  // Status: Pending | Scheduled | Done
    data.updatedBy || "",         // Updated By
    new Date(),                   // Updated At
    data.notes || ""              // Notes
  ]);
  return { success: true, message: "Makeup status set to " + data.status };
}

/************************************************
 * STUDENT STATUS — Update Active / Dropped
 * data: { studentId, studentName, status, notes? }
 * status values: "Active" | "Dropped"
 ************************************************/

function updateStudentStatus(data) {
  const sheet  = getSheet("STUDENTS");
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idCol     = headers.indexOf("Student ID");
  const statusCol = headers.indexOf("Status");
  const notesCol  = headers.indexOf("Drop Notes"); // optional column; add if needed

  if (idCol < 0 || statusCol < 0) {
    throw new Error("STUDENTS sheet missing 'Student ID' or 'Status' column.");
  }

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(data.studentId)) {
      sheet.getRange(i + 1, statusCol + 1).setValue(data.status);
      // Write notes to Drop Notes column if it exists
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
 * Student ID is generated here (next number after the highest
 * existing "STUDENT-####"), Facilitator is looked up from
 * TABLE_GUIDES based on the Table No chosen, Status defaults to
 * "Active", and Registration Date is set to right now.
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

  // Next sequential Student ID, e.g. STUDENT-0001 -> STUDENT-0002
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

  // Look up the Facilitator assigned to the chosen table
  let facilitatorName = "";
  const tableGuides = getSheetData("TABLE_GUIDES").data;
  const guide = tableGuides.find(function (g) {
    return String(g["Table No"]) === String(data.tableNo);
  });
  if (guide) facilitatorName = guide["Facilitator Name"] || "";

  const registrationDate = new Date();
  const status = "Active";

  sheet.appendRow([
    newId,                       // Student ID (auto)
    data.fullName || "",         // Full Name
    data.age || "",              // Age
    data.gender || "",           // Gender
    data.lgLeader || "",         // LG Leader
    data.networkLeader || "",    // Network Leader
    data.tableNo || "",          // Table No
    facilitatorName,             // Facilitator (auto, from Table Guide)
    data.contactNo || "",        // Contact No
    status,                      // Status (auto)
    registrationDate             // Registration Date (auto)
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