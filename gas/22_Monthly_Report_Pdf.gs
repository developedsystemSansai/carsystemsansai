// ═══════════════════════════════════════════════════════════════════
//  รายงานประจำเดือน (PDF) บน Google Drive — dashboard.html
//  หน้า Dashboard สร้าง PDF ในเบราว์เซอร์ (ข้อมูลล่าสุดจากชีท) แล้วส่งมาเก็บที่นี่ → โฟลเดอร์ "SAND รายงานประจำเดือน"
//  ไฟล์ไม่ถูกแชร์สาธารณะ: เปิด/ดาวน์โหลดผ่าน getMonthlyReportFile (ต้องมี API key เหมือนทุก endpoint)
// ═══════════════════════════════════════════════════════════════════
var MONTHLY_REPORT_FOLDER_NAME_ = 'SAND รายงานประจำเดือน';
var MONTHLY_REPORT_MAX_B64_     = 14 * 1024 * 1024;   // ~10 MB ไฟล์จริง (PDF ปกติ 1–3 MB)

/** โฟลเดอร์เก็บรายงาน — จำ ID ไว้ใน Script Properties; ไม่มีก็สร้างใหม่ (ชื่อซ้ำจะใช้ของเดิม) */
function getMonthlyReportFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('MONTHLY_REPORT_FOLDER_ID');
  if (id) {
    try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (_) { /* โฟลเดอร์ถูกลบ/ไม่มีสิทธิ์ → หาใหม่ */ }
  }
  var it = DriveApp.getFoldersByName(MONTHLY_REPORT_FOLDER_NAME_);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(MONTHLY_REPORT_FOLDER_NAME_);
  props.setProperty('MONTHLY_REPORT_FOLDER_ID', folder.getId());
  return folder;
}

function monthlyReportInfo_(file) {
  var m = String(file.getName()).match(/^SAND_Monthly_(\d{4}-\d{2})\.pdf$/);
  return {
    ym: m ? m[1] : '', name: file.getName(), id: file.getId(), url: file.getUrl(),
    size: file.getSize(), updated: file.getLastUpdated().toISOString()
  };
}

/** listMonthlyReports — รายการรายงานที่เก็บไว้ (เดือนใหม่ → เก่า; เดือนเดียวกันมีหลายไฟล์ใช้ไฟล์ล่าสุด) */
function listMonthlyReports() {
  var folder = getMonthlyReportFolder_(), it = folder.getFiles(), best = {};
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    var info = monthlyReportInfo_(f);
    if (!info.ym) continue;                          // ข้ามไฟล์อื่นที่ไม่ได้มาจากระบบ
    if (!best[info.ym] || info.updated > best[info.ym].updated) best[info.ym] = info;
  }
  var data = Object.keys(best).sort().reverse().map(function (k) { return best[k]; });
  return { status: 'ok', data: data, count: data.length };
}

/** saveMonthlyReport — รับ PDF (base64) ของเดือน ym → เก็บเป็น SAND_Monthly_YYYY-MM.pdf
 *  overwrite=false และมีไฟล์เดือนนั้นอยู่แล้ว → ไม่บันทึกทับ คืน status 'exists' (กัน 2 เครื่องสร้างพร้อมกัน/สร้างอัตโนมัติซ้ำ)
 *  overwrite=true → สร้างไฟล์ใหม่ แล้วย้ายไฟล์เดิมลงถังขยะ (กู้คืนได้ 30 วัน) */
function saveMonthlyReport(payload) {
  try {
    var ym = String((payload && payload.ym) || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return { status: 'error', message: 'รูปแบบเดือนไม่ถูกต้อง (ต้องเป็น YYYY-MM)' };
    var b64 = String((payload && payload.pdfBase64) || '');
    if (!b64) return { status: 'error', message: 'ไม่พบข้อมูลไฟล์ PDF' };
    if (b64.length > MONTHLY_REPORT_MAX_B64_) return { status: 'error', message: 'ไฟล์ใหญ่เกินกำหนด (สูงสุดประมาณ 10 MB)' };

    var bytes = Utilities.base64Decode(b64);
    // ตรวจว่าเป็น PDF จริง (ขึ้นต้นด้วย %PDF) — กันเก็บไฟล์อื่นผ่าน endpoint นี้
    if (!(bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      return { status: 'error', message: 'ไฟล์ที่ส่งมาไม่ใช่ PDF' };
    }

    var folder = getMonthlyReportFolder_(), name = 'SAND_Monthly_' + ym + '.pdf';
    var existing = [], it = folder.getFilesByName(name);
    while (it.hasNext()) { var f = it.next(); if (!f.isTrashed()) existing.push(f); }
    if (existing.length && !payload.overwrite) return { status: 'exists', file: monthlyReportInfo_(existing[0]) };

    var file = folder.createFile(Utilities.newBlob(bytes, 'application/pdf', name));
    file.setDescription('SAND monthly report ' + ym + ' · source=' + (payload.source === 'auto' ? 'auto' : 'manual') + ' · ' + new Date().toISOString());
    existing.forEach(function (old) { old.setTrashed(true); });
    return { status: 'ok', file: monthlyReportInfo_(file) };
  } catch (err) {
    return { status: 'error', message: 'บันทึกรายงานไม่สำเร็จ: ' + err.message };
  }
}

/** getMonthlyReportFile — ส่ง PDF กลับเป็น base64 ให้หน้า Dashboard เปิด/ดาวน์โหลด
 *  🔒 อนุญาตเฉพาะไฟล์ SAND_Monthly_*.pdf ที่อยู่ในโฟลเดอร์รายงานเท่านั้น (กันใช้ endpoint นี้อ่านไฟล์อื่นใน Drive) */
function getMonthlyReportFile(params) {
  try {
    var id = String((params && params.id) || '');
    if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return { status: 'error', message: 'รหัสไฟล์ไม่ถูกต้อง' };
    var folder = getMonthlyReportFolder_(), file;
    try { file = DriveApp.getFileById(id); } catch (_) { return { status: 'error', message: 'ไม่พบไฟล์' }; }
    var inFolder = false, ps = file.getParents();
    while (ps.hasNext()) { if (ps.next().getId() === folder.getId()) { inFolder = true; break; } }
    if (!inFolder || file.isTrashed() || !/^SAND_Monthly_\d{4}-\d{2}\.pdf$/.test(file.getName())) {
      return { status: 'error', message: 'ไม่ได้รับอนุญาตให้เข้าถึงไฟล์นี้' };
    }
    return { status: 'ok', name: file.getName(), mime: 'application/pdf', base64: Utilities.base64Encode(file.getBlob().getBytes()) };
  } catch (err) {
    return { status: 'error', message: 'เปิดไฟล์ไม่สำเร็จ: ' + err.message };
  }
}
