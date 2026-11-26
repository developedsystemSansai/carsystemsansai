// ════════════════════════════════════════════════════════════
//  2) LINE MESSAGING API — ส่งข้อความ (reply / push / multicast)
// ════════════════════════════════════════════════════════════

/** getActiveLineChannel_ — คืนค่า 'primary' หรือ 'backup' (ช่องทางที่กำลังใช้ส่งจริงจริง บนสมมติฐานที่ตั้งค่าไว้จริง) */
function getActiveLineChannel_() {
  var v = SCRIPT_PROPS_.getProperty(LINE_ACTIVE_CHANNEL_PROP) || 'primary';
  return (v === 'backup' && LINE_CHANNEL_ACCESS_TOKEN_BACKUP) ? 'backup' : 'primary';
}

/** getActiveLineToken_ — token ของช่องทางที่กำลังใช้งานอยู่จริง (หลัก/สำรอง) — ใช้แทน LINE_CHANNEL_ACCESS_TOKEN ตรงๆ ทุกจุดที่เรียก LINE API */
function getActiveLineToken_() {
  return getActiveLineChannel_() === 'backup' ? LINE_CHANNEL_ACCESS_TOKEN_BACKUP : LINE_CHANNEL_ACCESS_TOKEN;
}

/* ════════════════════════════════════════════════════════════
 *  ✅ NEW: จัดบรรทัดข้อความ LINE ให้อ่านง่ายบนมือถือ — ทุกข้อความที่ส่งผ่าน lineApiPost_ ถูกจัดอัตโนมัติ
 *  ปัญหาเดิม: ภาษาไทยไม่เว้นวรรคระหว่างคำ พอบรรทัดยาวเกินฟองแชท LINE จะตัดตรงไหนก็ได้
 *   เช่น "(รถปิกอัพ)" ถูกผ่ากลางคำ และบรรทัดที่ตัดต่อไม่ย่อหน้า อ่านยาก
 *  วิธีแก้: วัดความกว้างโดยประมาณ แล้วตัดเองที่ "ช่องว่าง" ก่อน (คำ/วงเล็บทั้งก้อนไม่ถูกผ่า)
 *   ก้อนที่ยาวเกินบรรทัดจริงๆ ค่อยตัดตามขอบพยางค์ (ไม่ทิ้งสระ/วรรณยุกต์/สระนำไว้โดดเดี่ยว)
 *   บรรทัดที่ตัดต่อจะย่อหน้าตามบรรทัดแรก · ไม่แตะบรรทัดที่มีลิงก์/เส้นคั่น · เบอร์โทรไม่ถูกผ่า (LINE ทำเป็นลิงก์กดโทรได้)
 *  ทำซ้ำกี่รอบผลเท่าเดิม — ปรับความกว้างที่ LINE_WRAP_MAX_ (หน่วย ≈ อักษรไทย 1 ตัว; จอมือถือเล็กใช้ 22, จอใหญ่ใช้ 26)
 * ════════════════════════════════════════════════════════════ */
const LINE_WRAP_MAX_ = 24;

function lineCharWidth_(cp) {
  if (cp === 0x0E31 || (cp >= 0x0E34 && cp <= 0x0E3A) || (cp >= 0x0E47 && cp <= 0x0E4E)) return 0; // สระ/วรรณยุกต์ซ้อนบน-ล่าง
  if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0x2060 || (cp >= 0xFE00 && cp <= 0xFE0F)) return 0;
  if (cp >= 0x1F000 || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0x2B00 && cp <= 0x2BFF)) return 2; // อีโมจิ
  if (cp === 0x20) return 0.4;
  if (cp < 0x80) return 0.62; // ตัวเลข/อังกฤษ แคบกว่าไทย
  return 1;
}

function lineVisualWidth_(str) {
  var w = 0;
  Array.from(String(str)).forEach(function (ch) { w += lineCharWidth_(ch.codePointAt(0)); });
  return w;
}

/** พจนานุกรมคำไทยที่พบบ่อยในงานรถ/โรงพยาบาล — ใช้เลือกจุดตัดที่ "ไม่ผ่ากลางคำ" เมื่อก้อนข้อความไม่มีช่องว่างแต่ยาวเกินบรรทัด
 *  เพิ่มคำใหม่ได้ตามต้องการ (ไม่ต้องเรียงลำดับ) — คำที่ไม่อยู่ในรายการจะถูกตัดตามขอบพยางค์แทน */
