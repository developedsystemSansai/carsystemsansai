// ============================================================
//  REPORT SYSTEM — LINE Messaging API + Email
//  ระบบส่งออกรายงานอัตโนมัติ (✅ แก้ไข: แยกผู้รับตามบทบาทแล้ว ตามตารางสิทธิ์):
//    1) รายงานการตรวจสภาพรถประจำวัน            → จ-ศ 10:00 น. → แอดมิน + รองฯ (พขร. ไม่ต้องส่ง)
//    2) ตารางงานประจำวัน (NEW)                  → จ-ศ 07:30 น. → รองฯ + พขร. (แอดมิน ไม่ต้องส่ง)
//    3) รายงานการใช้งานรถ + เติมน้ำมันประจำสัปดาห์ → ทุกวันศุกร์ 15:30 น. → แอดมิน + รองฯ (พขร. ไม่ต้องส่ง)
//    (สถานว่าง/สถานะรถ → ไม่มีการ push อัตโนมัติ — ตอบสด real-time เฉพาะตอนกดปุ่มบน Rich Menu (แอดมิน/รองฯ/พขร.))
//    (ตารางงานของฉัน (NEW) → ไม่มีการ push อัตโนมัติ — ตอบสดเป็นภาพรวมตารางงาน+เวรวันนี้ของทุกคน ตอนกดปุ่ม Rich Menu (แอดมิน/รองฯ/พขร.))
//
//  วิธีติดตั้ง (ทำครั้งเดียว):
//   1. Apps Script Editor → Project Settings → Script Properties เพิ่ม:
//        LINE_CHANNEL_ACCESS_TOKEN = <Channel access token (long-lived) จาก LINE Developers Console>
//        REPORT_EMAILS             = jantagorn@gmail.com,noppadol.ri@sansaihospital.go.th
//      (ค่า default ของ REPORT_EMAILS ถูกตั้งไว้ในโค้ดแล้ว ถ้าไม่ตั้ง Script Property ก็ยังใช้งานได้
//       แต่แนะนำให้ตั้งไว้ใน Script Properties เพื่อแก้ไขอีเมลผู้รับได้โดยไม่ต้องแก้โค้ด)
//   2. ตรวจสอบ Project Settings → General settings → Time zone ต้องเป็น "(GMT+07:00) Bangkok"
//   3. Deploy เว็บแอปนี้ใหม่ (New deployment) แล้วนำ URL ไปวางที่ Webhook URL ใน LINE Developers Console
//      (ถ้าใช้ URL เดิมที่ผูกกับ deployment เดิมอยู่แล้ว ไม่ต้องทำอะไรเพิ่ม — โค้ดนี้ตรวจจับ LINE event
//       จาก body ที่ส่งเข้ามาเอง ไม่ชนกับ API เดิมของระบบ)
//   4. กด "Verify" ที่หน้า Webhook settings ใน LINE Developers Console ให้ขึ้นสถานะ Success
//   5. ให้ผู้รับรายงานทั้งหมดสแกน QR/แอดไลน์ @382sjrlm แล้วพิมพ์ทักไปข้อความอะไรก็ได้ 1 ครั้ง
//      → ระบบจะบันทึก userId ลงชีท "LineUsers" อัตโนมัติ และตอบกลับยืนยันการลงทะเบียน
//   6. ✅ NEW ขั้นตอนสำคัญ: เปิดชีท "LineUsers" แล้วกรอกคอลัมน์ "บทบาท" (แอดมิน/รองฯ/พขร.) ของแต่ละคนเอง
//      (คอลัมน์ "เบอร์โทร (พขร.)" ไม่จำเป็นแล้ว — ปุ่ม "ตารางงานของฉัน" ใช้แค่บทบาทที่ตั้งไว้ ไม่ต้องผูกเบอร์โทร)
//      ใครยังไม่ตั้งบทบาทจะไม่ได้รับรายงานอัตโนมัติใดๆ เลย และกดปุ่ม Rich Menu ไม่ได้จนกว่าจะตั้งบทบาท
//      ใช้ testLineUserRoles ใน Apps Script Editor เพื่อดูรายชื่อ+บทบาทที่ตั้งไว้ทั้งหมด
//   7. เปิดฟังก์ชัน setupReportTriggers ใน Apps Script Editor แล้วกด Run (ครั้งเดียว)
//      → จะสร้าง time-driven trigger ให้ทั้ง 3 รายงานส่งอัตโนมัติตามเวลาที่กำหนด
//   8. ทดสอบได้ทันทีโดยไม่ต้องรอถึงเวลา: เลือกฟังก์ชัน testSendDailyReport / testSendDailyWorkScheduleReport /
//      testSendWeeklyReport / testCarStatusReply / testScheduleOverviewReply แล้วกด Run จาก Apps Script Editor
//   9. ✅ NEW ปุ่มบน Rich Menu (2 ปุ่ม) ที่คุณสร้างไว้แล้ว: ไปที่ LINE Official Account Manager → Rich menu →
//      ปุ่ม "สถานะรถ" ตั้ง action เป็น Postback data = "action=carstatus" (หรือข้อความ "สถานะรถ")
//      ปุ่ม "ตารางงานของฉัน" ตั้ง action เป็น Postback data = "action=myschedule" (หรือข้อความ "ตารางงานของฉัน")
//      — ถ้าตั้งเป็นค่าอื่น ให้แก้ CAR_STATUS_POSTBACK_DATA_/CAR_STATUS_TRIGGER_TEXTS_ หรือ
//      MY_SCHEDULE_POSTBACK_DATA_/MY_SCHEDULE_TRIGGER_TEXTS_ ในโค้ดให้ตรงกัน
//
//  ⚠️ ความปลอดภัย: Channel access token / Channel secret ที่เคยแปะไว้ในแชทควรกด "Reissue" ที่หน้า
//     LINE Developers Console เพื่อออก token ใหม่ ก่อนนำไปตั้งค่าจริงใน Script Properties
// ============================================================

