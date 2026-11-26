// ═══════════════════════════════════════════════════════════════════
//  ระบบแลกเวร พขร. (swap.html)
//  Sheet ใหม่: SwapRequests (สร้างอัตโนมัติ ไม่กระทบชีทเดิม)
//  ใช้ sheet "ตารางเวร" / "ตารางเวรถัดไป" เดิมเป็นแหล่งข้อมูลรายชื่อ+เวร
//  และเขียนสลับเวรจริงลงชีทเดิมเมื่ออนุมัติ
// ═══════════════════════════════════════════════════════════════════

var SHEET_SWAP_REQUESTS = 'SwapRequests';
var SWAP_REQUEST_HEADERS = [
  'RequestID', 'เดือน', 'ชื่อผู้ขอแลก', 'เบอร์ผู้ขอแลก',
  'วันที่เดิมของผู้ขอแลก', 'เวรเดิมของผู้ขอแลก',
  'ชื่อผู้รับแลก', 'วันที่เดิมของผู้รับแลก', 'เวรเดิมของผู้รับแลก',
  'เหตุผล', 'สถานะ', 'บันทึกเมื่อ',
  'ดำเนินการโดย', 'ดำเนินการเมื่อ', 'เหตุผลที่ปฏิเสธ',
  'DocURL', 'PdfURL',
  'ประเภทคำขอ', // ✅ NEW: 'แลกเวร' (สลับกัน 2 ทาง, ค่าเริ่มต้น) หรือ 'ยกเวร' (ให้ทางเดียว ผู้รับแลกอาจมีเวรเดิมอยู่แล้ว)
  'ส่วนที่ยก' // ✅ NEW: เฉพาะโหมด "ยกเวร" กับเวรรวมเช้า-บ่าย (เช่น ช2บ1) — 'full' (ยกทั้งเวร, ค่าเริ่มต้น)
             //        'am' (ยกเฉพาะครึ่งเช้า คงเหลือครึ่งบ่ายไว้เอง) หรือ 'pm' (ยกเฉพาะครึ่งบ่าย คงเหลือครึ่งเช้าไว้เอง)
];

/** ✅ NEW: เพิ่มคอลัมน์ 'ประเภทคำขอ' ให้ sheet ที่สร้างไว้ก่อนฟีเจอร์ "ยกเวร" โดยไม่กระทบคอลัมน์/ข้อมูลเดิม
 *  (sheet เก่าที่มีอยู่แล้วจะไม่ถูกสร้างใหม่ผ่าน getOrCreateSheet ดังนั้นต้องเติมคอลัมน์ที่ขาดเองที่นี่) */
function ensureSwapRequestTypeColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var has = headerRow.some(function (h) { return String(h).trim() === 'ประเภทคำขอ'; });
  if (!has) {
    sheet.getRange(1, lastCol + 1).setValue('ประเภทคำขอ');
  }
}

/** ✅ NEW: เพิ่มคอลัมน์ 'ส่วนที่ยก' ให้ sheet ที่สร้างไว้ก่อนฟีเจอร์ "แบ่งครึ่งเวรยก" (เช่นเดียวกับ ensureSwapRequestTypeColumn_) */
function ensureSwapGivePartColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var has = headerRow.some(function (h) { return String(h).trim() === 'ส่วนที่ยก'; });
  if (!has) {
    sheet.getRange(1, lastCol + 1).setValue('ส่วนที่ยก');
  }
}

function getSwapRequestsSheet_() {
  var sheet = getOrCreateSheet(getSpreadsheet(), SHEET_SWAP_REQUESTS, SWAP_REQUEST_HEADERS);
  ensureSwapRequestTypeColumn_(sheet);
  ensureSwapGivePartColumn_(sheet);
  return sheet;
}

/** ✅ NEW: สร้างแถวสำหรับ appendRow โดยอ้างอิงตำแหน่งคอลัมน์จริงของ sheet (idx จาก jobsHeaderIndex_)
 *  แทนการเรียงค่าแบบตายตัวตาม SWAP_REQUEST_HEADERS — ป้องกันข้อมูลเยื้องคอลัมน์ผิด
 *  กรณี sheet เก่าที่เพิ่งถูกเติมคอลัมน์ใหม่ (เช่น 'ประเภทคำขอ') ต่อท้ายให้ภายหลัง */
function buildSwapRequestRow_(idx, valuesByHeader) {
  var width = 0;
  Object.keys(idx).forEach(function (h) { width = Math.max(width, idx[h] + 1); });
  var row = new Array(width).fill('');
  Object.keys(valuesByHeader).forEach(function (h) {
    if (idx[h] != null) row[idx[h]] = valuesByHeader[h];
  });
  return row;
}

/** สร้างรหัสคำขอแลกเวรแบบไม่ซ้ำ เช่น SW260910-143502 */
function generateSwapRequestId_() {
  return 'SW' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyMMdd-HHmmss');
}

/** หา staff (name หรือ nick ตรงกัน) จากรายชื่อในตารางเวร */
function findSwapStaff_(list, nameOrNick) {
  var q = String(nameOrNick || '').trim();
  if (!q) return null;
  return (list || []).filter(function (s) {
    return s.name === q || s.nick === q;
  })[0] || null;
}

/** ดึงข้อมูล schedule (current+next) แล้วรวมเป็นรายชื่อ staff ไม่ซ้ำ (ใช้ name เป็น key หลัก) */
function getSwapCombinedStaff_() {
  var cur = getWorktableSchedule();
  var next = getWorktableScheduleNext();
  var byName = {};
  (cur.status === 'ok' ? cur.data : []).forEach(function (s) { byName[s.name] = s; });
  (next.status === 'ok' ? next.data : []).forEach(function (s) { if (!byName[s.name]) byName[s.name] = s; });
  return Object.keys(byName).map(function (k) { return byName[k]; });
}

// ── LOGIN ────────────────────────────────────────────────────────────
// ✅ รายชื่อเบอร์ที่ได้สิทธิ์แอดมินในระบบแลกเวรเสมอ (ดู/อนุมัติคำขอทุกคน + export ไฟล์ได้ทันที)
//    ไม่ผูกกับตำแหน่ง/role ในตารางเวร เผื่อกรณีตำแหน่งเปลี่ยนหรือยังไม่ได้ตั้ง role ไว้
//    - นายชัยพร มอญแสง (ชัย) หัวหน้างาน 0849484577
//    - นายกิตติพงศ์ เขื่อนแก้ว (หนุ่ย) รองหัวหน้างาน 0882665403
//    - นายกานต์นิธิ ทองอร (โบ๊ท) 0861004536
//    ใช้ร่วมกันทั้ง 3 จุด: ล็อกอินแลกเวร (swapLogin) · อนุมัติ/สร้างเอกสาร · แก้ไขเวรรายช่อง (verifyDriverPhone → canEditSchedule)
var SWAP_ADMIN_PHONES = ['0849484577', '0882665403', '0861004536'];

