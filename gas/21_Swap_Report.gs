// ═══════════════════════════════════════════════════════════════════
//  ใบแลกเวร รายเดือน (สำหรับยื่นฝ่ายการเงิน) — swap.html, ปุ่ม "ใบแลกเวร (Excel)"
//  ไม่แก้ไขฟังก์ชันเดิมของระบบแลกเวรเลย ใช้ข้อมูลจากชีต SwapRequests ที่มีอยู่แล้วเท่านั้น
//  อ้างอิงเดือน/ปี พ.ศ. จริงของแต่ละคำขอจาก RequestID (รูปแบบ SWyyMMdd-HHmmss) + ฟิลด์
//  "เดือน" (current/next) — เพื่อให้รายงานเดือนเก่ายังถูกต้อง แม้ตารางเวร current/next
//  ในระบบจะเปลี่ยนไปตามเวลาแล้วก็ตาม
// ═══════════════════════════════════════════════════════════════════

var SWAP_REPORT_THAI_MONTHS = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

/** ถอดปี(พ.ศ.)/เดือนจริงของคำขอ จาก RequestID (SWyyMMdd-HHmmss) + ฟิลด์ "เดือน" (current/next) */
function swapReportAbsoluteMonth_(requestId, monthSheetField) {
  var m = /^SW(\d{2})(\d{2})(\d{2})-/.exec(String(requestId || ''));
  var year, month;
  if (m) {
    year = 2000 + Number(m[1]) + 543; // yy (ค.ศ. 2 หลัก) → พ.ศ.
    month = Number(m[2]);
  } else {
    var now = new Date();
    year = now.getFullYear() + 543;
    month = now.getMonth() + 1;
  }
  if (String(monthSheetField) === 'next') {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return { year: year, month: month };
}
function swapReportMonthKey_(year, month) {
  return year + '-' + (month < 10 ? '0' + month : String(month));
}
function swapReportMonthLabel_(year, month) {
  return (SWAP_REPORT_THAI_MONTHS[month] || '') + ' ' + year;
}
function swapReportFullDate_(day, year, month) {
  return Number(day) + ' ' + (SWAP_REPORT_THAI_MONTHS[month] || '') + ' ' + year;
}
/** ✅ FIX: คอลัมน์ "ว/ด/ป" ในใบแลกเวร (วันที่บันทึก/อนุมัติคำขอ) เคยแสดงผลสลับ "เดือน/วัน" กัน
 *  (เช่น 9/17/2569 แทนที่จะเป็น 17/9/2569) สาเหตุ: ค่าที่บันทึกไว้ตอนแรกเป็นสตริง "dd/MM/yyyy HH:mm:ss"
 *  (ปี ค.ศ.) แต่ Google ชีตตรวจจับรูปแบบนี้แล้ว auto-convert เซลล์เป็น "วันที่จริง" (Date) ให้เองโดยไม่ได้ขอ
 *  พอไปอ่านค่ากลับด้วย getValues() จึงได้ JS Date object แทนสตริงเดิม แล้วตอนส่งออกไฟล์ Excel/PDF ค่านั้น
 *  ถูกจัดรูปแบบตาม locale เริ่มต้นของสเปรดชีต/โปรแกรม (เช่น en_US = เดือน/วัน/ปี) ทำให้วันที่สลับตำแหน่งกับ
 *  เดือนโดยไม่ตั้งใจ โดยเฉพาะวันที่ ≤12 ที่ตีความสลับกันได้ทั้งสองแบบจนดูไม่ออกว่าผิด (เช่น 9/11 อาจเป็น
 *  9 พ.ย. หรือ 11 ก.ย. ก็ได้) ฟังก์ชันนี้รองรับทั้ง 2 กรณี (Date object จาก auto-convert หรือสตริงเดิม)
 *  แล้วคืนค่าเป็นข้อความล้วน รูปแบบ "วัน/เดือน/ปี พ.ศ." ที่ไม่กำกวมเสมอ (เช่น "23/9/2569") */
function swapReportFormatRecordDate_(raw) {
  if (raw == null || raw === '') return '';
  var d, mo, y;
  if (Object.prototype.toString.call(raw) === '[object Date]' && !isNaN(raw.getTime())) {
    // ถูก auto-convert เป็น Date จริงไปแล้วโดย Google ชีต — อ่านค่ากลับด้วย timezone ไทยเสมอ กันวันที่เพี้ยน
    var parts = Utilities.formatDate(raw, 'Asia/Bangkok', 'd/M/yyyy').split('/');
    d = Number(parts[0]); mo = Number(parts[1]); y = Number(parts[2]);
  } else {
    // ยังเป็นสตริงเดิม "dd/MM/yyyy HH:mm:ss" (วัน/เดือน/ปี ค.ศ.) ที่เขียนไว้ตอนบันทึก/อนุมัติคำขอ
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(raw).trim());
    if (!m) return String(raw); // รูปแบบไม่รู้จัก — คืนค่าดิบไว้ก่อน ดีกว่าทำข้อมูลหาย
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
  }
  if (y < 2100) y += 543; // ปี ค.ศ. (4 หลัก แต่ค่าน้อยกว่านี้เสมอในยุคปัจจุบัน) → แปลงเป็น พ.ศ.
  return d + '/' + mo + '/' + y;
}
/** ป้ายชื่อเวรแบบสั้น สำหรับตารางใบแลกเวร (คอลัมน์แคบ) — ตรงกับ shiftName() ฝั่งหน้าเว็บ swap.html
 *  ✅ ค่าว่าง หรือ "0" (ไม่ว่าจะเป็นเลข 0 จริงๆ หรือข้อความ "0" จากช่องตารางงาน) หมายถึง "ไม่มีเวร"
 *     — ต้องแปลงเป็นข้อความนี้ก่อนนำไปลงเอกสาร ไม่เช่นนั้นเอกสารจะขึ้นเลข "0" ตรงๆ หรือช่องว่างจนดูเหมือนพิมพ์ตก */
