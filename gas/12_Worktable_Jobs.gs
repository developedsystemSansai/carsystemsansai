// ═══════════════════════════════════════════════════════════════════
//  WORKTABLE — ตารางเวรยานพาหนะ
//  Sheet name: ตารางเวร (สร้างอัตโนมัติใน Spreadsheet เดิม)
// ═══════════════════════════════════════════════════════════════════

var SHEET_WORKTABLE      = 'ตารางเวร';
var SHEET_WORKTABLE_NEXT = 'ตารางเวรถัดไป';
var SHEET_META_WT        = 'MetaWorktable';

// ✅ NEW: รูปประจำตัว พขร./เจ้าหน้าที่ — เก็บแยกชีท map ด้วยเบอร์โทร เพื่อไม่ต้องแก้โครงสร้างคอลัมน์วันที่ 1-31 ในชีท "ตารางเวร"
var SHEET_STAFF_PHOTOS      = 'StaffPhotos';
var STAFF_PHOTOS_HEADERS    = ['เบอร์โทรศัพท์', 'ชื่อ-สกุล', 'PhotoURL', 'อัปเดตล่าสุด'];
// ✅ NEW: สถานะ/บทบาทเริ่มต้น — ทุกคนเป็น "พขร." ยกเว้นคนที่ระบุบทบาทไว้แล้วในชีท (เช่น หัวหน้างาน/รองหัวหน้างาน)
var DEFAULT_STAFF_ROLE = 'พขร.';

function getWorktableSpreadsheet() {
  return getSpreadsheet(); // ใช้ Spreadsheet เดิมของระบบ
}

function getStaffPhotosSheet_() {
  return getOrCreateSheet(getSpreadsheet(), SHEET_STAFF_PHOTOS, STAFF_PHOTOS_HEADERS);
}

/** getStaffPhotosMap_ — คืน map { normalizedPhone: photoUrl } จากชีท StaffPhotos ทั้งหมดในครั้งเดียว (กันยิง sheet ซ้ำในลูป) */
function getStaffPhotosMap_() {
  var sheet = getStaffPhotosSheet_();
  var data  = sheet.getDataRange().getValues();
  var map   = {};
  for (var r = 1; r < data.length; r++) {
    var phone = normalizePhone_(data[r][0]);
    var url   = String(data[r][2] || '').trim();
    if (phone && url) map[phone] = url;
  }
  return map;
}

/** uploadStaffPhoto — อัปโหลดรูปประจำตัว พขร./เจ้าหน้าที่ (base64) เก็บใน Drive แล้ว map เข้ากับเบอร์โทรใน StaffPhotos
 *  สิทธิ์: เจ้าของเบอร์อัปโหลดรูปตัวเองได้เท่านั้น หรือแอดมิน (WORKTABLE_ADMIN_CODE) อัปโหลดแทนใครก็ได้ */
function uploadStaffPhoto(payload) {
  try {
    var v = verifyDriverPhone(payload); // payload.phone = รหัสยืนยันตัวตน (เบอร์ของตัวเอง หรือรหัสแอดมิน)
    if (v.status !== 'ok') return v;

    var targetPhone = normalizePhone_((payload && payload.targetPhone) || v.phone);
    if (!v.isAdmin && targetPhone !== normalizePhone_(v.phone)) {
      return { status: 'error', message: 'คุณสามารถอัปโหลดได้เฉพาะรูปของตัวเองเท่านั้น' };
    }
    var targetName = String((payload && payload.targetName) || v.name || '').trim();

    var base64Data = (payload && payload.base64Data) || (payload && payload.imageBase64) || '';
    if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };
    var mimeType = (payload && payload.mimeType) || 'image/jpeg';

    var rootFolder  = DRIVE_FOLDER ? DriveApp.getFolderById(DRIVE_FOLDER) : DriveApp.getRootFolder();
    var staffFolder = getOrCreateSubFolder(rootFolder, 'StaffPhotos');

    var clean = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    var bytes = Utilities.base64Decode(clean);
    var ext   = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
    var blob  = Utilities.newBlob(bytes, mimeType, 'staff_' + targetPhone + '_' + Date.now() + '.' + ext);
    var file  = staffFolder.createFile(blob);
    // ✅ ต้องเปิดสิทธิ์ "ทุกคนที่มีลิงก์ดูได้" ก่อน ไม่งั้นรูปจะไม่ขึ้นในเบราว์เซอร์ของคนอื่น (ไฟล์ที่สร้างใหม่ยังเป็นส่วนตัวอยู่)
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) { console.error('uploadStaffPhoto share error:', shareErr); }
    // ✅ ใช้ endpoint thumbnail แทน uc?export=view — โหลดเป็นรูปตรงๆ ใน <img> ได้เสถียรกว่า (uc?export=view บางครั้งโดนบล็อกหรือขึ้นหน้ายืนยันแทนรูป)
    var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400';

    var sheet = getStaffPhotosSheet_();
    var data  = sheet.getDataRange().getValues();
    var rowNum = -1;
    for (var r = 1; r < data.length; r++) {
      if (normalizePhone_(data[r][0]) === targetPhone) { rowNum = r + 1; break; }
    }
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    if (rowNum > 0) {
      sheet.getRange(rowNum, 1, 1, 4).setValues([[targetPhone, targetName, url, now]]);
    } else {
      sheet.appendRow([targetPhone, targetName, url, now]);
    }

    return { status: 'ok', message: 'อัปโหลดรูปเรียบร้อยแล้ว', photoUrl: url };
  } catch (err) {
    console.error('uploadStaffPhoto error:', err);
    return { status: 'error', message: err.message };
  }
}

