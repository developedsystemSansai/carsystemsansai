// ════════════════════════════════════════════════════════════
//  5) TRIGGERS — ตั้งเวลาส่งอัตโนมัติ (รันฟังก์ชันนี้ 1 ครั้งจาก Editor)
// ════════════════════════════════════════════════════════════

/**
 * setupReportTriggers — สร้าง time-driven trigger สำหรับรายงานทั้ง 2 ตัว
 * ⚠️ สำคัญ: ต้องตั้ง Time zone ของโปรเจกต์เป็น Asia/Bangkok ก่อน
 *    (Apps Script Editor → Project Settings → General settings → Time zone)
 *    ไม่งั้นเวลา trigger จะคลาดเคลื่อนตาม time zone อื่น
 */
function setupReportTriggers() {
  // ✅ NEW: เวลาส่งตอนนี้แก้ไขได้จากหน้า linecontrol.html (เก็บในชีท LineReportSchedule) แทนการ hard-code ไว้ในโค้ดแบบเดิม
  //    ฟังก์ชันนี้ยังกด Run ได้ตามปกติ (ครั้งแรก/reset) — จะไปอ่านค่าเวลาปัจจุบันจากชีทนั้นแล้วสร้าง trigger ให้ตรงกันเสมอ
  var created = rebuildLineReportTriggers_();
  return { status: 'ok', message: 'ตั้ง trigger สำเร็จตามเวลาที่ตั้งไว้ในชีท LineReportSchedule (แก้ไขเวลาต่อได้จากหน้า linecontrol.html)', triggers: created };
}

/**
 * ✅ NEW: setupCheckReminderTrigger — ตั้ง trigger "แจ้งเตือน พขร. ตรวจสภาพรถ" เพียงตัวเดียว (กด Run ครั้งเดียวจาก Editor)
 * - ไม่แตะ trigger ของรายงานตัวอื่น (ต่างจาก setupReportTriggers ที่ลบ/สร้างใหม่ทั้งหมด) — รันซ้ำได้ ไม่เกิด trigger ซ้ำ
 * - เวลา: อ่านจากชีท LineReportSchedule (ค่าเริ่มต้น 09:30 น.) — ส่งทุกวัน แต่ตัวฟังก์ชันข้ามเสาร์-อาทิตย์เอง
 * - ถ้าปิดสวิตช์ไว้ในหน้า linecontrol.html จะลบ trigger เดิมและไม่สร้างใหม่
 * ⚠️ Time zone ของโปรเจกต์ต้องเป็น Asia/Bangkok (Project Settings → General settings)
 */
function setupCheckReminderTrigger() {
  var fnName = LINE_SCHEDULE_FN_.checkReminder; // 'sendVehicleCheckReminder'
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === fnName) ScriptApp.deleteTrigger(t);
  });
  var cfg = getLineReportSchedule_('checkReminder') || { hour: 9, minute: 30, enabled: true };
  getOrCreateLineScheduleSheet_(); // เติมแถวใหม่ในชีทให้ปรากฏในหน้า linecontrol.html
  if (!cfg.enabled) {
    console.log('setupCheckReminderTrigger: สวิตช์ปิดอยู่ — ลบ trigger เดิมแล้ว ไม่สร้างใหม่');
    return { status: 'ok', created: false, reason: 'disabled' };
  }
  ScriptApp.newTrigger(fnName).timeBased().everyDays(1).atHour(cfg.hour).nearMinute(cfg.minute).create();
  console.log('setupCheckReminderTrigger: ตั้ง ' + fnName + ' เวลา ' + cfg.hour + ':' + ('0' + cfg.minute).slice(-2) + ' น. (จ-ศ)');
  return { status: 'ok', created: true, fn: fnName, hour: cfg.hour, minute: cfg.minute };
}

/** listReportTriggers — ดูรายการ trigger ปัจจุบันของโปรเจกต์ (สำหรับ debug) */
function listReportTriggers() {
  return ScriptApp.getProjectTriggers().map(function (t) {
    return { function: t.getHandlerFunction(), type: String(t.getEventType()) };
  });
}

// ════════════════════════════════════════════════════════════
//  7) LINE CONTROL PANEL (linecontrol.html) — ระบบควบคุม LINE แบบรวมศูนย์
//     เข้าหน้านี้ต้องกรอก "รหัสแอดมิน" ทุกครั้งที่จะแก้ไขค่า (ใช้รหัสเดียวกับ EDITMILE_ADMIN_CODE
//     เพื่อไม่ต้องจำรหัสหลายชุด — เปลี่ยนรหัสได้ที่ค่าคงที่ EDITMILE_ADMIN_CODE จุดเดียว)
//  ประกอบด้วย 4 ส่วน:
//    7.1) เวลาส่งอัตโนมัติของแต่ละรายงาน (แก้ไขได้ ไม่ต้องแก้โค้ด)
//    7.2) แคตตาล็อกข้อความ + ระบบทดสอบส่งจริง (เสียโควต้า LINE 1 ข้อความ/ครั้ง)
//    7.3) ควบคุมภาพรวมผู้รับ — เปิด/ปิดการรับข้อความอัตโนมัติเป็นรายคนจากชีท LineUsers
//    7.4) บัญชี LINE สำรอง — สลับไปใช้ channel token อีกอันเมื่อบัญชีหลัก token/โควต้าหมด
// ════════════════════════════════════════════════════════════

// ── 7.1) เวลาส่งอัตโนมัติของแต่ละรายงาน (เก็บในชีท LineReportSchedule) ──────────────
var SHEET_LINE_SCHEDULE   = 'LineReportSchedule';
var LINE_SCHEDULE_HEADERS = ['Key', 'ชื่อรายงาน', 'ชั่วโมง', 'นาที', 'วัน (ว่าง=ทุกวันจ-ศ)', 'เปิดใช้งาน'];