function swapReportShiftShort_(code) {
  var s = String(code == null ? '' : code).trim();
  if (!s || s === '0') return 'ไม่มีเวร';
  var l = s.toLowerCase();
  if (l.indexOf('ช1บ2') === 0) return 'ช1บ2';
  if (l.indexOf('ช2บ1') === 0) return 'ช2บ1';
  if (l.indexOf('บ') === 0) return 'บ่าย ' + s.charAt(1); // ✅ NEW: ครึ่งบ่ายที่ถูกแยกออกมา เช่น "บ1"
  if (l.indexOf('ems') >= 0) return 'EMS';
  if (l.indexOf('ช1') === 0) return 'เช้า 1';
  if (l.indexOf('ช2') === 0) return 'เช้า 2';
  if (l.indexOf('ช3') === 0) return 'เช้า 3';
  if (l.indexOf('ด') === 0) return 'ดึก';
  if (l.indexOf('ช') === 0) return 'เช้า';
  return s;
}

/** รายชื่อเดือนที่มีคำขอแลกเวร "อนุมัติแล้ว" อย่างน้อย 1 รายการ (สำหรับ dropdown เลือกเดือนในหน้าประวัติ) */
function getSwapReportAvailableMonths() {
  try {
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var counts = {};
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var status = String(row[idx['สถานะ']] || '');
      if (status.indexOf('อนุมัติ') < 0) continue;
      var am = swapReportAbsoluteMonth_(row[idx['RequestID']], row[idx['เดือน']]);
      var key = swapReportMonthKey_(am.year, am.month);
      if (!counts[key]) {
        counts[key] = { key: key, label: swapReportMonthLabel_(am.year, am.month), count: 0, sortKey: am.year * 100 + am.month };
      }
      counts[key].count++;
    }
    var months = Object.keys(counts).map(function (k) { return counts[k]; });
    months.sort(function (a, b) { return b.sortKey - a.sortKey; }); // เดือนล่าสุดก่อน
    return { status: 'ok', months: months };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** ดึงรายการแลกเวรที่ "อนุมัติแล้ว" ทั้งหมดของเดือนที่ระบุ (monthKey เช่น "2569-09")
 *  จัดรูปแบบพร้อมสำหรับตาราง "ใบแลกเวร" — ผู้ขอแลก/ผู้รับแลกเวร แต่ละคนมีเวรเดิม/แลกเป็นของตัวเอง
 *  (ผู้ขอแลกไปทำงานแทนในวันเดิมของผู้รับแลก และผู้รับแลกไปทำงานแทนในวันเดิมของผู้ขอแลก) */
function getSwapMonthlyReport(payload) {
  try {
    var monthKey = String((payload && payload.monthKey) || '').trim();
    if (!monthKey) return { status: 'error', message: 'กรุณาระบุเดือนที่ต้องการ' };

    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var rows = [];

    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var status = String(row[idx['สถานะ']] || '');
      if (status.indexOf('อนุมัติ') < 0) continue; // เฉพาะที่อนุมัติแล้วเท่านั้น (อนุมัติเอง หรืออนุมัติอัตโนมัติของแอดมิน)

      var requestId = row[idx['RequestID']];
      var am = swapReportAbsoluteMonth_(requestId, row[idx['เดือน']]);
      if (swapReportMonthKey_(am.year, am.month) !== monthKey) continue;

      var requesterDay   = row[idx['วันที่เดิมของผู้ขอแลก']];
      var requesterShift = row[idx['เวรเดิมของผู้ขอแลก']];
      var targetDay       = row[idx['วันที่เดิมของผู้รับแลก']];
      var targetShift     = row[idx['เวรเดิมของผู้รับแลก']];
      var isGiveRow       = idx['ประเภทคำขอ'] != null && String(row[idx['ประเภทคำขอ']] || '') === 'ยกเวร';
      // ✅ NEW: 'full' (ยกทั้งเวร, ค่าเริ่มต้น) / 'am' / 'pm' — ผู้ให้เวรอาจเหลือครึ่งเวรไว้เอง
      var giveScopeRow    = idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']] ? String(row[idx['ส่วนที่ยก']]) : 'full';

      // ✅ "ยกเวร" (ให้ทางเดียว) ต่างจาก "แลกเวร" (สลับ 2 ทาง): ผู้ให้เวรไม่ได้รับเวรอื่นกลับมาแทน
      // (แลกเป็น = ไม่มีเวรแล้ว หรือถ้ายกครึ่งเวร = เหลืออีกครึ่งไว้เอง) ส่วนผู้รับเวรแทนทำงาน "รวม 2 เวร"
      // ในวันเดียวกัน (เวรเดิม + เวรที่รับมา) ต้องแสดงผลรวมนี้ในใบแลกเวรให้ตรงกับตารางเวรจริง
      // เพื่อให้กลุ่มงานการเงินจ่ายเงินเวรครบทั้ง 2 เวร
      var reqNewDateOut, reqNewShiftOut, tgtNewShiftOut;
      if (isGiveRow) {
        var givenShiftRow = requesterShift;
        var remainingReqShiftRow = '';
        if (giveScopeRow !== 'full') {
          var splitPartsRow = swapSplitCombinedShift_(requesterShift);
          if (splitPartsRow) {
            givenShiftRow = (giveScopeRow === 'am') ? splitPartsRow.am : splitPartsRow.pm;
            remainingReqShiftRow = (giveScopeRow === 'am') ? splitPartsRow.pm : splitPartsRow.am;
          }
        }
        reqNewDateOut  = swapReportFullDate_(requesterDay, am.year, am.month);
        reqNewShiftOut = remainingReqShiftRow
          ? swapReportShiftShort_(remainingReqShiftRow) + ' (ยก ' + swapReportShiftShort_(givenShiftRow) + ' ให้ ' + (row[idx['ชื่อผู้รับแลก']] || '') + ')'
          : 'ไม่มีเวร (ยกให้ ' + (row[idx['ชื่อผู้รับแลก']] || '') + ')';
        tgtNewShiftOut = swapReportShiftShortCombined_(swapCombineShiftValues_(targetShift, givenShiftRow));
      } else {
        reqNewDateOut  = swapReportFullDate_(targetDay, am.year, am.month);
        reqNewShiftOut = swapReportShiftShort_(targetShift);
        tgtNewShiftOut = swapReportShiftShort_(requesterShift);
      }

      rows.push({
        requestId: requestId,
        recordDate: swapReportFormatRecordDate_(row[idx['ดำเนินการเมื่อ']] || row[idx['บันทึกเมื่อ']]),
        sortDay: Number(requesterDay) || 0,
        requesterName: row[idx['ชื่อผู้ขอแลก']],
        reqOldDate: swapReportFullDate_(requesterDay, am.year, am.month),
        reqOldShift: swapReportShiftShort_(requesterShift),
        reqNewDate: reqNewDateOut,
        reqNewShift: reqNewShiftOut,
        targetName: row[idx['ชื่อผู้รับแลก']],
        tgtOldDate: swapReportFullDate_(targetDay, am.year, am.month),
        tgtOldShift: swapReportShiftShort_(targetShift),
        tgtNewDate: swapReportFullDate_(requesterDay, am.year, am.month),
        tgtNewShift: tgtNewShiftOut,
        remark: row[idx['เหตุผล']],
        // ✅ NEW (ใบสรุปเวรจริงเพื่อจ่ายเงิน): เพิ่ม field เสริม 2 ตัวนี้ต่อท้าย ไม่กระทบโครงสร้างเดิม —
        //  ใช้จับคู่ "เหตุการณ์แลก/ยกเวร" เข้ากับวันจริงของแต่ละฝ่าย บนฝั่งไคลเอนต์ (swap.html) เพื่อสร้าง
        //  คอลัมน์ "หมายเหตุ/ที่มา" ในรายงานสรุปจ่ายเงิน โดยไม่ต้องคำนวณซ้ำฝั่งเซิร์ฟเวอร์อีกรอบ
        //  isGive: true = ยกเวร (ทางเดียว) / false = แลกเวร (สลับ 2 ทาง)
        //  targetSortDay: วันที่ (เลขวันของเดือนนั้น) ที่ผู้รับเวรแทน "ได้เวรเพิ่ม/เปลี่ยน" จริง
        //    (โหมดยกเวร = วันเดียวกับผู้ให้เวรเสมอ, โหมดแลกเวร = วันเดิมของผู้ขอแลก)
        isGive: isGiveRow,
        targetSortDay: isGiveRow ? (Number(requesterDay) || 0) : (Number(targetDay) || 0)
      });
    }

    rows.sort(function (a, b) { return a.sortDay - b.sortDay; });
    rows.forEach(function (r, i) { r.no = i + 1; });

    var ym = monthKey.split('-');
    var monthLabel = swapReportMonthLabel_(Number(ym[0]), Number(ym[1]));

    return { status: 'ok', monthKey: monthKey, monthLabel: monthLabel, rows: rows };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** สร้าง PDF ใบแลกเวรของเดือนที่ระบุ — สร้าง Google Sheet ชั่วคราว จัดรูปแบบให้เหมือนแบบฟอร์มเดิม
 *  แล้ว export เป็น PDF ผ่าน Sheets export URL (ควบคุม fit-to-width/แนวนอน/ไม่มีเส้นกริดได้ตรงนี้เท่านั้น
 *  — ต่างจาก getAs('application/pdf') ที่ไม่รองรับพารามิเตอร์เหล่านี้) จากนั้นลบชีตชั่วคราวทิ้ง เหลือแค่ไฟล์ PDF */
function generateSwapMonthlyReportPdf(payload) {
  try {
    var rep = getSwapMonthlyReport(payload);
    if (rep.status !== 'ok') return rep;
    if (!rep.rows || !rep.rows.length) {
      return { status: 'error', message: 'เดือนนี้ยังไม่มีรายการแลกเวรที่อนุมัติแล้ว' };
    }

    var destFolder = SWAP_MEMO_FOLDER_ID
      ? DriveApp.getFolderById(SWAP_MEMO_FOLDER_ID)
      : DriveApp.getRootFolder();

    var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
    var fileName = 'ใบแลกเวร_' + rep.monthLabel.replace(/\s+/g, '_') + '_' + stamp;

    var ss = SpreadsheetApp.create(fileName);
    var sheet = ss.getSheets()[0];
    sheet.setName('ใบแลกเวร');
    swapReportFillSheet_(sheet, rep.monthLabel, rep.rows);
    // ✅ ตัดแถว/คอลัมน์ว่างส่วนเกิน (ชีตใหม่มี 1000 แถว × 26 คอลัมน์) เหลือเฉพาะพื้นที่ใบแลกเวร (17 คอลัมน์ + แถวลงนาม)
    var lastUsedRow = 5 + rep.rows.length - 1 + 2 + 5; // dataStart + rows - 1 + 2 + แถวลงนาม(ถึง sigRow+5)
    if (sheet.getMaxRows() > lastUsedRow) sheet.deleteRows(lastUsedRow + 1, sheet.getMaxRows() - lastUsedRow);
    if (sheet.getMaxColumns() > 17) sheet.deleteColumns(18, sheet.getMaxColumns() - 17);
    SpreadsheetApp.flush();

    var ssFile = DriveApp.getFileById(ss.getId());
    try { destFolder.addFile(ssFile); DriveApp.getRootFolder().removeFile(ssFile); } catch (moveErr) { /* ข้ามได้ ไม่กระทบผลลัพธ์ */ }

    var exportUrl = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export' +
      '?format=pdf&size=A4&portrait=false&scale=4' + // ✅ scale=4 = พอดี 1 หน้า (ทั้งกว้างและสูง) — ห้ามแบ่งหน้า ไม่ให้ส่วนลงนามหลุดไปหน้าถัดไป
      '&top_margin=0.3&bottom_margin=0.3&left_margin=0.3&right_margin=0.3' +
      '&gridlines=false&printtitle=false&sheetnames=false&pagenumbers=false' +
      // ✅ FIX: ทำให้ "หัวตาราง" (แถวที่ตรึงไว้ด้วย setFrozenRows ใน swapReportFillSheet_) พิมพ์ซ้ำทุกหน้า
      //    เดิมไม่มีพารามิเตอร์นี้ (ค่าเริ่มต้นของ Google Sheets export คือ false) ทำให้พอเอกสารยาวเกิน 1 หน้า
      //    หน้าที่ 2 เป็นต้นไปไม่มีหัวตารางเลย (เอกสารราชการที่ยื่นฝ่ายการเงินดูไม่เหมาะสม)
      '&fzr=true' +
      '&horizontal_alignment=CENTER&gid=' + sheet.getSheetId();
    var token = ScriptApp.getOAuthToken();
    var resp = UrlFetchApp.fetch(exportUrl, { headers: { Authorization: 'Bearer ' + token } });
    var pdfBlob = resp.getBlob().setName(fileName + '.pdf');
    var pdfFile = destFolder.createFile(pdfBlob);

    try { pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) { console.error('share pdf error:', shareErr); }
    try { ssFile.setTrashed(true); } catch (trashErr) { console.error('trash temp sheet error:', trashErr); } // ลบชีตชั่วคราว เหลือแค่ไฟล์ PDF

    var pdfDownloadUrl = 'https://drive.google.com/uc?export=download&id=' + pdfFile.getId();
    return { status: 'ok', monthLabel: rep.monthLabel, pdfUrl: pdfFile.getUrl(), pdfDownloadUrl: pdfDownloadUrl };
  } catch (err) {
    console.error('generateSwapMonthlyReportPdf error:', err);
    return { status: 'error', message: 'สร้าง PDF ไม่สำเร็จ: ' + err.message };
  }
}

/** ✅ แทรกจุดตัดคำที่ถูกต้องสำหรับข้อความภาษาไทยยาวๆ (เช่น ช่องหมายเหตุ) ก่อนใส่ในเซลล์ Google Sheet/PDF
 *  ปัญหาเดิม: Google Sheets ไม่รู้จักการตัดคำภาษาไทย (ไม่มีเว้นวรรคระหว่างคำ) จึงตัดขึ้นบรรทัดใหม่
 *  แบบผิดตำแหน่ง (กลางคำ) เมื่อข้อความยาวเกินความกว้างเซลล์ — อ้างอิงหลักการตัดคำตามพจนานุกรม
 *  (เช่นเดียวกับที่ราชบัณฑิตยสถานใช้กำหนด) ผ่าน Intl.Segmenter แล้วแทรก Zero-Width Space
 *  (อักขระที่มองไม่เห็น) คั่นระหว่างคำ เพื่อบอกโปรแกรมว่า "ขึ้นบรรทัดใหม่ตรงนี้ได้เท่านั้น"
 *  หากรันไทม์ไม่รองรับ Intl.Segmenter จะคืนข้อความเดิมโดยไม่กระทบการทำงาน */
function thaiWordBreak_(text) {
  text = String(text || '');
  if (!text) return text;
  try {
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      var seg = new Intl.Segmenter('th', { granularity: 'word' });
      var out = '';
      var it = seg.segment(text)[Symbol.iterator]();
      var cur = it.next();
      while (!cur.done) {
        out += cur.value.segment + '\u200B';
        cur = it.next();
      }
      return out.replace(/\u200B$/, '');
    }
  } catch (e) { /* ไม่รองรับ — ใช้ข้อความเดิม */ }
  return text;
}

/** วาดแบบฟอร์ม "ใบแลกเวร" ลงชีตจริง (ใช้ทั้งสำหรับ PDF) ให้ตรงกับเทมเพลตต้นฉบับทุกประการ:
 *  หัวเรื่อง 1 แถว(merge), หัวตาราง 2 แถว(merge ตามคอลัมน์), แถวข้อมูลตามจำนวนรายการจริง, ท้ายฟอร์มลงนาม */
function swapReportFillSheet_(sheet, monthLabel, rows) {
  var THAI_FONT = 'Sarabun';
  var TOTAL_COLS = 17;
  var dataStart = 5, dataEnd = dataStart + rows.length - 1;
  var sigRow = dataEnd + 2;

  sheet.getRange(1, 1, sigRow + 5, TOTAL_COLS).setFontFamily(THAI_FONT);

  // ── หัวเรื่อง ──
  sheet.getRange(1, 4, 2, 11).merge()
    .setValue('แบบแลกเวร งานยานพาหนะ(บริหารทั่วไป) โรงพยาบาลสันทราย จังหวัดเชียงใหม่ เดือน ' + monthLabel)
    .setFontSize(16).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');

  // ── หัวตาราง (แถว 3-4) ──
  var h3 = ['ลำดับ', 'ว/ด/ป', 'ชื่อ-สกุล ผู้ขอแลก', 'เวรเดิม', '', 'แลกเป็น', '', 'ชื่อ-สกุล ผู้รับแลกเวร', '',
    'เวรเดิม', '', 'แลกเป็น', '', 'ลายมือชื่อ\nผู้ขอแลก', 'ลายมือชื่อ\nผู้รับแลก', 'ลายมือชื่อ\nหัวหน้างาน', 'หมายเหตุ'];
  var h4 = ['', '', '', 'ว/ด/ป', 'เวร', 'ว/ด/ป', 'เวร', '', '', 'ว/ด/ป', 'เวร', 'ว/ด/ป', 'เวร', '', '', '', ''];
  sheet.getRange(3, 1, 1, TOTAL_COLS).setValues([h3]);
  sheet.getRange(4, 1, 1, TOTAL_COLS).setValues([h4]);

  sheet.getRange(3, 1, 2, 1).merge();   // A3:A4  ลำดับ
  sheet.getRange(3, 2, 2, 1).merge();   // B3:B4  ว/ด/ป
  sheet.getRange(3, 3, 2, 1).merge();   // C3:C4  ชื่อผู้ขอแลก
  sheet.getRange(3, 4, 1, 2).merge();   // D3:E3  เวรเดิม
  sheet.getRange(3, 6, 1, 2).merge();   // F3:G3  แลกเป็น
  sheet.getRange(3, 8, 2, 2).merge();   // H3:I4  ชื่อผู้รับแลกเวร
  sheet.getRange(3, 10, 1, 2).merge();  // J3:K3  เวรเดิม
  sheet.getRange(3, 12, 1, 2).merge();  // L3:M3  แลกเป็น
  sheet.getRange(3, 14, 2, 1).merge();  // N3:N4  ลายมือชื่อผู้ขอแลก
  sheet.getRange(3, 15, 2, 1).merge();  // O3:O4  ลายมือชื่อผู้รับแลก
  sheet.getRange(3, 16, 2, 1).merge();  // P3:P4  ลายมือชื่อหัวหน้างาน
  sheet.getRange(3, 17, 2, 1).merge();  // Q3:Q4  หมายเหตุ

  sheet.getRange(3, 1, 2, TOTAL_COLS)
    .setFontWeight('bold').setFontSize(14)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true)
    .setBorder(true, true, true, true, true, true);

  // ✅ FIX: ตรึงแถวหัวเรื่อง+หัวตาราง (แถว 1-4) ให้ "ติดอยู่ทุกหน้า" เวลาพิมพ์/ส่งออก PDF
  //    ต้องใช้คู่กับพารามิเตอร์ fzr=true ตอนสร้าง URL export (ดู generateSwapMonthlyReportPdf)
  //    ไม่งั้น Google Sheets จะไม่พิมพ์แถวที่ตรึงไว้ซ้ำในหน้าถัดๆ ไป — ปัญหาเดิม: เอกสารหลายหน้า
  //    หน้าที่ 2 เป็นต้นไปไม่มีหัวตารางเลย ทำให้ไม่รู้ว่าแต่ละคอลัมน์คือข้อมูลอะไร
  sheet.setFrozenRows(4);

  // ── แถวข้อมูล ──
  // ✅ FIX: บังคับคอลัมน์ B (ว/ด/ป บันทึกเมื่อ) ให้เป็น "ข้อความล้วน" ก่อนใส่ค่า — กัน Google ชีต auto-convert
  //    ข้อความ "23/9/2569" กลับเป็นวันที่จริงอีกรอบแล้วจัดรูปแบบทับตาม locale ของสเปรดชีต (เช่น เดือน/วัน/ปี
  //    แบบสหรัฐฯ) ซึ่งเป็นสาเหตุเดิมที่ทำให้วันที่กับเดือนสลับตำแหน่งกันตอนส่งออกเป็น PDF (ดู swapReportFormatRecordDate_)
  sheet.getRange(dataStart, 2, Math.max(rows.length, 1), 1).setNumberFormat('@');
  var dataArr = rows.map(function (r) {
    return [r.no, r.recordDate || '', r.requesterName || '',
      r.reqOldDate || '', r.reqOldShift || '', r.reqNewDate || '', r.reqNewShift || '',
      r.targetName || '', '',
      r.tgtOldDate || '', r.tgtOldShift || '', r.tgtNewDate || '', r.tgtNewShift || '',
      '', '', '', thaiWordBreak_(r.remark || '')];
  });
  sheet.getRange(dataStart, 1, dataArr.length, TOTAL_COLS).setValues(dataArr);
  for (var i = 0; i < dataArr.length; i++) {
    sheet.getRange(dataStart + i, 8, 1, 2).merge(); // H:I ต่อแถว (ชื่อผู้รับแลกเวร)
  }
  sheet.getRange(dataStart, 1, dataArr.length, TOTAL_COLS)
    .setFontSize(13).setVerticalAlignment('middle').setWrap(true)
    .setHorizontalAlignment('center')
    .setBorder(true, true, true, true, true, true);
  [3, 8, 17].forEach(function (c) {
    sheet.getRange(dataStart, c, dataArr.length, 1).setHorizontalAlignment('left');
  });

  // ── ท้ายฟอร์ม: ลงนาม 3 คน ตามเทมเพลตจริง (พขร. / นักวิเคราะห์ฯ ผู้ตรวจสอบ / ผู้อำนวยการ ผู้อนุมัติ) ──
  // ✅ FIX: เดิมแยก "ตรวจสอบแล้ว"/"ตำแหน่ง" ไว้คอลัมน์แคบๆ ต่างหาก (คอลัมน์ 1/6/12 ใช้ร่วมกับคอลัมน์ลำดับ)
  //    ทำให้ข้อความล้นตัดคำตอนพิมพ์ (จัดชิดขวาในคอลัมน์แคบ) — ตอนนี้รวมทุกบรรทัดไว้ในบล็อกกว้างเดียวกัน
  //    ทั้งก้อน ให้อยู่กึ่งกลางตรงกัน และ "ตำแหน่ง" กับชื่อตำแหน่งอยู่บรรทัดเดียวกัน ตามหลักเอกสารราชการ
  // ✅ FIX: เว้นแถวว่าง (แถวสูงพิเศษ) ระหว่าง "ตรวจสอบแล้ว" กับเส้นประ ให้มีที่ว่างสำหรับเซ็นชื่อจริงด้วยปากกา
  // บล็อก 1: คอลัมน์ 1-5 (พขร. ผู้ขอแลก)
  sheet.getRange(sigRow, 1, 1, 5).merge().setValue('ตรวจสอบแล้ว').setHorizontalAlignment('center').setFontSize(13);
  // sigRow+1 เว้นว่างไว้ให้เซ็นชื่อ
  sheet.getRange(sigRow + 2, 1, 1, 5).merge().setValue('.......................................').setHorizontalAlignment('center').setFontSize(13);
  sheet.getRange(sigRow + 3, 1, 1, 5).merge().setValue('(นายชัยพร มอญแสง)').setHorizontalAlignment('center').setFontSize(13);
  sheet.getRange(sigRow + 4, 1, 1, 5).merge().setValue('ตำแหน่ง พนักงานขับรถยนต์').setHorizontalAlignment('center').setFontSize(13);

  // บล็อก 2: คอลัมน์ 6-11 (นักวิเคราะห์นโยบายและแผนฯ ผู้ตรวจสอบ)
  sheet.getRange(sigRow, 6, 1, 6).merge().setValue('ตรวจสอบแล้ว').setHorizontalAlignment('center').setFontSize(13);
  sheet.getRange(sigRow + 2, 6, 1, 6).merge().setValue('.......................................').setHorizontalAlignment('center').setFontSize(13);
  sheet.getRange(sigRow + 3, 6, 1, 6).merge().setValue('(นายนพดล ริยะสาร)').setHorizontalAlignment('center').setFontSize(13);
  sheet.getRange(sigRow + 4, 6, 1, 6).merge().setValue('ตำแหน่ง นักวิเคราะห์นโยบายและแผนชำนาญการ').setHorizontalAlignment('center').setFontSize(13);
  // ✅ เพิ่ม: บรรทัดใต้ชื่อ/ตำแหน่ง ระบุว่าปฏิบัติราชการแทนผู้อำนวยการ
  sheet.getRange(sigRow + 5, 6, 1, 6).merge().setValue('ปฏิบัติราชการแทน ผู้อำนวยการโรงพยาบาลสันทราย').setHorizontalAlignment('center').setFontSize(13);

  // บล็อก 3: คอลัมน์ 12-17 (ผู้อำนวยการโรงพยาบาล ผู้อนุมัติ) — เว้นว่างไว้ก่อน เนื่องจากมีการเปลี่ยนแปลงผู้อำนวยการ
  //          (ยังไม่ใส่ชื่อ/ตำแหน่งจนกว่าจะทราบชื่อผู้อำนวยการคนใหม่ที่แน่ชัด)
  sheet.setRowHeight(sigRow + 1, 30); // แถวว่างสำหรับเซ็นชื่อ — สูงกว่าปกติเพื่อให้มีที่ว่างพอ

  // ── ความกว้างคอลัมน์ / ความสูงแถว (พิกเซล) ──
  var widthsPx = [45, 85, 150, 70, 55, 70, 55, 150, 20, 70, 55, 70, 55, 100, 100, 100, 140];
  widthsPx.forEach(function (w, idx) { sheet.setColumnWidth(idx + 1, w); });
  sheet.setRowHeight(1, 30); sheet.setRowHeight(2, 20);
  sheet.setRowHeight(3, 42); sheet.setRowHeight(4, 42);
  for (var rIdx = dataStart; rIdx <= dataEnd; rIdx++) sheet.setRowHeight(rIdx, 42);

  sheet.setHiddenGridlines(true);
}