function getWorktableSchedule() {
  try {
    var ss  = getWorktableSpreadsheet();
    var ext = '207';
    try { var meta = ss.getSheetByName(SHEET_META_WT); if (meta) ext = meta.getRange('B4').getValue() || '207'; } catch (e0) {}

    // ✅ ตารางเวร "เดือนปัจจุบัน" = ชีทที่หัวชีทระบุเดือน/ปีของวันนี้ (ไม่ว่าจะชื่อ ตารางเวร หรือ ตารางเวรถัดไป)
    //    ไม่เชื่อ MetaWorktable อีกต่อไป (เคยค้างเดือนเก่า ทำให้หัววัน/จำนวนวันในหน้าเว็บเพี้ยน)
    var all  = rosterLoadAll_();
    var pick = rosterPickByMonth_(all.rosters, all.month, all.year);
    if (pick) return rosterToScheduleResult_(pick, all.month, all.year, ext);

    // ไม่พบชีทที่ตรงเดือนนี้ → ใช้ชีท "ตารางเวร" ตามเดิม (เดือน/ปีเอาจากหัวชีทถ้าอ่านได้)
    var main = all.rosters.filter(function (ro) { return ro.sheetName === SHEET_WORKTABLE; })[0];
    if (!main) return { status:'error', message:'ยังไม่มี sheet ตารางเวร — กรุณาเรียก setupWorktableSheet ก่อน' };
    var my = main.monthYear || { month: all.month, year: all.year };
    return rosterToScheduleResult_(main, my.month, my.year || all.year, ext);
  } catch(err) {
    console.error('getWorktableSchedule error:', err);
    return { status:'error', message: err.message };
  }
}

function getWorktableTodayDuty() {
  try {
    // ✅ ใช้ตัวอ่านตารางเวรใหม่: เลือกชีท (ตารางเวร / ตารางเวรถัดไป) จากเดือน/ปีจริงที่เขียนในชีท
    //    ไม่พึ่ง MetaWorktable (เคยค้างเดือนเก่า) และไม่นับค่า "0" (วันหยุด) เป็นผู้อยู่เวรอีกต่อไป
    var duty      = getDutyForDate_(new Date());
    var photosMap = getStaffPhotosMap_();
    var ext = '207';
    try {
      var meta = getWorktableSpreadsheet().getSheetByName(SHEET_META_WT);
      if (meta) ext = meta.getRange('B4').getValue() || '207';
    } catch (e2) {}

    var toItem = function (s) {
      return { name: s.name, nick: s.nick, phone: s.phoneRaw, role: s.role || DEFAULT_STAFF_ROLE,
               photo: photosMap[normalizePhone_(s.phoneRaw)] || '', shift: s.shift };
    };
    return {
      status   : 'ok',
      day      : String(duty.day),
      dow      : duty.dowThai,
      month    : duty.month,        // 1-12 (เดือนจริงวันนี้)
      year     : duty.year + 543,   // พ.ศ. (เหมือนเดิม)
      extension: ext,
      sheetName: duty.sheetName,
      rosterStatus: duty.status,    // ok | empty | nosheet
      message  : duty.status === 'ok' ? '' : duty.message,
      warning  : duty.warning || '',
      onDuty   : duty.people.map(toItem).concat(duty.leave.map(toItem))
    };
  } catch(err) {
    return { status:'error', message: err.message };
  }
}

// ── ตารางเวรเดือนถัดไป ── อ่านจาก sheet "ตารางเวรถัดไป"
// โครงสร้าง sheet เหมือนกับ "ตารางเวร" ทุกประการ
// หากไม่มี sheet นี้ จะ return status:'error' ให้ frontend แสดง errBox
function getWorktableScheduleNext() {
  try {
    var ss  = getWorktableSpreadsheet();
    var ext = '207';
    try { var meta = ss.getSheetByName(SHEET_META_WT); if (meta) ext = meta.getRange('B4').getValue() || '207'; } catch (e0) {}

    // ✅ ตารางเวร "เดือนถัดไป" = ชีทที่หัวชีทระบุเดือน/ปีของเดือนหน้า
    var all = rosterLoadAll_();
    var nm  = all.month === 12 ? 1 : all.month + 1;
    var ny  = all.month === 12 ? all.year + 1 : all.year;
    var pick = rosterPickByMonth_(all.rosters, nm, ny);
    if (pick) return rosterToScheduleResult_(pick, nm, ny, ext);

    // ไม่พบชีทเดือนหน้า → ใช้ชีท "ตารางเวรถัดไป" เฉพาะเมื่ออ่านเดือนจากหัวชีทไม่ได้เท่านั้น
    // (ถ้าชีทนั้นเป็นเดือนอื่นอย่างชัดเจน เช่น ขึ้นเดือนใหม่แล้วแต่ยังไม่ได้เตรียมเดือนถัดไป จะไม่แสดงซ้ำกับเดือนปัจจุบัน)
    var nx = all.rosters.filter(function (ro) { return ro.sheetName === SHEET_WORKTABLE_NEXT; })[0];
    if (nx && !nx.monthYear) return rosterToScheduleResult_(nx, nm, ny, ext);
    return { status:'error', message:'ยังไม่มีตารางเวรของเดือน' + ROSTER_MONTH_NAMES_[nm] + ' ' + (ny + 543) + ' — กรุณากรอกในชีท "' + SHEET_WORKTABLE_NEXT + '" (ใส่ "ประจำเดือน ' + ROSTER_MONTH_NAMES_[nm] + ' พ.ศ. ' + (ny + 543) + '" ในหัวชีท)' };
  } catch(err) {
    console.error('getWorktableScheduleNext error:', err);
    return { status:'error', message: err.message };
  }
}

