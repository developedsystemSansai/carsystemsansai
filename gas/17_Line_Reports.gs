// ════════════════════════════════════════════════════════════
//  3) รายงานที่ 1: ตรวจสภาพรถประจำวัน (ทุกวัน จ.-ศ. 10:00 น.)
// ════════════════════════════════════════════════════════════

// ── ลิงก์ Dashboard สำหรับผู้บริหารตรวจสอบข้อมูลด้วยตนเอง (แนบท้ายทุกรายงาน) ──
const DASHBOARD_URL = 'https://developedsystemsansai.github.io/carsystemsansai/dashboard.html';

// ── เส้นคั่นสำหรับจัดรูปแบบให้อ่านง่าย ──
const REPORT_DIVIDER_ = '━━━━━━━━━━━━━━'; // ✅ ย่อเหลือ 14 ตัว — 18 ตัวยาวเกินบนจอมือถือแคบ เส้นจะขาดขึ้นบรรทัดใหม่

// ── รถที่ไม่ต้องนำมารวมในรายงาน (เช่น รถผู้บริหาร) — ใช้ค่าเดียวกับ MILE_GAP_EXCLUDE_PLATES ด้านบนของไฟล์ (ปัจจุบันคือ 8781) ──
function isExcludedVehiclePlate_(plateOrLabel) {
  var s = String(plateOrLabel || '');
  return MILE_GAP_EXCLUDE_PLATES.some(function (ex) { return s.indexOf(ex) >= 0; });
}

// รายการหัวข้อตรวจที่ต้องเฝ้าดูความ "ผิดปกติ" (key ตาม headerToKey ใน getCheckData)
const CHECK_ITEM_LABELS_ = {
  eq_oil: 'น้ำมันเครื่อง/กระจกมองข้าง', eq_battery: 'แบตเตอรี่/ระบบเบรค', eq_tire: 'ยาง/น้ำหม้อน้ำ',
  chk_mirror: 'กระจก', chk_brake: 'เบรค', chk_coolant: 'น้ำหม้อน้ำ', chk_suspension: 'ช่วงล่าง',
  chk_oilLevel: 'ระดับน้ำมันเครื่อง', chk_tirePressure: 'ลมยาง', chk_headlight: 'ไฟหน้า',
  chk_taillight: 'ไฟท้าย', chk_reverseLight: 'ไฟถอย', chk_horn: 'แตร', chk_wiper: 'ที่ปัดน้ำฝน',
  chk_aircon: 'แอร์', chk_exteriorClean: 'ความสะอาดภายนอก', chk_interiorClean: 'ความสะอาดภายใน',
  chk_o2Level: 'ระดับ O2', chk_emergencyLight: 'แสงไฟฉุกเฉิน', chk_siren: 'เสียงไซเรน',
  chk_stretcherLock: 'เปลและระบบล็อกเปล', chk_suction: 'เครื่อง Suction', chk_aed: 'AED/Defibrillator'
};

function isAbnormalValue_(v) {
  return String(v || '').indexOf('ผิดปกติ') >= 0;
}

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** buildDailyCheckReport_ — สร้างเนื้อหารายงานตรวจสภาพรถวันนี้ (LINE text + Email HTML)
 *  จัดกลุ่ม: 🚨 คันที่มีปัญหา ขึ้นก่อนสุดเสมอ (เด่นชัด แยกกรอบจากรายการอื่น) → ✅ ตรวจปกติ → ❌ ยังไม่ตรวจ
 *  รถที่อยู่ใน MILE_GAP_EXCLUDE_PLATES (เช่น 8781 - รถผู้บริหาร) จะไม่ถูกนำมานับ/แสดงในรายงานนี้
 */
/** lineTypeLine_ — ประเภทรถขึ้นบรรทัดของตัวเอง (กันชื่อประเภท/วงเล็บถูกตัดกลางคำเมื่อต่อท้ายทะเบียน) */
function lineTypeLine_(type) { return type ? ('\n   🚘 ' + type) : ''; }