/* ============================================================================
   SWAP MEMO GENERATOR — สร้าง "บันทึกข้อความขอแลกเปลี่ยนเวร พขร." (มีตราครุฑ)
   จากเทมเพลต Google Doc โดยแทนที่ตัวแปรอัตโนมัติ แล้ว export เป็น PDF
   ----------------------------------------------------------------------------
   เทมเพลตถูกแก้ไขให้สมบูรณ์แล้ว (แก้ตำแหน่งเลขที่หนังสือ, แก้คำผิด "ผู้รับแลกแลก",
   จัดตารางลงนามใหม่กันข้อความตัดบรรทัด) — ไฟล์ .docx ที่แก้แล้วอยู่ใน outputs
   ให้อัปโหลดทับ/แปลงเป็น Google Doc แล้วนำ Doc ID มาใส่ด้านล่างนี้:
   1) อัปโหลดไฟล์ .docx ที่แก้แล้วขึ้น Google Drive
   2) เปิดด้วย Google Docs แล้ว File > Save as Google Docs (หรือวางทับเนื้อหาเดิมใน
      Doc ID เดิมเพื่อไม่ต้องแก้ ID ด้านล่างนี้)
   3) คัดลอก Doc ID จาก URL (ระหว่าง /d/ กับ /edit) มาแทนที่ด้านล่าง
   ============================================================================ */