function setupWorktableSheet() {
  try {
    var ss    = getWorktableSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_WORKTABLE);
    var isNew = !sheet;
    if (!sheet) sheet = ss.insertSheet(SHEET_WORKTABLE);

    // Title rows
    sheet.getRange(1, 1).setValue('ตารางปฏิบัติงานเจ้าหน้าที่ งานยานพาหนะ  กลุ่มงานบริหารทั่วไป');
    sheet.getRange(1, 1, 1, 35).merge().setBackground('#163251').setFontColor('#ffffff').setFontWeight('bold').setFontSize(13);
    var today = new Date();
    var monthNames = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                      'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    sheet.getRange(2, 1).setValue('ประจำเดือน  ' + monthNames[today.getMonth()+1] + '  พ.ศ. ' + (today.getFullYear()+543));
    sheet.getRange(2, 1, 1, 35).merge().setBackground('#1e4a7a').setFontColor('#ffffff').setFontWeight('bold');
    // Header row at row 3
    var headerRow = ['ชื่อ-สกุล','ชื่อเล่น','เบอร์โทรศัพท์','บทบาท'];
    var DOW_SHORT = ['อา','จ','อ','พ','พฤ','ศ','ส'];
    var firstDay = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
    for (var d = 1; d <= 31; d++) {
      var dt = new Date(today.getFullYear(), today.getMonth(), d);
      if (dt.getMonth() !== today.getMonth()) { headerRow.push(''); continue; }
      headerRow.push(d + '\n' + DOW_SHORT[dt.getDay()]);
    }
    sheet.getRange(3, 1, 1, headerRow.length).setValues([headerRow]);
    sheet.getRange(3, 1, 1, headerRow.length)
      .setBackground('#0f2744').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(3);
    sheet.setFrozenColumns(4);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 80);
    sheet.setColumnWidth(3, 130);
    sheet.setColumnWidth(4, 120);
    for (var i = 5; i <= 35; i++) sheet.setColumnWidth(i, 55);

    // Seed data
    if (isNew) {
      var staffData = getWorktableDefaultStaff();
      var rows = staffData.map(function(s) {
        var row = [s.name, s.nick, s.phone, s.role];
        for (var d = 1; d <= 31; d++) row.push(s.schedule[String(d)] || '');
        return row;
      });
      if (rows.length) {
        sheet.getRange(4, 1, rows.length, rows[0].length).setValues(rows);
        for (var r = 0; r < rows.length; r++) {
          sheet.getRange(r+4, 1, 1, rows[0].length)
            .setBackground(r % 2 === 0 ? '#f8fafc' : '#ffffff');
        }
      }
    }

    // Meta sheet
    var meta = ss.getSheetByName(SHEET_META_WT);
    if (!meta) meta = ss.insertSheet(SHEET_META_WT);
    // Row 1: title, Row 2: month, Row 3: year, Row 4: extension
    meta.getRange('A1').setValue('MetaWorktable — ค่า config สำหรับระบบ worktable.html');
    meta.getRange('A2').setValue('month'); meta.getRange('B2').setValue(new Date().getMonth() + 1);
    meta.getRange('A3').setValue('year');  meta.getRange('B3').setValue(new Date().getFullYear() + 543);
    meta.getRange('A4').setValue('extension'); meta.getRange('B4').setValue('207');
    try { meta.hideSheet(); } catch(_) {}

    SpreadsheetApp.flush();
    return {
      status  : 'ok',
      message : 'ตั้งค่า sheet ตารางเวรเรียบร้อยแล้ว',
      sheetId : sheet.getSheetId(),
      isNew   : isNew,
    };
  } catch(err) {
    console.error('setupWorktableSheet error:', err);
    return { status:'error', message: err.message };
  }
}