function buildDailyCheckReport_() {
  var todayYmd  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  var todayThai = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');

  var vehiclesRes = getVehicles();
  var vehicles    = ((vehiclesRes && vehiclesRes.data) || [])
    .filter(function (v) { return !isExcludedVehiclePlate_(v['ทะเบียน']); });

  var checkRes  = getCheckData();
  var checkRows = ((checkRes && checkRes.data) || []).filter(function (r) { return r.inspDate === todayYmd; });

  function plateOf(s) { return String(s || '').split(' ')[0].trim(); }

  var problemList   = []; // ตรวจแล้วแต่พบ "ผิดปกติ" — เด่นสุด ต้องรีบดำเนินการ
  var okList        = []; // ตรวจแล้ว ปกติทุกรายการ
  var uncheckedList = []; // ยังไม่ได้ตรวจ

  vehicles.forEach(function (v) {
    var plate = v['ทะเบียน'] || '';
    var label = plate + (v['ประเภท'] ? ' (' + v['ประเภท'] + ')' : '');
    var match = null;
    for (var i = 0; i < checkRows.length; i++) {
      var rowPlate = plateOf(checkRows[i].carType);
      if (rowPlate && (rowPlate === plateOf(plate) || String(checkRows[i].carType || '').indexOf(plateOf(plate)) >= 0)) {
        match = checkRows[i];
        break;
      }
    }
    if (match) {
      var abnormal = [];
      Object.keys(CHECK_ITEM_LABELS_).forEach(function (key) {
        if (isAbnormalValue_(match[key])) abnormal.push(CHECK_ITEM_LABELS_[key]);
      });
      var item = {
        label: label, plate: plate, type: v['ประเภท'] || '', time: match.inspTime || '', driver: match.driverName || '',
        abnormal: abnormal, remarks: match.remarks || ''
      };
      if (abnormal.length > 0) problemList.push(item); else okList.push(item);
    } else {
      uncheckedList.push({ label: label, plate: plate, type: v['ประเภท'] || '', responsible: v['ผู้รับผิดชอบ'] || '' });
    }
  });

  var total = vehicles.length;
  var checkedCount = problemList.length + okList.length;
  var abnormalCount = problemList.length;

  // ── LINE text (ใช้ tpl_() ดึงข้อความจาก LINE_TEMPLATE_DEFAULTS_ หรือค่าที่แอดมินแก้ไว้ผ่านหน้า linecontrol.html) ──
  var lines = [];
  lines.push(tpl_('dailyCheck', 'header', { todayThai: todayThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');
  lines.push(tpl_('dailyCheck', 'summary', {
    checkedCount: checkedCount, total: total,
    uncheckedCount: uncheckedList.length, abnormalCount: abnormalCount
  }));

  if (problemList.length > 0) {
    lines.push('');
    lines.push('🚨' + REPORT_DIVIDER_ + '🚨');
    lines.push(tpl_('dailyCheck', 'problemSectionTitle', {}));
    lines.push('🚨' + REPORT_DIVIDER_ + '🚨');
    problemList.forEach(function (c) {
      lines.push('');
      lines.push(tpl_('dailyCheck', 'problemItem', {
        label: c.label, plate: c.plate, typeLine: lineTypeLine_(c.type), driver: c.driver || '-', time: c.time || '-',
        abnormal: '\n      • ' + c.abnormal.join('\n      • '), // ทีละข้อ บรรทัดละ 1 รายการ
        remarksLine: c.remarks ? ('\n   📝 หมายเหตุ: ' + c.remarks) : ''
      }));
    });
  }

  if (okList.length > 0) {
    lines.push('');
    lines.push(REPORT_DIVIDER_);
    lines.push(tpl_('dailyCheck', 'okSectionTitle', { count: okList.length }));
    lines.push(REPORT_DIVIDER_);
    okList.forEach(function (c) {
      lines.push('');
      lines.push(tpl_('dailyCheck', 'okItem', { label: c.label, plate: c.plate, typeLine: lineTypeLine_(c.type), driver: c.driver || '-', time: c.time || '-' }));
    });
  }

  if (uncheckedList.length > 0) {
    lines.push('');
    lines.push(REPORT_DIVIDER_);
    lines.push(tpl_('dailyCheck', 'uncheckedSectionTitle', { count: uncheckedList.length }));
    lines.push(REPORT_DIVIDER_);
    uncheckedList.forEach(function (u) {
      lines.push('');
      lines.push(tpl_('dailyCheck', 'uncheckedItem', {
        label: u.label, plate: u.plate, typeLine: lineTypeLine_(u.type),
        responsibleLine: u.responsible ? ('\n   👤 ผู้รับผิดชอบ: ' + u.responsible) : ''
      }));
    });
  }

  lines.push('');
  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('dailyCheck', 'footer', { dashboardUrl: DASHBOARD_URL }));

  var lineText = lines.join('\n');

  // ── Email (HTML) ──
  var problemRowsHtml = problemList.map(function (c) {
    return '<tr style="background:#fdecea;border-left:6px solid #c0392b">' +
      '<td style="font-weight:bold;color:#c0392b">🚨 ' + escapeHtml_(c.label) + '</td>' +
      '<td style="color:#fff;background:#c0392b;font-weight:bold;text-align:center;border-radius:4px">พบปัญหา</td>' +
      '<td>' + escapeHtml_(c.driver) + '</td>' +
      '<td>' + escapeHtml_(c.time) + '</td>' +
      '<td style="color:#c0392b;font-weight:bold">' + escapeHtml_(c.abnormal.join(', ')) + (c.remarks ? ('<br><span style="font-weight:normal;color:#555">หมายเหตุ: ' + escapeHtml_(c.remarks) + '</span>') : '') + '</td>' +
      '</tr>';
  }).join('');
  var okRowsHtml = okList.map(function (c) {
    return '<tr>' +
      '<td>' + escapeHtml_(c.label) + '</td>' +
      '<td style="color:#27ae60">ตรวจแล้ว (ปกติ)</td>' +
      '<td>' + escapeHtml_(c.driver) + '</td>' +
      '<td>' + escapeHtml_(c.time) + '</td>' +
      '<td>-</td>' +
      '</tr>';
  }).join('');
  var uncheckedRowsHtml = uncheckedList.map(function (u) {
    return '<tr style="background:#fff8e1">' +
      '<td>' + escapeHtml_(u.label) + '</td>' +
      '<td style="color:#e67e22;font-weight:bold">ยังไม่ตรวจ</td>' +
      '<td colspan="3">' + escapeHtml_(u.responsible) + '</td>' +
      '</tr>';
  }).join('');

  var emailBody = ''
    + '<div style="font-family:sans-serif">'
    + '<h2 style="margin-bottom:4px">🚗 รายงานการตรวจสภาพรถประจำวัน — โรงพยาบาลสันทราย</h2>'
    + '<p style="color:#555;margin-top:0">วันที่ ' + todayThai + '</p>'
    + '<p style="font-size:14px">'
    +   '<b>ตรวจแล้ว ' + checkedCount + '/' + total + ' คัน</b> &nbsp;|&nbsp; '
    +   '<span style="color:#e67e22">ยังไม่ตรวจ ' + uncheckedList.length + ' คัน</span> &nbsp;|&nbsp; '
    +   (abnormalCount > 0
          ? '<span style="color:#fff;background:#c0392b;padding:3px 10px;border-radius:4px;font-weight:bold">⚠️ พบผิดปกติ ' + abnormalCount + ' คัน</span>'
          : '<span style="color:#27ae60">ไม่พบความผิดปกติ ✅</span>')
    + '</p>'
    + '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:10px">'
    + '<tr style="background:#0a2540;color:#fff"><th>รถ</th><th>สถานะ</th><th>ผู้ขับ/ผู้รับผิดชอบ</th><th>เวลา</th><th>รายการผิดปกติ</th></tr>'
    + problemRowsHtml + okRowsHtml + uncheckedRowsHtml
    + '</table>'
    + '<p style="margin-top:24px">📊 ตรวจสอบข้อมูลแบบเรียลไทม์ได้ด้วยตนเองที่ Dashboard:</p>'
    + '<p><a href="' + DASHBOARD_URL + '" style="display:inline-block;background:#0a2540;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">เปิด Dashboard</a></p>'
    + '<p style="color:#999;font-size:12px">' + DASHBOARD_URL + '</p>'
    + '</div>';

  return {
    lineText: lineText,
    emailSubject: '[SAND] รายงานตรวจสภาพรถประจำวัน ' + todayThai + (abnormalCount > 0 ? ' ⚠️ พบปัญหา ' + abnormalCount + ' คัน' : ''),
    emailBody: emailBody,
    checkedCount: checkedCount, total: total, abnormalCount: abnormalCount
  };
}

/** sendDailyVehicleCheckReport — ฟังก์ชันหลักที่ trigger เรียกทุกวัน 10:00 น. (ข้ามเสาร์-อาทิตย์อัตโนมัติ) */
function sendDailyVehicleCheckReport() { return sandRun_('รายงานตรวจสภาพรถรายวัน', sendDailyVehicleCheckReport_); }
function sendDailyVehicleCheckReport_() {
  var dow = Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'u')); // 1=จันทร์ ... 7=อาทิตย์
  if (dow === 6 || dow === 7) {
    console.log('sendDailyVehicleCheckReport: วันนี้เป็นเสาร์/อาทิตย์ — ข้ามการส่งรายงาน');
    return { status: 'skipped', reason: 'weekend' };
  }
  var _cfg = getLineReportSchedule_('dailyCheck'); // ✅ NEW: เช็คสวิตช์เปิด/ปิดจากหน้า linecontrol.html
  if (_cfg && !_cfg.enabled) {
    console.log('sendDailyVehicleCheckReport: ปิดใช้งานจากหน้าควบคุม LINE — ข้ามการส่งรายงาน');
    return { status: 'skipped', reason: 'disabled' };
  }
  var report = buildDailyCheckReport_();
  // ✅ แก้ไข: รายงานตรวจรถ ส่งเฉพาะ แอดมิน + รองฯ (พขร. ไม่ต้องส่ง ตามตารางสิทธิ์)
  var result = sendReportToAllChannels_(report.lineText, report.emailSubject, report.emailBody, REPORT_ROLES_DAILY_CHECK, { trigger: 'auto', key: 'dailyCheck', label: 'รายงานตรวจสภาพรถประจำวัน' });
  console.log('sendDailyVehicleCheckReport result:', JSON.stringify(result));
  return { status: 'ok', report: report, result: result };
}