var SWAP_MEMO_TEMPLATE_ID = '1Z3WH_Yi54c1oZob-vKySKqqzxCqK0RjSplBlC_HwPTU'; // Google Doc เทมเพลตบันทึกข้อความแลกเวร (มีครุฑ) — อัปเดตให้ชี้ไปที่เทมเพลตฉบับแก้ไขแล้ว
var SWAP_MEMO_FOLDER_ID = '1Zpt5G0lCOfHH7SX7jkmV-5Z6XXLqhlNg'; // โฟลเดอร์ Drive ปลายทางเก็บบันทึกข้อความที่ระบบสร้าง

// ✅ ผู้ลงนามในบันทึกข้อความ — เปลี่ยนจาก นายวรวุฒิ โฆวัชรกุล เป็น นายบารมี บุญเลิศ
//    ระบบจะค้นหาชื่อเดิม (ในเนื้อหา/หัวกระดาษ/ท้ายกระดาษของเทมเพลต) แล้วแทนที่เป็นชื่อใหม่ทุกครั้งที่สร้างเอกสาร
//    จึงไม่ต้องแก้เทมเพลต Google Doc ด้วยมือ (ถ้าแก้ในเทมเพลตแล้ว ส่วนนี้จะไม่ทำอะไร) และใส่ {{APPROVER_NAME}} ในเทมเพลตได้
var SWAP_MEMO_APPROVER_NAME = 'นายบารมี บุญเลิศ';
var SWAP_MEMO_REPLACED_NAMES = ['นายวรวุฒิ โฆวัชรกุล'];

