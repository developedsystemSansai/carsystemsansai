// ════════════════════════════════════════════════════════════
//  SECTION 6: Anomaly & Notifications
// ════════════════════════════════════════════════════════════

function detectMileAnomaly(tripRow, odomEnd, distance) {
  const odomStart = Number(tripRow[7]) || 0;
  if (odomEnd < odomStart) {
    return { type:'ODOMETER_REVERSE',
             message:'เลขไมล์ปลาย (' + odomEnd + ') น้อยกว่าเลขไมล์ต้น (' + odomStart + ')',
             carType:tripRow[4], driver:tripRow[5] };
  }
  if (distance > 500) {
    return { type:'HIGH_DISTANCE',
             message:'ระยะทางสูงผิดปกติ: ' + distance + ' กม.',
             carType:tripRow[4], driver:tripRow[5] };
  }
  return null;
}

function notifyAnomaly(anomaly) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail({
      to     : NOTIFY_EMAIL,
      subject: '[Fleet Alert] ' + anomaly.type + ' — ' + anomaly.carType,
      body   : 'พบความผิดปกติ\nรถ: ' + anomaly.carType + '\nพนักงาน: ' + anomaly.driver + '\n' + anomaly.message
    });
  } catch (err) { console.warn('notifyAnomaly:', err.message); }
}

function sendEMSAlert(payload, failItems) {
  const subject = '[EMS Alert] อุปกรณ์ไม่พร้อม ' + failItems.length + ' รายการ — ' + payload.carId;
  let body = 'รถ: ' + payload.carId + '\nผู้ตรวจ: ' + payload.checkerName + '\n\nอุปกรณ์ที่มีปัญหา:\n';
  failItems.forEach(function(it) {
    body += '• ' + it.name + ' — ' + it.status + (it.note ? ' (' + it.note + ')' : '') + '\n';
  });
  if (NOTIFY_EMAIL) {
    try { MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body }); }
    catch (err) { console.warn('EMS alert:', err.message); }
  }
  if (LINE_TOKEN) sendLineNotify(body);
}

function checkExpiredItems(payload, items) {
  const today    = new Date();
  const warnDays = 30;
  const expiring = items.filter(function(it) {
    if (!it.expDate) return false;
    const exp  = new Date(it.expDate);
    const diff = (exp - today) / 86400000;
    return diff >= 0 && diff <= warnDays;
  });
  if (expiring.length > 0 && NOTIFY_EMAIL) {
    let body = 'อุปกรณ์ใกล้หมดอายุ (' + expiring.length + ' รายการ):\n';
    expiring.forEach(function(it) {
      body += '• ' + it.name + ' หมดอายุ: ' + it.expDate + '\n';
    });
    try { MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '[EMS] อุปกรณ์ใกล้หมดอายุ', body: body }); }
    catch (err) { console.warn('expiry alert:', err.message); }
  }
}

function sendLineNotify(msg) {
  if (!LINE_TOKEN) return;
  try {
    UrlFetchApp.fetch('https://notify-api.line.me/api/notify', {
      method     : 'post',
      headers    : { 'Authorization': 'Bearer ' + LINE_TOKEN },
      payload    : { message: msg },
      muteHttpExceptions: true
    });
  } catch (err) { console.warn('LINE notify:', err.message); }
}

// ════════════════════════════════════════════════════════════
//  SECTION 7: Utilities
// ════════════════════════════════════════════════════════════