/** ✅ NEW: buildCheckReminder_ — หา "คันที่ยังไม่ได้ตรวจวันนี้" (จับคู่ทะเบียนด้วยตรรกะเดียวกับ buildDailyCheckReport_)
 *  ไม่นับรถที่ผู้รับผิดชอบอยู่ใน LINE_REMINDER_EXCLUDE_RESPONSIBLE_ */
function buildCheckReminder_() {
  var todayYmd  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  var todayThai = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');

  var vehicles = ((getVehicles() || {}).data || [])
    .filter(function (v) { return !isExcludedVehiclePlate_(v['ทะเบียน']); });
  var checkRows = ((getCheckData() || {}).data || []).filter(function (r) { return r.inspDate === todayYmd; });
  function plateOf(s) { return String(s || '').split(' ')[0].trim(); }

  var unchecked = [];
  vehicles.forEach(function (v) {
    var plate = v['ทะเบียน'] || '';
    var done = checkRows.some(function (r) {
      var rp = plateOf(r.carType);
      return rp && (rp === plateOf(plate) || String(r.carType || '').indexOf(plateOf(plate)) >= 0);
    });
    if (done) return;
    var responsible = String(v['ผู้รับผิดชอบ'] || '');
    var skip = LINE_REMINDER_EXCLUDE_RESPONSIBLE_.some(function (n) { return n && responsible.indexOf(n) >= 0; });
    if (skip) return;
    unchecked.push({ label: plate + (v['ประเภท'] ? ' (' + v['ประเภท'] + ')' : ''), plate: plate, type: v['ประเภท'] || '', responsible: responsible });
  });

  var lineText;
  if (!unchecked.length) {
    lineText = tpl_('checkReminder', 'allDoneText', {});
  } else {
    var lines = [];
    lines.push(tpl_('checkReminder', 'header', { todayThai: todayThai }));
    lines.push(REPORT_DIVIDER_);
    lines.push('');
    lines.push(tpl_('checkReminder', 'summary', { uncheckedCount: unchecked.length, total: vehicles.length }));
    lines.push('');
    unchecked.forEach(function (u) {
      lines.push(tpl_('checkReminder', 'item', {
        label: u.label, plate: u.plate, typeLine: lineTypeLine_(u.type),
        responsibleLine: u.responsible ? ('\n   👤 ผู้รับผิดชอบ: ' + u.responsible) : ''
      }));
    });
    lines.push('');
    lines.push(REPORT_DIVIDER_);
    lines.push(tpl_('checkReminder', 'footer', { checkUrl: String(DASHBOARD_URL).replace('dashboard.html', 'check.html') }));
    lineText = lines.join('\n');
  }
  return { lineText: lineText, uncheckedCount: unchecked.length, total: vehicles.length, unchecked: unchecked };
}