function getWorktableDefaultStaff() {
  return [
    { name:'นายชัยพร มอญแสง',         nick:'ชัย',   phone:'0849484577', role:'หัวหน้างาน',
      schedule:{2:'ช1บ2',4:'ช2บ1',8:'ช1บ2',10:'ช3(Ems)',11:'ด',12:'ช1บ2',14:'ด',15:'ช2บ1',
                18:'ช1บ2',19:'ช3(Ems)',20:'ด',22:'ช2บ1',24:'ช3(Ems)',25:'ช2บ1',27:'ช1บ2',29:'ช2บ1'} },
    { name:'นายกิตติพงศ์ เขื่อนแก้ว', nick:'หนุ่ย', phone:'0882665403', role:'รองหัวหน้างาน',
      schedule:{} },
    { name:'นายกานต์นิธิ ทองอร',       nick:'โบ๊ท', phone:'0861004536', role:'',
      schedule:{2:'ช3(Ems)',3:'ด',5:'ช1',7:'ช2บ1',8:'ช3(Ems)',9:'ด',11:'ช1บ2',
                16:'ช2บ1',17:'ช3(Ems)',18:'ด',19:'ช1บ2',21:'ด',22:'ช3(Ems)',23:'ด',
                24:'ช2บ1',26:'ช1บ2',28:'ด',30:'ช1บ2'} },
    { name:'นายนพดล คำปินคำ',           nick:'โด้',  phone:'0960214436', role:'',
      schedule:{3:'ช1บ2',7:'ช1บ2',9:'ช3(Ems)',10:'ด',11:'ช2บ1',14:'ช2บ1',
                16:'ช3(Ems)',17:'ด',18:'ช2บ1',21:'ช2บ1',23:'ช1บ2',25:'ด',26:'ช3(Ems)',27:'ด'} },
    { name:'นายเก้า พิจิตร',            nick:'เก้า', phone:'0869168036', role:'',
      schedule:{1:'ด',2:'ช2บ1',4:'ด',5:'ช3(Ems)',6:'ด',8:'ช2บ1',10:'ช1บ2',
                13:'ช2บ1',15:'ช3(Ems)',16:'ด',17:'ช2บ1',20:'ช2บ1',22:'ด',
                23:'ช3(Ems)',24:'ด',29:'ช1บ2',30:'ช3(Ems)'} },
    { name:'นายภาณุพงค์ กางสำโรง',     nick:'อุ้ม', phone:'0638020502', role:'',
      schedule:{1:'ช1บ2',4:'ช1บ2',6:'ช2บ1',12:'ช2บ1',14:'ช1บ2',21:'ช1บ2',28:'ช2บ1',30:'ด'} },
    { name:'นายเฉิมพล เลาแก้ว',       nick:'แบงค์',phone:'0907522278', role:'',
      schedule:{} },
    { name:'นายชัยพร ชัยศร',           nick:'บอม',  phone:'0866728623', role:'',
      schedule:{2:'ด',3:'ช2บ1',10:'ช2บ1',15:'ช1บ2',23:'ช2บ1',25:'ช3(Ems)',26:'ด',30:'ช2บ1'} },
    { name:'นายคมสันต์ ภายไธสงค์',     nick:'ก๊อต', phone:'0966952256', role:'',
      schedule:{1:'ช2บ1',4:'ช3(Ems)',5:'ด/บ2',6:'ช1บ2',9:'ช2บ1',12:'ช3(Ems)',13:'ด',
                17:'ช1บ2',19:'ช2บ1',24:'ช1บ2',26:'ช2บ1',28:'ช1บ2'} },
  ];
}

// ═══════════════════════════════════════════════════════════════════
//  ตารางงาน (Job Assignments) — งานที่ผู้ขอรถแจ้งให้ พขร. ไปรับ-ส่ง
//  Sheet name: ตารางงาน (สร้างอัตโนมัติใน Spreadsheet เดิม)
//  พขร. อัปเดตข้อมูลได้เองผ่านมือถือ โดย "ล็อกอิน" ด้วยเบอร์โทรศัพท์
//  (ตรวจสอบกับรายชื่อ พขร. ใน sheet "ตารางเวร" — ไม่ต้องตั้งรหัสผ่านแยก)
// ═══════════════════════════════════════════════════════════════════

var SHEET_JOBS = 'ตารางงาน';
var JOBS_HEADERS = [
  'JobID', 'วันที่', 'ผู้ขอรถ', 'จำนวนคน', 'ภารกิจ/คำสั่งงาน',
  'สถานที่ไป', 'เวลาไป', 'เวลากลับ', 'ผู้ไปส่ง', 'รถที่ใช้', 'เวรของ',
  'บันทึกโดย', 'เบอร์โทรผู้บันทึก', 'สถานะ', 'บันทึกเมื่อ', 'แก้ไขล่าสุด'
];

// ✅ NEW: 'รถที่ใช้' (หมวดรถทั่วไปที่เลือกใช้ในงานนี้ — ยังไม่บังคับกรอก เพราะหมวดรถอาจเปลี่ยนแปลงในอนาคต)
// getJobsSheet_() ทำให้ชีท "ตารางงาน" ที่มีอยู่แล้ว (สร้างไว้ก่อนเพิ่มคอลัมน์นี้) ได้คอลัมน์ใหม่แบบไม่กระทบข้อมูลเดิม
// — ensureExtraColumn() จะข้ามไปเฉยๆถ้าคอลัมน์มีอยู่แล้ว หรือเพิ่มต่อท้ายให้ถ้ายังไม่มี
function getJobsSheet_() {
  var sheet = getOrCreateSheet(getSpreadsheet(), SHEET_JOBS, JOBS_HEADERS);
  ensureExtraColumn(sheet, 'รถที่ใช้');
  return sheet;
}