// ค่าเริ่มต้น = เวลาที่ระบบเคยตั้งไว้แบบ hard-code เดิม (10:00 / 07:30 / ศุกร์ 15:30)
var LINE_SCHEDULE_DEFAULTS_ = [
  { key: 'dailyCheck',   label: 'รายงานตรวจสภาพรถประจำวัน (จ-ศ)',              hour: 10, minute: 0,  weekday: '',       enabled: true },
  { key: 'workSchedule', label: 'ตารางงานประจำวัน (จ-ศ)',                       hour: 7,  minute: 30, weekday: '',       enabled: true },
  { key: 'weeklyUsage',  label: 'รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์ (ศุกร์)', hour: 15, minute: 30, weekday: 'FRIDAY', enabled: true },
  { key: 'checkReminder', label: 'แจ้งเตือน พขร. ตรวจสภาพรถ — เฉพาะคันที่ยังไม่ตรวจ (จ-ศ)', hour: 9, minute: 30, weekday: '', enabled: true }
];
// key → ชื่อฟังก์ชันจริงที่ trigger จะเรียก (ต้องตรงกับฟังก์ชันที่มีอยู่แล้วในระบบ)
var LINE_SCHEDULE_FN_ = {
  dailyCheck:   'sendDailyVehicleCheckReport',
  workSchedule: 'sendDailyWorkScheduleReport',
  weeklyUsage:  'sendWeeklyUsageFuelReport',
  checkReminder: 'sendVehicleCheckReminder'
};

function getOrCreateLineScheduleSheet_() {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_LINE_SCHEDULE, LINE_SCHEDULE_HEADERS);
  // ✅ NEW: เติมคีย์ที่ยังไม่มีในชีท (ชีทเดิมจะได้เห็นรายงานใหม่) — ไม่แตะแถวที่แอดมินตั้งไว้แล้ว
  var existing = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (r) { existing[String(r[0]).trim()] = true; });
  }
  LINE_SCHEDULE_DEFAULTS_.forEach(function (d) {
    if (!existing[d.key]) sheet.appendRow([d.key, d.label, d.hour, d.minute, d.weekday, d.enabled ? 'TRUE' : 'FALSE']);
  });
  return sheet;
}

/** getLineReportSchedule_ — ค่า config ปัจจุบันของรายงานหนึ่งตัว (key) จากชีท (fallback เป็นค่า default ถ้ายังไม่เคยตั้ง) */
function getLineReportSchedule_(key) {
  var sheet = getOrCreateLineScheduleSheet_();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      return {
        key: key, label: String(data[i][1] || ''),
        hour: Number(data[i][2]), minute: Number(data[i][3]),
        weekday: String(data[i][4] || '').trim(),
        enabled: String(data[i][5]).trim().toUpperCase() !== 'FALSE'
      };
    }
  }
  var def = LINE_SCHEDULE_DEFAULTS_.filter(function (d) { return d.key === key; })[0];
  return def || null;
}

/** getLineReportScheduleAll — config ของรายงานอัตโนมัติทั้งหมด (สำหรับหน้า linecontrol.html) */
function getLineReportScheduleAll() {
  var sheet = getOrCreateLineScheduleSheet_();
  var data  = sheet.getDataRange().getValues();
  var items = [];
  for (var i = 1; i < data.length; i++) {
    items.push({
      key: String(data[i][0]).trim(), label: String(data[i][1] || ''),
      hour: Number(data[i][2]), minute: Number(data[i][3]),
      weekday: String(data[i][4] || '').trim(),
      enabled: String(data[i][5]).trim().toUpperCase() !== 'FALSE'
    });
  }
  return { status: 'ok', items: items };
}

/** saveLineReportSchedule — บันทึกเวลาส่งอัตโนมัติใหม่ + สร้าง trigger ใหม่ให้ตรงทันที (ต้องรหัสแอดมิน)
 *  payload: { items:[{key,hour,minute,weekday,enabled}], adminCode, clientIp } */
function saveLineReportSchedule(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var items = (payload && payload.items) || [];
  if (!items.length) return { status: 'error', message: 'ไม่มีข้อมูลตารางเวลาที่จะบันทึก' };

  var sheet = getOrCreateLineScheduleSheet_();
  var data  = sheet.getDataRange().getValues();

  items.forEach(function (it) {
    var hour   = Math.max(0, Math.min(23, Number(it.hour) || 0));
    var minute = Math.max(0, Math.min(59, Number(it.minute) || 0));
    var found  = false;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]).trim() === it.key) {
        sheet.getRange(i + 1, 3, 1, 4).setValues([[hour, minute, it.weekday || '', it.enabled ? 'TRUE' : 'FALSE']]);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.appendRow([it.key, it.label || it.key, hour, minute, it.weekday || '', it.enabled ? 'TRUE' : 'FALSE']);
    }
  });

  var triggers = rebuildLineReportTriggers_();
  logApiAccess_('saveLineReportSchedule', String((payload && payload.clientIp) || 'unknown'), true, '', '');
  return { status: 'ok', message: 'บันทึกเวลาสำเร็จ และตั้ง trigger ใหม่ให้ตรงกับเวลาที่บันทึกแล้ว', triggers: triggers };
}

/** rebuildLineReportTriggers_ — ลบ trigger เดิมของรายงานอัตโนมัติทั้ง 3 แล้วสร้างใหม่ตามเวลาในชีท LineReportSchedule
 *  (แทนที่การ hard-code เวลาไว้ในโค้ดแบบเดิม — เรียกอัตโนมัติทุกครั้งที่บันทึกเวลาใหม่จากหน้า linecontrol.html
 *   และยังกด Run setupReportTriggers เองจาก Editor ได้ตามปกติ เผื่อกรณี trigger หลุด/ต้องตั้งใหม่) */
function rebuildLineReportTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (Object.keys(LINE_SCHEDULE_FN_).some(function (k) { return LINE_SCHEDULE_FN_[k] === fn; })) {
      ScriptApp.deleteTrigger(t);
    }
  });

  var created = [];
  Object.keys(LINE_SCHEDULE_FN_).forEach(function (key) {
    var cfg = getLineReportSchedule_(key);
    if (!cfg || !cfg.enabled) return; // ปิดใช้งาน → ไม่สร้าง trigger เลย (ฟังก์ชันเองก็เช็คซ้ำอีกชั้นเผื่อมีคนกด Run ตรง)
    var fnName  = LINE_SCHEDULE_FN_[key];
    var builder = ScriptApp.newTrigger(fnName).timeBased();
    if (cfg.weekday && ScriptApp.WeekDay[cfg.weekday]) {
      builder = builder.onWeekDay(ScriptApp.WeekDay[cfg.weekday]);
    } else {
      builder = builder.everyDays(1);
    }
    builder.atHour(cfg.hour).nearMinute(cfg.minute).create();
    created.push({ key: key, fn: fnName, hour: cfg.hour, minute: cfg.minute, weekday: cfg.weekday || 'ทุกวัน (จ-ศ ข้ามเสาร์-อาทิตย์ในตัวฟังก์ชัน)' });
  });
  return created;
}

