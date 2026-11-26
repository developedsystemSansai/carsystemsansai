// ════════════════════════════════════════════════════════════
//  6) TEST FUNCTIONS — รันทดสอบได้ทันทีจาก Editor โดยไม่ต้องรอถึงเวลาจริง
// ════════════════════════════════════════════════════════════

/** testCarStatusReply — ทดสอบข้อความสถานะรถที่จะตอบกลับตอนกด Rich Menu (รันจาก Editor ได้ทันที ไม่ต้องรอมีคนกดจริง) */

/** testCarStatusReply — ทดสอบข้อความสถานะรถที่จะตอบกลับตอนกด Rich Menu (รันจาก Editor ได้ทันที ไม่ต้องรอมีคนกดจริง) */
function testCarStatusReply() {
  var text = buildCarStatusReplyText_();
  console.log(text);
  return text;
}

/** testMyScheduleReply — [LEGACY] ทดสอบฟังก์ชันเดิมที่ผูกเบอร์โทร (ไม่ได้ใช้งานจริงในระบบแล้ว เก็บไว้ debug เท่านั้น)
 *  วิธีใช้: แก้เบอร์โทรในวงเล็บให้ตรงกับคนที่ต้องการทดสอบ แล้วกด Run */
function testMyScheduleReply() {
  var text = buildMyScheduleReplyByPhone_('0849484577'); // ← เปลี่ยนเบอร์ตรงนี้เพื่อทดสอบคนอื่น
  console.log(text);
  return text;
}

/** testScheduleOverviewReply — ทดสอบข้อความ "ตารางงานของฉัน" แบบภาพรวม (ที่ใช้งานจริงตอนนี้ทุกบทบาท)
 *  ไม่ต้องใส่เบอร์โทร/พารามิเตอร์ใดๆ — รันจาก Editor ได้ทันที ไม่ต้องรอมีคนกดจริงบน LINE */
function testScheduleOverviewReply() {
  var text = buildScheduleOverviewReplyText_();
  console.log(text);
  return text;
}

// ── ⬇️ ฟังก์ชันด้านล่างนี้ "ส่งข้อความเข้า LINE จริง" (push/multicast) ต่างจาก test ด้านบนที่แค่ log ข้อความ ──
// ⚠️ กด Run แล้วข้อความจะไปเด้งในแอป LINE ของผู้รับจริง (ไม่ใช่แค่ดูใน Execution log)

/** testPushCarStatusToAll — ส่งข้อความ "สถานะรถ" เข้า LINE จริงให้ทุกคนที่มีสิทธิ์ (แอดมิน/รองฯ/พขร. ตามชีท LineUsers)
 *  ใช้ตรวจว่า LINE_CHANNEL_ACCESS_TOKEN ถูกต้องและข้อความส่งถึงเครื่องจริงหรือไม่ — กด Run จาก Editor ได้เลย */
function testPushCarStatusToAll() {
  var text = buildCarStatusReplyText_();
  var userIds = getLineUserIdsByRoles_(ONDEMAND_ROLES_CAR_STATUS);
  if (userIds.length === 0) {
    console.warn('ไม่มีผู้ใช้ LINE ที่ตั้งบทบาทตรงกับสิทธิ์นี้เลย (แอดมิน/รองฯ/พขร.) — ตรวจคอลัมน์ "บทบาท" ในชีท LineUsers');
    return { status: 'error', message: 'ไม่มีผู้รับ (ยังไม่มีใครตั้งบทบาทแอดมิน/รองฯ/พขร. ในชีท LineUsers)' };
  }
  lineLogRun_({ trigger: 'editor', key: 'carStatus', label: 'สถานะรถ (Rich Menu)', roles: ONDEMAND_ROLES_CAR_STATUS }, function () {
    lineMulticast_(userIds, [{ type: 'text', text: text }]);
  });
  console.log('ส่ง "สถานะรถ" เข้า LINE จริงให้ ' + userIds.length + ' คนแล้ว: ' + JSON.stringify(userIds));
  return { status: 'ok', sentTo: userIds.length, userIds: userIds };
}

/** testPushScheduleOverviewToAll — ส่งข้อความ "ตารางงานของฉัน" (ภาพรวม) เข้า LINE จริงให้ทุกคนที่มีสิทธิ์
 *  (แอดมิน/รองฯ/พขร. ตามชีท LineUsers) — กด Run จาก Editor ได้เลย */
