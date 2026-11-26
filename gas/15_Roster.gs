// ═══════════════════════════════════════════════════════════════════
//  ROSTER — อ่าน "ผู้อยู่เวรวันนี้" จากชีท ตารางเวร / ตารางเวรถัดไป
//
//  ออกแบบให้ทนต่อการเปลี่ยนแปลงของตารางเวรเมื่อขึ้นเดือนใหม่ โดยไม่ต้องแก้โค้ดหรือสลับชีทด้วยมือ:
//   1) เลือกชีทจาก "เดือน/ปีที่เขียนในชีท" ไม่ใช่จากชื่อชีท และไม่เชื่อ MetaWorktable (เคยค้างเดือนเก่า)
//      → ไม่ว่าเดือนใหม่จะอยู่ในชีท "ตารางเวร" หรือ "ตารางเวรถัดไป" ก็หาเจอเอง
//      → ชีทอื่นที่ชื่อขึ้นต้นด้วย "ตารางเวร" (เช่น ตารางเวรถัดไป1) ก็ถูกพิจารณาด้วย
//   2) อ่านเดือน/ปีได้หลายรูปแบบ: "ประจำเดือน ตุลาคม พ.ศ. 2569", ต.ค. 69, ค.ศ., 10/2569, เซลล์ชนิดวันที่,
//      พิมพ์ผิด (พฤศจิการยน) — ถ้าอ่านหัวชีทไม่ได้ จะดูจากวันที่ในหัวคอลัมน์ หรือเทียบ "วันในสัปดาห์" กับปฏิทินแทน
//   3) หัวคอลัมน์วันที่อ่านได้ทุกแบบ: "5\nจ", 5, 05/10/2569, "5 ต.ค.", เซลล์ชนิดวันที่ (Sheets แปลงให้เองเมื่อพิมพ์)
//   4) ช่องว่าง / 0 / 0.0 / - / หยุด = ไม่มีเวร, ขึ้นต้นด้วย "ลา" = ลา (แยกบรรทัด ไม่นับเป็นผู้อยู่เวร)
//   5) ตรวจ "วันในสัปดาห์ของหัวคอลัมน์" เทียบปฏิทินจริง ถ้าไม่ตรงจะแจ้งเตือนในข้อความ (กันกรณีคัดลอกชีทเก่ามาแก้แค่ชื่อเดือน)
// ═══════════════════════════════════════════════════════════════════

var ROSTER_SHEET_PREFIX_ = 'ตารางเวร';
var ROSTER_TZ_           = 'Asia/Bangkok';
var ROSTER_MONTH_NAMES_  = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
var ROSTER_DOW_NAMES_    = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
// จับด้วย "ต้นคำ"/ตัวย่อ เพราะในชีทเคยพิมพ์ผิด เช่น "พฤศจิการยน"
var ROSTER_MONTH_RX_ = [null,
  /มกรา|ม\.\s?ค|\bjan/i, /กุมภา|ก\.\s?พ|\bfeb/i, /มีนา|มี\.\s?ค|\bmar/i, /เมษา|เม\.\s?ย|\bapr/i,
  /พฤษภา|พ\.\s?ค|\bmay\b/i, /มิถุนา|มิ\.\s?ย|\bjun/i, /กรกฎา|ก\.\s?ค|\bjul/i, /สิงหา|ส\.\s?ค|\baug/i,
  /กันยา|ก\.\s?ย|\bsep/i, /ตุลา|ต\.\s?ค|\boct/i, /พฤศจิ|พ\.\s?ย|\bnov/i, /ธันวา|ธ\.\s?ค|\bdec/i
];

function rosterFmt_(d, tz, f) { return Utilities.formatDate(d, tz, f); }
function rosterNormYear_(y) { y = Number(y); return y > 2400 ? y - 543 : y; }
function rosterClean_(v) { return String(v == null ? '' : v).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim(); }

function rosterMonthFromText_(t) {
  var s = String(t == null ? '' : t);
  for (var m = 1; m <= 12; m++) if (ROSTER_MONTH_RX_[m].test(s)) return m;
  return 0;
}