/** สร้าง regex จากชื่อ — ยอมให้เว้นวรรค/ไม่เว้นวรรคหลัง "นาย" และระหว่างชื่อกับสกุล */
function swapNameRegex_(name) {
  return String(name).trim().replace(/^นาย\s*/, 'นาย ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
}

/** เลขที่หนังสือรันอัตโนมัติ รูปแบบ 001/2569 (รีเซ็ตทุกปี พ.ศ. ใหม่) เก็บตัวนับไว้ใน Script Properties */
function nextSwapMemoDocNo_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var buddhistYear = new Date().getFullYear() + 543;
    var storedYear = Number(props.getProperty('SWAP_MEMO_DOCNO_YEAR') || 0);
    var seq = Number(props.getProperty('SWAP_MEMO_DOCNO_SEQ') || 0);
    if (storedYear !== buddhistYear) { seq = 0; }
    seq += 1;
    props.setProperty('SWAP_MEMO_DOCNO_YEAR', String(buddhistYear));
    props.setProperty('SWAP_MEMO_DOCNO_SEQ', String(seq));
    var padded = seq < 10 ? '00' + seq : (seq < 100 ? '0' + seq : String(seq));
    return padded + '/' + buddhistYear;
  } finally {
    lock.releaseLock();
  }
}