/** ✅ NEW: sendVehicleCheckReminder — trigger 09:30 น. จ-ศ: แจ้งเตือน พขร. ให้ตรวจสภาพรถ เฉพาะเมื่อมีคันที่ยังไม่ตรวจ
 *  ส่ง LINE เฉพาะ พขร. (ตัดรายชื่อที่ยกเว้น) — ไม่ส่งอีเมล, ตรวจครบทุกคันแล้วไม่ส่ง */
function sendVehicleCheckReminder() { return sandRun_('แจ้งเตือน พขร. ตรวจสภาพรถ', sendVehicleCheckReminder_); }
function sendVehicleCheckReminder_() {
  var dow = Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'u'));
  if (dow === 6 || dow === 7) {
    console.log('sendVehicleCheckReminder: วันนี้เป็นเสาร์/อาทิตย์ — ข้ามการส่ง');
    return { status: 'skipped', reason: 'weekend' };
  }
  var _cfg = getLineReportSchedule_('checkReminder');
  if (_cfg && !_cfg.enabled) {
    console.log('sendVehicleCheckReminder: ปิดใช้งานจากหน้าควบคุม LINE — ข้ามการส่ง');
    return { status: 'skipped', reason: 'disabled' };
  }
  var rep = buildCheckReminder_();
  if (rep.uncheckedCount === 0) {
    console.log('sendVehicleCheckReminder: ตรวจครบทุกคันแล้ว — ไม่ส่ง');
    return { status: 'skipped', reason: 'all_checked' };
  }
  var meta = { trigger: 'auto', key: 'checkReminder', label: 'แจ้งเตือน พขร. ตรวจสภาพรถ', roles: REPORT_ROLES_CHECK_REMINDER, by: 'ระบบ' };
  var userIds = getLineUserIdsForKey_('checkReminder', REPORT_ROLES_CHECK_REMINDER);
  if (!userIds.length) {
    lineLogNoRecipient_(meta, REPORT_ROLES_CHECK_REMINDER, rep.lineText);
    console.warn('sendVehicleCheckReminder: ไม่มีผู้รับ พขร. — ตรวจสอบคอลัมน์ "บทบาท" ในชีท LineUsers');
    return { status: 'error', reason: 'no_recipient' };
  }
  var messages = splitLineText_(rep.lineText, 4500).slice(0, 5).map(function (t) { return { type: 'text', text: t }; });
  var mc = lineLogRun_(meta, function () { return lineMulticast_(userIds, messages); });
  console.log('sendVehicleCheckReminder:', JSON.stringify({ unchecked: rep.uncheckedCount, recipients: userIds.length, result: mc }));
  return { status: 'ok', unchecked: rep.uncheckedCount, recipients: userIds.length, result: mc };
}