// ── CONFIG (Script Properties) ──────────────────────────────
const LINE_CHANNEL_ACCESS_TOKEN = SCRIPT_PROPS_.getProperty('LINE_CHANNEL_ACCESS_TOKEN') || '';
// ✅ NEW: บัญชีสำรอง — ใช้เมื่อบัญชีหลัก token/โควต้าหมด (ตั้งค่า Script Property: LINE_CHANNEL_ACCESS_TOKEN_BACKUP)
const LINE_CHANNEL_ACCESS_TOKEN_BACKUP = SCRIPT_PROPS_.getProperty('LINE_CHANNEL_ACCESS_TOKEN_BACKUP') || '';
const LINE_ACTIVE_CHANNEL_PROP = 'LINE_ACTIVE_CHANNEL'; // script property: 'primary' | 'backup' (default 'primary')
const LINE_TEST_USER_ID_PROP   = 'LINE_TEST_USER_ID';   // script property: userId ที่ใช้รับข้อความทดสอบจาก linecontrol.html
const REPORT_EMAILS_RAW         = SCRIPT_PROPS_.getProperty('REPORT_EMAILS')
  || 'jantagorn@gmail.com,noppadol.ri@sansaihospital.go.th';
const REPORT_EMAILS = REPORT_EMAILS_RAW.split(',').map(function (s) { return s.trim(); }).filter(Boolean);

const SHEET_LINE_USERS   = 'LineUsers';
const LINE_USERS_HEADERS = ['UserId', 'DisplayName', 'ลงทะเบียนเมื่อ', 'สถานะ', 'ข้อความล่าสุดเมื่อ', 'บทบาท', 'เบอร์โทร (พขร.)'];
const LINE_ENABLED_COL_NAME_ = 'เปิดรับข้อความ'; // ✅ NEW: คอลัมน์เปิด/ปิดการรับข้อความอัตโนมัติเป็นรายคน ควบคุมจาก linecontrol.html (TRUE/FALSE, ค่าว่าง = เปิดโดยค่าเริ่มต้น)

// ✅ NEW: บทบาทผู้รับรายงาน LINE — ต้องตรงกับตาราง "แอดมิน / รองฯ / พขร(10)"
//    แอดมินตั้งค่าคอลัมน์ "บทบาท" เองในชีท LineUsers หลังจากผู้ใช้แอดไลน์เข้ามา (ค่าว่าง = ยังไม่ได้กำหนดบทบาท → จะไม่ได้รับรายงานอัตโนมัติใดๆ จนกว่าจะตั้งค่า)
const LINE_ROLE_ADMIN  = 'แอดมิน';
const LINE_ROLE_DEPUTY = 'รองฯ';
const LINE_ROLE_DRIVER = 'พขร';
const LINE_ROLE_VALUES_ = [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY, LINE_ROLE_DRIVER];

// ── ตารางสิทธิ์รับรายงานอัตโนมัติทาง LINE (อ้างอิงตารางที่ตกลงกันไว้) ──────────────
//   รายงานตรวจรถ (รายวัน)          → แอดมิน + รองฯ  (พขร. ไม่ต้องส่ง)
//   ตารางงานประจำวัน                → รองฯ + พขร.    (แอดมิน ไม่ต้องส่ง)
//   รายงานใช้รถ/น้ำมันประจำสัปดาห์    → แอดมิน + รองฯ  (พขร. ไม่ต้องส่ง)
//   สถานว่าง (สถานะรถ)              → ไม่ส่งอัตโนมัติ ดูได้เฉพาะตอนกดรีเฟรชเมนูเอง (ไม่ใช่ push)
const REPORT_ROLES_DAILY_CHECK    = [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY];
const REPORT_ROLES_WORK_SCHEDULE  = [LINE_ROLE_DEPUTY, LINE_ROLE_DRIVER];
const REPORT_ROLES_WEEKLY_USAGE   = [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY];
const ONDEMAND_ROLES_CAR_STATUS   = [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY, LINE_ROLE_DRIVER];
const ONDEMAND_ROLES_MY_SCHEDULE  = [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY, LINE_ROLE_DRIVER];
const REPORT_ROLES_CHECK_REMINDER = [LINE_ROLE_DRIVER]; // ✅ NEW: แจ้งเตือนตรวจสภาพรถ → พขร. เท่านั้น (ไม่ส่งแอดมิน/รองฯ/อีเมล)