function generateSwapMemoDoc(data) {
  try {
    if (!SWAP_MEMO_TEMPLATE_ID || SWAP_MEMO_TEMPLATE_ID.indexOf('ใส่') === 0) {
      throw new Error('ยังไม่ได้ตั้งค่า SWAP_MEMO_TEMPLATE_ID ให้ชี้ไปที่ Google Doc เทมเพลต');
    }
    data = data || {};

    var templateFile = DriveApp.getFileById(SWAP_MEMO_TEMPLATE_ID);
    var destFolder = SWAP_MEMO_FOLDER_ID
      ? DriveApp.getFolderById(SWAP_MEMO_FOLDER_ID)
      : DriveApp.getRootFolder();

    var stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmmss');
    var fileName = 'บันทึกข้อความแลกเวร_' + (data.requesterName || 'ผู้ขอแลก') +
      '_กับ_' + (data.targetName || 'ผู้รับแลก') + '_' + stamp;

    var copy = templateFile.makeCopy(fileName, destFolder);
    var doc = DocumentApp.openById(copy.getId());
    var body = doc.getBody();

    var tokenMap = {
      'DOC_NO': data.docNo || nextSwapMemoDocNo_(),
      'DOC_DATE': data.docDate || swapThaiFullDate_(new Date()),
      'REQUESTER_NAME': data.requesterName || '',
      'TARGET_NAME': data.targetName || '',
      'REASON': data.reason || '',
      'OLD_DATE': data.oldDate != null ? String(data.oldDate) : '',
      'OLD_SHIFT': data.oldShift || '',
      'TARGET_DATE': data.targetDate != null ? String(data.targetDate) : '',
      'TARGET_SHIFT': data.targetShift || '',
      'APPROVER_NAME': SWAP_MEMO_APPROVER_NAME
    };
    Object.keys(tokenMap).forEach(function (key) {
      var pattern = '\\{\\{' + key + '\\}\\}';
      body.replaceText(pattern, String(tokenMap[key]).replace(/\$/g, '$$$$'));
    });

    // ✅ แทนที่ชื่อผู้ลงนามเดิมเป็นชื่อใหม่ (เนื้อหา + หัวกระดาษ + ท้ายกระดาษ)
    var memoParts = [body, doc.getHeader(), doc.getFooter()];
    SWAP_MEMO_REPLACED_NAMES.forEach(function (oldName) {
      var namePattern = swapNameRegex_(oldName);
      memoParts.forEach(function (part) { if (part) part.replaceText(namePattern, SWAP_MEMO_APPROVER_NAME); });
    });

    doc.saveAndClose();

    var pdfBlob = copy.getAs('application/pdf');
    var pdfFile = destFolder.createFile(pdfBlob).setName(fileName + '.pdf');

    // ✅ เปิดสิทธิ์ให้ "ทุกคนที่มีลิงก์ดูได้" (ไม่ต้องขอสิทธิ์เข้าถึง/ไม่ต้อง login ก็เปิด-ดาวน์โหลดได้ทันที)
    //    ถ้าองค์กรใช้ Google Workspace โดเมนของตัวเอง และต้องการจำกัดเฉพาะคนในโดเมน
    //    ให้เปลี่ยน DriveApp.Access.ANYONE_WITH_LINK เป็น DriveApp.Access.DOMAIN_WITH_LINK ทั้ง 2 บรรทัดด้านล่าง
    try { copy.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) { console.error('share doc error:', shareErr); }
    try { pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr2) { console.error('share pdf error:', shareErr2); }

    // ✅ ลิงก์ดาวน์โหลดตรง — คลิกแล้วเบราว์เซอร์โหลดไฟล์ทันที ไม่ต้องเปิด Google Docs/Drive ดูก่อน
    var pdfDownloadUrl = 'https://drive.google.com/uc?export=download&id=' + pdfFile.getId();
    var docDownloadUrl = 'https://docs.google.com/document/d/' + copy.getId() + '/export?format=docx';

    return {
      status: 'ok',
      docUrl: copy.getUrl(),               // เปิดแก้ไขใน Google Docs (เผื่อต้องแก้ก่อนพิมพ์)
      pdfUrl: pdfFile.getUrl(),             // เปิดดูใน Google Drive
      pdfDownloadUrl: pdfDownloadUrl,       // ✅ ดาวน์โหลด PDF ทันที
      docDownloadUrl: docDownloadUrl        // ✅ ดาวน์โหลดเป็น .docx ทันที (เผื่อต้องแก้ไขต่อใน Word)
    };
  } catch (err) {
    return { status: 'error', message: 'สร้างบันทึกข้อความไม่สำเร็จ: ' + err.message };
  }
}