/** swapLogin — ใช้ตรรกะเดียวกับ verifyDriverPhone (เบอร์โทรใน "ตารางเวร" หรือรหัสแอดมิน)
 *  เพิ่มเติม: หัวหน้างาน/รองหัวหน้างาน และเบอร์ใน SWAP_ADMIN_PHONES ได้สิทธิ์ isAdmin ในระบบแลกเวรด้วย
 *  (ดูประวัติของทุกคนได้ทันทีโดยไม่ต้องติ๊กช่อง, อนุมัติ/ปฏิเสธคำขอได้, export ไฟล์ได้) */
function swapLogin(payload) {
  var v = verifyDriverPhone(payload);
  if (v.status !== 'ok') return v;
  if (!v.isAdmin) {
    var role = String(v.role || '');
    if (role.indexOf('หัวหน้างาน') >= 0) v.isAdmin = true;
  }
  if (!v.isAdmin && SWAP_ADMIN_PHONES.indexOf(normalizePhone_(v.phone)) >= 0) {
    v.isAdmin = true;
  }
  return v;
}

// ── STAFF LIST ───────────────────────────────────────────────────────
function getSwapStaffList() {
  try {
    var staff = getSwapCombinedStaff_().map(function (s) {
      return { name: s.name, nick: s.nick, role: s.role };
    });
    return { status: 'ok', staff: staff };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── SHIFT DAYS ของคนคนหนึ่ง (เดือนนี้ + เดือนถัดไป) ──────────────────
function getMyShiftDays(params) {
  try {
    var name = String((params && params.name) || '').trim();
    if (!name) return { status: 'error', message: 'ไม่พบชื่อพนักงาน' };

    var cur = getWorktableSchedule();
    var next = getWorktableScheduleNext();

    function buildBlock(res) {
      if (res.status !== 'ok') return { month: null, year: null, days: [] };
      var person = findSwapStaff_(res.data, name);
      if (!person) return { month: res.month, year: res.year, days: [] };
      var days = Object.keys(person.schedule || {})
        .map(function (d) { return { day: Number(d), shift: person.schedule[d] }; })
        .sort(function (a, b) { return a.day - b.day; });
      return { month: res.month, year: res.year, days: days };
    }

    return { status: 'ok', current: buildBlock(cur), next: buildBlock(next) };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── เขียนสลับเวรจริงลงชีท "ตารางเวร" / "ตารางเวรถัดไป" ───────────────
/** applySwapToSheet_ — สลับค่าเวรของ 2 คนใน 2 วันที่ต่างกันบนชีทเดียวกัน
 *  requesterName รับ targetDay/targetShift ไปแทน · targetName รับ requesterDay/requesterShift ไปแทน */
function applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบ sheet ' + sheetName);

  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }

  function findRow(nameOrNick) {
    for (var r = dataStartRow; r < data.length; r++) {
      var nm = String(data[r][0] || '').trim();
      var nk = String(data[r][1] || '').trim();
      if (nm === nameOrNick || nk === nameOrNick) return r; // 0-based index into data[]
    }
    return -1;
  }

  var reqRow = findRow(requesterName);
  var tgtRow = findRow(targetName);
  if (reqRow < 0) throw new Error('ไม่พบชื่อผู้ขอแลกในตารางเวร: ' + requesterName);
  if (tgtRow < 0) throw new Error('ไม่พบชื่อผู้รับแลกในตารางเวร: ' + targetName);
  if (reqRow === tgtRow) throw new Error('ผู้ขอแลกและผู้รับแลกตรงกับแถวเดียวกันในตารางเวร (ชื่อ/ชื่อเล่นอาจซ้ำกัน) — กรุณาตรวจสอบชื่อให้ถูกต้อง');

  var reqDayCol = rosterDayColumn_(sheetName, requesterDay);  // 1-based column — อ่านจากหัวตาราง (ไม่พึ่งตำแหน่งตายตัว)
  var tgtDayCol = rosterDayColumn_(sheetName, targetDay);

  // ✅ FIX: ถ้าทั้งคู่แลกกันในวันเดียวกัน (แค่สลับประเภทเวรของวันนั้น) ให้ "สลับค่าโดยตรง"
  //    เดิมโค้ดล้าง(setValue(''))แล้วเติมทีหลัง แยกเป็น 4 ขั้นตอนตามลำดับ reqDayCol แล้วค่อย tgtDayCol
  //    เมื่อ reqDayCol === tgtDayCol (วันเดียวกัน) ขั้นตอนที่ 4 (ล้างค่าของผู้รับแลกที่คอลัมน์ tgtDayCol)
  //    จะไปเขียนทับคอลัมน์เดียวกับที่เพิ่งใส่ค่าไว้ในขั้นตอนที่ 1 ทำให้ข้อมูลของผู้รับแลกหายไป (ว่างเปล่า)
  //    — นี่คือสาเหตุที่ "ข้อมูลในชีทหน้าตารางเวรหายไป" เวลาแลกเวรกันในวันเดียวกัน (กรณีที่พบบ่อยที่สุด)
  if (reqDayCol === tgtDayCol) {
    sheet.getRange(reqRow + 1, reqDayCol).setValue(targetShift);
    sheet.getRange(tgtRow + 1, reqDayCol).setValue(requesterShift);
  } else {
    // ผู้รับแลก (target) เข้าเวรแทนในวันเดิมของผู้ขอแลก
    sheet.getRange(tgtRow + 1, reqDayCol).setValue(requesterShift);
    sheet.getRange(reqRow + 1, reqDayCol).setValue('');
    // ผู้ขอแลก (requester) เข้าเวรแทนในวันเดิมของผู้รับแลก
    sheet.getRange(reqRow + 1, tgtDayCol).setValue(targetShift);
    sheet.getRange(tgtRow + 1, tgtDayCol).setValue('');
  }

  SpreadsheetApp.flush();
}

// ── ยกเวร (ให้ทางเดียว) — คนละฟังก์ชันกับการ "แลกเวร" (สลับกัน 2 ทาง) ──────
/** รวมค่าเวรของวันเดียวกัน เมื่อผู้รับเวรแทนมีเวรเดิมอยู่แล้ว: เก็บทั้งสองเวรไว้ในเซลล์เดียว
 *  คั่นด้วย "/" เช่น ผู้รับแลกมีเวร "ด" อยู่แล้ว รับเวร "ช1บ2" มาเพิ่ม → "ด/ช1บ2"
 *  ป้องกันการซ้ำ (เช่น กดยกเวรรายการเดิมซ้ำ) — ถ้ามีอยู่แล้วในรายการจะไม่ต่อซ้ำ */
function swapCombineShiftValues_(existingShift, newShift) {
  var e = String(existingShift == null ? '' : existingShift).trim();
  var n = String(newShift == null ? '' : newShift).trim();
  if (!e || e === '0') return n;
  if (!n || n === '0') return e;
  var parts = e.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.indexOf(n) >= 0) return e; // ยกเวรรายการเดียวกันซ้ำ — ไม่ต่อซ้ำ
  parts.push(n);
  return parts.join('/');
}

// ── ✅ NEW: แบ่งครึ่ง "เวรรวม" เช้าต่อบ่าย (16 ชม.) ออกเป็น 2 ส่วนอิสระ ──────────
/** เวรรวมเช้าต่อบ่าย เช่น "ช2บ1" แท้จริงแล้วคือคนคนเดียวทำงาน 2 ช่วงต่อกัน:
 *  ช่วงเช้า (ช2, 08.00-16.00) + ช่วงบ่าย (บ1, 16.00-00.00) — แต่ละช่วงเป็นเวรที่สมบูรณ์ในตัวเอง
 *  ฟังก์ชันนี้ใช้ตรวจสอบว่ารหัสเวรที่ส่งมาเป็นเวรรวมรูปแบบนี้หรือไม่ (ตรงตามรูปแบบ ช[1-3]บ[1-3] เป๊ะๆ
 *  เท่านั้น — ไม่รวมเวรที่ถูก "รวม" ไว้แล้วด้วย "/" เช่น "ด/ช2บ1" เพราะแบ่งต่ออีกชั้นแล้วจะสับสน)
 *  คืนค่า {am:'ช2', pm:'บ1'} ถ้าแบ่งได้ / null ถ้าแบ่งไม่ได้ (เวรเดี่ยว, ดึก, EMS ฯลฯ) */
function swapSplitCombinedShift_(code) {
  var s = String(code == null ? '' : code).trim();
  var m = /^(ช[1-3])(บ[1-3])$/.exec(s);
  if (!m) return null;
  return { am: m[1], pm: m[2] };
}

/** เขียน "ยกเวรให้" ลงชีทตารางเวรจริง — ต่างจาก applySwapToSheet_ (สลับ 2 ทาง):
 *  ผู้ให้เวร (requesterName) ปกติล้างเวรวันนั้นทิ้ง (ไม่มีเวรแล้ว) — ยกเว้นกรณี "ยกครึ่งเวร" (ดู
 *  swapSplitCombinedShift_) ที่ผู้ให้เวรยังคงเหลืออีกครึ่งหนึ่งไว้กับตัวเอง (remainingRequesterShift)
 *  ผู้รับเวรแทน (targetName) ได้ค่าเวร "รวม" ของเวรเดิม(ถ้ามี) + เวรที่รับมา (givenShift) ในเซลล์เดียวกัน (วันเดียวกัน)
 *  เพื่อเป็นหลักฐานว่าผู้รับเวรแทนทำงาน 2 เวรในวันนั้นจริง (สำหรับกลุ่มงานการเงินจ่ายเงินเวรให้ถูกคน)
 *  @param {string} givenShift  ค่าเวรที่ "ยกให้" จริง — เวรเต็มวัน (ยกทั้งเวร) หรือครึ่งเดียว (ช_ หรือ บ_) เมื่อยกครึ่งเวร
 *  @param {string} [remainingRequesterShift] ค่าเวรที่ผู้ให้เวรยังเหลือไว้เอง — ว่างเปล่า ('') = ยกทั้งเวร (ค่าเริ่มต้น) */
function applyGiveShiftToSheet_(monthSheet, requesterName, day, givenShift, targetName, existingTargetShift, remainingRequesterShift) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบ sheet ' + sheetName);

  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }

  function findRow(nameOrNick) {
    for (var r = dataStartRow; r < data.length; r++) {
      var nm = String(data[r][0] || '').trim();
      var nk = String(data[r][1] || '').trim();
      if (nm === nameOrNick || nk === nameOrNick) return r;
    }
    return -1;
  }

  var reqRow = findRow(requesterName);
  var tgtRow = findRow(targetName);
  if (reqRow < 0) throw new Error('ไม่พบชื่อผู้ให้เวรในตารางเวร: ' + requesterName);
  if (tgtRow < 0) throw new Error('ไม่พบชื่อผู้รับเวรแทนในตารางเวร: ' + targetName);
  if (reqRow === tgtRow) throw new Error('ผู้ให้เวรและผู้รับเวรแทนตรงกับแถวเดียวกันในตารางเวร (ชื่อ/ชื่อเล่นอาจซ้ำกัน) — กรุณาตรวจสอบชื่อให้ถูกต้อง');

  var dayCol = rosterDayColumn_(sheetName, day); // 1-based column — อ่านจากหัวตาราง สอดคล้องกับ applySwapToSheet_
  var combined = swapCombineShiftValues_(existingTargetShift, givenShift);

  sheet.getRange(tgtRow + 1, dayCol).setValue(combined);
  sheet.getRange(reqRow + 1, dayCol).setValue(remainingRequesterShift || '');

  SpreadsheetApp.flush();
  return combined;
}