const LINE_THAI_WORDS_ = ['โรงพยาบาล','ส่งเสริมสุขภาพ','สุขภาพ','ส่งเสริม','ตำบล','อำเภอ','จังหวัด','เชียงใหม่','เชียงราย','ลำพูน','ลำปาง','สันทราย','สันกำแพง','แม่ริม','หางดง','สารภี','ดอยสะเก็ด','แม่แตง','สันป่าตอง','ผู้ป่วย','รักษา','ส่งต่อ','ประชุม','อบรม','สัมมนา','ตรวจ','เยี่ยมบ้าน','เยี่ยม','บ้าน','ศูนย์','สำนักงาน','สาธารณสุข','มหาราช','นคร','มหาวิทยาลัย','วิทยาลัย','คณะ','แพทย์','พยาบาล','เจ้าหน้าที่','ราชการ','เอกสาร','พัสดุ','เวชภัณฑ์','วัคซีน','ฉีด','ชุมชน','หมู่บ้าน','ศึกษาดูงาน','ดูงาน','นิเทศ','ติดตาม','ประเมิน','รับรอง','มาตรฐาน','กรม','กระทรวง','โรงเรียน','เทศบาล','องค์การ','บริหาร','ส่วนตำบล','ส่วนท้องถิ่น','รับ','ส่ง','ไป','กลับ','ผู้','ขอ','ที่','และ','ของ','เพื่อ','ใน','นำ','งาน','การ','ประจำ','สภาพ','รถ','ยนต์','ตู้','กระบะ','เก๋ง','ซ่อม','บำรุง','ตรวจสอบ','ตรวจสภาพ','ศึกษา','ปฏิบัติ','สัมภาษณ์','รายงาน','ข้อมูล','ผู้บริหาร','รองผู้อำนวยการ','ผู้อำนวยการ','หัวหน้า','กลุ่ม','ภารกิจ','ผู้ขับ','ผู้ขอ','เวร','ลา','ศาล','ธนาคาร','ไปรษณีย์','คลัง','จังหวัด','เขต','สุขภาพจิต','ฟื้นฟู','ทันตกรรม','ห้องปฏิบัติการ','เลือด','ผ่าตัด','คลอด','เด็ก','ผู้สูงอายุ','ผู้พิการ','ผู้ติดเตียง','รพ.สต.','รพ.'];

/** หาจุดตัดที่ติดกับคำในพจนานุกรม (ตัดซ้ายสุด-ยาวสุดก่อน) — คืน Set ของ index ในอาร์เรย์ตัวอักษร */
function lineWordBreaks_(chars) {
  var set = {}, n = chars.length, i = 0, maxLen = 16;
  while (i < n) {
    var hit = 0;
    for (var L = Math.min(maxLen, n - i); L >= 2; L--) {
      if (LINE_THAI_WORDS_.indexOf(chars.slice(i, i + L).join('')) >= 0) { hit = L; break; }
    }
    if (hit) { if (i > 0) set[i] = true; if (i + hit < n) set[i + hit] = true; i += hit; } else { i++; }
  }
  return set;
}

function lineIsSafeBreak_(chars, b) {
  var c = chars[b].codePointAt(0), p = chars[b - 1].codePointAt(0);
  var start = (c >= 0x0E01 && c <= 0x0E2E) || (c >= 0x0E40 && c <= 0x0E44);
  var prevThai = p >= 0x0E01 && p <= 0x0E5B, prevLead = p >= 0x0E40 && p <= 0x0E44;
  return start && prevThai && !prevLead;
}

/** ตัดก้อนยาวที่ไม่มีช่องว่าง: ลำดับความสำคัญ 1) ขอบคำในพจนานุกรม 2) ขอบพยางค์ที่ปลอดภัย 3) ตัดตรงนั้น (เช่น ลิงก์/เบอร์ล้วน)
 *  และกัน "เศษโดดเดี่ยว" (บรรทัดสุดท้ายสั้นกว่า 3 หน่วย) โดยย้ายส่วนท้ายจากบรรทัดก่อนหน้ามาด้วย */