/** ปีจากข้อความ: 2569 / 2026 / "69" ท้ายข้อความ → ปี ค.ศ. | null */
function rosterYearFromText_(t) {
  var s = String(t == null ? '' : t);
  var m = s.match(/(?:^|[^\d])(\d{4})(?!\d)/);
  if (m) { var y = rosterNormYear_(m[1]); if (y >= 1990 && y <= 2200) return y; }
  m = s.match(/(?:^|[^\d])(\d{2})\s*$/);
  if (m) { var y2 = Number(m[1]); return y2 >= 40 ? 2500 + y2 - 543 : 2000 + y2; }
  return null;
}

/** parseRosterTitleCell_ — เซลล์หัวชีท → { month, year|null } | null */
function parseRosterTitleCell_(raw, tz) {
  if (raw instanceof Date) return { month: Number(rosterFmt_(raw, tz, 'M')), year: rosterNormYear_(rosterFmt_(raw, tz, 'yyyy')) };
  var s = rosterClean_(raw);
  if (!s) return null;
  var m = rosterMonthFromText_(s);
  if (m) return { month: m, year: rosterYearFromText_(s) };
  var f = s.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);          // 1/10/2569
  if (f && Number(f[2]) >= 1 && Number(f[2]) <= 12) return { month: Number(f[2]), year: rosterYearFromText_(f[3]) || rosterNormYear_(f[3]) };
  var mm = s.match(/^\D*?(\d{1,2})\s*[\/\-.]\s*(\d{4})\D*$/);                          // 10/2569
  if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) return { month: Number(mm[1]), year: rosterNormYear_(mm[2]) };
  return null;
}

/** วันในสัปดาห์จากตัวย่อไทย/อังกฤษ → 0=อาทิตย์ … 6=เสาร์ | null */
function rosterDowFromText_(t) {
  var s = String(t == null ? '' : t).replace(/[\s().\[\]]/g, '').toLowerCase();
  if (!s) return null;
  var table = [['อาทิตย์', 0], ['อาทิ', 0], ['อา', 0], ['sun', 0], ['จันทร์', 1], ['จ', 1], ['mon', 1], ['อังคาร', 2], ['อ', 2], ['tue', 2],
               ['พฤหัสบดี', 4], ['พฤหัส', 4], ['พฤ', 4], ['thu', 4], ['พุธ', 3], ['พ', 3], ['wed', 3], ['ศุกร์', 5], ['ศ', 5], ['fri', 5],
               ['เสาร์', 6], ['ส', 6], ['sat', 6]];
  for (var i = 0; i < table.length; i++) if (s.indexOf(table[i][0]) === 0) return table[i][1];
  return null;
}

/** parseRosterDayHeader_ — หัวคอลัมน์วันที่ → { day, month|null, year|null, dow|null } | null */
function parseRosterDayHeader_(cell, tz) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (cell instanceof Date) {
    return { day: Number(rosterFmt_(cell, tz, 'd')), month: Number(rosterFmt_(cell, tz, 'M')),
             year: rosterNormYear_(rosterFmt_(cell, tz, 'yyyy')), dow: Number(rosterFmt_(cell, tz, 'u')) % 7 };
  }
  if (typeof cell === 'number') {
    if (cell % 1 === 0 && cell >= 1 && cell <= 31) return { day: cell, month: null, year: null, dow: null };
    if (cell > 30000 && cell < 80000) { // เลข serial ของวันที่
      var dt = new Date(Math.round((cell - 25569) * 86400000));
      return { day: dt.getUTCDate(), month: dt.getUTCMonth() + 1, year: dt.getUTCFullYear(), dow: dt.getUTCDay() };
    }
    return null;
  }
  var s = rosterClean_(cell);
  if (!s) return null;
  var f = s.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);          // 05/10/2569
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 31 && Number(f[2]) >= 1 && Number(f[2]) <= 12) {
    var y = rosterYearFromText_(' ' + f[3]) || rosterNormYear_(f[3]);
    return { day: Number(f[1]), month: Number(f[2]), year: y, dow: new Date(Date.UTC(y, Number(f[2]) - 1, Number(f[1]))).getUTCDay() };
  }
  var lead = s.match(/^(\d{1,2})(?!\d)\s*(.*)$/);                                      // "5 จ" / "5 ต.ค." / "5"
  if (!lead) return null;
  var day = Number(lead[1]);
  if (day < 1 || day > 31) return null;
  var rest = lead[2] || '';
  var mo = rosterMonthFromText_(rest);
  if (mo) return { day: day, month: mo, year: rosterYearFromText_(rest), dow: null };
  return { day: day, month: null, year: null, dow: rosterDowFromText_(rest) };
}

