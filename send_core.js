// ── บริบทของการส่งแต่ละครั้ง (ใช้บันทึกลงประวัติ) ─────────────────────────────
//   ตั้งก่อนเรียกส่ง แล้ว lineApiPost_ จะอ่านไปบันทึกประวัติให้เองทุกครั้งที่ยิง LINE API
//   trigger: 'auto' = trigger ตั้งเวลา | 'test' = ปุ่มทดสอบ | 'resend' = ส่งจริงซ้ำ (สร้างข้อความใหม่)
//            'resend-history' = ส่งจริงซ้ำ (ข้อความเดิมจากประวัติ) | 'richmenu' = ตอบสดปุ่ม Rich Menu
//            'editor' = กด Run จาก Apps Script Editor | 'system' = อื่นๆ
var LINE_SEND_CTX_DEFAULT_ = { trigger: 'system', key: '', label: '', by: '', roles: '' };
var LINE_SEND_CTX_ = LINE_SEND_CTX_DEFAULT_;

function setLineSendContext_(ctx) {
  ctx = ctx || {};
  LINE_SEND_CTX_ = {
    trigger: String(ctx.trigger || 'system'),
    key:     String(ctx.key || ''),
    label:   String(ctx.label || lineMessageLabel_(ctx.key)),
    by:      String(ctx.by || ''),
    roles:   Array.isArray(ctx.roles) ? ctx.roles.join(', ') : String(ctx.roles || '')
  };
}
function resetLineSendContext_() { LINE_SEND_CTX_ = LINE_SEND_CTX_DEFAULT_; }

/** lineMessageLabel_ — ชื่อข้อความภาษาไทยจาก key (ดู LINE_MESSAGE_CATALOG_) */
function lineMessageLabel_(key) {
  if (!key) return '';
  if (key === 'welcome') return 'ข้อความต้อนรับ/ลงทะเบียน';
  var hit = (typeof LINE_MESSAGE_CATALOG_ !== 'undefined' ? LINE_MESSAGE_CATALOG_ : []).filter(function (c) { return c.key === key; })[0];
  return hit ? hit.label : String(key);
}

// ── ประวัติการส่ง LINE (ชีท LineSendLog) — บันทึกทุกครั้งที่ยิง LINE API พร้อม \"token ที่ใช้\" ─────────
//   ⚠️ ไม่เก็บ token จริง เก็บแค่ช่องทาง (หลัก/สำรอง) + 4 ตัวท้ายเพื่อแยกแยะ token ได้
var SHEET_LINE_SEND_LOG   = 'LineSendLog';
var LINE_SEND_LOG_HEADERS = [
  'LogId', 'เวลา', 'ช่องทาง Token', 'Token (4 ตัวท้าย)', 'วิธีส่ง', 'ประเภทการส่ง',
  'รหัสข้อความ', 'ชื่อข้อความ', 'จำนวนผู้รับ', 'จำนวนข้อความ', 'โควต้าที่ใช้',
  'สถานะ', 'HTTP', 'LINE Request ID', 'ข้อผิดพลาด', 'ผู้สั่งส่ง', 'ผู้รับ (บทบาท)',
  'ตัวอย่างข้อความ', 'ข้อความเต็ม'
];
var LINE_SEND_LOG_MAX_ROWS_  = 2500; // เกินนี้จะลบแถวเก่าสุดออกให้อัตโนมัติ
var LINE_SEND_LOG_TRIM_ROWS_ = 700;
var LINE_SEND_LOG_FULLTEXT_MAX_ = 45000; // ขีดจำกัดต่อเซลล์ของ Google Sheets = 50,000 ตัวอักษร

function lineTokenHint_(token) {
  token = String(token || '');
  return token ? ('…' + token.slice(-4)) : '';
}

function getLineSendLogSheet_() {
  return getOrCreateSheet(getSpreadsheet(), SHEET_LINE_SEND_LOG, LINE_SEND_LOG_HEADERS);
}