/** ป้ายชื่อเวรอ่านง่าย รองรับค่าที่ถูก "รวม" ไว้ด้วย "/" จาก applyGiveShiftToSheet_ เช่น "ด/ช1บ2"
 *  → "เวรดึก (ด) 00.00-08.00 น. + เวรเช้า1ต่อบ่าย2 (ช1บ2) 08.00-00.00 น." ใช้ในบันทึกข้อความ */
function swapShiftLabelCombined_(code) {
  var s = String(code == null ? '' : code).trim();
  if (!s) return '';
  var parts = s.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length <= 1) return swapShiftLabel_(s);
  return parts.map(swapShiftLabel_).join(' + ');
}

/** เวอร์ชันสั้น ของ swapShiftLabelCombined_ สำหรับตาราง "ใบแลกเวร" (คอลัมน์แคบ) */
function swapReportShiftShortCombined_(code) {
  var s = String(code == null ? '' : code).trim();
  if (!s || s === '0') return 'ไม่มีเวร';
  var parts = s.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length <= 1) return swapReportShiftShort_(s);
  return parts.map(swapReportShiftShort_).join(' + ');
}

// ── แปลงรหัสเวรเป็นข้อความอ่านง่าย พร้อมช่วงเวลา สำหรับใส่ในบันทึกข้อความ ──
//    เวรดึก/ด       = 00.00–08.00 น.
//    เวรเช้า/ช       = 08.00–16.00 น.
//    ช2บ1, ช1บ2     = 08.00–00.00 น. (เช้าต่อบ่าย รวม 16 ชม.)
//    บ1, บ2 (เดี่ยวๆ) = 16.00–00.00 น. (ครึ่งบ่ายที่ถูกแยกออกจากเวรรวม — ดู swapSplitCombinedShift_)
//    ช3(Ems)        = 08.00–16.00 น.
function swapShiftLabel_(code) {
  var s = String(code || '');
  var l = s.toLowerCase();
  if (l.indexOf('ช1บ2') === 0) return 'เวรเช้า1ต่อบ่าย2 (' + s + ') 08.00-00.00 น.';
  if (l.indexOf('ช2บ1') === 0) return 'เวรเช้า2ต่อบ่าย1 (' + s + ') 08.00-00.00 น.';
  // ✅ NEW: ครึ่งบ่ายที่ถูกแยกออกมาจากเวรรวม (ดู swapSplitCombinedShift_) เช่น "บ1", "บ2"
  if (l.indexOf('บ') === 0) return 'เวรบ่าย' + s.charAt(1) + ' (' + s + ') 16.00-00.00 น.';
  if (l.indexOf('ช3') === 0 && l.indexOf('ems') >= 0) return 'เวรเช้า 3 (EMS) (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ems') >= 0) return 'เวร EMS (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ด') === 0) return 'เวรดึก (' + s + ') 00.00-08.00 น.';
  if (l.indexOf('ช1') === 0) return 'เวรเช้า 1 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช2') === 0) return 'เวรเช้า 2 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช3') === 0) return 'เวรเช้า 3 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช') === 0) return 'เวรเช้า (' + s + ') 08.00-16.00 น.';
  return s;
}