function normShiftCell_(raw) {
  if (raw === null || raw === undefined || raw instanceof Date) return '';
  return rosterClean_(raw).replace(/（/g, '(').replace(/）/g, ')');
}
/** isOffShift_ — ช่องว่าง / 0 / 0.0 / ขีด / หยุด = ไม่มีเวร (ตารางเวรใหม่ใส่ "0" ในวันหยุด) */
function isOffShift_(v) {
  v = normShiftCell_(v);
  return v === '' || /^[0\-–—.\s]+$/.test(v) || v === 'หยุด' || v === 'วันหยุด' || /^(off|x)$/i.test(v);
}
function isLeaveShift_(v) { v = normShiftCell_(v); return v.indexOf('ลา') === 0 || /^leave$/i.test(v); }

function rosterIsNameHeader_(cell) {
  return /^ชื่อ[\-–—]?(นาม)?สกุล$/.test(String(cell == null ? '' : cell).replace(/\s+/g, ''));
}

/** รายชื่อชีทตารางเวรที่ต้องพิจารณา: ตารางเวร, ตารางเวรถัดไป ก่อน แล้วตามด้วยชีทอื่นที่ชื่อขึ้นต้นด้วย "ตารางเวร" */
function rosterSheetNames_(ss) {
  var names = [SHEET_WORKTABLE, SHEET_WORKTABLE_NEXT];
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (n.indexOf(ROSTER_SHEET_PREFIX_) === 0 && names.indexOf(n) < 0) names.push(n);
  });
  return names;
}

/** readRosterSheet_ — อ่านชีทตารางเวร 1 ชีท (ไม่เจอชีท/ว่าง = null)
 *  คืน { sheetName, monthYear:{month,year|null}|null, monthSource, titleConflict, dayCol:{วัน:index}, dowByDay:{วัน:0-6|null}, staff:[…] } */