// ✅ NEW: ยกเว้นรายคนสำหรับ "แจ้งเตือน พขร. ตรวจสภาพรถ" (นพดล — รองฯ รพ.สันทราย ไม่ต้องรับ/ไม่ต้องรายงาน)
//  - NAMES       : ตัดผู้รับที่ DisplayName (คอลัมน์ B ชีท LineUsers) มีข้อความนี้อยู่
//  - USER_IDS    : ระบุ LINE userId ตรงๆ (แม่นกว่า ถ้า DisplayName เป็นชื่อเล่น/อังกฤษ)
//  - RESPONSIBLE : ไม่นับรถที่ "ผู้รับผิดชอบ" (ชีทรถ) มีชื่อนี้ ว่าเป็นคันที่ยังไม่ตรวจ
const LINE_REMINDER_EXCLUDE_NAMES_       = ['นพดล'];
const LINE_REMINDER_EXCLUDE_USER_IDS_    = [];
const LINE_REMINDER_EXCLUDE_RESPONSIBLE_ = ['นพดล'];

// ── Rich Menu: ปุ่ม "สถานะรถ" — ตอบสด (ไม่ push) ตอนมีคนกดปุ่มบน Rich Menu ────────
// ⚠️ ต้องตั้งค่า 2 ค่านี้ให้ตรงกับ Rich Menu ที่สร้างไว้จริงใน LINE Official Account Manager:
//    - ถ้าปุ่มตั้งเป็น action แบบ "Postback" → ใส่ค่า data ให้ตรงกับ CAR_STATUS_POSTBACK_DATA_
//    - ถ้าปุ่มตั้งเป็น action แบบ "ข้อความ" (message)  → ใส่ข้อความให้ตรงกับ CAR_STATUS_TRIGGER_TEXTS_ (ตรงตัวเป๊ะ)
//    ระบบเช็คทั้ง 2 แบบพร้อมกัน แบบไหนตรงก็ตอบกลับ
var CAR_STATUS_POSTBACK_DATA_  = 'action=carstatus';
var CAR_STATUS_TRIGGER_TEXTS_  = ['สถานะรถ', 'สถานะรถว่าง', 'เช็คสถานะรถ'];

// ── Rich Menu: ปุ่ม "ตารางงานของฉัน" — ตอบสด (ไม่ push) เป็นภาพรวมตารางงาน+เวรวันนี้ของทุกคน ─────
// ✅ ทุกบทบาทที่กด (แอดมิน/รองฯ/พขร.) ใช้แค่บทบาทที่ตั้งไว้ในชีท LineUsers ไม่ต้องผูกเบอร์โทรอีกต่อไป
var MY_SCHEDULE_POSTBACK_DATA_ = 'action=myschedule';
var MY_SCHEDULE_TRIGGER_TEXTS_ = ['ตารางงานของฉัน'];

// ════════════════════════════════════════════════════════════
//  1) LINE WEBHOOK — จดจำผู้ใช้ที่ทักเข้ามา (follow / message / unfollow)
// ════════════════════════════════════════════════════════════

