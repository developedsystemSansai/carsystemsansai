// ════════════════════════════════════════════════════════════
//  SECTION 2.5: แก้ไขข้อมูลเลขไมล์ (editmile.html)
//  ─────────────────────────────────────────────────────────
//  พขร. เข้ามาแก้ไขได้ (เลือกชื่อ ไม่ต้องรหัส) แต่การแก้ไขจะไม่มีผลทันที
//  ต้องรอแอดมิน (กรอกรหัส) เข้ามา "อนุมัติ" ก่อนถึงจะเขียนทับ MileLog จริง
//  ทุกการแก้ไขที่เกิดขึ้นจริง (ทั้งแอดมินแก้ตรง และอนุมัติคำขอ พขร.)
//  จะถูกบันทึกลง MileEditLog เพื่อตรวจสอบย้อนหลังได้เสมอ
// ════════════════════════════════════════════════════════════

const SHEET_PENDING_EDITS = 'PendingMileEdits';
const SHEET_MILE_EDIT_LOG = 'MileEditLog';
const EDITMILE_ADMIN_CODE = 'sansai2569'; // ✅ รหัสแอดมินสำหรับอนุมัติ/แก้ไขตรง (เช็คฝั่ง server เท่านั้น)

const PENDING_EDIT_HEADERS = [
  'RequestID','ประเภทคำขอ','Timestamp','TripID','ทะเบียน/รถ',
  'ฟิลด์ที่แก้(JSON)','ค่าเดิม(JSON)','ค่าใหม่(JSON)',
  'ผู้ขอแก้','เหตุผล','สถานะ','ผู้ตัดสินใจ','เวลาที่ตัดสินใจ','หมายเหตุการปฏิเสธ'
];

const MILE_EDIT_LOG_HEADERS = [
  'Timestamp','TripID','ทะเบียน/รถ','ฟิลด์ที่แก้','ค่าเดิม','ค่าใหม่',
  'ผู้ขอแก้','บทบาท','เหตุผล','ผู้อนุมัติ','เวลาที่อนุมัติ','สถานะ'
];

// ── ADMIN CODE: ตรวจรหัสแอดมินฝั่ง server (ไม่มีระบบล็อกเมื่อกรอกผิด) ──
// ผิดจะถูกบันทึกลง log ผ่าน logApiAccess_ เพื่อให้ตรวจย้อนหลังได้

/** ตรวจรหัสแอดมิน — ใช้ร่วมกันทุกจุดที่ต้องเช็ค adminCode
 *  คืนค่า { ok:boolean, message:string } */
function checkAdminCode_(payload) {
  const clientIp = String((payload && payload.clientIp) || 'unknown');
  const provided = String((payload && payload.adminCode || payload && payload.code) || '').trim();
  if (provided !== EDITMILE_ADMIN_CODE) {
    logApiAccess_('adminCode_fail', clientIp, false, (payload && payload.driverName) || '', (payload && (payload.carType || payload.plate)) || '');
    return { ok: false, message: 'รหัสแอดมินไม่ถูกต้อง' };
  }
  return { ok: true, message: '' };
}

/** verifyEditMileAdminCode — เช็ครหัสแอดมินฝั่ง server (payload:{code}) */
function verifyEditMileAdminCode(payload) {
  const result = checkAdminCode_(payload);
  return { status: 'ok', valid: result.ok };
}

/** หาแถวใน MileLog จาก TripID (คืน {rowIndex(1-indexed), headers, values} หรือ null) */
function findMileRowByTripId_(tripId) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return null;
  const range  = sheet.getDataRange();
  const values = range.getValues();
  const headers = values[0];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(tripId).trim()) {
      return { sheet: sheet, rowIndex: i + 1, headers: headers, row: values[i] };
    }
  }
  return null;
}

/** สร้าง snapshot ของทั้งแถว (สำหรับบันทึกไว้ตอนขอลบ/ลบจริง) → { ชื่อคอลัมน์: ค่า } */
function snapshotMileRow_(found) {
  const snap = {};
  found.headers.forEach(function (h, i) { snap[h] = found.row[i]; });
  return snap;
}

/**
 * submitMileEditRequest — พขร. ส่งคำขอแก้ไข (ไม่มีผลทันที รอแอดมินอนุมัติ)
 * payload: { tripId, fields:{ชื่อคอลัมน์:ค่าใหม่,...}, oldValues:{ชื่อคอลัมน์:ค่าเดิม,...}, requestedBy, reason }
 */
function submitMileEditRequest(payload) {
  const tripId = String(payload.tripId || '').trim();
  const fields = payload.fields || {};
  const reason = String(payload.reason || '').trim();
  const requestedBy = String(payload.requestedBy || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!Object.keys(fields).length) return { status: 'error', message: 'ไม่มีข้อมูลที่ต้องการแก้ไข' };
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอแก้ไข' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการแก้ไข' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  // ✅ NEW: ตรวจความสมเหตุสมผลตั้งแต่ตอนส่งคำขอ (เดิมไม่เช็คเลย จนกว่าแอดมินจะกดอนุมัติ)
  // กันคำขอที่ข้อมูลเพี้ยนตั้งแต่ต้นทาง (เช่น เลขไมล์ปลาย < เลขไมล์ต้น) ไม่ให้ไปค้างในคิวรออนุมัติ
  const preCheck = validateMileFields_(fields, found);
  if (!preCheck.ok) return { status: 'error', message: preCheck.message };

  const ss     = getSpreadsheet();
  const sheet  = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now    = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId  = 'REQ' + new Date().getTime();
  const plateIdx = found.headers.indexOf('ทะเบียน/รถ');
  const plate  = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';

  sheet.appendRow([
    reqId, 'แก้ไข', now, tripId, plate,
    JSON.stringify(fields), JSON.stringify(payload.oldValues || {}), JSON.stringify(fields),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอแก้ไขแล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/**
 * submitMileDeleteRequest — พขร. ส่งคำขอ "ลบ" ทริป (ไม่มีผลทันที รอแอดมินอนุมัติ)
 * payload: { tripId, requestedBy, reason }
 */
function submitMileDeleteRequest(payload) {
  const tripId = String(payload.tripId || '').trim();
  const reason = String(payload.reason || '').trim();
  const requestedBy = String(payload.requestedBy || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอลบ' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการขอลบ' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const ss     = getSpreadsheet();
  const sheet  = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now    = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId  = 'REQ' + new Date().getTime();
  const plateIdx = found.headers.indexOf('ทะเบียน/รถ');
  const plate  = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';
  const snapshot = snapshotMileRow_(found);

  sheet.appendRow([
    reqId, 'ลบ', now, tripId, plate,
    JSON.stringify({}), JSON.stringify(snapshot), JSON.stringify({}),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอลบทริปนี้แล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/** getPendingMileEdits — ดึงคำขอแก้ไข/ลบ ที่ "รอตรวจสอบ" ทั้งหมด (สำหรับแผงแอดมิน) */
function getPendingMileEdits() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [] };
  const rows = sheet.getDataRange().getValues();
  const data = rows.slice(1)
    .map(function (r, i) {
      return {
        rowIndex   : i + 2,
        requestId  : String(r[0] || ''),
        requestType: String(r[1] || 'แก้ไข'),
        timestamp  : String(r[2] || ''),
        tripId     : String(r[3] || ''),
        plate      : String(r[4] || ''),
        fields     : safeParseJson_(r[5]),
        oldValues  : safeParseJson_(r[6]),
        newValues  : safeParseJson_(r[7]),
        requestedBy: String(r[8] || ''),
        reason     : String(r[9] || ''),
        status     : String(r[10] || ''),
        decidedBy  : String(r[11] || ''),
        decidedAt  : String(r[12] || ''),
        rejectNote : String(r[13] || '')
      };
    })
    .filter(function (r) { return r.requestId && r.status === 'รอตรวจสอบ'; });
  return { status: 'ok', data: data };
}

function safeParseJson_(s) {
  try { return JSON.parse(String(s || '{}')); } catch (e) { return {}; }
}

/**
 * approveMileEdit — แอดมินอนุมัติคำขอ (แก้ไข หรือ ลบ): ทำการเปลี่ยนแปลงจริงใน MileLog + log ไว้
 * payload: { requestId, approvedBy, adminCode }
 */
function approveMileEdit(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const requestId = String(payload.requestId || '').trim();
  const approvedBy = String(payload.approvedBy || '').trim();
  if (!requestId) return { status: 'error', message: 'ไม่พบ RequestID' };

  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบคำขอแก้ไข' };
  const rows = sheet.getDataRange().getValues();
  let targetRow = -1, reqData = null;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === requestId) { targetRow = i + 1; reqData = rows[i]; break; }
  }
  if (targetRow < 0) return { status: 'error', message: 'ไม่พบคำขอแก้ไข (' + requestId + ')' };
  if (String(reqData[10]).trim() !== 'รอตรวจสอบ') {
    return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว (' + reqData[10] + ')' };
  }

  const requestType = String(reqData[1] || 'แก้ไข').trim();
  const tripId = String(reqData[3] || '').trim();
  const reason = String(reqData[9] || '');
  const requestedBy = String(reqData[8] || '');
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  // ✅ NEW: 'เพิ่มน้ำมัน' ไม่มี TripID เดิมให้อ้างอิง (สร้างแถวใหม่ทั้งแถว) ต้องจัดการแยกจาก
  // 'แก้ไข'/'ลบ' ก่อนถึงจุดที่โค้ดด้านล่างพยายาม findMileRowByTripId_ (ซึ่งจะหาไม่เจอเสมอ)
  if (requestType === 'เพิ่มน้ำมัน') {
    const newFields = safeParseJson_(reqData[7]);
    const check = validateFuelBacklogFields_(newFields);
    if (!check.ok) {
      return { status: 'error', message: 'คำขอนี้มีข้อมูลไม่ถูกต้อง จึงยังไม่อนุมัติ: ' + check.message };
    }
    const newTripId = addFuelBacklogEntry_(newFields);
    const logSheet2 = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
    logSheet2.appendRow([
      now, newTripId, String(reqData[4] || ''), '(เพิ่มรายการน้ำมันย้อนหลัง — ไม่มีทริปเดิม)',
      '', 'ลิตร:' + newFields.fuelLiters + ' ราคา:' + (newFields.fuelPrice || '-'),
      requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'อนุมัติแล้ว'
    ]);
    sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
    SpreadsheetApp.flush();
    return { status: 'ok', message: 'อนุมัติและเพิ่มรายการน้ำมันย้อนหลังเรียบร้อย', tripId: newTripId };
  }

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog แล้ว (อาจถูกลบไปก่อนหน้า)' };

  if (requestType === 'ลบ') {
    deleteMileRowAndLog_(found, requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'ลบแล้ว (อนุมัติ)');
    sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
    SpreadsheetApp.flush();
    return { status: 'ok', message: 'อนุมัติและลบทริปนี้เรียบร้อย' };
  }

  const fields = safeParseJson_(reqData[7]);   // ค่าใหม่
  const oldValues = safeParseJson_(reqData[6]);
  const writeResult = writeMileFieldsAndLog_(found, fields, oldValues, requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'อนุมัติแล้ว');
  if (!writeResult.ok) {
    // ✅ FIX: เดิมถ้าข้อมูลในคำขอเพี้ยน (เช่น พขร. ขอแก้เป็นสถานะแปลกๆ หรือเลขไมล์ปลาย < เลขไมล์ต้น)
    // แอดมินกด "อนุมัติ" แล้วจะเงียบๆ ไม่มีอะไรเกิดขึ้นจริง แต่คำขอถูกปิดเป็น "อนุมัติแล้ว" ไปแล้ว —
    // ผลคือดูเหมือนอนุมัติสำเร็จ แต่ข้อมูลจริงใน MileLog ไม่ได้เปลี่ยนอะไรเลย
    // ตอนนี้แจ้ง error กลับให้แอดมินเห็นทันที และไม่ปิดคำขอ (ยังคงเป็น "รอตรวจสอบ" ให้แก้ไขคำขอใหม่)
    return { status: 'error', message: 'คำขอนี้มีข้อมูลไม่ถูกต้อง จึงยังไม่อนุมัติ: ' + writeResult.message };
  }

  sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'อนุมัติและบันทึกการแก้ไขเรียบร้อย' + (writeResult.message ? (' ' + writeResult.message) : '') };
}

/** rejectMileEdit — แอดมินปฏิเสธคำขอ (แก้ไขหรือลบ) payload:{ requestId, rejectedBy, rejectReason, adminCode } */
function rejectMileEdit(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const requestId = String(payload.requestId || '').trim();
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบคำขอแก้ไข' };
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === requestId) {
      const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      sheet.getRange(i + 1, 11, 1, 4).setValues([[
        'ปฏิเสธ', String(payload.rejectedBy || ''), now, String(payload.rejectReason || '')
      ]]);
      return { status: 'ok', message: 'ปฏิเสธคำขอแล้ว' };
    }
  }
  return { status: 'error', message: 'ไม่พบคำขอแก้ไข (' + requestId + ')' };
}