function readRosterSheet_(sheetName) {
  var ss = getWorktableSpreadsheet();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var tz = ss.getSpreadsheetTimeZone() || ROSTER_TZ_;

  // 1) แถวหัวตาราง (แถวที่มี "ชื่อ-สกุล") — ไม่เจอใช้แถวที่ 3 ตามรูปแบบเดิม
  var hdrIdx = -1;
  for (var h = 0; h < Math.min(12, data.length) && hdrIdx < 0; h++) {
    for (var c0 = 0; c0 < Math.min(4, data[h].length); c0++) if (rosterIsNameHeader_(data[h][c0])) { hdrIdx = h; break; }
  }
  if (hdrIdx < 0) hdrIdx = 2;
  if (hdrIdx >= data.length) return null;
  var hdr = data[hdrIdx] || [];

  // 2) เดือน/ปีจากหัวชีท (เฉพาะแถวเหนือหัวตาราง กันไปจับชื่อพนักงาน)
  var titleYm = null;
  for (var r0 = 0; r0 < hdrIdx && r0 < 6 && !(titleYm && titleYm.strong); r0++) {
    for (var c1 = 0; c1 < Math.min(4, data[r0].length); c1++) {
      var p = parseRosterTitleCell_(data[r0][c1], tz);
      if (!p) continue;
      var strong = String(data[r0][c1]).indexOf('ประจำเดือน') >= 0;
      if (!titleYm || strong) titleYm = { month: p.month, year: p.year, strong: strong };
      if (strong) break;
    }
  }

  // 3) คอลัมน์ข้อมูลบุคคล
  var col = { name: 0, nick: 1, phone: 2, role: 3 };
  hdr.forEach(function (cell, c) {
    var tx = String(cell == null ? '' : cell).replace(/\s+/g, '');
    if (rosterIsNameHeader_(cell)) col.name = c;
    else if (tx === 'ชื่อเล่น') col.nick = c;
    else if (tx.indexOf('เบอร์') === 0 || tx.indexOf('โทร') === 0) col.phone = c;
    else if (tx === 'บทบาท' || tx === 'ตำแหน่ง') col.role = c;
  });
  var lastInfoCol = Math.max(col.name, col.nick, col.phone, col.role);

  // 4) คอลัมน์วันที่ — อ่านหัวทุกช่องก่อน แล้วค่อยตัดสินเดือน
  var parsed = [];
  hdr.forEach(function (cell, c) {
    if (c <= lastInfoCol) return;
    var p = parseRosterDayHeader_(cell, tz);
    if (p) { p.col = c; parsed.push(p); }
  });
  // หัวตารางที่มี "วันที่เต็ม" (วัน/เดือน/ปี) → เชื่อวันที่ในหัวคอลัมน์มากกว่าข้อความหัวชีท
  var monthCount = {}, dated = 0;
  parsed.forEach(function (p) { if (p.month) { var k = (p.year || 0) + '-' + p.month; monthCount[k] = (monthCount[k] || 0) + 1; dated++; } });
  var ym = titleYm ? { month: titleYm.month, year: titleYm.year } : null, monthSource = titleYm ? 'title' : '', titleConflict = false;
  if (dated >= 5) {
    var bestK = Object.keys(monthCount).sort(function (a, b) { return monthCount[b] - monthCount[a]; })[0].split('-');
    var hm = { month: Number(bestK[1]), year: Number(bestK[0]) || (titleYm && titleYm.year) || null };
    if (ym && (ym.month !== hm.month)) titleConflict = true;
    ym = hm; monthSource = 'header-date';
  }

  var dayCol = {}, dowByDay = {}, minSeen = 99;
  parsed.forEach(function (p) {
    if (monthSource === 'header-date' && p.month && p.month !== ym.month) return;     // คอลัมน์ของเดือนอื่น
    if (p.day === 1 && minSeen >= 20 && minSeen < 99) { dayCol = {}; dowByDay = {}; } // ท้ายเดือนก่อนหน้า (29 30 31 | 1 2 …) ทิ้ง
    minSeen = Math.min(minSeen, p.day);
    if (dayCol[p.day] === undefined) { dayCol[p.day] = p.col; dowByDay[p.day] = p.dow; }
  });

  // 5) แถวพนักงาน
  var staff = [];
  for (var r = hdrIdx + 1; r < data.length; r++) {
    var row = data[r];
    var name = rosterClean_(row[col.name]);
    if (!name || name.indexOf('รวม') === 0 || name.indexOf('หมายเหตุ') === 0) continue; // ข้ามแถวสรุป เช่น "รวมเวร (จำนวนวัน)"
    staff.push({ name: name, nick: rosterClean_(row[col.nick]), phone: String(row[col.phone] == null ? '' : row[col.phone]).trim(),
                 role: rosterClean_(row[col.role]), row: row });
  }
  return { sheetName: sheetName, monthYear: ym, monthSource: monthSource, titleConflict: titleConflict,
           dayCol: dayCol, dowByDay: dowByDay, staff: staff };
}

/** rosterInferMonth_ — หัวชีทอ่านเดือนไม่ได้ → เดาเดือนจาก "วันในสัปดาห์" ของหัวคอลัมน์เทียบปฏิทิน (ต้องตรง ≥ 90% และมีคำตอบเดียว) */
function rosterInferMonth_(ro, cands) {
  var days = Object.keys(ro.dowByDay).filter(function (d) { return ro.dowByDay[d] !== null && ro.dowByDay[d] !== undefined; });
  if (days.length < 5) return null;
  var good = [];
  cands.forEach(function (cd) {
    var dim = new Date(Date.UTC(cd.year, cd.month, 0)).getUTCDate(), ok = 0, total = 0;
    days.forEach(function (d) {
      var dd = Number(d);
      if (dd > dim) return;
      total++;
      if (new Date(Date.UTC(cd.year, cd.month - 1, dd)).getUTCDay() === ro.dowByDay[d]) ok++;
    });
    if (total >= 5 && ok / total >= 0.9) good.push(cd);
  });
  return good.length === 1 ? good[0] : null;
}

function rosterMatchesMonth_(ro, month, year) {
  return !!ro.monthYear && ro.monthYear.month === month && (!ro.monthYear.year || ro.monthYear.year === year);
}
function rosterFilledCount_(ro, day) {
  var c = ro.dayCol[day];
  if (c === undefined) return 0;
  var n = 0;
  ro.staff.forEach(function (s) { if (normShiftCell_(s.row[c]) !== '') n++; });
  return n;
}
function rosterLabel_(ro) {
  return '"' + ro.sheetName + '" = ' + (ro.monthYear ? (ROSTER_MONTH_NAMES_[ro.monthYear.month] + (ro.monthYear.year ? ' ' + (ro.monthYear.year + 543) : '')) : 'อ่านเดือนไม่ได้');
}

