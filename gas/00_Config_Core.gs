// ============================================================
//  Code.gs — SAND (Sansai Administration Network Drive)
//  ระบบบริหารจัดการยานพาหนะ โรงพยาบาลสันทราย
//  Version : 2.0  |  ปรับปรุง : 2025-05
//  แก้ไข:
//    - headerToKey ตรงกับ frontend (ทุก key)
//    - getCheckData ส่ง inspDate เป็น yyyy-MM-dd เสมอ
//    - updateVehicleStatus ใช้ column index ที่ถูกต้อง (1-indexed)
//    - endMile: fuzzy match แบบ robust
//    - getStatusSummary: แก้ match logic
//    - ✅ FINAL: เพิ่มระบบประวัติการส่ง LINE (ชีท LineSendLog) + action getLineSendHistory /
//      getLineSendHistoryDetail / resendLineFromHistory / resendLineMessageByKey ให้ตรงกับ linecontrol.html
//      และเพิ่มฟิลด์ recipientCount ใน getLineMessageCatalog
// ============================================================

// ── GLOBAL CONFIG ────────────────────────────────────────────
// ✅ ย้ายค่ามาอ่านจาก Script Properties แทนการฝังไว้ในซอร์สโค้ดตรงๆ
//    ตั้งค่าที่ Apps Script Editor → Project Settings → Script Properties
//    key ที่ต้องตั้ง: SS_ID, DRIVE_FOLDER, LINE_TOKEN (ถ้าใช้), NOTIFY_EMAIL (ถ้าใช้)
//    (API_KEY ตั้งไว้แล้วตามเดิม ไม่เกี่ยวกับส่วนนี้)
const SCRIPT_PROPS_ = PropertiesService.getScriptProperties();
const SS_ID         = SCRIPT_PROPS_.getProperty('SS_ID')        || '';
const DRIVE_FOLDER  = SCRIPT_PROPS_.getProperty('DRIVE_FOLDER') || '';
const LINE_TOKEN    = SCRIPT_PROPS_.getProperty('LINE_TOKEN')   || '';
const NOTIFY_EMAIL  = SCRIPT_PROPS_.getProperty('NOTIFY_EMAIL') || '';

const SHEET_CHECK   = 'CheckLog';
const SHEET_MILE    = 'MileLog';
const SHEET_EMS     = 'EMSLog';
const SHEET_VEHICLE = 'Vehicles';
const SHEET_CONFIG  = 'Config';
const SHEET_LOCATIONS = 'Locations'; // ✅ NEW: จุดหมายปลายทางที่ปักหมุดพิกัดไว้ สำหรับหน้าแผนที่เส้นทาง (routemap.html)
const SHEET_MILE_GAP_DETAIL = 'รายงานไมล์หาย_ละเอียด'; // ✅ NEW: ชีทสูตรคำนวณไมล์หายแบบเรียลไทม์ (ใช้แทนการคำนวณเองใน getMileAnomalies)
const MILE_GAP_EXCLUDE_PLATES = []; // ทะเบียนรถที่ไม่ต้องแสดงในรายงาน (เทียบแบบ contains) — ปัจจุบันว่าง = แสดงทุกคัน รวม นง.8781 ชม. ในรายงาน LINE/อีเมล ถ้าต้องการซ่อนรถคันใดให้ใส่เลขทะเบียน เช่น ['8781']

// ── RELOAD SIGNAL: broadcast key สำหรับให้หน้า startmile/check รีเฟรชอัตโนมัติ ──
const RELOAD_KEY_MILE  = 'RELOAD_SIGNAL_MILE';   // bump เมื่อ startMile/endMile สำเร็จ
const RELOAD_KEY_CHECK = 'RELOAD_SIGNAL_CHECK';  // bump เมื่อ saveCheck สำเร็จ