/**
 * directEditMileRow — แอดมินแก้ไขตรง มีผลทันที + log ทันที
 * payload: { tripId, fields:{...}, oldValues:{...}, editedBy, reason, adminCode }
 */
function directEditMileRow(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const tripId = String(payload.tripId || '').trim();
  const fields = payload.fields || {};
  const editedBy = String(payload.editedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!Object.keys(fields).length) return { status: 'error', message: 'ไม่มีข้อมูลที่ต้องการแก้ไข' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการแก้ไข' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const writeResult = writeMileFieldsAndLog_(found, fields, payload.oldValues || {}, editedBy, 'แอดมิน (แก้ไขตรง)', reason, editedBy, now, 'แก้ไขโดยแอดมิน');
  if (!writeResult.ok) return { status: 'error', message: writeResult.message };

  return { status: 'ok', message: 'บันทึกการแก้ไขเรียบร้อย' + (writeResult.message ? (' ' + writeResult.message) : '') };
}

/**
 * directDeleteMileRow — แอดมินลบทริปตรง มีผลทันที + log ทันที
 * payload: { tripId, editedBy, reason, adminCode }
 */
function directDeleteMileRow(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const tripId = String(payload.tripId || '').trim();
  const editedBy = String(payload.editedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการลบ' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  deleteMileRowAndLog_(found, editedBy, 'แอดมิน (ลบตรง)', reason, editedBy, now, 'ลบโดยแอดมิน');

  return { status: 'ok', message: 'ลบทริปนี้เรียบร้อย' };
}

/** ลบแถวจริงออกจาก MileLog + เขียน log การลบไว้ใน MileEditLog (เก็บ snapshot ทั้งแถวไว้เป็นค่าเดิม) */
function deleteMileRowAndLog_(found, requestedBy, role, reason, approvedBy, decidedAt, statusLabel) {
  const snapshot = snapshotMileRow_(found);
  const headers = found.headers;
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  const plate = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';
  const wasLatestForPlate = isLatestMileRowForPlate_(found.sheet, headers, found.rowIndex, plate);

  const ss = getSpreadsheet();
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  const logNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  logSheet.appendRow([
    logNow, found.row[0], plate, '(ลบทั้งแถว)',
    JSON.stringify(snapshot), '', requestedBy, role, reason, approvedBy, decidedAt, statusLabel
  ]);

  found.sheet.deleteRow(found.rowIndex);
  SpreadsheetApp.flush();

  // ✅ NEW: ถ้าลบทริปที่เป็น "แถวล่าสุด" ของทะเบียนนี้ (ตัวที่กำหนดสถานะปัจจุบันของรถใน Vehicles sheet)
  // ต้องหาแถวที่เหลือที่ใหม่ที่สุดของทะเบียนนี้มาซิงค์สถานะแทน — ถ้าไม่มีทริปเหลือเลย ให้ตั้งกลับเป็น
  // "พร้อมใช้งาน" ว่างคนขับ/ปลายทาง (ไม่งั้น Vehicles sheet จะค้างอ้างอิงทริปที่ถูกลบไปแล้ว)
  if (wasLatestForPlate && plate) {
    try {
      const ss2    = getSpreadsheet();
      const sheet2 = ss2.getSheetByName(SHEET_MILE);
      let restored = false;
      if (sheet2 && sheet2.getLastRow() > 1) {
        const data2 = sheet2.getDataRange().getValues();
        const hdrs2 = data2[0];
        const plateIdx2 = hdrs2.indexOf('ทะเบียน/รถ');
        const shortPlate = String(plate || '').split(' ')[0].trim();
        for (let i = data2.length - 1; i >= 1; i--) {
          const rowPlateFull = String(data2[i][plateIdx2] || '').trim();
          const rowShortPlate = rowPlateFull.split(' ')[0].trim();
          if (rowShortPlate && (rowShortPlate === shortPlate || rowPlateFull.includes(shortPlate) || shortPlate.includes(rowShortPlate))) {
            const st  = String(data2[i][hdrs2.indexOf('สถานะ')] || 'พร้อมใช้งาน');
            const drv = String(data2[i][hdrs2.indexOf('พนักงานขับรถ')] || '');
            const dst = String(data2[i][hdrs2.indexOf('ปลายทาง')] || '');
            updateVehicleStatus(rowPlateFull, st, drv, st === 'กำลังใช้งาน' ? dst : '');
            restored = true;
            break;
          }
        }
      }
      if (!restored) updateVehicleStatus(plate, 'พร้อมใช้งาน', '', '');
    } catch (syncErr) {
      console.warn('deleteMileRowAndLog_ vehicle sync error:', syncErr.message);
    }
  }
}

/**
 * validateMileFields_ — ตรวจความสมเหตุสมผลของฟิลด์ที่จะเขียนก่อนแตะข้อมูลจริงใน MileLog
 * (ใช้ร่วมกันทั้ง submitMileEditRequest / directEditMileRow / approveMileEdit
 *  เพื่อกันข้อมูลเพี้ยนไม่ว่าจะแก้ผ่านเส้นทางไหน — เดิมไม่มีการเช็คนี้เลย ทำให้:
 *   - พิมพ์ "สถานะ" อะไรก็ได้ ทั้งที่หน้าอื่น (dashboard/startmile/endMile) เทียบ string
 *     ตรงตัวกับ 'กำลังใช้งาน'/'พร้อมใช้งาน' เท่านั้น พิมพ์ผิดแม้แค่วรรค ก็ทำให้รถนั้น
 *     หายไปจากทุก query ที่กรองด้วยสถานะ
 *   - เลขไมล์ปลาย < เลขไมล์ต้น หรือติดลบ เขียนลงชีทได้ตรงๆ โดยไม่มีใครเตือน
 * คืนค่า { ok:boolean, message:string } — ok:false ต้องไม่เขียนอะไรลงชีทเลย)
 */
/**
 * resolveMileColIdx_ — หา index คอลัมน์ใน MileLog จาก "ชื่อฟิลด์มาตรฐาน" ที่ editmile.html ส่งมา
 * ✅ NEW: แก้บั๊ก — โค้ดเดิมใช้ headers.indexOf(fieldName) แบบตรงตัวเป๊ะๆ เพียงอย่างเดียว แต่ชีท MileLog
 * จริงบางช่วง/บางไฟล์ตั้งชื่อ header ต่างไปเล็กน้อยจากชื่อมาตรฐานที่โค้ดคาดหวัง (เช่น คอลัมน์ราคาน้ำมัน
 * ในชีทจริงชื่อ "ราคาน้ำมัน" เฉยๆ ไม่มี "(บาท)" ต่อท้ายแบบที่โค้ดค้นหา) พอ indexOf() หาไม่เจอ
 * (คืน -1) โค้ดเดิมจะ "ข้ามเงียบๆ" ไม่เขียนอะไรลงชีทเลย โดยไม่มี error ให้เห็นเลย — ทำให้กรอกราคาน้ำมัน
 * ในฟอร์มแก้ไขแล้ว "หาย" ไม่ลงชีทจริง ทั้งที่ลิตรบันทึกได้ปกติ (เพราะชื่อคอลัมน์ลิตรตรงกันพอดี)
 * ฟังก์ชันนี้ลองไล่ชื่อ alias ที่เคยพบจริงในชีท (อ้างอิงจาก EXPECTED_HEADERS/alias keys ที่มีอยู่แล้ว
 * ในส่วนอ่านข้อมูล getMileLogData) ก่อนจะยอมแพ้คืน -1
 */
var MILE_FIELD_ALIASES_ = {
  'ราคาน้ำมัน(บาท)'     : ['ราคาน้ำมัน(บาท)', 'ราคาน้ำมัน'],
  'น้ำมันที่เติม(ลิตร)'  : ['น้ำมันที่เติม(ลิตร)', 'น้ำมันที่เติม', 'เติมน้ำมัน(ลิตร)'],
  'เลขไมล์ต้น'           : ['เลขไมล์ต้น', 'ไมล์เริ่มต้น'],
  'เลขไมล์ปลาย'          : ['เลขไมล์ปลาย', 'ไมล์สิ้นสุด'],
  'TripID'                : ['TripID', 'รหัสทริป'],
  'ลิตรเติมขากลับ'        : ['ลิตรเติมขากลับ'],
  'ราคาเติมขากลับ(บาท)'   : ['ราคาเติมขากลับ(บาท)']
};
// คอลัมน์น้ำมัน "ตอนกลับ" ถูกสร้างอัตโนมัติโดย writeExtraField ตอน endMile (จึงอาจยังไม่มีในชีท)
// editmile.html แก้ไขสองคอลัมน์นี้ได้ — ถ้ายังไม่มีให้สร้างตอนบันทึก แทนที่จะเงียบหรือแจ้งว่าไม่พบคอลัมน์
var MILE_RETURN_FUEL_COLS_ = ['ลิตรเติมขากลับ', 'ราคาเติมขากลับ(บาท)'];
function numPos_(v) { var x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return x > 0 ? x : 0; }
function resolveMileColIdx_(headers, fieldName) {
  var aliases = MILE_FIELD_ALIASES_[fieldName] || [fieldName];
  for (var i = 0; i < aliases.length; i++) {
    var idx = headers.indexOf(aliases[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

function validateMileFields_(fields, found) {
  const headers = found.headers;
  const row = found.row;
  const VALID_MILE_STATUS = ['กำลังใช้งาน', 'พร้อมใช้งาน'];

  if ('สถานะ' in fields) {
    const st = String(fields['สถานะ'] || '').trim();
    if (VALID_MILE_STATUS.indexOf(st) < 0) {
      return { ok: false, message: 'สถานะไม่ถูกต้อง — ต้องเป็น "กำลังใช้งาน" หรือ "พร้อมใช้งาน" เท่านั้น' };
    }
  }
  if ('ทะเบียน/รถ' in fields && !String(fields['ทะเบียน/รถ'] || '').trim()) {
    return { ok: false, message: 'กรุณาระบุทะเบียน/รถ ห้ามเว้นว่าง' };
  }
  if ('พนักงานขับรถ' in fields && !String(fields['พนักงานขับรถ'] || '').trim()) {
    return { ok: false, message: 'กรุณาระบุพนักงานขับรถ ห้ามเว้นว่าง' };
  }

  const startIdx = resolveMileColIdx_(headers, 'เลขไมล์ต้น');
  const endIdx   = resolveMileColIdx_(headers, 'เลขไมล์ปลาย');

  function currentOrNew(fieldName, idx) {
    if (fieldName in fields) return fields[fieldName];
    return idx >= 0 ? row[idx] : '';
  }

  if ('เลขไมล์ต้น' in fields) {
    const v = fields['เลขไมล์ต้น'];
    if (v === '' || v === null || isNaN(Number(v)) || Number(v) < 0) {
      return { ok: false, message: 'เลขไมล์ต้นต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  if ('เลขไมล์ปลาย' in fields) {
    const v = fields['เลขไมล์ปลาย'];
    // เลขไมล์ปลายเว้นว่างได้ (กรณีทริปยังไม่กลับ) — เช็คเฉพาะตอนมีค่าจริง
    if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
      return { ok: false, message: 'เลขไมล์ปลายต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }

  if (startIdx >= 0 && endIdx >= 0 && ('เลขไมล์ต้น' in fields || 'เลขไมล์ปลาย' in fields)) {
    const s = Number(currentOrNew('เลขไมล์ต้น', startIdx));
    const eRaw = currentOrNew('เลขไมล์ปลาย', endIdx);
    const e = Number(eRaw);
    if (eRaw !== '' && !isNaN(s) && !isNaN(e) && e < s) {
      return { ok: false, message: 'เลขไมล์ปลาย (' + e + ') ต้องไม่น้อยกว่าเลขไมล์ต้น (' + s + ')' };
    }
  }

  // ✅ NEW: ตรวจฟิลด์เติมน้ำมันย้อนหลัง (ใช้ตอนแอดมิน/พขร. แก้ไข MileLog ผ่าน editmile.html
  // เพื่อลงบิลน้ำมันของทริปเก่าที่ตอนออกรถ/กลับรถลืมกรอกไว้ — dashboard อ่านค่าจาก 2 คอลัมน์นี้
  // ตรงๆ เพื่อคำนวณอัตราสิ้นเปลืองและต้นทุนน้ำมัน ดังนั้นต้องเป็นตัวเลขไม่ติดลบเท่านั้น เว้นว่างได้)
  if ('น้ำมันที่เติม(ลิตร)' in fields) {
    const v = fields['น้ำมันที่เติม(ลิตร)'];
    // ✅ FIX: startmile.html (ปุ่ม "ไม่ได้เติมน้ำมันจริง") ส่งค่าพิเศษ 'ไม่เติม' มาเพื่อยืนยันว่าไม่ได้เติมน้ำมัน
    // (ใช้ปิดการแจ้งเตือน LINE — ดู caseA ใน getFuelAlert/ตัวเช็ค fuelMarkerRaw) เดิม validator ตีกลับเพราะไม่ใช่ตัวเลข
    // ทำให้ยกเลิกรายการไม่ได้ → ยอมรับเฉพาะค่านี้ค่าเดียว ส่วนข้อความอื่นยังถูกปฏิเสธเหมือนเดิม
    const isNoFuelMarker = String(v == null ? '' : v).trim() === 'ไม่เติม';
    if (!isNoFuelMarker) {
      if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
        return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) ต้องเป็นตัวเลขไม่ติดลบ' };
      }
      if (!isNaN(Number(v)) && Number(v) > 500) {
        return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) สูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
      }
    }
  }
  if ('ราคาน้ำมัน(บาท)' in fields) {
    const v = fields['ราคาน้ำมัน(บาท)'];
    if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
      return { ok: false, message: 'ราคาน้ำมัน (บาท) ต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  // ✅ NEW: น้ำมันตอนกลับ (ลิตรเติมขากลับ / ราคาเติมขากลับ(บาท)) — กติกาเดียวกับชุดตอนออก
  if ('ลิตรเติมขากลับ' in fields) {
    const rv = fields['ลิตรเติมขากลับ'];
    if (rv !== '' && rv !== null && (isNaN(Number(rv)) || Number(rv) < 0)) {
      return { ok: false, message: 'ลิตรที่เติมตอนกลับต้องเป็นตัวเลขไม่ติดลบ' };
    }
    if (rv !== '' && Number(rv) > 500) {
      return { ok: false, message: 'ลิตรที่เติมตอนกลับสูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
    }
  }
  if ('ราคาเติมขากลับ(บาท)' in fields) {
    const rp = fields['ราคาเติมขากลับ(บาท)'];
    if (rp !== '' && rp !== null && (isNaN(Number(rp)) || Number(rp) < 0)) {
      return { ok: false, message: 'ราคาที่เติมตอนกลับต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  if ('ลิตรเติมขากลับ' in fields && fields['ลิตรเติมขากลับ'] !== '' && Number(fields['ลิตรเติมขากลับ']) === 0 &&
      numPos_(fields['ราคาเติมขากลับ(บาท)']) > 0) {
    return { ok: false, message: 'กรอกราคาตอนกลับแล้วแต่ลิตร = 0 — กรุณาตรวจสอบจำนวนลิตรอีกครั้ง' };
  }

  // ถ้ากรอกราคาแต่ไม่กรอกลิตร (หรือกลับกัน) ไม่ block — บางบิลอาจมีแค่ราคารวมไม่มีลิตรระบุ
  // แต่เตือนกรณีกรอกลิตร=0 พร้อมราคา>0 (มักเป็นการพิมพ์ผิดคอลัมน์)
  {
    const litersNew = 'น้ำมันที่เติม(ลิตร)' in fields ? Number(fields['น้ำมันที่เติม(ลิตร)']) : null;
    const priceNew  = 'ราคาน้ำมัน(บาท)' in fields ? Number(fields['ราคาน้ำมัน(บาท)']) : null;
    if (litersNew === 0 && priceNew > 0) {
      return { ok: false, message: 'กรอกราคาน้ำมันแล้วแต่ลิตร = 0 — กรุณาตรวจสอบจำนวนลิตรที่เติมอีกครั้ง' };
    }
  }

  return { ok: true, message: '' };
}

/**
 * isLatestMileRowForPlate_ — เช็คว่าแถวที่กำลังจะแก้ เป็นแถว "ล่าสุด" ของทะเบียนนี้ใน MileLog หรือไม่
 * ใช้ตัดสินใจว่าควรซิงค์ค่าไปยัง Vehicles sheet หรือไม่ (Vehicles สะท้อน "สถานะปัจจุบัน" ของรถ
 * ซึ่งควรมาจากทริปล่าสุดของรถคันนั้นเท่านั้น ไม่ใช่ทริปเก่าที่ผ่านไปแล้ว)
 */
function isLatestMileRowForPlate_(sheet, headers, rowIndex, plate) {
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  if (plateIdx < 0) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  const shortPlate = String(plate || '').split(' ')[0].trim();
  if (!shortPlate) return false;
  const plateCol = sheet.getRange(2, plateIdx + 1, lastRow - 1, 1).getValues();
  for (let i = plateCol.length - 1; i >= 0; i--) {
    const r = i + 2; // เลขแถวจริง (1-indexed, header คือแถว 1)
    const rowPlateFull  = String(plateCol[i][0] || '').trim();
    const rowShortPlate = rowPlateFull.split(' ')[0].trim();
    if (rowShortPlate && (rowShortPlate === shortPlate || rowPlateFull.includes(shortPlate) || shortPlate.includes(rowShortPlate))) {
      return r === rowIndex;
    }
  }
  return false;
}

/**
 * syncVehicleFromMileRow_ — ซิงค์ Vehicles sheet ให้ตรงกับแถว MileLog ที่เพิ่งแก้ไข
 * ✅ FIX: เดิม startMile()/endMile() อัปเดต Vehicles sheet ทุกครั้งที่ออก/กลับรถ แต่
 * directEditMileRow / approveMileEdit (แก้ไข "สถานะ"/"พนักงานขับรถ"/"ปลายทาง"/"ทะเบียน/รถ"
 * ของทริปโดยแอดมิน) ไม่เคยอัปเดต Vehicles sheet เลย ทำให้หน้า dashboard/index/startmile
 * ที่อ่านสถานะรถจาก Vehicles sheet โชว์ข้อมูลเก่าค้าง ไม่ตรงกับ MileLog ที่เพิ่งแก้ไป
 * ทำงานเฉพาะตอนแถวที่แก้เป็นแถว "ล่าสุด" ของทะเบียนนั้น (ทริปที่กำหนดสถานะปัจจุบันของรถอยู่)
 */
function syncVehicleFromMileRow_(found, fields) {
  try {
    const syncTriggerFields = ['สถานะ', 'พนักงานขับรถ', 'ปลายทาง', 'ทะเบียน/รถ'];
    const touched = syncTriggerFields.some(function (f) { return f in fields; });
    if (!touched) return;

    const sheet = found.sheet;
    const headers = found.headers;
    const rowIndex = found.rowIndex;
    const plateIdxOld = headers.indexOf('ทะเบียน/รถ');
    const plateForCheck = plateIdxOld >= 0 ? String(found.row[plateIdxOld] || '') : '';

    if (!isLatestMileRowForPlate_(sheet, headers, rowIndex, plateForCheck)) return;

    const freshRow = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idxOf = function (name) { return headers.indexOf(name); };
    const readFresh = function (name) { const i = idxOf(name); return i >= 0 ? String(freshRow[i] || '') : ''; };

    const newPlate  = readFresh('ทะเบียน/รถ') || plateForCheck;
    const newStatus = readFresh('สถานะ') || 'พร้อมใช้งาน';
    const newDriver = readFresh('พนักงานขับรถ');
    const newDest   = readFresh('ปลายทาง');

    updateVehicleStatus(newPlate, newStatus, newDriver, newStatus === 'กำลังใช้งาน' ? newDest : '');
  } catch (syncErr) {
    console.warn('syncVehicleFromMileRow_ error:', syncErr.message);
  }
}

/**
 * FuelLog — ✅ NEW: บันทึกลิตร/จำนวนเงินน้ำมัน "ทุกครั้งที่บันทึก" 1 แถวต่อ 1 การบันทึก (ต่อท้ายเสมอ ไม่ทับของเดิม)
 * ใช้ดูย้อนหลัง/รวมยอดได้ง่ายกว่า MileEditLog (ที่เก็บทีละฟิลด์ ค่าเดิม→ค่าใหม่)
 * ห่อ try/catch — ถ้าเขียน FuelLog ไม่สำเร็จ จะไม่ทำให้การบันทึกหลักล้มเหลว
 */
const SHEET_FUEL_LOG = 'FuelLog';
const FUEL_LOG_HEADERS = ['วันเวลาที่บันทึก', 'TripID', 'ทะเบียน/รถ', 'จำนวนลิตร', 'จำนวนเงิน(บาท)', 'ประเภท', 'ผู้บันทึก', 'เหตุผล/หมายเหตุ'];
function appendFuelLog_(tripId, plate, liters, price, kind, by, note) {
  try {
    const ss = getSpreadsheet();
    const sh = getOrCreateSheet(ss, SHEET_FUEL_LOG, FUEL_LOG_HEADERS);
    const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sh.appendRow([now, String(tripId == null ? '' : tripId), String(plate || ''),
      liters === '' || liters == null ? '' : liters, price === '' || price == null ? '' : price,
      kind || '', String(by || ''), String(note || '')]);
  } catch (e) {
    console.warn('appendFuelLog_ error:', e.message);
  }
}

/** เขียนค่าใหม่ลง MileLog ตามชื่อคอลัมน์จริง + เขียน MileEditLog 1 แถวต่อ 1 ฟิลด์ที่เปลี่ยน
 *  คืนค่า { ok:boolean, message:string } — ok:false แปลว่าไม่ผ่านการตรวจสอบ ไม่มีการเขียนใดๆเกิดขึ้น */
function writeMileFieldsAndLog_(found, fields, oldValues, requestedBy, role, reason, approvedBy, decidedAt, statusLabel) {
  const check = validateMileFields_(fields, found);
  if (!check.ok) return check;

  const sheet = found.sheet;
  const headers = found.headers;
  const rowIndex = found.rowIndex;
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  const plate = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';

  const ss = getSpreadsheet();
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  const logNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  // ✅ FIX: เดิมใช้ headers.indexOf(fieldName) ตรงตัวเป๊ะๆ เพียงอย่างเดียว — ถ้าชื่อ header ในชีทจริง
  // ต่างจากชื่อมาตรฐานเพียงเล็กน้อย (เช่น "ราคาน้ำมัน" ไม่มี "(บาท)" ต่อท้าย) จะหาคอลัมน์ไม่เจอ (-1)
  // แล้ว "ข้ามเงียบๆ" ไม่เขียนอะไรลงชีทเลย โดยไม่มี error ให้เห็น — ทำให้ค่าที่กรอกในฟอร์ม "หาย" ไปจริงๆ
  // ตอนบันทึก ใช้ resolveMileColIdx_() แทน เพื่อลองหาด้วยชื่อ alias ที่เคยพบจริงในชีทก่อนจะถือว่าไม่มีคอลัมน์นี้
  // และเก็บรายชื่อฟิลด์ที่ยังหาคอลัมน์ไม่เจอไว้แจ้งเตือนกลับไป แทนที่จะเงียบเหมือนเดิม
  const unresolvedFields = [];
  Object.keys(fields).forEach(function (fieldName) {
    let colIdx = resolveMileColIdx_(headers, fieldName);
    if (colIdx < 0 && MILE_RETURN_FUEL_COLS_.indexOf(fieldName) >= 0) {
      colIdx = ensureExtraColumn(sheet, fieldName);   // สร้างคอลัมน์น้ำมันตอนกลับให้ ถ้ายังไม่เคยมีใครเติมตอนกลับ
    }
    if (colIdx < 0) { unresolvedFields.push(fieldName); return; } // ไม่พบคอลัมน์นี้จริงๆ ในชีท (แม้ลอง alias แล้ว)
    const newVal = fields[fieldName];
    sheet.getRange(rowIndex, colIdx + 1).setValue(newVal);
    logSheet.appendRow([
      logNow, found.row[0], plate, fieldName,
      oldValues[fieldName] != null ? oldValues[fieldName] : '',
      newVal, requestedBy, role, reason, approvedBy, decidedAt, statusLabel
    ]);
  });

  // ✅ NEW: ถ้าการบันทึกนี้แตะลิตร/ราคาน้ำมัน → ลง FuelLog ด้วยทุกครั้ง ('ไม่เติม' = ลิตร 0 ราคา 0)
  if ('น้ำมันที่เติม(ลิตร)' in fields || 'ราคาน้ำมัน(บาท)' in fields) {
    const _lv = fields['น้ำมันที่เติม(ลิตร)'];
    const _noFuel = String(_lv == null ? '' : _lv).trim() === 'ไม่เติม';
    const _tidIdx = resolveMileColIdx_(headers, 'TripID');
    appendFuelLog_(
      _tidIdx >= 0 ? found.row[_tidIdx] : found.row[0], plate,
      _noFuel ? 0 : (_lv === undefined ? '' : _lv),
      _noFuel ? 0 : ('ราคาน้ำมัน(บาท)' in fields ? fields['ราคาน้ำมัน(บาท)'] : ''),
      _noFuel ? 'ไม่ได้เติมน้ำมัน' : 'เติมน้ำมัน', requestedBy, reason
    );
  }

  // ✅ NEW: แตะน้ำมันตอนกลับ → ลง FuelLog ด้วย (ประเภท 'เติมน้ำมันขากลับ')
  if ('ลิตรเติมขากลับ' in fields || 'ราคาเติมขากลับ(บาท)' in fields) {
    const _tid2 = resolveMileColIdx_(headers, 'TripID');
    appendFuelLog_(
      _tid2 >= 0 ? found.row[_tid2] : found.row[0], plate,
      'ลิตรเติมขากลับ' in fields ? fields['ลิตรเติมขากลับ'] : '',
      'ราคาเติมขากลับ(บาท)' in fields ? fields['ราคาเติมขากลับ(บาท)'] : '',
      'เติมน้ำมันขากลับ', requestedBy, reason
    );
  }

  // ถ้ามีการแก้ "เลขไมล์ต้น" หรือ "เลขไมล์ปลาย" และไม่ได้ส่ง "ระยะทาง(กม.)" มาด้วย → คำนวณใหม่ให้อัตโนมัติ
  const startIdx = resolveMileColIdx_(headers, 'เลขไมล์ต้น');
  const endIdx   = resolveMileColIdx_(headers, 'เลขไมล์ปลาย');
  const distIdx  = headers.indexOf('ระยะทาง(กม.)');
  if (!('ระยะทาง(กม.)' in fields) && distIdx >= 0 && startIdx >= 0 && endIdx >= 0) {
    const freshStart = Number(sheet.getRange(rowIndex, startIdx + 1).getValue());
    const freshEnd   = Number(sheet.getRange(rowIndex, endIdx + 1).getValue());
    if (!isNaN(freshStart) && !isNaN(freshEnd) && freshEnd >= freshStart) {
      sheet.getRange(rowIndex, distIdx + 1).setValue(freshEnd - freshStart);
    }
  }

  // ✅ NEW: ซิงค์ Vehicles sheet ถ้าแก้ไขทริปที่เป็นสถานะปัจจุบันของรถคันนี้อยู่
  syncVehicleFromMileRow_(found, fields);

  SpreadsheetApp.flush();
  // ✅ NEW: ถ้ามีฟิลด์ที่หาคอลัมน์ไม่เจอเลยแม้ลอง alias แล้ว ให้แจ้งเตือนกลับไปด้วย แทนที่จะเงียบเหมือนเดิม
  // (ok ยังเป็น true เพราะฟิลด์อื่นที่บันทึกได้ก็ยังบันทึกไปแล้วตามปกติ — นี่แค่แจ้งเตือนเสริม)
  const warnMsg = unresolvedFields.length
    ? ('⚠️ ไม่พบคอลัมน์ในชีทสำหรับฟิลด์: ' + unresolvedFields.join(', ') + ' — ข้อมูลส่วนนี้ยังไม่ถูกบันทึก กรุณาแจ้งผู้ดูแลระบบ')
    : '';
  return { ok: true, message: warnMsg };
}

/**
 * getFuelBacklog — ✅ NEW: ดึงรายการทริปที่ "จบทริปแล้ว" (มีเลขไมล์ปลาย/สถานะพร้อมใช้งาน)
 * แต่ยังไม่มีข้อมูลน้ำมัน (คอลัมน์ 'น้ำมันที่เติม(ลิตร)' ว่าง) — ใช้โชว์ในหน้า editmile.html
 * เป็นรายการ "ทริปที่รอลงบิลน้ำมันย้อนหลัง" ให้ผู้ใช้ไล่กรอกได้ครบโดยไม่ต้องไล่หาเองทั้งตาราง
 * ✅ NEW: ดักจับเฉพาะทริปที่ "ปลายทาง" เป็นปั๊มน้ำมันจริง (ผ่าน isFuelStation()) เท่านั้น — ทริปทั่วไป
 * ที่ปลายทางไม่ใช่ปั๊ม (เช่น ไปส่งผู้ป่วย/ไปติดต่อราชการ) จะไม่ถูกนับว่า "ค้างลงบิลน้ำมัน" อีกต่อไป
 * เพราะทริปแบบนั้นไม่ได้แวะเติมน้ำมันอยู่แล้วตั้งแต่ต้น ทำให้รายการที่โชว์เหลือเฉพาะที่เกี่ยวข้องจริงๆ
 * payload/params: { plate? , from?(yyyy-MM-dd), to?(yyyy-MM-dd) } ทั้งหมด optional (ไม่ระบุ = ทั้งหมด)
 * หมายเหตุ: ไม่รวมทริปที่ "กำลังใช้งาน" อยู่ (ยังไม่กลับ) เพราะยังไม่ถึงเวลาที่ควรมีบิลน้ำมันครบ
 */
function getFuelBacklog(params) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    tripId : headers.indexOf('TripID'),
    date   : headers.indexOf('วันที่'),
    plate  : headers.indexOf('ทะเบียน/รถ'),
    driver : headers.indexOf('พนักงานขับรถ'),
    dest   : headers.indexOf('ปลายทาง'),
    odoEnd : headers.indexOf('เลขไมล์ปลาย'),
    status : headers.indexOf('สถานะ'),
    liters : headers.indexOf('น้ำมันที่เติม(ลิตร)'),
    price  : headers.indexOf('ราคาน้ำมัน(บาท)'),
    retLit : headers.indexOf('ลิตรเติมขากลับ')   // ✅ NEW: น้ำมันตอนกลับ (หน้าประวัติรวมกับตอนออก)
  };
  if (idx.tripId < 0 || idx.liters < 0) return { status: 'ok', data: [], count: 0 };

  const plateFilter = params && params.plate ? String(params.plate).trim() : '';
  const fromFilter  = params && params.from  ? String(params.from).trim()  : '';
  const toFilter    = params && params.to    ? String(params.to).trim()    : '';

  function toYmd_(v) {
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
  }

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const status = String(row[idx.status] || '').trim();
    const odoEndVal = row[idx.odoEnd];
    const litersVal = String(row[idx.liters] || '').trim();
    const finished = status === 'พร้อมใช้งาน' || (odoEndVal !== '' && odoEndVal !== null);
    if (!finished) continue;          // ทริปยังไม่จบ → ยังไม่ต้องเตือน
    // มีข้อมูลน้ำมันแล้ว → ข้าม  (marker 'auto' = ตรวจพบว่าไปปั๊มแต่ยังไม่มีลิตรจริง → ยังนับว่าค้าง)
    // ✅ FIX: ต้องนับลิตรที่เติมตอนกลับด้วย ไม่งั้นทริปที่กรอกน้ำมันตอนกลับแล้วจะยังโผล่ค้างลงบิล
    if (idx.retLit >= 0 && numPos_(row[idx.retLit]) > 0) continue;
    if (litersVal !== '' && litersVal !== 'auto') continue;

    const plate = String(row[idx.plate] || '');
    if (plateFilter && plate.indexOf(plateFilter) < 0) continue;

    // ✅ NEW: ดักจับเฉพาะรายการที่ปลายทางเป็นปั๊มน้ำมันจริงๆ (ใช้ตัวตรวจจับ isFuelStation() ตัวเดียวกับ
    // ที่ endMile() ใช้ตรวจสถานะ "เติมน้ำมันแล้ว" แบบเรียลไทม์) — ทริปที่ปลายทางไม่ใช่ปั๊มน้ำมัน (เช่น
    // ไปส่งผู้ป่วย/ไปโรงพยาบาลอื่น) ไม่ควรถูกนับเป็น "ค้างลงบิลน้ำมัน" เพราะทริปแบบนั้นไม่ได้เติมน้ำมันอยู่แล้ว
    const dest = String(row[idx.dest] || '');
    if (!isFuelStation(dest)) continue;

    const ymd = toYmd_(row[idx.date]);
    if (fromFilter && ymd && ymd < fromFilter) continue;
    if (toFilter && ymd && ymd > toFilter) continue;

    out.push({
      tripId : String(row[idx.tripId] || ''),
      date   : ymd,
      plate  : plate,
      driver : String(row[idx.driver] || ''),
      dest   : dest,
      status : status
    });
  }
  out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return { status: 'ok', data: out, count: out.length };
}

/**
 * ════════════════════════════════════════════════════════════
 *  FUEL BACKLOG ENTRY — สำหรับ "เติมน้ำมันย้อนหลังที่ไม่มีทริปเดิมเลย"
 *  (ต่างจาก directEditMileRow/submitMileEditRequest ที่ใช้แก้ "ทริปที่มีอยู่แล้ว"
 *   ชุดนี้ "สร้างแถวใหม่" ใน MileLog เพราะไม่มี TripID ให้อ้างอิงตั้งแต่ต้น)
 * ════════════════════════════════════════════════════════════
 */

/** validateFuelBacklogFields_ — ตรวจความสมเหตุสมผลของข้อมูลก่อนสร้างแถวน้ำมันย้อนหลัง */
function validateFuelBacklogFields_(fields) {
  if (!String((fields && fields.plate) || '').trim()) {
    return { ok: false, message: 'กรุณาระบุทะเบียน/รถ' };
  }
  const dateStr = String((fields && fields.date) || '').trim();
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return { ok: false, message: 'กรุณาระบุวันที่เติมน้ำมัน' };
  }
  const liters = Number(fields && fields.fuelLiters);
  if (!fields || fields.fuelLiters === '' || fields.fuelLiters == null || isNaN(liters) || liters <= 0) {
    return { ok: false, message: 'กรุณาระบุจำนวนน้ำมันที่เติม (ลิตร) มากกว่า 0' };
  }
  if (liters > 500) {
    return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) สูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
  }
  if (fields.fuelPrice !== '' && fields.fuelPrice != null) {
    const price = Number(fields.fuelPrice);
    if (isNaN(price) || price < 0) return { ok: false, message: 'ราคาน้ำมัน (บาท) ต้องเป็นตัวเลขไม่ติดลบ' };
  }
  if (fields.odoAt !== '' && fields.odoAt != null) {
    const odo = Number(fields.odoAt);
    if (isNaN(odo) || odo < 0) return { ok: false, message: 'เลขไมล์ ณ วันเติม ต้องเป็นตัวเลขไม่ติดลบ' };
  }
  return { ok: true, message: '' };
}

/**
 * normalizeDateStr_ — แปลงค่าวันที่จาก cell (อาจเป็น Date object, 'yyyy-MM-dd', หรือ 'dd/MM/yyyy...')
 * ให้เป็นรูปแบบเดียวกันเสมอคือ 'yyyy-MM-dd' (เทียบวันแบบไม่สนใจเวลา) เพื่อใช้เทียบวันที่ข้ามรูปแบบได้
 */
function normalizeDateStr_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    try { return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd'); } catch (_) { return ''; }
  }
  const s = String(val).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/MM/yyyy (formatDisplayDate ใช้รูปแบบนี้)
  if (m) {
    const dd = ('0' + m[1]).slice(-2), mo = ('0' + m[2]).slice(-2);
    return m[3] + '-' + mo + '-' + dd;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) {
    try { return Utilities.formatDate(new Date(t), 'Asia/Bangkok', 'yyyy-MM-dd'); } catch (_) { return ''; }
  }
  return '';
}

/**
 * checkFuelBacklogDuplicate_ — ตรวจว่าทะเบียนที่ระบุมีการลงบิลน้ำมัน (ไม่ว่าจะมาจากทริปปกติ
 * หรือรายการย้อนหลัง FB... ที่เคยเพิ่มไปก่อน) ไว้แล้วในวันที่ระบุ หรือวันก่อนหน้า/ถัดไป (±1 วัน)
 * — ใช้ป้องกันการลงบิลน้ำมันย้อนหลังซ้ำซ้อนโดยไม่ตั้งใจ (เช่น พขร. คนละคนลงบิลใบเดียวกันซ้ำ)
 *
 * plate: string, dateStr: 'yyyy-MM-dd' (หรือรูปแบบที่ normalizeDateStr_ รองรับ)
 * คืนค่า array เรียงจากวันก่อนหน้า → วันเดียวกัน → วันถัดไป:
 *   [{ tripId, date('yyyy-MM-dd'), dayOffset(-1/0/1), liters, price, driver, note }]
 */
function checkFuelBacklogDuplicate_(plate, dateStr) {
  const targetPlateFull = String(plate || '').trim();
  const targetPlate     = targetPlateFull.split(' ')[0].trim();
  const targetDate      = normalizeDateStr_(dateStr);
  if (!targetPlate || !targetDate) return [];

  const base = new Date(targetDate + 'T00:00:00');
  const prevDate = Utilities.formatDate(new Date(base.getTime() - 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');
  const nextDate = Utilities.formatDate(new Date(base.getTime() + 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');

  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    tripId : headers.indexOf('TripID'),
    date   : headers.indexOf('วันที่'),
    plate  : headers.indexOf('ทะเบียน/รถ'),
    driver : headers.indexOf('พนักงานขับรถ'),
    liters : headers.indexOf('น้ำมันที่เติม(ลิตร)'),
    price  : headers.indexOf('ราคาน้ำมัน(บาท)'),
    note   : headers.indexOf('หมายเหตุ')
  };
  if (idx.plate < 0 || idx.date < 0 || idx.liters < 0) return [];

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowPlateFull = String(row[idx.plate] || '').trim();
    const rowPlate = rowPlateFull.split(' ')[0].trim();
    if (rowPlate !== targetPlate && rowPlateFull !== targetPlateFull) continue;

    const liters = Number(row[idx.liters]);
    if (!liters || isNaN(liters) || liters <= 0) continue; // แถวนี้ยังไม่มีข้อมูลน้ำมัน → ไม่นับว่าซ้ำ

    const rowDate = normalizeDateStr_(row[idx.date]);
    if (rowDate !== targetDate && rowDate !== prevDate && rowDate !== nextDate) continue;

    out.push({
      tripId   : row[idx.tripId] || '',
      date     : rowDate,
      dayOffset: rowDate === targetDate ? 0 : (rowDate === prevDate ? -1 : 1),
      liters   : liters,
      price    : idx.price >= 0 ? row[idx.price] : '',
      driver   : idx.driver >= 0 ? String(row[idx.driver] || '') : '',
      note     : idx.note >= 0 ? String(row[idx.note] || '') : ''
    });
  }
  out.sort(function (a, b) { return a.dayOffset - b.dayOffset; });
  return out;
}

/** buildDuplicateWarningMessage_ — สร้างข้อความแจ้งเตือนภาษาไทยจากผลลัพธ์ checkFuelBacklogDuplicate_ */
function buildDuplicateWarningMessage_(dup) {
  const dayLabel = { '-1': 'วันก่อนหน้า 1 วัน', '0': 'วันเดียวกัน', '1': 'วันถัดไป 1 วัน' };
  const lines = dup.map(function (d) {
    return '• ' + d.date + ' (' + dayLabel[String(d.dayOffset)] + ') เติม ' + d.liters + ' ลิตร'
      + (d.price !== '' && d.price != null ? ' · ' + d.price + ' บาท' : '')
      + (d.driver ? ' · พขร. ' + d.driver : '')
      + (d.tripId ? ' [' + d.tripId + ']' : '');
  });
  return '⚠️ พบว่าทะเบียนนี้มีการลงบิลน้ำมันไว้แล้วใกล้เคียงวันที่ระบุ:\n' + lines.join('\n')
    + '\n\nยืนยันว่าต้องการบันทึกรายการนี้เพิ่ม (ซ้อนกับรายการข้างต้น) หรือไม่?';
}

/**
 * checkFuelBacklogDuplicate — API ให้ frontend เรียกตรวจสอบก่อนกดบันทึก (แสดงคำเตือนล่วงหน้า
 * ตั้งแต่ตอนกรอกฟอร์ม ก่อนที่ผู้ใช้จะกดปุ่มบันทึกจริงด้วยซ้ำ)
 * payload: { plate, date }
 */
function checkFuelBacklogDuplicate(payload) {
  const dup = checkFuelBacklogDuplicate_(payload && payload.plate, payload && payload.date);
  return { status: 'ok', duplicates: dup, count: dup.length,
    message: dup.length > 0 ? buildDuplicateWarningMessage_(dup) : '' };
}

/**
 * addFuelBacklogEntry_ — สร้างแถวใหม่ใน MileLog สำหรับรายการเติมน้ำมันที่ไม่มีทริปบันทึกไว้เลย
 * ✅ สำคัญมาก: ฟังก์ชันนี้ "ห้าม" เรียก updateVehicleStatus หรือ syncVehicleFromMileRow_ เด็ดขาด
 * เพราะแถวนี้คือข้อมูลย้อนหลัง ไม่ใช่ทริปที่กำลังเกิดขึ้นจริง ถ้าไปอัปเดตสถานะรถใน Vehicles sheet
 * จะทำให้หน้า dashboard/index/startmile เข้าใจผิดว่ารถคันนี้เพิ่งมีความเคลื่อนไหวล่าสุดจากแถวนี้ทันที
 *
 * fields: { date(yyyy-MM-dd), plate, driver?, odoAt?(เลขไมล์ ณ วันเติม ถ้าทราบ), fuelLiters, fuelPrice?, note? }
 * คืนค่า TripID ที่สร้างขึ้น (ขึ้นต้นด้วย 'FB' เพื่อแยกจากทริปจริงที่ขึ้นต้นด้วย 'T')
 */
function addFuelBacklogEntry_(fields) {
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_MILE, [
    'TripID','Timestamp','วันที่','เวลาออก','ทะเบียน/รถ','พนักงานขับรถ',
    'ปลายทาง','เลขไมล์ต้น','เลขไมล์ปลาย','ระยะทาง(กม.)',
    'เวลากลับ','สถานะ','น้ำมันที่เติม(ลิตร)','ราคาน้ำมัน(บาท)','หมายเหตุ','รูปบิลน้ำมัน',
    'รูปบิลน้ำมันขากลับ','จุดขอใช้รถ','รูปสภาพรถ','รูปสภาพรถขากลับ'
  ]);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  const tripId  = 'FB' + Date.now();
  const dateStr = String(fields.date || '').trim() || formatThaiDate(new Date());
  // ✅ เลขไมล์ต้น = เลขไมล์ปลาย (ถ้าทราบ) → ระยะทาง(กม.) = 0 เสมอ กันไม่ให้แถวนี้ไปบวกเพิ่มระยะทางรวม
  // ของทริปจริง (ไม่งั้นยอด กม. รวมกองรถจะเพี้ยน) แต่ยังเก็บ "เลขไมล์ ณ วันนั้น" ไว้เป็นจุดอ้างอิงได้ถ้าทราบ
  const hasOdo  = fields.odoAt !== '' && fields.odoAt != null && !isNaN(Number(fields.odoAt));
  const odoVal  = hasOdo ? Number(fields.odoAt) : '';

  const map = {
    'TripID'              : tripId,
    'Timestamp'            : formatDisplayDate(new Date()),
    'วันที่'                : dateStr,
    'ทะเบียน/รถ'           : String(fields.plate || '').trim(),
    'พนักงานขับรถ'         : String(fields.driver || '').trim(),
    'ปลายทาง'               : '',
    'เลขไมล์ต้น'           : odoVal,
    'เลขไมล์ปลาย'          : odoVal,
    'ระยะทาง(กม.)'         : hasOdo ? 0 : '',
    'สถานะ'                 : 'พร้อมใช้งาน', // ✅ ตายตัว — แถวย้อนหลังไม่มีทางเป็น "กำลังใช้งาน"
    'น้ำมันที่เติม(ลิตร)'   : Number(fields.fuelLiters) || 0,
    'ราคาน้ำมัน(บาท)'      : (fields.fuelPrice !== '' && fields.fuelPrice != null) ? (Number(fields.fuelPrice) || 0) : '',
    'หมายเหตุ'              : String(fields.note || '').trim() || 'เติมน้ำมันย้อนหลัง (ไม่มีทริปบันทึกไว้เดิม)'
  };

  const row = headers.map(function (h) { return (h in map) ? map[h] : ''; });
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return tripId;
}

/**
 * directAddFuelBacklogEntry — แอดมินเพิ่มรายการเติมน้ำมันย้อนหลังตรง (ไม่มีทริปเดิม) มีผลทันที
 * payload: { date, plate, driver, odoAt, fuelLiters, fuelPrice, note, editedBy, reason, adminCode }
 */
function directAddFuelBacklogEntry(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const reason = String(payload.reason || '').trim();
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผล/ที่มาของรายการนี้ (เช่น ลืมกดออกรถ, พขร. ใช้รถแบบไม่ผ่านระบบ)' };

  const check = validateFuelBacklogFields_(payload);
  if (!check.ok) return { status: 'error', message: check.message };

  // ✅ NEW: กันลงบิลน้ำมันย้อนหลังซ้ำซ้อน — เช็กว่าทะเบียนนี้มีบิลลงไว้แล้วในวันที่นี้ (หรือ ±1 วัน) หรือไม่
  // ถ้าพบและ frontend ยังไม่ได้ส่ง confirmDuplicate มายืนยัน ให้ตีกลับไปถามยืนยันก่อน แทนที่จะสร้างซ้ำเงียบๆ
  if (!payload.confirmDuplicate) {
    const dup = checkFuelBacklogDuplicate_(payload.plate, payload.date);
    if (dup.length > 0) {
      return { status: 'confirm_needed', duplicates: dup, message: buildDuplicateWarningMessage_(dup) };
    }
  }

  const tripId = addFuelBacklogEntry_(payload);

  const ss = getSpreadsheet();
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  logSheet.appendRow([
    now, tripId, String(payload.plate || ''), '(เพิ่มรายการน้ำมันย้อนหลัง — ไม่มีทริปเดิม)',
    '', 'ลิตร:' + payload.fuelLiters + ' ราคา:' + (payload.fuelPrice || '-'),
    String(payload.editedBy || ''), 'แอดมิน (เพิ่มตรง)', reason, String(payload.editedBy || ''), now, 'แอดมินเพิ่มย้อนหลัง'
  ]);

  // ✅ NEW: ลง FuelLog ทุกครั้งที่บันทึก
  appendFuelLog_(tripId, String(payload.plate || ''), payload.fuelLiters, payload.fuelPrice || '', 'เพิ่มย้อนหลัง', String(payload.editedBy || ''), reason);

  return { status: 'ok', message: 'บันทึกรายการเติมน้ำมันย้อนหลังเรียบร้อย', tripId: tripId };
}

/**
 * submitAddFuelBacklogRequest — พขร. ส่งคำขอเพิ่มรายการเติมน้ำมันย้อนหลัง (ไม่มีทริปเดิม) รอแอดมินอนุมัติ
 * payload: { date, plate, driver, odoAt, fuelLiters, fuelPrice, note, requestedBy, reason }
 */
function submitAddFuelBacklogRequest(payload) {
  const requestedBy = String(payload.requestedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอ' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผล/ที่มาของรายการนี้' };

  const check = validateFuelBacklogFields_(payload);
  if (!check.ok) return { status: 'error', message: check.message };

  // ✅ NEW: กันลงบิลน้ำมันย้อนหลังซ้ำซ้อน เช่นเดียวกับฝั่งแอดมิน (directAddFuelBacklogEntry)
  if (!payload.confirmDuplicate) {
    const dup = checkFuelBacklogDuplicate_(payload.plate, payload.date);
    if (dup.length > 0) {
      return { status: 'confirm_needed', duplicates: dup, message: buildDuplicateWarningMessage_(dup) };
    }
  }

  const fields = {
    date: payload.date, plate: payload.plate, driver: payload.driver || '',
    odoAt: payload.odoAt || '', fuelLiters: payload.fuelLiters, fuelPrice: payload.fuelPrice || '',
    note: payload.note || ''
  };

  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId = 'REQF' + new Date().getTime();

  sheet.appendRow([
    reqId, 'เพิ่มน้ำมัน', now, '', String(payload.plate || ''),
    JSON.stringify(fields), JSON.stringify({}), JSON.stringify(fields),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอเพิ่มรายการน้ำมันย้อนหลังแล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/**
 * getMileAnomalies — ตรวจไมล์ที่หายไป/ผิดปกติ
 * อ่านข้อมูลจากชีท "รายงานไมล์หาย_ละเอียด" (ที่ตั้งสูตรคำนวณแบบเรียลไทม์ไว้ในชีทเองแล้ว)
 * แทนการคำนวณเองใน Apps Script ดังนั้นความถูกต้อง/เรียลไทม์ขึ้นอยู่กับสูตรในชีทนั้นโดยตรง
 *
 * โครงสร้างคอลัมน์ของชีท (ตามลำดับ):
 * วันที่ | ทะเบียน/รถ | พนักงานขับรถ | ไมล์สิ้นสุดทริปก่อนหน้า | ไมล์เริ่มต้นทริปปัจจุบัน | ระยะทางที่หายไป (กม.)
 *
 * ไม่แสดงรถผู้บริหาร (ดู MILE_GAP_EXCLUDE_PLATES ด้านบนไฟล์นี้ — ปัจจุบันคือ นง.8781 ชม — รถตู้ฮุนได)
 */
function getMileAnomalies() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE_GAP_DETAIL);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [] };

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    date         : headers.indexOf('วันที่'),
    plate        : headers.indexOf('ทะเบียน/รถ'),
    driver       : headers.indexOf('พนักงานขับรถ'),
    prevEndMile  : headers.indexOf('ไมล์สิ้นสุดทริปก่อนหน้า'),
    currStartMile: headers.indexOf('ไมล์เริ่มต้นทริปปัจจุบัน'),
    missingKm    : headers.indexOf('ระยะทางที่หายไป (กม.)')
  };
  if (idx.plate < 0 || idx.missingKm < 0) {
    return { status: 'error', message: 'ไม่พบคอลัมน์ที่จำเป็นในชีท "' + SHEET_MILE_GAP_DETAIL + '"' };
  }

  function fmtDateOnly_(val) {
    if (!val) return '';
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    try { return Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy'); } catch (_) { return String(val); }
  }

  // ✅ NEW: ชีท "รายงานไมล์หาย_ละเอียด" มีแค่คอลัมน์ "วันที่" คอลัมน์เดียว (ของทริปปัจจุบัน)
  // ไม่มีวันที่/เวลาอ้างอิงของ "ไมล์ก่อนหน้า" (ทริปก่อนหน้าที่จบด้วยเลขไมล์นั้น) แยกไว้เลย
  // จึงต้อง cross-reference กับชีท MileLog โดยตรง (ทะเบียน + เลขไมล์ → วันที่/เวลาจริงของทริปนั้น)
  // เพื่อโชว์วงเล็บกำกับใต้ "ไมล์ก่อนหน้า" และ "ไมล์เริ่มต้น" ว่าอ้างอิงจากทริปวันที่/เวลาใด
  const refByEndMile   = {}; // key: 'ทะเบียน|เลขไมล์สิ้นสุด'  → "dd/MM/yyyy HH:mm น."
  const refByStartMile = {}; // key: 'ทะเบียน|เลขไมล์เริ่มต้น' → "dd/MM/yyyy HH:mm น."
  try {
    const mileSheet = ss.getSheetByName(SHEET_MILE);
    if (mileSheet && mileSheet.getLastRow() > 1) {
      const mVals    = mileSheet.getDataRange().getValues();
      const mHeaders = mVals[0];
      const mIdx = {
        plate     : mHeaders.indexOf('ทะเบียน/รถ'),
        startMile : mHeaders.indexOf('ไมล์เริ่มต้น'),
        endMile   : mHeaders.indexOf('ไมล์สิ้นสุด'),
        tripDate  : mHeaders.indexOf('วันที่'),
        startTime : mHeaders.indexOf('เวลาออก'),
        endTime   : mHeaders.indexOf('เวลากลับ')
      };
      function fmtTimePart_(v) {
        if (!v) return '';
        if (v instanceof Date) { try { return Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm'); } catch (_) { return ''; } }
        const m = String(v).match(/(\d{1,2}):(\d{2})/);
        return m ? (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2] : '';
      }
      function fmtRef_(dateVal, timeVal) {
        const dPart = fmtDateOnly_(dateVal);
        const tPart = fmtTimePart_(timeVal);
        if (!dPart) return '';
        return dPart + (tPart ? ' ' + tPart + ' น.' : '');
      }
      for (let i = 1; i < mVals.length; i++) {
        const row   = mVals[i];
        const plate = String(row[mIdx.plate] || '').trim();
        if (!plate) continue;
        if (mIdx.endMile >= 0) {
          const endMileVal = Number(row[mIdx.endMile]);
          if (endMileVal > 0) {
            refByEndMile[plate + '|' + endMileVal] = fmtRef_(row[mIdx.tripDate], row[mIdx.endTime]);
          }
        }
        if (mIdx.startMile >= 0) {
          const startMileVal = Number(row[mIdx.startMile]);
          if (startMileVal > 0) {
            refByStartMile[plate + '|' + startMileVal] = fmtRef_(row[mIdx.tripDate], row[mIdx.startTime]);
          }
        }
      }
    }
  } catch (refErr) {
    console.warn('getMileAnomalies: สร้าง reference lookup จาก MileLog ไม่สำเร็จ:', refErr.message);
  }

  const anomalies = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const plate = String(row[idx.plate] || '').trim();
    if (!plate) continue;

    // ไม่แสดงรถผู้บริหาร (เทียบแบบ contains กันปัญหาจุด/ช่องว่างสะกดต่างกันเล็กน้อย)
    if (MILE_GAP_EXCLUDE_PLATES.some(function (p) { return plate.indexOf(p) >= 0; })) continue;

    const missingKm = Number(row[idx.missingKm]);
    if (!isFinite(missingKm) || missingKm <= 0) continue; // แสดงเฉพาะกรณีระยะทางหายไปจริง (มากกว่า 0 กม.)

    const dateVal = idx.date >= 0 ? row[idx.date] : null;
    const dateMs  = dateVal instanceof Date && !isNaN(dateVal.getTime())
      ? dateVal.getTime()
      : (dateVal ? new Date(dateVal).getTime() : NaN);

    const prevEndMileVal   = idx.prevEndMile >= 0 ? Number(row[idx.prevEndMile]) : '';
    const currStartMileVal = idx.currStartMile >= 0 ? Number(row[idx.currStartMile]) : '';

    anomalies.push({
      plate        : plate,
      currDate     : idx.date >= 0 ? fmtDateOnly_(row[idx.date]) : '',
      _dateMs      : isFinite(dateMs) ? dateMs : -Infinity, // ใช้เรียงลำดับเท่านั้น ไม่ส่งออกไปหน้าเว็บ
      currDriver   : idx.driver >= 0 ? String(row[idx.driver] || '') : '',
      prevEndMile  : prevEndMileVal,
      currStartMile: currStartMileVal,
      // ✅ NEW: วันที่/เวลาอ้างอิงจริงของแต่ละเลขไมล์ (มาจาก MileLog โดยตรง)
      prevEndRef   : (prevEndMileVal   && refByEndMile[plate + '|' + prevEndMileVal])     || '',
      currStartRef : (currStartMileVal && refByStartMile[plate + '|' + currStartMileVal]) || '',
      missingKm    : missingKm
    });
  }

  // เรียงตามวันที่ล่าสุดขึ้นก่อน (ถ้าวันที่ตรงกัน ให้ระยะทางหายมากอยู่บนสุด)
  anomalies.sort(function (a, b) { return b._dateMs - a._dateMs || b.missingKm - a.missingKm; });
  anomalies.forEach(function (a) { delete a._dateMs; }); // ไม่ต้องส่งฟิลด์ภายในนี้ออกไปหน้าเว็บ

  return { status: 'ok', data: anomalies };
}