/** logLineSend_ — เพิ่ม 1 แถวในประวัติการส่ง (ห้าม throw — ถ้าบันทึกไม่ได้ต้องไม่กระทบการส่งจริง) */
function logLineSend_(e) {
  try {
    var sheet = getLineSendLogSheet_();
    var now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    var logId = 'L' + new Date().getTime() + Math.floor(Math.random() * 100);
    var text  = String(e.text || '');
    sheet.appendRow([
      logId, now, e.channel || '', e.tokenHint || '', e.mode || '', e.trigger || 'system',
      e.key || '', e.label || '', Number(e.recipients) || 0, Number(e.messageCount) || 0, Number(e.quota) || 0,
      e.status || '', e.http === undefined || e.http === null ? '' : e.http, e.requestId || '',
      String(e.error || '').slice(0, 800), e.by || '', e.roles || '',
      text.replace(/\s+/g, ' ').slice(0, 240),
      e.keepFullText ? text.slice(0, LINE_SEND_LOG_FULLTEXT_MAX_) : ''
    ]);
    var lastRow = sheet.getLastRow();
    if (lastRow > LINE_SEND_LOG_MAX_ROWS_ + 1) sheet.deleteRows(2, LINE_SEND_LOG_TRIM_ROWS_);
    return logId;
  } catch (err) {
    console.error('logLineSend_:', err.message);
    return '';
  }
}

function lineHeaderCI_(res, name) {
  try {
    var h = res.getHeaders() || {};
    var want = String(name).toLowerCase();
    var keys = Object.keys(h);
    for (var i = 0; i < keys.length; i++) if (String(keys[i]).toLowerCase() === want) return String(h[keys[i]]);
  } catch (_) {}
  return '';
}

function lineApiPost_(url, body) {
  var _channel = getActiveLineChannel_();
  var _token   = getActiveLineToken_(); // ✅ NEW: สลับไปใช้ token สำรองได้จาก linecontrol.html เมื่อ token หลักหมด/โควต้าหมด
  var _mode    = /\/reply$/.test(url) ? 'reply' : (/\/multicast$/.test(url) ? 'multicast' : 'push');
  var _msgs    = (body && body.messages) || [];
  var _rcpt    = _mode === 'multicast' ? ((body && body.to) || []).length : 1;
  var _text    = _msgs.map(function (m) { return (m && m.text) || ''; }).join('\n\n— — —\n\n');
  var _ctx     = LINE_SEND_CTX_;
  var _entry   = {
    channel: _channel, tokenHint: lineTokenHint_(_token), mode: _mode,
    trigger: _ctx.trigger, key: _ctx.key, label: _ctx.label || lineMessageLabel_(_ctx.key), by: _ctx.by, roles: _ctx.roles,
    recipients: _rcpt, messageCount: _msgs.length, text: _text,
    keepFullText: _mode !== 'reply' // ตอบสด Rich Menu ไม่เก็บข้อความเต็ม (ประหยัดพื้นที่ชีท)
  };

  if (!_token) {
    console.warn('lineApiPost_: ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ของช่องทางที่กำลังใช้งานใน Script Properties');
    _entry.status = 'ล้มเหลว'; _entry.error = 'ยังไม่ได้ตั้งค่า token ของช่องทาง "' + _channel + '" ใน Script Properties'; _entry.quota = 0;
    logLineSend_(_entry);
    return null;
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + _token },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    _entry.http = code;
    _entry.requestId = lineHeaderCI_(res, 'x-line-request-id');
    if (code >= 300) {
      console.error('LINE API error ' + code + ': ' + res.getContentText());
      _entry.status = 'ล้มเหลว'; _entry.error = res.getContentText(); _entry.quota = 0;
    } else {
      _entry.status = 'สำเร็จ';
      _entry.quota  = _mode === 'reply' ? 0 : _rcpt * _msgs.length; // reply ฟรี ไม่นับโควต้า / push-multicast นับ ผู้รับ × จำนวนข้อความ
    }
    logLineSend_(_entry);
    return res;
  } catch (err) {
    console.error('lineApiPost_:', err.message);
    _entry.status = 'ล้มเหลว'; _entry.error = err.message; _entry.quota = 0;
    logLineSend_(_entry);
    return null;
  }
}

