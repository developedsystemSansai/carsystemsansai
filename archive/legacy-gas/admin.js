/** getLineMessageCatalog — รายการข้อความทั้งหมดที่ระบบส่งได้ (สำหรับแท็บ "ทดสอบ / ส่งซ้ำ" ในหน้า linecontrol.html)
 *  ✅ NEW: แนบ recipientCount = จำนวนผู้รับจริงตามบทบาท (ใช้แสดงในหน้าต่างยืนยันก่อน "ส่งจริงอีกครั้ง") */
function getLineMessageCatalog() {
  var items = LINE_MESSAGE_CATALOG_.map(function (c) {
    var n = 0;
    try { n = getLineUserIdsByRoles_(c.roles || []).length; } catch (e) { console.warn('getLineMessageCatalog:', e.message); }
    return { key: c.key, label: c.label, type: c.type, roles: c.roles, recipientCount: n };
  });
  return { status: 'ok', items: items };
}

/** testSendLineMessageByKey — ทดสอบส่งข้อความจริง 1 ฉบับ ไปยัง "แอดมิน" ทุกคนที่ลงทะเบียนไว้ (ต้องรหัสแอดมิน)
 *  ✅ ส่งไปหาแอดมินโดยอัตโนมัติผ่านระบบบทบาทในชีท LineUsers — ไม่ต้องตั้งค่า userId ทดสอบเองอีกต่อไป
 *  ⚠️ นี่คือการส่งจริงผ่าน LINE push API เสียโควต้าข้อความ 1 ครั้ง/คน/การกดทดสอบ 1 ครั้ง (ไม่ใช่แค่ preview)
 *  ✅ NEW: ข้อความยาวถูกตัดแบ่งอัตโนมัติ (เดิมส่งก้อนเดียว ถ้าเกิน 5,000 ตัวอักษร LINE จะปฏิเสธ) + บันทึกลงประวัติการส่ง
 *  payload: { key, adminCode, clientIp } */
function testSendLineMessageByKey(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var key  = payload && payload.key;
  var text = buildLineMessageByKey_(key);
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

  var clientIp = String((payload && payload.clientIp) || 'unknown');
  var r;
  setLineSendContext_({ trigger: 'test', key: key, by: clientIp, roles: [LINE_ROLE_ADMIN] });
  try { r = lineSendTextToUsers_(adminIds, text); } finally { resetLineSendContext_(); }

  logApiAccess_('testSendLine:' + key, clientIp, r.ok, '', '');
  return {
    status: r.sent > 0 ? 'ok' : 'error',
    message: r.sent > 0
      ? ('ส่งสำเร็จไปยังแอดมิน ' + r.sent + '/' + adminIds.length + ' คนแล้ว (ใช้โควต้า LINE ' + (r.sent * r.messageCount) + ' ข้อความ)')
      : ('ส่งไม่สำเร็จ: ' + (r.errors[0] || 'ไม่ทราบสาเหตุ — ตรวจสอบ token/userId')),
    preview: text,
    channel: getActiveLineChannel_()
  };
}

/** resendLineMessageByKey — ✅ NEW: "ส่งจริงอีกครั้ง" (ไม่ใช่ทดสอบ) — สร้างข้อความ "ใหม่" จากข้อมูลล่าสุดตอนนี้
 *  แล้วส่งให้ผู้รับจริงตามบทบาทของข้อความนั้น (เหมือนที่ trigger อัตโนมัติส่ง) — ส่งทาง LINE เท่านั้น ไม่ส่งอีเมลซ้ำ
 *  ไม่เช็คสวิตช์เปิด/ปิดและไม่ข้ามเสาร์-อาทิตย์ (เพราะเป็นการสั่งส่งเองโดยแอดมิน) — ต้องรหัสแอดมิน
 *  payload: { key, adminCode, clientIp } */