function jobsHeaderIndex_(headers) {
  var idx = {};
  headers.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

function normalizePhone_(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

// ✅ NEW: รหัสแอดมินตายตัว — สำหรับหัวหน้างาน/ผู้ดูแลระบบ ให้จัดการ (เพิ่ม/แก้ไข/ลบ) ตารางงานได้
//    โดยไม่ต้องผูกกับเบอร์โทร พขร. คนใดคนหนึ่ง (เผื่อกรณีไม่ใช่ พขร. หรือเบอร์ไม่อยู่ในตารางเวร)
//    ⚠️ ควรย้ายไปเก็บใน Script Properties แทนถ้าต้องการความปลอดภัยสูงขึ้นในอนาคต
var WORKTABLE_ADMIN_CODE = 'sansai2569';

/** verifyDriverPhone — ตรวจรหัสผ่านที่กรอกกับเบอร์โทร พขร. ใน sheet "ตารางเวร" (ใช้เบอร์โทรเป็นรหัสผ่านภายใน ไม่แสดงต่อผู้ใช้)
 *  หรือรหัสแอดมิน (WORKTABLE_ADMIN_CODE) สำหรับสิทธิ์ผู้ดูแลระบบเต็มรูปแบบ */
function verifyDriverPhone(payload) {
  try {
    var raw = String((payload && payload.phone) || '').trim();
    if (!raw) return { status: 'error', message: 'โปรดใส่รหัสผ่าน' };

    // ✅ รหัสแอดมิน — เข้าถึง/จัดการตารางงานได้เต็มสิทธิ์ ไม่ผูกกับเบอร์โทรใคร
    if (raw === WORKTABLE_ADMIN_CODE) {
  return { status: 'ok', name: 'ผู้ดูแลระบบ', nick: 'Admin', role: 'แอดมิน', phone: raw, isAdmin: true, canEditSchedule: true };
}

    var phone = normalizePhone_(raw);
    if (phone.length < 9) return { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง' };

    var sched = getWorktableSchedule();
    if (sched.status !== 'ok') return { status: 'error', message: 'ไม่สามารถตรวจสอบรหัสผ่านได้ในขณะนี้' };

    var found = (sched.data || []).filter(function (s) {
      return normalizePhone_(s.phone) === phone;
    })[0];

    if (!found) return { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง กรุณาติดต่อหัวหน้างานยานพาหนะ' };

    // ✅ NEW: สิทธิ์แก้ไขเวรรายช่อง = หัวหน้างาน/รองหัวหน้างาน หรือเบอร์ใน SWAP_ADMIN_PHONES (ตรงกับ swapLogin)
    var canEditSchedule = String(found.role || '').indexOf('หัวหน้างาน') >= 0 || SWAP_ADMIN_PHONES.indexOf(phone) >= 0;
    return { status: 'ok', name: found.name, nick: found.nick, role: found.role, phone: found.phone, isAdmin: false, canEditSchedule: canEditSchedule };
  } catch (err) {
    console.error('verifyDriverPhone error:', err);
    return { status: 'error', message: err.message };
  }
}

// ============================================================
//  ✅ NEW: แก้ไขเวรรายช่อง (คน × วัน) จากหน้า worktable.html
//  ต่างจาก "แลกเวร/ยกเวร" (swap) — ไม่ต้องมีคู่กรณีและไม่ต้องรออนุมัติ ใช้เมื่อหัวหน้างานต้องแก้/เพิ่มเวร
//  ของใครสักคนในวันใดวันหนึ่งโดยตรง เช่น เพิ่มเวรดึกเป็น 2 เวรในวันเดียว = "ด/ด"
//  รูปแบบค่าในช่อง = ตามระบบยกเวร: หลายเวรต่อวันคั่นด้วย "/" (เช่น "ด/ด", "ด/ช1บ2")
//  ใบแลกเวร / รายงานเงินเวร / ข้อความ LINE อ่านจากชีทเดียวกันนี้ จึงสอดคล้องกันทันทีโดยไม่ต้องแก้ที่อื่น
// ============================================================
var SHEET_SCHEDULE_EDIT_LOG   = 'ScheduleEditLog';
var SCHEDULE_EDIT_LOG_HEADERS = ['เวลา', 'ผู้แก้ไข', 'ชีท', 'วันที่', 'ชื่อพนักงาน', 'เวรเดิม', 'เวรใหม่', 'หมายเหตุ'];
var SCHEDULE_EDIT_MAX_PARTS   = 3;

/** normalizeShiftInput_ — ตรวจ/จัดรูปค่าเวรที่รับจากหน้าเว็บ → { ok, value, message }
 *  อนุญาตเฉพาะตัวอักษรไทย/อังกฤษ/ตัวเลข/วงเล็บ (ป้องกันการฝังสูตรในชีท เช่น ขึ้นต้นด้วย = + - @)
 *  "0" (หยุด) และ "ลา" ต้องอยู่เดี่ยว ๆ — ใช้ร่วมกับเวรอื่นในวันเดียวกันไม่ได้ */
function normalizeShiftInput_(raw) {
  var s = String(raw == null ? '' : raw).replace(/（/g, '(').replace(/）/g, ')').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  if (!s) return { ok: true, value: '' };
  var parts = s.split('/').map(function (p) { return p.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  if (!parts.length) return { ok: true, value: '' };
  if (parts.length > SCHEDULE_EDIT_MAX_PARTS) return { ok: false, message: 'ใส่ได้สูงสุด ' + SCHEDULE_EDIT_MAX_PARTS + ' เวรต่อวัน' };
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (/^[=+\-@]/.test(p) || !/^[0-9A-Za-z\u0E00-\u0E7F().\- ]{1,20}$/.test(p)) {
      return { ok: false, message: 'รหัสเวร "' + p + '" ไม่ถูกต้อง (ใช้ได้เฉพาะตัวอักษร ตัวเลข และวงเล็บ ไม่เกิน 20 ตัว)' };
    }
    if (parts.length > 1 && (isOffShift_(p) || isLeaveShift_(p))) {
      return { ok: false, message: 'เวร "' + p + '" ใช้ร่วมกับเวรอื่นในวันเดียวกันไม่ได้' };
    }
  }
  return { ok: true, value: parts.join('/') };
}

/** findPendingSwapForCell_ — มีคำขอแลก/ยกเวรที่ "รอตรวจสอบ" อ้างถึงช่องนี้อยู่หรือไม่ (คืนข้อความเตือน หรือ '') */
function findPendingSwapForCell_(sheetName, day, name) {
  try {
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return '';
    var idx = jobsHeaderIndex_(data[0]);
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') continue;
      var ms = String(row[idx['เดือน']]) === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
      if (ms !== sheetName) continue;
      var hitReq = String(row[idx['ชื่อผู้ขอแลก']] || '').trim() === name && Number(row[idx['วันที่เดิมของผู้ขอแลก']]) === day;
      var hitTgt = String(row[idx['ชื่อผู้รับแลก']] || '').trim() === name && Number(row[idx['วันที่เดิมของผู้รับแลก']]) === day;
      if (hitReq || hitTgt) return 'มีคำขอแลก/ยกเวรที่ยังรออนุมัติของช่องนี้ — ควรตรวจสอบคำขอนั้นก่อนอนุมัติ เพราะค่าเวรในชีทเปลี่ยนไปแล้ว';
    }
  } catch (e) { console.warn('findPendingSwapForCell_: ' + e.message); }
  return '';
}

/** setWorktableShift — เขียนค่าเวรของ 1 คน ใน 1 วัน ลงชีทตารางเวรจริง
 *  payload: { phone(รหัส/เบอร์ผู้แก้), sheetName | monthSheet('current'|'next'), name(ชื่อ-สกุลเต็ม), day, value, expected }
 *    value    = ค่าใหม่ ("ด", "ด/ด", "ช1บ2", "0", "ลา" … ว่าง = ล้างช่อง)
 *    expected = ค่าที่หน้าเว็บเห็นอยู่ตอนกดแก้ — ถ้าชีทเปลี่ยนไปแล้ว (มีคนแลก/แก้ก่อน) จะไม่เขียนทับ คืน status:'conflict' */
function setWorktableShift(payload) {
  try {
    var v = swapLogin(payload); // ตรวจรหัส + สิทธิ์แบบเดียวกับระบบแลกเวร (แอดมิน / หัวหน้างาน / SWAP_ADMIN_PHONES)
    if (v.status !== 'ok') return v;
    if (!v.isAdmin) return { status: 'error', message: 'เฉพาะหัวหน้างานหรือผู้ดูแลระบบเท่านั้นที่แก้ไขเวรได้' };

    var ss = getWorktableSpreadsheet();
    var sheetName = String((payload && payload.sheetName) || '').trim();
    if (!sheetName) sheetName = (payload && payload.monthSheet) === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
    if (rosterSheetNames_(ss).indexOf(sheetName) < 0) return { status: 'error', message: 'ไม่พบชีทตารางเวร: ' + sheetName };
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { status: 'error', message: 'ไม่พบชีท ' + sheetName };

    var day = Number(payload && payload.day);
    if (!(day >= 1 && day <= 31) || day % 1 !== 0) return { status: 'error', message: 'วันที่ไม่ถูกต้อง' };
    var name = String((payload && payload.name) || '').trim();
    if (!name) return { status: 'error', message: 'ไม่พบชื่อพนักงาน' };

    var norm = normalizeShiftInput_(payload && payload.value);
    if (!norm.ok) return { status: 'error', message: norm.message };

    // คอลัมน์ของวัน — อ่านจากหัวตารางแบบเดียวกับ applySwapToSheet_ (ไม่พึ่งตำแหน่งตายตัว)
    var ro = readRosterSheet_(sheetName);
    var hasCols = !!ro && Object.keys(ro.dayCol).length > 0;
    if (hasCols && ro.dayCol[day] === undefined) return { status: 'error', message: 'ชีท "' + sheetName + '" ไม่มีคอลัมน์ของวันที่ ' + day };
    var dayCol = hasCols ? ro.dayCol[day] + 1 : day + 4;

    // แถวของพนักงาน — จับคู่ด้วยชื่อ-สกุลเต็มเท่านั้น (ไม่เดาจากชื่อเล่น) ถ้าซ้ำกันไม่เขียนเพื่อกันผิดคน
    var data = sheet.getDataRange().getValues();
    var hdrIdx = -1, nameCol = 0;
    for (var h = 0; h < Math.min(12, data.length) && hdrIdx < 0; h++) {
      for (var c0 = 0; c0 < Math.min(4, data[h].length); c0++) {
        if (rosterIsNameHeader_(data[h][c0])) { hdrIdx = h; nameCol = c0; break; }
      }
    }
    if (hdrIdx < 0) { hdrIdx = 2; nameCol = 0; }
    var rowIdx = -1, dup = 0;
    for (var r = hdrIdx + 1; r < data.length; r++) {
      var nm = String(data[r][nameCol] || '').trim();
      if (!nm || nm.indexOf('รวม') === 0) continue;
      if (nm === name) { if (rowIdx < 0) rowIdx = r; else dup++; }
    }
    if (rowIdx < 0) return { status: 'error', message: 'ไม่พบชื่อในตารางเวร: ' + name };
    if (dup > 0)    return { status: 'error', message: 'พบชื่อซ้ำกันในตารางเวร (' + name + ') — กรุณาแก้ในชีทโดยตรง' };

    var range   = sheet.getRange(rowIdx + 1, dayCol);
    var current = normShiftCell_(range.getValue());

    // กันเขียนทับเวรที่เพิ่งถูกเปลี่ยน (เช่น มีการแลกเวรเข้ามาระหว่างที่เปิดหน้าแก้ไขค้างไว้)
    if (payload && payload.expected !== undefined && payload.expected !== null) {
      var expected = normShiftCell_(payload.expected);
      if (expected !== current) {
        return { status: 'conflict', message: 'ช่องนี้ถูกเปลี่ยนไปแล้ว (ปัจจุบันเป็น "' + (current || 'ว่าง') + '") กรุณาตรวจสอบแล้วลองใหม่', current: current };
      }
    }

    var base = { sheetName: sheetName, day: day, name: name, previous: current };
    if (current === norm.value) return Object.assign({ status: 'ok', unchanged: true, value: current }, base);

    if (norm.value === '') range.clearContent(); else range.setValue(norm.value);
    SpreadsheetApp.flush();

    // บันทึกประวัติการแก้ไข (ล้มเหลวได้ ไม่กระทบการแก้เวร)
    try {
      var logSheet = getOrCreateSheet(getSpreadsheet(), SHEET_SCHEDULE_EDIT_LOG, SCHEDULE_EDIT_LOG_HEADERS);
      var who = v.isAdmin && v.role === 'แอดมิน' ? 'ผู้ดูแลระบบ' : (v.name + (v.nick ? ' (' + v.nick + ')' : ''));
      logSheet.appendRow([Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'), who, sheetName, day, name, current, norm.value, 'แก้ไขจากหน้าตารางเวร']);
    } catch (logErr) { console.warn('setWorktableShift log: ' + logErr.message); }

    return Object.assign({ status: 'ok', value: norm.value, warning: findPendingSwapForCell_(sheetName, day, name) }, base);
  } catch (err) {
    console.error('setWorktableShift error:', err);
    return { status: 'error', message: err.message };
  }
}

/** getJobAssignments — ดึงรายการงานทั้งหมด (ไม่รวมรายการที่ถูกยกเลิก) เรียงวันที่ใหม่สุดก่อน */
function getJobAssignments(params) {
  try {
    var sheet = getJobsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { status: 'ok', data: [] };

    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var jobId = String(row[idx['JobID']] || '').trim();
      if (!jobId) continue;
      if (String(row[idx['สถานะ']] || '').trim() === 'ยกเลิก') continue;

      out.push({
        jobId       : jobId,
        date        : normalizeDateStr_(row[idx['วันที่']]),
        requester   : String(row[idx['ผู้ขอรถ']] || ''),
        headcount   : row[idx['จำนวนคน']] || '',
        mission     : String(row[idx['ภารกิจ/คำสั่งงาน']] || ''),
        destination : String(row[idx['สถานที่ไป']] || ''),
        timeOut     : formatTimeCell(row[idx['เวลาไป']]),
        timeBack    : formatTimeCell(row[idx['เวลากลับ']]),
        driver      : String(row[idx['ผู้ไปส่ง']] || ''),
        car         : String(row[idx['รถที่ใช้']] || ''),
        shiftOwner  : String(row[idx['เวรของ']] || ''),
        updatedBy   : String(row[idx['บันทึกโดย']] || ''),
        updatedByPhone: String(row[idx['เบอร์โทรผู้บันทึก']] || ''),
        createdAt   : String(row[idx['บันทึกเมื่อ']] || ''),
        updatedAt   : String(row[idx['แก้ไขล่าสุด']] || ''),
      });
    }

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // วันที่ใหม่สุดก่อน
      return String(a.timeOut || '').localeCompare(String(b.timeOut || ''));
    });

    return { status: 'ok', data: out };
  } catch (err) {
    console.error('getJobAssignments error:', err);
    return { status: 'error', message: err.message };
  }
}

/** addJobAssignment — เพิ่มงานใหม่ (ต้องผ่านการยืนยันเบอร์โทรก่อนเสมอ) */
function addJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var requester = String((payload && payload.requester) || '').trim();
    var dateStr   = String((payload && payload.date) || '').trim();
    if (!requester) return { status: 'error', message: 'กรุณากรอกชื่อผู้ขอรถ' };
    if (!dateStr)   return { status: 'error', message: 'กรุณาเลือกวันที่' };

    var sheet = getJobsSheet_();
    var jobId = 'JOB' + new Date().getTime();
    var now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

    // ✅ FIX: เขียนแถวใหม่โดยอ้างอิงตำแหน่งคอลัมน์จาก header จริงบนชีท (ไม่ใช่ลำดับตายตัวใน JOBS_HEADERS)
    // เพื่อไม่ให้ข้อมูลเพี้ยนคอลัมน์ ถ้าชีทเดิมมีการเพิ่มคอลัมน์ใหม่ (เช่น "รถที่ใช้") ต่อท้ายในตำแหน่งที่ต่างไป
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var idx = jobsHeaderIndex_(headers);
    var row = new Array(headers.length).fill('');
    function setCell(col, val) { if (idx[col] != null) row[idx[col]] = val; }

    setCell('JobID', jobId);
    setCell('วันที่', dateStr);
    setCell('ผู้ขอรถ', requester);
    setCell('จำนวนคน', payload.headcount != null ? payload.headcount : '');
    setCell('ภารกิจ/คำสั่งงาน', String(payload.mission || '').trim());
    setCell('สถานที่ไป', String(payload.destination || '').trim());
    setCell('เวลาไป', String(payload.timeOut || '').trim());
    setCell('เวลากลับ', String(payload.timeBack || '').trim());
    setCell('ผู้ไปส่ง', String(payload.driver || '').trim());
    setCell('รถที่ใช้', String(payload.car || '').trim());
    setCell('เวรของ', String(payload.shiftOwner || '').trim());
    setCell('บันทึกโดย', v.name);
    setCell('เบอร์โทรผู้บันทึก', v.phone);
    setCell('สถานะ', 'ปกติ');
    setCell('บันทึกเมื่อ', now);
    setCell('แก้ไขล่าสุด', now);

    sheet.appendRow(row);

    return { status: 'ok', jobId: jobId, message: 'บันทึกงานเรียบร้อยแล้ว' };
  } catch (err) {
    console.error('addJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** updateJobAssignment — แก้ไขงานเดิม (ต้องผ่านการยืนยันเบอร์โทรก่อนเสมอ) */
function updateJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var jobId = String((payload && payload.jobId) || '').trim();
    if (!jobId) return { status: 'error', message: 'ไม่พบรายการที่ต้องการแก้ไข' };

    var sheet = getJobsSheet_();
    var data  = sheet.getDataRange().getValues();
    var idx   = jobsHeaderIndex_(data[0]);

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['JobID']] || '').trim() !== jobId) continue;

      var rowNum = r + 1;
      var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

      function setIfProvided(col, val) {
        if (val === undefined || val === null) return;
        sheet.getRange(rowNum, idx[col] + 1).setValue(val);
      }

      setIfProvided('วันที่', payload.date);
      setIfProvided('ผู้ขอรถ', payload.requester);
      setIfProvided('จำนวนคน', payload.headcount);
      setIfProvided('ภารกิจ/คำสั่งงาน', payload.mission);
      setIfProvided('สถานที่ไป', payload.destination);
      setIfProvided('เวลาไป', payload.timeOut);
      setIfProvided('เวลากลับ', payload.timeBack);
      setIfProvided('ผู้ไปส่ง', payload.driver);
      setIfProvided('รถที่ใช้', payload.car);
      setIfProvided('เวรของ', payload.shiftOwner);
      sheet.getRange(rowNum, idx['บันทึกโดย'] + 1).setValue(v.name);
      sheet.getRange(rowNum, idx['เบอร์โทรผู้บันทึก'] + 1).setValue(v.phone);
      sheet.getRange(rowNum, idx['แก้ไขล่าสุด'] + 1).setValue(now);

      return { status: 'ok', message: 'แก้ไขข้อมูลเรียบร้อยแล้ว' };
    }

    return { status: 'error', message: 'ไม่พบรายการนี้ในระบบ (อาจถูกลบไปแล้ว)' };
  } catch (err) {
    console.error('updateJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** deleteJobAssignment — ลบงาน (soft delete: ตั้งสถานะเป็น "ยกเลิก" เพื่อรักษาประวัติไว้ตรวจสอบย้อนหลังได้) */
function deleteJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var jobId = String((payload && payload.jobId) || '').trim();
    if (!jobId) return { status: 'error', message: 'ไม่พบรายการที่ต้องการลบ' };

    var sheet = getJobsSheet_();
    var data  = sheet.getDataRange().getValues();
    var idx   = jobsHeaderIndex_(data[0]);

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['JobID']] || '').trim() !== jobId) continue;
      var rowNum = r + 1;
      sheet.getRange(rowNum, idx['สถานะ'] + 1).setValue('ยกเลิก');
      sheet.getRange(rowNum, idx['แก้ไขล่าสุด'] + 1)
        .setValue(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'));
      return { status: 'ok', message: 'ลบรายการเรียบร้อยแล้ว' };
    }

    return { status: 'error', message: 'ไม่พบรายการนี้ในระบบ' };
  } catch (err) {
    console.error('deleteJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** setupJobAssignmentsSheet — สร้าง sheet "ตารางงาน" ถ้ายังไม่มี (เรียกครั้งเดียวตอนติดตั้งระบบ) */
function setupJobAssignmentsSheet() {
  try {
    var sheet = getJobsSheet_();
    return { status: 'ok', message: 'ตั้งค่า sheet ตารางงานเรียบร้อยแล้ว', sheetId: sheet.getSheetId() };
  } catch (err) {
    console.error('setupJobAssignmentsSheet error:', err);
    return { status: 'error', message: err.message };
  }
}