function lineSplitToken_(tok, firstAvail, restAvail) {
  var chars = Array.from(tok), wb = lineWordBreaks_(chars), out = [], cur = [], w = 0, avail = firstAvail;
  var lastWord = -1, lastWordW = 0, lastSyl = -1, lastSylW = 0;
  for (var i = 0; i < chars.length; i++) {
    var cw = lineCharWidth_(chars[i].codePointAt(0));
    if (cur.length && i > 0) {
      if (wb[i]) { lastWord = cur.length; lastWordW = w; }
      if (lineIsSafeBreak_(chars, i)) { lastSyl = cur.length; lastSylW = w; }
    }
    if (w + cw > avail && cur.length) {
      var cut = -1, cutW = 0;
      if (lastWord > 0 && lastWordW >= avail * 0.45) { cut = lastWord; cutW = lastWordW; }
      else if (lastSyl > 0) { cut = lastSyl; cutW = lastSylW; }
      else if (lastWord > 0) { cut = lastWord; cutW = lastWordW; }
      if (cut > 0 && cut < cur.length) { out.push(cur.slice(0, cut).join('')); cur = cur.slice(cut); w -= cutW; }
      else { out.push(cur.join('')); cur = []; w = 0; }
      avail = restAvail; lastWord = lastSyl = -1; lastWordW = lastSylW = 0;
    }
    cur.push(chars[i]); w += cw;
  }
  if (cur.length) out.push(cur.join(''));
  // กันเศษโดดเดี่ยวท้ายสุด
  if (out.length >= 2 && lineVisualWidth_(out[out.length - 1]) < 3) {
    var last = out[out.length - 1], pc = Array.from(out[out.length - 2]), need = 3 - lineVisualWidth_(last);
    for (var b = pc.length - 1; b >= 1; b--) {
      if (lineIsSafeBreak_(pc, b) && lineVisualWidth_(pc.slice(b).join('')) >= need) {
        out[out.length - 2] = pc.slice(0, b).join('');
        out[out.length - 1] = pc.slice(b).join('') + last;
        break;
      }
    }
  }
  return out;
}