function resendLineMessageByKey(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var key = String((payload && payload.key) || '');
  var cat = LINE_MESSAGE_CATALOG_.filter(function (c) { return c.key === key; })[0];
  if (!cat) return { status: 'error', message: 'ไม่พบข้อความนี้ในระบบ' };

  var text = buildLineMessageByKey_(key);
  if (text == null) return { status: 'error', message: 'สร้างข้อความไม่สำเร็จ' };

  var clientIp = String((payload && payload.clientIp) || 'unknown');
  var r = sendLineToRoles_(text, cat.roles, { key: key, label: cat.label, trigger: 'resend', by: clientIp });
  logApiAccess_('resendLine:' + key, clientIp, r.sent > 0, '', '');
  return lineResendResult_(r, text, cat.roles);
}

/** resendLineFromHistory — ✅ NEW: "ส่งซ้ำข้อความเดิม" จากแถวในประวัติการส่ง (ส่งข้อความตัวเดิมเป๊ะ ไม่ดึงข้อมูลใหม่)
 *  ผู้รับ: ถ้ารู้ว่าเป็นข้อความชนิดไหน ใช้ผู้รับจริงตามบทบาทของชนิดนั้น ไม่งั้นใช้บทบาทที่บันทึกไว้ในประวัติ — ต้องรหัสแอดมิน
 *  payload: { logId, adminCode, clientIp } */
function resendLineFromHistory(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var logId = String((payload && payload.logId) || '').trim();
  if (!logId) return { status: 'error', message: 'ไม่พบรหัสรายการ' };
  var row = findLineSendLogRow_(logId);
  if (!row) return { status: 'error', message: 'ไม่พบรายการนี้ในประวัติการส่ง (อาจถูกลบเพราะเก่าเกินไป)' };

  var v = row.values; // index ตาม LINE_SEND_LOG_HEADERS
  var text = String(v[18] || '');
  if (!text || String(v[4]) === 'reply') {
    return { status: 'error', message: 'รายการนี้ไม่มีข้อความเต็มเก็บไว้ (ข้อความตอบสด Rich Menu ไม่เก็บ) — ใช้ปุ่ม "ส่งจริงอีกครั้ง" ในแท็บ "ทดสอบ / ส่งซ้ำ" แทน' };
  }
  var key = String(v[6] || '');
  var cat = LINE_MESSAGE_CATALOG_.filter(function (c) { return c.key === key; })[0];
  var roles = cat ? cat.roles : String(v[16] || '').split(',').map(function (s) { return s.trim(); }).filter(function (s) { return LINE_ROLE_VALUES_.indexOf(s) >= 0; });
  if (!roles.length) return { status: 'error', message: 'ไม่ทราบว่าควรส่งให้บทบาทใด (ไม่พบข้อมูลผู้รับในประวัติ)' };

  var clientIp = String((payload && payload.clientIp) || 'unknown');
  var r = sendLineToRoles_(text, roles, { key: key, label: String(v[7] || (cat && cat.label) || ''), trigger: 'resend-history', by: clientIp });
  logApiAccess_('resendLineHistory:' + key, clientIp, r.sent > 0, '', '');
  return lineResendResult_(r, text, roles);
}

function lineResendResult_(r, text, roles) {
  var chLabel = r.channel === 'backup' ? 'บัญชีสำรอง' : 'บัญชีหลัก';
  if (r.recipients === 0) return { status: 'error', message: r.error, preview: text, channel: r.channel };
  if (r.sent > 0) {
    return {
      status: 'ok',
      message: 'ส่งจริงสำเร็จ ' + r.sent + '/' + r.recipients + ' คน (ใช้โควต้า LINE ' + (r.sent * r.messageCount) + ' ข้อความ · ' + chLabel + ')'
        + (r.failed > 0 ? ' — ส่งไม่ถึง ' + r.failed + ' คน' : ''),
      recipients: r.recipients, sent: r.sent, failed: r.failed, preview: text, channel: r.channel
    };
  }
  return { status: 'error', message: 'ส่งไม่สำเร็จ: ' + (r.error || 'ไม่ทราบสาเหตุ — ตรวจสอบ token/โควต้า'), recipients: r.recipients, preview: text, channel: r.channel };
}

// ── 7.5) ประวัติการส่ง LINE (แท็บ "ประวัติการส่ง" ใน linecontrol.html) ──────────────────────
/** lineLogTimeStr_ — ค่าในช่องเวลา (ข้อความ หรือ Date ที่ Sheets แปลงให้เอง) → "dd/MM/yyyy HH:mm:ss" */
function lineLogTimeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  return String(v || '');
}