function parseDateToYMD(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  if (typeof val === 'number' && val > 40000) {
    const d = new Date(Date.UTC(1899, 11, 30) + val * 86400000);
    return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const p = s.slice(0, 10).split('/');
    return p[2] + '-' + p[1] + '-' + p[0];
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s.slice(0, 10);
}

function getSpreadsheet() {
  if (SS_ID) return SpreadsheetApp.openById(SS_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setBackground('#0a2540');
    r.setFontColor('#ffffff');
    r.setFontWeight('bold');
    r.setHorizontalAlignment('center');
    sheet.setColumnWidths(1, headers.length, 140);
  }
  return sheet;
}

function getOrCreateSubFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function formatThaiDate(d) {
  return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
}
function formatTime(d) {
  return Utilities.formatDate(d, 'Asia/Bangkok', 'HH:mm');
}
function formatDisplayDate(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  try { return Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'); }
  catch (_) { return String(val); }
}

/**
 * formatTimeCell — แปลง cell ที่เป็น Time-only (หรือ Date จาก GAS) → "HH:mm:ss"
 * แก้ปัญหา GAS อ่าน Time cell แล้วได้ Date ฐาน 1899-12-30
 */
function formatTimeCell(val) {
  if (!val) return '';
  if (val instanceof Date) {
    try { return Utilities.formatDate(val, 'Asia/Bangkok', 'HH:mm:ss'); }
    catch (_) { return String(val); }
  }
  // ถ้าเป็น string ที่มี 1899 ให้ดึงเฉพาะเวลา
  const s = String(val);
  const m = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  return m ? m[1] : s;
}

/**
 * headerToKey — Thai header → camelCase key ที่ frontend ใช้
 * ต้องตรงกับ Dashboard STATUS_KEYS และ renderRecentRecords
 */
function headerToKey(h) {
  const map = {
    // ── Timestamp / ลำดับ ──
    'Timestamp'              : 'timestamp',
    'timestamp'              : 'timestamp',
    'ลำดับ'                  : '_rowNum',       // col A ในชีทจริง (ไม่ใช้)
    // ── วันที่ / เวลา ──
    'วันที่'                 : 'inspDate',
    'เวลา'                   : 'inspTime',
    // ── ทะเบียน / ผู้ตรวจ ──
    'ทะเบียน/ประเภทรถ'      : 'carType',
    'ทะเบียน/รถ'             : 'carType',       // ← header จริงในชีท
    'พนักงานขับรถ'           : 'driverName',
    'ผู้ตรวจ'                : 'driverName',    // ← header จริงในชีท CheckLog
    // ── ไมล์ ──
    'เลขไมล์'               : 'odometer',
    'ไมล์'                   : 'odometer',      // ← header จริงในชีท CheckLog
    // ── อุปกรณ์ ──
    'น้ำมันเครื่อง'          : 'eq_oil',
    'กระจกมองข้าง'           : 'eq_oil',       // ← header จริงในชีท (col 6 = กระจกมองข้าง mapping → eq_oil ตาม saveCheck)
    'แบตเตอรี่'              : 'eq_battery',
    'ระบบเบรค'               : 'eq_battery',   // ← header จริงในชีท (col 7 = ระบบเบรค mapping → eq_battery)
    'ยาง'                    : 'eq_tire',
    'น้ำในหม้อน้ำ'           : 'eq_tire',      // ← header จริงในชีท (col 8 = น้ำในหม้อน้ำ mapping → eq_tire)
    'ยางรถยนต์'              : 'eq_tire',      // ← col 24 ยางรถยนต์
    // ── น้ำมัน ──
    'ระดับน้ำมันเชื้อเพลิง' : 'fuelLevel',
    'ระดับน้ำมันเครื่อง'    : 'fuelLevel',     // ← col 10 ในชีทจริง
    'ปริมาณน้ำมัน'           : 'fuelLevel',     // ← col 20 ในชีทจริง
    'เติมน้ำมัน'             : 'fuelFill',
    'การเติมน้ำมัน'          : 'fuelFill',      // ← col 21 ในชีทจริง
    // ── รายการตรวจ (ชีทจริง col ตรงตามที่บันทึก) ──
    'กระจก'                  : 'chk_mirror',
    'เบรค'                   : 'chk_brake',
    'น้ำหม้อน้ำ'             : 'chk_coolant',
    'ช่วงล่าง'               : 'chk_suspension',
    'ระดับน้ำมันเครื่อง 2'  : 'chk_oilLevel',
    'ระดับน้ำมันเครื่อง2'   : 'chk_oilLevel',
    'ลมยาง'                  : 'chk_tirePressure',
    'ไฟหน้า'                 : 'chk_headlight',
    'ไฟท้าย'                 : 'chk_taillight',
    'ไฟท้าย/ไฟเบรค'          : 'chk_taillight', // ← header จริงในชีท
    'ไฟถอย'                  : 'chk_reverseLight',
    'แตร'                    : 'chk_horn',
    'เสียงแตร'               : 'chk_horn',      // ← header จริงในชีท
    'ที่ปัดน้ำฝน'            : 'chk_wiper',
    'แอร์'                   : 'chk_aircon',
    'เครื่องปรับอากาศ'       : 'chk_aircon',    // ← header จริงในชีท
    'ความสะอาดนอก'           : 'chk_exteriorClean',
    'ความสะอาดภายนอก'        : 'chk_exteriorClean', // ← header จริงในชีท
    'ความสะอาดใน'            : 'chk_interiorClean',
    'ความสะอาดภายใน'         : 'chk_interiorClean', // ← header จริงในชีท
    // ── หมายเหตุ / รูป ──
    'หมายเหตุ'               : 'remarks',
    'มีรูปแนบ'               : 'hasPhotos',
    'รูปถ่าย'                : 'hasPhotos',     // ← header จริงในชีท
    'DriveLinks'             : 'driveLinks',
    'DriveLinks_URLs'        : 'driveLinksUrls',
    // ── EMS / Refer fields ──
    'ระดับ O₂ (PSI)'         : 'chk_o2Level',
    'แสงไฟฉุกเฉิน'           : 'chk_emergencyLight',
    'เสียงไซเรน'              : 'chk_siren',
    'เปลและระบบล็อกเปล'       : 'chk_stretcherLock',
    'เครื่อง Suction'         : 'chk_suction',
    'AED/Defibrillator'       : 'chk_aed'
  };
  return map[h] !== undefined ? map[h] : h;
}