// ── 7.1b) ระบบแก้ไข "ชุดข้อความ" LINE ได้เองจากหน้า linecontrol.html (ไม่ต้องแก้โค้ด) ──
// แนวคิด: ข้อความแต่ละฉบับถูกแตกเป็น "ท่อน" (field) ย่อยๆ เช่น หัวข้อ/สรุป/รูปแบบต่อแถว/ท้ายข้อความ
// ท่อนไหนมีค่าที่เปลี่ยนไปตามข้อมูลจริง (วันที่ จำนวนคัน ชื่อคนขับ ฯลฯ) ใช้ {{placeholder}} แทนได้
// ค่าที่แอดมินแก้ไว้จะถูกเก็บใน Script Properties (คีย์เดียว เป็น JSON) แยกจากค่า default ในโค้ดนี้
// ถ้ายังไม่เคยแก้ ระบบจะใช้ข้อความเดิม (LINE_TEMPLATE_DEFAULTS_) ทุกประการ พฤติกรรมเดิมจึงไม่เปลี่ยน
const LINE_TEMPLATE_OVERRIDES_PROP_ = 'LINE_MSG_TEMPLATE_OVERRIDES_JSON';

/** ค่าเริ่มต้น (default) ของทุกท่อนข้อความ LINE ในระบบ — key รูปแบบ "<messageKey>.<field>" */
var LINE_TEMPLATE_DEFAULTS_ = {
  // ── dailyCheck: รายงานตรวจสภาพรถประจำวัน ──
  'dailyCheck.header': '🚗 ตรวจสภาพรถประจำวัน\n🏥 โรงพยาบาลสันทราย\n📅 วันที่ {{todayThai}}',
  'dailyCheck.summary': '📊 สรุปภาพรวม\n   ✅ ตรวจแล้ว {{checkedCount}}/{{total}} คัน\n   ❌ ยังไม่ตรวจ {{uncheckedCount}} คัน\n   ⚠️ ผิดปกติ {{abnormalCount}} คัน',
  'dailyCheck.problemSectionTitle': '🔴 พบปัญหา เร่งดำเนินการ !!',
  'dailyCheck.problemItem': '🔴 {{plate}}{{typeLine}}\n   👤 ผู้ขับ: {{driver}}\n   🕐 ตรวจเมื่อ {{time}} น.\n   ⚠️ พบปัญหา:{{abnormal}}{{remarksLine}}',
  'dailyCheck.okSectionTitle': '✅ ตรวจแล้ว ปกติ ({{count}} คัน)',
  'dailyCheck.okItem': '✅ {{plate}}{{typeLine}}\n   👤 {{driver}}\n   🕐 {{time}} น.',
  'dailyCheck.uncheckedSectionTitle': '❌ ยังไม่ได้ตรวจ ({{count}} คัน)',
  'dailyCheck.uncheckedItem': '❌ {{plate}}{{typeLine}}{{responsibleLine}}',
  'dailyCheck.footer': '📊 ดูข้อมูลล่าสุดที่ Dashboard\n🔗 {{dashboardUrl}}',

  // ── workSchedule: ตารางงานประจำวัน ──
  'workSchedule.header': '🗂️ ภาพรวมตารางงานวันนี้\n📅 วันที่ {{todayThai}}',
  'workSchedule.dutySectionTitle': '🧑\u200d✈️ ผู้อยู่เวรวันนี้ ({{count}} คน)',
  'workSchedule.dutyItem': '   • {{name}}{{nickPart}}\n     เวร {{shift}}{{phonePart}}',
  'workSchedule.dutyEmptyText': '🧑\u200d✈️ วันนี้ไม่มีผู้อยู่เวร',
  'workSchedule.dutyLeaveText': '🏖️ ลา ({{count}} คน)\n   {{names}}',
  'workSchedule.dutyWarnText': '⚠️ {{message}}',
  'workSchedule.emptyText': '📋 วันนี้ยังไม่มีภารกิจที่มอบหมาย',
  'workSchedule.listTitle': '📋 ภารกิจทั้งหมดวันนี้ ({{count}} รายการ)',
  'workSchedule.item': '{{no}}. ⏰ {{timeOut}}{{timeBackPart}} น.\n   📍 {{destination}}{{missionPart}}\n   🙋 ผู้ขอรถ: {{requester}}{{driverPart}}{{carPart}}',
  'workSchedule.footer': '📊 ดู/แก้ไขได้ที่ Dashboard\n🔗 {{dashboardUrl}}',

  // ── weeklyUsage: รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์ ──
  'weeklyUsage.header': '📊 สรุปการใช้รถและน้ำมัน\n   ประจำสัปดาห์\n🏥 โรงพยาบาลสันทราย\n📅 {{startThai}} – {{endThai}}',
  'weeklyUsage.summary': '📈 สรุปรวมทั้งหมด\n   🚙 เที่ยวรวม: {{totalTrips}}\n   🛣️ ระยะทางรวม: {{totalDistance}} กม.\n   ⛽ น้ำมันรวม: {{totalFuelLiters}} ลิตร\n   💰 ค่าน้ำมันรวม: {{totalFuelCost}} บาท',
  'weeklyUsage.byVehicleSectionTitle': '🚐 แยกตามรถ',
  'weeklyUsage.vehicleItem': '🚐 {{plate}}\n   🔁 เที่ยว: {{trips}}\n   🛣️ ระยะทาง: {{distance}} กม.{{fuelLine}}',
  'weeklyUsage.emptyText': 'ไม่มีการใช้งานรถในช่วงนี้',
  'weeklyUsage.footer': '📊 ดูข้อมูลล่าสุดที่ Dashboard\n🔗 {{dashboardUrl}}',

  // ── carStatus: สถานะรถ (ตอบสดตอนกดปุ่ม Rich Menu) ──
  'carStatus.header': '🚗 สถานะรถ\n🕐 ณ {{nowThai}} น.',
  'carStatus.readySectionTitle': '✅ พร้อมใช้งาน ({{count}} คัน)',
  'carStatus.readyItem': '   • {{plate}} {{type}}',
  'carStatus.inUseSectionTitle': '🚙 กำลังใช้งาน ({{count}} คัน)',
  'carStatus.inUseItem': '   • {{plate}}\n     👤 {{driver}}{{destPart}}',
  'carStatus.waitingCheckSectionTitle': '⏳ รอตรวจสภาพรถ ({{count}} คัน)',
  'carStatus.waitingCheckItem': '   • {{plate}} {{type}}',
  'carStatus.waitingRepairSectionTitle': '🔧 รอซ่อม ({{count}} คัน)',
  'carStatus.waitingRepairItem': '   • {{plate}} {{type}}',
  'carStatus.footer': '📊 ดูรายละเอียดที่ Dashboard\n🔗 {{dashboardUrl}}',

  // ── myScheduleOverview: ตารางงานของฉัน — ภาพรวม (ตอบสดตอนกดปุ่ม Rich Menu) ──
  'myScheduleOverview.header': '🗂️ ภาพรวมตารางงานวันนี้\n📅 วันที่ {{todayThai}}',
  'myScheduleOverview.dutySectionTitle': '🧑\u200d✈️ ผู้อยู่เวรวันนี้ ({{count}} คน)',
  'myScheduleOverview.dutyItem': '   • {{name}}{{nickPart}}\n     เวร {{shift}}{{phonePart}}',
  'myScheduleOverview.dutyEmptyText': '🧑\u200d✈️ วันนี้ไม่มีข้อมูลผู้อยู่เวร',
  'myScheduleOverview.dutyLeaveText': '🏖️ ลา ({{count}} คน)\n   {{names}}',
  'myScheduleOverview.dutyWarnText': '⚠️ {{message}}',
  'myScheduleOverview.jobsEmptyText': '📋 วันนี้ยังไม่มีภารกิจที่มอบหมาย',
  'myScheduleOverview.jobsListTitle': '📋 ภารกิจทั้งหมดวันนี้ ({{count}} รายการ)',
  'myScheduleOverview.jobItem': '{{no}}. ⏰ {{timeOut}}{{timeBackPart}} น.\n   📍 {{destination}}{{missionPart}}\n   🙋 ผู้ขอรถ: {{requester}}{{driverPart}}{{carPart}}',
  'myScheduleOverview.footer': '📊 ดู/แก้ไขได้ที่ Dashboard\n🔗 {{dashboardUrl}}',

  // ── checkReminder: แจ้งเตือน พขร. ตรวจสภาพรถ (เฉพาะคันที่ยังไม่ตรวจ) ──
  'checkReminder.header': '⏰ แจ้งเตือน พขร.\n🚗 ตรวจสภาพรถประจำวัน\n📅 วันที่ {{todayThai}}',
  'checkReminder.summary': '📋 ยังไม่ได้ตรวจ {{uncheckedCount}} คัน\n   (จากทั้งหมด {{total}} คัน)\nกรุณาตรวจสภาพรถ\nก่อนนำรถออกใช้งาน',
  'checkReminder.item': '❌ {{plate}}{{typeLine}}{{responsibleLine}}',
  'checkReminder.footer': '📝 ตรวจสภาพรถได้ที่\n🔗 {{checkUrl}}',
  'checkReminder.allDoneText': '✅ ตรวจสภาพรถครบทุกคันแล้ว ไม่มีรายการค้าง'
};