function lineWrapLine_(line, max) {
  if (lineVisualWidth_(line) <= max) return [line];
  if (/https?:\/\//i.test(line) || line.indexOf('━') >= 0) return [line];
  var m = line.match(/^(\s*)([\s\S]*)$/), lead = m[1], body = m[2];
  var cont = lead + '   ', contW = lineVisualWidth_(cont), leadW = lineVisualWidth_(lead);
  var tokens = body.split(/ +/).filter(function (t) { return t !== ''; });
  var out = [], cur = lead, curW = leadW, curHas = false;
  function flush() { out.push(cur.replace(/\s+$/, '')); cur = cont; curW = contW; curHas = false; }
  tokens.forEach(function (tok) {
    var tw = lineVisualWidth_(tok), sp = curHas ? 0.4 : 0;
    if (curW + sp + tw <= max) { cur += (curHas ? ' ' : '') + tok; curW += sp + tw; curHas = true; return; }
    var onlyPrefix = curHas && (curW - leadW) <= 4.5;            // บรรทัดมีแค่อีโมจิ/ป้ายสั้นๆ — อย่าทิ้งไว้โดดเดี่ยว
    if (curHas && !(onlyPrefix && tw > max - contW)) flush();
    else if (curHas) { cur += ' '; curW += 0.4; }
    if (curW + tw <= max) { cur += tok; curW += tw; curHas = true; return; }
    var parts = lineSplitToken_(tok, max - curW, max - contW);   // ก้อนเดียวยาวเกินบรรทัด
    parts.forEach(function (p, i) {
      if (i > 0) flush();
      cur += p; curW += lineVisualWidth_(p); curHas = true;
    });
  });
  out.push(cur.replace(/\s+$/, ''));
  return out;
}

function lineWrapText_(text, max) {
  max = max || LINE_WRAP_MAX_;
  var out = [];
  String(text == null ? '' : text).split('\n').forEach(function (ln) {
    Array.prototype.push.apply(out, lineWrapLine_(ln, max));
  });
  return out.join('\n');
}

function lineWrapMessages_(messages) {
  return (messages || []).map(function (m) {
    return (m && m.type === 'text' && typeof m.text === 'string') ? Object.assign({}, m, { text: lineWrapText_(m.text) }) : m;
  });
}

function lineApiPost_(url, body) {
  if (body && body.messages) body = Object.assign({}, body, { messages: lineWrapMessages_(body.messages) }); // ✅ NEW: จัดบรรทัดสำหรับมือถือทุกข้อความ
  var _token = getActiveLineToken_(); // ✅ NEW: สลับไปใช้ token สำรองได้จาก linecontrol.html เมื่อ token หลักหมด/โควต้าหมด
  var call = lineLogCallBase_(url, body, _token); // ✅ FINAL: เตรียมข้อมูลสำหรับบันทึกประวัติการส่ง
  if (!_token) {
    console.warn('lineApiPost_: ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ของช่องทางที่กำลังใช้งานใน Script Properties');
    call.error = 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN ของช่องทางที่กำลังใช้งานใน Script Properties';
    lineLogRecord_(call);
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
    call.http = res.getResponseCode();
    call.ok = call.http < 300;
    if (!call.ok) {
      call.error = String(res.getContentText() || '').slice(0, 300);
      console.error('LINE API error ' + call.http + ': ' + res.getContentText());
    }
    try {
      var hdrs = res.getHeaders() || {};
      Object.keys(hdrs).forEach(function (k) { if (k.toLowerCase() === 'x-line-request-id') call.requestId = String(hdrs[k]); });
    } catch (_) {}
    lineLogRecord_(call);
    return res;
  } catch (err) {
    console.error('lineApiPost_:', err.message);
    call.error = String(err.message || err);
    lineLogRecord_(call);
    return null;
  }
}

/** lineReply_ — ตอบกลับ (ฟรี ไม่นับโควต้า)  meta (ไม่บังคับ): { trigger, key, label, roles, by } สำหรับบันทึกประวัติ */
function lineReply_(replyToken, messages, meta) {
  return lineLogRun_(meta || { trigger: 'richmenu', label: 'ตอบกลับ LINE' }, function () {
    return lineApiPost_('https://api.line.me/v2/bot/message/reply', { replyToken: replyToken, messages: messages });
  });
}

function linePush_(userId, messages) {
  return lineApiPost_('https://api.line.me/v2/bot/message/push', { to: userId, messages: messages });
}

/** lineMulticast_ — ส่งข้อความเดียวกันให้หลายคน (สูงสุด 500 คน/ครั้งตามข้อจำกัดของ LINE)
 *  ✅ FINAL: คืนค่าสรุป { ok, fail, error } (จำนวนผู้รับที่ส่งสำเร็จ/ล้มเหลว) — ผู้เรียกเดิมที่ไม่ใช้ค่าคืนยังทำงานได้เหมือนเดิม */
function lineMulticast_(userIds, messages) {
  var chunkSize = 500;
  var out = { ok: 0, fail: 0, error: '' };
  for (var i = 0; i < userIds.length; i += chunkSize) {
    var chunk = userIds.slice(i, i + chunkSize);
    var res = lineApiPost_('https://api.line.me/v2/bot/message/multicast', { to: chunk, messages: messages });
    if (res && res.getResponseCode() < 300) {
      out.ok += chunk.length;
    } else {
      out.fail += chunk.length;
      out.error = res ? String(res.getContentText() || '').slice(0, 300) : 'ไม่มีการตอบกลับจาก LINE API (ตรวจสอบ token/เครือข่าย)';
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════
//  2.1) ประวัติการส่ง LINE (ชีท LineSendLog) — ใช้กับแท็บ "ประวัติการส่ง" ใน linecontrol.html
//   • บันทึกอัตโนมัติ "หนึ่งแถวต่อหนึ่งการส่ง" จากจุดเดียวคือ lineApiPost_ (ครอบคลุมทุกที่ที่ยิง LINE API)
//   • token เก็บเฉพาะ 4 ตัวท้าย ไม่เก็บ token เต็ม
//   • เก็บย้อนหลังสูงสุดประมาณ 2,500 แถว (เกิน 2,750 จะลบแถวเก่าสุดทิ้ง)
//   • การบันทึกประวัติล้มเหลวจะไม่กระทบการส่ง LINE (ครอบ try/catch ทุกจุด)
// ════════════════════════════════════════════════════════════
const SHEET_LINE_SEND_LOG_ = 'LineSendLog';
const LINE_SEND_LOG_HEADERS_ = [
  'LogID', 'เวลา', 'สถานะ', 'บัญชี', 'Token (4 ตัวท้าย)', 'ที่มา', 'Key', 'ชื่อข้อความ', 'โหมด',
  'ผู้รับ (คน)', 'ข้อความ/คน', 'โควต้าที่ใช้', 'ยิง API (ครั้ง)', 'ล้มเหลว (ครั้ง)', 'บทบาท', 'สั่งโดย',
  'HTTP', 'Error', 'LINE Request ID', 'ตัวอย่างย่อ', 'ข้อความเต็ม'
];
const LINE_SEND_LOG_MAX_ROWS_  = 2500;
const LINE_SEND_LOG_TRIM_AT_   = 2750;
const LINE_SEND_LOG_TEXT_MAX_  = 45000; // เซลล์ Google Sheets เก็บได้สูงสุด 50,000 ตัวอักษร
var   LINE_LOG_CTX_ = null;             // บริบทของการส่งที่กำลังรวบรวม (หลาย API call → 1 แถว)

function getOrCreateLineSendLogSheet_() {
  return getOrCreateSheet(getSpreadsheet(), SHEET_LINE_SEND_LOG_, LINE_SEND_LOG_HEADERS_);
}

function lineLogTokenHint_(token) {
  return token ? ('…' + String(token).slice(-4)) : '';
}

function lineLogCallBase_(url, body, token) {
  var mode = url.indexOf('/multicast') >= 0 ? 'multicast' : (url.indexOf('/reply') >= 0 ? 'reply' : 'push');
  var msgs = (body && body.messages) || [];
  return {
    mode: mode,
    recipients: mode === 'multicast' ? ((body && body.to) || []).length : 1,
    messageCount: msgs.length,
    text: msgs.map(function (m) { return (m && m.type === 'text') ? String(m.text || '') : ''; }).join(''),
    channel: getActiveLineChannel_(),
    tokenHint: lineLogTokenHint_(token),
    ok: false, http: '', error: '', requestId: ''
  };
}

/** lineLogRun_ — รวบรวมทุก LINE API call ที่เกิดใน fn() ให้เป็น "แถวเดียว" ในประวัติ (ถ้าซ้อนกัน ตัวนอกสุดเป็นเจ้าของ)
 *  meta: { trigger:'auto|test|resend|resend-history|richmenu|editor|system', key, label, roles:[], by } */
function lineLogRun_(meta, fn) {
  if (LINE_LOG_CTX_) return fn();
  LINE_LOG_CTX_ = { meta: meta || {}, calls: [] };
  try {
    return fn();
  } finally {
    var ctx = LINE_LOG_CTX_;
    LINE_LOG_CTX_ = null;
    lineLogFlush_(ctx.meta, ctx.calls);
  }
}

function lineLogRecord_(call) {
  try {
    if (LINE_LOG_CTX_) LINE_LOG_CTX_.calls.push(call);
    else lineLogFlush_({ trigger: 'system' }, [call]); // ไม่มีบริบท (เช่น เรียกตรงจาก Editor) → แถวเดียวต่อ call
  } catch (e) { console.error('lineLogRecord_:', e.message); }
}

function lineLogFlush_(meta, calls) {
  try {
    if (!calls || !calls.length) return;
    meta = meta || {};
    var first = calls[0];
    var recipients = 0, quota = 0, fail = 0, errs = [], http = first.http, reqId = '', httpSet = false;
    calls.forEach(function (c) {
      recipients += c.recipients;
      if (c.ok) { if (c.mode !== 'reply') quota += c.recipients * c.messageCount; } // reply ไม่นับโควต้า
      else { fail++; if (c.error && errs.indexOf(c.error) < 0) errs.push(c.error); if (!httpSet) { http = c.http; httpSet = true; } }
      if (!reqId && c.requestId) reqId = c.requestId;
    });
    lineLogAppend_({
      status: fail ? 'ล้มเหลว' : 'สำเร็จ',
      channel: first.channel, tokenHint: first.tokenHint,
      trigger: meta.trigger || 'system', key: meta.key || '', label: meta.label || '',
      mode: first.mode, recipients: recipients, messageCount: first.messageCount, quota: quota,
      sends: calls.length, fail: fail,
      roles: (meta.roles || []).join ? (meta.roles || []).join(', ') : String(meta.roles || ''),
      by: meta.by || '', http: http, error: errs.join(' | ').slice(0, 500), requestId: reqId, text: first.text
    });
  } catch (e) { console.error('lineLogFlush_:', e.message); }
}

/** lineLogNoRecipient_ — บันทึกกรณี "ไม่มีผู้รับที่ตรงบทบาท" (ไม่ได้ยิง API เลย) */
function lineLogNoRecipient_(meta, roles, text) {
  try {
    meta = meta || {};
    var token = getActiveLineToken_();
    lineLogAppend_({
      status: 'ไม่มีผู้รับ', channel: getActiveLineChannel_(), tokenHint: lineLogTokenHint_(token),
      trigger: meta.trigger || 'system', key: meta.key || '', label: meta.label || '',
      mode: 'multicast', recipients: 0, messageCount: 0, quota: 0, sends: 0, fail: 0,
      roles: (roles || []).join(', '), by: meta.by || '', http: '', error: 'ไม่มีผู้รับ LINE ที่ตรงบทบาท', requestId: '', text: text || ''
    });
  } catch (e) { console.error('lineLogNoRecipient_:', e.message); }
}

function lineLogAppend_(o) {
  var sheet = getOrCreateLineSendLogSheet_();
  var now = new Date();
  var logId = 'LS' + Utilities.formatDate(now, 'Asia/Bangkok', 'yyMMddHHmmss') + ('00' + Math.floor(Math.random() * 1000)).slice(-3);
  var text = String(o.text || '');
  var stored = text.length > LINE_SEND_LOG_TEXT_MAX_ ? text.slice(0, LINE_SEND_LOG_TEXT_MAX_) : text;
  var preview = text.replace(/\s*\n\s*/g, ' ').slice(0, 140);
  var row = [
    logId, Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'), o.status, o.channel, o.tokenHint,
    o.trigger, o.key, o.label, o.mode, o.recipients, o.messageCount, o.quota, o.sends, o.fail,
    o.roles, o.by, o.http, o.error, o.requestId, preview, stored
  ];
  var r = sheet.getLastRow() + 1;
  var rng = sheet.getRange(r, 1, 1, row.length);
  rng.setNumberFormat('@'); // เก็บเป็นข้อความทั้งหมด กัน Sheets แปลงเวลา/ข้อความเป็นวันที่หรือสูตร
  rng.setValues([row]);
  var dataRows = r - 1;
  if (dataRows > LINE_SEND_LOG_TRIM_AT_) sheet.deleteRows(2, dataRows - LINE_SEND_LOG_MAX_ROWS_);
}

function lineLogStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss');
  return String(v == null ? '' : v);
}

/** แปลงแถว (คอลัมน์ 1–20) เป็นออบเจ็กต์ item ตามที่ linecontrol.html ใช้ */
function lineSendLogRowToItem_(r) {
  return {
    logId: lineLogStr_(r[0]), time: lineLogStr_(r[1]), status: lineLogStr_(r[2]),
    channel: lineLogStr_(r[3]) === 'backup' ? 'backup' : 'primary', tokenHint: lineLogStr_(r[4]),
    trigger: lineLogStr_(r[5]), key: lineLogStr_(r[6]), label: lineLogStr_(r[7]), mode: lineLogStr_(r[8]),
    recipients: Number(r[9]) || 0, messageCount: Number(r[10]) || 0, quota: Number(r[11]) || 0,
    sends: Number(r[12]) || 0, failCalls: Number(r[13]) || 0,
    roles: lineLogStr_(r[14]), by: lineLogStr_(r[15]), http: lineLogStr_(r[16]),
    error: lineLogStr_(r[17]), requestId: lineLogStr_(r[18]), preview: lineLogStr_(r[19])
  };
}

/** getLineSendHistory — payload: { limit, adminCode } → { items(ใหม่สุดก่อน), summary{month,today,primary,backup}, total } */
function getLineSendHistory(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };

  var sheet = getOrCreateLineSendLogSheet_();
  var n = sheet.getLastRow() - 1;
  var limit = Math.max(1, Math.min(1000, Number(payload && payload.limit) || 100));
  var now = new Date();
  var todayKey = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
  var monthKey = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM');
  var empty = function () { return { quota: 0, sends: 0, fail: 0 }; };
  var summary = { month: Utilities.formatDate(now, 'Asia/Bangkok', 'MM/yyyy'), today: empty(), primary: empty(), backup: empty() };
  if (n <= 0) return { status: 'ok', items: [], summary: summary, total: 0 };

  var rows = sheet.getRange(2, 1, n, 20).getValues(); // ไม่อ่านคอลัมน์ข้อความเต็ม เพื่อความเร็ว
  rows.forEach(function (r) {
    var it = lineSendLogRowToItem_(r);
    var add = function (b) { b.quota += it.quota; b.sends += it.sends; b.fail += it.failCalls; };
    if (it.time.indexOf(todayKey) === 0) add(summary.today);
    if (it.time.indexOf(monthKey) === 0) add(it.channel === 'backup' ? summary.backup : summary.primary);
  });
  var items = rows.slice(-limit).reverse().map(lineSendLogRowToItem_);
  return { status: 'ok', items: items, summary: summary, total: n };
}

/** หาแถวจาก logId → { rowNum, row(21 คอลัมน์) } หรือ null */
function findLineSendLogRow_(logId) {
  logId = String(logId || '').trim();
  if (!logId) return null;
  var sheet = getOrCreateLineSendLogSheet_();
  var n = sheet.getLastRow() - 1;
  if (n <= 0) return null;
  var ids = sheet.getRange(2, 1, n, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {
    if (lineLogStr_(ids[i][0]).trim() === logId) {
      var rowNum = i + 2;
      return { rowNum: rowNum, row: sheet.getRange(rowNum, 1, 1, 21).getValues()[0] };
    }
  }
  return null;
}

function lineSendLogDetailFromRow_(row) {
  var item = lineSendLogRowToItem_(row);
  var text = lineLogStr_(row[20]);
  var isFull = text.length > 0 && text.length < LINE_SEND_LOG_TEXT_MAX_;
  var targetRoles = item.roles ? item.roles.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  var canResend = isFull && (item.mode === 'push' || item.mode === 'multicast') && item.trigger !== 'richmenu' && targetRoles.length > 0;
  return {
    item: item, text: text || item.preview, isFull: isFull, canResend: canResend,
    targetRoles: targetRoles, recipientCount: canResend ? getLineUserIdsForKey_(item.key, targetRoles).length : 0
  };
}

/** getLineSendHistoryDetail — payload: { logId, adminCode } → ข้อความเต็ม + ข้อมูลประกอบการส่งซ้ำ */
function getLineSendHistoryDetail(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };
  var found = findLineSendLogRow_(payload && payload.logId);
  if (!found) return { status: 'error', message: 'ไม่พบรายการนี้ในประวัติ (อาจถูกลบเพราะเก่าเกินกำหนด)' };
  var d = lineSendLogDetailFromRow_(found.row);
  return { status: 'ok', item: d.item, text: d.text, isFull: d.isFull, canResend: d.canResend, targetRoles: d.targetRoles, recipientCount: d.recipientCount };
}

/** lineSendTextToRoles_ — ส่งข้อความ (แบ่งเป็นหลายข้อความถ้ายาว) ให้ทุกคนที่บทบาทตรง พร้อมบันทึกประวัติ */
function lineSendTextToRoles_(text, roles, meta) {
  var userIds = getLineUserIdsForKey_(meta && meta.key, roles || []); // ✅ NEW: รองรับการยกเว้นผู้รับรายคนตาม key
  if (!userIds.length) {
    lineLogNoRecipient_(meta, roles, text);
    return { status: 'error', message: 'ไม่พบผู้รับที่ตรงบทบาท (' + (roles || []).join(', ') + ') — ตรวจสอบคอลัมน์ "บทบาท" ในชีท LineUsers' };
  }
  var chunks = splitLineText_(String(text), 4500);
  var messages = chunks.slice(0, 5).map(function (t) { return { type: 'text', text: t }; }); // LINE จำกัด 5 ข้อความ/ครั้ง
  var r = lineLogRun_(meta, function () { return lineMulticast_(userIds, messages); });
  var quotaUsed = r.ok * messages.length;
  if (r.ok > 0 && !r.fail) return { status: 'ok', message: 'ส่งสำเร็จถึง ' + r.ok + ' คน (ใช้โควต้า LINE ' + quotaUsed + ' ข้อความ)' };
  if (r.ok > 0) return { status: 'ok', message: 'ส่งสำเร็จ ' + r.ok + '/' + userIds.length + ' คน (ล้มเหลว ' + r.fail + ' คน: ' + r.error + ')' };
  return { status: 'error', message: 'ส่งไม่สำเร็จ: ' + (r.error || 'ไม่ทราบสาเหตุ — ตรวจสอบ token') };
}

/** resendLineFromHistory — ส่ง "ข้อความตัวเดิมเป๊ะ" จากประวัติซ้ำอีกครั้ง ไปยังบทบาทเดิม (ผู้รับที่ลงทะเบียนอยู่ ณ ตอนนี้) payload: { logId, adminCode } */
function resendLineFromHistory(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };
  var found = findLineSendLogRow_(payload && payload.logId);
  if (!found) return { status: 'error', message: 'ไม่พบรายการนี้ในประวัติ' };
  var d = lineSendLogDetailFromRow_(found.row);
  if (!d.canResend) return { status: 'error', message: 'รายการนี้ส่งซ้ำไม่ได้ (ไม่มีข้อความเต็ม หรือเป็นข้อความตอบสด/ไม่มีบทบาทผู้รับ)' };
  var res = lineSendTextToRoles_(d.text, d.targetRoles, {
    trigger: 'resend-history', key: d.item.key, label: d.item.label, roles: d.targetRoles, by: 'แอดมิน'
  });
  logApiAccess_('resendLineFromHistory:' + d.item.logId, String((payload && payload.clientIp) || 'unknown'), res.status === 'ok', '', '');
  return res;
}

function lineCatalogItem_(key) {
  for (var i = 0; i < LINE_MESSAGE_CATALOG_.length; i++) if (LINE_MESSAGE_CATALOG_[i].key === key) return LINE_MESSAGE_CATALOG_[i];
  return null;
}

/** resendLineMessageByKey — สร้างข้อความใหม่จากข้อมูลล่าสุดแล้วส่งจริงให้ทุกคนที่บทบาทตรง payload: { key, adminCode } */
function resendLineMessageByKey(payload) {
  var chk = checkAdminCode_(payload);
  if (!chk.ok) return { status: 'error', message: chk.message };
  var key = String((payload && payload.key) || '').trim();
  var cat = lineCatalogItem_(key);
  if (!cat) return { status: 'error', message: 'ไม่พบข้อความนี้ในระบบ' };
  var text = buildLineMessageByKey_(key);
  if (text == null) return { status: 'error', message: 'ไม่พบข้อความนี้ในระบบ' };
  var res = lineSendTextToRoles_(text, cat.roles, { trigger: 'resend', key: key, label: cat.label, roles: cat.roles, by: 'แอดมิน' });
  res.preview = text;
  logApiAccess_('resendLine:' + key, String((payload && payload.clientIp) || 'unknown'), res.status === 'ok', '', '');
  return res;
}

/** sendReportToAllChannels_ — ส่งรายงานออกทาง LINE (เฉพาะผู้ที่บทบาทตรงกับ targetRoles) + อีเมล (REPORT_EMAILS)
 *  @param {string[]} targetRoles - บทบาทที่ควรได้รับรายงานนี้ (เช่น [LINE_ROLE_ADMIN, LINE_ROLE_DEPUTY])
 *                                   ต้องระบุเสมอ เพื่อให้ตรงกับตารางสิทธิ์รับรายงานของแต่ละบทบาท — อีเมลยังส่งให้ REPORT_EMAILS ตามเดิมทุกกรณี (ไม่แยกบทบาท)
 *  @param {Object} [meta] - ✅ FINAL: ข้อมูลสำหรับบันทึกประวัติ { trigger:'auto'|'editor', key, label } (ไม่ใส่ = บันทึกเป็น 'auto') */
function sendReportToAllChannels_(lineText, emailSubject, emailBody, targetRoles, meta) {
  var results = { line: { sent: 0, error: '' }, email: { sent: 0, error: '' } };

  // ── LINE (ส่งเฉพาะบทบาทที่กำหนด) ──
  try {
    var userIds = getLineUserIdsByRoles_(targetRoles || []);
    if (userIds.length > 0) {
      // ข้อความ LINE จำกัดความยาว/จำนวนต่อครั้ง — ตัดแบ่งถ้ายาวเกิน
      var chunks = splitLineText_(lineText, 4500);
      var messages = chunks.slice(0, 5).map(function (t) { return { type: 'text', text: t }; }); // LINE จำกัด 5 ข้อความ/ครั้ง
      var logMeta = { trigger: (meta && meta.trigger) || 'auto', key: (meta && meta.key) || '', label: (meta && meta.label) || '', roles: targetRoles || [], by: 'ระบบ' };
      var mc = lineLogRun_(logMeta, function () { return lineMulticast_(userIds, messages); });
      results.line.sent = mc.ok;
      if (mc.fail) results.line.error = 'ส่ง LINE ไม่สำเร็จ ' + mc.fail + ' คน: ' + mc.error;
    } else {
      results.line.error = 'ยังไม่มีผู้รับ LINE ที่ตรงบทบาท (' + (targetRoles || []).join(', ') + ') — ตรวจสอบคอลัมน์ "บทบาท" ในชีท LineUsers';
      console.warn(results.line.error);
      lineLogNoRecipient_({ trigger: (meta && meta.trigger) || 'auto', key: (meta && meta.key) || '', label: (meta && meta.label) || '', by: 'ระบบ' }, targetRoles, lineText);
    }
  } catch (lineErr) {
    results.line.error = lineErr.message;
    console.error('sendReportToAllChannels_ (LINE):', lineErr);
  }

  // ── Email ──
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
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}