function handleLineWebhookEvents_(events) {
  events.forEach(function (ev) {
    try {
      var userId = ev.source && ev.source.userId;
      if (!userId) return;

      // ── Rich Menu: ปุ่ม "สถานะรถ" (postback หรือ message action) ──────────────────
      // ✅ NEW: ตอบสถานะรถ ณ เวลาที่กด แบบ real-time (ไม่ใช่ push อัตโนมัติ) เฉพาะบทบาท แอดมิน/รองฯ/พขร. ตามตารางสิทธิ์
      if (ev.replyToken && isCarStatusTrigger_(ev)) {
        registerLineUser_(userId, getLineDisplayName_(userId)); // เผื่อยังไม่เคยทัก + อัปเดตเวลาใช้งานล่าสุด
        var csRole = getLineUserRole_(userId);
        if (ONDEMAND_ROLES_CAR_STATUS.indexOf(csRole) >= 0) {
          lineReply_(ev.replyToken, [{ type: 'text', text: buildCarStatusReplyText_() }], { trigger: 'richmenu', key: 'carStatus', label: 'สถานะรถ (ตอบสด Rich Menu)' });
        } else {
          lineReply_(ev.replyToken, [{ type: 'text', text: 'เมนูนี้สำหรับบทบาทแอดมิน/รองฯ/พขร. เท่านั้นครับ/ค่ะ\nดูสถานะรถแบบเต็มได้ที่ Dashboard:\n' + DASHBOARD_URL }], { trigger: 'richmenu', key: 'carStatus', label: 'ปฏิเสธสิทธิ์ — สถานะรถ (Rich Menu)' });
        }
        return;
      }

      // ── Rich Menu: ปุ่ม "ตารางงานของฉัน" (postback หรือ message action) ─────────────
      // ✅ NEW: ตอบภาพรวมตารางงาน+เวรวันนี้ของทุกคน (ไม่ผูกเบอร์โทร ใช้แค่บทบาทที่ตั้งไว้ในชีท LineUsers) เฉพาะบทบาท แอดมิน/รองฯ/พขร.
      if (ev.replyToken && isMyScheduleTrigger_(ev)) {
        registerLineUser_(userId, getLineDisplayName_(userId));
        var msRole = getLineUserRole_(userId);
        if (ONDEMAND_ROLES_MY_SCHEDULE.indexOf(msRole) >= 0) {
          // ✅ NEW: ทุกบทบาท (แอดมิน/รองฯ/พขร.) ไม่ต้องผูกเบอร์โทรอีกต่อไป — เช็คแค่บทบาทที่ตั้งไว้ในชีท LineUsers พอ
          //    ตอบกลับเป็น "ภาพรวมของทุกคน" (ใครอยู่เวรวันนี้ + ภารกิจทั้งหมดวันนี้) แทนเวรส่วนตัวของแต่ละคน
          var myReply = buildScheduleOverviewReplyText_();
          lineReply_(ev.replyToken, [{ type: 'text', text: myReply }], { trigger: 'richmenu', key: 'myScheduleOverview', label: 'ตารางงานของฉัน (ตอบสด Rich Menu)' });
        } else {
          lineReply_(ev.replyToken, [{ type: 'text', text: 'เมนูนี้สำหรับบทบาทแอดมิน/รองฯ/พขร. เท่านั้นครับ/ค่ะ' }], { trigger: 'richmenu', key: 'myScheduleOverview', label: 'ปฏิเสธสิทธิ์ — ตารางงานของฉัน (Rich Menu)' });
        }
        return;
      }

      if (ev.type === 'follow' || ev.type === 'message') {
        var displayName = getLineDisplayName_(userId);
        var isNew = registerLineUser_(userId, displayName);
        if (ev.replyToken) {
          var welcomeMsg = isNew
            ? '✅ ลงทะเบียนกับระบบรถโรงพยาบาลสันทรายเรียบร้อยแล้วครับ/ค่ะ\n\n⚠️ ขั้นตอนถัดไป: รอแอดมินกำหนด "บทบาท" ให้ในระบบ (แอดมิน/รองฯ/พขร.) ก่อน จึงจะเริ่มได้รับรายงานอัตโนมัติตามสิทธิ์ของแต่ละบทบาท'
            : '👋 สวัสดีครับ/ค่ะ คุณลงทะเบียนไว้แล้ว ระบบจะส่งรายงานให้ตามบทบาทที่แอดมินกำหนดไว้';
          lineReply_(ev.replyToken, [{ type: 'text', text: welcomeMsg }], { trigger: 'system', label: 'ข้อความต้อนรับ / ลงทะเบียน' });
        }
      } else if (ev.type === 'unfollow') {
        setLineUserStatus_(userId, 'ยกเลิก');
      }
    } catch (evErr) {
      console.error('handleLineWebhookEvents_ item error:', evErr);
    }
  });
}

function getOrCreateLineUsersSheet_() {
  var ss = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_LINE_USERS, LINE_USERS_HEADERS);
  // ✅ NEW: เผื่อชีท LineUsers ถูกสร้างไว้ก่อนเพิ่มคอลัมน์ "บทบาท"/"เบอร์โทร" — เพิ่มให้อัตโนมัติโดยไม่กระทบข้อมูลเดิม
  var roleColIdx = ensureExtraColumn(sheet, 'บทบาท'); // 0-based
  if (roleColIdx >= 0) {
    var roleCol = roleColIdx + 1;
    var lastRow = Math.max(sheet.getMaxRows(), 200);
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(LINE_ROLE_VALUES_, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, roleCol, lastRow - 1, 1).setDataValidation(rule);
  }
  // ✅ NEW: คอลัมน์เบอร์โทร — แอดมินกรอกเบอร์ พขร./รองฯ ให้ตรงกับเบอร์ในชีท "ตารางเวร" เพื่อให้ปุ่ม "ตารางงานของฉัน" รู้ว่าใครกด
  ensureExtraColumn(sheet, 'เบอร์โทร (พขร.)');
  // ✅ NEW: คอลัมน์เปิด/ปิดการรับข้อความอัตโนมัติรายบุคคล (ควบคุมจากหน้า linecontrol.html — ไม่กระทบบทบาท)
  ensureExtraColumn(sheet, LINE_ENABLED_COL_NAME_);
  return sheet;
}