/** รายชื่อ field ของแต่ละ messageKey พร้อมป้ายกำกับภาษาไทย (ลำดับตามที่จะแสดงในหน้าแก้ไข) — สำหรับ getLineMessageTemplates() */
var LINE_TEMPLATE_FIELD_DEFS_ = {
  dailyCheck: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'summary', label: 'สรุปภาพรวม (จำนวนตรวจแล้ว/ยังไม่ตรวจ/ผิดปกติ)' },
    { field: 'problemSectionTitle', label: 'หัวข้อส่วน "พบปัญหา"' },
    { field: 'problemItem', label: 'รูปแบบต่อคัน — คันที่พบปัญหา' },
    { field: 'okSectionTitle', label: 'หัวข้อส่วน "ตรวจแล้วปกติ"' },
    { field: 'okItem', label: 'รูปแบบต่อคัน — ตรวจแล้วปกติ' },
    { field: 'uncheckedSectionTitle', label: 'หัวข้อส่วน "ยังไม่ได้ตรวจ"' },
    { field: 'uncheckedItem', label: 'รูปแบบต่อคัน — ยังไม่ได้ตรวจ' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์ Dashboard' }
  ],
  workSchedule: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'dutySectionTitle', label: 'หัวข้อส่วน "ผู้อยู่เวรวันนี้"' },
    { field: 'dutyItem', label: 'รูปแบบต่อคน — ผู้อยู่เวร' },
    { field: 'dutyEmptyText', label: 'ข้อความเมื่อวันนี้ไม่มีผู้อยู่เวร' },
    { field: 'dutyLeaveText', label: 'บรรทัดผู้ลา (แสดงเมื่อมีคนลา)' },
    { field: 'dutyWarnText', label: 'ข้อความเตือนเมื่ออ่านตารางเวรไม่ได้ / ตารางเวรผิดปกติ' },
    { field: 'emptyText', label: 'ข้อความเมื่อวันนี้ไม่มีงานเลย' },
    { field: 'listTitle', label: 'หัวข้อรายการภารกิจ (เมื่อมีงาน)' },
    { field: 'item', label: 'รูปแบบต่อ 1 ภารกิจ' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์ Dashboard' }
  ],
  weeklyUsage: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'summary', label: 'สรุปรวมทั้งหมด (เที่ยว/ระยะทาง/น้ำมัน)' },
    { field: 'byVehicleSectionTitle', label: 'หัวข้อส่วน "แยกตามรถ"' },
    { field: 'vehicleItem', label: 'รูปแบบต่อคัน — สรุปรายคัน' },
    { field: 'emptyText', label: 'ข้อความเมื่อไม่มีการใช้งานรถเลยในสัปดาห์นั้น' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์ Dashboard' }
  ],
  carStatus: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'readySectionTitle', label: 'หัวข้อส่วน "พร้อมใช้งาน"' },
    { field: 'readyItem', label: 'รูปแบบต่อคัน — พร้อมใช้งาน' },
    { field: 'inUseSectionTitle', label: 'หัวข้อส่วน "กำลังใช้งาน"' },
    { field: 'inUseItem', label: 'รูปแบบต่อคัน — กำลังใช้งาน' },
    { field: 'waitingCheckSectionTitle', label: 'หัวข้อส่วน "รอตรวจสภาพรถ"' },
    { field: 'waitingCheckItem', label: 'รูปแบบต่อคัน — รอตรวจสภาพรถ' },
    { field: 'waitingRepairSectionTitle', label: 'หัวข้อส่วน "รอซ่อม"' },
    { field: 'waitingRepairItem', label: 'รูปแบบต่อคัน — รอซ่อม' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์ Dashboard' }
  ],
  myScheduleOverview: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'dutySectionTitle', label: 'หัวข้อส่วน "ผู้อยู่เวรวันนี้"' },
    { field: 'dutyItem', label: 'รูปแบบต่อคน — ผู้อยู่เวร' },
    { field: 'dutyEmptyText', label: 'ข้อความเมื่อวันนี้ไม่มีข้อมูลผู้อยู่เวร' },
    { field: 'dutyLeaveText', label: 'บรรทัดผู้ลา (แสดงเมื่อมีคนลา)' },
    { field: 'dutyWarnText', label: 'ข้อความเตือนเมื่ออ่านตารางเวรไม่ได้ / ตารางเวรผิดปกติ' },
    { field: 'jobsEmptyText', label: 'ข้อความเมื่อวันนี้ไม่มีภารกิจเลย' },
    { field: 'jobsListTitle', label: 'หัวข้อรายการภารกิจ (เมื่อมีภารกิจ)' },
    { field: 'jobItem', label: 'รูปแบบต่อ 1 ภารกิจ' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์ Dashboard' }
  ],
  checkReminder: [
    { field: 'header', label: 'หัวข้อ / บรรทัดแรกของข้อความ' },
    { field: 'summary', label: 'สรุปจำนวนคันที่ยังไม่ตรวจ + คำขอ' },
    { field: 'item', label: 'รูปแบบต่อคัน — ยังไม่ได้ตรวจ' },
    { field: 'footer', label: 'ท้ายข้อความ / ลิงก์หน้าตรวจสภาพรถ' },
    { field: 'allDoneText', label: 'ข้อความเมื่อตรวจครบทุกคัน (ใช้ตอน "ทดสอบส่ง" เท่านั้น — ตอนส่งจริงจะไม่ส่ง)' }
  ]
};