function lineLogRowToItem_(r) {
  return {
    logId: String(r[0] || ''), time: lineLogTimeStr_(r[1]), channel: String(r[2] || ''), tokenHint: String(r[3] || ''),
    mode: String(r[4] || ''), trigger: String(r[5] || ''), key: String(r[6] || ''), label: String(r[7] || ''),
    recipients: Number(r[8]) || 0, messageCount: Number(r[9]) || 0, quota: Number(r[10]) || 0,
    status: String(r[11] || ''), http: r[12] === '' ? '' : Number(r[12]) || r[12], requestId: String(r[13] || ''),
    error: String(r[14] || ''), by: String(r[15] || ''), roles: String(r[16] || ''), preview: String(r[17] || '')
  };
}

/** findLineSendLogRow_ — หาแถวในประวัติจาก LogId → { rowNum, values[19] } | null */
function findLineSendLogRow_(logId) {
  var sheet = getLineSendLogSheet_();
  var last = sheet.getLastRow();
  if (last <= 1) return null;
  var hit = sheet.getRange(2, 1, last - 1, 1).createTextFinder(logId).matchEntireCell(true).findNext();
  if (!hit) return null;
  var rowNum = hit.getRow();
  return { rowNum: rowNum, values: sheet.getRange(rowNum, 1, 1, LINE_SEND_LOG_HEADERS.length).getValues()[0] };
}

/** getLineSendHistory — ประวัติการส่งล่าสุด (ใหม่สุดก่อน) + สรุปโควต้าที่ใช้ แยกตามช่องทาง token (ต้องรหัสแอดมิน)
 *  payload: { limit (ค่าเริ่มต้น 100, สูงสุด 500), adminCode } */
function getLineSendHistory(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var limit = Math.max(1, Math.min(500, Number(payload && payload.limit) || 100));
  var sheet = getLineSendLogSheet_();
  var last  = sheet.getLastRow();
  var empty = function () { return { sends: 0, quota: 0, fail: 0 }; };
  var summary = { month: Utilities.formatDate(new Date(), 'Asia/Bangkok', 'MM/yyyy'), primary: empty(), backup: empty(), today: empty() };
  if (last <= 1) return { status: 'ok', items: [], total: 0, summary: summary };

  var n    = Math.min(last - 1, LINE_SEND_LOG_MAX_ROWS_);
  var data = sheet.getRange(last - n + 1, 1, n, 18).getValues(); // ไม่อ่านคอลัมน์ "ข้อความเต็ม" (คอลัมน์ที่ 19) — ใหญ่และไม่จำเป็นในรายการ
  var todayStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
  var items = [];
  for (var i = data.length - 1; i >= 0; i--) {
    var it = lineLogRowToItem_(data[i]);
    if (!it.logId) continue;
    var ok = it.status === 'สำเร็จ';
    if (it.time.substring(3, 10) === summary.month) {
      var ch = it.channel === 'backup' ? summary.backup : summary.primary;
      ch.sends++; if (ok) ch.quota += it.quota; else ch.fail++;
    }
    if (it.time.substring(0, 10) === todayStr) { summary.today.sends++; if (ok) summary.today.quota += it.quota; else summary.today.fail++; }
    if (items.length < limit) items.push(it);
  }
  return { status: 'ok', items: items, total: last - 1, summary: summary };
}

/** getLineSendHistoryDetail — ข้อความเต็มของรายการหนึ่งในประวัติ (ต้องรหัสแอดมิน) payload: { logId, adminCode } */
function getLineSendHistoryDetail(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };
  var row = findLineSendLogRow_(String((payload && payload.logId) || '').trim());
  if (!row) return { status: 'error', message: 'ไม่พบรายการนี้ในประวัติการส่ง' };
  var item = lineLogRowToItem_(row.values);
  var full = String(row.values[18] || '');
  return { status: 'ok', item: item, text: full || item.preview, isFull: !!full, canResend: !!full && item.mode !== 'reply' };
}