/** getLineUserRole_ — คืนบทบาทที่แอดมินตั้งไว้ให้ userId นี้ในชีท LineUsers ('' ถ้ายังไม่ตั้ง) */
function getLineUserRole_(userId) {
  var sheet = getOrCreateLineUsersSheet_();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) return String(data[i][5] || '').trim();
  }
  return '';
}

/** getLineUserPhone_ — คืนเบอร์โทรที่แอดมินผูกไว้ให้ userId นี้ในชีท LineUsers ('' ถ้ายังไม่ตั้ง) */
function getLineUserPhone_(userId) {
  var sheet = getOrCreateLineUsersSheet_();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) return String(data[i][6] || '').trim();
  }
  return '';
}

/** getLineUserIdsByRoles_ — รายชื่อ userId ที่ active และบทบาท (คอลัมน์ "บทบาท" ที่แอดมินตั้งในชีท LineUsers)
 *  อยู่ใน roles ที่ระบุ ใช้แทน getActiveLineUserIds_() ทุกจุดที่ต้องส่งรายงานแยกตามบทบาท */
function getLineUserIdsByRoles_(roles) {
  var sheet = getOrCreateLineUsersSheet_();
  if (sheet.getLastRow() <= 1) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues(); // ✅ NEW: ขยายเป็น 8 คอลัมน์ เพื่ออ่านคอลัมน์ "เปิดรับข้อความ" (คอลัมน์ที่ 8) ด้วย
  return data.filter(function (r) {
    var status  = String(r[3]).trim();
    var role    = String(r[5]).trim();
    var enabled = String(r[7]).trim().toUpperCase() !== 'FALSE'; // ✅ NEW: ค่าว่าง/ยังไม่เคยตั้ง = เปิดรับ (default true) — ปิดเฉพาะตอนแอดมิน toggle เป็น FALSE เท่านั้น
    return status !== 'ยกเลิก' && enabled && roles.indexOf(role) >= 0;
  }).map(function (r) { return String(r[0]).trim(); })
    .filter(Boolean);
}

/** ✅ NEW: ผู้รับตามบทบาท แต่ตัดรายชื่อที่ยกเว้น — เงื่อนไขเดียวกับ getLineUserIdsByRoles_ ทุกประการ + ตัดตามชื่อ/userId */
function getLineUserIdsByRolesExcluding_(roles, excludeNames, excludeUserIds) {
  var sheet = getOrCreateLineUsersSheet_();
  if (sheet.getLastRow() <= 1) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues();
  return data.filter(function (r) {
    var uid     = String(r[0]).trim();
    var name    = String(r[1]).trim();
    var status  = String(r[3]).trim();
    var role    = String(r[5]).trim();
    var enabled = String(r[7]).trim().toUpperCase() !== 'FALSE';
    if (status === 'ยกเลิก' || !enabled || roles.indexOf(role) < 0) return false;
    if ((excludeUserIds || []).indexOf(uid) >= 0) return false;
    for (var k = 0; k < (excludeNames || []).length; k++) {
      if (excludeNames[k] && name.indexOf(excludeNames[k]) >= 0) return false;
    }
    return true;
  }).map(function (r) { return String(r[0]).trim(); })
    .filter(Boolean);
}

/** ✅ NEW: ผู้รับของข้อความหนึ่ง key — ใช้ทุกจุดที่ส่ง/นับผู้รับ (ส่งอัตโนมัติ, ส่งซ้ำ, ส่งซ้ำจากประวัติ, จำนวนผู้รับในหน้าควบคุม) เพื่อให้การยกเว้นตรงกันหมด */
function getLineUserIdsForKey_(key, roles) {
  if (key === 'checkReminder') return getLineUserIdsByRolesExcluding_(roles || [], LINE_REMINDER_EXCLUDE_NAMES_, LINE_REMINDER_EXCLUDE_USER_IDS_);
  return getLineUserIdsByRoles_(roles || []);
}

/** registerLineUser_ — เพิ่ม/อัปเดตผู้ใช้ LINE ที่ทักเข้ามา คืนค่า true ถ้าเป็นผู้ใช้ใหม่ */
function registerLineUser_(userId, displayName) {
  var sheet = getOrCreateLineUsersSheet_();
  var data  = sheet.getDataRange().getValues();
  var now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      sheet.getRange(i + 1, 2).setValue(displayName || data[i][1] || '');
      sheet.getRange(i + 1, 4).setValue('active');
      sheet.getRange(i + 1, 5).setValue(now);
      return false; // ผู้ใช้เดิม
    }
  }
  sheet.appendRow([userId, displayName || '', now, 'active', now]);
  return true; // ผู้ใช้ใหม่
}