function testPushScheduleOverviewToAll() {
  var text = buildScheduleOverviewReplyText_();
  var userIds = getLineUserIdsByRoles_(ONDEMAND_ROLES_MY_SCHEDULE);
  if (userIds.length === 0) {
    console.warn('ไม่มีผู้ใช้ LINE ที่ตั้งบทบาทตรงกับสิทธิ์นี้เลย (แอดมิน/รองฯ/พขร.) — ตรวจคอลัมน์ "บทบาท" ในชีท LineUsers');
    return { status: 'error', message: 'ไม่มีผู้รับ (ยังไม่มีใครตั้งบทบาทแอดมิน/รองฯ/พขร. ในชีท LineUsers)' };
  }
  lineLogRun_({ trigger: 'editor', key: 'myScheduleOverview', label: 'ตารางงานของฉัน — ภาพรวม', roles: ONDEMAND_ROLES_MY_SCHEDULE }, function () {
    lineMulticast_(userIds, [{ type: 'text', text: text }]);
  });
  console.log('ส่ง "ตารางงานของฉัน" เข้า LINE จริงให้ ' + userIds.length + ' คนแล้ว: ' + JSON.stringify(userIds));
  return { status: 'ok', sentTo: userIds.length, userIds: userIds };
}

/** testPushCarStatusToMe — ส่งข้อความ "สถานะรถ" เข้า LINE จริงให้คนเดียว (ใส่ userId ของตัวเองก่อนกด Run)
 *  หา userId ของตัวเองได้จากชีท "LineUsers" คอลัมน์ UserId (แถวที่ตรงกับชื่อ/DisplayName ของตัวเอง) */
function testPushCarStatusToMe() {
  var myUserId = 'ใส่ userId ของตัวเองตรงนี้'; // ← แก้ตรงนี้ก่อนกด Run
  lineLogRun_({ trigger: 'editor', key: 'carStatus', label: 'สถานะรถ (ทดสอบส่งให้ตัวเอง)' }, function () {
    linePush_(myUserId, [{ type: 'text', text: buildCarStatusReplyText_() }]);
  });
  console.log('ส่งแล้วไปยัง ' + myUserId);
}

/** testPushScheduleOverviewToMe — ส่งข้อความ "ตารางงานของฉัน" (ภาพรวม) เข้า LINE จริงให้คนเดียว
 *  (ใส่ userId ของตัวเองก่อนกด Run เช่นเดียวกับ testPushCarStatusToMe) */
function testPushScheduleOverviewToMe() {
  var myUserId = 'ใส่ userId ของตัวเองตรงนี้'; // ← แก้ตรงนี้ก่อนกด Run
  lineLogRun_({ trigger: 'editor', key: 'myScheduleOverview', label: 'ตารางงานของฉัน (ทดสอบส่งให้ตัวเอง)' }, function () {
    linePush_(myUserId, [{ type: 'text', text: buildScheduleOverviewReplyText_() }]);
  });
  console.log('ส่งแล้วไปยัง ' + myUserId);
}

function testSendDailyReport() {
  var r = buildDailyCheckReport_();
  console.log(r.lineText);
  var result = sendReportToAllChannels_(r.lineText, r.emailSubject, r.emailBody, REPORT_ROLES_DAILY_CHECK, { trigger: 'editor', key: 'dailyCheck', label: 'รายงานตรวจสภาพรถประจำวัน' });
  console.log(JSON.stringify(result));
  return result;
}

function testSendDailyWorkScheduleReport() {
  var r = buildDailyWorkScheduleReport_();
  console.log(r.lineText);
  var result = sendReportToAllChannels_(r.lineText, r.emailSubject, r.emailBody, REPORT_ROLES_WORK_SCHEDULE, { trigger: 'editor', key: 'workSchedule', label: 'ตารางงานประจำวัน' });
  console.log(JSON.stringify(result));
  return result;
}

function testSendWeeklyReport() {
  var r = buildWeeklyUsageFuelReport_();
  console.log(r.lineText);
  var result = sendReportToAllChannels_(r.lineText, r.emailSubject, r.emailBody, REPORT_ROLES_WEEKLY_USAGE, { trigger: 'editor', key: 'weeklyUsage', label: 'รายงานใช้งานรถ+เติมน้ำมันประจำสัปดาห์' });
  console.log(JSON.stringify(result));
  return result;
}

/** testLineUserRegistered — เช็คว่ามีใครลงทะเบียนรับ LINE แล้วบ้าง (รวมบทบาทที่ตั้งไว้) */
function testLineUserRegistered() {
  var ids = getActiveLineUserIds_();
  console.log('Active LINE users: ' + ids.length);
  console.log(JSON.stringify(ids));
  return ids;
}

/** testLineUserRoles — debug: ดูรายชื่อ+บทบาทของผู้ใช้ LINE ทุกคน (เพื่อตรวจว่าตั้งบทบาทครบหรือยัง)
 *  ผู้ใช้ที่ยังไม่ได้ตั้งบทบาท (role === '') จะไม่ได้รับรายงานอัตโนมัติใดๆ เลย */
function testLineUserRoles() {
  var sheet = getOrCreateLineUsersSheet_();
  if (sheet.getLastRow() <= 1) return [];
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  var out = data.map(function (r) {
    return { userId: r[0], name: r[1], status: r[3], role: r[5] || '(ยังไม่ได้ตั้ง)' };
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}