/** วันที่แบบไทยเต็ม สำหรับหัวบันทึกข้อความ เช่น "10 กันยายน 2569" */
function swapThaiFullDate_(d) {
  var months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return d.getDate() + ' ' + months[d.getMonth() + 1] + ' ' + (d.getFullYear() + 543);
}

/** เดือน/ปี(ไทย) ของ monthSheet ปัจจุบันหรือถัดไป → ใช้ประกอบวันที่เต็มของแต่ละฝ่าย */
function swapMonthYearFor_(monthSheet) {
  var res = monthSheet === 'next' ? getWorktableScheduleNext() : getWorktableSchedule();
  if (res.status !== 'ok') return { month: new Date().getMonth() + 1, year: new Date().getFullYear() + 543 };
  return { month: Number(res.month), year: Number(res.year) };
}
function swapDayFullLabel_(day, monthSheet) {
  var my = swapMonthYearFor_(monthSheet);
  var months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return Number(day) + ' ' + (months[my.month] || '') + ' ' + my.year;
}

// ── ส่งคำขอแลกเวร ─────────────────────────────────────────────────────
/** ✅ NEW: payload.requestType — 'swap' (ค่าเริ่มต้น, แลกเวรสลับกัน 2 ทาง) หรือ 'give' (ยกเวรให้ ทางเดียว)
 *  โหมด 'give': ผู้รับเวรแทน (targetName) ไม่ต้องเลือกวันเวรของตัวเองมาแลก — ระบบจะยึด "วันเดียวกัน"
 *  กับผู้ให้เวร แล้วดึงเวรเดิมของผู้รับเวรแทนในวันนั้นมา "รวม" กับเวรที่รับมา (คั่นด้วย "/") ลงเซลล์เดียว
 *  แม้ผู้รับเวรแทนจะมีเวรอยู่แล้วในวันนั้นก็ยกเวรให้ได้ — เพื่อเป็นหลักฐานว่าทำงาน 2 เวรจริงในวันเดียว */