/** getDutyForDate_ — ใครอยู่เวรอะไรในวันที่กำหนด (ค่าเริ่มต้น = วันนี้ เวลาไทย)
 *  คืน { status:'ok'|'empty'|'nosheet', message, warning, day, month, year(ค.ศ.), dowThai, sheetName, monthSource,
 *        people:[{name,nick,phone(เฉพาะตัวเลข),phoneRaw,role,shift}]   ← ทุกคนที่มีรหัสเวร (รวม "ช" ปกติ) เรียงตามชีท
 *        leave:[{name,nick,phone,phoneRaw,role,shift}], offCount } */
function getDutyForDate_(dateObj) {
  var d = dateObj || new Date();
  var day   = Number(Utilities.formatDate(d, ROSTER_TZ_, 'd'));
  var month = Number(Utilities.formatDate(d, ROSTER_TZ_, 'M'));
  var year  = Number(Utilities.formatDate(d, ROSTER_TZ_, 'yyyy'));
  var dow   = Number(Utilities.formatDate(d, ROSTER_TZ_, 'u')) % 7; // 1..7 (จ..อา) → 0=อาทิตย์
  var out = { status: 'nosheet', message: '', warning: '', day: day, month: month, year: year, dowThai: ROSTER_DOW_NAMES_[dow],
              sheetName: '', monthSource: '', people: [], leave: [], offCount: 0 };

  var ss = getWorktableSpreadsheet();
  var prev = { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year };
  var next = { month: month === 12 ? 1 : month + 1, year: month === 12 ? year + 1 : year };
  var cands = [prev, { month: month, year: year }, next];

  var rosters = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { console.warn('readRosterSheet_(' + nm + '): ' + e.message); }
    if (!ro) return;
    if (!ro.monthYear) {
      var inf = rosterInferMonth_(ro, cands);
      if (inf) { ro.monthYear = inf; ro.monthSource = 'weekday'; }
    }
    rosters.push(ro);
  });

  var matched = rosters.filter(function (ro) { return rosterMatchesMonth_(ro, month, year); });
  matched.forEach(function (ro) { ro.filled = rosterFilledCount_(ro, day); });
  var pick = matched.filter(function (ro) { return ro.filled > 0; })[0] || matched[0] || null; // ลำดับ: ตารางเวร → ตารางเวรถัดไป → ชีทอื่น

  if (!pick) {
    // อ่านเดือนจากชีทหลักไม่ได้เลย → ยอมใช้ชีท "ตารางเวร" (พร้อมเตือน) ดีกว่าไม่ส่งข้อมูลเวรเลย
    pick = rosters.filter(function (ro) { return !ro.monthYear && ro.sheetName === SHEET_WORKTABLE; })[0] || null;
    if (pick) out.warning = 'อ่านเดือนจากหัวชีท "' + pick.sheetName + '" ไม่ได้ — ใช้ข้อมูลตามที่มีในชีท กรุณาตรวจสอบ';
  }
  if (!pick) {
    out.message = 'ไม่พบตารางเวรของเดือน' + ROSTER_MONTH_NAMES_[month] + ' ' + (year + 543)
      + (rosters.length ? ' (พบ: ' + rosters.map(rosterLabel_).join(', ') + ')' : ' ในชีท "' + SHEET_WORKTABLE + '" หรือ "' + SHEET_WORKTABLE_NEXT + '"');
    return out;
  }
  out.sheetName = pick.sheetName;
  out.monthSource = pick.monthSource;

  var c = pick.dayCol[day];
  if (c === undefined) {
    if (Object.keys(pick.dayCol).length === 0) { c = day + 3; out.warning = out.warning || 'อ่านหัวคอลัมน์วันที่ไม่ได้ — ใช้ตำแหน่งคอลัมน์ตามรูปแบบเดิม'; }
    else { out.status = 'empty'; out.message = 'ตารางเวร (' + pick.sheetName + ') ไม่มีคอลัมน์ของวันที่ ' + day; return out; }
  }

  var filled = 0;
  pick.staff.forEach(function (s) {
    var val = normShiftCell_(s.row[c]);
    if (val !== '') filled++;
    if (isOffShift_(val)) { out.offCount++; return; }
    if (isLeaveShift_(val)) { out.leave.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone), phoneRaw: s.phone, role: s.role, shift: val }); return; }
    out.people.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone), phoneRaw: s.phone, role: s.role, shift: val });
  });
  if (filled === 0) { out.status = 'empty'; out.message = 'ตารางเวรของวันที่ ' + day + ' (' + pick.sheetName + ') ยังไม่ได้กรอกข้อมูล'; return out; }

  var hd = pick.dowByDay[day];
  if (hd !== undefined && hd !== null && hd !== dow) {
    out.warning = out.warning || ('วันในหัวตาราง (' + ROSTER_DOW_NAMES_[hd] + ') ไม่ตรงกับปฏิทินจริง (' + ROSTER_DOW_NAMES_[dow] + ') — กรุณาตรวจสอบชีท "' + pick.sheetName + '"');
  }
  if (pick.titleConflict) out.warning = out.warning || ('ชื่อเดือนในหัวชีท "' + pick.sheetName + '" ไม่ตรงกับวันที่ในหัวคอลัมน์ — ใช้ตามวันที่ในหัวคอลัมน์');
  out.status = 'ok';
  return out;
}