// ════════════════════════════════════════════════════════════
//  4) รายงานที่ 2: การใช้งานรถ + เติมน้ำมันประจำสัปดาห์ (ทุกวันศุกร์ 15:30 น.)
// ════════════════════════════════════════════════════════════

/** tripFuelFromMileRow_ — ลิตร/ราคาที่เติมจริงของ "ทริปเดียว" จากแถว getMileData
 *  = น้ำมันตอนออก (น้ำมันที่เติม(ลิตร) / ราคาน้ำมัน(บาท)) + น้ำมันตอนกลับ (ลิตรเติมขากลับ / ราคาเติมขากลับ(บาท))
 *  ค่าที่ไม่ใช่ตัวเลข ('auto' = ตรวจพบว่าไปปั๊มแต่ยังไม่มีลิตรจริง, 'ไม่เติม') นับเป็น 0
 *  กติกาเดียวกับ fuelNums_() และหน้าประวัติ/Dashboard — ✅ FIX: เดิมรายงานนี้อ่านเฉพาะ fuelLiters/fuelPrice (ตอนออก)
 *  ทำให้น้ำมันที่เติมตอนกลับ (ซึ่งเป็นช่องทางหลักตั้งแต่ ~12 พ.ย.) ไม่ถูกนับ รายงานสัปดาห์จึงขึ้น 0 ลิตร / 0 บาท */
function tripFuelFromMileRow_(r) {
  function n(v) { var x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return x > 0 ? x : 0; }
  var outL = (r['น้ำมันที่เติม(ลิตร)'] != null && r['น้ำมันที่เติม(ลิตร)'] !== '') ? r['น้ำมันที่เติม(ลิตร)'] : r['fuelLiters'];
  var outP = (r['ราคาน้ำมัน(บาท)'] != null && r['ราคาน้ำมัน(บาท)'] !== '') ? r['ราคาน้ำมัน(บาท)']
           : ((r['ราคาน้ำมัน'] != null && r['ราคาน้ำมัน'] !== '') ? r['ราคาน้ำมัน'] : r['fuelPrice']);
  return { liters: n(outL) + n(r['ลิตรเติมขากลับ']), price: n(outP) + n(r['ราคาเติมขากลับ(บาท)']) };
}

/** buildWeeklyUsageFuelReport_ — สรุปการใช้รถ/เติมน้ำมันย้อนหลัง 7 วัน (รวมวันนี้)
 *  รถที่อยู่ใน MILE_GAP_EXCLUDE_PLATES (เช่น 8781 - รถผู้บริหาร) จะไม่ถูกนำมานับ/แสดงในรายงานนี้
 */