function submitSwapRequest(payload) {
  try {
    // ✅ FIX (บั๊กสิทธิ์แอดมินแลกเวร): เดิมเรียก verifyDriverPhone() ตรงๆ ซึ่งให้ isAdmin=true
    // เฉพาะรหัสแอดมินหลัก (WORKTABLE_ADMIN_CODE) เท่านั้น — ไม่รู้จักเบอร์ใน SWAP_ADMIN_PHONES
    // (อีก 2 ไอดีที่อนุญาตให้เป็นแอดมินระบบแลกเวรได้ แม้ไม่ใช่หัวหน้างาน) ที่ swapLogin() ใช้ตอน
    // ล็อกอิน ผลคือคนที่ล็อกอินแล้วเห็น UI สิทธิ์แอดมิน (เพราะ session.isAdmin จาก swapLogin ถูก
    // ต้อง) แต่พอส่งคำขอแทนคนอื่นจริงจะถูกปฏิเสธสิทธิ์ที่ฝั่งเซิร์ฟเวอร์ (v.isAdmin เป็น false)
    // ใหม่: ใช้ swapLogin() แทน — ตรวจสอบเบอร์เหมือนเดิมทุกอย่าง แต่เพิ่มการเช็ค
    // SWAP_ADMIN_PHONES ให้ตรงกับตอนล็อกอินเสมอ
    var v = swapLogin({ phone: payload && payload.requesterPhone });
    if (v.status !== 'ok') return v;

    var requesterName = v.name;
    var isAdminReq = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;

    var isGive = String((payload && payload.requestType) || '') === 'give';
    var requestTypeLabel = isGive ? 'ยกเวร' : 'แลกเวร';
    // ✅ NEW: โหมด "ยกเวร" เฉพาะเวรรวมเช้า-บ่าย (เช่น ช2บ1) เลือกได้ว่าจะยก 'full' (ทั้งเวร, ค่าเริ่มต้น)
    //    'am' (เฉพาะครึ่งเช้า คงครึ่งบ่ายไว้เอง) หรือ 'pm' (เฉพาะครึ่งบ่าย คงครึ่งเช้าไว้เอง)
    var giveScope = isGive ? String((payload && payload.giveScope) || 'full') : 'full';
    if (giveScope !== 'am' && giveScope !== 'pm') giveScope = 'full';

    var monthSheet = (payload && payload.monthSheet) === 'next' ? 'next' : 'current';
    var targetName = String((payload && payload.targetName) || '').trim();
    var requesterDay = Number(payload && payload.requesterDay);
    var requesterShift = String((payload && payload.requesterShift) || '');
    // โหมด "ยกเวร": วันของผู้รับเวรแทน = วันเดียวกับผู้ให้เวรเสมอ (ไม่ต้องรับค่าจากฟอร์ม)
    var targetDay = isGive ? requesterDay : Number(payload && payload.targetDay);
    var targetShift = isGive ? '' : String((payload && payload.targetShift) || '');
    var reason = String((payload && payload.reason) || '').trim();

    var staffAll = getSwapCombinedStaff_();

    // ✅ NEW: แอดมิน (WORKTABLE_ADMIN_CODE) สามารถยื่น/แลกเวรแทนพนักงานคนใดก็ได้ทั้ง 2 ฝั่ง
    //    โดยระบุ payload.requesterName มาด้วย — ไม่ต้องเข้าสู่ระบบด้วยเบอร์โทรของพนักงานคนนั้นเอง
    var actingName = v.name; // ชื่อผู้ทำรายการจริง (เก็บไว้บันทึกลงคอลัมน์ "ดำเนินการโดย")
    if (v.isAdmin && payload && payload.requesterName) {
      requesterName = String(payload.requesterName).trim();
      if (!findSwapStaff_(staffAll, requesterName)) {
        return { status: 'error', message: 'ไม่พบชื่อพนักงานคนที่ 1 (ผู้ให้เวร) ในตารางเวร' };
      }
    }

    if (!requesterName) return { status: 'error', message: 'กรุณาเลือกพนักงานคนที่ 1 (ผู้ให้เวร)' };
    if (!targetName) return { status: 'error', message: 'กรุณาเลือกเพื่อนร่วมงานที่จะ' + requestTypeLabel + 'ด้วย' };
    if (!requesterDay || !requesterShift) return { status: 'error', message: 'ข้อมูลวันเวรของคุณไม่ถูกต้อง' };
    if (!isGive && (!targetDay || !targetShift)) return { status: 'error', message: 'ข้อมูลวันเวรของเพื่อนร่วมงานไม่ถูกต้อง' };
    if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลการ' + requestTypeLabel };
    if (!payload || !payload.consent) return { status: 'error', message: 'กรุณายืนยันว่าตกลงกับเพื่อนร่วมงานแล้ว' };

    if (!findSwapStaff_(staffAll, targetName)) {
      return { status: 'error', message: 'ไม่พบชื่อเพื่อนร่วมงานในตารางเวร' };
    }
    if (targetName === requesterName) {
      return { status: 'error', message: 'ไม่สามารถ' + requestTypeLabel + 'กับตัวเองได้' };
    }

    // ✅ ป้องกันการขอแลกเวร/ยกเวรทับซ้อน/ผิดปกติ — เช็คฝั่งเซิร์ฟเวอร์เป็นด่านสุดท้ายเสมอ
    //    (กันข้อมูลค้างจากหน้าจอที่เปิดทิ้งไว้นาน หรือกดส่งซ้ำ/ส่งพร้อมกันจากหลายอุปกรณ์)
    // 1) วันเวรนี้มีคำขออื่น "รอตรวจสอบ" ค้างอยู่แล้วหรือไม่ (ทั้งฝั่งผู้ให้เวรและผู้รับเวรแทน)
    var reqPending = findSwapDayConflicts_(monthSheet, requesterName, requesterDay)
      .filter(function (c) { return c.status === 'รอตรวจสอบ'; });
    if (reqPending.length) {
      return {
        status: 'error',
        message: 'วันเวรของ ' + requesterName + ' วันที่ ' + requesterDay +
          ' มีคำขอแลกเวรอื่นรอตรวจสอบอยู่แล้ว (กับ ' + reqPending[0].withName + ') กรุณารอผลคำขอเดิมก่อน หรือแจ้งแอดมินให้ปฏิเสธคำขอเดิมก่อนยื่นใหม่'
      };
    }
    // โหมด "ยกเวร" ตั้งใจอนุญาตให้ผู้รับเวรแทนมีเวรอนุมัติแล้วในวันนั้นอยู่ก่อนได้ (นั่นคือจุดประสงค์ของฟีเจอร์นี้)
    // จึงเช็คเฉพาะคำขอ "รอตรวจสอบ" อื่นที่ค้างอยู่บนวันเดียวกันของผู้รับเวรแทน กันการยื่นซ้อนกันเท่านั้น
    var tgtPending = findSwapDayConflicts_(monthSheet, targetName, targetDay)
      .filter(function (c) { return c.status === 'รอตรวจสอบ'; });
    if (tgtPending.length) {
      return {
        status: 'error',
        message: 'วันเวรของ ' + targetName + ' วันที่ ' + targetDay +
          ' มีคำขอแลกเวรอื่นรอตรวจสอบอยู่แล้ว (กับ ' + tgtPending[0].withName + ') กรุณารอผลคำขอเดิมก่อน หรือแจ้งแอดมินให้ปฏิเสธคำขอเดิมก่อนยื่นใหม่'
      };
    }
    // 2) ข้อมูลเวรที่ส่งมาต้องตรงกับตารางเวร "จริง" ในขณะนี้ — กันกรณีวันนั้นถูกแลกไปแล้ว
    //    โดยคำขออื่นที่เพิ่งอนุมัติไป ระหว่างที่หน้าจอฝั่งผู้ใช้เปิดค้างไว้
    var actualReqShift = getActualShiftForCell_(monthSheet, requesterName, requesterDay);
    if (actualReqShift === null) {
      return { status: 'error', message: 'ไม่พบชื่อ ' + requesterName + ' ในตารางเวร' };
    }
    if (String(actualReqShift) !== String(requesterShift)) {
      return {
        status: 'error',
        message: 'ข้อมูลเวรของ ' + requesterName + ' วันที่ ' + requesterDay +
          ' มีการเปลี่ยนแปลงไปแล้ว (อาจถูกแลกไปก่อนหน้านี้) กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'
      };
    }

    // ✅ NEW: ถ้าเลือกยกเฉพาะครึ่งเวร (giveScope !== 'full') ต้องแบ่งเวรจริง (requesterShift ที่เพิ่ง
    //    ตรวจสอบตรงกับตารางเวรสดด้านบนแล้ว) ออกเป็น 2 ส่วน — ใช้ส่วนที่ "ยกให้" (givenShift) แทน
    //    requesterShift เต็มวันในการรวมเวรของผู้รับเวรแทน และเก็บส่วนที่เหลือ (remainingReqShift) ไว้
    //    ให้ผู้ให้เวรเอง (ไม่ล้างทิ้งเหมือนยกทั้งเวร)
    var givenShift = requesterShift;
    var remainingReqShift = '';
    if (isGive && giveScope !== 'full') {
      var splitParts = swapSplitCombinedShift_(requesterShift);
      if (!splitParts) {
        return {
          status: 'error',
          message: 'เวรของ ' + requesterName + ' วันที่ ' + requesterDay + ' (' + requesterShift + ') ' +
            'ไม่ใช่เวรรวมเช้า-บ่ายที่แบ่งครึ่งได้ (ต้องเป็นรูปแบบ เช้า+บ่าย เช่น ช1บ2 หรือ ช2บ1 เท่านั้น) กรุณาเลือก "ยกทั้งเวร" แทน'
        };
      }
      givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
      remainingReqShift = (giveScope === 'am') ? splitParts.pm : splitParts.am;
    }

    var actualTgtShift;
    if (isGive) {
      // ✅ โหมด "ยกเวร": ไม่รับ targetShift จากฟอร์ม — ดึงเวร "ปัจจุบันจริง" ของผู้รับเวรแทนในวันนั้นจากชีทเสมอ
      //    (อาจว่างเปล่า หมายถึงยังไม่มีเวร หรือมีอยู่แล้ว หมายถึงจะถูกนำไปรวมกับเวรที่รับมา)
      actualTgtShift = getActualShiftForCell_(monthSheet, targetName, targetDay);
      if (actualTgtShift === null) {
        return { status: 'error', message: 'ไม่พบชื่อ ' + targetName + ' ในตารางเวร' };
      }
      targetShift = String(actualTgtShift == null || actualTgtShift === 0 ? '' : actualTgtShift);
    } else {
      actualTgtShift = getActualShiftForCell_(monthSheet, targetName, targetDay);
      if (actualTgtShift === null) {
        return { status: 'error', message: 'ไม่พบชื่อ ' + targetName + ' ในตารางเวร' };
      }
      if (String(actualTgtShift) !== String(targetShift)) {
        return {
          status: 'error',
          message: 'ข้อมูลเวรของ ' + targetName + ' วันที่ ' + targetDay +
            ' มีการเปลี่ยนแปลงไปแล้ว (อาจถูกแลกไปก่อนหน้านี้) กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'
        };
      }
    }

    var requestId = generateSwapRequestId_();
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    var sheet = getSwapRequestsSheet_();
    var idx = jobsHeaderIndex_(sheet.getDataRange().getValues()[0]);
    // ✅ [ยกเวรให้] นำหน้าเหตุผลไว้ในบันทึก — ให้เห็นชัดทั้งในหน้าประวัติและ "ใบแลกเวร" ที่ยื่นฝ่ายการเงิน
    //    ✅ NEW: กรณียกครึ่งเวร ระบุชัดว่ายกส่วนไหน เหลือส่วนไหนไว้เอง กันสับสนตอนตรวจสอบย้อนหลัง
    var reasonForRecord = reason;
    if (isGive) {
      reasonForRecord = (giveScope !== 'full')
        ? '[ยกครึ่งเวร: ยก ' + givenShift + ' ให้ ' + targetName + ' / คงเหลือ ' + remainingReqShift + ' ไว้กับตนเอง] ' + reason
        : '[ยกเวรให้] ' + reason;
    }

    if (isAdminReq) {
      // แอดมิน/หัวหน้างาน ยื่นเอง → อนุมัติทันที + เขียนตารางจริง + สร้างบันทึกข้อความ
      var resultShift;
      if (isGive) {
        resultShift = applyGiveShiftToSheet_(monthSheet, requesterName, requesterDay, givenShift, targetName, targetShift, remainingReqShift);
      } else {
        applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift);
      }

      var memo = generateSwapMemoDoc({
        requesterName: requesterName,
        targetName: targetName,
        reason: reasonForRecord,
        oldDate: swapDayFullLabel_(requesterDay, monthSheet),
        oldShift: swapShiftLabel_(requesterShift),
        targetDate: swapDayFullLabel_(targetDay, monthSheet),
        targetShift: isGive ? swapShiftLabelCombined_(resultShift) : swapShiftLabel_(targetShift)
      });

      sheet.appendRow(buildSwapRequestRow_(idx, {
        'RequestID': requestId, 'เดือน': monthSheet, 'ชื่อผู้ขอแลก': requesterName, 'เบอร์ผู้ขอแลก': v.phone,
        'วันที่เดิมของผู้ขอแลก': requesterDay, 'เวรเดิมของผู้ขอแลก': requesterShift,
        'ชื่อผู้รับแลก': targetName, 'วันที่เดิมของผู้รับแลก': targetDay, 'เวรเดิมของผู้รับแลก': targetShift,
        'เหตุผล': reasonForRecord, 'สถานะ': 'อนุมัติอัตโนมัติ (แอดมิน)', 'บันทึกเมื่อ': now,
        'ดำเนินการโดย': actingName, 'ดำเนินการเมื่อ': now, 'เหตุผลที่ปฏิเสธ': '',
        'DocURL': memo.docUrl || '', 'PdfURL': memo.pdfUrl || '',
        'ประเภทคำขอ': requestTypeLabel, 'ส่วนที่ยก': giveScope
      }));

      return { status: 'ok', autoApproved: true, requestId: requestId, memo: memo };
    }

    sheet.appendRow(buildSwapRequestRow_(idx, {
      'RequestID': requestId, 'เดือน': monthSheet, 'ชื่อผู้ขอแลก': requesterName, 'เบอร์ผู้ขอแลก': v.phone,
      'วันที่เดิมของผู้ขอแลก': requesterDay, 'เวรเดิมของผู้ขอแลก': requesterShift,
      'ชื่อผู้รับแลก': targetName, 'วันที่เดิมของผู้รับแลก': targetDay, 'เวรเดิมของผู้รับแลก': targetShift,
      'เหตุผล': reasonForRecord, 'สถานะ': 'รอตรวจสอบ', 'บันทึกเมื่อ': now,
      'ดำเนินการโดย': '', 'ดำเนินการเมื่อ': '', 'เหตุผลที่ปฏิเสธ': '',
      'DocURL': '', 'PdfURL': '',
      'ประเภทคำขอ': requestTypeLabel, 'ส่วนที่ยก': giveScope
    }));

    return { status: 'ok', autoApproved: false, requestId: requestId };
  } catch (err) {
    console.error('submitSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── รายการรอตรวจสอบ (แอดมิน/หัวหน้างาน) ──────────────────────────────
function getPendingSwapRequests() {
  try {
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') continue;
      out.push({
        requestId: row[idx['RequestID']],
        monthSheet: row[idx['เดือน']],
        requesterName: row[idx['ชื่อผู้ขอแลก']],
        requesterDay: row[idx['วันที่เดิมของผู้ขอแลก']],
        requesterShift: row[idx['เวรเดิมของผู้ขอแลก']],
        targetName: row[idx['ชื่อผู้รับแลก']],
        targetDay: row[idx['วันที่เดิมของผู้รับแลก']],
        targetShift: row[idx['เวรเดิมของผู้รับแลก']],
        reason: row[idx['เหตุผล']],
        status: row[idx['สถานะ']],
        createdAt: row[idx['บันทึกเมื่อ']],
        // ✅ NEW: 'ยกเวร' (ให้ทางเดียว) หรือ 'แลกเวร' (สลับ 2 ทาง) — ดูค่าเริ่มต้นเผื่อคำขอเก่าก่อนมีคอลัมน์นี้
        requestType: (idx['ประเภทคำขอ'] != null && row[idx['ประเภทคำขอ']]) ? row[idx['ประเภทคำขอ']] : 'แลกเวร',
        // ✅ NEW: 'full' (ยกทั้งเวร) / 'am' (เฉพาะครึ่งเช้า) / 'pm' (เฉพาะครึ่งบ่าย) — ดูค่าเริ่มต้นเผื่อคำขอเก่า
        giveScope: (idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']]) ? row[idx['ส่วนที่ยก']] : 'full'
      });
    }
    out.reverse(); // ใหม่สุดก่อน
    return { status: 'ok', requests: out };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function findSwapRequestRow_(sheet, requestId) {
  var data = sheet.getDataRange().getValues();
  var idx = jobsHeaderIndex_(data[0]);
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['RequestID']]) === String(requestId)) {
      return { rowNum: r + 1, row: data[r], idx: idx };
    }
  }
  return null;
}