/** lineReply_ — meta (ไม่บังคับ) = { key, label, by } ใช้ระบุที่มาของข้อความตอบสดในประวัติการส่ง */
function lineReply_(replyToken, messages, meta) {
  setLineSendContext_({ trigger: 'richmenu', key: meta && meta.key, label: meta && meta.label, by: meta && meta.by });
  try {
    return lineApiPost_('https://api.line.me/v2/bot/message/reply', { replyToken: replyToken, messages: messages });
  } finally { resetLineSendContext_(); }
}

function linePush_(userId, messages) {
  return lineApiPost_('https://api.line.me/v2/bot/message/push', { to: userId, messages: messages });
}

/** lineMulticast_ — ส่งข้อความเดียวกันให้หลายคน (สูงสุด 500 คน/ครั้งตามข้อจำกัดของ LINE)
 *  คืนค่า { ok, sent, failed, errors[] } — เดิมไม่คืนอะไรเลย ทำให้ส่งไม่สำเร็จก็ยังรายงานว่า "ส่งแล้ว" */
function lineMulticast_(userIds, messages) {
  var chunkSize = 500, sent = 0, failed = 0, errors = [];
  for (var i = 0; i < userIds.length; i += chunkSize) {
    var chunk = userIds.slice(i, i + chunkSize);
    var res = lineApiPost_('https://api.line.me/v2/bot/message/multicast', { to: chunk, messages: messages });
    var ok  = !!res && res.getResponseCode() < 300;
    if (ok) sent += chunk.length;
    else {
      failed += chunk.length;
      errors.push(res ? ('HTTP ' + res.getResponseCode() + ' ' + res.getContentText()) : 'ไม่มีการตอบกลับ / ยังไม่ได้ตั้งค่า token');
    }
  }
  return { ok: failed === 0 && sent > 0, sent: sent, failed: failed, errors: errors };
}

/** lineSendTextToUsers_ — ส่งข้อความยาวให้หลายคน: ตัดแบ่งทุก 4,500 ตัวอักษร และส่งทีละ 5 ข้อความ/ครั้ง (ข้อจำกัดของ LINE)
 *  ✅ แก้: เดิมตัดทิ้งเหลือแค่ 5 ก้อนแรกแบบเงียบๆ ข้อความที่ยาวมากจึงหายท้าย — ตอนนี้ส่งครบทุกก้อน */
function lineSendTextToUsers_(userIds, text) {
  var chunks = splitLineText_(String(text || ''), 4500);
  var out = { ok: true, sent: 0, failed: 0, errors: [], messageCount: chunks.length };
  var minSent = null;
  for (var i = 0; i < chunks.length; i += 5) {
    var msgs = chunks.slice(i, i + 5).map(function (t) { return { type: 'text', text: t }; });
    var r = lineMulticast_(userIds, msgs);
    minSent = (minSent === null) ? r.sent : Math.min(minSent, r.sent);
    out.failed = Math.max(out.failed, r.failed);
    if (!r.ok) out.ok = false;
    out.errors = out.errors.concat(r.errors);
  }
  out.sent = minSent || 0;
  return out;
}

/** sendLineToRoles_ — ส่งข้อความ LINE ให้ผู้รับตามบทบาท + บันทึกประวัติ (ใช้ร่วมกันทั้ง trigger อัตโนมัติ และปุ่มส่งซ้ำ)
 *  ctx = { key, label, trigger, by }  คืนค่า { recipients, sent, failed, error, channel, messageCount } */