function setLineUserStatus_(userId, status) {
  var sheet = getOrCreateLineUsersSheet_();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      sheet.getRange(i + 1, 4).setValue(status);
      return;
    }
  }
}

/** getActiveLineUserIds_ — รายชื่อ userId ที่ยัง active (ใช้เป็นผู้รับ push/multicast) */
function getActiveLineUserIds_() {
  var sheet = getOrCreateLineUsersSheet_();
  if (sheet.getLastRow() <= 1) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  return data.filter(function (r) { return String(r[3]).trim() !== 'ยกเลิก'; })
             .map(function (r) { return String(r[0]).trim(); })
             .filter(Boolean);
}

function getLineDisplayName_(userId) {
  var _token = getActiveLineToken_(); // ✅ NEW: ใช้ token ของช่องทางที่กำลังใช้งานอยู่
  if (!_token) return '';
  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/profile/' + encodeURIComponent(userId), {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + _token },
      muteHttpExceptions: true
    });
    var json = JSON.parse(res.getContentText() || '{}');
    return json.displayName || '';
  } catch (err) {
    console.warn('getLineDisplayName_:', err.message);
    return '';
  }
}

/** isCarStatusTrigger_ — เช็คว่า event นี้มาจากการกดปุ่ม "สถานะรถ" บน Rich Menu หรือไม่
 *  รองรับทั้ง action แบบ postback (data ตรงกับ CAR_STATUS_POSTBACK_DATA_)
 *  และแบบข้อความ (message action ที่ส่งข้อความตรงกับ CAR_STATUS_TRIGGER_TEXTS_) */
function isCarStatusTrigger_(ev) {
  if (ev.type === 'postback') {
    return String((ev.postback && ev.postback.data) || '').trim() === CAR_STATUS_POSTBACK_DATA_;
  }
  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    var text = String(ev.message.text || '').trim();
    return CAR_STATUS_TRIGGER_TEXTS_.indexOf(text) >= 0;
  }
  return false;
}

/** isMyScheduleTrigger_ — เช็คว่า event นี้มาจากการกดปุ่ม "ตารางงานของฉัน" บน Rich Menu หรือไม่ (postback หรือข้อความ) */
function isMyScheduleTrigger_(ev) {
  if (ev.type === 'postback') {
    return String((ev.postback && ev.postback.data) || '').trim() === MY_SCHEDULE_POSTBACK_DATA_;
  }
  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    var text = String(ev.message.text || '').trim();
    return MY_SCHEDULE_TRIGGER_TEXTS_.indexOf(text) >= 0;
  }
  return false;
}

/** buildCarStatusReplyText_ — สรุปสถานะรถทุกคัน ณ เวลาปัจจุบัน (real-time reply ตอนกด Rich Menu เท่านั้น ไม่ใช่ push)
 *  ใช้ 4 สถานะมาตรฐานของระบบ: พร้อมใช้งาน / กำลังใช้งาน / รอตรวจสภาพรถ / รอซ่อม
 *  รถที่อยู่ใน MILE_GAP_EXCLUDE_PLATES (เช่น รถผู้บริหาร) จะไม่แสดงในรายการนี้ */
function buildCarStatusReplyText_() {
  var nowThai = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  var vehiclesRes = getVehicles();
  var vehicles = ((vehiclesRes && vehiclesRes.data) || [])
    .filter(function (v) { return !isExcludedVehiclePlate_(v['ทะเบียน']); });

  var groups = { 'พร้อมใช้งาน': [], 'กำลังใช้งาน': [], 'รอตรวจสภาพรถ': [], 'รอซ่อม': [] };
  vehicles.forEach(function (v) {
    var st = String(v['สถานะ'] || 'พร้อมใช้งาน').trim();
    if (!groups[st]) groups[st] = [];
    groups[st].push(v);
  });

  var lines = [];
  lines.push(tpl_('carStatus', 'header', { nowThai: nowThai }));
  lines.push(REPORT_DIVIDER_);

  lines.push('');
  lines.push(tpl_('carStatus', 'readySectionTitle', { count: groups['พร้อมใช้งาน'].length }));
  groups['พร้อมใช้งาน'].forEach(function (v) {
    lines.push(tpl_('carStatus', 'readyItem', { plate: v['ทะเบียน'] || '', type: v['ประเภท'] || '' }));
  });

  lines.push('');
  lines.push(tpl_('carStatus', 'inUseSectionTitle', { count: groups['กำลังใช้งาน'].length }));
  groups['กำลังใช้งาน'].forEach(function (v) {
    lines.push(tpl_('carStatus', 'inUseItem', {
      plate: v['ทะเบียน'] || '', driver: v['ผู้ขับปัจจุบัน'] || 'ไม่ระบุ',
      destPart: v['ปลายทาง'] ? ('\n     📍 ' + v['ปลายทาง']) : ''
    }));
  });

  if (groups['รอตรวจสภาพรถ'].length > 0) {
    lines.push('');
    lines.push(tpl_('carStatus', 'waitingCheckSectionTitle', { count: groups['รอตรวจสภาพรถ'].length }));
    groups['รอตรวจสภาพรถ'].forEach(function (v) {
      lines.push(tpl_('carStatus', 'waitingCheckItem', { plate: v['ทะเบียน'] || '', type: v['ประเภท'] || '' }));
    });
  }

  if (groups['รอซ่อม'].length > 0) {
    lines.push('');
    lines.push(tpl_('carStatus', 'waitingRepairSectionTitle', { count: groups['รอซ่อม'].length }));
    groups['รอซ่อม'].forEach(function (v) {
      lines.push(tpl_('carStatus', 'waitingRepairItem', { plate: v['ทะเบียน'] || '', type: v['ประเภท'] || '' }));
    });
  }

  lines.push('');
  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('carStatus', 'footer', { dashboardUrl: DASHBOARD_URL }));

  return lines.join('\n');
}