// ── อนุมัติคำขอ ───────────────────────────────────────────────────────
function approveSwapRequest(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ — เดิม verifyDriverPhone() ไม่รู้จัก
    // SWAP_ADMIN_PHONES (อีก 2 ไอดีที่ได้สิทธิ์แอดมินระบบแลกเวรแม้ไม่ใช่หัวหน้างาน) ทำให้คนกลุ่มนี้
    // ล็อกอินเห็น UI สิทธิ์แอดมิน (ปุ่มอนุมัติ/ปฏิเสธ) แต่กดอนุมัติจริงแล้วโดนปฏิเสธสิทธิ์เสมอ
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์อนุมัติคำขอแลกเวร' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx, row = found.row;
    if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') {
      return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' };
    }

    var monthSheet = row[idx['เดือน']];
    var requesterName = row[idx['ชื่อผู้ขอแลก']];
    var requesterDay = row[idx['วันที่เดิมของผู้ขอแลก']];
    var requesterShift = row[idx['เวรเดิมของผู้ขอแลก']];
    var targetName = row[idx['ชื่อผู้รับแลก']];
    var targetDay = row[idx['วันที่เดิมของผู้รับแลก']];
    var targetShift = row[idx['เวรเดิมของผู้รับแลก']];
    var reason = row[idx['เหตุผล']];
    var isGive = idx['ประเภทคำขอ'] != null && String(row[idx['ประเภทคำขอ']] || '') === 'ยกเวร';
    // ✅ NEW: 'full' (ยกทั้งเวร, ค่าเริ่มต้น) / 'am' / 'pm' — ใช้แบ่งครึ่ง requesterShift (เก็บเป็นเวรรวมเต็ม
    //    ในคอลัมน์ 'เวรเดิมของผู้ขอแลก' เสมอ ไม่ว่าจะยกทั้งเวรหรือครึ่งเดียว) ตอนเขียนลงตารางเวรจริง
    var giveScope = idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']] ? String(row[idx['ส่วนที่ยก']]) : 'full';

    var memoTargetShiftLabel;
    if (isGive) {
      var givenShift = requesterShift;
      var remainingReqShift = '';
      if (giveScope !== 'full') {
        var splitParts = swapSplitCombinedShift_(requesterShift);
        if (splitParts) {
          givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
          remainingReqShift = (giveScope === 'am') ? splitParts.pm : splitParts.am;
        }
        // หมายเหตุ: ถ้าแบ่งไม่ได้ (ข้อมูลผิดปกติ) จะ fallback เป็นยกทั้งเวรเหมือนเดิม เพื่อไม่ให้คำขอค้าง
      }
      var resultShift = applyGiveShiftToSheet_(monthSheet, requesterName, requesterDay, givenShift, targetName, targetShift, remainingReqShift);
      memoTargetShiftLabel = swapShiftLabelCombined_(resultShift);
    } else {
      applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift);
      memoTargetShiftLabel = swapShiftLabel_(targetShift);
    }

    var memo = generateSwapMemoDoc({
      requesterName: requesterName,
      targetName: targetName,
      reason: reason,
      oldDate: swapDayFullLabel_(requesterDay, monthSheet),
      oldShift: swapShiftLabel_(requesterShift),
      targetDate: swapDayFullLabel_(targetDay, monthSheet),
      targetShift: memoTargetShiftLabel
    });

    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sheet.getRange(found.rowNum, idx['สถานะ'] + 1).setValue('อนุมัติแล้ว');
    sheet.getRange(found.rowNum, idx['ดำเนินการโดย'] + 1).setValue(v.name);
    sheet.getRange(found.rowNum, idx['ดำเนินการเมื่อ'] + 1).setValue(now);
    sheet.getRange(found.rowNum, idx['DocURL'] + 1).setValue(memo.docUrl || '');
    sheet.getRange(found.rowNum, idx['PdfURL'] + 1).setValue(memo.pdfUrl || '');

    return { status: 'ok', memo: memo };
  } catch (err) {
    console.error('approveSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── สร้าง/สร้างใหม่เอกสารบันทึกข้อความ สำหรับคำขอที่อนุมัติแล้ว ──────────
// ✅ NEW: ใช้กับปุ่ม "สร้างเอกสาร" ในหน้ารออนุมัติ (หลังกดอนุมัติ) และหน้าประวัติ
//    เพื่อสร้าง/สร้างใหม่เอกสารได้ทันทีโดยไม่ต้องรออนุมัติซ้ำ — เช่น กรณีสร้างเอกสารครั้งแรกไม่สำเร็จ
//    หรือต้องการสร้างใหม่ด้วยเทมเพลตล่าสุด
function regenerateSwapMemo(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ (ดูคำอธิบายเดียวกับ approveSwapRequest)
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์สร้างเอกสารนี้' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx, row = found.row;

    var status = String(row[idx['สถานะ']] || '');
    if (status.indexOf('อนุมัติ') < 0) {
      return { status: 'error', message: 'สร้างเอกสารได้เฉพาะคำขอที่อนุมัติแล้วเท่านั้น' };
    }

    var monthSheet     = row[idx['เดือน']];
    var requesterName  = row[idx['ชื่อผู้ขอแลก']];
    var requesterDay   = row[idx['วันที่เดิมของผู้ขอแลก']];
    var requesterShift = row[idx['เวรเดิมของผู้ขอแลก']];
    var targetName     = row[idx['ชื่อผู้รับแลก']];
    var targetDay      = row[idx['วันที่เดิมของผู้รับแลก']];
    var targetShift    = row[idx['เวรเดิมของผู้รับแลก']];
    var reason         = row[idx['เหตุผล']];
    var isGive         = idx['ประเภทคำขอ'] != null && String(row[idx['ประเภทคำขอ']] || '') === 'ยกเวร';
    // ✅ NEW: 'full' (ยกทั้งเวร, ค่าเริ่มต้น) / 'am' / 'pm' — แบ่งครึ่ง requesterShift ก่อนคำนวณผลรวม
    var giveScope = idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']] ? String(row[idx['ส่วนที่ยก']]) : 'full';
    var givenShift = requesterShift;
    if (isGive && giveScope !== 'full') {
      var splitParts = swapSplitCombinedShift_(requesterShift);
      if (splitParts) givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
    }
    // ✅ NEW: โหมด "ยกเวร" แสดงผลรวมของเวรเดิม+เวรที่รับมาในเอกสาร (เช่น "ด/ช1บ2" หรือ "ด/บ1" ถ้ายกครึ่งเวร) ให้ตรงกับตารางเวรจริง
    var memoTargetShiftLabel = isGive
      ? swapShiftLabelCombined_(swapCombineShiftValues_(targetShift, givenShift))
      : swapShiftLabel_(targetShift);

    var memo = generateSwapMemoDoc({
      requesterName: requesterName,
      targetName: targetName,
      reason: reason,
      oldDate: swapDayFullLabel_(requesterDay, monthSheet),
      oldShift: swapShiftLabel_(requesterShift),
      targetDate: swapDayFullLabel_(targetDay, monthSheet),
      targetShift: memoTargetShiftLabel
    });

    if (memo.status === 'ok') {
      sheet.getRange(found.rowNum, idx['DocURL'] + 1).setValue(memo.docUrl || '');
      sheet.getRange(found.rowNum, idx['PdfURL'] + 1).setValue(memo.pdfUrl || '');
    }

    return { status: 'ok', memo: memo };
  } catch (err) {
    console.error('regenerateSwapMemo error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── ปฏิเสธคำขอ ───────────────────────────────────────────────────────
function rejectSwapRequest(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ (ดูคำอธิบายเดียวกับ approveSwapRequest)
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์ปฏิเสธคำขอแลกเวร' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx;
    if (String(found.row[idx['สถานะ']]) !== 'รอตรวจสอบ') {
      return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' };
    }

    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sheet.getRange(found.rowNum, idx['สถานะ'] + 1).setValue('ปฏิเสธ');
    sheet.getRange(found.rowNum, idx['ดำเนินการโดย'] + 1).setValue(v.name);
    sheet.getRange(found.rowNum, idx['ดำเนินการเมื่อ'] + 1).setValue(now);
    sheet.getRange(found.rowNum, idx['เหตุผลที่ปฏิเสธ'] + 1).setValue(String((payload && payload.reason) || ''));

    return { status: 'ok' };
  } catch (err) {
    console.error('rejectSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── ประวัติการแลกเวร ─────────────────────────────────────────────────
function getSwapHistory(params) {
  try {
    var phone = normalizePhone_((params && params.phone) || '');
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (phone && normalizePhone_(row[idx['เบอร์ผู้ขอแลก']]) !== phone) continue;
      out.push({
        requestId: row[idx['RequestID']],
        requesterName: row[idx['ชื่อผู้ขอแลก']],
        requesterDay: row[idx['วันที่เดิมของผู้ขอแลก']],
        requesterShift: row[idx['เวรเดิมของผู้ขอแลก']],
        targetName: row[idx['ชื่อผู้รับแลก']],
        targetDay: row[idx['วันที่เดิมของผู้รับแลก']],
        targetShift: row[idx['เวรเดิมของผู้รับแลก']],
        reason: row[idx['เหตุผล']],
        status: row[idx['สถานะ']],
        createdAt: row[idx['บันทึกเมื่อ']],
        decidedBy: row[idx['ดำเนินการโดย']],
        decidedAt: row[idx['ดำเนินการเมื่อ']],
        rejectReason: row[idx['เหตุผลที่ปฏิเสธ']],
        docUrl: row[idx['DocURL']],
        pdfUrl: row[idx['PdfURL']],
        // ✅ NEW: 'ยกเวร' (ให้ทางเดียว) หรือ 'แลกเวร' (สลับ 2 ทาง) — ดูค่าเริ่มต้นเผื่อคำขอเก่าก่อนมีคอลัมน์นี้
        requestType: (idx['ประเภทคำขอ'] != null && row[idx['ประเภทคำขอ']]) ? row[idx['ประเภทคำขอ']] : 'แลกเวร',
        // ✅ NEW: 'full' (ยกทั้งเวร) / 'am' (เฉพาะครึ่งเช้า) / 'pm' (เฉพาะครึ่งบ่าย) — ดูค่าเริ่มต้นเผื่อคำขอเก่า
        giveScope: (idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']]) ? row[idx['ส่วนที่ยก']] : 'full'
      });
    }
    out.reverse(); // ใหม่สุดก่อน
    return { status: 'ok', requests: out };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function setupSwapRequestsSheet() {
  getSwapRequestsSheet_();
  return { status: 'ok', message: 'ตั้งค่า sheet SwapRequests เรียบร้อยแล้ว' };
}

// ═══════════════════════════════════════════════════════════════════
//  ป้องกันการขอแลกเวรทับซ้อน / ผิดปกติ
//  - checkSwapConflicts: เรียกจากหน้าเว็บ (ก่อนส่งคำขอ) เพื่อ "เตือน" ผู้ใช้ ไม่บล็อก
//  - ด่านบังคับจริง (บล็อกการบันทึก) อยู่ใน submitSwapRequest ด้านบน — เช็คซ้ำที่นี่เผื่อ
//    ผู้ใช้ข้ามหน้าเว็บ (เช่น เรียก API ตรงๆ) หรือข้อมูลบนจอค้างจากตอนโหลดหน้า
// ═══════════════════════════════════════════════════════════════════

/** สถานะที่ถือว่า "ยังมีผลอยู่" ของคำขอแลกเวร (ไม่ใช่ถูกปฏิเสธ) — ใช้ตรวจว่าวันเวรนี้
 *  เคยถูกใช้ไปแล้ว (อนุมัติแล้ว) หรือยังมีคำขอค้างอยู่ (รอตรวจสอบ) */
function swapStatusIsActive_(status) {
  var s = String(status || '');
  return s === 'รอตรวจสอบ' || s.indexOf('อนุมัติ') === 0;
}

/** หาคำขอแลกเวร (ที่ยังไม่ถูกปฏิเสธ) ที่เกี่ยวข้องกับ "คนคนหนึ่ง" ในวันที่หนึ่ง ของเดือนหนึ่ง
 *  ไม่ว่าคนนั้นจะเคยเป็นฝั่งผู้ขอแลกหรือผู้รับแลกในคำขอเดิมก็ตาม */
function findSwapDayConflicts_(monthSheet, personName, day) {
  var sheet = getSwapRequestsSheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var idx = jobsHeaderIndex_(data[0]);
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['เดือน']]) !== String(monthSheet)) continue;
    if (!swapStatusIsActive_(row[idx['สถานะ']])) continue;

    var isRequesterSide = row[idx['ชื่อผู้ขอแลก']] === personName &&
      Number(row[idx['วันที่เดิมของผู้ขอแลก']]) === Number(day);
    var isTargetSide = row[idx['ชื่อผู้รับแลก']] === personName &&
      Number(row[idx['วันที่เดิมของผู้รับแลก']]) === Number(day);
    if (!isRequesterSide && !isTargetSide) continue;

    out.push({
      requestId: row[idx['RequestID']],
      status: row[idx['สถานะ']],
      withName: isRequesterSide ? row[idx['ชื่อผู้รับแลก']] : row[idx['ชื่อผู้ขอแลก']],
      createdAt: row[idx['บันทึกเมื่อ']],
      decidedAt: row[idx['ดำเนินการเมื่อ']]
    });
  }
  return out;
}

/** เรียกจากหน้าเว็บ swap.html ก่อนส่งคำขอจริง — เช็คว่าวันเวรของ "ผู้ขอแลก" และ/หรือ "ผู้รับแลก"
 *  เคยมี/มีคำขอแลกเวรอยู่แล้วในเดือนเดียวกันหรือไม่ เพื่อแสดงคำเตือนบนหน้าจอ
 *  (ไม่บล็อกอัตโนมัติที่นี่ — ด่านบล็อกจริงอยู่ใน submitSwapRequest) */
function checkSwapConflicts(payload) {
  try {
    var monthSheet = (payload && payload.monthSheet) === 'next' ? 'next' : 'current';
    var requesterName = String((payload && payload.requesterName) || '').trim();
    var requesterDay = Number(payload && payload.requesterDay);
    var targetName = String((payload && payload.targetName) || '').trim();
    var targetDay = Number(payload && payload.targetDay);

    var result = { status: 'ok', requesterConflicts: [], targetConflicts: [] };
    if (requesterName && requesterDay) {
      result.requesterConflicts = findSwapDayConflicts_(monthSheet, requesterName, requesterDay);
    }
    if (targetName && targetDay) {
      result.targetConflicts = findSwapDayConflicts_(monthSheet, targetName, targetDay);
    }
    return result;
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** อ่านค่าเวร "จริง" ปัจจุบันของคนคนหนึ่งในวันหนึ่ง จากชีทตารางเวร (ไม่ใช่ค่าที่ส่งมาจากหน้าเว็บ)
 *  ใช้ตรวจสอบความผิดปกติ/ข้อมูลล้าสมัยก่อนบันทึกคำขอแลกเวรจริง เช่น กรณีเปิดหน้าจอค้างไว้นาน
 *  แล้ววันเวรนั้นถูกแลกไปแล้วโดยคำขออื่นที่อนุมัติไปก่อนหน้า — คืนค่า null ถ้าไม่พบชื่อในตาราง */
function getActualShiftForCell_(monthSheet, nameOrNick, day) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }
  for (var r = dataStartRow; r < data.length; r++) {
    var nm = String(data[r][0] || '').trim();
    var nk = String(data[r][1] || '').trim();
    if (nm === nameOrNick || nk === nameOrNick) {
      var col = rosterDayColumn_(sheetName, day); // 1-based column — อ่านจากหัวตาราง สอดคล้องกับ applySwapToSheet_
      return data[r][col - 1];
    }
  }
  return null;
}