function rosterShortName_(p) { return p.nick || String(p.name || '').replace(/^(นาย|นางสาว|นาง)/, ''); }

/** buildDutyLines_ — ส่วน "ผู้อยู่เวรวันนี้" ของข้อความ LINE (tplKey = 'workSchedule' | 'myScheduleOverview') */
function buildDutyLines_(duty, tplKey) {
  var lines = [];
  if (duty.status !== 'ok') {
    lines.push(tpl_(tplKey, 'dutyWarnText', { message: duty.message || 'อ่านตารางเวรไม่ได้' }));
    return lines;
  }
  if (duty.people.length > 0) {
    lines.push(tpl_(tplKey, 'dutySectionTitle', { count: duty.people.length }));
    duty.people.forEach(function (p) {
      lines.push(tpl_(tplKey, 'dutyItem', {
        name: p.name, nickPart: (p.nick ? ' (' + p.nick + ')' : ''), phonePart: (p.phone ? '\n     📞 ' + p.phone : ''), shift: p.shift
      }));
    });
  } else {
    lines.push(tpl_(tplKey, 'dutyEmptyText', {}));
  }
  if (duty.leave.length) {
    lines.push(tpl_(tplKey, 'dutyLeaveText', { count: duty.leave.length, names: duty.leave.map(rosterShortName_).join(', ') }));
  }
  if (duty.warning) lines.push(tpl_(tplKey, 'dutyWarnText', { message: duty.warning }));
  return lines;
}

/** buildDutyHtml_ — ตารางผู้อยู่เวรสำหรับอีเมล */
function buildDutyHtml_(duty) {
  if (duty.status !== 'ok') return '<p style="color:#b45309">⚠️ ' + escapeHtml_(duty.message) + '</p>';
  var html = '';
  if (duty.people.length === 0) {
    html += '<p>วันนี้ไม่มีผู้อยู่เวร</p>';
  } else {
    html += '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:6px">'
      + '<tr style="background:#163251;color:#fff"><th>ผู้อยู่เวร</th><th>เบอร์โทร</th><th>เวร</th></tr>'
      + duty.people.map(function (p) {
          return '<tr><td>' + escapeHtml_(p.name + (p.nick ? ' (' + p.nick + ')' : '')) + '</td><td>' + escapeHtml_(p.phone) + '</td><td>' + escapeHtml_(p.shift) + '</td></tr>';
        }).join('')
      + '</table>';
  }
  if (duty.leave.length) html += '<p style="margin:6px 0 0">🏖️ ลา: ' + escapeHtml_(duty.leave.map(rosterShortName_).join(', ')) + '</p>';
  if (duty.warning) html += '<p style="color:#b45309;margin:6px 0 0">⚠️ ' + escapeHtml_(duty.warning) + '</p>';
  return html;
}


// ── ตารางเวรสำหรับหน้าเว็บ (getSchedule / getScheduleNext) — ใช้ตัวอ่านเดียวกับรายงาน LINE ──────────