/** getLineTemplateOverrides_ — อ่านค่าที่แอดมินแก้ไว้ทั้งหมด (object แบน key = "<messageKey>.<field>") */
function getLineTemplateOverrides_() {
  var raw = SCRIPT_PROPS_.getProperty(LINE_TEMPLATE_OVERRIDES_PROP_);
  if (!raw) return {};
  try {
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) { return {}; }
}

/** setLineTemplateOverrides_ — บันทึกค่าที่แอดมินแก้ไว้ทั้งหมดกลับลง Script Properties */
function setLineTemplateOverrides_(overrides) {
  SCRIPT_PROPS_.setProperty(LINE_TEMPLATE_OVERRIDES_PROP_, JSON.stringify(overrides || {}));
}

/** renderLineTpl_ — แทนที่ {{token}} ด้วยค่าจริงจาก data (token ที่ไม่มีค่า → แทนด้วยข้อความว่าง) */
function renderLineTpl_(text, data) {
  var s = String(text == null ? '' : text);
  if (!data) return s;
  return s.replace(/\{\{(\w+)\}\}/g, function (m, k) {
    var v = data[k];
    return (v === undefined || v === null) ? '' : String(v);
  });
}

/** tpl_ — คืนข้อความของ "ท่อน" (key.field) หนึ่ง โดยใช้ค่าที่แอดมินแก้ไว้ถ้ามี ไม่งั้น fallback เป็น default แล้วแทนค่า {{placeholder}} ด้วย data */
function tpl_(messageKey, field, data) {
  var overrides = getLineTemplateOverrides_();
  var fkey = messageKey + '.' + field;
  var text = (Object.prototype.hasOwnProperty.call(overrides, fkey) && overrides[fkey] !== '')
    ? overrides[fkey]
    : LINE_TEMPLATE_DEFAULTS_[fkey];
  return renderLineTpl_(text, data);
}

/** getLineMessageTemplates — โครงสร้าง field ของทุกข้อความ + ค่าปัจจุบัน (default หรือค่าที่แก้ไว้) สำหรับหน้า "แก้ไขข้อความ" ใน linecontrol.html */
function getLineMessageTemplates() {
  var overrides = getLineTemplateOverrides_();
  var items = LINE_MESSAGE_CATALOG_.map(function (cat) {
    var defs = LINE_TEMPLATE_FIELD_DEFS_[cat.key] || [];
    var fields = defs.map(function (d) {
      var fkey = cat.key + '.' + d.field;
      var hasOverride = Object.prototype.hasOwnProperty.call(overrides, fkey) && overrides[fkey] !== '';
      return {
        field: d.field,
        label: d.label,
        defaultText: LINE_TEMPLATE_DEFAULTS_[fkey] || '',
        currentText: hasOverride ? overrides[fkey] : (LINE_TEMPLATE_DEFAULTS_[fkey] || ''),
        customized: hasOverride
      };
    });
    return { key: cat.key, label: cat.label, type: cat.type, fields: fields };
  });
  return { status: 'ok', items: items };
}

/** saveLineMessageTemplates — บันทึกข้อความที่แอดมินแก้ไว้ (payload: { key, values:{field:text}, adminCode }) */
function saveLineMessageTemplates(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var key = String((payload && payload.key) || '').trim();
  var defs = LINE_TEMPLATE_FIELD_DEFS_[key];
  if (!defs) return { status: 'error', message: 'ไม่พบชุดข้อความนี้ในระบบ' };

  var values = (payload && payload.values) || {};
  var validFields = {};
  defs.forEach(function (d) { validFields[d.field] = true; });

  var overrides = getLineTemplateOverrides_();
  Object.keys(values).forEach(function (field) {
    if (!validFields[field]) return; // กันชื่อ field แปลกปลอมที่ไม่ได้อยู่ในระบบจริง
    var fkey = key + '.' + field;
    var text = String(values[field] == null ? '' : values[field]);
    var isDefault = text === (LINE_TEMPLATE_DEFAULTS_[fkey] || '');
    if (!text || isDefault) {
      delete overrides[fkey]; // ว่าง หรือเหมือน default เป๊ะ → ไม่ต้องเก็บ override ไว้ ลดขยะ
    } else {
      overrides[fkey] = text;
    }
  });
  setLineTemplateOverrides_(overrides);
  logApiAccess_('saveLineMessageTemplates:' + key, String((payload && payload.clientIp) || 'unknown'), true, '', '');
  return { status: 'ok', message: 'บันทึกข้อความแล้ว' };
}