function buildWeeklyUsageFuelReport_() {
  var now       = new Date();
  var startDate = new Date(now.getTime() - 6 * 86400000); // ย้อนหลัง 7 วัน (รวมวันนี้) → ครอบคลุมทั้งสัปดาห์ รวมเสาร์-อาทิตย์ก่อนหน้า
  var startYmd  = Utilities.formatDate(startDate, 'Asia/Bangkok', 'yyyy-MM-dd');
  var endYmd    = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
  var startThai = Utilities.formatDate(startDate, 'Asia/Bangkok', 'dd/MM/yyyy');
  var endThai   = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');

  var mileRes = getMileData({});
  var rows    = ((mileRes && mileRes.data) || [])
    .filter(function (r) { return !isExcludedVehiclePlate_(r['ทะเบียน/รถ'] || r['carType']); });

  function rowYmd(r) {
    return parseDateToYMD(r['วันที่']);
  }

  var weekRows = rows.filter(function (r) {
    var y = rowYmd(r);
    return y && y >= startYmd && y <= endYmd;
  });

  // สรุปรายคัน
  var byVehicle = {}; // plate -> { trips, distance, fuelLiters, fuelCost }
  var totalTrips = 0, totalDistance = 0, totalFuelLiters = 0, totalFuelCost = 0;

  weekRows.forEach(function (r) {
    var plate = String(r['ทะเบียน/รถ'] || r['carType'] || 'ไม่ระบุ').trim();
    if (!byVehicle[plate]) byVehicle[plate] = { trips: 0, distance: 0, fuelLiters: 0, fuelCost: 0 };
    byVehicle[plate].trips += 1;

    var dist = Number(r['ระยะทาง(กม.)']) || 0;
    byVehicle[plate].distance += dist;

    var tf     = tripFuelFromMileRow_(r);     // ตอนออก + ตอนกลับ (ข้าม 'auto'/'ไม่เติม')
    var liters = tf.liters;
    var cost   = tf.price;
    byVehicle[plate].fuelLiters += liters;
    byVehicle[plate].fuelCost   += cost;

    totalTrips += 1; totalDistance += dist; totalFuelLiters += liters; totalFuelCost += cost;
  });

  var plates = Object.keys(byVehicle).sort();

  // ปัดทศนิยม 2 ตำแหน่ง กัน floating point (เช่น 267.76000000000005) แล้วจัดรูปแบบเป็นตัวเลขไทย
  function r2_(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function fmt_(x) { return r2_(x).toLocaleString(); }
  totalFuelLiters = r2_(totalFuelLiters); totalFuelCost = r2_(totalFuelCost); totalDistance = r2_(totalDistance);
  plates.forEach(function (p) { byVehicle[p].fuelLiters = r2_(byVehicle[p].fuelLiters); byVehicle[p].fuelCost = r2_(byVehicle[p].fuelCost); byVehicle[p].distance = r2_(byVehicle[p].distance); });

  // ── LINE text (ใช้ tpl_() ดึงข้อความจาก LINE_TEMPLATE_DEFAULTS_ หรือค่าที่แอดมินแก้ไว้ผ่านหน้า linecontrol.html) ──
  var lines = [];
  lines.push(tpl_('weeklyUsage', 'header', { startThai: startThai, endThai: endThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');
  lines.push(tpl_('weeklyUsage', 'summary', {
    totalTrips: totalTrips.toLocaleString(), totalDistance: totalDistance.toLocaleString(),
    totalFuelLiters: totalFuelLiters.toLocaleString(), totalFuelCost: totalFuelCost.toLocaleString()
  }));

  if (plates.length > 0) {
    lines.push('');
    lines.push(REPORT_DIVIDER_);
    lines.push(tpl_('weeklyUsage', 'byVehicleSectionTitle', {}));
    lines.push(REPORT_DIVIDER_);
    plates.forEach(function (p) {
      var v = byVehicle[p];
      lines.push('');
      lines.push(tpl_('weeklyUsage', 'vehicleItem', {
        plate: p, trips: v.trips, distance: v.distance.toLocaleString(),
        fuelLine: (v.fuelLiters > 0 ? ('\n   ⛽ น้ำมัน: ' + fmt_(v.fuelLiters) + ' ลิตร') : '') +
                  (v.fuelCost   > 0 ? ('\n   💰 ค่าน้ำมัน: ' + fmt_(v.fuelCost) + ' บาท') : '')
      }));
    });
  } else {
    lines.push('');
    lines.push(tpl_('weeklyUsage', 'emptyText', {}));
  }

  lines.push('');
  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('weeklyUsage', 'footer', { dashboardUrl: DASHBOARD_URL }));

  var lineText = lines.join('\n');

  // ── Email HTML ──
  var rowsHtml = plates.map(function (p) {
    var v = byVehicle[p];
    return '<tr><td>' + escapeHtml_(p) + '</td><td>' + v.trips + '</td><td>' + v.distance.toLocaleString() +
      '</td><td>' + (v.fuelLiters ? v.fuelLiters.toLocaleString() : '-') + '</td><td>' + (v.fuelCost ? v.fuelCost.toLocaleString() : '-') + '</td></tr>';
  }).join('');

  var emailBody = ''
    + '<div style="font-family:sans-serif">'
    + '<h2 style="margin-bottom:4px">📊 รายงานการใช้งานรถ + เติมน้ำมันประจำสัปดาห์ — โรงพยาบาลสันทราย</h2>'
    + '<p style="color:#555;margin-top:0">ช่วงวันที่ ' + startThai + ' ถึง ' + endThai + '</p>'
    + '<p style="font-size:14px"><b>รวม:</b> ' + totalTrips + ' เที่ยว &nbsp;|&nbsp; ' + totalDistance.toLocaleString() + ' กม. &nbsp;|&nbsp; น้ำมัน ' +
      totalFuelLiters.toLocaleString() + ' ลิตร &nbsp;|&nbsp; ' + totalFuelCost.toLocaleString() + ' บาท</p>'
    + '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:10px">'
    + '<tr style="background:#0a2540;color:#fff"><th>ทะเบียนรถ</th><th>จำนวนเที่ยว</th><th>ระยะทางรวม (กม.)</th><th>น้ำมัน (ลิตร)</th><th>ค่าน้ำมัน (บาท)</th></tr>'
    + rowsHtml
    + '</table>'
    + '<p style="margin-top:24px">📊 ตรวจสอบข้อมูลแบบเรียลไทม์ได้ด้วยตนเองที่ Dashboard:</p>'
    + '<p><a href="' + DASHBOARD_URL + '" style="display:inline-block;background:#0a2540;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">เปิด Dashboard</a></p>'
    + '<p style="color:#999;font-size:12px">' + DASHBOARD_URL + '</p>'
    + '</div>';

  return {
    lineText: lineText,
    emailSubject: '[SAND] รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์ ' + startThai + '-' + endThai,
    emailBody: emailBody,
    totalTrips: totalTrips, totalDistance: totalDistance, totalFuelLiters: totalFuelLiters, totalFuelCost: totalFuelCost
  };
}

/** sendWeeklyUsageFuelReport — ฟังก์ชันหลักที่ trigger เรียกทุกวันศุกร์ 15:30 น. */
function sendWeeklyUsageFuelReport() {
  var _cfg = getLineReportSchedule_('weeklyUsage'); // ✅ NEW: เช็คสวิตช์เปิด/ปิดจากหน้า linecontrol.html
  if (_cfg && !_cfg.enabled) {
    console.log('sendWeeklyUsageFuelReport: ปิดใช้งานจากหน้าควบคุม LINE — ข้ามการส่งรายงาน');
    return { status: 'skipped', reason: 'disabled' };
  }
  var report = buildWeeklyUsageFuelReport_();
  // ✅ แก้ไข: รายงานใช้รถ/น้ำมันประจำสัปดาห์ ส่งเฉพาะ แอดมิน + รองฯ (พขร. ไม่ต้องส่ง ตามตารางสิทธิ์)
  var result = sendReportToAllChannels_(report.lineText, report.emailSubject, report.emailBody, REPORT_ROLES_WEEKLY_USAGE, { trigger: 'auto', key: 'weeklyUsage', label: 'รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์' });
  console.log('sendWeeklyUsageFuelReport result:', JSON.stringify(result));
  return { status: 'ok', report: report, result: result };
}

// ════════════════════════════════════════════════════════════
//  4b) รายงานที่ 3 (NEW): ตารางงานประจำวัน (ทุกวัน เวลา 07:30 น.) — ส่งให้ รองฯ + พขร. เท่านั้น
// ════════════════════════════════════════════════════════════

/** buildDailyWorkScheduleReport_ — ตารางงานประจำวัน = "ผู้อยู่เวรวันนี้" (ตารางเวร/ตารางเวรถัดไป) + "ภารกิจทั้งหมดวันนี้" (ตารางงาน) สำหรับ รองฯ + พขร.
 *  รูปแบบข้อความเหมือนภาพรวมตารางงานที่กด Rich Menu (buildScheduleOverviewReplyText_) */
function buildDailyWorkScheduleReport_() {
  var now       = new Date();
  var todayYmd  = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
  var todayThai = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');

  var duty;
  try { duty = getDutyForDate_(now); }
  catch (e) { console.error('buildDailyWorkScheduleReport_ duty error:', e); duty = { status: 'error', message: 'อ่านตารางเวรไม่ได้ (' + e.message + ')', people: [], leave: [] }; }

  var jobsRes = getJobAssignments({});
  var todayJobs = ((jobsRes && jobsRes.data) || []).filter(function (j) { return j.date === todayYmd; });

  // เรียงตามเวลาไป (เร็วสุดก่อน)
  todayJobs.sort(function (a, b) { return String(a.timeOut || '').localeCompare(String(b.timeOut || '')); });

  var lines = [];
  lines.push(tpl_('workSchedule', 'header', { todayThai: todayThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  // ── ส่วนที่ 1: ผู้อยู่เวรวันนี้ ──
  Array.prototype.push.apply(lines, buildDutyLines_(duty, 'workSchedule'));
  lines.push('');

  // ── ส่วนที่ 2: ภารกิจทั้งหมดวันนี้ ──
  if (todayJobs.length === 0) {
    lines.push(tpl_('workSchedule', 'emptyText', {}));
  } else {
    lines.push(tpl_('workSchedule', 'listTitle', { count: todayJobs.length }));
    lines.push('');
    var phoneMap = buildStaffPhoneMap_(); // เบอร์โทร พขร. — แนบหลังชื่อผู้ขับแต่ละคน
    todayJobs.forEach(function (j, i) {
      var driverText = j.driver ? driverWithPhone_(j.driver, phoneMap) : '';
      lines.push(tpl_('workSchedule', 'item', {
        no: i + 1, timeOut: shortTime_(j.timeOut) || '-',
        timeBackPart: j.timeBack ? ('–' + shortTime_(j.timeBack)) : '',
        destination: j.destination || '-',
        missionPart: j.mission ? ('\n   🎯 ' + j.mission) : '',
        requester: j.requester || '-',
        driver: driverText || 'ยังไม่ระบุ',                                   // รองรับข้อความเดิมที่แอดมินเคยแก้ไว้ (ใช้ {{driver}})
        driverPart: driverText ? ('\n   🧑\u200d✈️ ผู้ขับ: ' + driverText) : '',
        carPart: j.car ? ('\n   🚗 รถ: ' + j.car) : ''
      }));
      lines.push('');
    });
  }

  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('workSchedule', 'footer', { dashboardUrl: DASHBOARD_URL }));

  var lineText = lines.join('\n');

  var rowsHtml = todayJobs.map(function (j) {
    return '<tr><td>' + escapeHtml_(shortTime_(j.timeOut)) + (j.timeBack ? '–' + escapeHtml_(shortTime_(j.timeBack)) : '') + '</td><td>' +
      escapeHtml_(j.destination) + '</td><td>' + escapeHtml_(j.mission) + '</td><td>' + escapeHtml_(j.requester) +
      '</td><td>' + escapeHtml_(j.driver) + '</td><td>' + escapeHtml_(j.car) + '</td></tr>';
  }).join('');

  var emailBody = ''
    + '<div style="font-family:sans-serif">'
    + '<h2 style="margin-bottom:4px">🗓️ ตารางงานประจำวัน — โรงพยาบาลสันทราย</h2>'
    + '<p style="color:#555;margin-top:0">วันที่ ' + todayThai + '</p>'
    + '<h3 style="margin:14px 0 4px">🧑\u200d✈️ ผู้อยู่เวรวันนี้</h3>' + buildDutyHtml_(duty)
    + '<h3 style="margin:18px 0 4px">📋 ภารกิจทั้งหมดวันนี้</h3>'
    + (todayJobs.length === 0
        ? '<p>ยังไม่มีงานที่บันทึกไว้สำหรับวันนี้</p>'
        : '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:6px">'
          + '<tr style="background:#0a2540;color:#fff"><th>เวลา</th><th>สถานที่ไป</th><th>ภารกิจ</th><th>ผู้ขอรถ</th><th>พขร.</th><th>รถ</th></tr>'
          + rowsHtml + '</table>')
    + '<p style="margin-top:24px">📊 ดูรายละเอียด/แก้ไขได้ที่ Dashboard:</p>'
    + '<p><a href="' + DASHBOARD_URL + '" style="display:inline-block;background:#0a2540;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">เปิด Dashboard</a></p>'
    + '</div>';

  return {
    lineText: lineText,
    emailSubject: '[SAND] ตารางงานประจำวัน ' + todayThai,
    emailBody: emailBody,
    jobCount: todayJobs.length,
    dutyCount: duty.people ? duty.people.length : 0,
    dutyStatus: duty.status
  };
}

/** sendDailyWorkScheduleReport — ฟังก์ชันหลักที่ trigger เรียกทุกวัน 07:30 น. ส่งเฉพาะ รองฯ + พขร.
 *  ✅ แก้ไข: ส่งเฉพาะวันจันทร์-ศุกร์ ข้ามเสาร์-อาทิตย์ (เหมือนรายงานตรวจรถ) */
function sendDailyWorkScheduleReport() { return sandRun_('รายงานตารางงานรายวัน', sendDailyWorkScheduleReport_); }
function sendDailyWorkScheduleReport_() {
  var dow = Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'u')); // 1=จันทร์ ... 7=อาทิตย์
  if (dow === 6 || dow === 7) {
    console.log('sendDailyWorkScheduleReport: วันนี้เป็นเสาร์/อาทิตย์ — ข้ามการส่งรายงาน');
    return { status: 'skipped', reason: 'weekend' };
  }
  var _cfg = getLineReportSchedule_('workSchedule'); // ✅ NEW: เช็คสวิตช์เปิด/ปิดจากหน้า linecontrol.html
  if (_cfg && !_cfg.enabled) {
    console.log('sendDailyWorkScheduleReport: ปิดใช้งานจากหน้าควบคุม LINE — ข้ามการส่งรายงาน');
    return { status: 'skipped', reason: 'disabled' };
  }
  var report = buildDailyWorkScheduleReport_();
  var result = sendReportToAllChannels_(report.lineText, report.emailSubject, report.emailBody, REPORT_ROLES_WORK_SCHEDULE, { trigger: 'auto', key: 'workSchedule', label: 'ตารางงานประจำวัน' });
  console.log('sendDailyWorkScheduleReport result:', JSON.stringify(result));
  return { status: 'ok', report: report, result: result };
}