function sendLineToRoles_(text, targetRoles, ctx) {
  ctx = ctx || {};
  var roles = targetRoles || [];
  var out = { recipients: 0, sent: 0, failed: 0, error: '', channel: getActiveLineChannel_(), messageCount: 0 };
  var userIds = getLineUserIdsByRoles_(roles);
  out.recipients = userIds.length;

  if (!userIds.length) {
    out.error = 'ยังไม่มีผู้รับ LINE ที่ตรงบทบาท (' + roles.join(', ') + ') — ตรวจสอบคอลัมน์ "บทบาท" ในชีท LineUsers';
    console.warn(out.error);
    var c0 = getActiveLineToken_();
    logLineSend_({
      channel: out.channel, tokenHint: lineTokenHint_(c0), mode: 'multicast', trigger: ctx.trigger || 'system',
      key: ctx.key || '', label: ctx.label || lineMessageLabel_(ctx.key), by: ctx.by || '', roles: roles.join(', '),
      recipients: 0, messageCount: 0, quota: 0, status: 'ไม่มีผู้รับ', error: out.error, text: text, keepFullText: true
    });
    return out;
  }

  setLineSendContext_({ trigger: ctx.trigger, key: ctx.key, label: ctx.label, by: ctx.by, roles: roles });
  try {
    var r = lineSendTextToUsers_(userIds, text);
    out.sent = r.sent; out.failed = r.failed; out.messageCount = r.messageCount;
    if (!r.ok) out.error = r.errors.slice(0, 2).join(' | ') || 'ส่งไม่สำเร็จ';
  } catch (err) {
    out.error = err.message;
    console.error('sendLineToRoles_:', err);
  } finally { resetLineSendContext_(); }
  return out;
}

/** sendReportToAllChannels_ — ส่งรายงานออกทาง LINE (เฉพาะผู้ที่บทบาทตรงกับ targetRoles) + อีเมล (REPORT_EMAILS)
 *  @param {string[]} targetRoles - บทบาทที่ควรได้รับรายงานนี้ (เช่น [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY])
 *  @param {Object}   opts - (ไม่บังคับ) { key, label, trigger, by, skipEmail } ใช้ระบุที่มาในประวัติการส่ง / ข้ามอีเมลเมื่อส่งซ้ำ
 *  อีเมลยังส่งให้ REPORT_EMAILS ตามเดิมทุกกรณี (ไม่แยกบทบาท) */
function sendReportToAllChannels_(lineText, emailSubject, emailBody, targetRoles, opts) {
  opts = opts || {};
  var results = { line: { sent: 0, failed: 0, recipients: 0, channel: '', error: '' }, email: { sent: 0, error: '' } };

  // ── LINE (ส่งเฉพาะบทบาทที่กำหนด) ──
  try {
    var r = sendLineToRoles_(lineText, targetRoles, { key: opts.key, label: opts.label, trigger: opts.trigger || 'system', by: opts.by });
    results.line = { sent: r.sent, failed: r.failed, recipients: r.recipients, channel: r.channel, error: r.error };
  } catch (lineErr) {
    results.line.error = lineErr.message;
    console.error('sendReportToAllChannels_ (LINE):', lineErr);
  }

  // ── Email ──
  if (!opts.skipEmail) {
    try {
      if (REPORT_EMAILS.length > 0) {
        MailApp.sendEmail({
          to: REPORT_EMAILS.join(','),
          subject: emailSubject,
          htmlBody: emailBody
        });
        results.email.sent = REPORT_EMAILS.length;
      }
    } catch (mailErr) {
      results.email.error = mailErr.message;
      console.error('sendReportToAllChannels_ (Email):', mailErr);
    }
  }

  return results;
}

function splitLineText_(text, maxLen) {
  if (text.length <= maxLen) return [text];
  var parts = [];
  var remaining = text;
  while (remaining.length > maxLen) {
    var cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining) parts.push(remaining);
  return parts;
}