/** resetLineMessageTemplates — รีเซ็ตกลับไปใช้ข้อความ default (payload: { key, field (ไม่ใส่ = รีเซ็ตทั้งชุด), adminCode }) */
function resetLineMessageTemplates(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var key = String((payload && payload.key) || '').trim();
  if (!LINE_TEMPLATE_FIELD_DEFS_[key]) return { status: 'error', message: 'ไม่พบชุดข้อความนี้ในระบบ' };

  var field = payload && payload.field ? String(payload.field) : '';
  var overrides = getLineTemplateOverrides_();
  if (field) {
    delete overrides[key + '.' + field];
  } else {
    Object.keys(overrides).forEach(function (fkey) {
      if (fkey.indexOf(key + '.') === 0) delete overrides[fkey];
    });
  }
  setLineTemplateOverrides_(overrides);
  logApiAccess_('resetLineMessageTemplates:' + key + (field ? ':' + field : ''), String((payload && payload.clientIp) || 'unknown'), true, '', '');
  return { status: 'ok', message: 'รีเซ็ตข้อความกลับเป็นค่าเริ่มต้นแล้ว' };
}

// ── 7.2) แคตตาล็อกข้อความในระบบ + ระบบทดสอบส่งจริง (ใช้โควต้า LINE 1 ข้อความ/ครั้งที่กดทดสอบ) ──
var LINE_MESSAGE_CATALOG_ = [
  { key: 'dailyCheck',          label: 'รายงานตรวจสภาพรถประจำวัน',                 type: 'auto',     roles: REPORT_ROLES_DAILY_CHECK },
  { key: 'workSchedule',        label: 'ตารางงานประจำวัน',                          type: 'auto',     roles: REPORT_ROLES_WORK_SCHEDULE },
  { key: 'weeklyUsage',         label: 'รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์',      type: 'auto',     roles: REPORT_ROLES_WEEKLY_USAGE },
  { key: 'carStatus',           label: 'สถานะรถ (ตอบสดตอนกดปุ่ม Rich Menu)',        type: 'ondemand', roles: ONDEMAND_ROLES_CAR_STATUS },
  { key: 'myScheduleOverview',  label: 'ตารางงานของฉัน — ภาพรวม (ตอบสดตอนกดปุ่ม Rich Menu)', type: 'ondemand', roles: ONDEMAND_ROLES_MY_SCHEDULE },
  { key: 'checkReminder',       label: 'แจ้งเตือน พขร. ตรวจสภาพรถ (เฉพาะคันที่ยังไม่ตรวจ)', type: 'auto', roles: REPORT_ROLES_CHECK_REMINDER }
];

/** buildLineMessageByKey_ — สร้างเนื้อหาข้อความจริงตาม key (ใช้ฟังก์ชัน build อันเดิมที่มีอยู่แล้วในระบบทุกจุด ไม่มีโค้ดซ้ำ) */
function buildLineMessageByKey_(key) {
  var t = buildLineMessageByKeyRaw_(key);
  return t == null ? null : lineWrapText_(t); // ✅ NEW: พรีวิว/ทดสอบ/ส่งซ้ำ ได้ข้อความจัดบรรทัดแล้ว เหมือนที่ผู้รับเห็นจริง
}
function buildLineMessageByKeyRaw_(key) {
  switch (key) {
    case 'dailyCheck':          return buildDailyCheckReport_().lineText;
    case 'workSchedule':        return buildDailyWorkScheduleReport_().lineText;
    case 'weeklyUsage':         return buildWeeklyUsageFuelReport_().lineText;
    case 'checkReminder':       return buildCheckReminder_().lineText;
    case 'carStatus':           return buildCarStatusReplyText_();
    case 'myScheduleOverview':  return buildScheduleOverviewReplyText_();
    default: return null;
  }
}

/** getLineMessageCatalog — รายการข้อความทั้งหมดที่ระบบส่งได้ (สำหรับแท็บ "ทดสอบส่งข้อความ" ในหน้า linecontrol.html) */
function getLineMessageCatalog() {
  // ✅ FINAL: เพิ่ม recipientCount (จำนวนผู้รับที่ตรงบทบาท ณ ตอนนี้) — linecontrol.html ใช้แสดงจำนวนผู้รับและเปิด/ปิดปุ่ม "ส่งจริงอีกครั้ง"
  var items = LINE_MESSAGE_CATALOG_.map(function (c) {
    return { key: c.key, label: c.label, type: c.type, roles: c.roles, recipientCount: getLineUserIdsForKey_(c.key, c.roles).length };
  });
  return { status: 'ok', items: items };
}

/** testSendLineMessageByKey — ทดสอบส่งข้อความจริง 1 ฉบับ ไปยัง "แอดมิน" ทุกคนที่ลงทะเบียนไว้ (ต้องรหัสแอดมิน)
 *  ✅ ส่งไปหาแอดมินโดยอัตโนมัติผ่านระบบบทบาทในชีท LineUsers — ไม่ต้องตั้งค่า userId ทดสอบเองอีกต่อไป
 *  ⚠️ นี่คือการส่งจริงผ่าน LINE push API เสียโควต้าข้อความ 1 ครั้ง/คน/การกดทดสอบ 1 ครั้ง (ไม่ใช่แค่ preview)
 *  payload: { key, adminCode, clientIp } */