/** rosterLoadAll_ — อ่านทุกชีทตารางเวรพร้อมเดือน/ปีที่ตรวจพบ (ถ้าหัวชีทอ่านไม่ได้ ลองเดาจากวันในสัปดาห์) */
function rosterLoadAll_(refDate) {
  var ss = getWorktableSpreadsheet();
  var d = refDate || new Date();
  var month = Number(Utilities.formatDate(d, ROSTER_TZ_, 'M'));
  var year  = Number(Utilities.formatDate(d, ROSTER_TZ_, 'yyyy'));
  var cands = [
    { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year },
    { month: month, year: year },
    { month: month === 12 ? 1 : month + 1, year: month === 12 ? year + 1 : year }
  ];
  var list = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { console.warn('rosterLoadAll_(' + nm + '): ' + e.message); }
    if (!ro) return;
    if (!ro.monthYear) {
      var inf = rosterInferMonth_(ro, cands);
      if (inf) { ro.monthYear = inf; ro.monthSource = 'weekday'; }
    }
    ro.filledTotal = 0;
    var days = Object.keys(ro.dayCol);
    ro.staff.forEach(function (s) {
      days.forEach(function (dd) { if (normShiftCell_(s.row[ro.dayCol[dd]]) !== '') ro.filledTotal++; });
    });
    list.push(ro);
  });
  return { rosters: list, month: month, year: year };
}

/** rosterPickByMonth_ — เลือกชีทของเดือน/ปีที่ต้องการ: ชีทที่มีข้อมูลก่อน แล้วตามลำดับ ตารางเวร → ตารางเวรถัดไป → ชีทอื่น */
function rosterPickByMonth_(rosters, month, year) {
  var m = rosters.filter(function (ro) { return rosterMatchesMonth_(ro, month, year); });
  return m.filter(function (ro) { return ro.filledTotal > 0; })[0] || m[0] || null;
}

/** rosterToScheduleResult_ — แปลงชีทเป็นรูปแบบที่หน้าเว็บใช้ { status, data:[{name,nick,phone,role,photo,schedule:{"1":"ช",…}}], month, year(พ.ศ.), extension } */
function rosterToScheduleResult_(ro, month, year, ext) {
  var photos = getStaffPhotosMap_();
  var hasCols = Object.keys(ro.dayCol).length > 0;
  var staff = ro.staff.map(function (s) {
    var schedule = {};
    for (var d = 1; d <= 31; d++) {
      var c = hasCols ? ro.dayCol[d] : d + 3;       // อ่านหัวคอลัมน์ไม่ได้ → ใช้ตำแหน่งตามรูปแบบเดิม
      if (c === undefined) continue;
      var val = normShiftCell_(s.row[c]);
      if (val !== '') schedule[String(d)] = val;    // "0" ยังส่งไปเหมือนเดิม (หน้าเว็บแสดงเป็นวันหยุด)
    }
    return { name: s.name, nick: s.nick, phone: s.phone, role: s.role || DEFAULT_STAFF_ROLE,
             photo: photos[normalizePhone_(s.phone)] || '', schedule: schedule };
  });
  return { status: 'ok', data: staff, month: month, year: year + 543, extension: ext, sheetName: ro.sheetName };
}

/** rosterDayColumn_ — เลขคอลัมน์ (1-based) ของวันที่ในชีทนั้น อ่านจากหัวตาราง; อ่านไม่ได้ → วันที่ + 4 ตามรูปแบบเดิม */
function rosterDayColumn_(sheetName, day) {
  try {
    var ro = readRosterSheet_(sheetName);
    if (ro && ro.dayCol[Number(day)] !== undefined) return ro.dayCol[Number(day)] + 1;
  } catch (e) { console.warn('rosterDayColumn_: ' + e.message); }
  return Number(day) + 4;
}

// ── เครื่องมือตรวจสอบ (รันจาก Apps Script Editor) ──────────────────────