// ============================================================
//  ⚡ PERFORMANCE LAYER (v2.1)
//  - CacheService: แคชผล read-heavy (getStatusSummary / getInitData / getMileData)
//    โดยใช้ "เลขเวอร์ชันข้อมูล" (DV) — ทุกครั้งที่มี write action จะ bump DV
//    แคชเก่าจึงใช้ไม่ได้ทันที (ข้อมูลสดเสมอหลังบันทึก)
//  - AccessLog: ข้าม log ของ action อ่านอย่างเดียวที่ถูกเรียกถี่ (poll ทุก 20-30 วิ)
// ============================================================
const ACCESS_LOG_SKIP_ACTIONS_ = {
  getReloadSignal:1, getCheckBootstrap:1, getInitData:1, getStatusSummary:1, getMileData:1, getStartMileBootstrap:1,
  getTodayCheckedPlates:1, getVehicles:1, getDrivers:1, getConfig:1, getMileAnomalies:1,
  getData:1, getEMSData:1, getLastMile:1, getActiveTripByPlate:1, getTodayCheck:1,
  getSchedule:1, getScheduleNext:1, getTodayDuty:1, getJobAssignments:1, getLocationPins:1
};
let __ACTION_ = 'get';   // ตั้งใน doPostCore_ — ใช้ตัดสินว่าต้อง invalidate แคชหรือไม่

function dataVer_() {
  const c = CacheService.getScriptCache();
  let v = c.get('DV');
  if (!v) { v = String(Date.now()); c.put('DV', v, 21600); }
  return v;
}
function invalidateDataCache_() {
  try { CacheService.getScriptCache().put('DV', String(Date.now()), 21600); } catch (e) {}
}

// cached_ — แคช JSON ขนาดใหญ่ (แบ่ง chunk ละ ≤ 30,000 ตัวอักษร เพราะจำกัด 100KB/ค่า และไทย = 3 byte/ตัว)
function cached_(name, ttlSec, fn) {
  const c   = CacheService.getScriptCache();
  const key = name + ':' + dataVer_();
  try {
    const meta = c.get(key);
    if (meta) {
      const n = parseInt(meta, 10);
      if (n > 0) {
        const keys = []; for (let i = 0; i < n; i++) keys.push(key + '#' + i);
        const got = c.getAll(keys);
        let txt = '', ok = true;
        for (let i = 0; i < n; i++) { const p = got[key + '#' + i]; if (p == null) { ok = false; break; } txt += p; }
        if (ok) return JSON.parse(txt);
      }
    }
  } catch (e) {}
  const result = fn();
  try {
    if (result && result.status === 'ok') {
      const txt = JSON.stringify(result), CH = 30000, parts = [];
      for (let i = 0; i < txt.length; i += CH) parts.push(txt.substring(i, i + CH));
      if (parts.length > 0 && parts.length <= 25) {
        const obj = {}; parts.forEach(function (p, i) { obj[key + '#' + i] = p; });
        obj[key] = String(parts.length);
        c.putAll(obj, ttlSec);
      }
    }
  } catch (e) {}
  return result;
}

// อ่านเฉพาะ "แถวที่ต้องใช้" ของชีทใหญ่ — แทน getDataRange().getValues() ทั้งชีท
//  probeIdx: index คอลัมน์ (0-based) ที่ใช้ตัดสินใจ,  pick(vals[], i) → true = ต้องการแถวนี้
//  fmlCols : [colIdx...] ที่ต้องการ formula (เช่น HYPERLINK) — คืนใน formulas[] ที่ index ตรงกับ values
function readRowsSubset_(sheet, probeIdx, pick, fmlCols) {
  const lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  const header  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const outRows = [header], outFml = [[]];
  if (lastRow < 2) return { rows: outRows, formulas: outFml };
  const n = lastRow - 1;
  const probes = probeIdx.map(function (ci) { return sheet.getRange(2, ci + 1, n, 1).getValues(); });
  const need = [];
  for (let i = 0; i < n; i++) {
    const vals = probes.map(function (p) { return p[i][0]; });
    if (pick(vals, i)) need.push(i + 2);
  }
  if (!need.length) return { rows: outRows, formulas: outFml };
  // รวมแถวติดกัน (ยอมช่องว่าง ≤ 3 แถว) เป็นช่วงเดียว
  let ranges = [], r0 = need[0], r1 = need[0];
  for (let k = 1; k < need.length; k++) {
    if (need[k] - r1 <= 4) r1 = need[k]; else { ranges.push([r0, r1]); r0 = r1 = need[k]; }
  }
  ranges.push([r0, r1]);
  if (ranges.length > 15) ranges = [[2, lastRow]];   // กระจัดกระจายมาก → อ่านทีเดียว
  const fc = (fmlCols || []).filter(function (c) { return c < lastCol; });
  const fMin = fc.length ? Math.min.apply(null, fc) : 0, fMax = fc.length ? Math.max.apply(null, fc) : -1;
  ranges.forEach(function (rg) {
    const len = rg[1] - rg[0] + 1;
    const vals = sheet.getRange(rg[0], 1, len, lastCol).getValues();
    const fmls = fc.length ? sheet.getRange(rg[0], fMin + 1, len, fMax - fMin + 1).getFormulas() : null;
    for (let i = 0; i < len; i++) {
      outRows.push(vals[i]);
      const f = new Array(lastCol).fill('');
      if (fmls) for (let j = 0; j < fmls[i].length; j++) f[fMin + j] = fmls[i][j];
      outFml.push(f);
    }
  });
  return { rows: outRows, formulas: outFml };
}