function testSendLineMessageByKey(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var text = buildLineMessageByKey_(payload && payload.key);
  if (text == null) return { status: 'error', message: 'ไม่พบข้อความนี้ในระบบ' };

  var adminIds = getLineUserIdsByRoles_([LINE_ROLE_ADMIN]);
  // รองรับย้อนหลัง: ถ้ายังไม่มีแอดมินลงทะเบียนเลย ใช้ "userId ทดสอบ" แบบเดิมที่เคยตั้งไว้ (ถ้ามี) แทน
  if (!adminIds.length) {
    var legacyTestUserId = SCRIPT_PROPS_.getProperty(LINE_TEST_USER_ID_PROP) || '';
    if (legacyTestUserId) adminIds = [legacyTestUserId];
  }
  if (!adminIds.length) {
    return { status: 'error', message: 'ยังไม่มีแอดมินลงทะเบียนรับ LINE เลย (ต้องทักแชทเข้าบอทอย่างน้อย 1 ครั้ง แล้วตั้งบทบาทเป็น "แอดมิน" ที่แท็บ "ผู้รับข้อความ" ก่อน)' };
  }

  var successCount = 0, lastError = '';
  var _cat = lineCatalogItem_(payload && payload.key);
  lineLogRun_({ trigger: 'test', key: String(payload.key), label: _cat ? _cat.label : '', roles: [LINE_ROLE_ADMIN], by: 'แอดมิน' }, function () {
    adminIds.forEach(function (uid) {
      var res = linePush_(uid, [{ type: 'text', text: text }]);
      var ok  = !!res && res.getResponseCode() < 300;
      if (ok) successCount++;
      else lastError = res ? res.getContentText() : 'ไม่ทราบสาเหตุ — ตรวจสอบ token/userId';
    });
  });
  var allOk = successCount === adminIds.length;
  logApiAccess_('testSendLine:' + (payload && payload.key), String((payload && payload.clientIp) || 'unknown'), allOk, '', '');
  return {
    status: successCount > 0 ? 'ok' : 'error',
    message: successCount > 0
      ? ('ส่งสำเร็จไปยังแอดมิน ' + successCount + '/' + adminIds.length + ' คนแล้ว (ใช้โควต้า LINE ' + successCount + ' ข้อความ)')
      : ('ส่งไม่สำเร็จ: ' + lastError),
    preview: text
  };
}

// ── 7.2b) ทดสอบส่ง "ทุกประเภท" ไปยังแอดมินในครั้งเดียว ──
/** sendAllTestMessagesToAdmin_ — สร้างข้อความจริงจากข้อมูลล่าสุดของทุก key ใน LINE_MESSAGE_CATALOG_ แล้วส่งไปหา "แอดมิน" เท่านั้น
 *  - หัวข้อความเติม "🧪 ทดสอบ n/N + ชื่อข้อความ" ให้รู้ว่าเป็นข้อความทดสอบ (รวมในข้อความเดียวกัน ไม่เปลืองโควต้าเพิ่ม)
 *  - ⚠️ ใช้โควต้า LINE จริง: (จำนวนข้อความของทุกชุด) × (จำนวนแอดมิน) · บันทึกลงประวัติการส่งเป็น trigger = test
 *  - ชุดไหนสร้าง/ส่งไม่สำเร็จจะไม่ทำให้ชุดอื่นหยุด (สรุปผลรายชุดใน items) */
function sendAllTestMessagesToAdmin_() {
  var adminIds = getLineUserIdsByRoles_([LINE_ROLE_ADMIN]);
  if (!adminIds.length) {
    var legacy = SCRIPT_PROPS_.getProperty(LINE_TEST_USER_ID_PROP) || '';
    if (legacy) adminIds = [legacy];
  }
  if (!adminIds.length) {
    return { status: 'error', message: 'ยังไม่มีแอดมินลงทะเบียนรับ LINE เลย (ต้องทักแชทเข้าบอทอย่างน้อย 1 ครั้ง แล้วตั้งบทบาทเป็น "แอดมิน" ที่แท็บ "ผู้รับข้อความ" ก่อน)' };
  }
  var total = LINE_MESSAGE_CATALOG_.length, items = [], okSets = 0, quota = 0;
  LINE_MESSAGE_CATALOG_.forEach(function (c, idx) {
    var row = { key: c.key, label: c.label, ok: false, error: '' };
    try {
      var text = buildLineMessageByKey_(c.key);
      if (text == null) throw new Error('สร้างข้อความไม่ได้');
      var head = '🧪 ทดสอบ ' + (idx + 1) + '/' + total + '\n' + c.label + '\n' + REPORT_DIVIDER_ + '\n';
      var messages = splitLineText_(head + text, 4500).slice(0, 5).map(function (t) { return { type: 'text', text: t }; });
      var okCount = 0, lastError = '';
      lineLogRun_({ trigger: 'test', key: c.key, label: c.label, roles: [LINE_ROLE_ADMIN], by: 'แอดมิน' }, function () {
        adminIds.forEach(function (uid) {
          var res = linePush_(uid, messages);
          if (res && res.getResponseCode() < 300) okCount++;
          else lastError = res ? String(res.getContentText() || '').slice(0, 200) : 'ไม่ทราบสาเหตุ — ตรวจสอบ token/userId';
        });
      });
      row.ok = okCount === adminIds.length;
      row.error = row.ok ? '' : (lastError || 'ส่งไม่ครบทุกคน');
      quota += okCount * messages.length;
    } catch (e) {
      row.error = String(e && e.message || e);
    }
    if (row.ok) okSets++;
    items.push(row);
    if (idx < total - 1) Utilities.sleep(400); // เว้นจังหวะเล็กน้อย กัน rate limit
  });
  return {
    status: okSets > 0 ? 'ok' : 'error',
    message: 'ส่งทดสอบสำเร็จ ' + okSets + '/' + total + ' ชุด ไปยังแอดมิน ' + adminIds.length + ' คน (ใช้โควต้า LINE ประมาณ ' + quota + ' ข้อความ)',
    items: items
  };
}

/** testSendAllLineMessagesToAdmin — เรียกจากหน้า linecontrol.html (ต้องรหัสแอดมิน) payload: { adminCode, clientIp } */
function testSendAllLineMessagesToAdmin(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };
  var res = sendAllTestMessagesToAdmin_();
  logApiAccess_('testSendAllLine', String((payload && payload.clientIp) || 'unknown'), res.status === 'ok', '', '');
  return res;
}