/** debugRosterSheets — ดูว่าแต่ละชีทตารางเวรถูกอ่านเป็นเดือนอะไร/พบกี่คอลัมน์วัน ใช้ตรวจหลังแก้ชีทหรือขึ้นเดือนใหม่ */
function debugRosterSheets() {
  var ss = getWorktableSpreadsheet();
  var rows = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { rows.push(nm + ': ERROR ' + e.message); return; }
    if (!ro) { rows.push(nm + ': (ไม่มีชีท/ว่าง)'); return; }
    var days = Object.keys(ro.dayCol).map(Number).sort(function (a, b) { return a - b; });
    rows.push(nm + ': เดือน=' + (ro.monthYear ? ro.monthYear.month + '/' + (ro.monthYear.year || '?') : 'อ่านไม่ได้') + ' (' + (ro.monthSource || '-') + ')'
      + (ro.titleConflict ? ' ⚠ หัวชีทขัดกับวันที่หัวคอลัมน์' : '')
      + ' | คอลัมน์วัน=' + days.length + (days.length ? ' [' + days[0] + '–' + days[days.length - 1] + ']' : '') + ' | พนักงาน=' + ro.staff.length);
  });
  console.log(rows.join('\n'));
  return rows;
}

/** previewDailyWorkScheduleReport — ดูข้อความรายงานตารางงานประจำวันที่จะส่ง (ไม่ส่งจริง) */
function previewDailyWorkScheduleReport() {
  var r = buildDailyWorkScheduleReport_();
  console.log(r.lineText);
  return r.lineText;
}


/** shortTime_ — "08:00:00" → "08:00" (ข้อความ LINE ไม่ต้องแสดงวินาที) ค่าอื่นคืนตามเดิม */
function shortTime_(t) {
  return String(t == null ? '' : t).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
}

/** buildScheduleOverviewReplyText_ — "ตารางงานของฉัน" สำหรับทุกบทบาท (real-time reply ตอนกด Rich Menu เท่านั้น ไม่ใช่ push)
 *  ✅ NEW: ทุกบทบาทไม่ต้องผูกเบอร์โทร/มีชื่อในตารางเวรอีกต่อไป — เช็คแค่บทบาทที่ตั้งไว้ในชีท LineUsers พอ
 *  แสดง "ภาพรวมของทุกคน" แทนเวรส่วนตัวรายบุคคล: ใครอยู่เวรวันนี้ทั้งหมด + ภารกิจทั้งหมดของวันนี้ (ไม่กรองเฉพาะคนใดคนหนึ่ง) */
function buildScheduleOverviewReplyText_() {
  var todayThai = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
  var todayYmd  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');

  var lines = [];
  lines.push(tpl_('myScheduleOverview', 'header', { todayThai: todayThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  var duty;
  try { duty = getDutyForDate_(new Date()); }
  catch (e) { console.error('buildScheduleOverviewReplyText_ duty error:', e); duty = { status: 'error', message: 'อ่านตารางเวรไม่ได้ (' + e.message + ')', people: [], leave: [] }; }
  Array.prototype.push.apply(lines, buildDutyLines_(duty, 'myScheduleOverview'));

  lines.push('');

  var jobsRes  = getJobAssignments({});
  var todayJobs = ((jobsRes && jobsRes.data) || []).filter(function (j) { return j.date === todayYmd; });
  todayJobs.sort(function (a, b) { return String(a.timeOut || '').localeCompare(String(b.timeOut || '')); });

  if (todayJobs.length === 0) {
    lines.push(tpl_('myScheduleOverview', 'jobsEmptyText', {}));
  } else {
    lines.push(tpl_('myScheduleOverview', 'jobsListTitle', { count: todayJobs.length }));
    lines.push('');
    var phoneMap = buildStaffPhoneMap_(); // เบอร์โทร พขร. — แนบหลังชื่อผู้ขับแต่ละคน
    todayJobs.forEach(function (j, i) {
      lines.push(tpl_('myScheduleOverview', 'jobItem', {
        no: i + 1, timeOut: shortTime_(j.timeOut) || '-',
        timeBackPart: j.timeBack ? ('–' + shortTime_(j.timeBack)) : '',
        destination: j.destination || '-',
        missionPart: j.mission ? ('\n   🎯 ' + j.mission) : '',
        requester: j.requester || '-',
        driverPart: j.driver ? ('\n   🧑\u200d✈️ ผู้ขับ: ' + driverWithPhone_(j.driver, phoneMap)) : '',
        carPart: j.car ? ('\n   🚗 รถ: ' + j.car) : ''
      }));
      lines.push('');
    });
  }

  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('myScheduleOverview', 'footer', { dashboardUrl: DASHBOARD_URL }));

  return lines.join('\n');
}