// ลิตร/ราคา ที่เติมจริงของทริป (รวมขาไป + ขากลับ) — ข้าม marker 'auto'
function fuelNums_(row, iL, iP, iRL, iRP) {
  const n = function (v) { const x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return x > 0 ? x : 0; };
  const l = n(row[iL]) + (iRL >= 0 ? n(row[iRL]) : 0);
  const p = n(row[iP]) + (iRP >= 0 ? n(row[iRP]) : 0);
  return { liters: l ? String(Math.round(l * 100) / 100) : '', price: p ? String(Math.round(p * 100) / 100) : '' };
}

// ── CORS HELPER ──────────────────────────────────────────────
function corsOutput(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Monitor (SAND Tools) ----------
 * ส่งบันทึกไป https://sandtools.vercel.app — ห้ามใส่ข้อมูลส่วนบุคคล (ชื่อ พขร./ทะเบียน/LINE userId) ใน message
 * level: info | warn | error · o = { task, status: 'start'|'ok'|'fail', ms } */
function sandLog(level, message, o) {
  try {
    UrlFetchApp.fetch('https://sandtools.vercel.app/api/collect', { method: 'post', contentType: 'text/plain', muteHttpExceptions: true,
      payload: JSON.stringify({ k: 'prnskn2arc', t: 'lg', h: 'developedsystemsansai.github.io', c: o && o.task ? 'tk' : 'lg', v: level,
        m: String(message == null ? '' : message).slice(0, 300), e: o && o.task, s: o && o.status, d: o && o.ms }) });
  } catch (e) { /* บันทึกไม่สำเร็จต้องไม่ทำให้งานหลักล้ม */ }
}
/* ห่อฟังก์ชันตั้งเวลา: จับเวลา + รายงานสำเร็จ/ล้มเหลว แล้วโยน error ต่อตามเดิม
 * ถ้าฟังก์ชันคืนค่า { status: 'error', message } (ไม่ throw) ก็นับเป็นล้มเหลว */
function sandRun_(task, fn) {
  var t0 = Date.now();
  try {
    var r = fn();
    if (r && typeof r === 'object' && r.status === 'error') sandLog('error', String(r.message || 'error'), { task: task, status: 'fail', ms: Date.now() - t0 });
    else sandLog('info', task + ' เสร็จ', { task: task, status: 'ok', ms: Date.now() - t0 });
    return r;
  } catch (e) { sandLog('error', String(e && e.message || e), { task: task, status: 'fail', ms: Date.now() - t0 }); throw e; }
}

// ── ACCESS LOG: เก็บ log ทุก request ที่เข้ามา (ไม่ต้อง login เก็บแค่ IP) ──
// ⚠️ IP นี้มาจาก client เอง (ดู secure-fetch.js ฝั่ง frontend) เป็น best-effort ไม่ใช่หลักฐานสำหรับ auth
// (ข้อจำกัดของแพลตฟอร์ม GAS: request ตรงไม่มี client IP ให้อ่านได้)
// ✅ NEW: เพิ่มคอลัมน์ผู้บันทึก + ทะเบียนรถ ให้จับคู่กับ IP ได้ตรงๆ ไม่ต้องเดาจากเวลา
const SHEET_ACCESS_LOG = 'AccessLog';
const ACCESS_LOG_HEADERS = ['Timestamp', 'Action', 'ClientIP', 'Authorized', 'ผู้บันทึก', 'ทะเบียน/รถ'];

function logApiAccess_(action, clientIp, authorized, driverName, plateInfo) {
  try {
    // ⚡ ข้าม log ของ action อ่านอย่างเดียวที่ถูกเรียกถี่ (ที่ผ่านการยืนยัน) — ลดเวลาตอบสนองต่อ request ลง ~0.3-1 วิ
    //    request ที่ไม่ผ่านการยืนยัน และ action เขียนข้อมูลทุกตัว ยัง log ครบเหมือนเดิม
    if (authorized && ACCESS_LOG_SKIP_ACTIONS_[String(action || '')]) return;
    const ss = getSpreadsheet();
    const cache = CacheService.getScriptCache();
    let sheet;
    if (cache.get('ACCESSLOG_READY')) {
      sheet = ss.getSheetByName(SHEET_ACCESS_LOG);
    }
    if (!sheet) {
      sheet = getOrCreateSheet(ss, SHEET_ACCESS_LOG, ACCESS_LOG_HEADERS);
      // self-heal: ถ้าชีทถูกสร้างไว้ก่อนหน้านี้ด้วย header ชุดเก่า (4 คอลัมน์) ให้เติมคอลัมน์ใหม่ให้อัตโนมัติ
      ensureExtraColumn(sheet, 'ผู้บันทึก');
      ensureExtraColumn(sheet, 'ทะเบียน/รถ');
      cache.put('ACCESSLOG_READY', '1', 21600);
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sheet.appendRow([
      now, String(action || '(no action)'), String(clientIp || 'unknown'), authorized ? 'ok' : 'fail',
      String(driverName || ''), String(plateInfo || '')
    ]);
  } catch (err) {
    console.error('logApiAccess_ error:', err.message);
  }
}

// ── LOCK HELPER: ห่อสำหรับ action ที่เขียนข้อมูลซ้อนกัน (startMile/endMile) ──
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
  } catch (e) {
    return { status: 'error', message: 'ระบบกำลังประมวลผลรายการอื่นอยู่ กรุณาลองใหม่อีกครั้ง' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ── ROUTER: doGet ────────────────────────────────────────────
// ── API KEY AUTH ─────────────────────────────────────────────
// ตั้งค่า API_KEY ใน GAS: Project Settings → Script Properties
// เพิ่ม key: API_KEY  value: (uuid หรือ string สุ่มยาวๆ)
function isAuthorized(e) {
  const storedKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
  // 🔒 FAIL-CLOSED: ถ้ายังไม่ได้ตั้ง API_KEY ให้ปฏิเสธทุก request เสมอ (เดิม fail-open ช่องโหว่หากลืมตั้งค่า)
  if (!storedKey) return false;

  // GET: ?apikey=...
  const fromParam = (e && e.parameter && e.parameter.apikey) || '';

  // ✅ FIX: อ่าน apikey จาก postData.contents ก่อน (ไม่มี per-param size limit)
  // เดิมอ่านจาก e.parameter.payload ซึ่ง GAS ตัดทิ้งเมื่อ payload > ~2KB
  // → เมื่อส่งรูปใหญ่ isAuthorized() ได้ apikey = '' → return false → "Unauthorized"
  const fromBody = (() => {
    try {
      const bodyRaw = (e && e.postData && e.postData.contents) || '';
      if (!bodyRaw) return '';
      let jsonStr = '';
      if (bodyRaw.trim().startsWith('{')) {
        jsonStr = bodyRaw; // raw JSON body
      } else {
        // form-urlencoded: "payload=%7B...%7D"
        const m = bodyRaw.match(/(?:^|&)payload=([^&]*)/);
        jsonStr = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
      }
      return jsonStr ? (JSON.parse(jsonStr).apikey || '') : '';
    } catch(_) { return ''; }
  })();

  // fallback: e.parameter.payload (ใช้ได้เฉพาะ request ขนาดเล็ก)
  const fromPayload = (!fromBody && e && e.parameter && e.parameter.payload)
    ? (() => { try { return JSON.parse(e.parameter.payload).apikey || ''; } catch(_) { return ''; } })()
    : '';

  const provided = fromParam || fromBody || fromPayload;
  return provided === storedKey;
}