/** testSendAllToAdmin — กด Run จาก Apps Script Editor ได้ตรงๆ (ไม่ต้องใช้รหัสแอดมิน) เพื่อทดสอบส่งทุกประเภทไปหาแอดมิน */
function testSendAllToAdmin() {
  var res = sendAllTestMessagesToAdmin_();
  console.log(JSON.stringify(res));
  return res;
}

// ── 7.3) ควบคุมภาพรวมผู้รับ — เปิด/ปิดการรับข้อความอัตโนมัติเป็นรายคน (ไม่กระทบบทบาทที่ตั้งไว้) ──
/** getLineUsersForAdmin — รายชื่อผู้ใช้ LINE ทั้งหมดในชีท LineUsers + บทบาท + สถานะเปิด/ปิดรับข้อความ
 *  (สำหรับแท็บ "ควบคุมผู้รับ" ในหน้า linecontrol.html) */
function getLineUsersForAdmin() {
  var sheet = getOrCreateLineUsersSheet_();
  if (sheet.getLastRow() <= 1) return { status: 'ok', items: [] };
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
  var items = data.map(function (r) {
    return {
      userId: String(r[0] || '').trim(),
      displayName: String(r[1] || ''),
      registeredAt: String(r[2] || ''),
      status: String(r[3] || ''),
      role: String(r[5] || ''),
      phone: String(r[6] || ''),
      enabled: String(r[7] || '').trim().toUpperCase() !== 'FALSE' // ค่าว่าง/ยังไม่เคยตั้ง = เปิดรับ (default true)
    };
  }).filter(function (it) { return it.userId; });
  return { status: 'ok', items: items };
}

/** setLineUserEnabled — เปิด/ปิดการรับข้อความอัตโนมัติของ userId นี้ (ไม่กระทบบทบาทที่ตั้งไว้) ต้องรหัสแอดมิน
 *  payload: { userId, enabled, adminCode, clientIp } */
function setLineUserEnabled(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var userId = String((payload && payload.userId) || '').trim();
  if (!userId) return { status: 'error', message: 'ไม่พบ userId' };

  var sheet  = getOrCreateLineUsersSheet_();
  var colIdx = ensureExtraColumn(sheet, LINE_ENABLED_COL_NAME_) + 1; // 1-based
  var data   = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      sheet.getRange(i + 1, colIdx).setValue(payload.enabled ? 'TRUE' : 'FALSE');
      logApiAccess_('setLineUserEnabled:' + userId + ':' + (payload.enabled ? 'ON' : 'OFF'), String(payload.clientIp || 'unknown'), true, '', '');
      return { status: 'ok' };
    }
  }
  return { status: 'error', message: 'ไม่พบผู้ใช้นี้ในชีท LineUsers' };
}

// ── 7.4) บัญชี LINE สำรอง — สลับไปใช้อีก channel token เมื่อบัญชีหลัก token/โควต้าหมด ──
/** getLineQuotaInfo_ — ดึงโควต้าข้อความ LINE เดือนนี้ (limit + used) จาก LINE API ของ token ที่ระบุ */
function getLineQuotaInfo_(token) {
  if (!token) return { available: false };
  try {
    var qRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota', {
      method: 'get', headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true
    });
    var cRes = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/quota/consumption', {
      method: 'get', headers: { 'Authorization': 'Bearer ' + token }, muteHttpExceptions: true
    });
    var q = qRes.getResponseCode() < 300 ? JSON.parse(qRes.getContentText()) : {};
    var c = cRes.getResponseCode() < 300 ? JSON.parse(cRes.getContentText()) : {};
    return {
      available: true,
      type:  q.type || '',                                              // 'none' = แพ็กเกจฟรี (จำกัดโควต้า), 'limited' = ตั้งเพดานเอง
      limit: (typeof q.value === 'number') ? q.value : null,             // null = ไม่จำกัด (บางแพ็กเกจเสียเงิน)
      used:  (typeof c.totalUsage === 'number') ? c.totalUsage : null
    };
  } catch (err) {
    console.warn('getLineQuotaInfo_:', err.message);
    return { available: false, error: err.message };
  }
}

/** getLineChannelStatus — สถานะช่องทางหลัก/สำรอง + โควต้าคงเหลือของช่องที่ใช้งานอยู่จริง (สำหรับแท็บ "บัญชี LINE") */
function getLineChannelStatus() {
  var active = getActiveLineChannel_();
  return {
    status: 'ok',
    active: active,
    primaryConfigured: !!LINE_CHANNEL_ACCESS_TOKEN,
    backupConfigured:  !!LINE_CHANNEL_ACCESS_TOKEN_BACKUP,
    testUserId: SCRIPT_PROPS_.getProperty(LINE_TEST_USER_ID_PROP) || '',
    quota: getLineQuotaInfo_(getActiveLineToken_())
  };
}

/** switchLineChannel — สลับช่องทางหลัก/สำรอง (ต้องรหัสแอดมิน) payload:{ target:'primary'|'backup', adminCode, clientIp } */
function switchLineChannel(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var target = (payload && payload.target) || '';
  if (target !== 'primary' && target !== 'backup') {
    return { status: 'error', message: 'ระบุช่องทางไม่ถูกต้อง (ต้องเป็น primary หรือ backup)' };
  }
  if (target === 'backup' && !LINE_CHANNEL_ACCESS_TOKEN_BACKUP) {
    return { status: 'error', message: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN_BACKUP ใน Script Properties — เพิ่ม Channel access token ของบัญชีสำรองก่อน' };
  }
  if (target === 'primary' && !LINE_CHANNEL_ACCESS_TOKEN) {
    return { status: 'error', message: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN (บัญชีหลัก) ใน Script Properties' };
  }

  SCRIPT_PROPS_.setProperty(LINE_ACTIVE_CHANNEL_PROP, target);
  logApiAccess_('switchLineChannel:' + target, String((payload && payload.clientIp) || 'unknown'), true, '', '');
  return { status: 'ok', active: target };
}

/** saveLineTestUserId — บันทึก userId ที่ใช้รับข้อความทดสอบ (ต้องรหัสแอดมิน) payload:{ userId, adminCode, clientIp } */
function saveLineTestUserId(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var uid = String((payload && payload.userId) || '').trim();
  if (!uid) return { status: 'error', message: 'กรุณาระบุ userId' };

  SCRIPT_PROPS_.setProperty(LINE_TEST_USER_ID_PROP, uid);
  return { status: 'ok' };
}