/** buildMyScheduleReplyText_ — สรุปเวร+ภารกิจ "ของตัวเอง" เท่านั้น ณ วันนี้ (real-time reply ตอนกด Rich Menu เท่านั้น ไม่ใช่ push)
 *  ผูกตัวตนด้วยเบอร์โทรที่แอดมินตั้งไว้ในชีท LineUsers (คอลัมน์ "เบอร์โทร (พขร.)") เทียบกับเบอร์ในชีท "ตารางเวร" */
function buildMyScheduleReplyText_(userId) {
  var phone = normalizePhone_(getLineUserPhone_(userId));
  if (!phone) {
    return '⚠️ ยังไม่ได้ผูกเบอร์โทรกับบัญชี LINE นี้ กรุณาแจ้งแอดมินให้กรอกเบอร์โทรในชีท "LineUsers" (คอลัมน์ "เบอร์โทร (พขร.)") ก่อนครับ/ค่ะ';
  }
  return buildMyScheduleReplyByPhone_(phone);
}

/** buildMyScheduleReplyByPhone_ — โค้ดหลักของ "ตารางงานของฉัน" แยกออกมาให้เรียกทดสอบตรงได้ด้วยเบอร์โทร (testMyScheduleReply) */
function buildMyScheduleReplyByPhone_(phone) {
  phone = normalizePhone_(phone);
  var sched = getWorktableSchedule();
  if (sched.status !== 'ok') {
    return 'ไม่สามารถดึงตารางเวรได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';
  }

  var me = (sched.data || []).filter(function (s) { return normalizePhone_(s.phone) === phone; })[0];
  if (!me) {
    return '⚠️ ไม่พบชื่อที่ตรงกับเบอร์โทรนี้ในตารางเวร กรุณาตรวจสอบเบอร์โทรกับแอดมินอีกครั้งครับ/ค่ะ';
  }

  var today     = new Date();
  var day       = String(today.getDate());
  var todayThai = Utilities.formatDate(today, 'Asia/Bangkok', 'dd/MM/yyyy');
  var todayYmd  = Utilities.formatDate(today, 'Asia/Bangkok', 'yyyy-MM-dd');
  var myShiftRaw = me.schedule[day];
  var myShift    = (myShiftRaw === undefined || myShiftRaw === '' || myShiftRaw === '0')
    ? 'ว่าง (ไม่มีเวร)' : myShiftRaw;

  var jobsRes = getJobAssignments({});
  var myJobs = ((jobsRes && jobsRes.data) || []).filter(function (j) {
    if (j.date !== todayYmd) return false;
    var nameHit  = j.driver && j.driver.indexOf(me.name) >= 0;
    var nickHit  = me.nick && j.driver && j.driver.indexOf(me.nick) >= 0;
    var ownerHit = j.shiftOwner && (j.shiftOwner.indexOf(me.name) >= 0 || (me.nick && j.shiftOwner.indexOf(me.nick) >= 0));
    return nameHit || nickHit || ownerHit;
  });
  myJobs.sort(function (a, b) { return String(a.timeOut || '').localeCompare(String(b.timeOut || '')); });

  var lines = [];
  lines.push('🧑‍✈️ ตารางงานของฉัน');
  lines.push('👤 ' + me.name + (me.nick ? ' (' + me.nick + ')' : ''));
  lines.push('📅 วันที่ ' + todayThai);
  lines.push('🕒 เวรวันนี้: ' + myShift);
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  if (myJobs.length === 0) {
    lines.push('วันนี้ยังไม่มีภารกิจที่มอบหมายให้คุณ');
  } else {
    lines.push('📋 ภารกิจของคุณวันนี้ (' + myJobs.length + ' รายการ)');
    lines.push('');
    myJobs.forEach(function (j, i) {
      lines.push((i + 1) + '. ⏰ ' + (j.timeOut || '-') + (j.timeBack ? '–' + j.timeBack : '') + ' น.');
      lines.push('   📍 ' + (j.destination || '-'));
      if (j.mission) lines.push('   🎯 ' + j.mission);
      lines.push('   🙋 ผู้ขอรถ: ' + (j.requester || '-'));
      if (j.car) lines.push('   🚗 รถ: ' + j.car);
      lines.push('');
    });
  }

  lines.push(REPORT_DIVIDER_);
  lines.push('📊 ดู/แก้ไขได้ที่ Dashboard');
  lines.push('🔗 ' + DASHBOARD_URL);

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════
//  เบอร์โทรผู้ขับในข้อความ LINE (ตารางงานประจำวัน) — แนบไว้หลังชื่อ/ชื่อเล่นของแต่ละคน
//  ใช้เบอร์จากชีท "ตารางเวร" (คอลัมน์ ชื่อ-สกุล / ชื่อเล่น / เบอร์โทรศัพท์)
//  เบอร์ถูกพิมพ์เป็นตัวเลขติดกัน (เช่น 0882665403) เพื่อให้ LINE ทำเป็นลิงก์ให้กดโทรได้เอง
// ════════════════════════════════════════════════════════════

/** linePhoneDigits_ — แปลงเบอร์เป็นตัวเลขล้วน 9-10 หลัก (คืน '' ถ้าไม่ใช่เบอร์ที่ใช้ได้)
 *  - ถ้าในช่องมีหลายเบอร์ (คั่นด้วย , / ;) ใช้เบอร์แรก
 *  - ถ้า Sheets เก็บเป็นตัวเลขจนเลข 0 หน้าเบอร์หาย (9 หลักไม่ขึ้นต้นด้วย 0) ให้เติม 0 กลับให้ */
function linePhoneDigits_(raw) {
  var first = String(raw == null ? '' : raw).split(/[\/,;]/)[0];
  var d = normalizePhone_(first);
  if (d.length === 9 && d.charAt(0) !== '0') d = '0' + d;
  return (d.length >= 9 && d.length <= 10) ? d : '';
}

/** buildStaffPhoneMap_ — map { ชื่อ-สกุล | ชื่อเล่น : เบอร์โทร } จากชีท "ตารางเวร" (อ่านชีตครั้งเดียวต่อการสร้างข้อความ)
 *  ถ้าอ่านไม่ได้ จะคืน {} — ข้อความยังส่งได้ตามปกติ เพียงแต่ไม่มีเบอร์แนบ */
function buildStaffPhoneMap_() {
  var map = {};
  try {
    var res = getWorktableSchedule();
    if (res && res.status === 'ok') {
      (res.data || []).forEach(function (s) {
        var phone = linePhoneDigits_(s.phone);
        if (!phone) return;
        [s.name, s.nick].forEach(function (k) {
          var key = String(k || '').replace(/\s+/g, ' ').trim();
          if (key && !map[key]) map[key] = phone; // ชื่อซ้ำ → ใช้คนแรกในตาราง (เหมือนหน้าตารางงาน)
        });
      });
    }
  } catch (e) {
    console.warn('buildStaffPhoneMap_: ' + e.message);
  }
  return map;
}

/** driverWithPhone_ — ใส่เบอร์โทรต่อท้ายชื่อผู้ขับแต่ละคนในช่อง "ผู้ไปส่ง"
 *  รองรับทั้งกรอกชื่อเล่น (หนุ่ย) / ชื่อ-สกุลเต็ม / หลายคนคั่นด้วย , / & + "และ" "กับ"
 *  คนที่หาเบอร์ไม่เจอจะแสดงชื่อตามที่กรอกไว้เหมือนเดิม (ไม่แนบเบอร์)
 *  ตัวอย่าง: "หนุ่ย" → "หนุ่ย 📞 0882665403" ; "หนุ่ย, บอม" → "หนุ่ย 📞 0882665403, บอม 📞 0866728623" */
function driverWithPhone_(driverText, phoneMap) {
  var text = String(driverText || '').trim();
  if (!text) return '';
  phoneMap = phoneMap || {};
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function one(name) {
    var n = norm(name);
    return phoneMap[n] ? (n + ' 📞 ' + phoneMap[n]) : n;
  }
  // ทั้งข้อความตรงกับ 1 คนพอดี (รวมชื่อ-สกุลที่มีช่องว่างตรงกลาง) → ไม่ต้องแยกคำ
  if (phoneMap[norm(text)]) return one(text);

  var parts = text.split(/\s*(?:,|，|、|\/|&|\+)\s*|\s+และ\s+|\s+กับ\s+/).filter(function (x) { return norm(x); });
  var hit = parts.some(function (x) { return !!phoneMap[norm(x)]; });
  if (!hit) return text; // ไม่พบใครในตารางเวรเลย → คืนข้อความเดิมทุกตัวอักษร
  return parts.map(one).join(', ');
}
