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

function doGet(e) {
  const clientIp = (e && e.parameter && e.parameter.clientIp) || 'unknown';
  const action = (e && e.parameter && e.parameter.action) || '';
  // ✅ GET ส่วนใหญ่เป็น query อ่านข้อมูล ไม่มีผู้บันทึกโดยตรง — ใส่เท่าที่มีติดมากับ query string
  const gDriverName = (e && e.parameter && e.parameter.driverName) || '';
  const gPlateInfo  = (e && e.parameter && (e.parameter.carType || e.parameter.plate)) || '';
  try {
    const authorized = isAuthorized(e);
    logApiAccess_(action, clientIp, authorized, gDriverName, gPlateInfo); // 🔒 log ทุก request ที่เข้ามา ไม่ต้อง login
    if (!authorized) {
      return corsOutput({ status: 'error', message: 'Unauthorized' });
    }
    switch (action) {
      case 'getData':               return corsOutput(getCheckData());
      case 'getMileData':           return corsOutput(getMileData(e.parameter));
      case 'getEMSData':            return corsOutput(getEMSData());
      case 'getInitData':           return corsOutput(getInitData());  // vehicles+drivers+config ใน 1 call
      case 'getStartMileBootstrap': return corsOutput(getStartMileBootstrap(e.parameter));
      case 'getCheckBootstrap':     return corsOutput(getCheckBootstrap());
      case 'getVehicles':           return corsOutput(getVehicles());
      case 'getDrivers':            return corsOutput(getDrivers());
      case 'getConfig':             return corsOutput(getConfig());
      case 'getTodayCheck':         return corsOutput(getTodayCheck(e.parameter.carType));
      case 'getLastMile':           return corsOutput(getLastMile(e.parameter.carType));
      case 'getTodayCheckedPlates': return corsOutput(getTodayCheckedPlates());
      case 'getStatusSummary':      return corsOutput(getStatusSummary());
      case 'getActiveTripByPlate':  return corsOutput(getActiveTripByPlate(e.parameter.plate));
      // 🔒 resetDailyStatus ถูกปิดจาก GET URL แล้ว — ใช้ได้แค่ Time Trigger (scheduledDailyReset) เท่านั้น
      // case 'resetDailyStatus':   return corsOutput(resetDailyStatus());
      case 'authorizeUpload':       return corsOutput(authorizeUpload());
      case 'getDriveFolder':        return corsOutput(getDriveFolderInfo());
      case 'uploadFuelPhoto':       return corsOutput(uploadFuelPhotoFromGet(e.parameter));
      case 'getLatestPhotoUrl':     return corsOutput(getLatestPhotoUrl(e.parameter.carType, e.parameter.inspDate));
      case 'getRepairJobs':         return corsOutput(getRepairJobs());
      case 'getLocationPins':       return corsOutput(getLocationPins());
      case 'getSatisfactionData':   return corsOutput(getSatisfactionData(e.parameter));
      case 'getCarTripsForSatisfaction': return corsOutput(getCarTripsForSatisfaction(e.parameter)); // QR รายคัน: สถานะรถ + เที่ยววิ่ง
      case 'getSatisfactionReport':  return corsOutput(getSatisfactionReport(e.parameter));   // Dashboard ผู้บริหาร: คะแนนรายเที่ยว/ผู้ขับ/รถ
      case 'getFeedbackData':       return corsOutput(getFeedbackData(e.parameter));
      case 'setupSheets':           return corsOutput(setupAllSheets());
      case 'getSchedule':           return corsOutput(getWorktableSchedule());
      case 'getScheduleNext':       return corsOutput(getWorktableScheduleNext());
      case 'getTodayDuty':          return corsOutput(getWorktableTodayDuty());
      case 'getJobAssignments':     return corsOutput(getJobAssignments(e.parameter));
      case 'verifyDriverPhone':     return corsOutput(verifyDriverPhone(e.parameter));
      case 'getReloadSignal':       return corsOutput(getReloadSignal());
      case 'fixStaleFuelStatus':    return corsOutput(fixStaleFuelStatus());
      case 'fixFuelStationMarkers': return corsOutput(fixFuelStationMarkers());
      case 'getPendingMileEdits':   return corsOutput(getPendingMileEdits());
      case 'getMileAnomalies':      return corsOutput(getMileAnomalies());
      case 'getFuelBacklog':        return corsOutput(getFuelBacklog(e.parameter));
      // ── ระบบแลกเวร พขร. (swap.html) ──────────────────────────────
      case 'getSwapStaffList':      return corsOutput(getSwapStaffList());
      case 'getMyShiftDays':        return corsOutput(getMyShiftDays(e.parameter));
      case 'getPendingSwapRequests':return corsOutput(getPendingSwapRequests());
      case 'getSwapHistory':        return corsOutput(getSwapHistory(e.parameter));
      case 'checkSwapConflicts':    return corsOutput(checkSwapConflicts(e.parameter));
      case 'getSwapReportAvailableMonths': return corsOutput(getSwapReportAvailableMonths());
      case 'getSwapMonthlyReport':  return corsOutput(getSwapMonthlyReport(e.parameter));
      // ── ระบบควบคุม LINE (linecontrol.html) ──────────────────────
      case 'getLineChannelStatus':  return corsOutput(getLineChannelStatus());
      case 'getLineMessageCatalog':   return corsOutput(getLineMessageCatalog());
      case 'getLineMessageTemplates': return corsOutput(getLineMessageTemplates());
      case 'getLineUsersForAdmin':    return corsOutput(getLineUsersForAdmin());
      case 'getLineReportSchedule':   return corsOutput(getLineReportScheduleAll());
      // ── รายงานประจำเดือน (PDF) บน Google Drive (dashboard.html) ──
      case 'getMonthlyReports':       return corsOutput(listMonthlyReports());
      case 'getMonthlyReportFile':    return corsOutput(getMonthlyReportFile(e.parameter));
      default:
        return corsOutput({ status: 'ok', message: 'SAND API v2.0' });
    }
  } catch (err) {
    return corsOutput({ status: 'error', message: err.message });
  }
}

// ── ROUTER: doPost ────────────────────────────────────────────
function doPost(e) {
  __ACTION_ = 'get';
  const out = doPostCore_(e);
  // write action ทุกตัว (ไม่ขึ้นต้นด้วย get) → ทำให้แคชข้อมูลเก่าใช้ไม่ได้ทันที
  if (!/^get/.test(String(__ACTION_ || ''))) invalidateDataCache_();
  return out;
}

function doPostCore_(e) {
  var payload;
  try {
    // ✅ FIX: อ่าน e.postData.contents ก่อนเสมอสำหรับ POST request
    // เหตุผล: เมื่อ Content-Type = application/x-www-form-urlencoded, GAS จะ parse body
    //   ลงใน e.parameter โดยอัตโนมัติ — แต่ GAS มี hard limit ~2,000-3,000 bytes ต่อ parameter
    //   รูป 1MB+ → base64 ~1.4MB → encodeURIComponent → e.parameter.payload ถูกตัดกลางคัน
    //   → JSON.parse error หรือ base64Data ขาดหาย → upload ล้มเหลวแบบสุ่ม
    // วิธีแก้: อ่านจาก e.postData.contents (body ดิบ) ก่อน ซึ่งไม่มี per-param limit
    //   รองรับทั้ง: Content-Type text/plain (JSON ดิบ) และ form-urlencoded
    var raw = '';
    try {
      var bodyRaw = (e && e.postData && e.postData.contents) || '';
      if (bodyRaw) {
        // ลอง parse เป็น JSON ตรงๆ ก่อน (กรณี Content-Type: text/plain หรือ application/json)
        if (bodyRaw.trim().startsWith('{')) {
          raw = bodyRaw;
        } else {
          // form-urlencoded: body = "payload=<encoded>"  หรือ เพิ่งแค่ encoded JSON
          var m = bodyRaw.match(/(?:^|&)payload=([^&]*)/);
          if (m) {
            raw = decodeURIComponent(m[1].replace(/\+/g, ' '));
          } else {
            // ลอง decode ทั้ง body เผื่อ frontend ส่ง URL-encoded JSON ล้วนๆ โดยไม่มี key
            try { raw = decodeURIComponent(bodyRaw.replace(/\+/g, ' ')); } catch(_) { raw = bodyRaw; }
          }
        }
      }
    } catch(_) {}
    // fallback: e.parameter.payload (ใช้ได้กับ payload ขนาดเล็ก เช่น non-photo requests)
    if (!raw) { try { raw = e.parameter.payload || ''; } catch(_) {} }
    if (!raw) return corsOutput({ status: 'error', message: 'ไม่มีข้อมูล payload' });
    payload = JSON.parse(raw);
  } catch (parseErr) {
    console.error('doPost parse error:', parseErr, 'raw:', String(e && e.postData && e.postData.contents).slice(0,200));
    sandLog('warn', 'doPost parse error: ' + parseErr.message, null);
    return corsOutput({ status: 'error', message: 'parse error: ' + parseErr.message });
  }
  if (!payload || typeof payload !== 'object') {
    return corsOutput({ status: 'error', message: 'payload ไม่ถูกต้อง' });
  }

  // ── LINE WEBHOOK: เช็คก่อนทุกอย่าง ──
  // Webhook ของ LINE Official Account ถูกชี้ไปที่ URL เดียวกับ API ของระบบนี้ (ดูภาพ Messaging API settings)
  // LINE จะส่ง JSON รูปแบบ { destination, events:[...] } ซึ่งไม่มี action/apikey → ต้องดักออกมาจัดการก่อนถึงขั้น isAuthorized()
  // ✅ หมายเหตุ: Apps Script web app ไม่สามารถอ่าน HTTP header (X-Line-Signature) ได้ จึงข้ามการตรวจลายเซ็นตามมาตรฐานของ LINE
  //   (ความเสี่ยงต่ำ เพราะ URL นี้เดาสยาก และเป็น endpoint อ่านอย่างเดียวเท่านั้น ไม่มีทางเขียนข้อมูลอื่นๆ)
  if (payload.events && Array.isArray(payload.events)) {
    try { handleLineWebhookEvents_(payload.events); } catch (lineErr) { console.error('LINE webhook error:', lineErr); }
    return corsOutput({ status: 'ok' }); // LINE ต้องได้ 200 OK เสมอ ไม่งั้นจะขึ้น error ใน LINE Developers Console
  }

  var clientIp = String(payload.clientIp || 'unknown');
  var action   = payload.action || 'saveCheck';
  __ACTION_ = action;
  // ✅ NEW: ดึงชื่อผู้บันทึก + ทะเบียนรถจาก payload มาบันทึกคู่กับ IP ใน AccessLog
  var pDriverName = payload.driverName || '';
  var pPlateInfo  = payload.carType || payload.plate || '';
  try {
    var authorized = isAuthorized(e);
    logApiAccess_(action, clientIp, authorized, pDriverName, pPlateInfo); // 🔒 log ทุก request ที่เข้ามา ไม่ต้อง login
    if (!authorized) {
      return corsOutput({ status: 'error', message: 'Unauthorized' });
    }
    console.log('doPost action=' + action);
    switch (action) {
      case 'saveCheck':
      case 'saveInspection':      return corsOutput(saveCheck(payload));
      case 'uploadPhotos':
      case 'saveCheckPhotos':
      case 'uploadFuelPhotos':    return corsOutput(savePhotos(payload));
      case 'uploadPhotoPost':     return corsOutput(uploadPhotoPost(payload));
      case 'linkTripPhoto':       return corsOutput(linkTripPhoto(payload));
      case 'attachTripPhotoRetro': return corsOutput(attachTripPhotoRetro(payload));
      // 🔒 ห่อด้วย LockService เพราะเป็นจุดที่แก้ MileLog — ป้องกัน race condition
      //    เมื่อมีการบันทึกไมล์เข้ามาพร้อมกัน (ความถี่ต่ำก็จริง แต่ป้องกันไว้ก่อนต้นทุนต่ำ)
      case 'startMile':           return corsOutput(withLock_(function () { return startMile(payload); }));
      case 'endMile':             return corsOutput(withLock_(function () { return endMile(payload); }));
      case 'saveFuel':            return corsOutput(saveFuel(payload));
      case 'saveEMS':             return corsOutput(saveEMS(payload));
      case 'restockEMS':          return corsOutput(restockEMS(payload));
      case 'uploadRepairPhoto':   return corsOutput(uploadRepairPhoto(payload));
      case 'saveRepair':          return corsOutput(saveRepair(payload));
      case 'updateRepair':        return corsOutput(updateRepair(payload));
      case 'submitFeedback':      return corsOutput(submitFeedback(payload));
      case 'uploadSatisfactionMedia': return corsOutput(uploadSatisfactionMedia(payload));
      case 'saveSatisfaction':    return corsOutput(saveSatisfaction(payload));
      case 'updateVehicleStatus': return corsOutput(updateVehicleStatusFromDash(payload));
      case 'saveLocationPin':     return corsOutput(saveLocationPin(payload));
      case 'deleteLocationPin':   return corsOutput(deleteLocationPin(payload));
      case 'verifyEditMileAdminCode': return corsOutput(verifyEditMileAdminCode(payload));
      case 'submitMileEditRequest':   return corsOutput(submitMileEditRequest(payload));
      case 'submitMileDeleteRequest': return corsOutput(submitMileDeleteRequest(payload));
      case 'directAddFuelBacklogEntry':   return corsOutput(directAddFuelBacklogEntry(payload));
      case 'submitAddFuelBacklogRequest': return corsOutput(submitAddFuelBacklogRequest(payload));
      case 'checkFuelBacklogDuplicate':   return corsOutput(checkFuelBacklogDuplicate(payload));
      case 'getPendingMileEdits':     return corsOutput(getPendingMileEdits());
      case 'approveMileEdit':         return corsOutput(approveMileEdit(payload));
      case 'rejectMileEdit':          return corsOutput(rejectMileEdit(payload));
      case 'directEditMileRow':       return corsOutput(directEditMileRow(payload));
      case 'directDeleteMileRow':     return corsOutput(directDeleteMileRow(payload));
      case 'getMileAnomalies':        return corsOutput(getMileAnomalies());

      // ── ตารางเวร (worktable) — public, ไม่ต้องการ API_KEY ──────────
      case 'getSchedule':       return corsOutput(getWorktableSchedule());
      case 'getScheduleNext':   return corsOutput(getWorktableScheduleNext());
      case 'getTodayDuty':      return corsOutput(getWorktableTodayDuty());

      // ── ตารางงาน (Job Assignments) — ต้องใส่รหัสผ่านก่อนเข้าดู/แก้ไข ──────
      case 'verifyDriverPhone':   return corsOutput(verifyDriverPhone(payload));
      case 'getJobAssignments':   return corsOutput(getJobAssignments(payload));
      case 'addJobAssignment':    return corsOutput(withLock_(function () { return addJobAssignment(payload); }));
      case 'updateJobAssignment': return corsOutput(withLock_(function () { return updateJobAssignment(payload); }));
      case 'deleteJobAssignment': return corsOutput(withLock_(function () { return deleteJobAssignment(payload); }));
      // ✅ NEW: แก้ไขเวรรายช่อง (คน × วัน) จากหน้าตารางเวร — เฉพาะแอดมิน/หัวหน้างาน (ต่างจากแลกเวร/ยกเวร)
      case 'setWorktableShift':   return corsOutput(withLock_(function () { return setWorktableShift(payload); }));
      case 'setupJobAssignmentsSheet': return corsOutput(setupJobAssignmentsSheet());
      // ── รูปประจำตัว พขร./เจ้าหน้าที่ ──────────────────────────────
      case 'uploadStaffPhoto':    return corsOutput(withLock_(function () { return uploadStaffPhoto(payload); }));
      // ── รายงานประจำเดือน (PDF) — dashboard.html สร้าง PDF ในเบราว์เซอร์แล้วส่งมาเก็บลง Drive ──
      case 'saveMonthlyReport':   return corsOutput(withLock_(function () { return saveMonthlyReport(payload); }));
      // ── Read actions — รองรับทั้ง GET และ POST (frontend เปลี่ยนมาใช้ POST เพื่อหลีกเลี่ยง CORS) ──
      case 'getReloadSignal':        return corsOutput(getReloadSignal());
      case 'getData':                return corsOutput(getCheckData());
      case 'getMileData':            return corsOutput(getMileData(payload));
      case 'getEMSData':             return corsOutput(getEMSData());
      case 'getInitData':            return corsOutput(getInitData());  // vehicles+drivers+config ใน 1 call
      case 'getStartMileBootstrap':  return corsOutput(getStartMileBootstrap(payload));
      case 'getCheckBootstrap':      return corsOutput(getCheckBootstrap());
      case 'getVehicles':            return corsOutput(getVehicles());
      case 'getDrivers':             return corsOutput(getDrivers());
      case 'getConfig':              return corsOutput(getConfig());
      case 'getStatusSummary':       return corsOutput(getStatusSummary());
      case 'getTodayCheckedPlates':  return corsOutput(getTodayCheckedPlates());
      case 'getRepairJobs':          return corsOutput(getRepairJobs());
      case 'getLocationPins':        return corsOutput(getLocationPins());
      case 'getLastMile':            return corsOutput(getLastMile(payload.carType));
      case 'getActiveTripByPlate':   return corsOutput(getActiveTripByPlate(payload.plate));
      case 'setupWorktableSheet': {
        if (!isAuthorized(e)) return corsOutput({ status:'error', message:'Unauthorized' });
        return corsOutput(setupWorktableSheet());
      }

      // ── ระบบแลกเวร พขร. (swap.html) ──────────────────────────────
      case 'swapLogin':             return corsOutput(swapLogin(payload));
      case 'getSwapStaffList':      return corsOutput(getSwapStaffList());
      case 'getMyShiftDays':        return corsOutput(getMyShiftDays(payload));
      case 'submitSwapRequest':     return corsOutput(withLock_(function () { return submitSwapRequest(payload); }));
      case 'getPendingSwapRequests':return corsOutput(getPendingSwapRequests());
      case 'approveSwapRequest':    return corsOutput(withLock_(function () { return approveSwapRequest(payload); }));
      case 'rejectSwapRequest':     return corsOutput(withLock_(function () { return rejectSwapRequest(payload); }));
      case 'getSwapHistory':        return corsOutput(getSwapHistory(payload));
      case 'regenerateSwapMemo':    return corsOutput(withLock_(function () { return regenerateSwapMemo(payload); }));
      case 'setupSwapRequestsSheet':return corsOutput(setupSwapRequestsSheet());
      case 'getSwapReportAvailableMonths': return corsOutput(getSwapReportAvailableMonths());
      case 'getSwapMonthlyReport':  return corsOutput(getSwapMonthlyReport(payload));
      case 'generateSwapMonthlyReportPdf': return corsOutput(withLock_(function () { return generateSwapMonthlyReportPdf(payload); }));

      // ── ระบบควบคุม LINE (linecontrol.html) — ทุก action ที่แก้ไขค่าต้องแนบ adminCode มาด้วย ──
      case 'switchLineChannel':        return corsOutput(switchLineChannel(payload));
      case 'saveLineTestUserId':       return corsOutput(saveLineTestUserId(payload));
      case 'testSendLineMessageByKey': return corsOutput(testSendLineMessageByKey(payload));
      case 'testSendAllLineMessagesToAdmin': return corsOutput(testSendAllLineMessagesToAdmin(payload));
      case 'setLineUserEnabled':       return corsOutput(setLineUserEnabled(payload));
      case 'saveLineReportSchedule':   return corsOutput(saveLineReportSchedule(payload));
      case 'getLineMessageTemplates':   return corsOutput(getLineMessageTemplates());
      case 'saveLineMessageTemplates':  return corsOutput(saveLineMessageTemplates(payload));
      case 'resetLineMessageTemplates': return corsOutput(resetLineMessageTemplates(payload));
      case 'resendLineMessageByKey':    return corsOutput(resendLineMessageByKey(payload));
      case 'getLineSendHistory':        return corsOutput(getLineSendHistory(payload));
      case 'getLineSendHistoryDetail':  return corsOutput(getLineSendHistoryDetail(payload));
      case 'resendLineFromHistory':     return corsOutput(resendLineFromHistory(payload));

      default:
        return corsOutput({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('doPost error action=' + (payload&&payload.action) + ':', err);
    sandLog('error', 'doPost ' + String((payload && payload.action) || '?') + ': ' + (err && err.message), null);
    return corsOutput({ status: 'error', message: err.message });
  }
}

/** normalizeFuelLevelToDecimal — แปลง "75%" → 0.75 หรือ decimal → decimal */
function normalizeFuelLevelToDecimal(val) {
  if (!val && val !== 0) return '';
  const s = String(val).trim();
  if (!s) return '';
  // "75%" → 0.75
  if (s.endsWith('%')) {
    const n = parseFloat(s);
    if (!isNaN(n)) return n / 100;
  }
  // already decimal (0.75)
  const n = parseFloat(s);
  if (!isNaN(n)) {
    if (n > 1) return n / 100; // "75" → 0.75
    return n; // "0.75" → 0.75
  }
  return s;
}

function saveCheck(payload) {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_CHECK, [
    'Timestamp','วันที่','เวลา','ทะเบียน/ประเภทรถ','พนักงานขับรถ',
    'เลขไมล์','น้ำมันเครื่อง','แบตเตอรี่','ยาง',
    'ระดับน้ำมันเชื้อเพลิง','เติมน้ำมัน',
    'กระจก','เบรค','น้ำหม้อน้ำ','ช่วงล่าง','ระดับน้ำมันเครื่อง 2',
    'ลมยาง','ไฟหน้า','ไฟท้าย','ไฟถอย','แตร','ที่ปัดน้ำฝน','แอร์',
    'ความสะอาดนอก','ความสะอาดใน',
    'หมายเหตุ','มีรูปแนบ','DriveLinks','DriveLinks_URLs',
    'ระดับ O₂ (PSI)','แสงไฟฉุกเฉิน','เสียงไซเรน',
    'เปลและระบบล็อกเปล','เครื่อง Suction','AED/Defibrillator'
  ]);

  var inspDateStr = payload.inspDate || formatThaiDate(new Date());
  var existing = getTodayCheck(payload.carType || '');
  if (existing.checked) {
    return { status: 'duplicate', message: 'รถคันนี้ตรวจสภาพไปแล้ววันนี้' };
  }

  // บันทึกเวลาจริงจาก server (Asia/Bangkok) เพื่อให้แสดง realtime ณ ตอนตรวจ
  const serverTime = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'HH:mm:ss');
  const serverTs   = formatDisplayDate(new Date()); // dd/MM/yyyy HH:mm:ss

  var row = [
    serverTs, inspDateStr,
    serverTime, payload.carType || '', payload.driverName || '',
    payload.odometer || '', payload.eq_oil || '', payload.eq_battery || '',
    payload.eq_tire || '', payload.fuelLevel || '', payload.fuelFill || '',
    payload.chk_mirror || '', payload.chk_brake || '', payload.chk_coolant || '',
    payload.chk_suspension || '', payload.chk_oilLevel || '', payload.chk_tirePressure || '',
    payload.chk_headlight || '', payload.chk_taillight || '', payload.chk_reverseLight || '',
    payload.chk_horn || '', payload.chk_wiper || '', payload.chk_aircon || '',
    payload.chk_exteriorClean || '', payload.chk_interiorClean || '',
    payload.remarks || '', 'ไม่มีรูป', '', '',
    payload.chk_o2Level || '', payload.chk_emergencyLight || '',
    payload.chk_siren || '', payload.chk_stretcherLock || '',
    payload.chk_suction || '', payload.chk_aed || ''
  ];

  sheet.appendRow(row);
  SpreadsheetApp.flush();
  var newRowIndex = sheet.getLastRow();
  console.log('saveCheck: row=' + newRowIndex + ' carType=' + (payload.carType||'') + ' inspDate=' + inspDateStr);

  // ✅ NEW: บันทึก IP ผู้บันทึกติดกับแถวนี้โดยตรง (เพิ่มคอลัมน์อัตโนมัติถ้ายังไม่มี)
  writeExtraField(sheet, newRowIndex, 'IP ผู้บันทึก', payload.clientIp || 'unknown');

  // === รวม URL จากทุกทาง ===
  var allUrls = [];

  // 1. driveUrls จาก frontend (อัพโหลดสำเร็จก่อน submit)
  var frontendUrls = Array.isArray(payload.driveUrls) ? payload.driveUrls : [];
  frontendUrls.forEach(function(u) {
    if (u && u.startsWith('http') && allUrls.indexOf(u) === -1) allUrls.push(u);
  });
  console.log('saveCheck: frontendUrls=' + frontendUrls.length + ' allUrls=' + allUrls.length);

  // 2. Buffer จาก ScriptProperties (กรณี uploadPhotoPost ทำงานแต่ row ยังไม่มี)
  try {
    var plate = (payload.carType || '').split(' ')[0].trim();
    var bDate = inspDateStr.slice(0, 10);
    var bKey  = 'photo_buffer__' + plate + '__' + bDate;
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(bKey) || '';
    if (raw) {
      raw.split('\n').forEach(function(u) {
        if (u.startsWith('http') && allUrls.indexOf(u) === -1) allUrls.push(u);
      });
      props.deleteProperty(bKey);
      console.log('saveCheck: flushed buffer key=' + bKey);
    }
  } catch(e) {
    console.warn('saveCheck buffer error:', e.message);
  }

  // เขียน URL ลง Sheet — ใช้ HYPERLINK formula คลิกได้ใน Sheets
  if (allUrls.length > 0) {
    ensureDriveLinksMultiCol(sheet, null);
    writePhotoLinksToRow(sheet, newRowIndex, allUrls);
    SpreadsheetApp.flush();
    console.log('saveCheck: wrote ' + allUrls.length + ' URLs to row ' + newRowIndex);
  }

  // อัปเดตสถานะใน Vehicles sheet → "พร้อมใช้งาน" เมื่อตรวจสภาพสำเร็จ
  updateVehicleStatus(
    payload.carType    || '',
    'พร้อมใช้งาน',
    payload.driverName || '',
    ''
  );

  // ── broadcast: ให้ทุกอุปกรณ์ที่เปิดหน้าตรวจสภาพรถรีเฟรชอัตโนมัติ ──
  bumpReloadSignal(RELOAD_KEY_CHECK);

  return {
    status    : 'ok',
    message   : 'บันทึกการตรวจสภาพรถสำเร็จ',
    photoUrls : allUrls
  };
}
function authorizeUpload() {
  try {
    let folderId = DRIVE_FOLDER;
    const folderName = 'FleetPhotos_สันทราย';
    if (!folderId) {
      const existing = DriveApp.getFoldersByName(folderName);
      let folder = existing.hasNext() ? existing.next() : DriveApp.createFolder(folderName);
      folderId = folder.getId();
    } else {
      DriveApp.getFolderById(folderId);
    }
    return { status: 'ok', authorized: true, folderId: folderId };
  } catch (err) {
    return { status: 'error', authorized: false, message: err.message };
  }
}

function getDriveFolderInfo() {
  try {
    if (!DRIVE_FOLDER) return { status: 'ok', configured: false };
    const folder = DriveApp.getFolderById(DRIVE_FOLDER);
    return { status: 'ok', configured: true, folderId: DRIVE_FOLDER,
             folderName: folder.getName(), folderUrl: folder.getUrl() };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/**
 * savePhotos — อัปโหลดรูป base64 → Drive แล้วอัปเดต DriveLinks ใน CheckLog
 * ส่ง hyperlink formula กลับมา (=HYPERLINK(url,"ดูรูป")) เพื่อให้คลิกได้ใน Sheets
 */
function savePhotos(payload) {
  if (!payload || typeof payload !== 'object') {
    return { status: 'error', message: 'payload ไม่ถูกต้อง' };
  }
  var photos     = Array.isArray(payload.photos) ? payload.photos : [];
  var carType    = payload.carType    || '';
  var inspDate   = payload.inspDate   || formatThaiDate(new Date());

  // รับ driveUrls จาก frontend โดยตรง (path ที่ใช้จริง)
  var driveUrls = Array.isArray(payload.driveUrls) ? payload.driveUrls : [];
  if (driveUrls.length > 0) {
    updateCheckRowLinks(carType, inspDate, driveUrls);
    return { status: 'ok', links: driveUrls, count: driveUrls.length, message: 'บันทึก DriveLinks สำเร็จ' };
  }

  // รองรับ driveLinks (ชื่อเก่า)
  var driveLinks = Array.isArray(payload.driveLinks) ? payload.driveLinks : [];
  if (driveLinks.length > 0 && !photos.length) {
    updateCheckRowLinks(carType, inspDate, driveLinks);
    return { status: 'ok', links: driveLinks, count: driveLinks.length, message: 'บันทึก DriveLinks สำเร็จ' };
  }

  if (!photos.length) return { status: 'ok', message: 'ไม่มีรูปภาพ', links: [] };

  try {
    var folder = DriveApp.getFolderById(DRIVE_FOLDER);
    var subFolder = getOrCreateSubFolder(folder, 'Check_' + carType + '_' + inspDate);
    var links = [];

    photos.forEach(function(photo, idx) {
      try {
        var base64 = photo.data.replace(/^data:[^;]+;base64,/, '');
        var bytes  = Utilities.base64Decode(base64);
        var blob   = Utilities.newBlob(bytes, photo.type || 'image/jpeg',
                       photo.name || ('photo_' + (idx + 1) + '.jpg'));
        var file   = subFolder.createFile(blob);
        links.push('https://drive.google.com/file/d/' + file.getId() + '/view');
      } catch(e) { console.error('savePhotos photo error:', e); }
    });

    updateCheckRowLinks(carType, inspDate, links);
    return { status: 'ok', links: links, count: links.length };
  } catch (err) {
    console.error('savePhotos error:', err);
    return { status: 'error', message: err.message };
  }
}
function uploadFuelPhotoFromGet(params) {
  const fileName  = params.fileName  || ('fuel_' + new Date().getTime() + '.jpg');
  const mimeType  = params.mimeType  || 'image/jpeg';
  const base64Data = params.base64Data || '';

  if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };

  try {
    let folder;
    if (DRIVE_FOLDER) {
      const root = DriveApp.getFolderById(DRIVE_FOLDER);
      folder = getOrCreateSubFolder(root, 'FuelReceipts');
    } else {
      const folderName = 'FleetPhotos_สันทราย';
      const existing   = DriveApp.getFoldersByName(folderName);
      const root = existing.hasNext() ? existing.next() : DriveApp.createFolder(folderName);
      folder = getOrCreateSubFolder(root, 'FuelReceipts');
    }

    const clean = base64Data.replace(/^data:[^;]+;base64,/, '');
    const bytes  = Utilities.base64Decode(clean);
    const blob   = Utilities.newBlob(bytes, mimeType, fileName);
    const file   = folder.createFile(blob);

    const url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
    return { status: 'ok', url: url, fileId: file.getId() };
  } catch (err) {
    console.error('uploadFuelPhotoFromGet error:', err);
    return { status: 'error', message: err.message };
  }
}


/**
 * uploadPhotoPost — รับ base64 รูปภาพผ่าน POST body (ไม่จำกัดขนาด URL)
 * ใช้แทน uploadFuelPhotoFromGet เพื่อรองรับรูปขนาดใหญ่
 * subFolder: 'FuelReceipts' | 'CheckPhotos'
 */
/**
 * uploadPhotoPost — อัพโหลดรูปเดี่ยว + บันทึก URL ลง Sheet ทันที (ในคำขอเดียว)
 * แก้ปัญหา: ไม่ต้องรอ frontend ส่งครั้งที่สอง ป้องกัน race condition จาก resetForm()
 */
function uploadPhotoPost(payload) {
  var fileName   = payload.fileName   || ('photo_' + new Date().getTime() + '.jpg');
  var mimeType   = payload.mimeType   || 'image/jpeg';
  var base64Data = payload.base64Data || '';
  var subFolder  = payload.subFolder  || 'CheckPhotos';
  var tripId     = payload.tripId     || '';
  var carType    = payload.carType    || '';
  var inspDate   = payload.inspDate   || '';

  if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };

  try {
    var rootFolder = DriveApp.getFolderById(DRIVE_FOLDER);

    var clean = base64Data.replace(/^data:[^;]+;base64,/, '');
    var bytes  = Utilities.base64Decode(clean);
    var blob   = Utilities.newBlob(bytes, mimeType, fileName);
    var file   = rootFolder.createFile(blob);

    var url = 'https://drive.google.com/file/d/' + file.getId() + '/view';
    console.log('uploadPhotoPost OK: ' + fileName + ' -> ' + url);

    // รูปบิลน้ำมัน → เขียนลง MileLog ทันที
    if (subFolder === 'FuelReceipts') {
      updateMileRowFuelPhoto(tripId, carType, url);
      return { status: 'ok', url: url, fileId: file.getId() };
    }

    // ✅ NEW: รูปบิลน้ำมันขาออก — pre-upload ตอนเลือกรูป (ยังไม่มี tripId)
    // แค่อัปโหลดไฟล์คืน URL กลับไป ไม่เขียนลง sheet ทันที
    // startMile() จะเขียน URL ลงคอลัมน์ 'รูปบิลน้ำมันออกรถ' ให้เองตอนสร้างแถว
    if (subFolder === 'FuelReceiptsPreUpload') {
      return { status: 'ok', url: url, fileId: file.getId() };
    }

    // รูปสภาพรถขากลับ → เขียนลง MileLog col 'รูปสภาพรถขากลับ' ทันที
    if (subFolder === 'ReturnCarPhotos') {
      updateMileRowReturnCarPhoto(tripId, carType, url);
      return { status: 'ok', url: url, fileId: file.getId() };
    }

    // ✅ NEW: รูปบิลน้ำมันขากลับ — pre-upload ตอนเลือกรูป
    // แค่อัปโหลดไฟล์คืน URL กลับไป ไม่เขียนลง sheet ทันที
    // endMile() จะเขียน URL ลงคอลัมน์ 'รูปบิลน้ำมันขากลับ' ให้เองตอน submit + ผ่าน dedup guard
    if (subFolder === 'ReturnFuelReceipts') {
      return { status: 'ok', url: url, fileId: file.getId() };
    }

    // ✅ FIX: รูปสภาพรถขาออก → เขียนลง MileLog col 'รูปสภาพรถ' ทันที (ถ้ามี tripId)
    // เดิม: ส่งแค่ driveUrls ตอน submit → ถ้ารูปค้างใน frontend อาจปนไปกับทริปถัดไป
    // ใหม่: เขียนลง sheet ทันทีตาม tripId → แม้ frontend ไม่ reset ก็ไม่ปน
    if (subFolder === 'TripPhotos') {
      if (tripId) {
        updateMileRowTripPhoto(tripId, carType, url);
      }
      // คืน URL ให้ frontend เก็บใน tripPhotos[].driveUrl ตามปกติ
      return { status: 'ok', url: url, fileId: file.getId() };
    }

    // รูปตรวจสภาพรถ (CheckLog) → buffer ไว้ใน ScriptProperties เพื่อให้ saveCheck flush เมื่อ submit
    // ✅ FIX: เดิมเช็คแค่ (carType && inspDate) ทำให้ subFolder อื่น (เช่น 'TripPhotos' รูปสภาพรถขาออก
    // ของ MileLog) หลุดเข้ามา buffer คีย์เดียวกับ CheckLog โดยไม่ได้ตั้งใจ — ถ้า saveCheck ถูกเรียก
    // ของรถ/วันเดียวกันทีหลัง รูปขาออกของ MileLog จะหลุดไปติดในแถวตรวจสภาพรถ (CheckLog) ผิดที่
    // จำกัดให้ buffer นี้ใช้กับ subFolder === 'CheckPhotos' เท่านั้น
    if (subFolder === 'CheckPhotos' && carType && inspDate) {
      var plate = (carType || '').split(' ')[0].trim();
      var bDate = (inspDate || '').slice(0, 10);
      var bKey  = 'photo_buffer__' + plate + '__' + bDate;
      try {
        var props    = PropertiesService.getScriptProperties();
        var existing = props.getProperty(bKey) || '';
        var bUrls    = existing ? existing.split('\n').filter(function(u){ return u; }) : [];
        if (bUrls.indexOf(url) === -1) bUrls.push(url);
        props.setProperty(bKey, bUrls.join('\n'));
        console.log('uploadPhotoPost buffer: key=' + bKey + ' count=' + bUrls.length);
      } catch(e) {
        console.warn('uploadPhotoPost buffer error:', e.message);
      }
    }

    return { status: 'ok', url: url, fileId: file.getId() };
  } catch (err) {
    console.error('uploadPhotoPost error:', err);
    return { status: 'error', message: err.message };
  }
}
function appendCheckRowLink(carType, inspDate, url) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_CHECK);
    if (!sheet || sheet.getLastRow() <= 1) {
      console.warn('appendCheckRowLink: ไม่พบ sheet CheckLog');
      return false;
    }

    const data       = sheet.getDataRange().getValues();
    const plate      = (carType || '').split(' ')[0].trim();
    const targetDate = (inspDate || '').slice(0, 10);  // yyyy-MM-dd

    for (let i = data.length - 1; i >= 1; i--) {
      const rowPlate = String(data[i][3]).split(' ')[0].trim();
      const rowDate  = parseDateToYMD(data[i][1]).slice(0, 10);

      if (rowPlate === plate && rowDate === targetDate) {
        const existingRaw  = String(data[i][28] || '').trim();
        const existingUrls = existingRaw.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
        if (!existingUrls.includes(url)) existingUrls.push(url);
        const count = existingUrls.length;

        ensureDriveLinksMultiCol(sheet, data[0]);
        writePhotoLinksToRow(sheet, i + 1, existingUrls);
        SpreadsheetApp.flush();
        console.log('✅ appendCheckRowLink: row ' + (i+1) + ' plate=' + rowPlate + ' date=' + rowDate + ' count=' + count);
        return true;
      }
    }
    console.warn('⚠️ appendCheckRowLink: ไม่พบ row สำหรับ plate=' + plate + ' date=' + targetDate);
    return false;
  } catch(e) {
    console.error('appendCheckRowLink error:', e.message);
    return false;
  }
}


/**
 * getLatestPhotoUrl — คืน URL รูปล่าสุดของรถ+วันที่ จาก DriveLinks_URLs col 29
 * ใช้โดย frontend fallback หลัง no-cors upload
 */
function getLatestPhotoUrl(carType, inspDate) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_CHECK);
    if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบ sheet' };
    const data   = sheet.getDataRange().getValues();
    const plate  = (carType || '').split(' ')[0].trim();
    const target = (inspDate || '').slice(0, 10);
    for (let i = data.length - 1; i >= 1; i--) {
      const rowPlate = String(data[i][3]).split(' ')[0].trim();
      const rowDate  = parseDateToYMD(data[i][1]).slice(0, 10);
      if (rowPlate === plate && rowDate === target) {
        const urlsRaw = String(data[i][28] || '').trim();
        const urls = urlsRaw.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
        if (urls.length) return { status: 'ok', url: urls[urls.length - 1], count: urls.length };
      }
    }
    return { status: 'error', message: 'ไม่พบข้อมูล' };
  } catch(e) {
    return { status: 'error', message: e.message };
  }
}


/**
 * bufferPhotoUrl — เก็บ URL รูปชั่วคราวใน ScriptProperties
 * key: "photo_buffer__<plate>__<date>"
 * ใช้เมื่อ uploadPhotoPost ถูกเรียกก่อน saveCheck (row ยังไม่มีใน Sheet)
 */
function bufferPhotoUrl(carType, inspDate, url) {
  try {
    const plate = (carType || '').split(' ')[0].trim();
    const date  = (inspDate || '').slice(0, 10);
    const key   = 'photo_buffer__' + plate + '__' + date;
    const props = PropertiesService.getScriptProperties();
    const existing = props.getProperty(key) || '';
    const urls = existing ? existing.split('\n').filter(u => u) : [];
    if (!urls.includes(url)) urls.push(url);
    props.setProperty(key, urls.join('\n'));
    console.log('📦 bufferPhotoUrl: key=' + key + ' count=' + urls.length);
  } catch(e) {
    console.warn('bufferPhotoUrl error:', e.message);
  }
}

/**
 * flushBufferedPhotos — ดึง URL ที่ buffer ไว้มาเขียนลง row ใน CheckLog
 * เรียกจาก saveCheck หลัง appendRow สำเร็จ
 */
function flushBufferedPhotos(carType, inspDate, sheet, rowIndex) {
  try {
    const plate = (carType || '').split(' ')[0].trim();
    const date  = (inspDate || '').slice(0, 10);
    const key   = 'photo_buffer__' + plate + '__' + date;
    const props = PropertiesService.getScriptProperties();
    const raw   = props.getProperty(key) || '';
    if (!raw) return;

    const urls  = raw.split('\n').filter(u => u.startsWith('http'));
    if (!urls.length) return;

    ensureDriveLinksMultiCol(sheet, null);
    writePhotoLinksToRow(sheet, rowIndex, urls);
    SpreadsheetApp.flush();

    props.deleteProperty(key);
    console.log('✅ flushBufferedPhotos: ' + urls.length + ' รูป → row ' + rowIndex);
  } catch(e) {
    console.warn('flushBufferedPhotos error:', e.message);
  }
}

/**
 * ensureDriveLinksMultiCol — ตรวจว่า col 29 มี header DriveLinks_URLs หรือยัง
 * แก้: เพิ่ม null-check สำหรับ sheet ก่อนเรียก getLastColumn()
 */
function ensureDriveLinksMultiCol(sheet, headers) {
  if (!sheet) return;  // ← แก้ TypeError: Cannot read properties of undefined
  try {
    const lastCol = sheet.getLastColumn();
    if (lastCol < 29) {
      sheet.getRange(1, 29).setValue('DriveLinks_URLs');
      const r = sheet.getRange(1, 29);
      r.setBackground('#0a2540'); r.setFontColor('#ffffff'); r.setFontWeight('bold');
    }
  } catch(e) {
    console.warn('ensureDriveLinksMultiCol:', e.message);
  }
}

/**
 * writePhotoLinksToRow — เขียน =HYPERLINK() formula ลง CheckLog row
 * ─────────────────────────────────────────────────────────────────────────────
 * col 27 : "มีรูป (N รูป)"
 * col 28 : =HYPERLINK("url","ดูรูป (1)")   ← 1 รูป
 *           =HYPERLINK("url1","ดูรูป 1")&CHAR(10)&HYPERLINK("url2","ดูรูป 2")  ← หลายรูป
 * col 29 : plain-text URL ทุกรูป คั่น newline  (สำหรับ dashboard)
 * ─────────────────────────────────────────────────────────────────────────────
 */
function writePhotoLinksToRow(sheet, rowIndex, urls) {
  if (!sheet || !urls || !urls.length) return;
  var count = urls.length;

  // col 27: สถานะ
  sheet.getRange(rowIndex, 27).setValue('มีรูป (' + count + ' รูป)');

  // col 28: URL ดิบ— 1 รูป = URL เดียว, หลายรูป = คั่นด้วย newline
  sheet.getRange(rowIndex, 28).setValue(urls.join('\n'));

  // col 29: plain URL ทุกรูป คั่น newline
  sheet.getRange(rowIndex, 29).setValue(urls.join('\n'));
}

/**
 * getOrAddHeader — หาหรือสร้าง column header แล้วคืน column index (1-based)
 * แก้: เพิ่ม null-check สำหรับ headers ก่อนวน loop ป้องกัน TypeError: length of undefined
 */
function getOrAddHeader(sheet, headers, name, defaultCol) {
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i++) {
      if (String(headers[i]).trim() === name) return i + 1;
    }
  }
  // ไม่มีหรือ headers ไม่ valid → สร้างใหม่ที่ defaultCol
  try {
    if (!sheet) return 0;
    sheet.getRange(1, defaultCol).setValue(name);
    const r = sheet.getRange(1, defaultCol);
    r.setBackground('#0a2540'); r.setFontColor('#fff'); r.setFontWeight('bold');
    return defaultCol;
  } catch(_) { return 0; }
}

/**
 * updateMileRowFuelPhoto — เขียน URL รูปบิลน้ำมันลง MileLog col 16
 * สร้าง HYPERLINK formula เพื่อให้คลิกได้ใน Google Sheets
 */
function updateMileRowFuelPhoto(tripId, carType, url) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) return;
    const allData = sheet.getDataRange().getValues();
    const hdrs    = allData[0];
    // ค้นหา column จาก header จริง (ชีทจริงชื่อ "รูปบิลน้ำมันออกรถ")
    const fuelColIdx = hdrs.indexOf('รูปบิลน้ำมันออกรถ') >= 0
      ? hdrs.indexOf('รูปบิลน้ำมันออกรถ')
      : (hdrs.indexOf('รูปบิลน้ำมัน') >= 0 ? hdrs.indexOf('รูปบิลน้ำมัน') : 15);
    const plate = (carType || '').split(' ')[0].trim();
    // ✅ FIX: ถ้าไม่มี tripId ต้อง match เฉพาะแถวที่ "กำลังใช้งาน" เท่านั้น
    // ป้องกันการเขียนรูปทับลงแถวเก่าที่ปิดงานไปแล้ว (ของทริป/รถคันอื่นในอดีต)
    const statColIdx = hdrs.indexOf('สถานะ') >= 0 ? hdrs.indexOf('สถานะ') : 11;
    for (let i = allData.length - 1; i >= 1; i--) {
      const rowTripId = String(allData[i][0]).trim();
      const rowPlate  = String(allData[i][4]).split(' ')[0].trim();
      const rowStatus = String(allData[i][statColIdx]).trim();
      if ((tripId && rowTripId === tripId) ||
          (!tripId && rowPlate === plate && rowStatus === 'กำลังใช้งาน')) {
        // สร้าง HYPERLINK formula แทน plain URL
        sheet.getRange(i + 1, fuelColIdx + 1).setValue(url);
        SpreadsheetApp.flush();
        return;
      }
    }
    console.warn('⚠️ updateMileRowFuelPhoto: ไม่พบแถวที่ตรงกัน (tripId=' + tripId + ', plate=' + plate + ') — ไม่เขียนรูป เพื่อป้องกันรูปติดผิดแถว');
  } catch(e) {
    console.warn('updateMileRowFuelPhoto:', e.message);
  }
}

/**
 * updateMileRowTripPhoto — เขียน URL รูปสภาพรถขาออกลง MileLog ทันที (ผ่าน tripId)
 * ✅ FIX: ป้องกันรูปปน — เขียนลง sheet ทันทีตาม tripId แทนที่จะรอ submit
 * รองรับหลาย URL (เขียนเป็น =HYPERLINK()&CHAR(10)&HYPERLINK()... เพื่อให้คลิกได้ทุกรูปใน Sheet)
 */
function updateMileRowTripPhoto(tripId, carType, url) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) return;
    const allData = sheet.getDataRange().getValues();
    const hdrs    = allData[0];

    // ✅ FIX: เดิมหาคอลัมน์ด้วยชื่อ 'รูปสภาพรถขาออก' แบบ exact-match ซึ่งไม่ตรงกับ
    // คอลัมน์จริงในชีท (' รูปสภาพรถก่อนออก' — มีช่องว่างนำหน้า + คำต่างกัน) ทำให้
    // indexOf หาไม่เจอเสมอ แล้วไปสร้างคอลัมน์ใหม่ผิดที่ (หรือเขียนไม่สำเร็จ)
    // ใช้ ensureCarPhotoOutColIdx() แทน — เทียบชื่อแบบ trim() + รองรับ alias เก่า
    var colIdx = ensureCarPhotoOutColIdx(sheet);
    if (colIdx < 0) { console.warn('updateMileRowTripPhoto: ไม่พบ/สร้าง column รูปสภาพรถก่อนออกไม่สำเร็จ'); return; }

    const plate = (carType || '').split(' ')[0].trim();
    // ✅ ใช้ tripId เป็น primary key — ถ้าไม่มีจึง fallback หา 'กำลังใช้งาน' ล่าสุด
    const statColIdx = hdrs.indexOf('สถานะ') >= 0 ? hdrs.indexOf('สถานะ') : 11;
    for (let i = allData.length - 1; i >= 1; i--) {
      const rowTripId = String(allData[i][0]).trim();
      const rowPlate  = String(allData[i][4]).split(' ')[0].trim();
      const rowStatus = String(allData[i][statColIdx]).trim();
      const matched   = tripId
        ? rowTripId === tripId
        : (rowPlate === plate && rowStatus === 'กำลังใช้งาน');
      if (!matched) continue;

      const cell = sheet.getRange(i + 1, colIdx + 1);
      // ✅ FIX: เดิมใช้ cell.getValue() ซึ่งคืน "ดูรูปรถ" (label ที่แสดงผล) ไม่ใช่ URL จริง
      // ทำให้ตอน append รูปที่ 2 เป็นต้นไป URL ของรูปแรกหายไป (ถูกเข้าใจผิดว่าเป็น URL "ดูรูปรถ")
      // ใหม่: ใช้ getFormula() ดึง URL จริงจาก =HYPERLINK(...) formula ก่อน แล้วค่อย fallback
      // ไปที่ plain-text value (กรณีเซลล์เคยถูกเขียนด้วย setValue() จากโค้ดเก่า)
      const existingFormula = String(cell.getFormula() || '').trim();
      const existingValue   = String(cell.getValue()   || '').trim();
      let existUrls = [];
      if (existingFormula) {
        const re = /HYPERLINK\("([^"]+)"/g;
        let m;
        while ((m = re.exec(existingFormula)) !== null) existUrls.push(m[1]);
      } else if (existingValue.startsWith('http') || existingValue.indexOf('\n') >= 0) {
        existUrls = existingValue.split('\n').map(function(u){ return u.trim(); })
          .filter(function(u){ return u.startsWith('http'); });
      }

      if (existUrls.indexOf(url) === -1) existUrls.push(url);

      if (existUrls.length === 1) {
        cell.setValue(existUrls[0]);
      } else {
        cell.setValue(existUrls.join('\n'));
      }
      SpreadsheetApp.flush();
      console.log('✅ updateMileRowTripPhoto: row ' + (i+1) + ' tripId=' + tripId + ' plate=' + plate + ' count=' + existUrls.length);
      return;
    }
    console.warn('⚠️ updateMileRowTripPhoto: ไม่พบแถวที่ตรงกัน (tripId=' + tripId + ', plate=' + plate + ') — ไม่เขียนรูป');
  } catch(e) {
    console.warn('updateMileRowTripPhoto:', e.message);
  }
}

/**
 * updateMileRowReturnCarPhoto — เขียน URL รูปสภาพรถขากลับลง MileLog
 * รองรับหลาย URL (append ต่อกันด้วย \n) และเขียนเป็น HYPERLINK ถ้ามีรูปเดียว
 */
/**
 * linkTripPhoto — เขียน driveUrl ที่มีอยู่แล้วลง MileLog โดยใช้ tripId
 * ใช้โดย frontend backfillTripPhotos() หลัง startMile() สำเร็จ
 * เพื่อแก้ปัญหา: รูปสภาพรถก่อนออกอัปโหลดก่อน tripId ถูกสร้าง → row ยังไม่มีตอนอัปโหลด
 */
function linkTripPhoto(payload) {
  var tripId   = payload.tripId   || '';
  var carType  = payload.carType  || '';
  var driveUrl = payload.driveUrl || '';
  if (!driveUrl || !tripId) {
    return { status: 'error', message: 'linkTripPhoto: ต้องการ tripId และ driveUrl' };
  }
  try {
    updateMileRowTripPhoto(tripId, carType, driveUrl);
    return { status: 'ok', message: 'linkTripPhoto: เขียน URL สำเร็จ' };
  } catch(e) {
    return { status: 'error', message: e.message };
  }
}

/**
 * updateMileRowReturnFuelPhoto — เขียน URL รูปบิลน้ำมันขากลับลง MileLog ทันที (ผ่าน tripId)
 * ใช้คู่กับ attachTripPhotoRetro() สำหรับแนบรูปย้อนหลังเฉพาะรายการ
 * (endMile() ปกติจะเขียนคอลัมน์นี้เองตอน submit — ฟังก์ชันนี้ไว้เขียนซ้ำ/เพิ่มเติมทีหลังโดยระบุ tripId ตรงๆ)
 */
function updateMileRowReturnFuelPhoto(tripId, carType, url) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) return;
    const allData = sheet.getDataRange().getValues();
    const hdrs    = allData[0];
    const fuelBackColIdx = hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') >= 0 ? hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') : 17;
    const plate = (carType || '').split(' ')[0].trim();
    const statColIdx = hdrs.indexOf('สถานะ') >= 0 ? hdrs.indexOf('สถานะ') : 11;
    for (let i = allData.length - 1; i >= 1; i--) {
      const rowTripId = String(allData[i][0]).trim();
      const rowPlate  = String(allData[i][4]).split(' ')[0].trim();
      const rowStatus = String(allData[i][statColIdx]).trim();
      if ((tripId && rowTripId === tripId) ||
          (!tripId && rowPlate === plate && rowStatus === 'กำลังใช้งาน')) {
        sheet.getRange(i + 1, fuelBackColIdx + 1).setValue(url);
        SpreadsheetApp.flush();
        console.log('✅ updateMileRowReturnFuelPhoto: row ' + (i+1) + ' tripId=' + tripId + ' plate=' + plate);
        return;
      }
    }
    console.warn('⚠️ updateMileRowReturnFuelPhoto: ไม่พบแถวที่ตรงกัน (tripId=' + tripId + ', plate=' + plate + ') — ไม่เขียนรูป');
  } catch(e) {
    console.warn('updateMileRowReturnFuelPhoto:', e.message);
  }
}

/**
 * attachTripPhotoRetro — แนบรูปย้อนหลังให้ทริปที่ระบุ (ใช้จากหน้า editmile.html)
 * ─────────────────────────────────────────────────────────────────────────────
 * ต่างจาก uploadPhotoPost() ตรงที่: ใช้ตอนทริปนั้น "จบไปแล้ว" นานแล้ว และ พขร./แอดมิน
 * ต้องการแนบรูปเพิ่มเติมเข้ากับรายการเดิม (เช่น พขร. ลืมถ่ายรูปตอนออกรถ แล้วมาแนบทีหลัง)
 * เขียน URL ลง MileLog ทันทีตาม tripId ที่ระบุ (บังคับต้องมี tripId เสมอ — ไม่ fallback หา
 * แถว "กำลังใช้งาน" ล่าสุดเหมือน uploadPhotoPost เพราะรูปย้อนหลังต้องผูกกับทริปที่ระบุเท่านั้น)
 * ทุกครั้งที่แนบสำเร็จจะเขียน 1 แถวลง MileEditLog ไว้ตรวจสอบย้อนหลังได้เสมอ
 *
 * payload: {
 *   tripId, category: 'carOut'|'carBack'|'fuelOut'|'fuelBack',
 *   fileName, mimeType, base64Data,
 *   editedBy, role: 'driver'|'admin', adminCode, note
 * }
 */
function attachTripPhotoRetro(payload) {
  var tripId     = String((payload && payload.tripId) || '').trim();
  var category   = String((payload && payload.category) || '').trim();
  var fileName   = (payload && payload.fileName)   || ('retro_' + new Date().getTime() + '.jpg');
  var mimeType   = (payload && payload.mimeType)   || 'image/jpeg';
  var base64Data = (payload && payload.base64Data) || '';
  var editedBy   = (payload && payload.editedBy)   || 'ไม่ระบุ';
  var role       = (payload && payload.role)       || 'driver';
  var adminCode  = (payload && payload.adminCode)  || '';
  var note       = (payload && payload.note)       || '';

  var CATEGORY_LABELS = {
    carOut  : 'รูปสภาพรถก่อนออก',
    carBack : 'รูปสภาพรถขากลับ',
    fuelOut : 'รูปบิลน้ำมันออกรถ',
    fuelBack: 'รูปบิลน้ำมันขากลับ'
  };

  if (!tripId)     return { status: 'error', message: 'ต้องระบุ TripID ของทริปที่จะแนบรูป' };
  if (!category || !CATEGORY_LABELS[category])
    return { status: 'error', message: 'ประเภทรูปไม่ถูกต้อง' };
  if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };
  if (role === 'admin' && adminCode !== EDITMILE_ADMIN_CODE)
    return { status: 'error', message: 'รหัสแอดมินไม่ถูกต้อง' };

  var found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  var plateColIdx = found.headers.indexOf('ทะเบียน/รถ');
  var carType     = plateColIdx >= 0 ? String(found.row[plateColIdx] || '') : '';

  try {
    var rootFolder = DriveApp.getFolderById(DRIVE_FOLDER);
    var clean = base64Data.replace(/^data:[^;]+;base64,/, '');
    var bytes = Utilities.base64Decode(clean);
    var blob  = Utilities.newBlob(bytes, mimeType, fileName);
    var file  = rootFolder.createFile(blob);
    var url   = 'https://drive.google.com/file/d/' + file.getId() + '/view';

    switch (category) {
      case 'carOut':   updateMileRowTripPhoto(tripId, carType, url);        break;
      case 'carBack':  updateMileRowReturnCarPhoto(tripId, carType, url);   break;
      case 'fuelOut':  updateMileRowFuelPhoto(tripId, carType, url);        break;
      case 'fuelBack': updateMileRowReturnFuelPhoto(tripId, carType, url);  break;
    }

    // เขียน log ไว้ตรวจสอบย้อนหลัง (ไม่ให้ error ตรงนี้ทำให้การแนบรูปทั้งหมดล้มเหลว)
    try {
      const ss      = getSpreadsheet();
      const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
      logSheet.appendRow([
        new Date(), tripId, carType,
        'แนบรูปย้อนหลัง: ' + CATEGORY_LABELS[category],
        '(ไม่มีรูปเดิม/เพิ่มเติม)', url,
        editedBy, role, note || '(ไม่ระบุเหตุผล)', editedBy, new Date(), 'สำเร็จ'
      ]);
    } catch(logErr) {
      console.warn('attachTripPhotoRetro log error:', logErr.message);
    }

    console.log('✅ attachTripPhotoRetro: tripId=' + tripId + ' category=' + category + ' url=' + url);
    return { status: 'ok', url: url, fileId: file.getId(), message: 'แนบรูปสำเร็จ' };
  } catch (err) {
    console.error('attachTripPhotoRetro error:', err);
    return { status: 'error', message: err.message };
  }
}

function updateMileRowReturnCarPhoto(tripId, carType, url) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) return;
    const allData = sheet.getDataRange().getValues();
    const hdrs    = allData[0];
    // หา col 'รูปสภาพรถขากลับ' — สร้างอัตโนมัติถ้ายังไม่มี
    var colIdx = hdrs.indexOf('รูปสภาพรถขากลับ');
    if (colIdx < 0) {
      colIdx = ensureExtraColumn(sheet, 'รูปสภาพรถขากลับ');
    }
    if (colIdx < 0) { console.warn('updateMileRowReturnCarPhoto: ไม่พบ column รูปสภาพรถขากลับ'); return; }

    const plate = (carType || '').split(' ')[0].trim();
    // ✅ FIX: ถ้าไม่มี tripId ต้อง match เฉพาะแถวที่ "กำลังใช้งาน" เท่านั้น
    // ป้องกันการเขียนรูปทับ/ต่อท้ายลงแถวเก่าที่ปิดงานไปแล้ว (ของทริป/รถคันอื่นในอดีต)
    const statColIdx = hdrs.indexOf('สถานะ') >= 0 ? hdrs.indexOf('สถานะ') : 11;
    for (let i = allData.length - 1; i >= 1; i--) {
      const rowTripId = String(allData[i][0]).trim();
      const rowPlate  = String(allData[i][4]).split(' ')[0].trim();
      const rowStatus = String(allData[i][statColIdx]).trim();
      if ((tripId && rowTripId === tripId) ||
          (!tripId && rowPlate === plate && rowStatus === 'กำลังใช้งาน')) {
        const cell    = sheet.getRange(i + 1, colIdx + 1);
        const current = String(cell.getValue() || '').trim();
        // ถ้ายังไม่มีรูป → HYPERLINK formula
        if (!current) {
          cell.setValue(url);
        } else {
          // มีรูปแล้ว → append URL (plain text หลายรูป) — กันรูปซ้ำเดิมในแถวเดียวกัน
          const existUrls = current.replace(/=HYPERLINK\("([^"]+)"[^)]*\)/g, '$1')
            .split('\n').map(u => u.trim()).filter(Boolean);
          if (!existUrls.includes(url)) existUrls.push(url);
          cell.setValue(existUrls.join('\n'));
        }
        SpreadsheetApp.flush();
        console.log('✅ updateMileRowReturnCarPhoto: row ' + (i+1) + ' plate=' + plate);
        return;
      }
    }
    console.warn('⚠️ updateMileRowReturnCarPhoto: ไม่พบแถวที่ตรงกัน (tripId=' + tripId + ', plate=' + plate + ') — ไม่เขียนรูป เพื่อป้องกันรูปติดผิดแถว');
  } catch(e) {
    console.warn('updateMileRowReturnCarPhoto:', e.message);
  }
}

/**
 * updateCheckRowLinks — เขียน URL รูปลง CheckLog
 * แก้ไข v2.1:
 *   col 27 = สถานะ "มีรูป (N รูป)"
 *   col 28 = DriveLinks — ใช้ RichTextValue (คลิกได้ใน Sheets + getValues() อ่านได้เป็น URL)
 *   col 29 = DriveLinks_URLs — URL ทุกรูปคั่นด้วย \n สำหรับ dashboard
 */
function updateCheckRowLinks(carType, inspDate, links) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CHECK);
  if (!sheet || sheet.getLastRow() <= 1) return;

  const data       = sheet.getDataRange().getValues();
  const plate      = (carType || '').split(' ')[0].trim();
  const targetDate = (inspDate || '').slice(0, 10);

  for (let i = data.length - 1; i >= 1; i--) {
    const rowPlate = String(data[i][3]).split(' ')[0].trim();
    const rowDate  = parseDateToYMD(data[i][1]).slice(0, 10);

    if (rowPlate === plate && rowDate === targetDate) {
      const count = links.length;
      const firstUrl = links[0];

      // เขียน HYPERLINK formula + plain URLs
      ensureDriveLinksMultiCol(sheet, data[0]);
      writePhotoLinksToRow(sheet, i + 1, links);
      SpreadsheetApp.flush();
      console.log('✅ updateCheckRowLinks: row ' + (i+1) + ' plate=' + rowPlate + ' links=' + count);
      return;
    }
  }
  console.warn('⚠️ updateCheckRowLinks: ไม่พบ row plate=' + plate + ' date=' + targetDate);
  SpreadsheetApp.flush();
}

/**
 * getCheckData — ส่งข้อมูล CheckLog สำหรับ dashboard
 * สำคัญ: inspDate ต้องเป็น "yyyy-MM-dd" เสมอ เพื่อให้ filter ทำงานได้
 */
/**
 * getCheckData — ส่งข้อมูล CheckLog สำหรับ dashboard
 * แก้ไข v2.1: ใช้ getFormulas() ดึง URL จริงออกจาก HYPERLINK formula ใน col 28
 * เพื่อแก้ปัญหา driveLinks ว่างเปล่าใน dashboard และ hasPhoto icon ไม่แสดง
 */
function getCheckData() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CHECK);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  const dataRange = sheet.getDataRange();
  const rows      = dataRange.getValues();
  const formulas  = dataRange.getFormulas();  // ← ดึง formula ทุก cell พร้อมกัน
  const headers   = rows[0];

  const data = rows.slice(1).map(function(row, rowIdx) {
    const obj = {};
    // formulaRow index = rowIdx+1 เพราะ row[0] คือ header
    const formulaRow = formulas[rowIdx + 1] || [];

    headers.forEach(function(h, i) {
      let v = row[i];
      // แปลง Date → string ด้วย key ที่ถูกต้อง
      if (v instanceof Date) {
        if (h === 'วันที่') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        } else if (h === 'เวลา' || h === 'เวลาออก' || h === 'เวลากลับ') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm:ss');
        } else {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        }
      }
      obj[headerToKey(h)] = v;
    });

    // normalize inspDate ให้เป็น yyyy-MM-dd เสมอ
    if (obj.inspDate) {
      obj.inspDate = parseDateToYMD(obj.inspDate);
    }

    // ── inspTime: ใช้ col เวลา (serverTime) เป็นหลัก
    //    fallback → ดึงจาก Timestamp col 0 (dd/MM/yyyy HH:mm:ss)
    if (!obj.inspTime || String(obj.inspTime).trim() === '') {
      const ts0 = row[0]; // col Timestamp (index 0)
      if (ts0) {
        let tsStr = ts0 instanceof Date
          ? Utilities.formatDate(ts0, 'Asia/Bangkok', 'HH:mm:ss')
          : String(ts0);
        // ดึงเฉพาะ HH:mm:ss จาก "dd/MM/yyyy HH:mm:ss"
        const m = tsStr.match(/(\d{2}:\d{2}(?::\d{2})?)/);
        if (m) obj.inspTime = m[1];
      }
    }

    // ── timestamp: รวม inspDate + inspTime ให้ครบ
    //    ถ้า Timestamp col 0 มีข้อมูลใช้โดยตรง
    if (!obj.timestamp) {
      const ts0 = row[0];
      if (ts0) {
        obj.timestamp = ts0 instanceof Date
          ? Utilities.formatDate(ts0, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss')
          : String(ts0);
      } else if (obj.inspDate && obj.inspTime) {
        // สร้าง timestamp จาก inspDate + inspTime
        const [y, mo, d] = obj.inspDate.split('-');
        obj.timestamp = `${d}/${mo}/${y} ${obj.inspTime}`;
      }
    }

    // ── ค้นหา col index สำหรับรูปภาพจาก headers ──
    // ✅ FIX (บั๊กรูปไม่ขึ้นในหน้ารายละเอียด): เดิมค้นหาคอลัมน์ชื่อ 'DriveLinks' และ
    // 'DriveLinks_URLs' ซึ่งเป็นชื่อคอลัมน์เก่า/คาดหวังเท่านั้น — ชีท CheckLog จริงไม่มี
    // คอลัมน์ชื่อนี้เลย คอลัมน์จริงที่เก็บ URL รูปคือ 'รูปถ่าย' (URL ดิบ, คั่น \n ถ้าหลายรูป)
    // และ 'PhotoLinkBackup' (สำรอง ค่าเดียวกัน) → เดิม indexOf คืน -1 ทั้งคู่เสมอ ทำให้
    // obj.driveUrls/driveLinks ไม่เคยมีค่าจริงเลย รูปเลยไม่ขึ้นในปุ่ม "รายละเอียด" ของ dashboard
    // ใหม่: หาคอลัมน์ชื่อจริงในชีทก่อน แล้ว fallback ไปชื่อเก่าเผื่อชีทรุ่นเก่า/อนาคตเปลี่ยนชื่อคืน
    const driveLinksIdx = headers.indexOf('รูปถ่าย') >= 0
      ? headers.indexOf('รูปถ่าย')
      : headers.indexOf('DriveLinks');
    const driveLinksUrlsIdx = headers.indexOf('PhotoLinkBackup') >= 0
      ? headers.indexOf('PhotoLinkBackup')
      : headers.indexOf('DriveLinks_URLs');
    const timestampIdx      = headers.indexOf('timestamp');

    // ── helper: ดึง URL ทั้งหมดออกจาก formula (=HYPERLINK("url",...)) หรือ plain-text
    //    (รองรับทั้งกรณีเก่าที่อาจเขียนเป็น HYPERLINK formula และกรณีปัจจุบันที่เป็น plain URL) ──
    function extractCheckPhotoUrls_(formulaStr, valueStr) {
      const f = String(formulaStr || '').trim();
      const urls = [];
      if (f) {
        const re = /HYPERLINK\("([^"]+)"/g;
        let m;
        while ((m = re.exec(f)) !== null) {
          if (m[1] && m[1].startsWith('http')) urls.push(m[1]);
        }
      }
      if (urls.length) return urls;
      const v = String(valueStr || '').trim();
      if (!v) return [];
      return v.split(/[\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
    }

    // ── รูปถ่าย / PhotoLinkBackup — รวม URL จากทั้งสองคอลัมน์ (union, ไม่ซ้ำ) ──
    // เผื่อกรณีคอลัมน์ใดคอลัมน์หนึ่งไม่มีข้อมูล (เขียนไม่สำเร็จ) แต่อีกคอลัมน์มี
    let checkPhotoUrls = [];
    if (driveLinksIdx >= 0) {
      checkPhotoUrls = checkPhotoUrls.concat(
        extractCheckPhotoUrls_(formulaRow[driveLinksIdx], row[driveLinksIdx])
      );
    }
    if (driveLinksUrlsIdx >= 0 && driveLinksUrlsIdx !== driveLinksIdx) {
      checkPhotoUrls = checkPhotoUrls.concat(
        extractCheckPhotoUrls_(formulaRow[driveLinksUrlsIdx], row[driveLinksUrlsIdx])
      );
    }
    // dedup รักษาลำดับเดิม
    checkPhotoUrls = checkPhotoUrls.filter((u, i) => checkPhotoUrls.indexOf(u) === i);

    obj.driveUrls = checkPhotoUrls;
    obj.driveLinksUrls = checkPhotoUrls.length ? checkPhotoUrls.join('\n') : '';
    obj.driveLinks = checkPhotoUrls.length ? checkPhotoUrls[0] : '';
    obj.photoLinks = obj.driveLinksUrls; // alias สำหรับ dashboard.html fallback (r.photoLinks)

    // ── timestamp จาก col จริง (ไม่ใช่ col 0 ที่เป็น ลำดับ) ──
    if (timestampIdx >= 0 && row[timestampIdx]) {
      let tsVal = row[timestampIdx];
      if (tsVal instanceof Date) {
        tsVal = Utilities.formatDate(tsVal, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      }
      obj.timestamp = tsVal;
    }

    return obj;
  }).filter(function(r) {
    return r.timestamp || r.inspDate || r.carType;
  });

  // ── normalize fuelLevel: decimal (0.25/0.5/0.75/1.0) → "25%"/"50%"/"75%"/"100%" ──
  data.forEach(function(r) {
    if (r.fuelLevel !== undefined && r.fuelLevel !== null && r.fuelLevel !== '') {
      const n = parseFloat(String(r.fuelLevel));
      if (!isNaN(n) && n >= 0 && n <= 1 && String(r.fuelLevel).indexOf('%') === -1) {
        const pct = Math.round(n * 100);
        if (pct <= 5)       r.fuelLevel = '0%';
        else if (pct <= 37) r.fuelLevel = '25%';
        else if (pct <= 62) r.fuelLevel = '50%';
        else if (pct <= 87) r.fuelLevel = '75%';
        else                r.fuelLevel = '100%';
      }
    }
  });

  return { status: 'ok', data: data, count: data.length };
}

/** getTodayCheck — รถคันนี้ตรวจแล้ววันนี้หรือยัง */
function getTodayCheck(carType) {
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CHECK);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', checked: false };

  const data = sheet.getDataRange().getValues();
  const plate = (carType || '').split(' ')[0].trim();

  for (let i = data.length - 1; i >= 1; i--) {
    const rowCar  = String(data[i][3]);
    const rowDate = parseDateToYMD(data[i][1]);
    const rowPlate = rowCar.split(' ')[0].trim();
    if (rowDate === today && (rowPlate === plate || rowCar.includes(plate) || (plate && plate.includes(rowPlate)))) {
      return {
        status   : 'ok',
        checked  : true,
        odometer : data[i][5],
        driverName: data[i][4],
        inspTime : formatTimeCell(data[i][2])
      };
    }
  }
  return { status: 'ok', checked: false };
}

/** getTodayCheckedPlates — รายการรถที่ตรวจแล้ววันนี้ */
function getTodayCheckedPlates() {
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CHECK);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { status: 'ok', today: today, checked: [] };
  }

  const rows    = sheet.getDataRange().getValues();
  const checked = [];
  const seen    = new Set(); // ป้องกัน duplicate

  rows.slice(1).forEach(function(row) {
    const rowDate = parseDateToYMD(row[1]);
    if (rowDate === today) {
      const carType = String(row[3] || '');
      if (!seen.has(carType)) {
        seen.add(carType);
        // ── ใช้ col index จาก header ชีทจริง ──
        // col[3]=ทะเบียน/รถ, col[4]=ผู้ตรวจ, col[5]=ไมล์
        // col[20]=ปริมาณน้ำมัน, col[21]=การเติมน้ำมัน
        const _hdrs = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
        const _flIdx = _hdrs.indexOf('ปริมาณน้ำมัน') >= 0 ? _hdrs.indexOf('ปริมาณน้ำมัน')
          : (_hdrs.indexOf('ระดับน้ำมันเชื้อเพลิง') >= 0 ? _hdrs.indexOf('ระดับน้ำมันเชื้อเพลิง') : 20);
        const _ffIdx = _hdrs.indexOf('การเติมน้ำมัน') >= 0 ? _hdrs.indexOf('การเติมน้ำมัน')
          : (_hdrs.indexOf('เติมน้ำมัน') >= 0 ? _hdrs.indexOf('เติมน้ำมัน') : 21);
        const _dlIdx = _hdrs.indexOf('DriveLinks') >= 0 ? _hdrs.indexOf('DriveLinks') : 32;
        checked.push({
          carType   : carType,
          driverName: String(row[4] || ''),
          inspTime  : formatTimeCell(row[2]),
          odometer  : row[5] || '',
          fuelLevel : String(row[_flIdx] || ''),
          fuelFill  : String(row[_ffIdx] || ''),
          driveLinks: String(row[_dlIdx] || '')
        });
      }
    }
  });

  return { status: 'ok', today: today, checked: checked };
}

// ════════════════════════════════════════════════════════════
//  SECTION 2: บันทึกเลขไมล์ (startmile.html)
// ════════════════════════════════════════════════════════════

/**
 * ensureExtraColumn — ตรวจสอบ/สร้าง column ใหม่ใน sheet อัตโนมัติ
 * @param {Sheet}  sheet    - Google Sheets Sheet object
 * @param {string} colName  - ชื่อ column ที่ต้องการ
 * @returns {number} 0-based index ของ column (มีอยู่แล้วหรือสร้างใหม่)
 *                   คืน -1 ถ้าเกิดข้อผิดพลาด
 */
function ensureExtraColumn(sheet, colName) {
  try {
    var lastCol = sheet.getLastColumn();
    var hdrs = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0]
          .map(function(c) { return String(c).trim(); })
      : [];
    var idx = hdrs.indexOf(colName);
    if (idx >= 0) return idx; // มีอยู่แล้ว

    // สร้าง column ใหม่ต่อท้าย
    var newCol = lastCol + 1;
    sheet.getRange(1, newCol)
      .setValue(colName)
      .setBackground('#163251')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    SpreadsheetApp.flush();
    console.log('✅ ensureExtraColumn: created "' + colName + '" at col ' + newCol);
    return lastCol; // 0-based index ของ column ใหม่
  } catch (e) {
    console.error('ensureExtraColumn("' + colName + '"):', e.message);
    return -1;
  }
}

/**
 * writeExtraField — เขียนค่าลง column ที่ระบุใน row ที่ระบุ
 * สร้าง column อัตโนมัติถ้ายังไม่มี
 */
function writeExtraField(sheet, targetRow, colName, value) {
  if (!value && value !== 0) return;
  try {
    var colIdx = ensureExtraColumn(sheet, colName);
    if (colIdx >= 0) {
      sheet.getRange(targetRow, colIdx + 1).setValue(value);
    }
  } catch (e) {
    console.error('writeExtraField("' + colName + '"):', e.message);
  }
}

// ── รูปสภาพรถก่อนออก: canonical column name ─────────────────────────
// ✅ FIX (บั๊กรูปสภาพรถก่อนออกไม่บันทึก/ไม่ขึ้นประวัติ):
// เดิมโค้ดทุกจุด (startMile, updateMileRowTripPhoto, getMileData) ค้นหา/สร้าง
// คอลัมน์ชื่อ 'รูปสภาพรถขาออก' แต่คอลัมน์จริงในชีทชื่อ ' รูปสภาพรถก่อนออก'
// (มีช่องว่างนำหน้า + ใช้คำว่า "ก่อนออก" ไม่ใช่ "ขาออก") ทำให้ชื่อไม่ตรงกันเลย
// → เขียนรูปใหม่จะไปสร้างคอลัมน์ใหม่ที่ผิดตำแหน่ง (หรือเขียนไม่สำเร็จ) และ
// getMileData() ก็หาคอลัมน์รูปไม่เจอ (จึงไม่มี URL ส่งออกไปให้ frontend เลย)
// ใหม่: รวมจุดค้นหา/สร้างคอลัมน์เป็นฟังก์ชันเดียว เทียบชื่อแบบ trim() และ
// รองรับชื่อเก่าที่อาจหลงเหลืออยู่ (รูปสภาพรถขาออก / รูปสภาพรถ) เพื่อไม่ให้เกิด
// คอลัมน์ซ้ำถ้ามีอยู่แล้ว แต่คอลัมน์ "ตัวจริง" (canonical) คือ 'รูปสภาพรถก่อนออก'
const CAR_PHOTO_OUT_COL = 'รูปสภาพรถก่อนออก';
const CAR_PHOTO_OUT_COL_ALIASES = ['รูปสภาพรถก่อนออก', 'รูปสภาพรถขาออก', 'รูปสภาพรถ'];

/**
 * findCarPhotoOutColIdx — หา index (0-based) ของคอลัมน์ "รูปสภาพรถก่อนออก" จาก header
 * จริงในชีท โดยเทียบแบบ trim() กันช่องว่างเกินมาก่อกวน และรองรับชื่อ alias เก่า
 * ถ้าไม่พบเลย → คืน -1 (ผู้เรียกตัดสินใจว่าจะสร้างคอลัมน์ใหม่หรือไม่)
 */
function findCarPhotoOutColIdx(hdrs) {
  var trimmed = hdrs.map(function(h) { return String(h).trim(); });
  for (var a = 0; a < CAR_PHOTO_OUT_COL_ALIASES.length; a++) {
    var idx = trimmed.indexOf(CAR_PHOTO_OUT_COL_ALIASES[a]);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * ensureCarPhotoOutColIdx — เหมือน findCarPhotoOutColIdx แต่ถ้าไม่พบจะสร้างคอลัมน์
 * ใหม่ชื่อ CAR_PHOTO_OUT_COL (canonical, ไม่มีช่องว่างนำหน้า) ให้อัตโนมัติ
 */
function ensureCarPhotoOutColIdx(sheet) {
  var lastCol = sheet.getLastColumn();
  var hdrs = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var idx = findCarPhotoOutColIdx(hdrs);
  if (idx >= 0) return idx;
  return ensureExtraColumn(sheet, CAR_PHOTO_OUT_COL);
}

function startMile(payload) {
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_MILE, [
    'TripID','Timestamp','วันที่','เวลาออก','ทะเบียน/รถ','พนักงานขับรถ',
    'ปลายทาง','เลขไมล์ต้น','เลขไมล์ปลาย','ระยะทาง(กม.)',
    'เวลากลับ','สถานะ','น้ำมันที่เติม(ลิตร)','ราคาน้ำมัน(บาท)','หมายเหตุ','รูปบิลน้ำมัน',
    'รูปบิลน้ำมันขากลับ','จุดขอใช้รถ','รูปสภาพรถ','รูปสภาพรถขากลับ'
  ]);

  // ── แก้ไข header ที่ซ้ำกัน (col 17 ต้องชื่อ รูปบิลน้ำมันขากลับ) ──
  try {
    var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (headerRow[16] === 'รูปบิลน้ำมัน') {
      sheet.getRange(1, 17).setValue('รูปบิลน้ำมันขากลับ');
      SpreadsheetApp.flush();
      console.log('✅ Fixed duplicate header: col 17 → รูปบิลน้ำมันขากลับ');
    }
  } catch(hErr) {
    console.warn('header fix error:', hErr.message);
  }

  // ✅ FIX: header คอลัมน์รูปสภาพรถก่อนออกในชีทจริงมีช่องว่างนำหน้าติดมา
  // (' รูปสภาพรถก่อนออก') ซึ่งเป็นสาเหตุที่ทำให้ชื่อไม่ตรงกับที่โค้ดค้นหาแบบ
  // exact-match มาโดยตลอด — เคลียร์ช่องว่างออกให้ที่ต้นทางด้วยเลย (self-heal)
  try {
    var headerRow2 = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    for (var hc = 0; hc < headerRow2.length; hc++) {
      var raw = String(headerRow2[hc]);
      var trim = raw.trim();
      if (raw !== trim && trim) {
        sheet.getRange(1, hc + 1).setValue(trim);
        console.log('✅ Fixed stray whitespace in header col ' + (hc + 1) + ': "' + raw + '" → "' + trim + '"');
      }
    }
  } catch(wsErr) {
    console.warn('header whitespace fix error:', wsErr.message);
  }

  const tripId = 'T' + Date.now();

  // ── อัพโหลด fuel photo ตรงเข้า DRIVE_FOLDER ──
  let fuelPhotoUrl = payload.fuelPhotoUrl || '';
  if (!fuelPhotoUrl && payload.fuelPhotoB64 && payload.hasFuel) {
    try {
      const raw      = String(payload.fuelPhotoB64).replace(/^data:[^;]+;base64,/, '');
      const mime     = payload.fuelPhotoMime || 'image/jpeg';
      const ext      = mime.split('/')[1] || 'jpg';
      const fname    = payload.fuelPhotoName || ('fuel_' + tripId + '.' + ext);
      const bytes    = Utilities.base64Decode(raw);
      const blob     = Utilities.newBlob(bytes, mime, fname);
      const folder   = DriveApp.getFolderById(DRIVE_FOLDER);
      const file     = folder.createFile(blob);
      fuelPhotoUrl   = 'https://drive.google.com/file/d/' + file.getId() + '/view';
      console.log('✅ startMile fuel photo uploaded: ' + fname + ' → ' + fuelPhotoUrl);
    } catch(uploadErr) {
      console.error('startMile fuel photo error:', uploadErr.message);
    }
  }

  const row = [
    tripId,
    formatDisplayDate(new Date()),
    payload.tripDate      || formatThaiDate(new Date()),
    payload.tripTime      || formatTime(new Date()),
    payload.carType       || '',
    payload.driverName    || '',
    payload.destination   || '',
    Number(payload.odometerStart) || 0,
    '',   // เลขไมล์ปลาย
    '',   // ระยะทาง
    '',   // เวลากลับ
    'กำลังใช้งาน',
    payload.hasFuel ? (Number(payload.fuelLiters) || (payload.hasFuel === 'ใช่' ? 'ใช่' : '')) : '',
    payload.hasFuel ? (Number(payload.fuelPrice)  || payload.fuelPrice || '') : '',
    payload.remarks || '',
    fuelPhotoUrl    // รูปบิลน้ำมัน
  ];

  sheet.appendRow(row);
  SpreadsheetApp.flush();

  // ── เขียน field พิเศษหลัง appendRow (สร้าง column อัตโนมัติถ้ายังไม่มี) ──
  var newRow = sheet.getLastRow();

  // 1. จุดขอใช้รถ
  var requestPointsVal = String(payload.requestPoints || '').trim();
  writeExtraField(sheet, newRow, 'จุดขอใช้รถ', requestPointsVal);

  // ✅ NEW: บันทึก IP ผู้บันทึกตอนออกรถ ติดกับแถวนี้โดยตรง
  writeExtraField(sheet, newRow, 'IP ผู้บันทึก(ออกรถ)', payload.clientIp || 'unknown');

  // 2. รูปสภาพรถขาออก — อัปโหลดจาก base64 ที่ frontend ส่งมา แล้วเขียน HYPERLINK ลง Sheet
  //    ใช้ชื่อคอลัมน์ 'รูปสภาพรถขาออก' ให้ตรงกับ getMileData() และ history modal
  var tripDriveUrls = Array.isArray(payload.driveUrls)
    ? payload.driveUrls.filter(Boolean) : [];

  // อัปโหลดรูปจาก base64 (tripPhotosB64 array) ถ้ามี
  // ✅ FIX: frontend ใหม่จะกรองไม่ให้รูปที่ pre-upload สำเร็จแล้ว (มีอยู่ใน driveUrls)
  // หลุดเข้ามาใน tripPhotosB64 ซ้ำอีก — แต่กันไว้อีกชั้นที่ backend ด้วย dedup ขั้นสุดท้าย
  // ก่อนเขียนลง sheet (กันกรณี client เก่า/แคชเก่ายังส่งซ้ำมา ไม่ให้อัปโหลดรูปเดิมขึ้น Drive ซ้ำซ้อน)
  var tripPhotosB64 = Array.isArray(payload.tripPhotosB64) ? payload.tripPhotosB64 : [];
  if (tripPhotosB64.length > 0) {
    var folder = DriveApp.getFolderById(DRIVE_FOLDER);
    tripPhotosB64.forEach(function(p, idx) {
      try {
        var raw   = String(p.b64 || '').replace(/^data:[^;]+;base64,/, '');
        if (!raw) return;
        var mime  = p.mimeType || 'image/jpeg';
        var ext   = mime.split('/')[1] || 'jpg';
        var fname = p.fileName || ('tripout_' + tripId + '_' + idx + '.' + ext);
        var bytes = Utilities.base64Decode(raw);
        var blob  = Utilities.newBlob(bytes, mime, fname);
        var file  = folder.createFile(blob);
        var url   = 'https://drive.google.com/file/d/' + file.getId() + '/view';
        tripDriveUrls.push(url);
        console.log('✅ startMile trip photo ' + idx + ': ' + fname + ' → ' + url);
      } catch(uploadErr) {
        console.error('startMile tripPhoto[' + idx + '] error:', uploadErr.message);
      }
    });
  }

  // ✅ FIX: dedup ขั้นสุดท้ายก่อนเขียนลง sheet (กันลิงก์ซ้ำในคอลัมน์)
  tripDriveUrls = tripDriveUrls.filter(function(u, i) { return tripDriveUrls.indexOf(u) === i; });

  // เขียน URL ลงคอลัมน์ "รูปสภาพรถก่อนออก" เป็น plain URL คั่น \n
  // ✅ FIX: เดิม outParts.map() ไม่ return ค่า → ทำให้เขียน undefined ลง Sheet
  // ✅ FIX: เดิมเขียนลงคอลัมน์ชื่อ 'รูปสภาพรถขาออก' ซึ่งไม่ตรงกับคอลัมน์จริงในชีท
  // (' รูปสภาพรถก่อนออก') → ใช้ ensureCarPhotoOutColIdx() แทนเพื่อหา/สร้างคอลัมน์
  // ที่ถูกต้องเสมอ (ดูคอมเมนต์ที่ CAR_PHOTO_OUT_COL ด้านบน)
  // ใหม่: setValue(urls.join('\n')) ทุกกรณี — ลิงก์ดิบ คลิกได้จาก Sheet
  if (tripDriveUrls.length >= 1) {
    var colIdxOut = ensureCarPhotoOutColIdx(sheet);
    if (colIdxOut >= 0) {
      sheet.getRange(newRow, colIdxOut + 1).setValue(tripDriveUrls.join('\n'));
    } else {
      console.error('startMile: ไม่สามารถหา/สร้างคอลัมน์รูปสภาพรถก่อนออกได้');
    }
  }

  // อัปเดตสถานะใน Vehicles sheet → "กำลังใช้งาน" เมื่อออกรถ
  updateVehicleStatus(
    payload.carType    || '',
    'กำลังใช้งาน',
    payload.driverName || '',
    payload.destination || ''
  );

  // ── broadcast: ให้ทุกอุปกรณ์ที่เปิดหน้าลงเลขไมล์รีเฟรชอัตโนมัติ ──
  bumpReloadSignal(RELOAD_KEY_MILE);

  return { status: 'ok', tripId: tripId, message: 'บันทึกออกรถสำเร็จ',
           fuelPhotoUrl: fuelPhotoUrl };
}

function endMile(payload) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet) return { status: 'error', message: 'ไม่พบ MileLog sheet' };

  const data    = sheet.getDataRange().getValues();
  const hdrs    = data[0];  // ← header row จริงจากชีท
  // ── หา col index จาก header จริง (รองรับทั้งชื่อเก่าและชื่อใหม่) ──
  const _tripCol  = hdrs.indexOf('รหัสทริป') >= 0 ? hdrs.indexOf('รหัสทริป')
    : (hdrs.indexOf('TripID') >= 0 ? hdrs.indexOf('TripID') : 1);
  const _carCol   = hdrs.indexOf('ทะเบียน/รถ') >= 0 ? hdrs.indexOf('ทะเบียน/รถ') : 4;
  const _statCol  = hdrs.indexOf('ผู้โดยสาร') >= 0 ? hdrs.indexOf('ผู้โดยสาร')
    : (hdrs.indexOf('สถานะ') >= 0 ? hdrs.indexOf('สถานะ') : 11);
  const _oEndCol  = hdrs.indexOf('ไมล์สิ้นสุด') >= 0 ? hdrs.indexOf('ไมล์สิ้นสุด')
    : (hdrs.indexOf('เลขไมล์ปลาย') >= 0 ? hdrs.indexOf('เลขไมล์ปลาย') : 8);
  const _distCol  = hdrs.indexOf('ระยะทาง(กม.)') >= 0 ? hdrs.indexOf('ระยะทาง(กม.)') : 9;
  const _tBackCol = hdrs.indexOf('เวลากลับ') >= 0 ? hdrs.indexOf('เวลากลับ') : 10;
  const _fuelBkCol = hdrs.indexOf('รูปบิลน้ำมันขากลับ') >= 0 ? hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') : 16;

  const tripId  = String(payload.tripId || '').trim();
  const carType = String(payload.carType || '').trim();
  const plate   = carType.split(' ')[0].trim();

  let targetRow = -1;

  // หา row: ใช้ tripId ก่อน ถ้าไม่มีให้หาจาก plate + สถานะ "กำลังใช้งาน"
  for (let i = data.length - 1; i >= 1; i--) {
    const rowTripId = String(data[i][_tripCol]).trim();
    const rowCar    = String(data[i][_carCol]).trim();
    const rowStatus = String(data[i][11]).trim();
    const rowPlate  = rowCar.split(' ')[0].trim();

    if (tripId && rowTripId === tripId) {
      targetRow = i + 1; break;
    }
    if (!tripId && rowStatus === 'กำลังใช้งาน') {
      if (plate && (rowPlate === plate || rowCar.includes(plate) || plate.includes(rowPlate))) {
        targetRow = i + 1; break;
      }
    }
  }

  if (targetRow < 0) {
    return { status: 'error', message: 'ไม่พบข้อมูลการออกรถที่กำลังใช้งาน (plate: ' + plate + ')' };
  }

  const odomStart = Number(data[targetRow - 1][7]) || 0;
  const odomEnd   = Number(payload.odometerEnd)     || 0;
  const distance  = odomEnd > odomStart ? odomEnd - odomStart : 0;

  // ใช้ col index จาก header จริง (1-indexed สำหรับ getRange)
  sheet.getRange(targetRow, _oEndCol + 1).setValue(odomEnd);
  sheet.getRange(targetRow, _distCol + 1).setValue(distance);
  sheet.getRange(targetRow, _tBackCol + 1).setValue(payload.returnTime || formatTime(new Date()));
  sheet.getRange(targetRow, _statCol + 1).setValue('พร้อมใช้งาน');
  const _remarksCol = hdrs.indexOf('หมายเหตุ') >= 0 ? hdrs.indexOf('หมายเหตุ') + 1 : 15;
  if (payload.remarks) sheet.getRange(targetRow, _remarksCol).setValue(payload.remarks);

  // ✅ NEW: บันทึก IP ผู้บันทึกตอนปิดงาน แยกคอลัมน์จากตอนออกรถ (อาจเป็นคนละคนกัน)
  writeExtraField(sheet, targetRow, 'IP ผู้บันทึก(ปิดงาน)', payload.clientIp || 'unknown');

  // ── รูปบิลน้ำมันขากลับ (col 17 = returnFuelPhoto) ──
  // ป้องกันบัค: ห้ามเขียน URL ซ้ำกับแถวอื่น (กรณี frontend ส่ง URL ค้างจากทริปก่อนหน้า)
  // และต้องมีการติ๊ก "เติมน้ำมันขากลับ" จริง (hasReturnFuel = 'ใช่') เท่านั้น
  const _hasReturnFuel = String(payload.hasReturnFuel || '').trim() === 'ใช่';

  function isDuplicateReturnFuelUrl(url) {
    if (!url) return false;
    const allFormulas = sheet.getDataRange().getFormulas();
    const allValues   = sheet.getDataRange().getValues();
    for (let r = 1; r < allValues.length; r++) {
      if (r === targetRow - 1) continue; // ข้ามแถวตัวเอง
      const f = String(allFormulas[r][_fuelBkCol] || '');
      const v = String(allValues[r][_fuelBkCol] || '');
      const m = f.match(/=HYPERLINK\("([^"]+)"/i);
      const existingUrl = (m && m[1]) || (v.startsWith('http') ? v : '');
      if (existingUrl && existingUrl === url) return true;
    }
    return false;
  }

  if (_hasReturnFuel && payload.returnFuelPhotoUrl) {
    if (isDuplicateReturnFuelUrl(payload.returnFuelPhotoUrl)) {
      console.warn('⚠️ endMile: returnFuelPhotoUrl ซ้ำกับแถวอื่น — ข้ามการเขียน (' + payload.returnFuelPhotoUrl + ')');
      payload.returnFuelPhotoUrl = '';
    } else {
      sheet.getRange(targetRow, _fuelBkCol + 1).setValue(payload.returnFuelPhotoUrl);
    }
  } else if (_hasReturnFuel && payload.returnFuelPhotoB64) {
    try {
      var rfRaw  = String(payload.returnFuelPhotoB64).replace(/^data:[^;]+;base64,/, '');
      var rfMime = payload.returnFuelPhotoMime || 'image/jpeg';
      var rfExt  = rfMime.split('/')[1] || 'jpg';
      var rfName = payload.returnFuelPhotoName || ('fuel_return_' + Date.now() + '.' + rfExt);
      var rfBytes = Utilities.base64Decode(rfRaw);
      var rfBlob  = Utilities.newBlob(rfBytes, rfMime, rfName);
      var rfFile  = DriveApp.getFolderById(DRIVE_FOLDER).createFile(rfBlob);
      var rfUrl   = 'https://drive.google.com/file/d/' + rfFile.getId() + '/view';
      sheet.getRange(targetRow, _fuelBkCol + 1).setValue(rfUrl);
      payload.returnFuelPhotoUrl = rfUrl;
      console.log('✅ endMile returnFuelPhoto uploaded: ' + rfName + ' → ' + rfUrl);
    } catch(rfErr) {
      console.error('endMile returnFuelPhoto error:', rfErr.message);
    }
  } else if (!_hasReturnFuel) {
    // ไม่ได้ติ๊กเติมน้ำมันขากลับ — เคลียร์ค่าเดิม (เผื่อมีข้อมูลค้างจากการกรอกผิด)
    if (payload.returnFuelPhotoUrl || payload.returnFuelPhotoB64) {
      console.warn('⚠️ endMile: ได้รับรูปบิลขากลับ แต่ hasReturnFuel ไม่ใช่ "ใช่" — ไม่บันทึก');
    }
  }


  // ── รูปสภาพรถขากลับ — สร้าง column อัตโนมัติถ้ายังไม่มี ──
  // ✅ FIX: ป้องกันบัค URL รูปค้างจากทริป/รถคันก่อนหน้า (frontend ไม่ได้เคลียร์ state)
  // ใช้หลักการเดียวกับ isDuplicateReturnFuelUrl ด้านบน — ถ้า URL นี้มีอยู่ในแถวอื่นแล้ว แสดงว่าไม่ใช่ของทริปนี้ ให้ข้ามไป
  function isDuplicateReturnCarUrl(url) {
    if (!url) return false;
    var rcCheckColIdx = hdrs.indexOf('รูปสภาพรถขากลับ');
    if (rcCheckColIdx < 0) return false; // ยังไม่มี column นี้ → ไม่มีทางซ้ำ
    var allFormulas = sheet.getDataRange().getFormulas();
    var allValues   = sheet.getDataRange().getValues();
    for (var r = 1; r < allValues.length; r++) {
      if (r === targetRow - 1) continue; // ข้ามแถวตัวเอง (ทริปนี้เอง)
      var f = String(allFormulas[r][rcCheckColIdx] || '');
      var v = String(allValues[r][rcCheckColIdx] || '');
      var rowUrls = [];
      var m = f.match(/=HYPERLINK\("([^"]+)"/i);
      if (m && m[1]) rowUrls.push(m[1]);
      v.split('\n').forEach(function(u) { u = u.trim(); if (u.indexOf('http') === 0) rowUrls.push(u); });
      if (rowUrls.indexOf(url) >= 0) return true;
    }
    return false;
  }

  var retCarUrls = Array.isArray(payload.returnCarDriveUrls)
    ? payload.returnCarDriveUrls.filter(Boolean) : [];
  var filteredRetCarUrls = retCarUrls.filter(function(u) {
    if (isDuplicateReturnCarUrl(u)) {
      console.warn('⚠️ endMile: returnCarDriveUrls มี URL ซ้ำกับแถวอื่น (ไม่ใช่ของทริปนี้) — ข้ามการเขียน (' + u + ')');
      return false;
    }
    return true;
  });

  if (filteredRetCarUrls.length === 1) {
    var rcColIdx = ensureExtraColumn(sheet, 'รูปสภาพรถขากลับ');
    if (rcColIdx >= 0) {
      sheet.getRange(targetRow, rcColIdx + 1).setValue(filteredRetCarUrls[0]);
    }
  } else if (filteredRetCarUrls.length > 1) {
    writeExtraField(sheet, targetRow, 'รูปสภาพรถขากลับ', filteredRetCarUrls.join('\n'));
  }

  // ⛽ บันทึก "ลิตร/ราคา" ที่เติมขากลับ (เดิมหน้าเว็บส่งมาแต่ backend ไม่ได้เก็บ)
  try {
    var _rfL = String(payload.returnFuelLiters == null ? '' : payload.returnFuelLiters).trim();
    var _rfP = String(payload.returnFuelPrice  == null ? '' : payload.returnFuelPrice).trim();
    if (_rfL) writeExtraField(sheet, targetRow, 'ลิตรเติมขากลับ', Number(_rfL) || _rfL);
    if (_rfP) writeExtraField(sheet, targetRow, 'ราคาเติมขากลับ(บาท)', Number(_rfP) || _rfP);
  } catch (rfErr) { console.warn('endMile return fuel liters/price:', rfErr.message); }

  SpreadsheetApp.flush();

  // ── ตรวจ destination: ถ้าเดินทางไปปั๊มน้ำมันและกลับมาแล้ว → บันทึก marker สำหรับสถานะน้ำมันแบบเรียลไทม์ ──
  // ⚠️ หมายเหตุสำคัญ: "สถานะ" ใน Vehicles sheet ต้องเป็นหนึ่งใน 4 ค่ามาตรฐานเท่านั้น
  //   (พร้อมใช้งาน / กำลังใช้งาน / รอตรวจสภาพรถ / รอซ่อม) เพราะหน้า dashboard.html, startmile.html,
  //   index.html เทียบค่าตรงๆ แบบ strict equality — ถ้าเขียนค่าอื่น (เช่น "เติมน้ำมันแล้ว") ลงไป
  //   รถจะหายไปจากสถานะ "พร้อมใช้งาน" ทันที (เลือกออกรถใหม่ไม่ได้) ทั้งที่จริงพร้อมใช้งาน
  //   จึงใช้วิธีเขียน marker ลง MileLog แทน แล้วให้ getStatusSummary() นำไปคำนวณ "todayFueled"
  //   เพื่อให้ dashboard แสดงป้าย "เติมแล้ว" แบบเรียลไทม์ โดยไม่ต้องรอรูปบิลน้ำมัน
  // รองรับชื่อ: ปตท, บางจาก, เชลล์, เอสโซ่, คาลเท็กซ์, ซัสโก้, ปั๊ม/ปั้ม PT, รวีกาญจน์, ปั๊มน้ำมัน, ปั้มน้ำมัน ฯลฯ
  const tripDestination = String(data[targetRow - 1][6] || payload.destination || '').trim();
  const wentToFuelStation = isFuelStation(tripDestination);

  if (wentToFuelStation) {
    console.log('⛽ endMile: ตรวจพบเดินทางไปปั๊มน้ำมัน ("' + tripDestination + '") และกลับมาแล้ว → บันทึกสถานะ "เติมน้ำมันแล้ว" แบบเรียลไทม์');
    // เขียน marker ลง MileLog (สร้าง column อัตโนมัติถ้ายังไม่มี) — ใช้เพื่อ audit/อ้างอิงเท่านั้น
    writeExtraField(sheet, targetRow, 'ตรวจพบเติมน้ำมัน(ปลายทาง)', 'ใช่ — ' + tripDestination);
    // ── เขียน column "น้ำมันที่เติม(ลิตร)" ให้มี marker "auto" ถ้ายังว่างอยู่ ──
    // เพื่อให้ getStatusSummary() section 6.4 จับได้แม้ไม่มีรูปบิล (Case B)
    try {
      var mHdrRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
      var fuelColI = mHdrRow.indexOf('น้ำมันที่เติม(ลิตร)');
      if (fuelColI < 0) fuelColI = mHdrRow.indexOf('น้ำมันที่เติม');
      if (fuelColI >= 0) {
        var fuelCell = sheet.getRange(targetRow, fuelColI + 1);
        var existVal = String(fuelCell.getValue() || '').trim();
        if (!existVal || existVal === '0') {
          fuelCell.setValue('auto');
          console.log('⛽ endMile: เขียน marker auto → น้ำมันที่เติม(ลิตร) row=' + targetRow);
        }
      }
    } catch(mErr) { console.warn('endMile fuelMarker:', mErr.message); }
  }

  // ── ตรวจ destination: ถ้าเดินทางไป "เปลี่ยนออกซิเจน" และกลับมาแล้ว → บันทึก marker
  //    สำหรับสถานะ O₂ แบบเรียลไทม์ (ใช้คู่กับ oxygenAlerts ใน getStatusSummary())
  //    รูปแบบเดียวกับ wentToFuelStation ด้านบน — ไม่แตะ "สถานะ" มาตรฐานใน Vehicles sheet ──
  const wentToChangeOxygen = isOxygenChangeMission(tripDestination);
  if (wentToChangeOxygen) {
    console.log('🅾️ endMile: ตรวจพบเดินทางไป "' + tripDestination + '" (เปลี่ยนออกซิเจน) และกลับมาแล้ว → บันทึกสถานะ "เปลี่ยนแล้ว" แบบเรียลไทม์');
    writeExtraField(sheet, targetRow, 'ตรวจพบเปลี่ยนออกซิเจน(ปลายทาง)', 'ใช่ — ' + tripDestination);
  }

  // อัปเดตสถานะใน Vehicles sheet → กลับเป็น "พร้อมใช้งาน" เสมอ (สถานะมาตรฐาน 1 ใน 4 ค่า)
  updateVehicleStatus(
    carType,
    'พร้อมใช้งาน',
    '',
    ''
  );

  const anomaly = detectMileAnomaly(data[targetRow - 1], odomEnd, distance);
  if (anomaly) notifyAnomaly(anomaly);

  // ── broadcast: ให้ทุกอุปกรณ์ที่เปิดหน้าลงเลขไมล์รีเฟรชอัตโนมัติ ──
  bumpReloadSignal(RELOAD_KEY_MILE);

  return {
    status  : 'ok',
    distance: distance,
    message : 'บันทึกกลับสำเร็จ ระยะทาง ' + distance + ' กม.'
      + (wentToFuelStation ? ' (ตรวจพบเติมน้ำมันที่ปั๊มอัตโนมัติ จากปลายทาง "' + tripDestination + '")' : '')
      + (wentToChangeOxygen ? ' (ตรวจพบเปลี่ยนออกซิเจน จากปลายทาง "' + tripDestination + '")' : ''),
    vehicleStatus: 'พร้อมใช้งาน',
    fueledAtStation: wentToFuelStation,
    oxygenChanged: wentToChangeOxygen,
    anomaly : anomaly || null,
    returnFuelPhotoUrl: payload.returnFuelPhotoUrl || ''
  };
}

function saveFuel(payload) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet) return { status: 'error', message: 'ไม่พบ MileLog sheet' };

  const data  = sheet.getDataRange().getValues();
  const plate = (payload.carType || '').split(' ')[0].trim();

  for (let i = data.length - 1; i >= 1; i--) {
    const rowPlate = String(data[i][4]).split(' ')[0].trim();
    if (rowPlate === plate || String(data[i][4]).includes(plate)) {
      sheet.getRange(i + 1, 13).setValue(payload.fuelLiters || '');
      sheet.getRange(i + 1, 14).setValue(payload.fuelPrice  || '');
      SpreadsheetApp.flush();
      return { status: 'ok', message: 'บันทึกการเติมน้ำมันสำเร็จ' };
    }
  }
  return { status: 'error', message: 'ไม่พบข้อมูลการเดินทางของรถคันนี้' };
}

function getMileData(opts) {
  const lm = opts && (opts.limit != null ? opts.limit : (opts.parameter && opts.parameter.limit));
  if (Number(lm) > 0) return cached_('MILE' + Math.floor(Number(lm)), 30, function () { return getMileDataCompute_(opts); });
  return getMileDataCompute_(opts);   // ไม่ระบุ limit (editmile.html) = สดเสมอ ไม่แคช
}

function getMileDataCompute_(opts) {
  // ✅ NEW: รองรับ limit — ดึงเฉพาะ N แถวล่าสุด แทนทั้งชีท
  // ใช้สำหรับหน้าที่โชว์แค่ประวัติล่าสุด (เช่น startmile.html) เพื่อลดเวลาโหลด
  // ไม่ระบุ limit = พฤติกรรมเดิมทุกประการ (ดึงทั้งชีท เช่น editmile.html ที่ต้องแก้ไข/ลบทริปเก่าได้ทุกรายการ)
  const limitRaw = opts && (opts.limit != null ? opts.limit : (opts.parameter && opts.parameter.limit));
  const limit = Number(limitRaw) > 0 ? Math.floor(Number(limitRaw)) : 0;

  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  let rows, formulas;

  // ✅ FIX BUG: เดิมโค้ดสมมติว่า "N แถวล่าสุด" = N แถวท้ายสุดของชีทเสมอ (lastRow - limit + 1)
  // ซึ่งถูกก็ต่อเมื่อชีทเรียงจากเก่า→ใหม่ตามลำดับแถว (append order) เท่านั้น
  // แต่ถ้าชีทจริงถูกจัดเรียงใหม่ล่าสุดไว้ "บนสุด" (หรือถูก sort/แก้ไขจนลำดับแถวไม่ตรงกับ Timestamp แล้ว)
  // การดึงแบบเดิมจะได้แถวที่ "เก่าที่สุด" ไปแทน ทำให้หน้า "ประวัติการใช้รถ" ค้างอยู่ที่วันที่เก่า
  //
  // ใหม่: หาคอลัมน์ Timestamp แล้วอ่านเฉพาะคอลัมน์นั้นทั้งชีทก่อน (ถูกมาก แค่ 1 คอลัมน์)
  // เพื่อหาว่า N แถวที่ Timestamp ใหม่ที่สุดจริงๆ อยู่แถวไหนบ้าง — ไม่ยึดตำแหน่งแถวอีกต่อไป
  const headerValsChk = sheet.getRange(1, 1, 1, lastCol).getValues();
  // ✅ FIX (บั๊ก "ประวัติไม่ใช่รายการล่าสุด"): เดิมหาคอลัมน์ Timestamp ด้วย exact-match
  // 'Timestamp' (ตัว T ใหญ่ เอกพจน์) แต่คอลัมน์จริงในชีท MileLog ชื่อ 'timestamps'
  // (ตัวเล็กทั้งหมด + พหูพจน์) ทำให้ indexOf หาไม่เจอเสมอ (คืน -1) → โค้ดตกไปใช้ fallback
  // เดิมที่ดึง "N แถวท้ายสุดของชีท" ซึ่งถูกก็ต่อเมื่อแถวใหม่ถูก append ต่อท้ายเท่านั้น
  // แต่ชีทจริงมีการแทรกแถวใหม่ไว้ "บนสุด" (row 2) เสมอ → แถวท้ายสุดคือแถวที่ "เก่าที่สุด"
  // ผลคือหน้าประวัติได้ข้อมูลเก่าที่สุด ไม่ใช่ล่าสุด — แก้โดยเทียบชื่อแบบ trim() + ไม่สนตัวพิมพ์เล็ก/ใหญ่
  // และรองรับทั้งเอกพจน์/พหูพจน์ ('Timestamp'/'timestamp'/'Timestamps'/'timestamps')
  const tsColIdx0 = headerValsChk[0].findIndex(function(h) {
    const norm = String(h || '').trim().toLowerCase();
    return norm === 'timestamp' || norm === 'timestamps';
  });

  function parseTsMs(v) {
    if (v instanceof Date) return v.getTime();
    const s = String(v || '').trim();
    if (!s) return 0;
    const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m1) {
      const y = +m1[3], mo = +m1[2] - 1, d = +m1[1], hh = +(m1[4] || 0), mm = +(m1[5] || 0), ss = +(m1[6] || 0);
      return new Date(y, mo, d, hh, mm, ss).getTime();
    }
    const t = Date.parse(s.replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }

  if (limit > 0 && lastRow - 1 > limit && tsColIdx0 >= 0) {
    const tsCol1 = tsColIdx0 + 1;
    const tsVals = sheet.getRange(2, tsCol1, lastRow - 1, 1).getValues();
    const withMs = tsVals.map(function(r, i) { return { row: i + 2, ms: parseTsMs(r[0]) }; });
    withMs.sort(function(a, b) { return b.ms - a.ms; }); // ใหม่ → เก่า
    const topRows = withMs.slice(0, limit).map(function(o) { return o.row; });
    const minRow = Math.min.apply(null, topRows);
    const maxRow = Math.max.apply(null, topRows);

    if (maxRow - minRow + 1 === limit) {
      // กรณีปกติ: N แถวใหม่สุดอยู่ติดกันเป็นก้อนเดียว (ไม่ว่าจะอยู่บนสุดหรือล่างสุดของชีท) → ดึง range เดียว เร็วเท่าเดิม
      const dataValsRange = sheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol);
      const dataVals      = dataValsRange.getValues();
      const dataFormulas  = dataValsRange.getFormulas();
      rows     = headerValsChk.concat(dataVals);
      formulas = [new Array(lastCol)].concat(dataFormulas);
    } else {
      // กรณีแถวใหม่สุดกระจัดกระจาย ไม่ติดกัน → fallback ดึงทั้งชีทเพื่อความถูกต้อง (จะเรียง/ตัดตาม Timestamp อีกทีด้านล่าง)
      const dataRange = sheet.getDataRange();
      rows     = dataRange.getValues();
      formulas = dataRange.getFormulas();
    }
  } else if (limit > 0 && lastRow - 1 > limit) {
    // ไม่พบคอลัมน์ Timestamp เลย → fallback พฤติกรรมเดิม (ดึง N แถวจากท้ายชีท)
    const startRow = lastRow - limit + 1;
    const dataValsRange = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol);
    const dataVals      = dataValsRange.getValues();
    const dataFormulas  = dataValsRange.getFormulas();
    rows     = headerValsChk.concat(dataVals);
    formulas = [new Array(lastCol)].concat(dataFormulas);
  } else {
    const dataRange = sheet.getDataRange();
    rows      = dataRange.getValues();
    formulas  = dataRange.getFormulas();  // ← ดึง formula ทุก cell (แก้บัค: getValues ได้ display text ไม่ใช่ URL)
  }
  const headers   = rows[0];

  // ── helper: แกะ URL ทั้งหมดออกจาก =HYPERLINK(...)&CHAR(10)&HYPERLINK(...) formula
  //    (รองรับหลาย URL ในเซลล์เดียว) หรือจาก plain-text value คั่นด้วย \n ──
  // ✅ FIX: เดิม extractUrl() ใช้ String.match() (ไม่ใช่ global) จึงดึงได้แค่ URL แรก
  // เมื่อเซลล์มีหลาย HYPERLINK ต่อกัน (รูปสภาพรถขาออกที่มี >1 รูป) ทำให้ดึง URL รูปอื่นๆหายไป
  function extractAllUrls(formulaStr, valueStr) {
    const f = String(formulaStr || '').trim();
    const urls = [];
    if (f) {
      const re = /HYPERLINK\("([^"]+)"/g;
      let m;
      while ((m = re.exec(f)) !== null) {
        if (m[1] && m[1].startsWith('http')) urls.push(m[1]);
      }
    }
    if (urls.length) return urls;
    // fallback: plain-text URL(s) จาก getValues() คั่นด้วย \n
    const v = String(valueStr || '').trim();
    if (v) {
      return v.split('\n').map(function(u){ return u.trim(); })
        .filter(function(u){ return u.startsWith('http'); });
    }
    return [];
  }

  // ── helper: แกะ URL ออกจาก HYPERLINK formula หรือ plain URL ──
  // ใช้ formulaStr ก่อน (ถ้ามี) แล้วค่อย fallback ไป valueStr
  function extractUrl(formulaStr, valueStr) {
    // formula: =HYPERLINK("url","label") → ดึง url
    const f = String(formulaStr || '').trim();
    const m = f.match(/=HYPERLINK\("([^"]+)"/i);
    if (m && m[1].startsWith('http')) return m[1];
    // plain URL จาก getValues()
    const v = String(valueStr || '').trim();
    if (v.startsWith('http')) return v;
    return '';
  }

  // col index (0-based) — ค้นหาจาก header จริงเพื่อรองรับชีทที่มี column เพิ่มเติม
  // ชีทจริง: col 16 = รูปบิลน้ำมันออกรถ, col 17 = timestamp, col 18 = รูปบิลน้ำมันขากลับ
  const fuelPhotoIdx = headers.indexOf('รูปบิลน้ำมันออกรถ') >= 0
    ? headers.indexOf('รูปบิลน้ำมันออกรถ')
    : (headers.indexOf('รูปบิลน้ำมัน') >= 0 ? headers.indexOf('รูปบิลน้ำมัน') : 15);
  const returnFuelPhotoIdx = headers.lastIndexOf('รูปบิลน้ำมันขากลับ') >= 0
    ? headers.lastIndexOf('รูปบิลน้ำมันขากลับ')
    : 17; // col 18 (0-based idx 17) ในชีทที่มี timestamp แทรกที่ col 17
  // ── รูปสภาพรถขาออก (ก่อนออก) / รูปสภาพรถขากลับ ──
  // ✅ FIX: เดิมหาคอลัมน์ด้วยชื่อ exact-match 'รูปสภาพรถขาออก' หรือ 'รูปสภาพรถ' เท่านั้น
  // แต่คอลัมน์จริงในชีทชื่อ ' รูปสภาพรถก่อนออก' (มีช่องว่างนำหน้า + คำต่างกัน) ทำให้
  // ไม่เจอคอลัมน์เลย → รูปสภาพรถก่อนออกไม่เคยถูกส่งออกไปให้ frontend เลยแม้แต่รูปเดียว
  // ใหม่: ใช้ findCarPhotoOutColIdx() เทียบชื่อแบบ trim() + รองรับ alias เก่าทั้งหมด
  const carPhotoOutIdx = findCarPhotoOutColIdx(headers);
  const carPhotoBackIdx = headers.indexOf('รูปสภาพรถขากลับ') >= 0
    ? headers.indexOf('รูปสภาพรถขากลับ') : -1;

  const data = rows.slice(1).map(function(row, rowIdx) {
    const formulaRow = formulas[rowIdx + 1] || [];
    const obj = {};

    headers.forEach(function(h, i) {
      if (i === fuelPhotoIdx || i === returnFuelPhotoIdx) return; // จัดการแยกด้านล่าง
      let v = row[i];
      if (v instanceof Date) v = formatDisplayDate(v);
      obj[h] = v;
      // ── alias keys สำหรับ header ชีทจริงที่ต่างจาก EXPECTED_HEADERS ──
      if (h === 'น้ำมันที่เติม(ลิตร)')  obj['fuelLiters']  = v;
      if (h === 'ราคาน้ำมัน(บาท)' || h === 'ราคาน้ำมัน') obj['fuelPrice'] = v;
      if (h === 'ทะเบียน/รถ')            obj['carType']     = obj['carType'] || v;
      // ── header ชีทจริง → alias ที่ dashboard JS คาดหวัง ──
      if (h === 'ไมล์เริ่มต้น')          obj['เลขไมล์ต้น']  = v;  // ← ชีทจริงใช้ชื่อนี้
      if (h === 'ไมล์สิ้นสุด')           obj['เลขไมล์ปลาย'] = v;  // ← ชีทจริงใช้ชื่อนี้
      if (h === 'ผู้โดยสาร')             obj['สถานะ']        = v;  // ← col 11 เก็บสถานะจริง
      if (h === 'รหัสทริป')              obj['TripID']       = v;  // ← ชีทจริงใช้ชื่อนี้
      if (h === 'เวลาออก' && v)          obj['เวลาออก']     = typeof v === 'object' ? v : v;
      if (h === 'เวลากลับ' && v)         obj['เวลากลับ']    = typeof v === 'object' ? v : v;
      if (h === 'ระยะทาง(กม.)')          obj['ระยะทาง(กม.)'] = v;
      // ── Timestamp → timestamp alias (สำหรับ dashboard JS ที่ใช้ r.timestamp / r['Timestamp']) ──
      // ✅ FIX: คอลัมน์จริงในชีท MileLog ชื่อ 'timestamps' (พหูพจน์ตัวเล็ก) ไม่ใช่ 'Timestamp'/'timestamp'
      // เดิมเช็คแค่ 2 แบบนี้จึงไม่เคยตรงเลย → obj['timestamp'] ไม่ถูกตั้งค่า ทำให้เรียงประวัติผิดพลาด
      if (String(h || '').trim().toLowerCase() === 'timestamp' ||
          String(h || '').trim().toLowerCase() === 'timestamps') obj['timestamp'] = v;
    });


    // ใช้ getFormulas() เพื่อดึง URL จริงจาก =HYPERLINK formula
    // (getValues() ส่งคืน display text "ดูบิลน้ำมัน" ไม่ใช่ URL)
    const fuelUrl = extractUrl(formulaRow[fuelPhotoIdx], row[fuelPhotoIdx]);
    obj['รูปบิลน้ำมันออกรถ'] = fuelUrl || String(row[fuelPhotoIdx] || '');
    obj['รูปบิลน้ำมัน']      = obj['รูปบิลน้ำมันออกรถ']; // alias backward compat
    obj['fuelPhotoUrl']       = fuelUrl;

    // ── col รูปบิลน้ำมันขากลับ (ค้นหาจาก header จริง) ──
    const returnUrl = extractUrl(formulaRow[returnFuelPhotoIdx], row[returnFuelPhotoIdx]);
    obj['รูปบิลน้ำมันขากลับ'] = returnUrl || String(row[returnFuelPhotoIdx] || '');
    obj['returnFuelPhotoUrl']  = returnUrl;

    // ── รูปสภาพรถขาออก — ใช้ getFormulas() เพื่อดึง URL ทั้งหมดจาก =HYPERLINK formula(s) ──
    if (carPhotoOutIdx >= 0) {
      const carOutFormula = String(formulaRow[carPhotoOutIdx] || '').trim();
      const carOutVal     = String(row[carPhotoOutIdx] || '').trim();
      const carOutUrls    = extractAllUrls(carOutFormula, carOutVal);
      if (carOutUrls.length === 1) {
        // รูปเดียว → ส่งเป็น URL string (ส่งครบทุก alias ที่ frontend อาจอ่าน)
        obj['รูปสภาพรถก่อนออก'] = carOutUrls[0]; // canonical (ตรงกับคอลัมน์จริง)
        obj['รูปสภาพรถขาออก']   = carOutUrls[0];
        obj['รูปสภาพรถ']         = carOutUrls[0]; // backward compat
      } else if (carOutUrls.length > 1) {
        // หลายรูป → ส่งเป็น string คั่น \n (ของเดิม) + array เพิ่มเติมสำหรับ frontend ที่รองรับหลายรูป
        obj['รูปสภาพรถก่อนออก']     = carOutUrls.join('\n');
        obj['รูปสภาพรถขาออก']      = carOutUrls.join('\n');
        obj['รูปสภาพรถ']            = carOutUrls.join('\n');
        obj['รูปสภาพรถก่อนออกList'] = carOutUrls;
        obj['รูปสภาพรถขาออกList']   = carOutUrls;
      }
      // ถ้าไม่มี URL จริง (เช่น "ดูรูปรถ") ไม่ส่งออก → ป้องกัน broken link
    }

    // ── รูปสภาพรถขากลับ — ใช้ getFormulas() เช่นกัน ──
    if (carPhotoBackIdx >= 0) {
      const carBackFormula = String(formulaRow[carPhotoBackIdx] || '').trim();
      const carBackVal     = String(row[carPhotoBackIdx] || '').trim();
      const carBackUrls    = extractAllUrls(carBackFormula, carBackVal);
      if (carBackUrls.length === 1) {
        obj['รูปสภาพรถขากลับ'] = carBackUrls[0];
      } else if (carBackUrls.length > 1) {
        obj['รูปสภาพรถขากลับ']      = carBackUrls.join('\n');
        obj['รูปสภาพรถขากลับList']  = carBackUrls;
      }
    }


    return obj;
  }).filter(function(r) { return r['TripID'] || r['ทะเบียน/รถ']; });

  // ✅ safety net: เรียงผลลัพธ์สุดท้ายตาม Timestamp ใหม่→เก่าเสมอ ก่อนตัดตาม limit
  // กันไว้เผื่อกรณี fallback ที่ดึงทั้งชีทมา (แถวไม่ได้เรียงตาม Timestamp อยู่แล้ว)
  function finalRowMs(r) {
    // ✅ FIX: เพิ่ม r['timestamps'] (ชื่อ header จริงในชีท) เข้าไปในลำดับ fallback ด้วย
    return parseTsMs(r['Timestamp'] || r['timestamp'] || r['timestamps'] || r['วันที่']);
  }
  data.sort(function(a, b) { return finalRowMs(b) - finalRowMs(a); });
  const finalData = limit > 0 ? data.slice(0, limit) : data;

  return { status: 'ok', data: finalData, count: finalData.length };
}

function getLastMile(carType) {
  // MileLog columns (0-indexed):
  // 0=TripID, 1=Timestamp, 2=วันที่, 3=เวลาออก, 4=ทะเบียน/รถ
  // 5=พนักงานขับรถ, 6=ปลายทาง, 7=เลขไมล์ต้น, 8=เลขไมล์ปลาย
  // 9=ระยะทาง(กม.), 10=เวลากลับ, 11=สถานะ

  const ss    = getSpreadsheet();
  const plate = (carType || '').split(' ')[0].trim();

  let lastOdoEnd   = null;   // เลขไมล์ปลาย (trip เสร็จ)
  let lastOdoStart = null;   // เลขไมล์ต้น (trip ล่าสุด fallback)
  let lastDate     = '';
  let lastDateStart = '';

  // ── 1. ดึงจาก MileLog คอลัมน์ "เลขไมล์ปลาย" เป็นหลัก ──
  const mileSheet = ss.getSheetByName(SHEET_MILE);
  if (mileSheet && mileSheet.getLastRow() > 1) {
    const data = mileSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowCar   = String(data[i][4] || '');
      const rowPlate = rowCar.split(' ')[0].trim();
      if (rowPlate !== plate && !rowCar.includes(plate)) continue;

      const rowDate  = parseDateToYMD(data[i][2]);   // คอลัมน์ วันที่
      const odoEnd   = Number(data[i][8])  || 0;      // เลขไมล์ปลาย
      const odoStart = Number(data[i][7])  || 0;      // เลขไมล์ต้น

      // หา เลขไมล์ปลาย ที่มีค่า และ trip วันที่ล่าสุด
      if (odoEnd > 0) {
        if (!lastDate || rowDate >= lastDate) {
          lastDate   = rowDate;
          lastOdoEnd = odoEnd;
        }
      }
      // เก็บ เลขไมล์ต้น ไว้ fallback (trip ล่าสุดที่ยังไม่กลับ)
      if (odoStart > 0) {
        if (!lastDateStart || rowDate >= lastDateStart) {
          lastDateStart = rowDate;
          lastOdoStart  = odoStart;
        }
      }
    }
  }

  // ถ้ามีเลขไมล์ปลาย → ใช้เลย (trip ล่าสุดที่กลับแล้ว)
  if (lastOdoEnd) {
    return { status: 'ok', odometer: lastOdoEnd, date: lastDate, source: 'MileLog_end' };
  }

  // fallback: เลขไมล์ต้น (กรณียังออกอยู่ / ยังไม่มีเลขปลาย)
  if (lastOdoStart) {
    return { status: 'ok', odometer: lastOdoStart, date: lastDateStart, source: 'MileLog_start' };
  }

  // ── 2. fallback สุดท้าย: CheckLog (เลขไมล์ตรวจสภาพ) ──
  const checkSheet = ss.getSheetByName(SHEET_CHECK);
  let chkOdo = null, chkDate = '';
  if (checkSheet && checkSheet.getLastRow() > 1) {
    const data = checkSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const rowCar   = String(data[i][3] || '');
      const rowPlate = rowCar.split(' ')[0].trim();
      const rowDate  = parseDateToYMD(data[i][1]);
      const rowOdo   = Number(data[i][5]) || 0;
      if ((rowPlate === plate || rowCar.includes(plate)) && rowOdo > 0) {
        if (!chkDate || rowDate >= chkDate) { chkDate = rowDate; chkOdo = rowOdo; }
      }
    }
  }

  return { status: 'ok', odometer: chkOdo, date: chkDate, source: 'CheckLog' };
}

/**
 * getActiveTripByPlate — ดึง trip ที่กำลังใช้งานของรถคันที่ระบุ
 * ใช้โดย endMile dropdown เพื่อดึง tripId + odometerStart
 */
function getActiveTripByPlate(plate) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', found: false };

  const data  = sheet.getDataRange().getValues();
  const p     = (plate || '').split(' ')[0].trim();

  for (let i = data.length - 1; i >= 1; i--) {
    const rowCar    = String(data[i][4]);
    const rowStatus = String(data[i][11]);
    const rowPlate  = rowCar.split(' ')[0].trim();
    if (rowStatus === 'กำลังใช้งาน' && (rowPlate === p || rowCar.includes(p) || p.includes(rowPlate))) {
      return {
        status      : 'ok',
        found       : true,
        tripId      : String(data[i][0]),
        carType     : rowCar,
        driverName  : String(data[i][5]),
        destination : String(data[i][6]),
        odometerStart: Number(data[i][7]) || 0,
        tripDate     : parseDateToYMD(data[i][2]),
        tripTime     : String(data[i][3]),
        fuelPhotoUrl : (function() {
          // getValues() คืน display text "ดูบิลน้ำมัน" แทน URL จาก =HYPERLINK formula
          // → ต้องดึง formula จาก sheet ก่อนแกะ URL ออก
          var raw = String(data[i][15] || data[i][16] || '').trim();
          var m   = raw.match(/=HYPERLINK\("([^"]+)"/i);
          if (m) return m[1];
          return raw.startsWith('http') ? raw : '';
        })()   // col 16-17 = รูปบิลน้ำมัน (แกะ HYPERLINK formula ออก)
      };
    }
  }
  return { status: 'ok', found: false };
}

// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
//  SECTION 2b: รีเซตสถานะรถประจำวัน (07:00–08:00 น.)
// ════════════════════════════════════════════════════════════

/**
 * resetDailyStatus
 * - รีเซตสถานะรถทุกคันใน Vehicles sheet ให้เป็น "รอตรวจสภาพรถ"
 * - ล้าง ผู้ขับปัจจุบัน / ปลายทาง / อัปเดตล่าสุด
 * - ปิด MileLog ที่ค้างสถานะ "กำลังใช้งาน" ข้ามวัน → "พร้อมใช้งาน (ปิดอัตโนมัติ)"
 * เรียกได้เฉพาะจาก Time Trigger (scheduledDailyReset) เท่านั้น
 * 🔒 ไม่เปิดให้เรียกจาก GET/POST URL โดยตรง
 */
function resetDailyStatus() {
  try {
    const ss      = getSpreadsheet();
    const today   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
    const nowStr  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');

    // ── 1. รีเซตทุกคันใน Vehicles sheet → "รอตรวจสภาพรถ" ──
    const vSheet = ss.getSheetByName(SHEET_VEHICLE);
    if (vSheet && vSheet.getLastRow() > 1) {
      const vData = vSheet.getDataRange().getValues();
      for (var i = 1; i < vData.length; i++) {
        vSheet.getRange(i + 1, 4).setValue('รอตรวจสภาพรถ');  // col D = สถานะ
        vSheet.getRange(i + 1, 5).setValue('');               // col E = ผู้ขับปัจจุบัน
        vSheet.getRange(i + 1, 6).setValue('');               // col F = ปลายทาง
        vSheet.getRange(i + 1, 7).setValue(nowStr);           // col G = อัปเดตล่าสุด
      }
      SpreadsheetApp.flush();
    }

    // ── 2. ปิด MileLog ที่ค้างสถานะ "กำลังใช้งาน" จากวันก่อนหน้า ──
    // ใช้ header จริงในชีทเพื่อหา col index ของ "สถานะ" / "ผู้โดยสาร" (col 11 default)
    const mSheet = ss.getSheetByName(SHEET_MILE);
    var closedCount = 0;
    if (mSheet && mSheet.getLastRow() > 1) {
      const mData = mSheet.getDataRange().getValues();
      const mHdrs = mData[0];
      // หา index ของคอลัมน์ สถานะ (ชีทจริงอาจชื่อ "ผู้โดยสาร" หรือ "สถานะ")
      const statIdx = (function() {
        var idx = mHdrs.indexOf('ผู้โดยสาร');
        if (idx >= 0) return idx;
        idx = mHdrs.indexOf('สถานะ');
        if (idx >= 0) return idx;
        return 11; // fallback default
      })();
      // หา index ของคอลัมน์ วันที่ (col 2 default)
      const dateIdx = (function() {
        var idx = mHdrs.indexOf('วันที่');
        return idx >= 0 ? idx : 2;
      })();
      // หา index ของคอลัมน์ หมายเหตุ (col 14 default)
      const remIdx = (function() {
        var idx = mHdrs.indexOf('หมายเหตุ');
        return idx >= 0 ? idx : 14;
      })();

      for (var j = 1; j < mData.length; j++) {
        if (String(mData[j][statIdx]).trim() !== 'กำลังใช้งาน') continue;
        const tripDate = parseDateToYMD(mData[j][dateIdx]);
        if (tripDate === today) continue;  // trip วันนี้ยังถือว่า active ได้
        // trip ข้ามวัน → ปิดอัตโนมัติ (1-indexed)
        mSheet.getRange(j + 1, statIdx + 1).setValue('พร้อมใช้งาน (ปิดอัตโนมัติ)');
        mSheet.getRange(j + 1, remIdx + 1).setValue(
          (String(mData[j][remIdx] || '') + ' [ปิดอัตโนมัติ ' + nowStr + ']').trim()
        );
        closedCount++;
      }
      if (closedCount > 0) SpreadsheetApp.flush();
    }

    console.log('resetDailyStatus OK date=' + today + ' closedTrips=' + closedCount);
    return {
      status      : 'ok',
      message     : 'รีเซตสถานะรถเรียบร้อย',
      resetDate   : today,
      closedTrips : closedCount
    };
  } catch (err) {
    console.error('resetDailyStatus error:', err);
    return { status: 'error', message: err.message };
  }
}

/**
 * scheduledDailyReset — ฟังก์ชันที่ตั้ง Time-based Trigger (07:00–08:00 น.)
 * วิธีตั้ง: Apps Script → Triggers → Add Trigger
 *   Function: scheduledDailyReset | Event: Time-driven | Day timer | 7am to 8am
 *   Timezone: (GMT+07:00) Asia/Bangkok
 */
function scheduledDailyReset() { return sandRun_('รีเซตสถานะรถรายวัน', scheduledDailyReset_); }
function scheduledDailyReset_() {
  var result = resetDailyStatus();
  if (result && result.status === 'error') return result;   // ให้ sandRun_ นับเป็นล้มเหลว
  console.log('scheduledDailyReset completed at ' +
    Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') +
    ' | closedTrips=' + (result.closedTrips || 0));
}

// ════════════════════════════════════════════════════════════
//  SECTION 2.5: แก้ไขข้อมูลเลขไมล์ (editmile.html)
//  ─────────────────────────────────────────────────────────
//  พขร. เข้ามาแก้ไขได้ (เลือกชื่อ ไม่ต้องรหัส) แต่การแก้ไขจะไม่มีผลทันที
//  ต้องรอแอดมิน (กรอกรหัส) เข้ามา "อนุมัติ" ก่อนถึงจะเขียนทับ MileLog จริง
//  ทุกการแก้ไขที่เกิดขึ้นจริง (ทั้งแอดมินแก้ตรง และอนุมัติคำขอ พขร.)
//  จะถูกบันทึกลง MileEditLog เพื่อตรวจสอบย้อนหลังได้เสมอ
// ════════════════════════════════════════════════════════════

const SHEET_PENDING_EDITS = 'PendingMileEdits';
const SHEET_MILE_EDIT_LOG = 'MileEditLog';
const EDITMILE_ADMIN_CODE = 'sansai2569'; // ✅ รหัสแอดมินสำหรับอนุมัติ/แก้ไขตรง (เช็คฝั่ง server เท่านั้น)

const PENDING_EDIT_HEADERS = [
  'RequestID','ประเภทคำขอ','Timestamp','TripID','ทะเบียน/รถ',
  'ฟิลด์ที่แก้(JSON)','ค่าเดิม(JSON)','ค่าใหม่(JSON)',
  'ผู้ขอแก้','เหตุผล','สถานะ','ผู้ตัดสินใจ','เวลาที่ตัดสินใจ','หมายเหตุการปฏิเสธ'
];

const MILE_EDIT_LOG_HEADERS = [
  'Timestamp','TripID','ทะเบียน/รถ','ฟิลด์ที่แก้','ค่าเดิม','ค่าใหม่',
  'ผู้ขอแก้','บทบาท','เหตุผล','ผู้อนุมัติ','เวลาที่อนุมัติ','สถานะ'
];

// ── ADMIN CODE: ตรวจรหัสแอดมินฝั่ง server (ไม่มีระบบล็อกเมื่อกรอกผิด) ──
// ผิดจะถูกบันทึกลง log ผ่าน logApiAccess_ เพื่อให้ตรวจย้อนหลังได้

/** ตรวจรหัสแอดมิน — ใช้ร่วมกันทุกจุดที่ต้องเช็ค adminCode
 *  คืนค่า { ok:boolean, message:string } */
function checkAdminCode_(payload) {
  const clientIp = String((payload && payload.clientIp) || 'unknown');
  const provided = String((payload && payload.adminCode || payload && payload.code) || '').trim();
  if (provided !== EDITMILE_ADMIN_CODE) {
    logApiAccess_('adminCode_fail', clientIp, false, (payload && payload.driverName) || '', (payload && (payload.carType || payload.plate)) || '');
    return { ok: false, message: 'รหัสแอดมินไม่ถูกต้อง' };
  }
  return { ok: true, message: '' };
}

/** verifyEditMileAdminCode — เช็ครหัสแอดมินฝั่ง server (payload:{code}) */
function verifyEditMileAdminCode(payload) {
  const result = checkAdminCode_(payload);
  return { status: 'ok', valid: result.ok };
}

/** หาแถวใน MileLog จาก TripID (คืน {rowIndex(1-indexed), headers, values} หรือ null) */
function findMileRowByTripId_(tripId) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return null;
  const range  = sheet.getDataRange();
  const values = range.getValues();
  const headers = values[0];
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === String(tripId).trim()) {
      return { sheet: sheet, rowIndex: i + 1, headers: headers, row: values[i] };
    }
  }
  return null;
}

/** สร้าง snapshot ของทั้งแถว (สำหรับบันทึกไว้ตอนขอลบ/ลบจริง) → { ชื่อคอลัมน์: ค่า } */
function snapshotMileRow_(found) {
  const snap = {};
  found.headers.forEach(function (h, i) { snap[h] = found.row[i]; });
  return snap;
}

/**
 * submitMileEditRequest — พขร. ส่งคำขอแก้ไข (ไม่มีผลทันที รอแอดมินอนุมัติ)
 * payload: { tripId, fields:{ชื่อคอลัมน์:ค่าใหม่,...}, oldValues:{ชื่อคอลัมน์:ค่าเดิม,...}, requestedBy, reason }
 */
function submitMileEditRequest(payload) {
  const tripId = String(payload.tripId || '').trim();
  const fields = payload.fields || {};
  const reason = String(payload.reason || '').trim();
  const requestedBy = String(payload.requestedBy || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!Object.keys(fields).length) return { status: 'error', message: 'ไม่มีข้อมูลที่ต้องการแก้ไข' };
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอแก้ไข' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการแก้ไข' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  // ✅ NEW: ตรวจความสมเหตุสมผลตั้งแต่ตอนส่งคำขอ (เดิมไม่เช็คเลย จนกว่าแอดมินจะกดอนุมัติ)
  // กันคำขอที่ข้อมูลเพี้ยนตั้งแต่ต้นทาง (เช่น เลขไมล์ปลาย < เลขไมล์ต้น) ไม่ให้ไปค้างในคิวรออนุมัติ
  const preCheck = validateMileFields_(fields, found);
  if (!preCheck.ok) return { status: 'error', message: preCheck.message };

  const ss     = getSpreadsheet();
  const sheet  = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now    = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId  = 'REQ' + new Date().getTime();
  const plateIdx = found.headers.indexOf('ทะเบียน/รถ');
  const plate  = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';

  sheet.appendRow([
    reqId, 'แก้ไข', now, tripId, plate,
    JSON.stringify(fields), JSON.stringify(payload.oldValues || {}), JSON.stringify(fields),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอแก้ไขแล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/**
 * submitMileDeleteRequest — พขร. ส่งคำขอ "ลบ" ทริป (ไม่มีผลทันที รอแอดมินอนุมัติ)
 * payload: { tripId, requestedBy, reason }
 */
function submitMileDeleteRequest(payload) {
  const tripId = String(payload.tripId || '').trim();
  const reason = String(payload.reason || '').trim();
  const requestedBy = String(payload.requestedBy || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอลบ' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการขอลบ' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const ss     = getSpreadsheet();
  const sheet  = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now    = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId  = 'REQ' + new Date().getTime();
  const plateIdx = found.headers.indexOf('ทะเบียน/รถ');
  const plate  = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';
  const snapshot = snapshotMileRow_(found);

  sheet.appendRow([
    reqId, 'ลบ', now, tripId, plate,
    JSON.stringify({}), JSON.stringify(snapshot), JSON.stringify({}),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอลบทริปนี้แล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/** getPendingMileEdits — ดึงคำขอแก้ไข/ลบ ที่ "รอตรวจสอบ" ทั้งหมด (สำหรับแผงแอดมิน) */
function getPendingMileEdits() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [] };
  const rows = sheet.getDataRange().getValues();
  const data = rows.slice(1)
    .map(function (r, i) {
      return {
        rowIndex   : i + 2,
        requestId  : String(r[0] || ''),
        requestType: String(r[1] || 'แก้ไข'),
        timestamp  : String(r[2] || ''),
        tripId     : String(r[3] || ''),
        plate      : String(r[4] || ''),
        fields     : safeParseJson_(r[5]),
        oldValues  : safeParseJson_(r[6]),
        newValues  : safeParseJson_(r[7]),
        requestedBy: String(r[8] || ''),
        reason     : String(r[9] || ''),
        status     : String(r[10] || ''),
        decidedBy  : String(r[11] || ''),
        decidedAt  : String(r[12] || ''),
        rejectNote : String(r[13] || '')
      };
    })
    .filter(function (r) { return r.requestId && r.status === 'รอตรวจสอบ'; });
  return { status: 'ok', data: data };
}

function safeParseJson_(s) {
  try { return JSON.parse(String(s || '{}')); } catch (e) { return {}; }
}

/**
 * approveMileEdit — แอดมินอนุมัติคำขอ (แก้ไข หรือ ลบ): ทำการเปลี่ยนแปลงจริงใน MileLog + log ไว้
 * payload: { requestId, approvedBy, adminCode }
 */
function approveMileEdit(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const requestId = String(payload.requestId || '').trim();
  const approvedBy = String(payload.approvedBy || '').trim();
  if (!requestId) return { status: 'error', message: 'ไม่พบ RequestID' };

  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบคำขอแก้ไข' };
  const rows = sheet.getDataRange().getValues();
  let targetRow = -1, reqData = null;
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === requestId) { targetRow = i + 1; reqData = rows[i]; break; }
  }
  if (targetRow < 0) return { status: 'error', message: 'ไม่พบคำขอแก้ไข (' + requestId + ')' };
  if (String(reqData[10]).trim() !== 'รอตรวจสอบ') {
    return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว (' + reqData[10] + ')' };
  }

  const requestType = String(reqData[1] || 'แก้ไข').trim();
  const tripId = String(reqData[3] || '').trim();
  const reason = String(reqData[9] || '');
  const requestedBy = String(reqData[8] || '');
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  // ✅ NEW: 'เพิ่มน้ำมัน' ไม่มี TripID เดิมให้อ้างอิง (สร้างแถวใหม่ทั้งแถว) ต้องจัดการแยกจาก
  // 'แก้ไข'/'ลบ' ก่อนถึงจุดที่โค้ดด้านล่างพยายาม findMileRowByTripId_ (ซึ่งจะหาไม่เจอเสมอ)
  if (requestType === 'เพิ่มน้ำมัน') {
    const newFields = safeParseJson_(reqData[7]);
    const check = validateFuelBacklogFields_(newFields);
    if (!check.ok) {
      return { status: 'error', message: 'คำขอนี้มีข้อมูลไม่ถูกต้อง จึงยังไม่อนุมัติ: ' + check.message };
    }
    const newTripId = addFuelBacklogEntry_(newFields);
    const logSheet2 = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
    logSheet2.appendRow([
      now, newTripId, String(reqData[4] || ''), '(เพิ่มรายการน้ำมันย้อนหลัง — ไม่มีทริปเดิม)',
      '', 'ลิตร:' + newFields.fuelLiters + ' ราคา:' + (newFields.fuelPrice || '-'),
      requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'อนุมัติแล้ว'
    ]);
    sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
    SpreadsheetApp.flush();
    return { status: 'ok', message: 'อนุมัติและเพิ่มรายการน้ำมันย้อนหลังเรียบร้อย', tripId: newTripId };
  }

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog แล้ว (อาจถูกลบไปก่อนหน้า)' };

  if (requestType === 'ลบ') {
    deleteMileRowAndLog_(found, requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'ลบแล้ว (อนุมัติ)');
    sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
    SpreadsheetApp.flush();
    return { status: 'ok', message: 'อนุมัติและลบทริปนี้เรียบร้อย' };
  }

  const fields = safeParseJson_(reqData[7]);   // ค่าใหม่
  const oldValues = safeParseJson_(reqData[6]);
  const writeResult = writeMileFieldsAndLog_(found, fields, oldValues, requestedBy, 'พขร. (ผ่านการอนุมัติ)', reason, approvedBy, now, 'อนุมัติแล้ว');
  if (!writeResult.ok) {
    // ✅ FIX: เดิมถ้าข้อมูลในคำขอเพี้ยน (เช่น พขร. ขอแก้เป็นสถานะแปลกๆ หรือเลขไมล์ปลาย < เลขไมล์ต้น)
    // แอดมินกด "อนุมัติ" แล้วจะเงียบๆ ไม่มีอะไรเกิดขึ้นจริง แต่คำขอถูกปิดเป็น "อนุมัติแล้ว" ไปแล้ว —
    // ผลคือดูเหมือนอนุมัติสำเร็จ แต่ข้อมูลจริงใน MileLog ไม่ได้เปลี่ยนอะไรเลย
    // ตอนนี้แจ้ง error กลับให้แอดมินเห็นทันที และไม่ปิดคำขอ (ยังคงเป็น "รอตรวจสอบ" ให้แก้ไขคำขอใหม่)
    return { status: 'error', message: 'คำขอนี้มีข้อมูลไม่ถูกต้อง จึงยังไม่อนุมัติ: ' + writeResult.message };
  }

  sheet.getRange(targetRow, 11, 1, 3).setValues([['อนุมัติแล้ว', approvedBy, now]]);
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'อนุมัติและบันทึกการแก้ไขเรียบร้อย' + (writeResult.message ? (' ' + writeResult.message) : '') };
}

/** rejectMileEdit — แอดมินปฏิเสธคำขอ (แก้ไขหรือลบ) payload:{ requestId, rejectedBy, rejectReason, adminCode } */
function rejectMileEdit(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const requestId = String(payload.requestId || '').trim();
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_PENDING_EDITS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบคำขอแก้ไข' };
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === requestId) {
      const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
      sheet.getRange(i + 1, 11, 1, 4).setValues([[
        'ปฏิเสธ', String(payload.rejectedBy || ''), now, String(payload.rejectReason || '')
      ]]);
      return { status: 'ok', message: 'ปฏิเสธคำขอแล้ว' };
    }
  }
  return { status: 'error', message: 'ไม่พบคำขอแก้ไข (' + requestId + ')' };
}

/**
 * directEditMileRow — แอดมินแก้ไขตรง มีผลทันที + log ทันที
 * payload: { tripId, fields:{...}, oldValues:{...}, editedBy, reason, adminCode }
 */
function directEditMileRow(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const tripId = String(payload.tripId || '').trim();
  const fields = payload.fields || {};
  const editedBy = String(payload.editedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!Object.keys(fields).length) return { status: 'error', message: 'ไม่มีข้อมูลที่ต้องการแก้ไข' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการแก้ไข' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const writeResult = writeMileFieldsAndLog_(found, fields, payload.oldValues || {}, editedBy, 'แอดมิน (แก้ไขตรง)', reason, editedBy, now, 'แก้ไขโดยแอดมิน');
  if (!writeResult.ok) return { status: 'error', message: writeResult.message };

  return { status: 'ok', message: 'บันทึกการแก้ไขเรียบร้อย' + (writeResult.message ? (' ' + writeResult.message) : '') };
}

/**
 * directDeleteMileRow — แอดมินลบทริปตรง มีผลทันที + log ทันที
 * payload: { tripId, editedBy, reason, adminCode }
 */
function directDeleteMileRow(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const tripId = String(payload.tripId || '').trim();
  const editedBy = String(payload.editedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!tripId) return { status: 'error', message: 'ไม่พบ TripID' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลในการลบ' };

  const found = findMileRowByTripId_(tripId);
  if (!found) return { status: 'error', message: 'ไม่พบทริปนี้ใน MileLog (TripID: ' + tripId + ')' };

  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  deleteMileRowAndLog_(found, editedBy, 'แอดมิน (ลบตรง)', reason, editedBy, now, 'ลบโดยแอดมิน');

  return { status: 'ok', message: 'ลบทริปนี้เรียบร้อย' };
}

/** ลบแถวจริงออกจาก MileLog + เขียน log การลบไว้ใน MileEditLog (เก็บ snapshot ทั้งแถวไว้เป็นค่าเดิม) */
function deleteMileRowAndLog_(found, requestedBy, role, reason, approvedBy, decidedAt, statusLabel) {
  const snapshot = snapshotMileRow_(found);
  const headers = found.headers;
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  const plate = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';
  const wasLatestForPlate = isLatestMileRowForPlate_(found.sheet, headers, found.rowIndex, plate);

  const ss = getSpreadsheet();
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  const logNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  logSheet.appendRow([
    logNow, found.row[0], plate, '(ลบทั้งแถว)',
    JSON.stringify(snapshot), '', requestedBy, role, reason, approvedBy, decidedAt, statusLabel
  ]);

  found.sheet.deleteRow(found.rowIndex);
  SpreadsheetApp.flush();

  // ✅ NEW: ถ้าลบทริปที่เป็น "แถวล่าสุด" ของทะเบียนนี้ (ตัวที่กำหนดสถานะปัจจุบันของรถใน Vehicles sheet)
  // ต้องหาแถวที่เหลือที่ใหม่ที่สุดของทะเบียนนี้มาซิงค์สถานะแทน — ถ้าไม่มีทริปเหลือเลย ให้ตั้งกลับเป็น
  // "พร้อมใช้งาน" ว่างคนขับ/ปลายทาง (ไม่งั้น Vehicles sheet จะค้างอ้างอิงทริปที่ถูกลบไปแล้ว)
  if (wasLatestForPlate && plate) {
    try {
      const ss2    = getSpreadsheet();
      const sheet2 = ss2.getSheetByName(SHEET_MILE);
      let restored = false;
      if (sheet2 && sheet2.getLastRow() > 1) {
        const data2 = sheet2.getDataRange().getValues();
        const hdrs2 = data2[0];
        const plateIdx2 = hdrs2.indexOf('ทะเบียน/รถ');
        const shortPlate = String(plate || '').split(' ')[0].trim();
        for (let i = data2.length - 1; i >= 1; i--) {
          const rowPlateFull = String(data2[i][plateIdx2] || '').trim();
          const rowShortPlate = rowPlateFull.split(' ')[0].trim();
          if (rowShortPlate && (rowShortPlate === shortPlate || rowPlateFull.includes(shortPlate) || shortPlate.includes(rowShortPlate))) {
            const st  = String(data2[i][hdrs2.indexOf('สถานะ')] || 'พร้อมใช้งาน');
            const drv = String(data2[i][hdrs2.indexOf('พนักงานขับรถ')] || '');
            const dst = String(data2[i][hdrs2.indexOf('ปลายทาง')] || '');
            updateVehicleStatus(rowPlateFull, st, drv, st === 'กำลังใช้งาน' ? dst : '');
            restored = true;
            break;
          }
        }
      }
      if (!restored) updateVehicleStatus(plate, 'พร้อมใช้งาน', '', '');
    } catch (syncErr) {
      console.warn('deleteMileRowAndLog_ vehicle sync error:', syncErr.message);
    }
  }
}

/**
 * validateMileFields_ — ตรวจความสมเหตุสมผลของฟิลด์ที่จะเขียนก่อนแตะข้อมูลจริงใน MileLog
 * (ใช้ร่วมกันทั้ง submitMileEditRequest / directEditMileRow / approveMileEdit
 *  เพื่อกันข้อมูลเพี้ยนไม่ว่าจะแก้ผ่านเส้นทางไหน — เดิมไม่มีการเช็คนี้เลย ทำให้:
 *   - พิมพ์ "สถานะ" อะไรก็ได้ ทั้งที่หน้าอื่น (dashboard/startmile/endMile) เทียบ string
 *     ตรงตัวกับ 'กำลังใช้งาน'/'พร้อมใช้งาน' เท่านั้น พิมพ์ผิดแม้แค่วรรค ก็ทำให้รถนั้น
 *     หายไปจากทุก query ที่กรองด้วยสถานะ
 *   - เลขไมล์ปลาย < เลขไมล์ต้น หรือติดลบ เขียนลงชีทได้ตรงๆ โดยไม่มีใครเตือน
 * คืนค่า { ok:boolean, message:string } — ok:false ต้องไม่เขียนอะไรลงชีทเลย)
 */
/**
 * resolveMileColIdx_ — หา index คอลัมน์ใน MileLog จาก "ชื่อฟิลด์มาตรฐาน" ที่ editmile.html ส่งมา
 * ✅ NEW: แก้บั๊ก — โค้ดเดิมใช้ headers.indexOf(fieldName) แบบตรงตัวเป๊ะๆ เพียงอย่างเดียว แต่ชีท MileLog
 * จริงบางช่วง/บางไฟล์ตั้งชื่อ header ต่างไปเล็กน้อยจากชื่อมาตรฐานที่โค้ดคาดหวัง (เช่น คอลัมน์ราคาน้ำมัน
 * ในชีทจริงชื่อ "ราคาน้ำมัน" เฉยๆ ไม่มี "(บาท)" ต่อท้ายแบบที่โค้ดค้นหา) พอ indexOf() หาไม่เจอ
 * (คืน -1) โค้ดเดิมจะ "ข้ามเงียบๆ" ไม่เขียนอะไรลงชีทเลย โดยไม่มี error ให้เห็นเลย — ทำให้กรอกราคาน้ำมัน
 * ในฟอร์มแก้ไขแล้ว "หาย" ไม่ลงชีทจริง ทั้งที่ลิตรบันทึกได้ปกติ (เพราะชื่อคอลัมน์ลิตรตรงกันพอดี)
 * ฟังก์ชันนี้ลองไล่ชื่อ alias ที่เคยพบจริงในชีท (อ้างอิงจาก EXPECTED_HEADERS/alias keys ที่มีอยู่แล้ว
 * ในส่วนอ่านข้อมูล getMileLogData) ก่อนจะยอมแพ้คืน -1
 */
var MILE_FIELD_ALIASES_ = {
  'ราคาน้ำมัน(บาท)'     : ['ราคาน้ำมัน(บาท)', 'ราคาน้ำมัน'],
  'น้ำมันที่เติม(ลิตร)'  : ['น้ำมันที่เติม(ลิตร)', 'น้ำมันที่เติม', 'เติมน้ำมัน(ลิตร)'],
  'เลขไมล์ต้น'           : ['เลขไมล์ต้น', 'ไมล์เริ่มต้น'],
  'เลขไมล์ปลาย'          : ['เลขไมล์ปลาย', 'ไมล์สิ้นสุด'],
  'TripID'                : ['TripID', 'รหัสทริป'],
  'ลิตรเติมขากลับ'        : ['ลิตรเติมขากลับ'],
  'ราคาเติมขากลับ(บาท)'   : ['ราคาเติมขากลับ(บาท)']
};
// คอลัมน์น้ำมัน "ตอนกลับ" ถูกสร้างอัตโนมัติโดย writeExtraField ตอน endMile (จึงอาจยังไม่มีในชีท)
// editmile.html แก้ไขสองคอลัมน์นี้ได้ — ถ้ายังไม่มีให้สร้างตอนบันทึก แทนที่จะเงียบหรือแจ้งว่าไม่พบคอลัมน์
var MILE_RETURN_FUEL_COLS_ = ['ลิตรเติมขากลับ', 'ราคาเติมขากลับ(บาท)'];
function numPos_(v) { var x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return x > 0 ? x : 0; }
function resolveMileColIdx_(headers, fieldName) {
  var aliases = MILE_FIELD_ALIASES_[fieldName] || [fieldName];
  for (var i = 0; i < aliases.length; i++) {
    var idx = headers.indexOf(aliases[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

function validateMileFields_(fields, found) {
  const headers = found.headers;
  const row = found.row;
  const VALID_MILE_STATUS = ['กำลังใช้งาน', 'พร้อมใช้งาน'];

  if ('สถานะ' in fields) {
    const st = String(fields['สถานะ'] || '').trim();
    if (VALID_MILE_STATUS.indexOf(st) < 0) {
      return { ok: false, message: 'สถานะไม่ถูกต้อง — ต้องเป็น "กำลังใช้งาน" หรือ "พร้อมใช้งาน" เท่านั้น' };
    }
  }
  if ('ทะเบียน/รถ' in fields && !String(fields['ทะเบียน/รถ'] || '').trim()) {
    return { ok: false, message: 'กรุณาระบุทะเบียน/รถ ห้ามเว้นว่าง' };
  }
  if ('พนักงานขับรถ' in fields && !String(fields['พนักงานขับรถ'] || '').trim()) {
    return { ok: false, message: 'กรุณาระบุพนักงานขับรถ ห้ามเว้นว่าง' };
  }

  const startIdx = resolveMileColIdx_(headers, 'เลขไมล์ต้น');
  const endIdx   = resolveMileColIdx_(headers, 'เลขไมล์ปลาย');

  function currentOrNew(fieldName, idx) {
    if (fieldName in fields) return fields[fieldName];
    return idx >= 0 ? row[idx] : '';
  }

  if ('เลขไมล์ต้น' in fields) {
    const v = fields['เลขไมล์ต้น'];
    if (v === '' || v === null || isNaN(Number(v)) || Number(v) < 0) {
      return { ok: false, message: 'เลขไมล์ต้นต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  if ('เลขไมล์ปลาย' in fields) {
    const v = fields['เลขไมล์ปลาย'];
    // เลขไมล์ปลายเว้นว่างได้ (กรณีทริปยังไม่กลับ) — เช็คเฉพาะตอนมีค่าจริง
    if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
      return { ok: false, message: 'เลขไมล์ปลายต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }

  if (startIdx >= 0 && endIdx >= 0 && ('เลขไมล์ต้น' in fields || 'เลขไมล์ปลาย' in fields)) {
    const s = Number(currentOrNew('เลขไมล์ต้น', startIdx));
    const eRaw = currentOrNew('เลขไมล์ปลาย', endIdx);
    const e = Number(eRaw);
    if (eRaw !== '' && !isNaN(s) && !isNaN(e) && e < s) {
      return { ok: false, message: 'เลขไมล์ปลาย (' + e + ') ต้องไม่น้อยกว่าเลขไมล์ต้น (' + s + ')' };
    }
  }

  // ✅ NEW: ตรวจฟิลด์เติมน้ำมันย้อนหลัง (ใช้ตอนแอดมิน/พขร. แก้ไข MileLog ผ่าน editmile.html
  // เพื่อลงบิลน้ำมันของทริปเก่าที่ตอนออกรถ/กลับรถลืมกรอกไว้ — dashboard อ่านค่าจาก 2 คอลัมน์นี้
  // ตรงๆ เพื่อคำนวณอัตราสิ้นเปลืองและต้นทุนน้ำมัน ดังนั้นต้องเป็นตัวเลขไม่ติดลบเท่านั้น เว้นว่างได้)
  if ('น้ำมันที่เติม(ลิตร)' in fields) {
    const v = fields['น้ำมันที่เติม(ลิตร)'];
    // ✅ FIX: startmile.html (ปุ่ม "ไม่ได้เติมน้ำมันจริง") ส่งค่าพิเศษ 'ไม่เติม' มาเพื่อยืนยันว่าไม่ได้เติมน้ำมัน
    // (ใช้ปิดการแจ้งเตือน LINE — ดู caseA ใน getFuelAlert/ตัวเช็ค fuelMarkerRaw) เดิม validator ตีกลับเพราะไม่ใช่ตัวเลข
    // ทำให้ยกเลิกรายการไม่ได้ → ยอมรับเฉพาะค่านี้ค่าเดียว ส่วนข้อความอื่นยังถูกปฏิเสธเหมือนเดิม
    const isNoFuelMarker = String(v == null ? '' : v).trim() === 'ไม่เติม';
    if (!isNoFuelMarker) {
      if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
        return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) ต้องเป็นตัวเลขไม่ติดลบ' };
      }
      if (!isNaN(Number(v)) && Number(v) > 500) {
        return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) สูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
      }
    }
  }
  if ('ราคาน้ำมัน(บาท)' in fields) {
    const v = fields['ราคาน้ำมัน(บาท)'];
    if (v !== '' && v !== null && (isNaN(Number(v)) || Number(v) < 0)) {
      return { ok: false, message: 'ราคาน้ำมัน (บาท) ต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  // ✅ NEW: น้ำมันตอนกลับ (ลิตรเติมขากลับ / ราคาเติมขากลับ(บาท)) — กติกาเดียวกับชุดตอนออก
  if ('ลิตรเติมขากลับ' in fields) {
    const rv = fields['ลิตรเติมขากลับ'];
    if (rv !== '' && rv !== null && (isNaN(Number(rv)) || Number(rv) < 0)) {
      return { ok: false, message: 'ลิตรที่เติมตอนกลับต้องเป็นตัวเลขไม่ติดลบ' };
    }
    if (rv !== '' && Number(rv) > 500) {
      return { ok: false, message: 'ลิตรที่เติมตอนกลับสูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
    }
  }
  if ('ราคาเติมขากลับ(บาท)' in fields) {
    const rp = fields['ราคาเติมขากลับ(บาท)'];
    if (rp !== '' && rp !== null && (isNaN(Number(rp)) || Number(rp) < 0)) {
      return { ok: false, message: 'ราคาที่เติมตอนกลับต้องเป็นตัวเลขไม่ติดลบ' };
    }
  }
  if ('ลิตรเติมขากลับ' in fields && fields['ลิตรเติมขากลับ'] !== '' && Number(fields['ลิตรเติมขากลับ']) === 0 &&
      numPos_(fields['ราคาเติมขากลับ(บาท)']) > 0) {
    return { ok: false, message: 'กรอกราคาตอนกลับแล้วแต่ลิตร = 0 — กรุณาตรวจสอบจำนวนลิตรอีกครั้ง' };
  }

  // ถ้ากรอกราคาแต่ไม่กรอกลิตร (หรือกลับกัน) ไม่ block — บางบิลอาจมีแค่ราคารวมไม่มีลิตรระบุ
  // แต่เตือนกรณีกรอกลิตร=0 พร้อมราคา>0 (มักเป็นการพิมพ์ผิดคอลัมน์)
  {
    const litersNew = 'น้ำมันที่เติม(ลิตร)' in fields ? Number(fields['น้ำมันที่เติม(ลิตร)']) : null;
    const priceNew  = 'ราคาน้ำมัน(บาท)' in fields ? Number(fields['ราคาน้ำมัน(บาท)']) : null;
    if (litersNew === 0 && priceNew > 0) {
      return { ok: false, message: 'กรอกราคาน้ำมันแล้วแต่ลิตร = 0 — กรุณาตรวจสอบจำนวนลิตรที่เติมอีกครั้ง' };
    }
  }

  return { ok: true, message: '' };
}

/**
 * isLatestMileRowForPlate_ — เช็คว่าแถวที่กำลังจะแก้ เป็นแถว "ล่าสุด" ของทะเบียนนี้ใน MileLog หรือไม่
 * ใช้ตัดสินใจว่าควรซิงค์ค่าไปยัง Vehicles sheet หรือไม่ (Vehicles สะท้อน "สถานะปัจจุบัน" ของรถ
 * ซึ่งควรมาจากทริปล่าสุดของรถคันนั้นเท่านั้น ไม่ใช่ทริปเก่าที่ผ่านไปแล้ว)
 */
function isLatestMileRowForPlate_(sheet, headers, rowIndex, plate) {
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  if (plateIdx < 0) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  const shortPlate = String(plate || '').split(' ')[0].trim();
  if (!shortPlate) return false;
  const plateCol = sheet.getRange(2, plateIdx + 1, lastRow - 1, 1).getValues();
  for (let i = plateCol.length - 1; i >= 0; i--) {
    const r = i + 2; // เลขแถวจริง (1-indexed, header คือแถว 1)
    const rowPlateFull  = String(plateCol[i][0] || '').trim();
    const rowShortPlate = rowPlateFull.split(' ')[0].trim();
    if (rowShortPlate && (rowShortPlate === shortPlate || rowPlateFull.includes(shortPlate) || shortPlate.includes(rowShortPlate))) {
      return r === rowIndex;
    }
  }
  return false;
}

/**
 * syncVehicleFromMileRow_ — ซิงค์ Vehicles sheet ให้ตรงกับแถว MileLog ที่เพิ่งแก้ไข
 * ✅ FIX: เดิม startMile()/endMile() อัปเดต Vehicles sheet ทุกครั้งที่ออก/กลับรถ แต่
 * directEditMileRow / approveMileEdit (แก้ไข "สถานะ"/"พนักงานขับรถ"/"ปลายทาง"/"ทะเบียน/รถ"
 * ของทริปโดยแอดมิน) ไม่เคยอัปเดต Vehicles sheet เลย ทำให้หน้า dashboard/index/startmile
 * ที่อ่านสถานะรถจาก Vehicles sheet โชว์ข้อมูลเก่าค้าง ไม่ตรงกับ MileLog ที่เพิ่งแก้ไป
 * ทำงานเฉพาะตอนแถวที่แก้เป็นแถว "ล่าสุด" ของทะเบียนนั้น (ทริปที่กำหนดสถานะปัจจุบันของรถอยู่)
 */
function syncVehicleFromMileRow_(found, fields) {
  try {
    const syncTriggerFields = ['สถานะ', 'พนักงานขับรถ', 'ปลายทาง', 'ทะเบียน/รถ'];
    const touched = syncTriggerFields.some(function (f) { return f in fields; });
    if (!touched) return;

    const sheet = found.sheet;
    const headers = found.headers;
    const rowIndex = found.rowIndex;
    const plateIdxOld = headers.indexOf('ทะเบียน/รถ');
    const plateForCheck = plateIdxOld >= 0 ? String(found.row[plateIdxOld] || '') : '';

    if (!isLatestMileRowForPlate_(sheet, headers, rowIndex, plateForCheck)) return;

    const freshRow = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
    const idxOf = function (name) { return headers.indexOf(name); };
    const readFresh = function (name) { const i = idxOf(name); return i >= 0 ? String(freshRow[i] || '') : ''; };

    const newPlate  = readFresh('ทะเบียน/รถ') || plateForCheck;
    const newStatus = readFresh('สถานะ') || 'พร้อมใช้งาน';
    const newDriver = readFresh('พนักงานขับรถ');
    const newDest   = readFresh('ปลายทาง');

    updateVehicleStatus(newPlate, newStatus, newDriver, newStatus === 'กำลังใช้งาน' ? newDest : '');
  } catch (syncErr) {
    console.warn('syncVehicleFromMileRow_ error:', syncErr.message);
  }
}

/**
 * FuelLog — ✅ NEW: บันทึกลิตร/จำนวนเงินน้ำมัน "ทุกครั้งที่บันทึก" 1 แถวต่อ 1 การบันทึก (ต่อท้ายเสมอ ไม่ทับของเดิม)
 * ใช้ดูย้อนหลัง/รวมยอดได้ง่ายกว่า MileEditLog (ที่เก็บทีละฟิลด์ ค่าเดิม→ค่าใหม่)
 * ห่อ try/catch — ถ้าเขียน FuelLog ไม่สำเร็จ จะไม่ทำให้การบันทึกหลักล้มเหลว
 */
const SHEET_FUEL_LOG = 'FuelLog';
const FUEL_LOG_HEADERS = ['วันเวลาที่บันทึก', 'TripID', 'ทะเบียน/รถ', 'จำนวนลิตร', 'จำนวนเงิน(บาท)', 'ประเภท', 'ผู้บันทึก', 'เหตุผล/หมายเหตุ'];
function appendFuelLog_(tripId, plate, liters, price, kind, by, note) {
  try {
    const ss = getSpreadsheet();
    const sh = getOrCreateSheet(ss, SHEET_FUEL_LOG, FUEL_LOG_HEADERS);
    const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sh.appendRow([now, String(tripId == null ? '' : tripId), String(plate || ''),
      liters === '' || liters == null ? '' : liters, price === '' || price == null ? '' : price,
      kind || '', String(by || ''), String(note || '')]);
  } catch (e) {
    console.warn('appendFuelLog_ error:', e.message);
  }
}

/** เขียนค่าใหม่ลง MileLog ตามชื่อคอลัมน์จริง + เขียน MileEditLog 1 แถวต่อ 1 ฟิลด์ที่เปลี่ยน
 *  คืนค่า { ok:boolean, message:string } — ok:false แปลว่าไม่ผ่านการตรวจสอบ ไม่มีการเขียนใดๆเกิดขึ้น */
function writeMileFieldsAndLog_(found, fields, oldValues, requestedBy, role, reason, approvedBy, decidedAt, statusLabel) {
  const check = validateMileFields_(fields, found);
  if (!check.ok) return check;

  const sheet = found.sheet;
  const headers = found.headers;
  const rowIndex = found.rowIndex;
  const plateIdx = headers.indexOf('ทะเบียน/รถ');
  const plate = plateIdx >= 0 ? String(found.row[plateIdx] || '') : '';

  const ss = getSpreadsheet();
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  const logNow = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  // ✅ FIX: เดิมใช้ headers.indexOf(fieldName) ตรงตัวเป๊ะๆ เพียงอย่างเดียว — ถ้าชื่อ header ในชีทจริง
  // ต่างจากชื่อมาตรฐานเพียงเล็กน้อย (เช่น "ราคาน้ำมัน" ไม่มี "(บาท)" ต่อท้าย) จะหาคอลัมน์ไม่เจอ (-1)
  // แล้ว "ข้ามเงียบๆ" ไม่เขียนอะไรลงชีทเลย โดยไม่มี error ให้เห็น — ทำให้ค่าที่กรอกในฟอร์ม "หาย" ไปจริงๆ
  // ตอนบันทึก ใช้ resolveMileColIdx_() แทน เพื่อลองหาด้วยชื่อ alias ที่เคยพบจริงในชีทก่อนจะถือว่าไม่มีคอลัมน์นี้
  // และเก็บรายชื่อฟิลด์ที่ยังหาคอลัมน์ไม่เจอไว้แจ้งเตือนกลับไป แทนที่จะเงียบเหมือนเดิม
  const unresolvedFields = [];
  Object.keys(fields).forEach(function (fieldName) {
    let colIdx = resolveMileColIdx_(headers, fieldName);
    if (colIdx < 0 && MILE_RETURN_FUEL_COLS_.indexOf(fieldName) >= 0) {
      colIdx = ensureExtraColumn(sheet, fieldName);   // สร้างคอลัมน์น้ำมันตอนกลับให้ ถ้ายังไม่เคยมีใครเติมตอนกลับ
    }
    if (colIdx < 0) { unresolvedFields.push(fieldName); return; } // ไม่พบคอลัมน์นี้จริงๆ ในชีท (แม้ลอง alias แล้ว)
    const newVal = fields[fieldName];
    sheet.getRange(rowIndex, colIdx + 1).setValue(newVal);
    logSheet.appendRow([
      logNow, found.row[0], plate, fieldName,
      oldValues[fieldName] != null ? oldValues[fieldName] : '',
      newVal, requestedBy, role, reason, approvedBy, decidedAt, statusLabel
    ]);
  });

  // ✅ NEW: ถ้าการบันทึกนี้แตะลิตร/ราคาน้ำมัน → ลง FuelLog ด้วยทุกครั้ง ('ไม่เติม' = ลิตร 0 ราคา 0)
  if ('น้ำมันที่เติม(ลิตร)' in fields || 'ราคาน้ำมัน(บาท)' in fields) {
    const _lv = fields['น้ำมันที่เติม(ลิตร)'];
    const _noFuel = String(_lv == null ? '' : _lv).trim() === 'ไม่เติม';
    const _tidIdx = resolveMileColIdx_(headers, 'TripID');
    appendFuelLog_(
      _tidIdx >= 0 ? found.row[_tidIdx] : found.row[0], plate,
      _noFuel ? 0 : (_lv === undefined ? '' : _lv),
      _noFuel ? 0 : ('ราคาน้ำมัน(บาท)' in fields ? fields['ราคาน้ำมัน(บาท)'] : ''),
      _noFuel ? 'ไม่ได้เติมน้ำมัน' : 'เติมน้ำมัน', requestedBy, reason
    );
  }

  // ✅ NEW: แตะน้ำมันตอนกลับ → ลง FuelLog ด้วย (ประเภท 'เติมน้ำมันขากลับ')
  if ('ลิตรเติมขากลับ' in fields || 'ราคาเติมขากลับ(บาท)' in fields) {
    const _tid2 = resolveMileColIdx_(headers, 'TripID');
    appendFuelLog_(
      _tid2 >= 0 ? found.row[_tid2] : found.row[0], plate,
      'ลิตรเติมขากลับ' in fields ? fields['ลิตรเติมขากลับ'] : '',
      'ราคาเติมขากลับ(บาท)' in fields ? fields['ราคาเติมขากลับ(บาท)'] : '',
      'เติมน้ำมันขากลับ', requestedBy, reason
    );
  }

  // ถ้ามีการแก้ "เลขไมล์ต้น" หรือ "เลขไมล์ปลาย" และไม่ได้ส่ง "ระยะทาง(กม.)" มาด้วย → คำนวณใหม่ให้อัตโนมัติ
  const startIdx = resolveMileColIdx_(headers, 'เลขไมล์ต้น');
  const endIdx   = resolveMileColIdx_(headers, 'เลขไมล์ปลาย');
  const distIdx  = headers.indexOf('ระยะทาง(กม.)');
  if (!('ระยะทาง(กม.)' in fields) && distIdx >= 0 && startIdx >= 0 && endIdx >= 0) {
    const freshStart = Number(sheet.getRange(rowIndex, startIdx + 1).getValue());
    const freshEnd   = Number(sheet.getRange(rowIndex, endIdx + 1).getValue());
    if (!isNaN(freshStart) && !isNaN(freshEnd) && freshEnd >= freshStart) {
      sheet.getRange(rowIndex, distIdx + 1).setValue(freshEnd - freshStart);
    }
  }

  // ✅ NEW: ซิงค์ Vehicles sheet ถ้าแก้ไขทริปที่เป็นสถานะปัจจุบันของรถคันนี้อยู่
  syncVehicleFromMileRow_(found, fields);

  SpreadsheetApp.flush();
  // ✅ NEW: ถ้ามีฟิลด์ที่หาคอลัมน์ไม่เจอเลยแม้ลอง alias แล้ว ให้แจ้งเตือนกลับไปด้วย แทนที่จะเงียบเหมือนเดิม
  // (ok ยังเป็น true เพราะฟิลด์อื่นที่บันทึกได้ก็ยังบันทึกไปแล้วตามปกติ — นี่แค่แจ้งเตือนเสริม)
  const warnMsg = unresolvedFields.length
    ? ('⚠️ ไม่พบคอลัมน์ในชีทสำหรับฟิลด์: ' + unresolvedFields.join(', ') + ' — ข้อมูลส่วนนี้ยังไม่ถูกบันทึก กรุณาแจ้งผู้ดูแลระบบ')
    : '';
  return { ok: true, message: warnMsg };
}

/**
 * getFuelBacklog — ✅ NEW: ดึงรายการทริปที่ "จบทริปแล้ว" (มีเลขไมล์ปลาย/สถานะพร้อมใช้งาน)
 * แต่ยังไม่มีข้อมูลน้ำมัน (คอลัมน์ 'น้ำมันที่เติม(ลิตร)' ว่าง) — ใช้โชว์ในหน้า editmile.html
 * เป็นรายการ "ทริปที่รอลงบิลน้ำมันย้อนหลัง" ให้ผู้ใช้ไล่กรอกได้ครบโดยไม่ต้องไล่หาเองทั้งตาราง
 * ✅ NEW: ดักจับเฉพาะทริปที่ "ปลายทาง" เป็นปั๊มน้ำมันจริง (ผ่าน isFuelStation()) เท่านั้น — ทริปทั่วไป
 * ที่ปลายทางไม่ใช่ปั๊ม (เช่น ไปส่งผู้ป่วย/ไปติดต่อราชการ) จะไม่ถูกนับว่า "ค้างลงบิลน้ำมัน" อีกต่อไป
 * เพราะทริปแบบนั้นไม่ได้แวะเติมน้ำมันอยู่แล้วตั้งแต่ต้น ทำให้รายการที่โชว์เหลือเฉพาะที่เกี่ยวข้องจริงๆ
 * payload/params: { plate? , from?(yyyy-MM-dd), to?(yyyy-MM-dd) } ทั้งหมด optional (ไม่ระบุ = ทั้งหมด)
 * หมายเหตุ: ไม่รวมทริปที่ "กำลังใช้งาน" อยู่ (ยังไม่กลับ) เพราะยังไม่ถึงเวลาที่ควรมีบิลน้ำมันครบ
 */
function getFuelBacklog(params) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    tripId : headers.indexOf('TripID'),
    date   : headers.indexOf('วันที่'),
    plate  : headers.indexOf('ทะเบียน/รถ'),
    driver : headers.indexOf('พนักงานขับรถ'),
    dest   : headers.indexOf('ปลายทาง'),
    odoEnd : headers.indexOf('เลขไมล์ปลาย'),
    status : headers.indexOf('สถานะ'),
    liters : headers.indexOf('น้ำมันที่เติม(ลิตร)'),
    price  : headers.indexOf('ราคาน้ำมัน(บาท)'),
    retLit : headers.indexOf('ลิตรเติมขากลับ')   // ✅ NEW: น้ำมันตอนกลับ (หน้าประวัติรวมกับตอนออก)
  };
  if (idx.tripId < 0 || idx.liters < 0) return { status: 'ok', data: [], count: 0 };

  const plateFilter = params && params.plate ? String(params.plate).trim() : '';
  const fromFilter  = params && params.from  ? String(params.from).trim()  : '';
  const toFilter    = params && params.to    ? String(params.to).trim()    : '';

  function toYmd_(v) {
    if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
    const s = String(v || '').trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
  }

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const status = String(row[idx.status] || '').trim();
    const odoEndVal = row[idx.odoEnd];
    const litersVal = String(row[idx.liters] || '').trim();
    const finished = status === 'พร้อมใช้งาน' || (odoEndVal !== '' && odoEndVal !== null);
    if (!finished) continue;          // ทริปยังไม่จบ → ยังไม่ต้องเตือน
    // มีข้อมูลน้ำมันแล้ว → ข้าม  (marker 'auto' = ตรวจพบว่าไปปั๊มแต่ยังไม่มีลิตรจริง → ยังนับว่าค้าง)
    // ✅ FIX: ต้องนับลิตรที่เติมตอนกลับด้วย ไม่งั้นทริปที่กรอกน้ำมันตอนกลับแล้วจะยังโผล่ค้างลงบิล
    if (idx.retLit >= 0 && numPos_(row[idx.retLit]) > 0) continue;
    if (litersVal !== '' && litersVal !== 'auto') continue;

    const plate = String(row[idx.plate] || '');
    if (plateFilter && plate.indexOf(plateFilter) < 0) continue;

    // ✅ NEW: ดักจับเฉพาะรายการที่ปลายทางเป็นปั๊มน้ำมันจริงๆ (ใช้ตัวตรวจจับ isFuelStation() ตัวเดียวกับ
    // ที่ endMile() ใช้ตรวจสถานะ "เติมน้ำมันแล้ว" แบบเรียลไทม์) — ทริปที่ปลายทางไม่ใช่ปั๊มน้ำมัน (เช่น
    // ไปส่งผู้ป่วย/ไปโรงพยาบาลอื่น) ไม่ควรถูกนับเป็น "ค้างลงบิลน้ำมัน" เพราะทริปแบบนั้นไม่ได้เติมน้ำมันอยู่แล้ว
    const dest = String(row[idx.dest] || '');
    if (!isFuelStation(dest)) continue;

    const ymd = toYmd_(row[idx.date]);
    if (fromFilter && ymd && ymd < fromFilter) continue;
    if (toFilter && ymd && ymd > toFilter) continue;

    out.push({
      tripId : String(row[idx.tripId] || ''),
      date   : ymd,
      plate  : plate,
      driver : String(row[idx.driver] || ''),
      dest   : dest,
      status : status
    });
  }
  out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return { status: 'ok', data: out, count: out.length };
}

/**
 * ════════════════════════════════════════════════════════════
 *  FUEL BACKLOG ENTRY — สำหรับ "เติมน้ำมันย้อนหลังที่ไม่มีทริปเดิมเลย"
 *  (ต่างจาก directEditMileRow/submitMileEditRequest ที่ใช้แก้ "ทริปที่มีอยู่แล้ว"
 *   ชุดนี้ "สร้างแถวใหม่" ใน MileLog เพราะไม่มี TripID ให้อ้างอิงตั้งแต่ต้น)
 * ════════════════════════════════════════════════════════════
 */

/** validateFuelBacklogFields_ — ตรวจความสมเหตุสมผลของข้อมูลก่อนสร้างแถวน้ำมันย้อนหลัง */
function validateFuelBacklogFields_(fields) {
  if (!String((fields && fields.plate) || '').trim()) {
    return { ok: false, message: 'กรุณาระบุทะเบียน/รถ' };
  }
  const dateStr = String((fields && fields.date) || '').trim();
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return { ok: false, message: 'กรุณาระบุวันที่เติมน้ำมัน' };
  }
  const liters = Number(fields && fields.fuelLiters);
  if (!fields || fields.fuelLiters === '' || fields.fuelLiters == null || isNaN(liters) || liters <= 0) {
    return { ok: false, message: 'กรุณาระบุจำนวนน้ำมันที่เติม (ลิตร) มากกว่า 0' };
  }
  if (liters > 500) {
    return { ok: false, message: 'จำนวนน้ำมันที่เติม (ลิตร) สูงผิดปกติ (>500 ลิตร) กรุณาตรวจสอบอีกครั้ง' };
  }
  if (fields.fuelPrice !== '' && fields.fuelPrice != null) {
    const price = Number(fields.fuelPrice);
    if (isNaN(price) || price < 0) return { ok: false, message: 'ราคาน้ำมัน (บาท) ต้องเป็นตัวเลขไม่ติดลบ' };
  }
  if (fields.odoAt !== '' && fields.odoAt != null) {
    const odo = Number(fields.odoAt);
    if (isNaN(odo) || odo < 0) return { ok: false, message: 'เลขไมล์ ณ วันเติม ต้องเป็นตัวเลขไม่ติดลบ' };
  }
  return { ok: true, message: '' };
}

/**
 * normalizeDateStr_ — แปลงค่าวันที่จาก cell (อาจเป็น Date object, 'yyyy-MM-dd', หรือ 'dd/MM/yyyy...')
 * ให้เป็นรูปแบบเดียวกันเสมอคือ 'yyyy-MM-dd' (เทียบวันแบบไม่สนใจเวลา) เพื่อใช้เทียบวันที่ข้ามรูปแบบได้
 */
function normalizeDateStr_(val) {
  if (!val) return '';
  if (val instanceof Date) {
    try { return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd'); } catch (_) { return ''; }
  }
  const s = String(val).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // dd/MM/yyyy (formatDisplayDate ใช้รูปแบบนี้)
  if (m) {
    const dd = ('0' + m[1]).slice(-2), mo = ('0' + m[2]).slice(-2);
    return m[3] + '-' + mo + '-' + dd;
  }
  const t = Date.parse(s);
  if (!isNaN(t)) {
    try { return Utilities.formatDate(new Date(t), 'Asia/Bangkok', 'yyyy-MM-dd'); } catch (_) { return ''; }
  }
  return '';
}

/**
 * checkFuelBacklogDuplicate_ — ตรวจว่าทะเบียนที่ระบุมีการลงบิลน้ำมัน (ไม่ว่าจะมาจากทริปปกติ
 * หรือรายการย้อนหลัง FB... ที่เคยเพิ่มไปก่อน) ไว้แล้วในวันที่ระบุ หรือวันก่อนหน้า/ถัดไป (±1 วัน)
 * — ใช้ป้องกันการลงบิลน้ำมันย้อนหลังซ้ำซ้อนโดยไม่ตั้งใจ (เช่น พขร. คนละคนลงบิลใบเดียวกันซ้ำ)
 *
 * plate: string, dateStr: 'yyyy-MM-dd' (หรือรูปแบบที่ normalizeDateStr_ รองรับ)
 * คืนค่า array เรียงจากวันก่อนหน้า → วันเดียวกัน → วันถัดไป:
 *   [{ tripId, date('yyyy-MM-dd'), dayOffset(-1/0/1), liters, price, driver, note }]
 */
function checkFuelBacklogDuplicate_(plate, dateStr) {
  const targetPlateFull = String(plate || '').trim();
  const targetPlate     = targetPlateFull.split(' ')[0].trim();
  const targetDate      = normalizeDateStr_(dateStr);
  if (!targetPlate || !targetDate) return [];

  const base = new Date(targetDate + 'T00:00:00');
  const prevDate = Utilities.formatDate(new Date(base.getTime() - 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');
  const nextDate = Utilities.formatDate(new Date(base.getTime() + 86400000), 'Asia/Bangkok', 'yyyy-MM-dd');

  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) return [];

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    tripId : headers.indexOf('TripID'),
    date   : headers.indexOf('วันที่'),
    plate  : headers.indexOf('ทะเบียน/รถ'),
    driver : headers.indexOf('พนักงานขับรถ'),
    liters : headers.indexOf('น้ำมันที่เติม(ลิตร)'),
    price  : headers.indexOf('ราคาน้ำมัน(บาท)'),
    note   : headers.indexOf('หมายเหตุ')
  };
  if (idx.plate < 0 || idx.date < 0 || idx.liters < 0) return [];

  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const rowPlateFull = String(row[idx.plate] || '').trim();
    const rowPlate = rowPlateFull.split(' ')[0].trim();
    if (rowPlate !== targetPlate && rowPlateFull !== targetPlateFull) continue;

    const liters = Number(row[idx.liters]);
    if (!liters || isNaN(liters) || liters <= 0) continue; // แถวนี้ยังไม่มีข้อมูลน้ำมัน → ไม่นับว่าซ้ำ

    const rowDate = normalizeDateStr_(row[idx.date]);
    if (rowDate !== targetDate && rowDate !== prevDate && rowDate !== nextDate) continue;

    out.push({
      tripId   : row[idx.tripId] || '',
      date     : rowDate,
      dayOffset: rowDate === targetDate ? 0 : (rowDate === prevDate ? -1 : 1),
      liters   : liters,
      price    : idx.price >= 0 ? row[idx.price] : '',
      driver   : idx.driver >= 0 ? String(row[idx.driver] || '') : '',
      note     : idx.note >= 0 ? String(row[idx.note] || '') : ''
    });
  }
  out.sort(function (a, b) { return a.dayOffset - b.dayOffset; });
  return out;
}

/** buildDuplicateWarningMessage_ — สร้างข้อความแจ้งเตือนภาษาไทยจากผลลัพธ์ checkFuelBacklogDuplicate_ */
function buildDuplicateWarningMessage_(dup) {
  const dayLabel = { '-1': 'วันก่อนหน้า 1 วัน', '0': 'วันเดียวกัน', '1': 'วันถัดไป 1 วัน' };
  const lines = dup.map(function (d) {
    return '• ' + d.date + ' (' + dayLabel[String(d.dayOffset)] + ') เติม ' + d.liters + ' ลิตร'
      + (d.price !== '' && d.price != null ? ' · ' + d.price + ' บาท' : '')
      + (d.driver ? ' · พขร. ' + d.driver : '')
      + (d.tripId ? ' [' + d.tripId + ']' : '');
  });
  return '⚠️ พบว่าทะเบียนนี้มีการลงบิลน้ำมันไว้แล้วใกล้เคียงวันที่ระบุ:\n' + lines.join('\n')
    + '\n\nยืนยันว่าต้องการบันทึกรายการนี้เพิ่ม (ซ้อนกับรายการข้างต้น) หรือไม่?';
}

/**
 * checkFuelBacklogDuplicate — API ให้ frontend เรียกตรวจสอบก่อนกดบันทึก (แสดงคำเตือนล่วงหน้า
 * ตั้งแต่ตอนกรอกฟอร์ม ก่อนที่ผู้ใช้จะกดปุ่มบันทึกจริงด้วยซ้ำ)
 * payload: { plate, date }
 */
function checkFuelBacklogDuplicate(payload) {
  const dup = checkFuelBacklogDuplicate_(payload && payload.plate, payload && payload.date);
  return { status: 'ok', duplicates: dup, count: dup.length,
    message: dup.length > 0 ? buildDuplicateWarningMessage_(dup) : '' };
}

/**
 * addFuelBacklogEntry_ — สร้างแถวใหม่ใน MileLog สำหรับรายการเติมน้ำมันที่ไม่มีทริปบันทึกไว้เลย
 * ✅ สำคัญมาก: ฟังก์ชันนี้ "ห้าม" เรียก updateVehicleStatus หรือ syncVehicleFromMileRow_ เด็ดขาด
 * เพราะแถวนี้คือข้อมูลย้อนหลัง ไม่ใช่ทริปที่กำลังเกิดขึ้นจริง ถ้าไปอัปเดตสถานะรถใน Vehicles sheet
 * จะทำให้หน้า dashboard/index/startmile เข้าใจผิดว่ารถคันนี้เพิ่งมีความเคลื่อนไหวล่าสุดจากแถวนี้ทันที
 *
 * fields: { date(yyyy-MM-dd), plate, driver?, odoAt?(เลขไมล์ ณ วันเติม ถ้าทราบ), fuelLiters, fuelPrice?, note? }
 * คืนค่า TripID ที่สร้างขึ้น (ขึ้นต้นด้วย 'FB' เพื่อแยกจากทริปจริงที่ขึ้นต้นด้วย 'T')
 */
function addFuelBacklogEntry_(fields) {
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_MILE, [
    'TripID','Timestamp','วันที่','เวลาออก','ทะเบียน/รถ','พนักงานขับรถ',
    'ปลายทาง','เลขไมล์ต้น','เลขไมล์ปลาย','ระยะทาง(กม.)',
    'เวลากลับ','สถานะ','น้ำมันที่เติม(ลิตร)','ราคาน้ำมัน(บาท)','หมายเหตุ','รูปบิลน้ำมัน',
    'รูปบิลน้ำมันขากลับ','จุดขอใช้รถ','รูปสภาพรถ','รูปสภาพรถขากลับ'
  ]);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  const tripId  = 'FB' + Date.now();
  const dateStr = String(fields.date || '').trim() || formatThaiDate(new Date());
  // ✅ เลขไมล์ต้น = เลขไมล์ปลาย (ถ้าทราบ) → ระยะทาง(กม.) = 0 เสมอ กันไม่ให้แถวนี้ไปบวกเพิ่มระยะทางรวม
  // ของทริปจริง (ไม่งั้นยอด กม. รวมกองรถจะเพี้ยน) แต่ยังเก็บ "เลขไมล์ ณ วันนั้น" ไว้เป็นจุดอ้างอิงได้ถ้าทราบ
  const hasOdo  = fields.odoAt !== '' && fields.odoAt != null && !isNaN(Number(fields.odoAt));
  const odoVal  = hasOdo ? Number(fields.odoAt) : '';

  const map = {
    'TripID'              : tripId,
    'Timestamp'            : formatDisplayDate(new Date()),
    'วันที่'                : dateStr,
    'ทะเบียน/รถ'           : String(fields.plate || '').trim(),
    'พนักงานขับรถ'         : String(fields.driver || '').trim(),
    'ปลายทาง'               : '',
    'เลขไมล์ต้น'           : odoVal,
    'เลขไมล์ปลาย'          : odoVal,
    'ระยะทาง(กม.)'         : hasOdo ? 0 : '',
    'สถานะ'                 : 'พร้อมใช้งาน', // ✅ ตายตัว — แถวย้อนหลังไม่มีทางเป็น "กำลังใช้งาน"
    'น้ำมันที่เติม(ลิตร)'   : Number(fields.fuelLiters) || 0,
    'ราคาน้ำมัน(บาท)'      : (fields.fuelPrice !== '' && fields.fuelPrice != null) ? (Number(fields.fuelPrice) || 0) : '',
    'หมายเหตุ'              : String(fields.note || '').trim() || 'เติมน้ำมันย้อนหลัง (ไม่มีทริปบันทึกไว้เดิม)'
  };

  const row = headers.map(function (h) { return (h in map) ? map[h] : ''; });
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return tripId;
}

/**
 * directAddFuelBacklogEntry — แอดมินเพิ่มรายการเติมน้ำมันย้อนหลังตรง (ไม่มีทริปเดิม) มีผลทันที
 * payload: { date, plate, driver, odoAt, fuelLiters, fuelPrice, note, editedBy, reason, adminCode }
 */
function directAddFuelBacklogEntry(payload) {
  const _adminCheck = checkAdminCode_(payload);
  if (!_adminCheck.ok) return { status: 'error', message: _adminCheck.message };
  const reason = String(payload.reason || '').trim();
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผล/ที่มาของรายการนี้ (เช่น ลืมกดออกรถ, พขร. ใช้รถแบบไม่ผ่านระบบ)' };

  const check = validateFuelBacklogFields_(payload);
  if (!check.ok) return { status: 'error', message: check.message };

  // ✅ NEW: กันลงบิลน้ำมันย้อนหลังซ้ำซ้อน — เช็กว่าทะเบียนนี้มีบิลลงไว้แล้วในวันที่นี้ (หรือ ±1 วัน) หรือไม่
  // ถ้าพบและ frontend ยังไม่ได้ส่ง confirmDuplicate มายืนยัน ให้ตีกลับไปถามยืนยันก่อน แทนที่จะสร้างซ้ำเงียบๆ
  if (!payload.confirmDuplicate) {
    const dup = checkFuelBacklogDuplicate_(payload.plate, payload.date);
    if (dup.length > 0) {
      return { status: 'confirm_needed', duplicates: dup, message: buildDuplicateWarningMessage_(dup) };
    }
  }

  const tripId = addFuelBacklogEntry_(payload);

  const ss = getSpreadsheet();
  const now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const logSheet = getOrCreateSheet(ss, SHEET_MILE_EDIT_LOG, MILE_EDIT_LOG_HEADERS);
  logSheet.appendRow([
    now, tripId, String(payload.plate || ''), '(เพิ่มรายการน้ำมันย้อนหลัง — ไม่มีทริปเดิม)',
    '', 'ลิตร:' + payload.fuelLiters + ' ราคา:' + (payload.fuelPrice || '-'),
    String(payload.editedBy || ''), 'แอดมิน (เพิ่มตรง)', reason, String(payload.editedBy || ''), now, 'แอดมินเพิ่มย้อนหลัง'
  ]);

  // ✅ NEW: ลง FuelLog ทุกครั้งที่บันทึก
  appendFuelLog_(tripId, String(payload.plate || ''), payload.fuelLiters, payload.fuelPrice || '', 'เพิ่มย้อนหลัง', String(payload.editedBy || ''), reason);

  return { status: 'ok', message: 'บันทึกรายการเติมน้ำมันย้อนหลังเรียบร้อย', tripId: tripId };
}

/**
 * submitAddFuelBacklogRequest — พขร. ส่งคำขอเพิ่มรายการเติมน้ำมันย้อนหลัง (ไม่มีทริปเดิม) รอแอดมินอนุมัติ
 * payload: { date, plate, driver, odoAt, fuelLiters, fuelPrice, note, requestedBy, reason }
 */
function submitAddFuelBacklogRequest(payload) {
  const requestedBy = String(payload.requestedBy || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!requestedBy) return { status: 'error', message: 'กรุณาเลือกชื่อผู้ขอ' };
  if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผล/ที่มาของรายการนี้' };

  const check = validateFuelBacklogFields_(payload);
  if (!check.ok) return { status: 'error', message: check.message };

  // ✅ NEW: กันลงบิลน้ำมันย้อนหลังซ้ำซ้อน เช่นเดียวกับฝั่งแอดมิน (directAddFuelBacklogEntry)
  if (!payload.confirmDuplicate) {
    const dup = checkFuelBacklogDuplicate_(payload.plate, payload.date);
    if (dup.length > 0) {
      return { status: 'confirm_needed', duplicates: dup, message: buildDuplicateWarningMessage_(dup) };
    }
  }

  const fields = {
    date: payload.date, plate: payload.plate, driver: payload.driver || '',
    odoAt: payload.odoAt || '', fuelLiters: payload.fuelLiters, fuelPrice: payload.fuelPrice || '',
    note: payload.note || ''
  };

  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_PENDING_EDITS, PENDING_EDIT_HEADERS);
  const now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const reqId = 'REQF' + new Date().getTime();

  sheet.appendRow([
    reqId, 'เพิ่มน้ำมัน', now, '', String(payload.plate || ''),
    JSON.stringify(fields), JSON.stringify({}), JSON.stringify(fields),
    requestedBy, reason, 'รอตรวจสอบ', '', '', ''
  ]);
  return { status: 'ok', message: 'ส่งคำขอเพิ่มรายการน้ำมันย้อนหลังแล้ว รอแอดมินอนุมัติ', requestId: reqId };
}

/**
 * getMileAnomalies — ตรวจไมล์ที่หายไป/ผิดปกติ
 * อ่านข้อมูลจากชีท "รายงานไมล์หาย_ละเอียด" (ที่ตั้งสูตรคำนวณแบบเรียลไทม์ไว้ในชีทเองแล้ว)
 * แทนการคำนวณเองใน Apps Script ดังนั้นความถูกต้อง/เรียลไทม์ขึ้นอยู่กับสูตรในชีทนั้นโดยตรง
 *
 * โครงสร้างคอลัมน์ของชีท (ตามลำดับ):
 * วันที่ | ทะเบียน/รถ | พนักงานขับรถ | ไมล์สิ้นสุดทริปก่อนหน้า | ไมล์เริ่มต้นทริปปัจจุบัน | ระยะทางที่หายไป (กม.)
 *
 * ไม่แสดงรถผู้บริหาร (ดู MILE_GAP_EXCLUDE_PLATES ด้านบนไฟล์นี้ — ปัจจุบันคือ นง.8781 ชม — รถตู้ฮุนได)
 */
function getMileAnomalies() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE_GAP_DETAIL);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [] };

  const values  = sheet.getDataRange().getValues();
  const headers = values[0];
  const idx = {
    date         : headers.indexOf('วันที่'),
    plate        : headers.indexOf('ทะเบียน/รถ'),
    driver       : headers.indexOf('พนักงานขับรถ'),
    prevEndMile  : headers.indexOf('ไมล์สิ้นสุดทริปก่อนหน้า'),
    currStartMile: headers.indexOf('ไมล์เริ่มต้นทริปปัจจุบัน'),
    missingKm    : headers.indexOf('ระยะทางที่หายไป (กม.)')
  };
  if (idx.plate < 0 || idx.missingKm < 0) {
    return { status: 'error', message: 'ไม่พบคอลัมน์ที่จำเป็นในชีท "' + SHEET_MILE_GAP_DETAIL + '"' };
  }

  function fmtDateOnly_(val) {
    if (!val) return '';
    const d = val instanceof Date ? val : new Date(val);
    if (isNaN(d.getTime())) return String(val);
    try { return Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy'); } catch (_) { return String(val); }
  }

  // ✅ NEW: ชีท "รายงานไมล์หาย_ละเอียด" มีแค่คอลัมน์ "วันที่" คอลัมน์เดียว (ของทริปปัจจุบัน)
  // ไม่มีวันที่/เวลาอ้างอิงของ "ไมล์ก่อนหน้า" (ทริปก่อนหน้าที่จบด้วยเลขไมล์นั้น) แยกไว้เลย
  // จึงต้อง cross-reference กับชีท MileLog โดยตรง (ทะเบียน + เลขไมล์ → วันที่/เวลาจริงของทริปนั้น)
  // เพื่อโชว์วงเล็บกำกับใต้ "ไมล์ก่อนหน้า" และ "ไมล์เริ่มต้น" ว่าอ้างอิงจากทริปวันที่/เวลาใด
  const refByEndMile   = {}; // key: 'ทะเบียน|เลขไมล์สิ้นสุด'  → "dd/MM/yyyy HH:mm น."
  const refByStartMile = {}; // key: 'ทะเบียน|เลขไมล์เริ่มต้น' → "dd/MM/yyyy HH:mm น."
  try {
    const mileSheet = ss.getSheetByName(SHEET_MILE);
    if (mileSheet && mileSheet.getLastRow() > 1) {
      const mVals    = mileSheet.getDataRange().getValues();
      const mHeaders = mVals[0];
      const mIdx = {
        plate     : mHeaders.indexOf('ทะเบียน/รถ'),
        startMile : mHeaders.indexOf('ไมล์เริ่มต้น'),
        endMile   : mHeaders.indexOf('ไมล์สิ้นสุด'),
        tripDate  : mHeaders.indexOf('วันที่'),
        startTime : mHeaders.indexOf('เวลาออก'),
        endTime   : mHeaders.indexOf('เวลากลับ')
      };
      function fmtTimePart_(v) {
        if (!v) return '';
        if (v instanceof Date) { try { return Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm'); } catch (_) { return ''; } }
        const m = String(v).match(/(\d{1,2}):(\d{2})/);
        return m ? (m[1].length < 2 ? '0' + m[1] : m[1]) + ':' + m[2] : '';
      }
      function fmtRef_(dateVal, timeVal) {
        const dPart = fmtDateOnly_(dateVal);
        const tPart = fmtTimePart_(timeVal);
        if (!dPart) return '';
        return dPart + (tPart ? ' ' + tPart + ' น.' : '');
      }
      for (let i = 1; i < mVals.length; i++) {
        const row   = mVals[i];
        const plate = String(row[mIdx.plate] || '').trim();
        if (!plate) continue;
        if (mIdx.endMile >= 0) {
          const endMileVal = Number(row[mIdx.endMile]);
          if (endMileVal > 0) {
            refByEndMile[plate + '|' + endMileVal] = fmtRef_(row[mIdx.tripDate], row[mIdx.endTime]);
          }
        }
        if (mIdx.startMile >= 0) {
          const startMileVal = Number(row[mIdx.startMile]);
          if (startMileVal > 0) {
            refByStartMile[plate + '|' + startMileVal] = fmtRef_(row[mIdx.tripDate], row[mIdx.startTime]);
          }
        }
      }
    }
  } catch (refErr) {
    console.warn('getMileAnomalies: สร้าง reference lookup จาก MileLog ไม่สำเร็จ:', refErr.message);
  }

  const anomalies = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const plate = String(row[idx.plate] || '').trim();
    if (!plate) continue;

    // ไม่แสดงรถผู้บริหาร (เทียบแบบ contains กันปัญหาจุด/ช่องว่างสะกดต่างกันเล็กน้อย)
    if (MILE_GAP_EXCLUDE_PLATES.some(function (p) { return plate.indexOf(p) >= 0; })) continue;

    const missingKm = Number(row[idx.missingKm]);
    if (!isFinite(missingKm) || missingKm <= 0) continue; // แสดงเฉพาะกรณีระยะทางหายไปจริง (มากกว่า 0 กม.)

    const dateVal = idx.date >= 0 ? row[idx.date] : null;
    const dateMs  = dateVal instanceof Date && !isNaN(dateVal.getTime())
      ? dateVal.getTime()
      : (dateVal ? new Date(dateVal).getTime() : NaN);

    const prevEndMileVal   = idx.prevEndMile >= 0 ? Number(row[idx.prevEndMile]) : '';
    const currStartMileVal = idx.currStartMile >= 0 ? Number(row[idx.currStartMile]) : '';

    anomalies.push({
      plate        : plate,
      currDate     : idx.date >= 0 ? fmtDateOnly_(row[idx.date]) : '',
      _dateMs      : isFinite(dateMs) ? dateMs : -Infinity, // ใช้เรียงลำดับเท่านั้น ไม่ส่งออกไปหน้าเว็บ
      currDriver   : idx.driver >= 0 ? String(row[idx.driver] || '') : '',
      prevEndMile  : prevEndMileVal,
      currStartMile: currStartMileVal,
      // ✅ NEW: วันที่/เวลาอ้างอิงจริงของแต่ละเลขไมล์ (มาจาก MileLog โดยตรง)
      prevEndRef   : (prevEndMileVal   && refByEndMile[plate + '|' + prevEndMileVal])     || '',
      currStartRef : (currStartMileVal && refByStartMile[plate + '|' + currStartMileVal]) || '',
      missingKm    : missingKm
    });
  }

  // เรียงตามวันที่ล่าสุดขึ้นก่อน (ถ้าวันที่ตรงกัน ให้ระยะทางหายมากอยู่บนสุด)
  anomalies.sort(function (a, b) { return b._dateMs - a._dateMs || b.missingKm - a.missingKm; });
  anomalies.forEach(function (a) { delete a._dateMs; }); // ไม่ต้องส่งฟิลด์ภายในนี้ออกไปหน้าเว็บ

  return { status: 'ok', data: anomalies };
}

// ════════════════════════════════════════════════════════════
//  SECTION 3: ตรวจอุปกรณ์ EMS (EMScheck.html)
// ════════════════════════════════════════════════════════════

function saveEMS(payload) {
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_EMS, [
    'Timestamp','วันที่','เวลา','รถ EMS','ผู้ตรวจ',
    'รหัสอุปกรณ์','ชื่ออุปกรณ์','หมวด','สถานะ','วันหมดอายุ','หมายเหตุ',
    'ผลรวม','ผ่าน','ไม่ผ่าน/ขาด/ชำรุด'
  ]);

  const ts        = formatDisplayDate(new Date());
  const items     = payload.items || [];
  const passCount = items.filter(function(it) { return it.status === 'พร้อม'; }).length;
  const failCount = items.length - passCount;

  items.forEach(function(item) {
    sheet.appendRow([
      ts,
      payload.checkDate   || formatThaiDate(new Date()),
      payload.checkTime   || formatTime(new Date()),
      payload.carId       || '',
      payload.checkerName || '',
      item.id             || '',
      item.name           || '',
      item.category       || '',
      item.status         || '',
      item.expDate        || '',
      item.note           || '',
      items.length,
      passCount,
      failCount
    ]);
  });

  SpreadsheetApp.flush();

  const failItems = items.filter(function(it) { return it.status !== 'พร้อม'; });
  if (failItems.length > 0) sendEMSAlert(payload, failItems);
  checkExpiredItems(payload, items);

  return {
    status  : 'ok',
    message : 'บันทึก EMS Check สำเร็จ',
    total   : items.length,
    pass    : passCount,
    fail    : failCount,
    passRate: Math.round((passCount / items.length) * 100) + '%'
  };
}

function getEMSData() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_EMS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const data    = rows.slice(1).map(function(row) {
    const obj = {};
    headers.forEach(function(h, i) {
      let v = row[i];
      if (v instanceof Date) {
        if (h === 'วันที่') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
        } else if (h === 'เวลา') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm:ss');
        } else if (h === 'Timestamp' || h === 'timestamp') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        } else {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        }
      }
      obj[h] = v;
      // alias Timestamp → timestamp สำหรับ dashboard
      if (h === 'Timestamp' || h === 'timestamp') obj['timestamp'] = v;
    });
    return obj;
  });
  return { status: 'ok', data: data, count: data.length };
}

function restockEMS(payload) {
  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, 'EMSRestock', [
    'Timestamp','วันที่','รถ EMS','ผู้เติม',
    'รหัสอุปกรณ์','ชื่ออุปกรณ์','จำนวน','วันหมดอายุใหม่','หมายเหตุ'
  ]);

  const items = payload.items || [];
  items.forEach(function(item) {
    sheet.appendRow([
      formatDisplayDate(new Date()),
      payload.restockDate   || formatThaiDate(new Date()),
      payload.carId         || '',
      payload.restockerName || '',
      item.id               || '',
      item.name             || '',
      item.quantity         || 1,
      item.newExpDate       || '',
      item.note             || ''
    ]);
  });
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'บันทึกการเติมอุปกรณ์สำเร็จ', count: items.length };
}
// ════════════════════════════════════════════════════════════
//  SECTION 4: Status Summary (dashboard + index)
//  แก้ไข v2.2:
//    - ย้าย mileHeaders + ตัวแปร index ขึ้นบนสุดของฟังก์ชัน
//      เพื่อแก้ bug "mileDateIdx is not defined"
//      (เดิมประกาศใน block if (mileSheet) แต่ถูกใช้นอก block)
//    - เพิ่ม fallback สำหรับ index ที่อาจเป็น -1
//    - รักษา logic เดิมทั้งหมดไว้ครบถ้วน
// ════════════════════════════════════════════════════════════

function getStatusSummary() {
  return cached_('SUMMARY', 30, getStatusSummaryCompute_);
}

function getStatusSummaryCompute_() {
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  const ss    = getSpreadsheet();

  // ────────────────────────────────────────────────────────────
  // 1) ดึง header ของ MileLog ล่วงหน้า (แก้ bug scope)
  //    เพื่อให้ตัวแปร index ใช้ได้ทุกที่ในฟังก์ชัน
  // ────────────────────────────────────────────────────────────
  const mileSheet = ss.getSheetByName(SHEET_MILE);
  let mileHeaders     = [];
  let mileStatIdx     = 11;   // default: col L = สถานะ
  let mileDateIdx     = 2;    // default: col C = วันที่
  let mileCarIdx      = 4;    // default: col E = ทะเบียน/รถ
  let mileDriverIdx   = 5;    // default: col F = พนักงานขับรถ
  let mileDestIdx     = 6;    // default: col G = ปลายทาง
  let mileTripIdx     = 1;    // default: col B = รหัสทริป/TripID
  let mileTimeOutIdx  = 3;    // default: col D = เวลาออก
  let mileOdomIdx     = 7;    // default: col H = ไมล์เริ่มต้น
  let mileFuelIdx     = 12;   // default: col M = น้ำมันที่เติม(ลิตร)
  let milePriceIdx    = 13;   // default: col N = ราคาน้ำมัน
  let mileTimeBackIdx = 10;   // default: col K = เวลากลับ
  let mileOdomEndIdx  = 8;    // default: col I = ไมล์สิ้นสุด
  let mileDistIdx     = 9;    // default: col J = ระยะทาง(กม.)
  let mileRetFuelIdx  = -1;   // ลิตรเติมขากลับ (ถ้ามี)
  let mileRetPriceIdx = -1;   // ราคาเติมขากลับ (ถ้ามี)

  if (mileSheet && mileSheet.getLastRow() > 0) {
    try {
      mileHeaders = mileSheet.getRange(1, 1, 1, mileSheet.getLastColumn()).getValues()[0];
      // helper: หา index แบบ fallback
      const findIdx = (names, fallback) => {
        for (let i = 0; i < names.length; i++) {
          const idx = mileHeaders.indexOf(names[i]);
          if (idx >= 0) return idx;
        }
        return fallback;
      };
      mileStatIdx     = findIdx(['ผู้โดยสาร', 'สถานะ'], 11);
      mileDateIdx     = findIdx(['วันที่'], 2);
      mileCarIdx      = findIdx(['ทะเบียน/รถ', 'ทะเบียนรถ', 'ทะเบียน'], 4);
      mileDriverIdx   = findIdx(['พนักงานขับรถ', 'ผู้ขับ'], 5);
      mileDestIdx     = findIdx(['ปลายทาง'], 6);
      mileTripIdx     = findIdx(['รหัสทริป', 'TripID', 'tripId'], 1);
      mileTimeOutIdx  = findIdx(['เวลาออก'], 3);
      mileOdomIdx     = findIdx(['ไมล์เริ่มต้น', 'เลขไมล์ต้น'], 7);
      mileFuelIdx     = findIdx(['น้ำมันที่เติม(ลิตร)', 'น้ำมันที่เติม', 'เติมน้ำมัน(ลิตร)'], 12);
      milePriceIdx    = findIdx(['ราคาน้ำมัน(บาท)', 'ราคาน้ำมัน'], 13);
      mileTimeBackIdx = findIdx(['เวลากลับ'], 10);
      mileOdomEndIdx  = findIdx(['ไมล์สิ้นสุด', 'เลขไมล์ปลาย'], 8);
      mileDistIdx     = findIdx(['ระยะทาง(กม.)', 'ระยะทาง'], 9);
      mileRetFuelIdx  = findIdx(['ลิตรเติมขากลับ'], -1);
      mileRetPriceIdx = findIdx(['ราคาเติมขากลับ(บาท)'], -1);
    } catch (e) {
      console.warn('getStatusSummary: mileHeaders parse error:', e.message);
    }
  }

  // ⚡ อ่าน MileLog "เฉพาะแถวที่เกี่ยวข้อง" (วันนี้ + กำลังใช้งาน) ครั้งเดียว แทนการอ่านทั้งชีท 4 รอบ + getFormulas ทั้งชีท 2 รอบ
  const mileCtx = (mileSheet && mileSheet.getLastRow() > 1)
    ? readRowsSubset_(mileSheet, [mileDateIdx, mileStatIdx], function (v) {
        return parseDateToYMD(v[0]) === today || String(v[1] || '').trim() === 'กำลังใช้งาน';
      }, [15, 16, 17])
    : { rows: [[]], formulas: [[]] };

  // ────────────────────────────────────────────────────────────
  // 2) รถทั้งหมด (Vehicles sheet)
  // ────────────────────────────────────────────────────────────
  const vehicleData = getVehicles().data;

  // ────────────────────────────────────────────────────────────
  // 3) รถที่ตรวจวันนี้ (CheckLog)
  // ────────────────────────────────────────────────────────────
  const checkSheet  = ss.getSheetByName(SHEET_CHECK);
  const checkedCars = [];
  const checkedPlateSet = new Set();

  if (checkSheet && checkSheet.getLastRow() > 1) {
    const rows = readRowsSubset_(checkSheet, [1], function (v) { return parseDateToYMD(v[0]) === today; }, []).rows;  // ⚡ เฉพาะแถววันนี้
    const headers_check = checkSheet.getRange(1, 1, 1, checkSheet.getLastColumn()).getValues()[0];
    const fuelLevelIdx_c = headers_check.indexOf('ปริมาณน้ำมัน') >= 0
      ? headers_check.indexOf('ปริมาณน้ำมัน')
      : (headers_check.indexOf('ระดับน้ำมันเชื้อเพลิง') >= 0
          ? headers_check.indexOf('ระดับน้ำมันเชื้อเพลิง') : 20);
    const fuelFillIdx_c = headers_check.indexOf('การเติมน้ำมัน') >= 0
      ? headers_check.indexOf('การเติมน้ำมัน')
      : (headers_check.indexOf('เติมน้ำมัน') >= 0
          ? headers_check.indexOf('เติมน้ำมัน') : 21);
    const driveLinksIdx_c = headers_check.indexOf('DriveLinks') >= 0
      ? headers_check.indexOf('DriveLinks') : 32;
    const o2LevelIdx_c = headers_check.indexOf('ระดับ O₂ (PSI)') >= 0
      ? headers_check.indexOf('ระดับ O₂ (PSI)') : 29;

    rows.slice(1).forEach(function(row) {
      const rowDate = parseDateToYMD(row[1]);
      if (rowDate === today) {
        const carType = String(row[3] || '');
        const plate   = carType.split(' ')[0].trim();
        if (!checkedPlateSet.has(plate)) {
          checkedPlateSet.add(plate);
          checkedCars.push({
            carType   : carType,
            driverName: String(row[4] || ''),
            inspTime  : formatTimeCell(row[2]),
            odometer  : row[5] || '',
            fuelLevel : String(row[fuelLevelIdx_c] || ''),
            fuelFill  : String(row[fuelFillIdx_c] || ''),
            driveLinks: String(row[driveLinksIdx_c] || ''),
            o2Level   : String(row[o2LevelIdx_c] || '')
          });
        }
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // 4) รถที่กำลังใช้งาน (MileLog — สถานะ = "กำลังใช้งาน" + วันที่ = today)
  // ────────────────────────────────────────────────────────────
  const inUse = [];
  const inUsePlateSet = new Set();

  if (mileSheet && mileSheet.getLastRow() > 1) {
    const rows = mileCtx.rows;
    rows.slice(1).forEach(function(row) {
      const statusVal = String(row[mileStatIdx] || '').trim();
      if (statusVal !== 'กำลังใช้งาน') return;

      // ✅ FIX: เดิมกรองเฉพาะ trip ที่วันที่ = วันนี้ ทำให้รถที่ออกก่อนเที่ยงคืน
      // แล้วยังไม่กลับ (ยังไม่ปิดทริป) หลุดออกจากลิสต์ "กำลังใช้งาน" พอข้ามวัน
      // → พขร. ผู้ขับปัจจุบันหายไปจากหน้า index ทั้งที่รถยังไม่คืน
      // ตอนนี้ใช้แค่ "สถานะ = กำลังใช้งาน" เป็นตัวตัดสิน ไม่สนวันที่ออกทริป
      const tripDate = parseDateToYMD(row[mileDateIdx]);

      const carType = String(row[mileCarIdx] || '');
      const plate   = carType.split(' ')[0].trim();
      if (!inUsePlateSet.has(plate)) {
        inUsePlateSet.add(plate);
        inUse.push({
          tripId     : String(row[mileTripIdx] || ''),
          carType    : carType,
          driver     : String(row[mileDriverIdx] || ''),
          destination: String(row[mileDestIdx] || ''),
          tripDate   : tripDate,
          startTime  : String(row[mileTimeOutIdx] || ''),
          odomStart  : Number(row[mileOdomIdx]) || 0,
          fuelLiters : row[mileFuelIdx] || ''
        });
      }
    });
  }

  // ────────────────────────────────────────────────────────────
  // 5) รถที่ยังไม่ตรวจวันนี้
  // ────────────────────────────────────────────────────────────
  const notChecked = vehicleData
    .map(function(v) { return String(v['ทะเบียน'] || '').trim(); })
    .filter(function(plate) {
      if (!plate) return false;
      const shortPlate = plate.split(' ')[0].trim();
      return !checkedPlateSet.has(shortPlate) && !checkedPlateSet.has(plate);
    });

  // รถที่ตรวจแล้ว + ไม่ได้กำลังใช้งาน
  const ready = checkedCars.filter(function(c) {
    const plate = c.carType.split(' ')[0].trim();
    return !inUsePlateSet.has(plate);
  });

  // ────────────────────────────────────────────────────────────
  // 6) รถที่เติมน้ำมันวันนี้ (cross-match MileLog + CheckLog)
  // ────────────────────────────────────────────────────────────
  const todayFueled    = [];
  const fueledPlateSet = new Set();

  // 6.1) ดึง MileLog ทั้งวันนี้ไว้เป็น map เพื่อ cross-match
  const mileFuelMap = {}; // plate → { fuelLiters, fuelPrice, fuelPhotoUrl, time, driverName }
  if (mileSheet && mileSheet.getLastRow() > 1) {
    const mRows      = mileCtx.rows;
    const mFormulas  = mileCtx.formulas;

    // helper: แกะ URL จาก =HYPERLINK formula หรือ plain URL
    function extractUrlFromCell(formulaStr, valueStr) {
      var f = String(formulaStr || '').trim();
      var m = f.match(/=HYPERLINK\("([^"]+)"/i);
      if (m && m[1].startsWith('http')) return m[1];
      var v = String(valueStr || '').trim();
      if (v.startsWith('http')) return v;
      return '';
    }

    mRows.slice(1).forEach(function(row, rowIdx) {
      const rowDate = parseDateToYMD(row[mileDateIdx]);
      if (rowDate !== today) return;
      const carType = String(row[mileCarIdx] || '');
      const plate   = carType.split(' ')[0].trim();

      // formulaRow index = rowIdx+1 เพราะ row[0] คือ header
      const formulaRow = mFormulas[rowIdx + 1] || [];
      // col 15 = รูปบิลน้ำมันออกรถ (ขาไป), col 16 = timestamp, col 17 = รูปบิลน้ำมันขากลับ
      const outUrl    = extractUrlFromCell(formulaRow[15], row[15]);
      const retUrl    = extractUrlFromCell(formulaRow[17], row[17])
                     || extractUrlFromCell(formulaRow[16], row[16]); // fallback col 16

      // ── ใช้รูปบิลน้ำมันเป็นตัวตัดสินว่า "เติมแล้ว" หรือไม่ ──
      // ถ้ามีรูปบิล (ขาไปหรือขากลับ) ให้ถือว่าเติมแล้ว และระดับน้ำมัน = 100%
      if (!outUrl && !retUrl) return;

      const hasFuel = String(row[mileFuelIdx] || '').trim();

      // เก็บ record ล่าสุดของแต่ละ plate
      mileFuelMap[plate] = {
        fuelLiters         : fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).liters,
        fuelPrice          : fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).price,
        fuelPhotoUrl       : outUrl,
        returnFuelPhotoUrl : retUrl,
        fuelLevel          : '100%',
        time               : formatTimeCell(row[mileTimeOutIdx]),
        driverName         : String(row[mileDriverIdx] || '')
      };
    });
  }

  // 6.2) จาก CheckLog (fuelFill = 'เติม') — ใช้ร่วมกับรูปบิลจาก MileLog (6.1) เพื่อยืนยัน
  checkedCars.forEach(function(c) {
    if (c.fuelFill === 'เติม') {
      const plate = c.carType.split(' ')[0].trim();
      const mf = mileFuelMap[plate] || {};
      if (!fueledPlateSet.has(plate)) {
        fueledPlateSet.add(plate);
        todayFueled.push({
          carType            : c.carType,
          driverName         : mf.driverName || c.driverName,
          time               : mf.time || c.inspTime,
          // ถ้ามีรูปบิลน้ำมัน → ระดับน้ำมัน 100% เสมอ ไม่ว่า CheckLog จะบันทึกระดับไว้เท่าไหร่
          fuelLevel          : (mf.fuelPhotoUrl || mf.returnFuelPhotoUrl) ? '100%' : c.fuelLevel,
          fuelLiters         : mf.fuelLiters  || '',
          fuelPrice          : mf.fuelPrice   || '',
          fuelPhotoUrl       : mf.fuelPhotoUrl       || '',
          returnFuelPhotoUrl : mf.returnFuelPhotoUrl  || '',
          source             : 'check'
        });
      }
    }
  });

  // 6.3) จาก MileLog — เติมแล้วถ้ามี "รูปบิลน้ำมัน" แนบมา (ไม่ต้องดูลิตร/ราคา)
  if (mileSheet && mileSheet.getLastRow() > 1) {
    const rows        = mileCtx.rows;
    const m2Formulas  = mileCtx.formulas;

    function extractUrl2(formulaStr, valueStr) {
      var f = String(formulaStr || '').trim();
      var m = f.match(/=HYPERLINK\("([^"]+)"/i);
      if (m && m[1].startsWith('http')) return m[1];
      var v = String(valueStr || '').trim();
      if (v.startsWith('http')) return v;
      return '';
    }

    rows.slice(1).forEach(function(row, rowIdx) {
      const rowDate = parseDateToYMD(row[mileDateIdx]);
      if (rowDate !== today) return;

      const formulaRow2 = m2Formulas[rowIdx + 1] || [];
      // col 15 = รูปบิลน้ำมันออกรถ (ขาไป), col 17 = รูปบิลน้ำมันขากลับ, col 16 = timestamp
      const outPhotoUrl2    = extractUrl2(formulaRow2[15], row[15]);
      const retPhotoUrl2    = extractUrl2(formulaRow2[17], row[17])
                           || extractUrl2(formulaRow2[16], row[16]);

      // ── มีรูปบิลน้ำมัน (ขาไปหรือขากลับ) → ถือว่าเติมแล้ว 100% ──
      if (!outPhotoUrl2 && !retPhotoUrl2) return;

      const carType = String(row[mileCarIdx] || '');
      const plate   = carType.split(' ')[0].trim();
      if (!fueledPlateSet.has(plate)) {
        fueledPlateSet.add(plate);
        const hasFuel = String(row[mileFuelIdx] || '').trim();
        todayFueled.push({
          carType            : carType,
          driverName         : String(row[mileDriverIdx] || ''),
          time               : formatTimeCell(row[mileTimeOutIdx]),
          fuelLevel          : '100%',
          fuelLiters         : fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).liters,
          fuelPrice          : fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).price,
          source             : 'mile',
          fuelPhotoUrl       : outPhotoUrl2,
          returnFuelPhotoUrl : retPhotoUrl2
        });
      }
    });
  }

  // 6.4) จาก MileLog — ตรวจจาก "ปลายทาง" ว่าเป็นปั๊มน้ำมันหรือไม่ + ต้องกลับมาแล้ว (มีเวลากลับ)
  //      เคสนี้ครอบคลุม "ออกรถไปปั๊มน้ำมันแล้วกลับมา แต่ไม่ได้แนบรูปบิล" ซึ่งเป็นสาเหตุหลักที่
  //      ทำให้สถานะน้ำมันไม่เป็นเรียลไทม์ — ใช้เป็น fallback หลังสุด (ไม่ทับของจริงจาก 6.2/6.3)
  if (mileSheet && mileSheet.getLastRow() > 1) {
    const m3Rows = mileCtx.rows;
    m3Rows.slice(1).forEach(function(row) {
      const rowDate = parseDateToYMD(row[mileDateIdx]);
      if (rowDate !== today) return;

      const carType = String(row[mileCarIdx] || '');
      const plate   = carType.split(' ')[0].trim();
      if (!plate || fueledPlateSet.has(plate)) return;

      const destination = String(row[mileDestIdx]     || '').trim();
      const timeBack     = String(row[mileTimeBackIdx] || '').trim();
      // ต้องเดินทางกลับมาแล้วเท่านั้น (มีเวลากลับ) ถึงจะนับว่า "เติมน้ำมันแล้ว"
      // ✅ v2.1: รองรับ 2 case:
      //   Case A: มี timeBack + isFuelStation(destination)
      //   Case B: มี marker 'auto' ใน น้ำมันที่เติม(ลิตร) จาก endMile()
      const fuelMarkerRaw = String(row[mileFuelIdx] || '').trim();
      const caseA = timeBack && isFuelStation(destination) && fuelMarkerRaw !== 'ไม่เติม';  // แอดมินยืนยันแล้วว่าไม่ได้เติมจริง
      const caseB = fuelMarkerRaw === 'auto' || fuelMarkerRaw === 'ตรวจจับอัตโนมัติ';
      if (!caseA && !caseB) return;

      fueledPlateSet.add(plate);
      const hasFuel = fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).liters;
      todayFueled.push({
        carType            : carType,
        driverName         : String(row[mileDriverIdx] || ''),
        time               : formatTimeCell(timeBack || row[mileTimeOutIdx]),
        fuelLevel          : '100%',
        fuelLiters         : hasFuel,
        fuelPrice          : fuelNums_(row, mileFuelIdx, milePriceIdx, mileRetFuelIdx, mileRetPriceIdx).price,
        source             : 'destination',
        destination        : destination || (caseB ? 'ตรวจจับจากปลายทางอัตโนมัติ' : ''),
        fuelPhotoUrl       : '',
        returnFuelPhotoUrl : ''
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // 6.5) รถ EMS/Refer ที่ไป "เปลี่ยนออกซิเจน" วันนี้แล้วกลับมา (MileLog)
  //      ใช้คู่กับ oxygenAlerts (ข้อ 8.5) เพื่อเปลี่ยนสถานะ index.html เป็น "เปลี่ยนแล้ว"
  // ────────────────────────────────────────────────────────────
  const todayOxygenChanged    = [];
  const oxygenChangedPlateSet = new Set();

  if (mileSheet && mileSheet.getLastRow() > 1) {
    const m4Rows = mileCtx.rows;
    m4Rows.slice(1).forEach(function(row) {
      const rowDate = parseDateToYMD(row[mileDateIdx]);
      if (rowDate !== today) return;

      const carType = String(row[mileCarIdx] || '');
      const plate   = carType.split(' ')[0].trim();
      if (!plate || oxygenChangedPlateSet.has(plate)) return;

      const destination = String(row[mileDestIdx]     || '').trim();
      const timeBack    = String(row[mileTimeBackIdx] || '').trim();
      // ต้องเดินทางกลับมาแล้วเท่านั้น (มีเวลากลับ) + ปลายทางเป็น "เปลี่ยนออกซิเจน" ถึงจะนับว่า "เปลี่ยนแล้ว"
      if (!timeBack || !isOxygenChangeMission(destination)) return;

      oxygenChangedPlateSet.add(plate);
      todayOxygenChanged.push({
        carType    : carType,
        driverName : String(row[mileDriverIdx] || ''),
        time       : formatTimeCell(timeBack || row[mileTimeOutIdx]),
        destination: destination
      });
    });
  }

  // ────────────────────────────────────────────────────────────
  // 7) embed sheetStatus สำหรับแต่ละคัน (จาก Vehicles sheet โดยตรง)
  //    เพื่อให้ dashboard/index แสดงสถานะเรียลไทม์
  // ────────────────────────────────────────────────────────────
  const vehiclesMeta = vehicleData.map(function(v) {
    return {
      plate      : String(v['ทะเบียน']        || '').replace(/ ชม\.?$/, '').trim(),
      type       : String(v['ประเภท']          || ''),
      sys        : String(v['ประเภทระบบ']     || 'ทั่วไป'),
      sheetStatus: String(v['สถานะ']          || '').trim(),
      sheetDriver: String(v['ผู้ขับปัจจุบัน'] || '').trim(),
      sheetDest  : String(v['ปลายทาง']        || '').trim()
    };
  });

  // ────────────────────────────────────────────────────────────
  // 8) สร้าง lowFuelAlerts: รถที่ fuelLevel ≤ 50% วันนี้
  //    + cross-match ว่าเติมแล้วหรือยัง
  // ────────────────────────────────────────────────────────────
  const fueledPlateSetFinal = new Set(todayFueled.map(function(t) {
    return t.carType.split(' ')[0].trim();
  }));

  const lowFuelAlerts = [];
  checkedCars.forEach(function(c) {
    const rawLevel = String(c.fuelLevel || '').replace('%', '').trim();
    const pct = parseFloat(rawLevel);
    if (isNaN(pct) || pct > 50) return;
    const plate    = c.carType.split(' ')[0].trim();
    const refueled = fueledPlateSetFinal.has(plate);
    const fuelInfo = refueled
      ? (todayFueled.find(function(t){ return t.carType.split(' ')[0].trim() === plate; }) || {})
      : {};
    lowFuelAlerts.push({
      carType     : c.carType,
      fuelPct     : pct,
      refueled    : refueled,
      fuelLiters  : fuelInfo.fuelLiters  || '',
      fuelPrice   : fuelInfo.fuelPrice   || '',
      fuelPhotoUrl: fuelInfo.fuelPhotoUrl || '',
      refuelTime  : fuelInfo.time        || '',
      driverName  : fuelInfo.driverName  || c.driverName || ''
    });
  });

  // ────────────────────────────────────────────────────────────
  // 8.5) สร้าง oxygenAlerts: รถ EMS/Refer ที่ตรวจ O₂ วันนี้แล้วเป็น "ผิดปกติ" หรือ "ไม่ตรวจ"
  //      + cross-match กับ todayOxygenChanged ว่าเปลี่ยนถังแล้วหรือยัง (คู่กับ index.html)
  // ────────────────────────────────────────────────────────────
  const oxygenChangedPlateSetFinal = new Set(todayOxygenChanged.map(function(t) {
    return t.carType.split(' ')[0].trim();
  }));

  const oxygenAlerts = [];
  checkedCars.forEach(function(c) {
    const isEmsRefer = /refer|ems/i.test(c.carType);
    if (!isEmsRefer) return;
    const rawO2 = String(c.o2Level || '').trim();
    if (!rawO2) return;
    const isAbnormal  = rawO2.indexOf('ผิดปกติ') >= 0;
    const isNotChecked = rawO2 === 'ไม่ตรวจ';
    if (!isAbnormal && !isNotChecked) return; // ปกติ (≥300 PSI) → ไม่ต้องแจ้งเตือน

    const plate  = c.carType.split(' ')[0].trim();
    const changed = isAbnormal && oxygenChangedPlateSetFinal.has(plate);
    const changeInfo = changed
      ? (todayOxygenChanged.find(function(t){ return t.carType.split(' ')[0].trim() === plate; }) || {})
      : {};
    oxygenAlerts.push({
      carType    : c.carType,
      o2Status   : isNotChecked ? 'ไม่ตรวจ' : 'ผิดปกติ',
      changed    : changed,
      changeTime : changeInfo.time       || '',
      driverName : changeInfo.driverName || c.driverName || ''
    });
  });

  // ────────────────────────────────────────────────────────────
  // 9) Return response
  // ────────────────────────────────────────────────────────────
  // 🚗 จำนวนเที่ยวของแต่ละคันในวันนี้ (นับทุกทริปที่วันที่ = วันนี้ รวมที่กำลังใช้งาน)
  const tripCounts = {};
  // 👤 พขร. ล่าสุดของแต่ละคันในวันนี้ (ทริปล่าสุดตามลำดับแถวใน MileLog — แถวใหม่ต่อท้ายเสมอ)
  const lastDrivers = {};
  mileCtx.rows.slice(1).forEach(function(row) {
    if (parseDateToYMD(row[mileDateIdx]) !== today) return;
    const pl = String(row[mileCarIdx] || '').split(' ')[0].trim();
    if (pl) tripCounts[pl] = (tripCounts[pl] || 0) + 1;
    const drv = String(row[mileDriverIdx] || '').trim();
    if (pl && drv) lastDrivers[pl] = drv;
  });

  return {
    status         : 'ok',
    today          : today,
    totalCars      : vehicleData.length,
    tripCounts     : tripCounts,
    lastDrivers    : lastDrivers,
    todayChecked   : checkedCars,
    notCheckedToday: notChecked,
    inUse          : inUse,
    ready          : ready,
    todayFueled    : todayFueled,
    todayOxygenChanged: todayOxygenChanged,
    checkedCount   : checkedCars.length,
    notCheckedCount: notChecked.length,
    inUseCount     : inUse.length,
    readyCount     : ready.length,
    fueledCount    : todayFueled.length,
    lowFuelAlerts  : lowFuelAlerts,
    oxygenAlerts   : oxygenAlerts,
    vehicles       : vehiclesMeta
  };
}

// ════════════════════════════════════════════════════════════
//  SECTION 5: Vehicles / Drivers / Config
// ════════════════════════════════════════════════════════════

function getVehicles() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_VEHICLE);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { status: 'ok', data: getDefaultVehicles() };
  }

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const data    = rows.slice(1).map(function(row) {
    const obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i]; });
    return obj;
  }).filter(function(r) { return r['ทะเบียน'] || r['ประเภท']; });

  return { status: 'ok', data: data.length ? data : getDefaultVehicles() };
}

function getDrivers() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CONFIG);
  if (sheet) {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).trim() === 'Drivers') {
        const names = String(rows[i][1]).split('\n').map(function(n) { return n.trim(); }).filter(Boolean);
        if (names.length) return { status: 'ok', drivers: names };
      }
    }
  }
  return {
    status : 'ok',
    drivers: [
      'นาย ชัยพร มอญแสง','นาย กิตติพงศ์ เขื่อนแก้ว','นาย กานต์นิธิ ทองอร',
      'นาย นพดล คำปินคำ','นาย เก้า พิจิตร',
      'นาย ภาณุพงศ์ กางสำโรง','นาย เฉลิมพล เลาแก้ว','นายชัยพร ชัยศร','นาย ธนวัฒน์ มอญแสง'
    ]
  };
}

function getConfig() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_CONFIG);
  const config = {
    hospitalName: 'โรงพยาบาลสันทราย',
    destinations: [
      'รพ.นครพิงค์','รพ.สันทราย','รพ.สันป่าตอง','รพ.จอมทอง','รพ.ฝาง',
      'รพ.แม่ริม','รพ.สันกำแพง','รพ.ดอยสะเก็ด','รพ.แม่แตง','รพ.เชียงดาว',
      'รพ.แม่อาย','รพ.ไชยปราการ','รพ.เวียงแหง','รพ.พร้าว','รพ.สะเมิง',
      'รพ.หางดง','รพ.สารภี','รพ.ดอยหล่อ','รพ.อมก๋อย','รพ.กัลยาณิวัฒนา',
      'รพ.แม่วาง','อื่นๆ'
    ]
  };
  if (!sheet) return { status: 'ok', config: config };

  const rows = sheet.getDataRange().getValues();
  rows.slice(1).forEach(function(row) {
    const key = String(row[0]).trim();
    const val = String(row[1]).trim();
    if (!key) return;
    if (['LineToken','NotifyEmail','LINE_TOKEN','NOTIFY_EMAIL'].includes(key)) return;
    if (key === 'HospitalName' && val) config.hospitalName = val;
    if (key === 'Destinations'  && val) config.destinations = val.split('\n').map(function(d) { return d.trim(); }).filter(Boolean);
  });

  return { status: 'ok', config: config };
}

/**
 * getInitData — รวม getVehicles + getDrivers + getConfig เป็น 1 call
 * เปิด Spreadsheet ครั้งเดียว ลด API round-trip จาก 3 → 1
 * Frontend cache ผลใน sessionStorage (valid 30 นาที)
 */
function getInitData() {
  return cached_('INIT', 300, getInitDataCompute_);
}

/**
 * getStartMileBootstrap — รวม initData + statusSummary + mileData(limit) เป็น 1 request
 * (เดิมหน้า startmile ยิง 3 request → ตอนนี้ 1 request, ผลแต่ละส่วนถูกแคชแยกกัน)
 */
/**
 * getCheckBootstrap — หน้า check.html: รถ + พขร. + รถที่ตรวจแล้ววันนี้ ใน 1 request
 * (เดิม 3 request โดย getTodayCheckedPlates อ่านหัวชีทซ้ำในลูปทุกแถว)
 */
function getCheckBootstrap() {
  const init = getInitData();
  const sum  = getStatusSummary();
  return {
    status  : 'ok',
    vehicles: init.vehicles || [],
    drivers : init.drivers  || [],
    checked : (sum.todayChecked || [])
  };
}

function getStartMileBootstrap(opts) {
  const lim = Number(opts && opts.limit) > 0 ? Number(opts.limit) : 80;
  return {
    status : 'ok',
    init   : getInitData(),
    summary: getStatusSummary(),
    mile   : getMileData({ limit: lim })
  };
}

function getInitDataCompute_() {
  const ss = getSpreadsheet();

  // ── Vehicles ──
  var vehicles = [];
  try {
    var vSheet = ss.getSheetByName(SHEET_VEHICLE);
    if (vSheet && vSheet.getLastRow() > 1) {
      var vRows = vSheet.getDataRange().getValues();
      var vHdrs = vRows[0];
      vehicles = vRows.slice(1).map(function(row) {
        var obj = {}; vHdrs.forEach(function(h, i) { obj[h] = row[i]; }); return obj;
      }).filter(function(r) { return r['ทะเบียน'] || r['ประเภท']; });
    }
    if (!vehicles.length) vehicles = getDefaultVehicles();
  } catch(e) { vehicles = getDefaultVehicles(); }

  // ── Drivers + Config — เปิด Config sheet ครั้งเดียว ──
  var drivers = [];
  var config  = {
    hospitalName: 'โรงพยาบาลสันทราย',
    destinations: [
      'รพ.นครพิงค์','รพ.สันทราย','รพ.สันป่าตอง','รพ.จอมทอง','รพ.ฝาง',
      'รพ.แม่ริม','รพ.สันกำแพง','รพ.ดอยสะเก็ด','รพ.แม่แตง','รพ.เชียงดาว',
      'รพ.แม่อาย','รพ.ไชยปราการ','รพ.เวียงแหง','รพ.พร้าว','รพ.สะเมิง',
      'รพ.หางดง','รพ.สารภี','รพ.ดอยหล่อ','รพ.อมก๋อย','รพ.กัลยาณิวัฒนา',
      'รพ.แม่วาง','อื่นๆ'
    ]
  };
  try {
    var cfgSheet = ss.getSheetByName(SHEET_CONFIG);
    if (cfgSheet) {
      var cfgRows = cfgSheet.getDataRange().getValues();
      cfgRows.slice(1).forEach(function(row) {
        var key = String(row[0]).trim(), val = String(row[1]).trim();
        if (!key) return;
        if (key === 'Drivers' && val) drivers = val.split('\n').map(function(n){return n.trim();}).filter(Boolean);
        if (['LineToken','NotifyEmail','LINE_TOKEN','NOTIFY_EMAIL'].includes(key)) return;
        if (key === 'HospitalName' && val) config.hospitalName = val;
        if (key === 'Destinations' && val) config.destinations = val.split('\n').map(function(d){return d.trim();}).filter(Boolean);
      });
    }
  } catch(e) {}
  if (!drivers.length) drivers = [
    'นาย ชัยพร มอญแสง','นาย กิตติพงศ์ เขื่อนแก้ว','นาย กานต์นิธิ ทองอร',
    'นาย นพดล คำปินคำ','นาย เก้า พิจิตร',
    'นาย ภาณุพงศ์ กางสำโรง','นาย เฉลิมพล เลาแก้ว','นายชัยพร ชัยศร','นาย ธนวัฒน์ มอญแสง'
  ];

  return { status: 'ok', vehicles: vehicles, drivers: drivers, config: config };
}


/**
 * updateVehicleStatus — อัปเดตสถานะรถใน Vehicles sheet
 * Vehicles columns (0-indexed):
 *   0=ทะเบียน, 1=ประเภท, 2=ผู้รับผิดชอบ, 3=สถานะ,
 *   4=ผู้ขับปัจจุบัน, 5=ปลายทาง, 6=อัปเดตล่าสุด, 7=ประเภทระบบ, 8=หมายเหตุ
 */
// ── FUEL STATION DETECTION ────────────────────────────────────
// ตรวจว่า destination เป็นปั๊มน้ำมันหรือไม่ (รองรับการคีย์หลายรูปแบบ/หลายแบรนด์)
// ครอบคลุม: ชื่อปั๊มท้องถิ่น, แบรนด์ปั๊มหลักทั่วไทย, คำเรียกทั่วไป (ไทย/อังกฤษ),
// ทั้งแบบมีจุด/ไม่มีจุด/มีช่องว่าง/ตัวพิมพ์เล็ก-ใหญ่
const FUEL_STATION_KEYWORDS = [
  // ── ปั๊มท้องถิ่น / ใกล้ รพ.สันทราย ──
  'รวีกาญจน์', 'รวีกาญจน', 'รวีกานต์', 'รวีกาญน์', 'รวีกาญจ',

  // ── แบรนด์ปั๊มน้ำมันหลักในประเทศไทย ──
  'ปตท', 'ptt', 'ป.ต.ท', 'ปตท.',
  'บางจาก', 'bangchak',
  'เชลล์', 'shell',
  'เอสโซ่', 'เอสโซ', 'esso',
  'คาลเท็กซ์', 'คาลเทกซ์', 'caltex', 'คาลเท็ก', 'คาลเทก',
  'ซัสโก้', 'ซัสโก', 'susco',
  'ปิโตรนาส', 'petronas',
  'ไออาร์พีซี', 'irpc',
  'เพียว', 'pure',
  'พีที', 'พี.ที.', // ปั๊ม PT แบบสะกดไทย

  // ── ชื่อปั๊มท้องถิ่นเชียงใหม่ / สันทราย ──
  // หมายเหตุ: เอา 'สหกรณ์' ออกแล้ว เพราะชนกับปลายทางจริง "สหกรณ์" (ที่ พขร. ไปติดต่อราชการ) ทำให้ตรวจจับเติมน้ำมันผิดพลาด
  'โคออบ', 'ปั๊มโก', 'ปั๊มสันทราย', 'ปั๊มสันกำแพง',

  // ── คำทั่วไปที่หมายถึง "ไปปั๊มน้ำมัน / เติมน้ำมัน" ──
  // รองรับการคีย์หลายรูปแบบ ทั้งแบบพิมพ์สระสลับ สะกดต่างกัน
  'ปั๊มน้ำมัน', 'ปั้มน้ำมัน', 'ปั๊มนำ้มัน', 'ปั้มนำ้มัน', // เผื่อพิมพ์สระสลับตำแหน่ง
  'ปั๊มน้ำ', 'ปั้มน้ำ',
  'ปั๊ม', 'ปั้ม',
  'ปั๋ม',                                                   // สำเนียงเหนือ
  'เติมน้ำมัน', 'เติมแก๊ส', 'เติมก๊าซ', 'เติมนำ้มัน',
  'น้ำมัน',                                                 // ปลายทางสั้นว่าแค่ "น้ำมัน"
  'gas station', 'petrol station', 'fuel station', 'pump', 'gasoline', 'gas'
];

// ── คำสั้นที่เสี่ยงชนคำอื่นโดยบังเอิญ (เช่น "pt") ต้องเช็คแบบ word-boundary เท่านั้น ──
const FUEL_STATION_BOUNDARY_KEYWORDS = ['pt'];

// ── OXYGEN TANK CHANGE DETECTION ───────────────────────────────
// ตรวจว่า "ปลายทาง/ภารกิจ" ใน MileLog หมายถึง "ไปเปลี่ยนถังออกซิเจน" หรือไม่
// ใช้คู่กับ getStatusSummary() → oxygenAlerts เพื่อเปลี่ยนสถานะรถ EMS/Refer จาก
// "O₂ ผิดปกติ ต้องเปลี่ยน" → "เปลี่ยนแล้ว" แบบเรียลไทม์ (รูปแบบเดียวกับ isFuelStation)
const OXYGEN_CHANGE_KEYWORDS = ['เปลี่ยนออกซิเจน', 'เปลี่ยนถังออกซิเจน', 'เปลี่ยน o2', 'เปลี่ยนo2'];

function isOxygenChangeMission(destination) {
  if (!destination) return false;
  const raw = String(destination).toLowerCase().replace(/\s+/g, ' ').trim();
  return OXYGEN_CHANGE_KEYWORDS.some(function(kw) { return raw.indexOf(kw.toLowerCase()) >= 0; });
}

function isFuelStation(destination) {
  if (!destination) return false;
  const raw = String(destination);

  // normalize: ตัวพิมพ์เล็กทั้งหมด + ตัดจุด/วงเล็บ/ขีด/ช่องว่างซ้ำ
  const d = raw
    .toLowerCase()
    .replace(/[.\-_()[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // ── ตรวจ keyword หลัก ──
  const hasKeyword = FUEL_STATION_KEYWORDS.some(function(kw) {
    return d.indexOf(kw.toLowerCase()) >= 0;
  });
  if (hasKeyword) return true;

  // ── ตรวจ pattern regex: ปั๊ม/ปั้ม/ปั๋ม + อะไรก็ได้ ──
  if (/ปั[๊้๋]ม/.test(raw)) return true;

  // ── ตรวจ "เติม" + น้ำมัน/แก๊ส/ก๊าซ ──
  if (/เติม.{0,8}(น้.มัน|นำ้มัน|แก๊ส|ก๊าซ|นํ้ามัน|น้ำ)/.test(raw)) return true;

  // ── ตรวจ "น้ำมัน" อย่างเดียวในปลายทางสั้นๆ (max 10 ตัว) ──
  if (raw.trim().length <= 10 && /น้.มัน|นำ้มัน|นํ้ามัน/.test(raw)) return true;

  // เช็คคำสั้นแบบ word-boundary กันชนคำอื่น (เช่น "pt")
  return FUEL_STATION_BOUNDARY_KEYWORDS.some(function(kw) {
    const re = new RegExp('\\b' + kw + '\\b', 'i');
    return re.test(d);
  });
}

function updateVehicleStatus(carType, status, driver, destination) {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_VEHICLE);
    if (!sheet) return;

    const data  = sheet.getDataRange().getValues();
    const plate = (carType || '').split(' ')[0].trim();

    for (let i = 1; i < data.length; i++) {
      const rowPlate = String(data[i][0]).split(' ')[0].trim();
      const rowFull  = String(data[i][0]) + ' ' + String(data[i][1]);
      if (rowPlate === plate || rowFull.includes(plate) || plate.includes(rowPlate)) {
        // col D=4(สถานะ), E=5(ผู้ขับ), F=6(ปลายทาง), G=7(อัปเดต) — 1-indexed
        sheet.getRange(i + 1, 4).setValue(status);
        sheet.getRange(i + 1, 5).setValue(driver      || '');
        sheet.getRange(i + 1, 6).setValue(destination || '');
        sheet.getRange(i + 1, 7).setValue(
          Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm')
        );
        break;
      }
    }
    SpreadsheetApp.flush();
  } catch (err) {
    console.warn('updateVehicleStatus:', err.message);
  }
}

/**
 * fixStaleFuelStatus — เครื่องมือซ่อมข้อมูลครั้งเดียว (one-time data repair)
 * แก้ไขรถที่ค้างสถานะ "เติมน้ำมันแล้ว" จากบั๊กเดิมของ endMile() เวอร์ชันก่อนหน้า
 * ให้กลับเป็น "พร้อมใช้งาน" (1 ใน 4 สถานะมาตรฐานที่ dashboard/startmile/index ต้องใช้)
 *
 * วิธีใช้:
 *   1) เปิด Apps Script editor → เลือกฟังก์ชันนี้จาก dropdown → กด Run (รันครั้งเดียวพอ)
 *   2) หรือเรียกผ่าน URL: GAS_URL?action=fixStaleFuelStatus&apikey=...
 */
function fixStaleFuelStatus() {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_VEHICLE);
    if (!sheet) return { status: 'error', message: 'ไม่พบ Vehicles sheet' };

    const data = sheet.getDataRange().getValues();
    let fixedCount = 0;
    const fixedPlates = [];

    for (let i = 1; i < data.length; i++) {
      const status = String(data[i][3] || '').trim();
      if (status === 'เติมน้ำมันแล้ว') {
        sheet.getRange(i + 1, 4).setValue('พร้อมใช้งาน');
        fixedPlates.push(String(data[i][0] || ''));
        fixedCount++;
      }
    }
    SpreadsheetApp.flush();
    console.log('✅ fixStaleFuelStatus: แก้ไขแล้ว ' + fixedCount + ' คัน (' + fixedPlates.join(', ') + ')');
    return { status: 'ok', fixedCount: fixedCount, fixedPlates: fixedPlates };
  } catch (err) {
    console.error('fixStaleFuelStatus:', err.message);
    return { status: 'error', message: err.message };
  }
}

/**
 * fixFuelStationMarkers — เครื่องมือซ่อมข้อมูลครั้งเดียว (one-time data repair)
 * ─────────────────────────────────────────────────────────────────────────────
 * ปัญหาที่พบ: คอลัมน์ 'ตรวจพบเติมน้ำมัน(ปลายทาง)' ใน MileLog ค้างค่าผิดจากบั๊กเดิมของ
 * endMile() เวอร์ชันก่อนหน้า (และจาก FUEL_STATION_KEYWORDS ที่เพิ่มคำใหม่เข้ามาทีหลัง
 * ทำให้แถวเก่าที่บันทึกไว้ก่อนหน้านั้นไม่เคยถูกคำนวณด้วยรายการคำล่าสุด) ผลคือ:
 *   - บางแถวปลายทางไม่ใช่ปั๊มน้ำมันเลย (เช่น "รพ.สันป่าตอง") แต่ column กลับมีคำว่า
 *     "ใช่ — ปั๊ม PT หน้า รพ." ค้างอยู่ (ข้อความไม่ตรงกับปลายทางจริงของแถวนั้น)
 *   - บางแถวปลายทางเป็นปั๊มน้ำมันจริง (เช่น "ปั๊ม PT หน้า รพ.") แต่ column กลับว่างเปล่า
 * ฟังก์ชันนี้ไล่ทุกแถวที่มี "เวลากลับ" (ทริปปิดงานแล้ว) แล้วคำนวณใหม่จาก "ปลายทาง"
 * ของแถวนั้นเองด้วย isFuelStation() เวอร์ชันล่าสุดเสมอ — เขียนทับ/ล้างค่าให้ตรงความจริง
 *
 * วิธีใช้:
 *   1) เปิด Apps Script editor → เลือกฟังก์ชันนี้จาก dropdown → กด Run (รันครั้งเดียวพอ)
 *   2) หรือเรียกผ่าน URL: GAS_URL?action=fixFuelStationMarkers&apikey=...
 */
function fixFuelStationMarkers() {
  try {
    const ss    = getSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) return { status: 'error', message: 'ไม่พบ MileLog sheet' };

    const data = sheet.getDataRange().getValues();
    const hdrs = data[0];

    const _destCol = hdrs.indexOf('ปลายทาง');
    const _backCol = hdrs.indexOf('เวลากลับ');
    let   _markCol = hdrs.indexOf('ตรวจพบเติมน้ำมัน(ปลายทาง)');

    if (_destCol < 0 || _backCol < 0) {
      return { status: 'error', message: 'ไม่พบคอลัมน์ ปลายทาง หรือ เวลากลับ ใน MileLog' };
    }
    // ถ้ายังไม่มีคอลัมน์ marker เลย ก็ไม่มีอะไรต้องซ่อม
    if (_markCol < 0) {
      return { status: 'ok', message: 'ยังไม่เคยมีคอลัมน์ ตรวจพบเติมน้ำมัน(ปลายทาง) — ไม่มีอะไรต้องแก้', fixedCount: 0 };
    }

    let addedCount   = 0; // แก้จาก "ว่าง" → "ใช่ — ..."
    let clearedCount = 0; // แก้จาก "ใช่ — ..." ผิด → ล้างว่าง
    const details = [];

    for (let i = 1; i < data.length; i++) {
      const destination = String(data[i][_destCol] || '').trim();
      const hasReturned  = String(data[i][_backCol] || '').trim() !== '';
      if (!hasReturned) continue; // ทริปยังไม่ปิดงาน ไม่ต้องยุ่ง

      const currentMark = String(data[i][_markCol] || '').trim();
      const shouldMark   = isFuelStation(destination);
      const correctValue = shouldMark ? ('ใช่ — ' + destination) : '';

      if (currentMark !== correctValue) {
        sheet.getRange(i + 1, _markCol + 1).setValue(correctValue);
        if (correctValue && !currentMark) addedCount++;
        else if (!correctValue && currentMark) clearedCount++;
        details.push({
          row: i + 1,
          tripId: String(data[i][0] || ''),
          destination: destination,
          before: currentMark,
          after: correctValue
        });
      }
    }

    SpreadsheetApp.flush();
    console.log('✅ fixFuelStationMarkers: เพิ่ม marker ที่ขาด ' + addedCount + ' แถว, ล้าง marker ที่ผิด ' + clearedCount + ' แถว');
    return {
      status: 'ok',
      addedCount: addedCount,
      clearedCount: clearedCount,
      totalFixed: addedCount + clearedCount,
      details: details
    };
  } catch (err) {
    console.error('fixFuelStationMarkers:', err.message);
    return { status: 'error', message: err.message };
  }
}

/**
 * updateVehicleStatusFromDash — รับจาก dashboard (ผู้บริหารแก้สถานะ)
 * payload: { carType, status, updatedBy, reason }
 *
 * 🔒 ข้อจำกัดความปลอดภัย:
 *   - เปลี่ยนสถานะได้เฉพาะรถที่ระบุใน carType เท่านั้น (1 คัน)
 *   - ไม่สามารถรีเซตรถทุกคันพร้อมกันได้จากฟังก์ชันนี้
 *   - บันทึก reason + updatedBy + timestamp ลง col หมายเหตุ (col 9)
 */
function updateVehicleStatusFromDash(payload) {
  if (!payload || !payload.carType || !payload.status) {
    return { status: 'error', message: 'ข้อมูลไม่ครบ (ต้องการ carType และ status)' };
  }

  // ป้องกัน carType ว่าง หรือเป็น wildcard
  const carType = String(payload.carType).trim();
  if (!carType || carType === '*' || carType === 'all' || carType === 'ทุกคัน') {
    return { status: 'error', message: 'ไม่อนุญาตให้เปลี่ยนสถานะรถหลายคันพร้อมกันจาก dashboard' };
  }

  const allowed = ['พร้อมใช้งาน', 'กำลังใช้งาน', 'รอตรวจสภาพรถ', 'รอซ่อม'];
  if (!allowed.includes(payload.status)) {
    return { status: 'error', message: 'สถานะไม่ถูกต้อง: ' + payload.status };
  }

  try {
    const ss     = getSpreadsheet();
    const sheet  = ss.getSheetByName(SHEET_VEHICLE);
    if (!sheet) return { status: 'error', message: 'ไม่พบ sheet Vehicles' };

    const data   = sheet.getDataRange().getValues();
    const plate  = carType.split(' ')[0].trim();
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
    const reason = String(payload.reason || '').trim();
    const by     = String(payload.updatedBy || 'ผู้บริหาร').trim();

    let updated = false;

    for (let i = 1; i < data.length; i++) {
      const rowPlate = String(data[i][0]).split(' ')[0].trim();
      const rowFull  = String(data[i][0]) + ' ' + String(data[i][1]);

      // match เฉพาะคันนี้เท่านั้น — หยุด break ทันที ไม่แตะคันอื่น
      if (rowPlate === plate || rowFull.includes(plate) || plate.includes(rowPlate)) {
        sheet.getRange(i + 1, 4).setValue(payload.status);
        sheet.getRange(i + 1, 5).setValue(payload.status === 'พร้อมใช้งาน' ? '' : by);
        sheet.getRange(i + 1, 6).setValue('');
        sheet.getRange(i + 1, 7).setValue(nowStr);
        // col I (9) = หมายเหตุ: บันทึก reason + ผู้แก้ไข + เวลา
        const noteVal = '[' + nowStr + '] ' + by + ': ' + payload.status + (reason ? ' — ' + reason : '');
        sheet.getRange(i + 1, 9).setValue(noteVal);
        updated = true;
        break; // ✅ หยุดทันที ไม่แตะคันอื่นเด็ดขาด
      }
    }

    SpreadsheetApp.flush();

    if (!updated) {
      return { status: 'error', message: 'ไม่พบรถ: ' + carType + ' ใน Vehicles sheet' };
    }

    console.log('updateVehicleStatusFromDash OK plate=' + plate + ' -> ' + payload.status + ' by=' + by);
    return {
      status   : 'ok',
      message  : 'อัปเดตสถานะ "' + payload.status + '" เรียบร้อยแล้ว',
      carType  : carType,
      updatedAt: nowStr
    };
  } catch(err) {
    console.error('updateVehicleStatusFromDash error:', err);
    return { status: 'error', message: err.message };
  }
}

function getDefaultVehicles() {
  return [
    { ทะเบียน:'นง.8781 ชม.', ประเภท:'รถตู้ฮุนได',        ผู้รับผิดชอบ:'นายภาณุพงศ์ กางสำโรง',  สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'ทั่วไป' },
    { ทะเบียน:'นง.86 ชม.',   ประเภท:'รถตู้',             ผู้รับผิดชอบ:'นายคมสันต์ ภายไธสงค์',   สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'ทั่วไป' },
    { ทะเบียน:'จย.1379 ชม.', ประเภท:'รถ Refer',           ผู้รับผิดชอบ:'นายชัยพร มอญแสง',        สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'EMS' },
    { ทะเบียน:'งบ.5466 ชม.', ประเภท:'รถ Refer',           ผู้รับผิดชอบ:'นายนพดล คำปินคำ',        สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'EMS' },
    { ทะเบียน:'ขษ.4361 ชม.', ประเภท:'รถ Refer',           ผู้รับผิดชอบ:'นายกิติพงศ์ เขื่อนแก้ว', สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'EMS' },
    { ทะเบียน:'ขร.501 ชม.',  ประเภท:'รถ Refer',           ผู้รับผิดชอบ:'นายธนวัฒน์ มอญแสง', สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'EMS' },
    { ทะเบียน:'ขธ.9302 ชม.', ประเภท:'รถปิ๊กอัพ 4 ประตู', ผู้รับผิดชอบ:'นายชัยพร ชัยศร',         สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'ทั่วไป' },
    { ทะเบียน:'ขฉ.8407 ชม.', ประเภท:'รถ Refer',           ผู้รับผิดชอบ:'นายกานต์นิธิ ทองอร',     สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'EMS' },
    { ทะเบียน:'ขค.9662 ชม.', ประเภท:'รถปิ๊กอัพ 4 ประตู', ผู้รับผิดชอบ:'นายเก้า พิจิตร',          สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'ทั่วไป' },
    { ทะเบียน:'กล.9438 ชม.', ประเภท:'รถปิ๊กอัพ 4 ประตู', ผู้รับผิดชอบ:'นายเฉิมพล เลาแก้ว',     สถานะ:'พร้อมใช้งาน', ประเภทระบบ:'ทั่วไป' }
  ];
}

// ════════════════════════════════════════════════════════════
//  เพิ่ม พขร. ใหม่ — นายธนวัฒน์ มอญแสง (ผู้รับผิดชอบรถ ขร.501 ชม. / ตรวจสภาพรถ)
//  ข้อมูลจริงอยู่ในชีท (Vehicles / Config / ตารางเวร) ไม่ใช่ใน code
//  → แก้ค่าเริ่มต้นใน code อย่างเดียวไม่พอ ต้อง "รันครั้งเดียว": addDriverThanawat() จาก Apps Script editor
//  รันซ้ำได้ปลอดภัย (ตรวจชื่อซ้ำก่อนเขียนทุกจุด) — ไม่ใส่ชื่อเล่น/เบอร์โทร (ยังไม่ทราบ) ให้กรอกเองในชีท "ตารางเวร"
// ════════════════════════════════════════════════════════════
function addDriverThanawat() {
  return addDriverToAllSheets_('นายธนวัฒน์ มอญแสง', 'ขร.501');
}

function addDriverToAllSheets_(fullName, plateKey) {
  var norm = function (s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); };
  var target = norm(fullName);
  var ss = getSpreadsheet();
  var report = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // 1) Vehicles — ตั้ง "ผู้รับผิดชอบ" ของรถทะเบียน plateKey
    var vs = ss.getSheetByName(SHEET_VEHICLE);
    if (vs && vs.getLastRow() > 1) {
      var vd = vs.getDataRange().getValues();
      var hd = vd[0].map(function (h) { return String(h).trim(); });
      var cPlate = hd.indexOf('ทะเบียน'), cOwner = hd.indexOf('ผู้รับผิดชอบ');
      if (cPlate < 0 || cOwner < 0) {
        report.push('Vehicles: ไม่พบหัวคอลัมน์ ทะเบียน/ผู้รับผิดชอบ — ข้าม');
      } else {
        var found = false;
        for (var r = 1; r < vd.length; r++) {
          if (norm(vd[r][cPlate]).indexOf(norm(plateKey)) !== 0) continue;
          found = true;
          if (norm(vd[r][cOwner]) === target) { report.push('Vehicles: ' + vd[r][cPlate] + ' มีชื่อนี้อยู่แล้ว'); }
          else {
            vs.getRange(r + 1, cOwner + 1).setValue(fullName);
            report.push('Vehicles: ตั้งผู้รับผิดชอบ ' + vd[r][cPlate] + ' = ' + fullName + (vd[r][cOwner] ? ' (เดิม: ' + vd[r][cOwner] + ')' : ''));
          }
        }
        if (!found) report.push('Vehicles: ไม่พบรถทะเบียน ' + plateKey + ' — ข้าม');
      }
    } else {
      report.push('Vehicles: ไม่มีชีท/ข้อมูล — ข้าม (ระบบจะใช้ getDefaultVehicles ซึ่งแก้แล้ว)');
    }

    // 2) Config → Drivers (รายชื่อ dropdown ทุกหน้า)
    var cs = ss.getSheetByName(SHEET_CONFIG);
    if (cs) {
      var cd = cs.getDataRange().getValues(), drvRow = -1;
      for (var i = 1; i < cd.length; i++) { if (String(cd[i][0]).trim() === 'Drivers') { drvRow = i; break; } }
      if (drvRow < 0) {
        report.push('Config: ไม่มีแถว Drivers — ข้าม (ระบบใช้รายชื่อเริ่มต้นซึ่งแก้แล้ว)');
      } else {
        var names = String(cd[drvRow][1]).split('\n').map(function (n) { return n.trim(); }).filter(Boolean);
        if (names.some(function (n) { return norm(n) === target; })) report.push('Config Drivers: มีชื่อนี้อยู่แล้ว');
        else { names.push(fullName); cs.getRange(drvRow + 1, 2).setValue(names.join('\n')); report.push('Config Drivers: เพิ่มชื่อแล้ว'); }
      }
    } else {
      report.push('Config: ไม่พบชีท — ข้าม');
    }

    // 3) ตารางเวร (เดือนนี้ + เดือนถัดไป) — เพิ่มแถวพนักงาน (ช่องเวรเว้นว่าง) และขยายสูตร "รวมเวร"
    [SHEET_WORKTABLE, SHEET_WORKTABLE_NEXT].forEach(function (shName) {
      var sh = ss.getSheetByName(shName);
      if (!sh) { report.push(shName + ': ไม่พบชีท — ข้าม'); return; }
      var data = sh.getDataRange().getValues();
      var hdr = -1, colName = 0;
      for (var h = 0; h < Math.min(12, data.length) && hdr < 0; h++) {
        for (var c = 0; c < Math.min(4, data[h].length); c++) {
          if (norm(data[h][c]).indexOf('ชื่อ-สกุล') === 0 || norm(data[h][c]) === 'ชื่อสกุล') { hdr = h; colName = c; break; }
        }
      }
      if (hdr < 0) { hdr = 2; colName = 0; }
      var lastStaff = -1, placeholder = -1, totalIdx = -1, exists = false;
      for (var rr = hdr + 1; rr < data.length; rr++) {
        var nm = String(data[rr][colName] == null ? '' : data[rr][colName]).trim();
        if (!nm) continue;
        if (nm.indexOf('รวม') === 0) { totalIdx = rr; break; }
        if (nm.indexOf('หมายเหตุ') === 0) continue;
        if (norm(nm) === target) exists = true;
        if (norm(nm) === norm('พขร.ใหม่')) placeholder = rr;
        lastStaff = rr;
      }
      if (exists) { report.push(shName + ': มีชื่อนี้อยู่แล้ว'); return; }
      var newRow; // 1-based
      if (placeholder >= 0) {
        newRow = placeholder + 1;
        sh.getRange(newRow, colName + 1).setValue(fullName);
        report.push(shName + ': ใส่ชื่อแทนแถว "พขร.ใหม่" (แถว ' + newRow + ')');
      } else {
        var after = (lastStaff >= 0 ? lastStaff : hdr) + 1; // แถว 1-based ของพนักงานคนสุดท้าย
        sh.insertRowAfter(after);
        newRow = after + 1;
        sh.getRange(newRow, colName + 1).setValue(fullName);
        report.push(shName + ': เพิ่มแถวใหม่ (แถว ' + newRow + ')');
      }
      // ขยายสูตร "รวมเวร" ให้ครอบคลุมแถวใหม่ (เช่น COUNTA(E4:E12) → COUNTA(E4:E13))
      var tRow = -1, lastRow = sh.getLastRow();
      for (var q = newRow + 1; q <= lastRow; q++) {
        if (String(sh.getRange(q, colName + 1).getValue()).trim().indexOf('รวม') === 0) { tRow = q; break; }
      }
      if (tRow > 0) {
        var rng = sh.getRange(tRow, 1, 1, sh.getLastColumn());
        var fs = rng.getFormulas()[0], first = hdr + 2, changed = 0;
        for (var k = 0; k < fs.length; k++) {
          if (!fs[k]) continue;
          var nf = fs[k].replace(/([A-Z]+)(\d+):([A-Z]+)(\d+)/g, function (m, a, r1, b, r2) {
            return (Number(r1) === first && Number(r2) >= newRow - 1 && Number(r2) < newRow) ? a + r1 + ':' + b + newRow : m;
          });
          if (nf !== fs[k]) { sh.getRange(tRow, k + 1).setFormula(nf); changed++; }
        }
        if (changed) report.push(shName + ': ขยายสูตรรวมเวร ' + changed + ' ช่อง');
      }
    });

    SpreadsheetApp.flush();
    try { invalidateDataCache_(); } catch (e1) {}
  } finally {
    lock.releaseLock();
  }
  report.forEach(function (l) { console.log(l); });
  return { status: 'ok', fullName: fullName, report: report };
}

// ════════════════════════════════════════════════════════════
//  SECTION 6: Anomaly & Notifications
// ════════════════════════════════════════════════════════════

function detectMileAnomaly(tripRow, odomEnd, distance) {
  const odomStart = Number(tripRow[7]) || 0;
  if (odomEnd < odomStart) {
    return { type:'ODOMETER_REVERSE',
             message:'เลขไมล์ปลาย (' + odomEnd + ') น้อยกว่าเลขไมล์ต้น (' + odomStart + ')',
             carType:tripRow[4], driver:tripRow[5] };
  }
  if (distance > 500) {
    return { type:'HIGH_DISTANCE',
             message:'ระยะทางสูงผิดปกติ: ' + distance + ' กม.',
             carType:tripRow[4], driver:tripRow[5] };
  }
  return null;
}

function notifyAnomaly(anomaly) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail({
      to     : NOTIFY_EMAIL,
      subject: '[Fleet Alert] ' + anomaly.type + ' — ' + anomaly.carType,
      body   : 'พบความผิดปกติ\nรถ: ' + anomaly.carType + '\nพนักงาน: ' + anomaly.driver + '\n' + anomaly.message
    });
  } catch (err) { console.warn('notifyAnomaly:', err.message); }
}

function sendEMSAlert(payload, failItems) {
  const subject = '[EMS Alert] อุปกรณ์ไม่พร้อม ' + failItems.length + ' รายการ — ' + payload.carId;
  let body = 'รถ: ' + payload.carId + '\nผู้ตรวจ: ' + payload.checkerName + '\n\nอุปกรณ์ที่มีปัญหา:\n';
  failItems.forEach(function(it) {
    body += '• ' + it.name + ' — ' + it.status + (it.note ? ' (' + it.note + ')' : '') + '\n';
  });
  if (NOTIFY_EMAIL) {
    try { MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: subject, body: body }); }
    catch (err) { console.warn('EMS alert:', err.message); }
  }
  if (LINE_TOKEN) sendLineNotify(body);
}

function checkExpiredItems(payload, items) {
  const today    = new Date();
  const warnDays = 30;
  const expiring = items.filter(function(it) {
    if (!it.expDate) return false;
    const exp  = new Date(it.expDate);
    const diff = (exp - today) / 86400000;
    return diff >= 0 && diff <= warnDays;
  });
  if (expiring.length > 0 && NOTIFY_EMAIL) {
    let body = 'อุปกรณ์ใกล้หมดอายุ (' + expiring.length + ' รายการ):\n';
    expiring.forEach(function(it) {
      body += '• ' + it.name + ' หมดอายุ: ' + it.expDate + '\n';
    });
    try { MailApp.sendEmail({ to: NOTIFY_EMAIL, subject: '[EMS] อุปกรณ์ใกล้หมดอายุ', body: body }); }
    catch (err) { console.warn('expiry alert:', err.message); }
  }
}

function sendLineNotify(msg) {
  if (!LINE_TOKEN) return;
  try {
    UrlFetchApp.fetch('https://notify-api.line.me/api/notify', {
      method     : 'post',
      headers    : { 'Authorization': 'Bearer ' + LINE_TOKEN },
      payload    : { message: msg },
      muteHttpExceptions: true
    });
  } catch (err) { console.warn('LINE notify:', err.message); }
}

// ════════════════════════════════════════════════════════════
//  SECTION 7: Utilities
// ════════════════════════════════════════════════════════════

function parseDateToYMD(val) {
  if (!val && val !== 0) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  if (typeof val === 'number' && val > 40000) {
    const d = new Date(Date.UTC(1899, 11, 30) + val * 86400000);
    return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(s)) {
    const p = s.slice(0, 10).split('/');
    return p[2] + '-' + p[1] + '-' + p[0];
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s.slice(0, 10);
}

function getSpreadsheet() {
  if (SS_ID) return SpreadsheetApp.openById(SS_ID);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
    const r = sheet.getRange(1, 1, 1, headers.length);
    r.setBackground('#0a2540');
    r.setFontColor('#ffffff');
    r.setFontWeight('bold');
    r.setHorizontalAlignment('center');
    sheet.setColumnWidths(1, headers.length, 140);
  }
  return sheet;
}

function getOrCreateSubFolder(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function formatThaiDate(d) {
  return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
}
function formatTime(d) {
  return Utilities.formatDate(d, 'Asia/Bangkok', 'HH:mm');
}
function formatDisplayDate(val) {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  try { return Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'); }
  catch (_) { return String(val); }
}

/**
 * formatTimeCell — แปลง cell ที่เป็น Time-only (หรือ Date จาก GAS) → "HH:mm:ss"
 * แก้ปัญหา GAS อ่าน Time cell แล้วได้ Date ฐาน 1899-12-30
 */
function formatTimeCell(val) {
  if (!val) return '';
  if (val instanceof Date) {
    try { return Utilities.formatDate(val, 'Asia/Bangkok', 'HH:mm:ss'); }
    catch (_) { return String(val); }
  }
  // ถ้าเป็น string ที่มี 1899 ให้ดึงเฉพาะเวลา
  const s = String(val);
  const m = s.match(/(\d{2}:\d{2}(?::\d{2})?)/);
  return m ? m[1] : s;
}

/**
 * headerToKey — Thai header → camelCase key ที่ frontend ใช้
 * ต้องตรงกับ Dashboard STATUS_KEYS และ renderRecentRecords
 */
function headerToKey(h) {
  const map = {
    // ── Timestamp / ลำดับ ──
    'Timestamp'              : 'timestamp',
    'timestamp'              : 'timestamp',
    'ลำดับ'                  : '_rowNum',       // col A ในชีทจริง (ไม่ใช้)
    // ── วันที่ / เวลา ──
    'วันที่'                 : 'inspDate',
    'เวลา'                   : 'inspTime',
    // ── ทะเบียน / ผู้ตรวจ ──
    'ทะเบียน/ประเภทรถ'      : 'carType',
    'ทะเบียน/รถ'             : 'carType',       // ← header จริงในชีท
    'พนักงานขับรถ'           : 'driverName',
    'ผู้ตรวจ'                : 'driverName',    // ← header จริงในชีท CheckLog
    // ── ไมล์ ──
    'เลขไมล์'               : 'odometer',
    'ไมล์'                   : 'odometer',      // ← header จริงในชีท CheckLog
    // ── อุปกรณ์ ──
    'น้ำมันเครื่อง'          : 'eq_oil',
    'กระจกมองข้าง'           : 'eq_oil',       // ← header จริงในชีท (col 6 = กระจกมองข้าง mapping → eq_oil ตาม saveCheck)
    'แบตเตอรี่'              : 'eq_battery',
    'ระบบเบรค'               : 'eq_battery',   // ← header จริงในชีท (col 7 = ระบบเบรค mapping → eq_battery)
    'ยาง'                    : 'eq_tire',
    'น้ำในหม้อน้ำ'           : 'eq_tire',      // ← header จริงในชีท (col 8 = น้ำในหม้อน้ำ mapping → eq_tire)
    'ยางรถยนต์'              : 'eq_tire',      // ← col 24 ยางรถยนต์
    // ── น้ำมัน ──
    'ระดับน้ำมันเชื้อเพลิง' : 'fuelLevel',
    'ระดับน้ำมันเครื่อง'    : 'fuelLevel',     // ← col 10 ในชีทจริง
    'ปริมาณน้ำมัน'           : 'fuelLevel',     // ← col 20 ในชีทจริง
    'เติมน้ำมัน'             : 'fuelFill',
    'การเติมน้ำมัน'          : 'fuelFill',      // ← col 21 ในชีทจริง
    // ── รายการตรวจ (ชีทจริง col ตรงตามที่บันทึก) ──
    'กระจก'                  : 'chk_mirror',
    'เบรค'                   : 'chk_brake',
    'น้ำหม้อน้ำ'             : 'chk_coolant',
    'ช่วงล่าง'               : 'chk_suspension',
    'ระดับน้ำมันเครื่อง 2'  : 'chk_oilLevel',
    'ระดับน้ำมันเครื่อง2'   : 'chk_oilLevel',
    'ลมยาง'                  : 'chk_tirePressure',
    'ไฟหน้า'                 : 'chk_headlight',
    'ไฟท้าย'                 : 'chk_taillight',
    'ไฟท้าย/ไฟเบรค'          : 'chk_taillight', // ← header จริงในชีท
    'ไฟถอย'                  : 'chk_reverseLight',
    'แตร'                    : 'chk_horn',
    'เสียงแตร'               : 'chk_horn',      // ← header จริงในชีท
    'ที่ปัดน้ำฝน'            : 'chk_wiper',
    'แอร์'                   : 'chk_aircon',
    'เครื่องปรับอากาศ'       : 'chk_aircon',    // ← header จริงในชีท
    'ความสะอาดนอก'           : 'chk_exteriorClean',
    'ความสะอาดภายนอก'        : 'chk_exteriorClean', // ← header จริงในชีท
    'ความสะอาดใน'            : 'chk_interiorClean',
    'ความสะอาดภายใน'         : 'chk_interiorClean', // ← header จริงในชีท
    // ── หมายเหตุ / รูป ──
    'หมายเหตุ'               : 'remarks',
    'มีรูปแนบ'               : 'hasPhotos',
    'รูปถ่าย'                : 'hasPhotos',     // ← header จริงในชีท
    'DriveLinks'             : 'driveLinks',
    'DriveLinks_URLs'        : 'driveLinksUrls',
    // ── EMS / Refer fields ──
    'ระดับ O₂ (PSI)'         : 'chk_o2Level',
    'แสงไฟฉุกเฉิน'           : 'chk_emergencyLight',
    'เสียงไซเรน'              : 'chk_siren',
    'เปลและระบบล็อกเปล'       : 'chk_stretcherLock',
    'เครื่อง Suction'         : 'chk_suction',
    'AED/Defibrillator'       : 'chk_aed'
  };
  return map[h] !== undefined ? map[h] : h;
}

// ════════════════════════════════════════════════════════════
//  SECTION 8: Initialize / Setup (รันจาก GAS Editor)
// ════════════════════════════════════════════════════════════

const EXPECTED_HEADERS = {
  CheckLog: [
    'Timestamp','วันที่','เวลา','ทะเบียน/ประเภทรถ','พนักงานขับรถ',
    'เลขไมล์','น้ำมันเครื่อง','แบตเตอรี่','ยาง',
    'ระดับน้ำมันเชื้อเพลิง','เติมน้ำมัน',
    'กระจก','เบรค','น้ำหม้อน้ำ','ช่วงล่าง','ระดับน้ำมันเครื่อง2',
    'ลมยาง','ไฟหน้า','ไฟท้าย','ไฟถอย','แตร','ที่ปัดน้ำฝน','แอร์',
    'ความสะอาดนอก','ความสะอาดใน','หมายเหตุ','มีรูปแนบ','DriveLinks','DriveLinks_URLs',
    'ระดับ O₂ (PSI)','แสงไฟฉุกเฉิน','เสียงไซเรน',
    'เปลและระบบล็อกเปล','เครื่อง Suction','AED/Defibrillator'
  ],
  MileLog: [
    // ชีทจริงมี header เหล่านี้ (ลำดับและชื่อตรงจากการตรวจสอบ):
    'ลำดับ','รหัสทริป','วันที่','เวลาออก','ทะเบียน/รถ','พนักงานขับรถ',
    'ปลายทาง','ไมล์เริ่มต้น','ไมล์สิ้นสุด','ระยะทาง(กม.)',
    'เวลากลับ','ผู้โดยสาร','น้ำมันที่เติม(ลิตร)','ราคาน้ำมัน','หมายเหตุ','รูปบิลน้ำมัน',
    'รูปบิลน้ำมันขากลับ','timestamp','รูปบิลน้ำมันขากลับ'
  ],
  EMSLog: [
    'Timestamp','วันที่','เวลา','รถ EMS','ผู้ตรวจ',
    'รหัสอุปกรณ์','ชื่ออุปกรณ์','หมวด','สถานะ','วันหมดอายุ','หมายเหตุ',
    'ผลรวม','ผ่าน','ไม่ผ่าน/ขาด/ชำรุด'
  ],
  Vehicles: [
    'ทะเบียน','ประเภท','ผู้รับผิดชอบ','สถานะ',
    'ผู้ขับปัจจุบัน','ปลายทาง','อัปเดตล่าสุด','ประเภทระบบ','หมายเหตุ'
  ],
  Config: ['Key','Value','Description']
};

function setupSheet() {
  console.log('=== setupSheet เริ่มต้น ===');
  const ss = getSpreadsheet();

  Object.entries(EXPECTED_HEADERS).forEach(function([name, headers]) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
      const r = sheet.getRange(1, 1, 1, headers.length);
      r.setBackground('#0a2540'); r.setFontColor('#ffffff'); r.setFontWeight('bold');
      console.log('✅ สร้าง sheet: ' + name);
    } else {
      // ซ่อม header ถ้าไม่ตรง
      const cur = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), headers.length)).getValues()[0];
      headers.forEach(function(exp, i) {
        if (String(cur[i] || '').trim() !== exp) {
          sheet.getRange(1, i + 1).setValue(exp);
          console.log('🔧 ' + name + ' col' + (i+1) + ': fix → ' + exp);
        }
      });
    }
  });

  // Seed Vehicles ถ้าว่าง
  const vSheet = ss.getSheetByName('Vehicles');
  if (vSheet && vSheet.getLastRow() <= 1) {
    getDefaultVehicles().forEach(function(v) {
      vSheet.appendRow([
        v['ทะเบียน'], v['ประเภท'], '', 'พร้อมใช้งาน', '', '', '', v['ประเภทระบบ'], ''
      ]);
    });
  }

  // Seed Config ถ้าว่าง
  const cfgSheet = ss.getSheetByName('Config');
  if (cfgSheet && cfgSheet.getLastRow() <= 1) {
    [
      ['HospitalName','โรงพยาบาลสันทราย','ชื่อโรงพยาบาล'],
      ['Drivers',
       'นาย ชัยพร มอญแสง\nนาย กิตติพงศ์ เขื่อนแก้ว\nนาย กานต์นิธิ ทองอร\nนาย นพดล คำปินคำ\nนาย เก้า พิจิตร\nนาย ภาณุพงศ์ กางสำโรง\nนาย เฉลิมพล เลาแก้ว\nนายชัยพร ชัยศร\nนาย ธนวัฒน์ มอญแสง\n',
       'รายชื่อพนักงาน'],
      ['LineToken','','LINE Notify Token'],
      ['NotifyEmail','','Email แจ้งเตือน']
    ].forEach(function(r) { cfgSheet.appendRow(r); });
  }

  SpreadsheetApp.flush();
  console.log('=== setupSheet เสร็จสิ้น ===');
  return { status: 'ok', message: 'Setup เสร็จสิ้น' };
}
function fixDriveFolder() {
  // สร้าง folder ใหม่ใน My Drive แล้วคืน ID มาให้ copy ใส่ DRIVE_FOLDER
  const folder = DriveApp.createFolder('FleetPhotos_สันทราย');
  console.log('New folder ID:', folder.getId());
  console.log('URL:', folder.getUrl());
}
// ════════════════════════════════════════════════════════════
//  SECTION 8b: จุดหมายปลายทาง (Location Pins) — routemap.html
//  ใช้ทำแผนที่ความถี่จุดหมาย: อ่าน "ปลายทาง" ที่มีอยู่แล้วใน MileLog
//  แล้วผูกกับพิกัด lat/lng ที่ผู้ใช้ปักหมุดไว้ครั้งเดียว (เก็บในชีต Locations)
// ════════════════════════════════════════════════════════════

const LOCATIONS_HEADERS = ['ชื่อจุดหมาย', 'ละติจูด', 'ลองจิจูด', 'ปักหมุดโดย', 'วันที่ปักหมุด'];

/** getLocationPins — คืนรายการจุดหมายที่ปักหมุดพิกัดไว้แล้วทั้งหมด */
function getLocationPins() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_LOCATIONS);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { status: 'ok', data: [] };
  }
  const rows = sheet.getDataRange().getValues();
  const data = rows.slice(1)
    .filter(function(r) { return String(r[0] || '').trim(); })
    .map(function(r) {
      return {
        name: String(r[0] || '').trim(),
        lat: Number(r[1]) || null,
        lng: Number(r[2]) || null,
        pinnedBy: String(r[3] || ''),
        pinnedAt: String(r[4] || '')
      };
    })
    .filter(function(p) { return p.lat !== null && p.lng !== null; });
  return { status: 'ok', data: data };
}

/**
 * saveLocationPin — บันทึก/แก้ไขพิกัดของจุดหมายปลายทาง (upsert ด้วยชื่อ)
 * payload: { name, lat, lng, pinnedBy }
 */
function saveLocationPin(payload) {
  const name = String(payload.name || '').trim();
  const lat  = Number(payload.lat);
  const lng  = Number(payload.lng);
  if (!name) return { status: 'error', message: 'ไม่มีชื่อจุดหมาย' };
  if (isNaN(lat) || isNaN(lng)) return { status: 'error', message: 'พิกัดไม่ถูกต้อง' };

  const ss    = getSpreadsheet();
  const sheet = getOrCreateSheet(ss, SHEET_LOCATIONS, LOCATIONS_HEADERS);
  const now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  const pinnedBy = String(payload.pinnedBy || '').trim();

  // upsert: หาแถวที่ชื่อจุดหมายตรงกันก่อน (ไม่สนตัวพิมพ์เล็กใหญ่/เว้นวรรคหัวท้าย)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < names.length; i++) {
      if (String(names[i][0] || '').trim() === name) {
        const rowIdx = i + 2; // 1-indexed + header row
        sheet.getRange(rowIdx, 1, 1, 5).setValues([[name, lat, lng, pinnedBy, now]]);
        return { status: 'ok', updated: true };
      }
    }
  }
  sheet.appendRow([name, lat, lng, pinnedBy, now]);
  return { status: 'ok', updated: false };
}

/** deleteLocationPin — ลบหมุดที่ปักผิด (payload: { name }) */
function deleteLocationPin(payload) {
  const name = String(payload.name || '').trim();
  if (!name) return { status: 'error', message: 'ไม่มีชื่อจุดหมาย' };
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_LOCATIONS);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', deleted: false };
  const lastRow = sheet.getLastRow();
  const names = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0] || '').trim() === name) {
      sheet.deleteRow(i + 2);
      return { status: 'ok', deleted: true };
    }
  }
  return { status: 'ok', deleted: false };
}

// ════════════════════════════════════════════════════════════
//  SECTION 9: ระบบแจ้งซ่อมยานพาหนะ (fixedcar.html)
// ════════════════════════════════════════════════════════════

const SHEET_REPAIR = 'RepairLog';

const REPAIR_HEADERS = [
  'RepairID','Timestamp','วันที่แจ้ง','ทะเบียนรถ',
  'แจ้งซ่อมไปยัง','ชื่อสถานที่','ความเร่งด่วน',
  'วันนัดหมาย','วันเข้าซ่อม','วันนัดรับ','วันซ่อมเสร็จ',
  'อาการ','รายการซ่อม',
  'ผู้ส่งซ่อม','เบอร์โทรผู้ส่ง',
  'ผู้รับรถออก','เบอร์โทรผู้รับ',
  'ค่าซ่อม(บาท)','สถานะ','หมายเหตุ','PhotoUrls','UpdatedAt'
];

function generateRepairId(sheet) {
  var today  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd');
  var prefix = 'RPR-' + today + '-';
  var maxSeq = 0;
  if (sheet.getLastRow() > 1) {
    var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();
    ids.forEach(function(row) {
      var id = String(row[0] || '');
      if (id.startsWith(prefix)) {
        var seq = parseInt(id.slice(prefix.length), 10) || 0;
        if (seq > maxSeq) maxSeq = seq;
      }
    });
  }
  return prefix + String(maxSeq + 1).padStart(3, '0');
}

function saveRepair(payload) {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_REPAIR, REPAIR_HEADERS);
  var repairId = generateRepairId(sheet);
  var now      = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  var itemsList = '';
  if (Array.isArray(payload.repairItems)) {
    itemsList = payload.repairItems.filter(function(x){ return x && String(x).trim(); }).join('\n');
  } else if (payload.repairItems) {
    itemsList = String(payload.repairItems);
  }

  // รวม photoUrls จาก frontend (อัปโหลดสำเร็จก่อน submit)
  var photoUrlList = '';
  if (Array.isArray(payload.photoUrls) && payload.photoUrls.length > 0) {
    photoUrlList = payload.photoUrls.filter(function(u){ return u && String(u).trim(); }).join('\n');
  }

  var row = [
    repairId,
    now,
    payload.reportDate     || '',
    payload.carPlate       || '',
    payload.repairDest     || '',
    payload.repairDestName || '',
    payload.urgency        || '',
    payload.appointDate    || '',
    payload.repairInDate   || '',
    payload.pickupDate     || '',
    payload.repairDoneDate || '',
    payload.symptom        || '',
    itemsList,
    payload.senderName     || '',
    payload.senderPhone    || '',
    payload.receiverName   || '',
    payload.receiverPhone  || '',
    payload.cost           || '',
    payload.status         || 'รออนุมัติ',
    payload.repairRemarks  || '',
    photoUrlList,                          // col 21: PhotoUrls
    now                                    // col 22: UpdatedAt
  ];

  sheet.appendRow(row);
  SpreadsheetApp.flush();
  console.log('saveRepair OK id=' + repairId + ' plate=' + (payload.carPlate||''));

  try {
    var urg = payload.urgency || '';
    if ((urg === 'ด่วนมาก' || urg === 'เร่งด่วนพิเศษ') && NOTIFY_EMAIL) {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: '[แจ้งซ่อม ' + urg + '] ' + (payload.carPlate||'') + ' — ' + repairId,
        body: 'ใบแจ้งซ่อม: ' + repairId + '\nทะเบียน: ' + (payload.carPlate||'-')
            + '\nส่งซ่อมที่: ' + (payload.repairDest||'-') + (payload.repairDestName ? ' — '+payload.repairDestName : '')
            + '\nอาการ: ' + (payload.symptom||'-') + '\nผู้แจ้ง: ' + (payload.senderName||'-')
      });
    }
    if (LINE_TOKEN) {
      sendLineNotify('[แจ้งซ่อม] ' + repairId + '\nรถ: ' + (payload.carPlate||'')
        + '\n' + (payload.repairDest||'') + '\nอาการ: ' + (payload.symptom||'').slice(0,80));
    }
  } catch(ne) { console.warn('saveRepair notify:', ne.message); }

  return { status: 'ok', id: repairId, message: 'บันทึกใบแจ้งซ่อมสำเร็จ' };
}

function updateRepair(payload) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_REPAIR);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'error', message: 'ไม่พบ RepairLog sheet' };

  var repairId = String(payload.id || '').trim();
  if (!repairId) return { status: 'error', message: 'ไม่มี RepairID' };

  var data = sheet.getDataRange().getValues();
  var targetRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === repairId) { targetRow = i + 1; break; }
  }
  if (targetRow < 0) return { status: 'error', message: 'ไม่พบ RepairID: ' + repairId };

  var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
  // col index (1-based): 11=วันซ่อมเสร็จ 16=ผู้รับรถออก 17=เบอร์โทรผู้รับ 18=ค่าซ่อม 19=สถานะ 20=หมายเหตุ 21=UpdatedAt
  // col: 11=วันซ่อมเสร็จ 16=ผู้รับรถออก 17=เบอร์โทรผู้รับ 18=ค่าซ่อม 19=สถานะ 20=หมายเหตุ 21=PhotoUrls 22=UpdatedAt
  var fieldMap = { repairDoneDate:11, receiverName:16, receiverPhone:17, cost:18, status:19, remarks:20 };
  Object.keys(fieldMap).forEach(function(key) {
    if (payload[key] !== undefined && payload[key] !== null) {
      sheet.getRange(targetRow, fieldMap[key]).setValue(payload[key]);
    }
  });
  sheet.getRange(targetRow, 22).setValue(now);
  SpreadsheetApp.flush();
  console.log('updateRepair OK id=' + repairId + ' status=' + (payload.status||''));
  return { status: 'ok', id: repairId, message: 'อัปเดตสถานะสำเร็จ' };
}

function getRepairJobs() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_REPAIR);
  if (!sheet || sheet.getLastRow() <= 1) return { status: 'ok', data: [], count: 0 };

  var rows    = sheet.getDataRange().getValues();
  var headers = rows[0];
  var keyMap  = {
    'RepairID':'id','Timestamp':'timestamp','วันที่แจ้ง':'reportDate',
    'ทะเบียนรถ':'carPlate','แจ้งซ่อมไปยัง':'repairDest','ชื่อสถานที่':'repairDestName',
    'ความเร่งด่วน':'urgency','วันนัดหมาย':'appointDate','วันเข้าซ่อม':'repairInDate',
    'วันนัดรับ':'pickupDate','วันซ่อมเสร็จ':'repairDoneDate','อาการ':'symptom',
    'รายการซ่อม':'repairItemsRaw','ผู้ส่งซ่อม':'senderName','เบอร์โทรผู้ส่ง':'senderPhone',
    'ผู้รับรถออก':'receiverName','เบอร์โทรผู้รับ':'receiverPhone',
    'ค่าซ่อม(บาท)':'cost','สถานะ':'status','หมายเหตุ':'remarks','UpdatedAt':'updatedAt'
  };

  var data = rows.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      var v = row[i];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy');
      var key = keyMap[h] || h;
      obj[key] = v;
    });
    // แปลง repairItemsRaw (newline) → array
    if (obj.repairItemsRaw) {
      obj.repairItems = String(obj.repairItemsRaw).split('\n').filter(function(x){ return x.trim(); });
    } else {
      obj.repairItems = [];
    }
    return obj;
  }).filter(function(r) { return r.id; });

  data.sort(function(a, b) { return String(b.id).localeCompare(String(a.id)); });
  return { status: 'ok', data: data, count: data.length };
}

function setupRepairSheet() {
  console.log('=== setupRepairSheet ===');
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_REPAIR);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_REPAIR);
    sheet.appendRow(REPAIR_HEADERS);
    sheet.setFrozenRows(1);
    var r = sheet.getRange(1, 1, 1, REPAIR_HEADERS.length);
    r.setBackground('#d4580a');
    r.setFontColor('#ffffff');
    r.setFontWeight('bold');
    r.setHorizontalAlignment('center');
    var widths = [160,160,100,160,120,160,100,100,100,100,100,250,250,160,120,160,120,100,120,200,300,160];
    widths.forEach(function(w, i) { sheet.setColumnWidth(i+1, w); });
    console.log('✅ สร้าง RepairLog');
  } else {
    var cur = sheet.getRange(1,1,1,Math.max(sheet.getLastColumn(),REPAIR_HEADERS.length)).getValues()[0];
    REPAIR_HEADERS.forEach(function(exp, i) {
      if (String(cur[i]||'').trim() !== exp) {
        sheet.getRange(1, i+1).setValue(exp);
        console.log('🔧 fix col'+(i+1)+' → '+exp);
      }
    });
    console.log('✅ ตรวจสอบ RepairLog header');
  }
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'RepairLog พร้อมใช้งาน' };
}

function submitFeedback(payload) {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, 'Feedback', [
    'Timestamp', 'วันที่', 'เวลา', 'ประเภท', 'ข้อความ', 'หน้า'
  ]);

  // ตั้ง header style ถ้ายังไม่มี (ทำแค่ครั้งแรก)
  try {
    var hdr = sheet.getRange(1, 1, 1, 6);
    if (sheet.getLastRow() === 1) {
      hdr.setBackground('#163251');
      hdr.setFontColor('#ffffff');
      hdr.setFontWeight('bold');
      hdr.setHorizontalAlignment('center');
      var colWidths = [160, 90, 80, 120, 400, 100];
      colWidths.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });
      sheet.setFrozenRows(1);
    }
  } catch(e) { /* ignore style errors */ }

  var now     = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');
  var timeStr = Utilities.formatDate(now, 'Asia/Bangkok', 'HH:mm:ss');
  var tsStr   = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  sheet.appendRow([
    tsStr,
    dateStr,
    timeStr,
    payload.type    || 'ทั่วไป',
    payload.message || '',
    payload.page    || 'index'
  ]);
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'ขอบคุณสำหรับ feedback' };
}

// ── uploadRepairPhoto — อัปโหลดรูปซ่อมทีละรูป → Drive subfolder RepairPhotos ──
// รับ: { action, fileName, mimeType, base64Data, repairId? }
// คืน: { status, url, viewUrl, fileId }
//
// pattern เดียวกับ uploadPhotoPost แต่ใช้ subfolder แยกเป็น
//   RepairPhotos/RPR-YYYYMMDD-NNN/  (ถ้ามี repairId)
//   RepairPhotos/pending_TIMESTAMP/ (ถ้ายังไม่มี repairId)
//
// ════════════════════════════════════════════════════════════
//  SECTION 10: ระบบประเมินความพึงพอใจ (Satisfaction.html)
// ════════════════════════════════════════════════════════════

const SHEET_SATISFACTION = 'SatisfactionLog';

/**
 * saveSatisfaction — บันทึกผลการประเมินความพึงพอใจ
 * รับ payload: { action, rating, purpose, comment, ts, driverName?, carType? }
 * สร้างชีท SatisfactionLog อัตโนมัติถ้ายังไม่มี
 */
function saveSatisfaction(payload) {
  var ss    = getSpreadsheet();
  var sheet = getOrCreateSheet(ss, SHEET_SATISFACTION, [
    'Timestamp',
    'วันที่',
    'เวลา',
    'คะแนน (1-5)',
    'ระดับความพึงพอใจ',
    'จุดประสงค์การใช้รถ',
    'ทะเบียน/ประเภทรถ',
    'พนักงานขับรถ',
    'ข้อเสนอแนะ',
    'รูปภาพหลักฐาน (URLs)',
    'วีดีโอหลักฐาน (URLs)',
    'รหัสทริป (TripID)',
    'วัน-เวลาที่ใช้รถ',
    'ที่มาของข้อมูลเที่ยว'
  ]);
  // ชีทเดิมที่สร้างไว้ก่อนหน้า: เติมคอลัมน์ใหม่ต่อท้าย (ข้อมูลเก่าไม่ถูกแตะ)
  var idxTrip   = ensureExtraColumn(sheet, 'รหัสทริป (TripID)');
  var idxUsage  = ensureExtraColumn(sheet, 'วัน-เวลาที่ใช้รถ');
  var idxSource = ensureExtraColumn(sheet, 'ที่มาของข้อมูลเที่ยว');

  var ratingText = {
    1: 'ควรปรับปรุงอย่างมาก',
    2: 'ต่ำกว่าความคาดหวัง',
    3: 'พอใจในระดับปานกลาง',
    4: 'พึงพอใจดี',
    5: 'พึงพอใจมากที่สุด'
  }[parseInt(payload.rating)] || '';

  var now     = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');
  var timeStr = Utilities.formatDate(now, 'Asia/Bangkok', 'HH:mm:ss');
  var tsStr   = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

  // รวบรวม URL สื่อแต่ละชนิด คั่นด้วย newline
  var photoUrls = Array.isArray(payload.photoUrls)
    ? payload.photoUrls.filter(Boolean).join('\n')
    : (payload.photoUrls || '');
  var videoUrls = Array.isArray(payload.videoUrls)
    ? payload.videoUrls.filter(Boolean).join('\n')
    : (payload.videoUrls || '');

  // ── ข้อมูลเที่ยววิ่งจาก QR รายคัน (ไม่บังคับ) ──
  var usageAt = String(payload.usageAt || '').trim();
  if (usageAt) {
    var um = usageAt.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
    if (!um) return { status: 'error', message: 'รูปแบบวัน-เวลาที่ใช้รถไม่ถูกต้อง (ต้องเป็น วว/ดด/ปปปป ชช:นน)' };
    var uMs = new Date(um[3] + '-' + um[2] + '-' + um[1] + 'T' + um[4] + ':' + um[5] + ':00+07:00').getTime();
    if (isNaN(uMs)) return { status: 'error', message: 'วัน-เวลาที่ใช้รถไม่ถูกต้อง' };
    if (uMs > now.getTime() + 5 * 60 * 1000) return { status: 'error', message: 'วัน-เวลาที่ใช้รถเป็นอนาคต กรุณาตรวจสอบ' };
  }
  var srcOk = { active: 'เที่ยวที่กำลังใช้งาน', today: 'เที่ยวของวันนี้', manual: 'ระบุวัน-เวลาเอง' };
  var tripSrc = srcOk[String(payload.tripSource || '')] || '';

  var baseRow = [
    tsStr,
    dateStr,
    timeStr,
    parseInt(payload.rating) || 0,
    ratingText,
    payload.purpose    || '',
    payload.carType    || '',
    payload.driverName || '',
    payload.comment    || '',
    photoUrls,
    videoUrls
  ];
  var totalCols = Math.max(sheet.getLastColumn(), baseRow.length);
  var rowOut = [];
  for (var ci = 0; ci < totalCols; ci++) rowOut.push(ci < baseRow.length ? baseRow[ci] : '');
  if (idxTrip   >= 0) rowOut[idxTrip]   = satSafeCell_(payload.tripId, 60);
  if (idxUsage  >= 0) rowOut[idxUsage]  = usageAt;
  if (idxSource >= 0) rowOut[idxSource] = tripSrc;
  sheet.appendRow(rowOut);

  SpreadsheetApp.flush();
  console.log('saveSatisfaction: rating=' + payload.rating +
    ' photos=' + (Array.isArray(payload.photoUrls) ? payload.photoUrls.length : 0) +
    ' videos=' + (Array.isArray(payload.videoUrls) ? payload.videoUrls.length : 0));

  return {
    status  : 'ok',
    message : 'บันทึกการประเมินความพึงพอใจสำเร็จ'
  };
}

/**
 * uploadSatisfactionMedia — อัพโหลดรูป/วีดีโอหลักฐานจาก satisfaction.html
 * รับ payload: { fileName, mimeType, base64Data, mediaType:'photo'|'video' }
 * อัพโหลดตรงเข้า DRIVE_FOLDER (ไม่ใช้ subfolder เพื่อหลีกเลี่ยง Access denied)
 */
function uploadSatisfactionMedia(payload) {
  if (!payload || !payload.base64Data) {
    return { status: 'error', message: 'ไม่มีข้อมูลไฟล์' };
  }
  try {
    var fileName = payload.fileName || ('media_' + new Date().getTime());
    var mimeType = payload.mimeType || 'image/jpeg';
    // ตัด data URI prefix ออกก่อน decode (รองรับทั้งที่ตัดแล้วและยังไม่ตัด)
    var raw   = String(payload.base64Data).replace(/^data:[^;]+;base64,/, '');
    var bytes = Utilities.base64Decode(raw);
    var blob  = Utilities.newBlob(bytes, mimeType, fileName);

    // อัพโหลดตรงเข้า DRIVE_FOLDER — ไม่ใช้ subfolder/setSharing เพื่อหลีกเลี่ยง Access denied
    // (pattern เดียวกับ uploadRepairPhoto และ uploadPhotoPost)
    var folder = DriveApp.getFolderById(DRIVE_FOLDER);
    var file   = folder.createFile(blob);
    var fileId = file.getId();

    console.log('uploadSatisfactionMedia OK: ' + fileName + ' [' + (payload.mediaType || 'photo') + '] id=' + fileId);
    return {
      status    : 'ok',
      url       : 'https://drive.google.com/file/d/' + fileId + '/view',
      directUrl : 'https://drive.google.com/uc?export=view&id=' + fileId,
      fileId    : fileId,
      fileName  : fileName,
      mediaType : payload.mediaType || 'photo'
    };
  } catch (err) {
    console.error('uploadSatisfactionMedia error:', err);
    return { status: 'error', message: err.message };
  }
}

function uploadRepairPhoto(payload) {
  if (!payload || typeof payload !== 'object') {
    return { status: 'error', message: 'uploadRepairPhoto: no payload' };
  }
  var fileName   = payload.fileName   || ('repair_' + new Date().getTime() + '.jpg');
  var mimeType   = payload.mimeType   || 'image/jpeg';
  var base64Data = payload.base64Data || '';

  if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };

  try {
    // อัพโหลดตรงเข้า DRIVE_FOLDER — ไม่ใช้ subfolder/setSharing เพื่อหลีกเลี่ยง Access denied
    var raw    = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    var bytes  = Utilities.base64Decode(raw);
    var blob   = Utilities.newBlob(bytes, mimeType, fileName);
    var folder = DriveApp.getFolderById(DRIVE_FOLDER);
    var file   = folder.createFile(blob);

    // เปิด sharing (view anyone with link)

    var fileId  = file.getId();
    // url แบบ view (เปิดใน browser)
    var viewUrl = 'https://drive.google.com/file/d/' + fileId + '/view';
    // url แบบ embed ตรง (ใช้ใน <img> ได้)
    var directUrl = 'https://drive.google.com/uc?export=view&id=' + fileId;

    console.log('uploadRepairPhoto OK: ' + fileName + ' → ' + viewUrl);
    return {
      status   : 'ok',
      url      : viewUrl,
      directUrl: directUrl,
      fileId   : fileId,
      fileName : fileName
    };

  } catch (err) {
    console.error('uploadRepairPhoto error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── getCarTripsForSatisfaction — ข้อมูลรถ + เที่ยววิ่ง สำหรับหน้าประเมินที่เปิดจาก QR รายคัน ──
// params: plate (จำเป็น), date (yyyy-MM-dd, ไม่ใส่ = วันนี้, ย้อนหลังได้ไม่เกิน 30 วัน), time (HH:mm, ไม่บังคับ — ใช้จับคู่เที่ยวอัตโนมัติ)
// คืน: vehicle (สถานะรถ), activeTrip (เที่ยวที่ "กำลังใช้งาน" อยู่ตอนนี้), trips (เที่ยวของวันที่ระบุ), matchedTripId
// อ่านอย่างเดียว ไม่แก้ข้อมูลใด ๆ — ส่งเฉพาะฟิลด์ที่จำเป็นต่อการระบุเที่ยว (ไม่ส่งเลขไมล์/รูป/น้ำมัน)
function satPlateKey_(s) {
  var t = String(s == null ? '' : s).split(' — ')[0].trim();
  return t.split(/\s+/)[0] || '';
}

function satHM_(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) {
    try { return Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm'); } catch (_) { return ''; }
  }
  var m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : '';
}

function satMin_(hm) {
  var m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/);
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : -1;
}

function getCarTripsForSatisfaction(params) {
  var p = params || {};
  var plateIn = String(p.plate || p.car || '').trim();
  if (!plateIn) return { status: 'error', message: 'ไม่ระบุทะเบียนรถ' };
  var key = satPlateKey_(plateIn);
  if (!key) return { status: 'error', message: 'ทะเบียนรถไม่ถูกต้อง' };

  var tz      = 'Asia/Bangkok';
  var now     = new Date();
  var today   = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var nowMin  = parseInt(Utilities.formatDate(now, tz, 'HH'), 10) * 60 + parseInt(Utilities.formatDate(now, tz, 'mm'), 10);
  var date    = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? String(p.date) : today;
  if (date > today) return { status: 'error', message: 'ไม่สามารถเลือกวันที่ในอนาคตได้' };
  var diffDays = Math.round((new Date(today + 'T00:00:00+07:00') - new Date(date + 'T00:00:00+07:00')) / 86400000);
  if (diffDays > 30) return { status: 'error', message: 'เลือกย้อนหลังได้ไม่เกิน 30 วัน' };
  var wantMin = satMin_(p.time);

  // ── สถานะรถ (ชีท Vehicles) ──
  var vehicle = null;
  var vres = getVehicles();
  (vres.data || []).some(function (v) {
    if (satPlateKey_(v['ทะเบียน']) !== key) return false;
    var upd = v['อัปเดตล่าสุด'];
    if (upd instanceof Date) upd = Utilities.formatDate(upd, tz, 'dd/MM/yyyy HH:mm');
    vehicle = {
      plate         : String(v['ทะเบียน'] || ''),
      type          : String(v['ประเภท'] || ''),
      status        : String(v['สถานะ'] || ''),
      currentDriver : String(v['ผู้ขับปัจจุบัน'] || ''),
      destination   : String(v['ปลายทาง'] || ''),
      updatedAt     : String(upd || '')
    };
    return true;
  });
  if (!vehicle) return { status: 'error', message: 'ไม่พบรถทะเบียนนี้ในระบบ' };

  // ── เที่ยววิ่ง (ชีท MileLog) — หาคอลัมน์จากชื่อ header ถ้าไม่พบใช้ตำแหน่งเดิม ──
  var activeTrip = null;
  var trips = [];
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_MILE);
  if (sheet && sheet.getLastRow() > 1) {
    var lastCol = Math.max(sheet.getLastColumn(), 12);
    var hdr = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    function col(names, fallback) {
      for (var i = 0; i < names.length; i++) { var k = hdr.indexOf(names[i]); if (k >= 0) return k; }
      return fallback;
    }
    var cId = col(['TripID', 'รหัสทริป'], 0), cDate = col(['วันที่'], 2), cOut = col(['เวลาออก', 'เวลา'], 3),
        cCar = col(['ทะเบียน/รถ'], 4), cDrv = col(['พนักงานขับรถ'], 5), cDest = col(['ปลายทาง'], 6),
        cBack = col(['เวลากลับ'], 10), cSt = col(['สถานะ'], 11);
    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getValues();
    rows.forEach(function (r) {
      if (satPlateKey_(r[cCar]) !== key) return;
      var rDate  = parseDateToYMD(r[cDate]);
      var status = String(r[cSt] || '').trim();
      var t = {
        tripId      : String(r[cId] || ''),
        date        : rDate,
        timeOut     : satHM_(r[cOut]),
        timeBack    : satHM_(r[cBack]),
        driverName  : String(r[cDrv] || ''),
        destination : String(r[cDest] || ''),
        status      : status,
        active      : status === 'กำลังใช้งาน'
      };
      if (t.active && (!activeTrip || (t.date + t.timeOut) > (activeTrip.date + activeTrip.timeOut))) activeTrip = t;
      if (rDate === date) trips.push(t);
    });
  }
  trips.sort(function (a, b) { return a.timeOut < b.timeOut ? 1 : (a.timeOut > b.timeOut ? -1 : 0); });
  trips = trips.slice(0, 30);

  // ── จับคู่เที่ยวจากเวลาที่ระบุ ──
  var matchedTripId = '';
  if (wantMin >= 0) {
    trips.some(function (t) {
      var o = satMin_(t.timeOut);
      if (o < 0) return false;
      var b = t.timeBack ? satMin_(t.timeBack) : -1;
      var ok;
      if (b < 0)       ok = wantMin >= o && (date !== today || wantMin <= nowMin);
      else if (b >= o) ok = wantMin >= o && wantMin <= b;
      else             ok = wantMin >= o || wantMin <= b;   // เที่ยวข้ามเที่ยงคืน
      if (ok) { matchedTripId = t.tripId; return true; }
      return false;
    });
  }

  return {
    status        : 'ok',
    plate         : vehicle.plate,
    date          : date,
    today         : today,
    vehicle       : vehicle,
    activeTrip    : activeTrip,
    trips         : trips,
    matchedTripId : matchedTripId
  };
}

// กัน formula injection ในช่องใหม่ของ SatisfactionLog (ค่าที่ขึ้นต้นด้วย = + - @ จะถูกนำหน้าด้วย ')
function satSafeCell_(v, maxLen) {
  var s = String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen || 120);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// ── getSatisfactionData — ดึงข้อมูลประเมินความพึงพอใจ ──────────────
// params: limit (จำนวนแถว, default 200), startDate, endDate (dd/MM/yyyy)
function getSatisfactionData(params) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SATISFACTION);

  // ถ้ายังไม่มี sheet → สร้างและคืนค่าว่าง
  if (!sheet) {
    setupSatisfactionSheet();
    return { status: 'ok', data: [], count: 0, summary: buildEmptySummary() };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return { status: 'ok', data: [], count: 0, summary: buildEmptySummary() };
  }

  var rows    = sheet.getDataRange().getValues();
  var headers = rows[0];

  // map header → key
  var keyMap = {
    'Timestamp'                  : 'timestamp',
    'วันที่'                      : 'date',
    'เวลา'                        : 'time',
    'คะแนน (1-5)'                : 'rating',
    'ระดับความพึงพอใจ'           : 'ratingText',
    'จุดประสงค์การใช้รถ'         : 'purpose',
    'ทะเบียน/ประเภทรถ'           : 'carType',
    'พนักงานขับรถ'               : 'driverName',
    'ข้อเสนอแนะ'                 : 'comment',
    'รูปภาพหลักฐาน (URLs)'       : 'photoUrls',
    'วีดีโอหลักฐาน (URLs)'       : 'videoUrls',
    'รหัสทริป (TripID)'          : 'tripId',
    'วัน-เวลาที่ใช้รถ'            : 'usageAt',
    'ที่มาของข้อมูลเที่ยว'        : 'tripSource'
  };

  var p         = params || {};
  var limitNum  = parseInt(p.limit) || 200;
  var startDate = p.startDate || '';
  var endDate   = p.endDate   || '';

  // parse filter dates
  function parseThai(dStr) {
    if (!dStr) return null;
    var parts = dStr.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  }
  var sdObj = parseThai(startDate);
  var edObj = parseThai(endDate);
  if (edObj) edObj.setHours(23, 59, 59);

  var data = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    var row = rows[i];
    var obj = {};
    headers.forEach(function(h, idx) {
      var v   = row[idx];
      if (v instanceof Date) {
        // คอลัมน์ 'เวลา' ให้ format เป็น HH:mm:ss, คอลัมน์อื่นเป็น dd/MM/yyyy
        if (h === 'เวลา') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm:ss');
        } else {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy');
        }
      }
      var key = keyMap[h] || h;
      obj[key] = (v === null || v === undefined) ? '' : v;
    });

    // filter by date range
    if (sdObj || edObj) {
      var dParts = String(obj.date || '').split('/');
      if (dParts.length === 3) {
        var rowDate = new Date(parseInt(dParts[2]), parseInt(dParts[1]) - 1, parseInt(dParts[0]));
        if (sdObj && rowDate < sdObj) continue;
        if (edObj && rowDate > edObj) continue;
      }
    }

    data.push(obj);
    if (data.length >= limitNum) break;
  }

  // ── สร้าง summary ──
  var summary = buildSatisfactionSummary(data);
  return { status: 'ok', data: data, count: data.length, summary: summary };
}

function buildEmptySummary() {
  return {
    totalCount  : 0,
    avgRating   : 0,
    dist        : { 1:0, 2:0, 3:0, 4:0, 5:0 },
    purposeDist : {},
    recentCount7: 0,
    avgRating7  : 0
  };
}

function buildSatisfactionSummary(data) {
  var total    = data.length;
  var sumRat   = 0;
  var dist     = { 1:0, 2:0, 3:0, 4:0, 5:0 };
  var purposes = {};
  var now      = new Date();
  var sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var cnt7 = 0, sum7 = 0;

  data.forEach(function(r) {
    var rat = parseInt(r.rating) || 0;
    sumRat += rat;
    if (dist[rat] !== undefined) dist[rat]++;

    var pur = r.purpose || 'ไม่ระบุ';
    purposes[pur] = (purposes[pur] || 0) + 1;

    // 7 วันล่าสุด
    if (r.date) {
      var parts = String(r.date).split('/');
      if (parts.length === 3) {
        var d = new Date(parseInt(parts[2]), parseInt(parts[1])-1, parseInt(parts[0]));
        if (d >= sevenDaysAgo) { cnt7++; sum7 += rat; }
      }
    }
  });

  return {
    totalCount  : total,
    avgRating   : total > 0 ? Math.round((sumRat / total) * 100) / 100 : 0,
    dist        : dist,
    purposeDist : purposes,
    recentCount7: cnt7,
    avgRating7  : cnt7 > 0 ? Math.round((sum7 / cnt7) * 100) / 100 : 0
  };
}


// ── getSatisfactionReport — ข้อมูลประเมิน + เที่ยววิ่ง สำหรับ Dashboard ผู้บริหาร (รายผู้ขับ / รายเที่ยว / รายคัน) ──
// params: startDate, endDate (dd/MM/yyyy, ไม่บังคับ), limit (ค่าเริ่มต้น 3000, สูงสุด 5000 แถวล่าสุด)
// อ่านอย่างเดียว · ไม่ส่งรูป/วิดีโอหลักฐาน · แนบรายละเอียดเที่ยว (วัน เวลา ปลายทาง ผู้ขับ) จาก MileLog ตาม TripID
function satDmyToYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
  var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : '';
}

function getSatisfactionReport(params) {
  var p = params || {};
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SATISFACTION);
  var empty = { status: 'ok', rows: [], count: 0, truncated: false, noTripCount: 0 };
  if (!sheet || sheet.getLastRow() <= 1) return empty;

  var limitNum = Math.min(parseInt(p.limit, 10) || 3000, 5000);
  var fromYmd = satDmyToYmd_(p.startDate || '');
  var toYmd   = satDmyToYmd_(p.endDate || '');

  var values = sheet.getDataRange().getValues();
  var hdr = values[0].map(function (h) { return String(h).trim(); });
  function col(name) { return hdr.indexOf(name); }
  var cTs = col('Timestamp'), cDate = col('วันที่'), cTime = col('เวลา'), cRat = col('คะแนน (1-5)'),
      cPur = col('จุดประสงค์การใช้รถ'), cCar = col('ทะเบียน/ประเภทรถ'), cDrv = col('พนักงานขับรถ'),
      cCom = col('ข้อเสนอแนะ'), cTrip = col('รหัสทริป (TripID)'), cUse = col('วัน-เวลาที่ใช้รถ'), cSrc = col('ที่มาของข้อมูลเที่ยว');

  function cell(r, c) { return c >= 0 ? r[c] : ''; }
  var rows = [];
  var truncated = false;
  for (var i = values.length - 1; i >= 1; i--) {
    var r = values[i];
    var ymd = satDmyToYmd_(cell(r, cDate));
    if (fromYmd && ymd && ymd < fromYmd) continue;
    if (toYmd && ymd && ymd > toYmd) continue;
    var rating = parseInt(cell(r, cRat), 10) || 0;
    if (rating < 1 || rating > 5) continue;
    if (rows.length >= limitNum) { truncated = true; break; }
    var t = cell(r, cTime);
    var carStr = String(cell(r, cCar) || '').trim();
    rows.push({
      ymd       : ymd,
      date      : ymd ? ymd.slice(8, 10) + '/' + ymd.slice(5, 7) + '/' + ymd.slice(0, 4) : '',
      time      : t instanceof Date ? Utilities.formatDate(t, 'Asia/Bangkok', 'HH:mm') : satHM_(t),
      rating    : rating,
      purpose   : String(cell(r, cPur) || ''),
      car       : carStr,
      plate     : satPlateKey_(carStr),
      driver    : String(cell(r, cDrv) || '').replace(/\s+/g, ' ').trim(),
      comment   : String(cell(r, cCom) || '').slice(0, 600),
      tripId    : String(cell(r, cTrip) || '').trim(),
      usageAt   : String(cell(r, cUse) || ''),
      tripSource: String(cell(r, cSrc) || ''),
      trip      : null
    });
  }

  // ── แนบรายละเอียดเที่ยว (เฉพาะ TripID ที่ถูกอ้างถึง) ──
  var want = {};
  rows.forEach(function (x) { if (x.tripId) want[x.tripId] = true; });
  var sheetM = Object.keys(want).length ? ss.getSheetByName(SHEET_MILE) : null;
  if (sheetM && sheetM.getLastRow() > 1) {
    var lastCol = Math.max(sheetM.getLastColumn(), 12);
    var mh = sheetM.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    function mcol(names, fb) { for (var k = 0; k < names.length; k++) { var ix = mh.indexOf(names[k]); if (ix >= 0) return ix; } return fb; }
    var mId = mcol(['TripID', 'รหัสทริป'], 0), mDate = mcol(['วันที่'], 2), mOut = mcol(['เวลาออก', 'เวลา'], 3),
        mCar = mcol(['ทะเบียน/รถ'], 4), mDrv = mcol(['พนักงานขับรถ'], 5), mDest = mcol(['ปลายทาง'], 6), mBack = mcol(['เวลากลับ'], 10);
    var trips = {};
    sheetM.getRange(2, 1, sheetM.getLastRow() - 1, lastCol).getValues().forEach(function (m) {
      var id = String(m[mId] || '').trim();
      if (!id || !want[id]) return;
      trips[id] = {
        date       : parseDateToYMD(m[mDate]),
        timeOut    : satHM_(m[mOut]),
        timeBack   : satHM_(m[mBack]),
        plate      : satPlateKey_(m[mCar]),
        driver     : String(m[mDrv] || '').replace(/\s+/g, ' ').trim(),
        destination: String(m[mDest] || '')
      };
    });
    rows.forEach(function (x) {
      if (x.tripId && trips[x.tripId]) {
        x.trip = trips[x.tripId];
        if (!x.driver) x.driver = x.trip.driver;
        if (!x.plate)  x.plate  = x.trip.plate;
      }
    });
  }

  var noTrip = rows.filter(function (x) { return !x.tripId; }).length;
  return { status: 'ok', rows: rows, count: rows.length, truncated: truncated, noTripCount: noTrip };
}

// ── getFeedbackData — ดึงข้อมูล feedback (ช่วยเหลือ/แจ้งปัญหา) ────
function getFeedbackData(params) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Feedback');

  if (!sheet) {
    // สร้าง sheet ใหม่
    submitFeedback({ type: '_init', message: '_system_init', page: 'system' });
    return { status: 'ok', data: [], count: 0 };
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { status: 'ok', data: [], count: 0 };

  var p        = params || {};
  var limitNum = parseInt(p.limit) || 100;
  var rows     = sheet.getDataRange().getValues();
  var headers  = rows[0];

  var keyMap = {
    'Timestamp' : 'timestamp',
    'วันที่'     : 'date',
    'เวลา'       : 'time',
    'ประเภท'     : 'type',
    'ข้อความ'    : 'message',
    'หน้า'       : 'page'
  };

  var data = [];
  for (var i = rows.length - 1; i >= 1; i--) {
    var row = rows[i];
    var obj = {};
    headers.forEach(function(h, idx) {
      var v   = row[idx];
      if (v instanceof Date) {
        if (h === 'เวลา') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'HH:mm:ss');
        } else if (h === 'Timestamp') {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
        } else {
          v = Utilities.formatDate(v, 'Asia/Bangkok', 'dd/MM/yyyy');
        }
      }
      obj[keyMap[h] || h] = (v === null || v === undefined) ? '' : v;
    });
    // กรอง _system_init ออก
    if (obj.message === '_system_init') continue;
    data.push(obj);
    if (data.length >= limitNum) break;
  }

  return { status: 'ok', data: data, count: data.length };
}


// ── setupSatisfactionSheet — สร้าง SatisfactionLog พร้อม style ────
function setupSatisfactionSheet() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_SATISFACTION);
  var SAT_HEADERS = [
    'Timestamp', 'วันที่', 'เวลา', 'คะแนน (1-5)',
    'ระดับความพึงพอใจ', 'จุดประสงค์การใช้รถ',
    'ทะเบียน/ประเภทรถ', 'พนักงานขับรถ', 'ข้อเสนอแนะ',
    'รูปภาพหลักฐาน (URLs)', 'วีดีโอหลักฐาน (URLs)'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SATISFACTION);
    sheet.appendRow(SAT_HEADERS);
    console.log('✅ สร้าง SatisfactionLog sheet');
  } else {
    // ตรวจสอบว่ามีคอลัมน์ใหม่หรือยัง — ถ้าไม่มีให้เพิ่มต่อท้าย
    var existingHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    if (existingHeaders.indexOf('รูปภาพหลักฐาน (URLs)') === -1) {
      var nextCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, nextCol).setValue('รูปภาพหลักฐาน (URLs)');
      sheet.getRange(1, nextCol + 1).setValue('วีดีโอหลักฐาน (URLs)');
      console.log('✅ เพิ่มคอลัมน์ รูปภาพ/วีดีโอหลักฐาน ใน SatisfactionLog (col ' + nextCol + ')');
    }
  }

  // QR รายคัน: คอลัมน์เที่ยววิ่ง (เติมต่อท้ายถ้ายังไม่มี)
  ensureExtraColumn(sheet, 'รหัสทริป (TripID)');
  ensureExtraColumn(sheet, 'วัน-เวลาที่ใช้รถ');
  ensureExtraColumn(sheet, 'ที่มาของข้อมูลเที่ยว');

  // ตั้งค่า header style
  sheet.setFrozenRows(1);
  var lastCol = sheet.getLastColumn();
  var hdr = sheet.getRange(1, 1, 1, lastCol);
  hdr.setBackground('#4a2a9a');
  hdr.setFontColor('#ffffff');
  hdr.setFontWeight('bold');
  hdr.setHorizontalAlignment('center');

  // ความกว้างคอลัมน์ (9 เดิม + 2 ใหม่)
  var colW = [160, 90, 80, 90, 160, 180, 160, 160, 300, 260, 260];
  colW.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  // คอลัมน์ URL (col 10-11) ให้ wrap text เพื่ออ่านง่าย
  if (lastCol >= 10) {
    sheet.getRange(2, 10, Math.max(sheet.getMaxRows() - 1, 1), 2).setWrap(true);
  }

  SpreadsheetApp.flush();
  return { status: 'ok', message: 'SatisfactionLog พร้อมใช้งาน (11 คอลัมน์)' };
}


// ── setupFeedbackSheet — สร้าง Feedback sheet พร้อม style ──────────
function setupFeedbackSheet() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('Feedback');
  var FB_HEADERS = ['Timestamp', 'วันที่', 'เวลา', 'ประเภท', 'ข้อความ', 'หน้า'];

  if (!sheet) {
    sheet = ss.insertSheet('Feedback');
    sheet.appendRow(FB_HEADERS);
    console.log('✅ สร้าง Feedback sheet');
  }

  sheet.setFrozenRows(1);
  var hdr = sheet.getRange(1, 1, 1, FB_HEADERS.length);
  hdr.setBackground('#163251');
  hdr.setFontColor('#ffffff');
  hdr.setFontWeight('bold');
  hdr.setHorizontalAlignment('center');

  var colW = [160, 90, 80, 120, 400, 100];
  colW.forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
  return { status: 'ok', message: 'Feedback sheet พร้อมใช้งาน' };
}


// ── setupAllSheets — สร้างทุก sheet ที่ต้องการ ──────────────────────
function setupAllSheets() {
  var results = [];
  results.push(setupVehiclesSheet());
  results.push(setupCheckLogColumns());
  results.push(setupMileLogColumns());
  results.push(setupSatisfactionSheet());
  results.push(setupFeedbackSheet());
  results.push({ status: 'ok', message: 'Locations sheet: ' + (getOrCreateSheet(getSpreadsheet(), SHEET_LOCATIONS, LOCATIONS_HEADERS) ? 'พร้อมใช้งาน' : '') });
  results.push(setupJobAssignmentsSheet());
  return { status: 'ok', message: 'ตั้งค่า sheets เสร็จสิ้น', results: results };
}

/**
 * setupVehiclesSheet — สร้าง/ตรวจสอบ Vehicles sheet พร้อมคอลัมน์ครบ
 * คอลัมน์ที่ต้องการ (0-indexed):
 *   0=ทะเบียน, 1=ประเภท, 2=ผู้รับผิดชอบ, 3=สถานะ,
 *   4=ผู้ขับปัจจุบัน, 5=ปลายทาง, 6=อัปเดตล่าสุด, 7=ประเภทระบบ, 8=หมายเหตุ
 */
function setupVehiclesSheet() {
  try {
    const ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_VEHICLE);
    var created = false;
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_VEHICLE);
      created = true;
    }

    const REQUIRED_COLS = [
      'ทะเบียน', 'ประเภท', 'ผู้รับผิดชอบ', 'สถานะ',
      'ผู้ขับปัจจุบัน', 'ปลายทาง', 'อัปเดตล่าสุด', 'ประเภทระบบ', 'หมายเหตุ'
    ];

    var existing = [];
    if (sheet.getLastRow() >= 1) {
      existing = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUIRED_COLS.length))
                       .getValues()[0]
                       .map(function(c) { return String(c).trim(); });
    }

    // เพิ่มคอลัมน์ที่ขาด
    var added = [];
    REQUIRED_COLS.forEach(function(col, idx) {
      var foundAt = existing.indexOf(col);
      if (foundAt === -1) {
        // หา slot ว่าง หรือต่อท้าย
        var targetCol = idx + 1; // 1-indexed
        if (sheet.getLastColumn() < targetCol) {
          sheet.insertColumns(sheet.getLastColumn() + 1, targetCol - sheet.getLastColumn());
        }
        sheet.getRange(1, targetCol).setValue(col);
        // จัดรูปแบบ header
        sheet.getRange(1, targetCol)
             .setBackground('#0d2137')
             .setFontColor('#ffffff')
             .setFontWeight('bold');
        added.push(col);
      }
    });

    // ล็อก header row ถ้ายังไม่ล็อก
    sheet.setFrozenRows(1);

    // ถ้าสร้างใหม่ ใส่ข้อมูลตัวอย่าง default vehicles
    if (created) {
      var defaults = getDefaultVehicles();
      defaults.forEach(function(v, i) {
        sheet.getRange(i + 2, 1).setValue(v['ทะเบียน']    || '');
        sheet.getRange(i + 2, 2).setValue(v['ประเภท']      || '');
        sheet.getRange(i + 2, 3).setValue(v['ผู้รับผิดชอบ'] || '');
        sheet.getRange(i + 2, 4).setValue(v['สถานะ']       || 'พร้อมใช้งาน');
        sheet.getRange(i + 2, 5).setValue('');
        sheet.getRange(i + 2, 6).setValue('');
        sheet.getRange(i + 2, 7).setValue(
          Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm')
        );
        sheet.getRange(i + 2, 8).setValue(v['ประเภทระบบ'] || 'ทั่วไป');
        sheet.getRange(i + 2, 9).setValue('');
      });
    }

    SpreadsheetApp.flush();
    return { sheet: SHEET_VEHICLE, status: 'ok',
             created: created, columnsAdded: added,
             message: created ? 'สร้าง sheet ใหม่' : (added.length > 0 ? 'เพิ่มคอลัมน์: ' + added.join(', ') : 'ครบถ้วนแล้ว') };
  } catch(err) {
    return { sheet: SHEET_VEHICLE, status: 'error', message: err.message };
  }
}

/**
 * setupCheckLogColumns — ตรวจสอบ/เพิ่มคอลัมน์ CheckLog sheet
 */
function setupCheckLogColumns() {
  try {
    const ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_CHECK);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_CHECK);
    }

    const REQUIRED = [
      'ลำดับ', 'วันที่', 'เวลา', 'ทะเบียน/รถ', 'ผู้ตรวจ', 'ไมล์',
      'กระจกมองข้าง', 'ระบบเบรค', 'น้ำในหม้อน้ำ', 'ช่วงล่าง',
      'ระดับน้ำมันเครื่อง', 'ลมยาง', 'ไฟหน้า', 'ไฟท้าย/ไฟเบรค',
      'ไฟถอย', 'เสียงแตร', 'ที่ปัดน้ำฝน', 'เครื่องปรับอากาศ',
      'ความสะอาดภายนอก', 'ความสะอาดภายใน',
      'ปริมาณน้ำมัน', 'การเติมน้ำมัน',
      'น้ำมันเครื่อง', 'แบตเตอรี่', 'ยางรถยนต์',
      'หมายเหตุ', 'สถานะ', 'รูปถ่าย', 'timestamp'
    ];

    var existing = sheet.getLastRow() >= 1
      ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUIRED.length))
             .getValues()[0].map(function(c){ return String(c).trim(); })
      : [];

    var added = [];
    REQUIRED.forEach(function(col, idx) {
      if (existing.indexOf(col) === -1) {
        var targetCol = idx + 1;
        if (sheet.getLastColumn() < targetCol) {
          sheet.insertColumns(sheet.getLastColumn() + 1, targetCol - sheet.getLastColumn());
        }
        var cell = sheet.getRange(1, targetCol);
        cell.setValue(col)
            .setBackground('#163251')
            .setFontColor('#ffffff')
            .setFontWeight('bold');
        added.push(col);
      }
    });

    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    return { sheet: SHEET_CHECK, status: 'ok', columnsAdded: added,
             message: added.length > 0 ? 'เพิ่มคอลัมน์: ' + added.join(', ') : 'ครบถ้วนแล้ว' };
  } catch(err) {
    return { sheet: SHEET_CHECK, status: 'error', message: err.message };
  }
}

/**
 * setupMileLogColumns — ตรวจสอบ/เพิ่มคอลัมน์ MileLog sheet
 */
function setupMileLogColumns() {
  try {
    const ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_MILE);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_MILE);
    }

    const REQUIRED = [
      'ลำดับ', 'รหัสทริป', 'วันที่', 'เวลาออก',
      'ทะเบียน/รถ', 'พนักงานขับรถ', 'ปลายทาง',
      'ไมล์เริ่มต้น', 'ไมล์สิ้นสุด', 'ระยะทาง(กม.)',
      'เวลากลับ', 'ผู้โดยสาร', 'สถานะ',
      'น้ำมันที่เติม(ลิตร)', 'ราคาน้ำมัน', 'รูปบิลน้ำมัน',
      'หมายเหตุ', 'timestamp', 'รูปบิลน้ำมันขากลับ',
      'จุดขอใช้รถ', 'รูปสภาพรถ', 'รูปสภาพรถขากลับ'
    ];

    var existing = sheet.getLastRow() >= 1
      ? sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), REQUIRED.length))
             .getValues()[0].map(function(c){ return String(c).trim(); })
      : [];

    var added = [];
    REQUIRED.forEach(function(col, idx) {
      if (existing.indexOf(col) === -1) {
        var targetCol = idx + 1;
        if (sheet.getLastColumn() < targetCol) {
          sheet.insertColumns(sheet.getLastColumn() + 1, targetCol - sheet.getLastColumn());
        }
        var cell = sheet.getRange(1, targetCol);
        cell.setValue(col)
            .setBackground('#163251')
            .setFontColor('#ffffff')
            .setFontWeight('bold');
        added.push(col);
      }
    });

    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    return { sheet: SHEET_MILE, status: 'ok', columnsAdded: added,
             message: added.length > 0 ? 'เพิ่มคอลัมน์: ' + added.join(', ') : 'ครบถ้วนแล้ว' };
  } catch(err) {
    return { sheet: SHEET_MILE, status: 'error', message: err.message };
  }
}


// ═══════════════════════════════════════════════════════════════════
//  WORKTABLE — ตารางเวรยานพาหนะ
//  Sheet name: ตารางเวร (สร้างอัตโนมัติใน Spreadsheet เดิม)
// ═══════════════════════════════════════════════════════════════════

var SHEET_WORKTABLE      = 'ตารางเวร';
var SHEET_WORKTABLE_NEXT = 'ตารางเวรถัดไป';
var SHEET_META_WT        = 'MetaWorktable';

// ✅ NEW: รูปประจำตัว พขร./เจ้าหน้าที่ — เก็บแยกชีท map ด้วยเบอร์โทร เพื่อไม่ต้องแก้โครงสร้างคอลัมน์วันที่ 1-31 ในชีท "ตารางเวร"
var SHEET_STAFF_PHOTOS      = 'StaffPhotos';
var STAFF_PHOTOS_HEADERS    = ['เบอร์โทรศัพท์', 'ชื่อ-สกุล', 'PhotoURL', 'อัปเดตล่าสุด'];
// ✅ NEW: สถานะ/บทบาทเริ่มต้น — ทุกคนเป็น "พขร." ยกเว้นคนที่ระบุบทบาทไว้แล้วในชีท (เช่น หัวหน้างาน/รองหัวหน้างาน)
var DEFAULT_STAFF_ROLE = 'พขร.';

function getWorktableSpreadsheet() {
  return getSpreadsheet(); // ใช้ Spreadsheet เดิมของระบบ
}

function getStaffPhotosSheet_() {
  return getOrCreateSheet(getSpreadsheet(), SHEET_STAFF_PHOTOS, STAFF_PHOTOS_HEADERS);
}

/** getStaffPhotosMap_ — คืน map { normalizedPhone: photoUrl } จากชีท StaffPhotos ทั้งหมดในครั้งเดียว (กันยิง sheet ซ้ำในลูป) */
function getStaffPhotosMap_() {
  var sheet = getStaffPhotosSheet_();
  var data  = sheet.getDataRange().getValues();
  var map   = {};
  for (var r = 1; r < data.length; r++) {
    var phone = normalizePhone_(data[r][0]);
    var url   = String(data[r][2] || '').trim();
    if (phone && url) map[phone] = url;
  }
  return map;
}

/** uploadStaffPhoto — อัปโหลดรูปประจำตัว พขร./เจ้าหน้าที่ (base64) เก็บใน Drive แล้ว map เข้ากับเบอร์โทรใน StaffPhotos
 *  สิทธิ์: เจ้าของเบอร์อัปโหลดรูปตัวเองได้เท่านั้น หรือแอดมิน (WORKTABLE_ADMIN_CODE) อัปโหลดแทนใครก็ได้ */
function uploadStaffPhoto(payload) {
  try {
    var v = verifyDriverPhone(payload); // payload.phone = รหัสยืนยันตัวตน (เบอร์ของตัวเอง หรือรหัสแอดมิน)
    if (v.status !== 'ok') return v;

    var targetPhone = normalizePhone_((payload && payload.targetPhone) || v.phone);
    if (!v.isAdmin && targetPhone !== normalizePhone_(v.phone)) {
      return { status: 'error', message: 'คุณสามารถอัปโหลดได้เฉพาะรูปของตัวเองเท่านั้น' };
    }
    var targetName = String((payload && payload.targetName) || v.name || '').trim();

    var base64Data = (payload && payload.base64Data) || (payload && payload.imageBase64) || '';
    if (!base64Data) return { status: 'error', message: 'ไม่มีข้อมูลรูปภาพ' };
    var mimeType = (payload && payload.mimeType) || 'image/jpeg';

    var rootFolder  = DRIVE_FOLDER ? DriveApp.getFolderById(DRIVE_FOLDER) : DriveApp.getRootFolder();
    var staffFolder = getOrCreateSubFolder(rootFolder, 'StaffPhotos');

    var clean = String(base64Data).replace(/^data:[^;]+;base64,/, '');
    var bytes = Utilities.base64Decode(clean);
    var ext   = mimeType.indexOf('png') >= 0 ? 'png' : 'jpg';
    var blob  = Utilities.newBlob(bytes, mimeType, 'staff_' + targetPhone + '_' + Date.now() + '.' + ext);
    var file  = staffFolder.createFile(blob);
    // ✅ ต้องเปิดสิทธิ์ "ทุกคนที่มีลิงก์ดูได้" ก่อน ไม่งั้นรูปจะไม่ขึ้นในเบราว์เซอร์ของคนอื่น (ไฟล์ที่สร้างใหม่ยังเป็นส่วนตัวอยู่)
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) { console.error('uploadStaffPhoto share error:', shareErr); }
    // ✅ ใช้ endpoint thumbnail แทน uc?export=view — โหลดเป็นรูปตรงๆ ใน <img> ได้เสถียรกว่า (uc?export=view บางครั้งโดนบล็อกหรือขึ้นหน้ายืนยันแทนรูป)
    var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400';

    var sheet = getStaffPhotosSheet_();
    var data  = sheet.getDataRange().getValues();
    var rowNum = -1;
    for (var r = 1; r < data.length; r++) {
      if (normalizePhone_(data[r][0]) === targetPhone) { rowNum = r + 1; break; }
    }
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    if (rowNum > 0) {
      sheet.getRange(rowNum, 1, 1, 4).setValues([[targetPhone, targetName, url, now]]);
    } else {
      sheet.appendRow([targetPhone, targetName, url, now]);
    }

    return { status: 'ok', message: 'อัปโหลดรูปเรียบร้อยแล้ว', photoUrl: url };
  } catch (err) {
    console.error('uploadStaffPhoto error:', err);
    return { status: 'error', message: err.message };
  }
}

function getWorktableSchedule() {
  try {
    var ss  = getWorktableSpreadsheet();
    var ext = '207';
    try { var meta = ss.getSheetByName(SHEET_META_WT); if (meta) ext = meta.getRange('B4').getValue() || '207'; } catch (e0) {}

    // ✅ ตารางเวร "เดือนปัจจุบัน" = ชีทที่หัวชีทระบุเดือน/ปีของวันนี้ (ไม่ว่าจะชื่อ ตารางเวร หรือ ตารางเวรถัดไป)
    //    ไม่เชื่อ MetaWorktable อีกต่อไป (เคยค้างเดือนเก่า ทำให้หัววัน/จำนวนวันในหน้าเว็บเพี้ยน)
    var all  = rosterLoadAll_();
    var pick = rosterPickByMonth_(all.rosters, all.month, all.year);
    if (pick) return rosterToScheduleResult_(pick, all.month, all.year, ext);

    // ไม่พบชีทที่ตรงเดือนนี้ → ใช้ชีท "ตารางเวร" ตามเดิม (เดือน/ปีเอาจากหัวชีทถ้าอ่านได้)
    var main = all.rosters.filter(function (ro) { return ro.sheetName === SHEET_WORKTABLE; })[0];
    if (!main) return { status:'error', message:'ยังไม่มี sheet ตารางเวร — กรุณาเรียก setupWorktableSheet ก่อน' };
    var my = main.monthYear || { month: all.month, year: all.year };
    return rosterToScheduleResult_(main, my.month, my.year || all.year, ext);
  } catch(err) {
    console.error('getWorktableSchedule error:', err);
    return { status:'error', message: err.message };
  }
}

function getWorktableTodayDuty() {
  try {
    // ✅ ใช้ตัวอ่านตารางเวรใหม่: เลือกชีท (ตารางเวร / ตารางเวรถัดไป) จากเดือน/ปีจริงที่เขียนในชีท
    //    ไม่พึ่ง MetaWorktable (เคยค้างเดือนเก่า) และไม่นับค่า "0" (วันหยุด) เป็นผู้อยู่เวรอีกต่อไป
    var duty      = getDutyForDate_(new Date());
    var photosMap = getStaffPhotosMap_();
    var ext = '207';
    try {
      var meta = getWorktableSpreadsheet().getSheetByName(SHEET_META_WT);
      if (meta) ext = meta.getRange('B4').getValue() || '207';
    } catch (e2) {}

    var toItem = function (s) {
      return { name: s.name, nick: s.nick, phone: s.phoneRaw, role: s.role || DEFAULT_STAFF_ROLE,
               photo: photosMap[normalizePhone_(s.phoneRaw)] || '', shift: s.shift };
    };
    return {
      status   : 'ok',
      day      : String(duty.day),
      dow      : duty.dowThai,
      month    : duty.month,        // 1-12 (เดือนจริงวันนี้)
      year     : duty.year + 543,   // พ.ศ. (เหมือนเดิม)
      extension: ext,
      sheetName: duty.sheetName,
      rosterStatus: duty.status,    // ok | empty | nosheet
      message  : duty.status === 'ok' ? '' : duty.message,
      warning  : duty.warning || '',
      onDuty   : duty.people.map(toItem).concat(duty.leave.map(toItem))
    };
  } catch(err) {
    return { status:'error', message: err.message };
  }
}

// ── ตารางเวรเดือนถัดไป ── อ่านจาก sheet "ตารางเวรถัดไป"
// โครงสร้าง sheet เหมือนกับ "ตารางเวร" ทุกประการ
// หากไม่มี sheet นี้ จะ return status:'error' ให้ frontend แสดง errBox
function getWorktableScheduleNext() {
  try {
    var ss  = getWorktableSpreadsheet();
    var ext = '207';
    try { var meta = ss.getSheetByName(SHEET_META_WT); if (meta) ext = meta.getRange('B4').getValue() || '207'; } catch (e0) {}

    // ✅ ตารางเวร "เดือนถัดไป" = ชีทที่หัวชีทระบุเดือน/ปีของเดือนหน้า
    var all = rosterLoadAll_();
    var nm  = all.month === 12 ? 1 : all.month + 1;
    var ny  = all.month === 12 ? all.year + 1 : all.year;
    var pick = rosterPickByMonth_(all.rosters, nm, ny);
    if (pick) return rosterToScheduleResult_(pick, nm, ny, ext);

    // ไม่พบชีทเดือนหน้า → ใช้ชีท "ตารางเวรถัดไป" เฉพาะเมื่ออ่านเดือนจากหัวชีทไม่ได้เท่านั้น
    // (ถ้าชีทนั้นเป็นเดือนอื่นอย่างชัดเจน เช่น ขึ้นเดือนใหม่แล้วแต่ยังไม่ได้เตรียมเดือนถัดไป จะไม่แสดงซ้ำกับเดือนปัจจุบัน)
    var nx = all.rosters.filter(function (ro) { return ro.sheetName === SHEET_WORKTABLE_NEXT; })[0];
    if (nx && !nx.monthYear) return rosterToScheduleResult_(nx, nm, ny, ext);
    return { status:'error', message:'ยังไม่มีตารางเวรของเดือน' + ROSTER_MONTH_NAMES_[nm] + ' ' + (ny + 543) + ' — กรุณากรอกในชีท "' + SHEET_WORKTABLE_NEXT + '" (ใส่ "ประจำเดือน ' + ROSTER_MONTH_NAMES_[nm] + ' พ.ศ. ' + (ny + 543) + '" ในหัวชีท)' };
  } catch(err) {
    console.error('getWorktableScheduleNext error:', err);
    return { status:'error', message: err.message };
  }
}

function setupWorktableSheet() {
  try {
    var ss    = getWorktableSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_WORKTABLE);
    var isNew = !sheet;
    if (!sheet) sheet = ss.insertSheet(SHEET_WORKTABLE);

    // Title rows
    sheet.getRange(1, 1).setValue('ตารางปฏิบัติงานเจ้าหน้าที่ งานยานพาหนะ  กลุ่มงานบริหารทั่วไป');
    sheet.getRange(1, 1, 1, 35).merge().setBackground('#163251').setFontColor('#ffffff').setFontWeight('bold').setFontSize(13);
    var today = new Date();
    var monthNames = ['','มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน',
                      'กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];
    sheet.getRange(2, 1).setValue('ประจำเดือน  ' + monthNames[today.getMonth()+1] + '  พ.ศ. ' + (today.getFullYear()+543));
    sheet.getRange(2, 1, 1, 35).merge().setBackground('#1e4a7a').setFontColor('#ffffff').setFontWeight('bold');
    // Header row at row 3
    var headerRow = ['ชื่อ-สกุล','ชื่อเล่น','เบอร์โทรศัพท์','บทบาท'];
    var DOW_SHORT = ['อา','จ','อ','พ','พฤ','ศ','ส'];
    var firstDay = new Date(today.getFullYear(), today.getMonth(), 1).getDay();
    for (var d = 1; d <= 31; d++) {
      var dt = new Date(today.getFullYear(), today.getMonth(), d);
      if (dt.getMonth() !== today.getMonth()) { headerRow.push(''); continue; }
      headerRow.push(d + '\n' + DOW_SHORT[dt.getDay()]);
    }
    sheet.getRange(3, 1, 1, headerRow.length).setValues([headerRow]);
    sheet.getRange(3, 1, 1, headerRow.length)
      .setBackground('#0f2744').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(3);
    sheet.setFrozenColumns(4);
    sheet.setColumnWidth(1, 200);
    sheet.setColumnWidth(2, 80);
    sheet.setColumnWidth(3, 130);
    sheet.setColumnWidth(4, 120);
    for (var i = 5; i <= 35; i++) sheet.setColumnWidth(i, 55);

    // Seed data
    if (isNew) {
      var staffData = getWorktableDefaultStaff();
      var rows = staffData.map(function(s) {
        var row = [s.name, s.nick, s.phone, s.role];
        for (var d = 1; d <= 31; d++) row.push(s.schedule[String(d)] || '');
        return row;
      });
      if (rows.length) {
        sheet.getRange(4, 1, rows.length, rows[0].length).setValues(rows);
        for (var r = 0; r < rows.length; r++) {
          sheet.getRange(r+4, 1, 1, rows[0].length)
            .setBackground(r % 2 === 0 ? '#f8fafc' : '#ffffff');
        }
      }
    }

    // Meta sheet
    var meta = ss.getSheetByName(SHEET_META_WT);
    if (!meta) meta = ss.insertSheet(SHEET_META_WT);
    // Row 1: title, Row 2: month, Row 3: year, Row 4: extension
    meta.getRange('A1').setValue('MetaWorktable — ค่า config สำหรับระบบ worktable.html');
    meta.getRange('A2').setValue('month'); meta.getRange('B2').setValue(new Date().getMonth() + 1);
    meta.getRange('A3').setValue('year');  meta.getRange('B3').setValue(new Date().getFullYear() + 543);
    meta.getRange('A4').setValue('extension'); meta.getRange('B4').setValue('207');
    try { meta.hideSheet(); } catch(_) {}

    SpreadsheetApp.flush();
    return {
      status  : 'ok',
      message : 'ตั้งค่า sheet ตารางเวรเรียบร้อยแล้ว',
      sheetId : sheet.getSheetId(),
      isNew   : isNew,
    };
  } catch(err) {
    console.error('setupWorktableSheet error:', err);
    return { status:'error', message: err.message };
  }
}

function getWorktableDefaultStaff() {
  return [
    { name:'นายชัยพร มอญแสง',         nick:'ชัย',   phone:'0849484577', role:'หัวหน้างาน',
      schedule:{2:'ช1บ2',4:'ช2บ1',8:'ช1บ2',10:'ช3(Ems)',11:'ด',12:'ช1บ2',14:'ด',15:'ช2บ1',
                18:'ช1บ2',19:'ช3(Ems)',20:'ด',22:'ช2บ1',24:'ช3(Ems)',25:'ช2บ1',27:'ช1บ2',29:'ช2บ1'} },
    { name:'นายกิตติพงศ์ เขื่อนแก้ว', nick:'หนุ่ย', phone:'0882665403', role:'รองหัวหน้างาน',
      schedule:{} },
    { name:'นายกานต์นิธิ ทองอร',       nick:'โบ๊ท', phone:'0861004536', role:'',
      schedule:{2:'ช3(Ems)',3:'ด',5:'ช1',7:'ช2บ1',8:'ช3(Ems)',9:'ด',11:'ช1บ2',
                16:'ช2บ1',17:'ช3(Ems)',18:'ด',19:'ช1บ2',21:'ด',22:'ช3(Ems)',23:'ด',
                24:'ช2บ1',26:'ช1บ2',28:'ด',30:'ช1บ2'} },
    { name:'นายนพดล คำปินคำ',           nick:'โด้',  phone:'0960214436', role:'',
      schedule:{3:'ช1บ2',7:'ช1บ2',9:'ช3(Ems)',10:'ด',11:'ช2บ1',14:'ช2บ1',
                16:'ช3(Ems)',17:'ด',18:'ช2บ1',21:'ช2บ1',23:'ช1บ2',25:'ด',26:'ช3(Ems)',27:'ด'} },
    { name:'นายเก้า พิจิตร',            nick:'เก้า', phone:'0869168036', role:'',
      schedule:{1:'ด',2:'ช2บ1',4:'ด',5:'ช3(Ems)',6:'ด',8:'ช2บ1',10:'ช1บ2',
                13:'ช2บ1',15:'ช3(Ems)',16:'ด',17:'ช2บ1',20:'ช2บ1',22:'ด',
                23:'ช3(Ems)',24:'ด',29:'ช1บ2',30:'ช3(Ems)'} },
    { name:'นายภาณุพงค์ กางสำโรง',     nick:'อุ้ม', phone:'0638020502', role:'',
      schedule:{1:'ช1บ2',4:'ช1บ2',6:'ช2บ1',12:'ช2บ1',14:'ช1บ2',21:'ช1บ2',28:'ช2บ1',30:'ด'} },
    { name:'นายเฉิมพล เลาแก้ว',       nick:'แบงค์',phone:'0907522278', role:'',
      schedule:{} },
    { name:'นายชัยพร ชัยศร',           nick:'บอม',  phone:'0866728623', role:'',
      schedule:{2:'ด',3:'ช2บ1',10:'ช2บ1',15:'ช1บ2',23:'ช2บ1',25:'ช3(Ems)',26:'ด',30:'ช2บ1'} },
    { name:'นายคมสันต์ ภายไธสงค์',     nick:'ก๊อต', phone:'0966952256', role:'',
      schedule:{1:'ช2บ1',4:'ช3(Ems)',5:'ด/บ2',6:'ช1บ2',9:'ช2บ1',12:'ช3(Ems)',13:'ด',
                17:'ช1บ2',19:'ช2บ1',24:'ช1บ2',26:'ช2บ1',28:'ช1บ2'} },
    { name:'นายธนวัฒน์ มอญแสง',     nick:'',     phone:'',           role:'',
      schedule:{} },
  ];
}

// ═══════════════════════════════════════════════════════════════════
//  ตารางงาน (Job Assignments) — งานที่ผู้ขอรถแจ้งให้ พขร. ไปรับ-ส่ง
//  Sheet name: ตารางงาน (สร้างอัตโนมัติใน Spreadsheet เดิม)
//  พขร. อัปเดตข้อมูลได้เองผ่านมือถือ โดย "ล็อกอิน" ด้วยเบอร์โทรศัพท์
//  (ตรวจสอบกับรายชื่อ พขร. ใน sheet "ตารางเวร" — ไม่ต้องตั้งรหัสผ่านแยก)
// ═══════════════════════════════════════════════════════════════════

var SHEET_JOBS = 'ตารางงาน';
var JOBS_HEADERS = [
  'JobID', 'วันที่', 'ผู้ขอรถ', 'จำนวนคน', 'ภารกิจ/คำสั่งงาน',
  'สถานที่ไป', 'เวลาไป', 'เวลากลับ', 'ผู้ไปส่ง', 'รถที่ใช้', 'เวรของ',
  'บันทึกโดย', 'เบอร์โทรผู้บันทึก', 'สถานะ', 'บันทึกเมื่อ', 'แก้ไขล่าสุด'
];

// ✅ NEW: 'รถที่ใช้' (หมวดรถทั่วไปที่เลือกใช้ในงานนี้ — ยังไม่บังคับกรอก เพราะหมวดรถอาจเปลี่ยนแปลงในอนาคต)
// getJobsSheet_() ทำให้ชีท "ตารางงาน" ที่มีอยู่แล้ว (สร้างไว้ก่อนเพิ่มคอลัมน์นี้) ได้คอลัมน์ใหม่แบบไม่กระทบข้อมูลเดิม
// — ensureExtraColumn() จะข้ามไปเฉยๆถ้าคอลัมน์มีอยู่แล้ว หรือเพิ่มต่อท้ายให้ถ้ายังไม่มี
function getJobsSheet_() {
  var sheet = getOrCreateSheet(getSpreadsheet(), SHEET_JOBS, JOBS_HEADERS);
  ensureExtraColumn(sheet, 'รถที่ใช้');
  return sheet;
}

function jobsHeaderIndex_(headers) {
  var idx = {};
  headers.forEach(function (h, i) { idx[String(h).trim()] = i; });
  return idx;
}

function normalizePhone_(v) {
  return String(v || '').replace(/[^0-9]/g, '');
}

// ✅ NEW: รหัสแอดมินตายตัว — สำหรับหัวหน้างาน/ผู้ดูแลระบบ ให้จัดการ (เพิ่ม/แก้ไข/ลบ) ตารางงานได้
//    โดยไม่ต้องผูกกับเบอร์โทร พขร. คนใดคนหนึ่ง (เผื่อกรณีไม่ใช่ พขร. หรือเบอร์ไม่อยู่ในตารางเวร)
//    ⚠️ ควรย้ายไปเก็บใน Script Properties แทนถ้าต้องการความปลอดภัยสูงขึ้นในอนาคต
var WORKTABLE_ADMIN_CODE = 'sansai2569';

/** verifyDriverPhone — ตรวจรหัสผ่านที่กรอกกับเบอร์โทร พขร. ใน sheet "ตารางเวร" (ใช้เบอร์โทรเป็นรหัสผ่านภายใน ไม่แสดงต่อผู้ใช้)
 *  หรือรหัสแอดมิน (WORKTABLE_ADMIN_CODE) สำหรับสิทธิ์ผู้ดูแลระบบเต็มรูปแบบ */
function verifyDriverPhone(payload) {
  try {
    var raw = String((payload && payload.phone) || '').trim();
    if (!raw) return { status: 'error', message: 'โปรดใส่รหัสผ่าน' };

    // ✅ รหัสแอดมิน — เข้าถึง/จัดการตารางงานได้เต็มสิทธิ์ ไม่ผูกกับเบอร์โทรใคร
    if (raw === WORKTABLE_ADMIN_CODE) {
  return { status: 'ok', name: 'ผู้ดูแลระบบ', nick: 'Admin', role: 'แอดมิน', phone: raw, isAdmin: true, canEditSchedule: true };
}

    var phone = normalizePhone_(raw);
    if (phone.length < 9) return { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง' };

    var sched = getWorktableSchedule();
    if (sched.status !== 'ok') return { status: 'error', message: 'ไม่สามารถตรวจสอบรหัสผ่านได้ในขณะนี้' };

    var found = (sched.data || []).filter(function (s) {
      return normalizePhone_(s.phone) === phone;
    })[0];

    if (!found) return { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง กรุณาติดต่อหัวหน้างานยานพาหนะ' };

    // ✅ NEW: สิทธิ์แก้ไขเวรรายช่อง = หัวหน้างาน/รองหัวหน้างาน หรือเบอร์ใน SWAP_ADMIN_PHONES (ตรงกับ swapLogin)
    var canEditSchedule = String(found.role || '').indexOf('หัวหน้างาน') >= 0 || SWAP_ADMIN_PHONES.indexOf(phone) >= 0;
    return { status: 'ok', name: found.name, nick: found.nick, role: found.role, phone: found.phone, isAdmin: false, canEditSchedule: canEditSchedule };
  } catch (err) {
    console.error('verifyDriverPhone error:', err);
    return { status: 'error', message: err.message };
  }
}

// ============================================================
//  ✅ NEW: แก้ไขเวรรายช่อง (คน × วัน) จากหน้า worktable.html
//  ต่างจาก "แลกเวร/ยกเวร" (swap) — ไม่ต้องมีคู่กรณีและไม่ต้องรออนุมัติ ใช้เมื่อหัวหน้างานต้องแก้/เพิ่มเวร
//  ของใครสักคนในวันใดวันหนึ่งโดยตรง เช่น เพิ่มเวรดึกเป็น 2 เวรในวันเดียว = "ด/ด"
//  รูปแบบค่าในช่อง = ตามระบบยกเวร: หลายเวรต่อวันคั่นด้วย "/" (เช่น "ด/ด", "ด/ช1บ2")
//  ใบแลกเวร / รายงานเงินเวร / ข้อความ LINE อ่านจากชีทเดียวกันนี้ จึงสอดคล้องกันทันทีโดยไม่ต้องแก้ที่อื่น
// ============================================================
var SHEET_SCHEDULE_EDIT_LOG   = 'ScheduleEditLog';
var SCHEDULE_EDIT_LOG_HEADERS = ['เวลา', 'ผู้แก้ไข', 'ชีท', 'วันที่', 'ชื่อพนักงาน', 'เวรเดิม', 'เวรใหม่', 'หมายเหตุ'];
var SCHEDULE_EDIT_MAX_PARTS   = 3;

/** normalizeShiftInput_ — ตรวจ/จัดรูปค่าเวรที่รับจากหน้าเว็บ → { ok, value, message }
 *  อนุญาตเฉพาะตัวอักษรไทย/อังกฤษ/ตัวเลข/วงเล็บ (ป้องกันการฝังสูตรในชีท เช่น ขึ้นต้นด้วย = + - @)
 *  "0" (หยุด) และ "ลา" ต้องอยู่เดี่ยว ๆ — ใช้ร่วมกับเวรอื่นในวันเดียวกันไม่ได้ */
function normalizeShiftInput_(raw) {
  var s = String(raw == null ? '' : raw).replace(/（/g, '(').replace(/）/g, ')').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  if (!s) return { ok: true, value: '' };
  var parts = s.split('/').map(function (p) { return p.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
  if (!parts.length) return { ok: true, value: '' };
  if (parts.length > SCHEDULE_EDIT_MAX_PARTS) return { ok: false, message: 'ใส่ได้สูงสุด ' + SCHEDULE_EDIT_MAX_PARTS + ' เวรต่อวัน' };
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (/^[=+\-@]/.test(p) || !/^[0-9A-Za-z\u0E00-\u0E7F().\- ]{1,20}$/.test(p)) {
      return { ok: false, message: 'รหัสเวร "' + p + '" ไม่ถูกต้อง (ใช้ได้เฉพาะตัวอักษร ตัวเลข และวงเล็บ ไม่เกิน 20 ตัว)' };
    }
    if (parts.length > 1 && (isOffShift_(p) || isLeaveShift_(p))) {
      return { ok: false, message: 'เวร "' + p + '" ใช้ร่วมกับเวรอื่นในวันเดียวกันไม่ได้' };
    }
  }
  return { ok: true, value: parts.join('/') };
}

/** findPendingSwapForCell_ — มีคำขอแลก/ยกเวรที่ "รอตรวจสอบ" อ้างถึงช่องนี้อยู่หรือไม่ (คืนข้อความเตือน หรือ '') */
function findPendingSwapForCell_(sheetName, day, name) {
  try {
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return '';
    var idx = jobsHeaderIndex_(data[0]);
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') continue;
      var ms = String(row[idx['เดือน']]) === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
      if (ms !== sheetName) continue;
      var hitReq = String(row[idx['ชื่อผู้ขอแลก']] || '').trim() === name && Number(row[idx['วันที่เดิมของผู้ขอแลก']]) === day;
      var hitTgt = String(row[idx['ชื่อผู้รับแลก']] || '').trim() === name && Number(row[idx['วันที่เดิมของผู้รับแลก']]) === day;
      if (hitReq || hitTgt) return 'มีคำขอแลก/ยกเวรที่ยังรออนุมัติของช่องนี้ — ควรตรวจสอบคำขอนั้นก่อนอนุมัติ เพราะค่าเวรในชีทเปลี่ยนไปแล้ว';
    }
  } catch (e) { console.warn('findPendingSwapForCell_: ' + e.message); }
  return '';
}

/** setWorktableShift — เขียนค่าเวรของ 1 คน ใน 1 วัน ลงชีทตารางเวรจริง
 *  payload: { phone(รหัส/เบอร์ผู้แก้), sheetName | monthSheet('current'|'next'), name(ชื่อ-สกุลเต็ม), day, value, expected }
 *    value    = ค่าใหม่ ("ด", "ด/ด", "ช1บ2", "0", "ลา" … ว่าง = ล้างช่อง)
 *    expected = ค่าที่หน้าเว็บเห็นอยู่ตอนกดแก้ — ถ้าชีทเปลี่ยนไปแล้ว (มีคนแลก/แก้ก่อน) จะไม่เขียนทับ คืน status:'conflict' */
function setWorktableShift(payload) {
  try {
    var v = swapLogin(payload); // ตรวจรหัส + สิทธิ์แบบเดียวกับระบบแลกเวร (แอดมิน / หัวหน้างาน / SWAP_ADMIN_PHONES)
    if (v.status !== 'ok') return v;
    if (!v.isAdmin) return { status: 'error', message: 'เฉพาะหัวหน้างานหรือผู้ดูแลระบบเท่านั้นที่แก้ไขเวรได้' };

    var ss = getWorktableSpreadsheet();
    var sheetName = String((payload && payload.sheetName) || '').trim();
    if (!sheetName) sheetName = (payload && payload.monthSheet) === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
    if (rosterSheetNames_(ss).indexOf(sheetName) < 0) return { status: 'error', message: 'ไม่พบชีทตารางเวร: ' + sheetName };
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) return { status: 'error', message: 'ไม่พบชีท ' + sheetName };

    var day = Number(payload && payload.day);
    if (!(day >= 1 && day <= 31) || day % 1 !== 0) return { status: 'error', message: 'วันที่ไม่ถูกต้อง' };
    var name = String((payload && payload.name) || '').trim();
    if (!name) return { status: 'error', message: 'ไม่พบชื่อพนักงาน' };

    var norm = normalizeShiftInput_(payload && payload.value);
    if (!norm.ok) return { status: 'error', message: norm.message };

    // คอลัมน์ของวัน — อ่านจากหัวตารางแบบเดียวกับ applySwapToSheet_ (ไม่พึ่งตำแหน่งตายตัว)
    var ro = readRosterSheet_(sheetName);
    var hasCols = !!ro && Object.keys(ro.dayCol).length > 0;
    if (hasCols && ro.dayCol[day] === undefined) return { status: 'error', message: 'ชีท "' + sheetName + '" ไม่มีคอลัมน์ของวันที่ ' + day };
    var dayCol = hasCols ? ro.dayCol[day] + 1 : day + 4;

    // แถวของพนักงาน — จับคู่ด้วยชื่อ-สกุลเต็มเท่านั้น (ไม่เดาจากชื่อเล่น) ถ้าซ้ำกันไม่เขียนเพื่อกันผิดคน
    var data = sheet.getDataRange().getValues();
    var hdrIdx = -1, nameCol = 0;
    for (var h = 0; h < Math.min(12, data.length) && hdrIdx < 0; h++) {
      for (var c0 = 0; c0 < Math.min(4, data[h].length); c0++) {
        if (rosterIsNameHeader_(data[h][c0])) { hdrIdx = h; nameCol = c0; break; }
      }
    }
    if (hdrIdx < 0) { hdrIdx = 2; nameCol = 0; }
    var rowIdx = -1, dup = 0;
    for (var r = hdrIdx + 1; r < data.length; r++) {
      var nm = String(data[r][nameCol] || '').trim();
      if (!nm || nm.indexOf('รวม') === 0) continue;
      if (nm === name) { if (rowIdx < 0) rowIdx = r; else dup++; }
    }
    if (rowIdx < 0) return { status: 'error', message: 'ไม่พบชื่อในตารางเวร: ' + name };
    if (dup > 0)    return { status: 'error', message: 'พบชื่อซ้ำกันในตารางเวร (' + name + ') — กรุณาแก้ในชีทโดยตรง' };

    var range   = sheet.getRange(rowIdx + 1, dayCol);
    var current = normShiftCell_(range.getValue());

    // กันเขียนทับเวรที่เพิ่งถูกเปลี่ยน (เช่น มีการแลกเวรเข้ามาระหว่างที่เปิดหน้าแก้ไขค้างไว้)
    if (payload && payload.expected !== undefined && payload.expected !== null) {
      var expected = normShiftCell_(payload.expected);
      if (expected !== current) {
        return { status: 'conflict', message: 'ช่องนี้ถูกเปลี่ยนไปแล้ว (ปัจจุบันเป็น "' + (current || 'ว่าง') + '") กรุณาตรวจสอบแล้วลองใหม่', current: current };
      }
    }

    var base = { sheetName: sheetName, day: day, name: name, previous: current };
    if (current === norm.value) return Object.assign({ status: 'ok', unchanged: true, value: current }, base);

    if (norm.value === '') range.clearContent(); else range.setValue(norm.value);
    SpreadsheetApp.flush();

    // บันทึกประวัติการแก้ไข (ล้มเหลวได้ ไม่กระทบการแก้เวร)
    try {
      var logSheet = getOrCreateSheet(getSpreadsheet(), SHEET_SCHEDULE_EDIT_LOG, SCHEDULE_EDIT_LOG_HEADERS);
      var who = v.isAdmin && v.role === 'แอดมิน' ? 'ผู้ดูแลระบบ' : (v.name + (v.nick ? ' (' + v.nick + ')' : ''));
      logSheet.appendRow([Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'), who, sheetName, day, name, current, norm.value, 'แก้ไขจากหน้าตารางเวร']);
    } catch (logErr) { console.warn('setWorktableShift log: ' + logErr.message); }

    return Object.assign({ status: 'ok', value: norm.value, warning: findPendingSwapForCell_(sheetName, day, name) }, base);
  } catch (err) {
    console.error('setWorktableShift error:', err);
    return { status: 'error', message: err.message };
  }
}

/** getJobAssignments — ดึงรายการงานทั้งหมด (ไม่รวมรายการที่ถูกยกเลิก) เรียงวันที่ใหม่สุดก่อน */
function getJobAssignments(params) {
  try {
    var sheet = getJobsSheet_();
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { status: 'ok', data: [] };

    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      var jobId = String(row[idx['JobID']] || '').trim();
      if (!jobId) continue;
      if (String(row[idx['สถานะ']] || '').trim() === 'ยกเลิก') continue;

      out.push({
        jobId       : jobId,
        date        : normalizeDateStr_(row[idx['วันที่']]),
        requester   : String(row[idx['ผู้ขอรถ']] || ''),
        headcount   : row[idx['จำนวนคน']] || '',
        mission     : String(row[idx['ภารกิจ/คำสั่งงาน']] || ''),
        destination : String(row[idx['สถานที่ไป']] || ''),
        timeOut     : formatTimeCell(row[idx['เวลาไป']]),
        timeBack    : formatTimeCell(row[idx['เวลากลับ']]),
        driver      : String(row[idx['ผู้ไปส่ง']] || ''),
        car         : String(row[idx['รถที่ใช้']] || ''),
        shiftOwner  : String(row[idx['เวรของ']] || ''),
        updatedBy   : String(row[idx['บันทึกโดย']] || ''),
        updatedByPhone: String(row[idx['เบอร์โทรผู้บันทึก']] || ''),
        createdAt   : String(row[idx['บันทึกเมื่อ']] || ''),
        updatedAt   : String(row[idx['แก้ไขล่าสุด']] || ''),
      });
    }

    out.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // วันที่ใหม่สุดก่อน
      return String(a.timeOut || '').localeCompare(String(b.timeOut || ''));
    });

    return { status: 'ok', data: out };
  } catch (err) {
    console.error('getJobAssignments error:', err);
    return { status: 'error', message: err.message };
  }
}

/** addJobAssignment — เพิ่มงานใหม่ (ต้องผ่านการยืนยันเบอร์โทรก่อนเสมอ) */
function addJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var requester = String((payload && payload.requester) || '').trim();
    var dateStr   = String((payload && payload.date) || '').trim();
    if (!requester) return { status: 'error', message: 'กรุณากรอกชื่อผู้ขอรถ' };
    if (!dateStr)   return { status: 'error', message: 'กรุณาเลือกวันที่' };

    var sheet = getJobsSheet_();
    var jobId = 'JOB' + new Date().getTime();
    var now   = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

    // ✅ FIX: เขียนแถวใหม่โดยอ้างอิงตำแหน่งคอลัมน์จาก header จริงบนชีท (ไม่ใช่ลำดับตายตัวใน JOBS_HEADERS)
    // เพื่อไม่ให้ข้อมูลเพี้ยนคอลัมน์ ถ้าชีทเดิมมีการเพิ่มคอลัมน์ใหม่ (เช่น "รถที่ใช้") ต่อท้ายในตำแหน่งที่ต่างไป
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
      .map(function (h) { return String(h).trim(); });
    var idx = jobsHeaderIndex_(headers);
    var row = new Array(headers.length).fill('');
    function setCell(col, val) { if (idx[col] != null) row[idx[col]] = val; }

    setCell('JobID', jobId);
    setCell('วันที่', dateStr);
    setCell('ผู้ขอรถ', requester);
    setCell('จำนวนคน', payload.headcount != null ? payload.headcount : '');
    setCell('ภารกิจ/คำสั่งงาน', String(payload.mission || '').trim());
    setCell('สถานที่ไป', String(payload.destination || '').trim());
    setCell('เวลาไป', String(payload.timeOut || '').trim());
    setCell('เวลากลับ', String(payload.timeBack || '').trim());
    setCell('ผู้ไปส่ง', String(payload.driver || '').trim());
    setCell('รถที่ใช้', String(payload.car || '').trim());
    setCell('เวรของ', String(payload.shiftOwner || '').trim());
    setCell('บันทึกโดย', v.name);
    setCell('เบอร์โทรผู้บันทึก', v.phone);
    setCell('สถานะ', 'ปกติ');
    setCell('บันทึกเมื่อ', now);
    setCell('แก้ไขล่าสุด', now);

    sheet.appendRow(row);

    return { status: 'ok', jobId: jobId, message: 'บันทึกงานเรียบร้อยแล้ว' };
  } catch (err) {
    console.error('addJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** updateJobAssignment — แก้ไขงานเดิม (ต้องผ่านการยืนยันเบอร์โทรก่อนเสมอ) */
function updateJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var jobId = String((payload && payload.jobId) || '').trim();
    if (!jobId) return { status: 'error', message: 'ไม่พบรายการที่ต้องการแก้ไข' };

    var sheet = getJobsSheet_();
    var data  = sheet.getDataRange().getValues();
    var idx   = jobsHeaderIndex_(data[0]);

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['JobID']] || '').trim() !== jobId) continue;

      var rowNum = r + 1;
      var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');

      function setIfProvided(col, val) {
        if (val === undefined || val === null) return;
        sheet.getRange(rowNum, idx[col] + 1).setValue(val);
      }

      setIfProvided('วันที่', payload.date);
      setIfProvided('ผู้ขอรถ', payload.requester);
      setIfProvided('จำนวนคน', payload.headcount);
      setIfProvided('ภารกิจ/คำสั่งงาน', payload.mission);
      setIfProvided('สถานที่ไป', payload.destination);
      setIfProvided('เวลาไป', payload.timeOut);
      setIfProvided('เวลากลับ', payload.timeBack);
      setIfProvided('ผู้ไปส่ง', payload.driver);
      setIfProvided('รถที่ใช้', payload.car);
      setIfProvided('เวรของ', payload.shiftOwner);
      sheet.getRange(rowNum, idx['บันทึกโดย'] + 1).setValue(v.name);
      sheet.getRange(rowNum, idx['เบอร์โทรผู้บันทึก'] + 1).setValue(v.phone);
      sheet.getRange(rowNum, idx['แก้ไขล่าสุด'] + 1).setValue(now);

      return { status: 'ok', message: 'แก้ไขข้อมูลเรียบร้อยแล้ว' };
    }

    return { status: 'error', message: 'ไม่พบรายการนี้ในระบบ (อาจถูกลบไปแล้ว)' };
  } catch (err) {
    console.error('updateJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** deleteJobAssignment — ลบงาน (soft delete: ตั้งสถานะเป็น "ยกเลิก" เพื่อรักษาประวัติไว้ตรวจสอบย้อนหลังได้) */
function deleteJobAssignment(payload) {
  try {
    var v = verifyDriverPhone(payload);
    if (v.status !== 'ok') return v;

    var jobId = String((payload && payload.jobId) || '').trim();
    if (!jobId) return { status: 'error', message: 'ไม่พบรายการที่ต้องการลบ' };

    var sheet = getJobsSheet_();
    var data  = sheet.getDataRange().getValues();
    var idx   = jobsHeaderIndex_(data[0]);

    for (var r = 1; r < data.length; r++) {
      if (String(data[r][idx['JobID']] || '').trim() !== jobId) continue;
      var rowNum = r + 1;
      sheet.getRange(rowNum, idx['สถานะ'] + 1).setValue('ยกเลิก');
      sheet.getRange(rowNum, idx['แก้ไขล่าสุด'] + 1)
        .setValue(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss'));
      return { status: 'ok', message: 'ลบรายการเรียบร้อยแล้ว' };
    }

    return { status: 'error', message: 'ไม่พบรายการนี้ในระบบ' };
  } catch (err) {
    console.error('deleteJobAssignment error:', err);
    return { status: 'error', message: err.message };
  }
}

/** setupJobAssignmentsSheet — สร้าง sheet "ตารางงาน" ถ้ายังไม่มี (เรียกครั้งเดียวตอนติดตั้งระบบ) */
function setupJobAssignmentsSheet() {
  try {
    var sheet = getJobsSheet_();
    return { status: 'ok', message: 'ตั้งค่า sheet ตารางงานเรียบร้อยแล้ว', sheetId: sheet.getSheetId() };
  } catch (err) {
    console.error('setupJobAssignmentsSheet error:', err);
    return { status: 'error', message: err.message };
  }
}
// ════════════════════════════════════════════════════════════
//  MAINTENANCE: cleanupDuplicateReturnFuelPhotos
//  ──────────────────────────────────────────────────────────
//  ใช้ครั้งเดียวเพื่อล้างข้อมูล "รูปบิลน้ำมันขากลับ" ที่ถูก
//  drag-fill ทับซ้ำหลายแถว (URL เดียวกันซ้ำในหลาย TripID)
//
//  วิธีรัน: เปิด Apps Script editor → เลือกฟังก์ชันนี้ → Run
//  ผลลัพธ์: เก็บ URL ไว้ที่แถวบนสุด (TripID ใหม่สุด/แถวแรกของกลุ่ม)
//  ของแต่ละกลุ่ม URL ที่ซ้ำกัน แล้วล้างค่าในแถวที่ซ้ำที่เหลือทั้งหมด
//  (เฉพาะแถวที่อยู่ติดกันเป็นกลุ่มเดียวกัน เพื่อป้องกันการลบ URL
//  ที่บังเอิญตรงกันข้ามกลุ่ม)
// ════════════════════════════════════════════════════════════
function cleanupDuplicateReturnFuelPhotos() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) {
    console.log('ไม่พบ MileLog หรือไม่มีข้อมูล');
    return { status: 'ok', cleared: 0 };
  }

  const hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const fuelBkCol = hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') >= 0
    ? hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') : 17; // 0-based

  const dataRange = sheet.getDataRange();
  const formulas  = dataRange.getFormulas();
  const values    = dataRange.getValues();
  const lastRow   = sheet.getLastRow();

  function extractUrl(formulaStr, valueStr) {
    const f = String(formulaStr || '').trim();
    const m = f.match(/=HYPERLINK\("([^"]+)"/i);
    if (m && m[1].startsWith('http')) return m[1];
    const v = String(valueStr || '').trim();
    if (v.startsWith('http')) return v;
    return '';
  }

  let clearedCount = 0;
  const clearedRows = [];

  // วนหาแถวที่ "URL เหมือนกับแถวก่อนหน้าติดกัน" → ถือว่าเป็น drag-fill duplicate
  // เก็บ URL ของแถวแรกของแต่ละกลุ่มไว้ (ไม่แตะ) แล้วล้างแถวที่เหลือในกลุ่มเดียวกัน
  let prevUrl = '';
  for (let i = 1; i < values.length; i++) { // i = 0-based row index, แถวจริง = i+1
    const url = extractUrl(formulas[i][fuelBkCol], values[i][fuelBkCol]);
    if (url && url === prevUrl) {
      // ซ้ำกับแถวบนติดกัน → ล้างค่า
      sheet.getRange(i + 1, fuelBkCol + 1).clearContent();
      clearedRows.push({ row: i + 1, tripId: values[i][0], url: url });
      clearedCount++;
      // prevUrl คงเดิม เพื่อให้กลุ่มที่มี >2 แถวซ้ำถูกล้างต่อเนื่อง
    } else {
      prevUrl = url;
    }
  }

  SpreadsheetApp.flush();
  console.log('✅ cleanupDuplicateReturnFuelPhotos: ล้างแล้ว ' + clearedCount + ' แถว');
  clearedRows.forEach(function(r) {
    console.log('   ล้างแถว ' + r.row + ' (TripID: ' + r.tripId + ') URL: ' + r.url);
  });

  return { status: 'ok', cleared: clearedCount, rows: clearedRows };
}

// ────────────────────────────────────────────────────────────
//  DRY-RUN version: ดูรายการที่จะถูกล้าง โดยไม่แก้ข้อมูลจริง
// ────────────────────────────────────────────────────────────
function previewDuplicateReturnFuelPhotos() {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_MILE);
  if (!sheet || sheet.getLastRow() <= 1) {
    console.log('ไม่พบ MileLog หรือไม่มีข้อมูล');
    return { status: 'ok', duplicates: [] };
  }

  const hdrs = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const fuelBkCol = hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') >= 0
    ? hdrs.lastIndexOf('รูปบิลน้ำมันขากลับ') : 17;

  const dataRange = sheet.getDataRange();
  const formulas  = dataRange.getFormulas();
  const values    = dataRange.getValues();

  function extractUrl(formulaStr, valueStr) {
    const f = String(formulaStr || '').trim();
    const m = f.match(/=HYPERLINK\("([^"]+)"/i);
    if (m && m[1].startsWith('http')) return m[1];
    const v = String(valueStr || '').trim();
    if (v.startsWith('http')) return v;
    return '';
  }

  const duplicates = [];
  let prevUrl = '';
  for (let i = 1; i < values.length; i++) {
    const url = extractUrl(formulas[i][fuelBkCol], values[i][fuelBkCol]);
    if (url && url === prevUrl) {
      duplicates.push({ row: i + 1, tripId: values[i][0], plate: values[i][4], url: url });
    } else {
      prevUrl = url;
    }
  }

  console.log('พบ ' + duplicates.length + ' แถวที่ซ้ำ (จะถูกล้างถ้ารัน cleanupDuplicateReturnFuelPhotos):');
  duplicates.forEach(function(d) {
    console.log('   แถว ' + d.row + ' | TripID: ' + d.tripId + ' | ทะเบียน: ' + d.plate + ' | URL: ' + d.url);
  });

  return { status: 'ok', duplicates: duplicates };
}

// ════════════════════════════════════════════════════════════
//  RELOAD SIGNAL — broadcast ให้ทุกอุปกรณ์ที่เปิดหน้า
//  startmile.html / check.html รีเฟรชหน้าอัตโนมัติ
//  เมื่อมีการบันทึกข้อมูลสำเร็จ (startMile, endMile, saveCheck)
// ════════════════════════════════════════════════════════════

/**
 * bumpReloadSignal — อัปเดต timestamp ของ key ที่ระบุ
 * เรียกหลัง startMile/endMile/saveCheck บันทึกสำเร็จ
 * @param {string} key - RELOAD_KEY_MILE หรือ RELOAD_KEY_CHECK
 */
function bumpReloadSignal(key) {
  invalidateDataCache_();
  try {
    PropertiesService.getScriptProperties().setProperty(key, String(Date.now()));
  } catch (e) {
    console.warn('bumpReloadSignal(' + key + '):', e.message);
  }
}

/**
 * getReloadSignal — คืนค่า timestamp ล่าสุดของแต่ละ key
 * ฝั่ง frontend poll เทียบกับค่าที่เก็บไว้ใน localStorage
 * ถ้าค่าเปลี่ยน → location.reload()
 */
function getReloadSignal() {
  const props = PropertiesService.getScriptProperties();
  return {
    status: 'ok',
    mile : props.getProperty(RELOAD_KEY_MILE)  || '0',
    check: props.getProperty(RELOAD_KEY_CHECK) || '0'
  };
}
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

// ═══════════════════════════════════════════════════════════════════
//  ROSTER — อ่าน "ผู้อยู่เวรวันนี้" จากชีท ตารางเวร / ตารางเวรถัดไป
//
//  ออกแบบให้ทนต่อการเปลี่ยนแปลงของตารางเวรเมื่อขึ้นเดือนใหม่ โดยไม่ต้องแก้โค้ดหรือสลับชีทด้วยมือ:
//   1) เลือกชีทจาก "เดือน/ปีที่เขียนในชีท" ไม่ใช่จากชื่อชีท และไม่เชื่อ MetaWorktable (เคยค้างเดือนเก่า)
//      → ไม่ว่าเดือนใหม่จะอยู่ในชีท "ตารางเวร" หรือ "ตารางเวรถัดไป" ก็หาเจอเอง
//      → ชีทอื่นที่ชื่อขึ้นต้นด้วย "ตารางเวร" (เช่น ตารางเวรถัดไป1) ก็ถูกพิจารณาด้วย
//   2) อ่านเดือน/ปีได้หลายรูปแบบ: "ประจำเดือน ตุลาคม พ.ศ. 2569", ต.ค. 69, ค.ศ., 10/2569, เซลล์ชนิดวันที่,
//      พิมพ์ผิด (พฤศจิการยน) — ถ้าอ่านหัวชีทไม่ได้ จะดูจากวันที่ในหัวคอลัมน์ หรือเทียบ "วันในสัปดาห์" กับปฏิทินแทน
//   3) หัวคอลัมน์วันที่อ่านได้ทุกแบบ: "5\nจ", 5, 05/10/2569, "5 ต.ค.", เซลล์ชนิดวันที่ (Sheets แปลงให้เองเมื่อพิมพ์)
//   4) ช่องว่าง / 0 / 0.0 / - / หยุด = ไม่มีเวร, ขึ้นต้นด้วย "ลา" = ลา (แยกบรรทัด ไม่นับเป็นผู้อยู่เวร)
//   5) ตรวจ "วันในสัปดาห์ของหัวคอลัมน์" เทียบปฏิทินจริง ถ้าไม่ตรงจะแจ้งเตือนในข้อความ (กันกรณีคัดลอกชีทเก่ามาแก้แค่ชื่อเดือน)
// ═══════════════════════════════════════════════════════════════════

var ROSTER_SHEET_PREFIX_ = 'ตารางเวร';
var ROSTER_TZ_           = 'Asia/Bangkok';
var ROSTER_MONTH_NAMES_  = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
var ROSTER_DOW_NAMES_    = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
// จับด้วย "ต้นคำ"/ตัวย่อ เพราะในชีทเคยพิมพ์ผิด เช่น "พฤศจิการยน"
var ROSTER_MONTH_RX_ = [null,
  /มกรา|ม\.\s?ค|\bjan/i, /กุมภา|ก\.\s?พ|\bfeb/i, /มีนา|มี\.\s?ค|\bmar/i, /เมษา|เม\.\s?ย|\bapr/i,
  /พฤษภา|พ\.\s?ค|\bmay\b/i, /มิถุนา|มิ\.\s?ย|\bjun/i, /กรกฎา|ก\.\s?ค|\bjul/i, /สิงหา|ส\.\s?ค|\baug/i,
  /กันยา|ก\.\s?ย|\bsep/i, /ตุลา|ต\.\s?ค|\boct/i, /พฤศจิ|พ\.\s?ย|\bnov/i, /ธันวา|ธ\.\s?ค|\bdec/i
];

function rosterFmt_(d, tz, f) { return Utilities.formatDate(d, tz, f); }
function rosterNormYear_(y) { y = Number(y); return y > 2400 ? y - 543 : y; }
function rosterClean_(v) { return String(v == null ? '' : v).replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim(); }

function rosterMonthFromText_(t) {
  var s = String(t == null ? '' : t);
  for (var m = 1; m <= 12; m++) if (ROSTER_MONTH_RX_[m].test(s)) return m;
  return 0;
}

/** ปีจากข้อความ: 2569 / 2026 / "69" ท้ายข้อความ → ปี ค.ศ. | null */
function rosterYearFromText_(t) {
  var s = String(t == null ? '' : t);
  var m = s.match(/(?:^|[^\d])(\d{4})(?!\d)/);
  if (m) { var y = rosterNormYear_(m[1]); if (y >= 1990 && y <= 2200) return y; }
  m = s.match(/(?:^|[^\d])(\d{2})\s*$/);
  if (m) { var y2 = Number(m[1]); return y2 >= 40 ? 2500 + y2 - 543 : 2000 + y2; }
  return null;
}

/** parseRosterTitleCell_ — เซลล์หัวชีท → { month, year|null } | null */
function parseRosterTitleCell_(raw, tz) {
  if (raw instanceof Date) return { month: Number(rosterFmt_(raw, tz, 'M')), year: rosterNormYear_(rosterFmt_(raw, tz, 'yyyy')) };
  var s = rosterClean_(raw);
  if (!s) return null;
  var m = rosterMonthFromText_(s);
  if (m) return { month: m, year: rosterYearFromText_(s) };
  var f = s.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);          // 1/10/2569
  if (f && Number(f[2]) >= 1 && Number(f[2]) <= 12) return { month: Number(f[2]), year: rosterYearFromText_(f[3]) || rosterNormYear_(f[3]) };
  var mm = s.match(/^\D*?(\d{1,2})\s*[\/\-.]\s*(\d{4})\D*$/);                          // 10/2569
  if (mm && Number(mm[1]) >= 1 && Number(mm[1]) <= 12) return { month: Number(mm[1]), year: rosterNormYear_(mm[2]) };
  return null;
}

/** วันในสัปดาห์จากตัวย่อไทย/อังกฤษ → 0=อาทิตย์ … 6=เสาร์ | null */
function rosterDowFromText_(t) {
  var s = String(t == null ? '' : t).replace(/[\s().\[\]]/g, '').toLowerCase();
  if (!s) return null;
  var table = [['อาทิตย์', 0], ['อาทิ', 0], ['อา', 0], ['sun', 0], ['จันทร์', 1], ['จ', 1], ['mon', 1], ['อังคาร', 2], ['อ', 2], ['tue', 2],
               ['พฤหัสบดี', 4], ['พฤหัส', 4], ['พฤ', 4], ['thu', 4], ['พุธ', 3], ['พ', 3], ['wed', 3], ['ศุกร์', 5], ['ศ', 5], ['fri', 5],
               ['เสาร์', 6], ['ส', 6], ['sat', 6]];
  for (var i = 0; i < table.length; i++) if (s.indexOf(table[i][0]) === 0) return table[i][1];
  return null;
}

/** parseRosterDayHeader_ — หัวคอลัมน์วันที่ → { day, month|null, year|null, dow|null } | null */
function parseRosterDayHeader_(cell, tz) {
  if (cell === null || cell === undefined || cell === '') return null;
  if (cell instanceof Date) {
    return { day: Number(rosterFmt_(cell, tz, 'd')), month: Number(rosterFmt_(cell, tz, 'M')),
             year: rosterNormYear_(rosterFmt_(cell, tz, 'yyyy')), dow: Number(rosterFmt_(cell, tz, 'u')) % 7 };
  }
  if (typeof cell === 'number') {
    if (cell % 1 === 0 && cell >= 1 && cell <= 31) return { day: cell, month: null, year: null, dow: null };
    if (cell > 30000 && cell < 80000) { // เลข serial ของวันที่
      var dt = new Date(Math.round((cell - 25569) * 86400000));
      return { day: dt.getUTCDate(), month: dt.getUTCMonth() + 1, year: dt.getUTCFullYear(), dow: dt.getUTCDay() };
    }
    return null;
  }
  var s = rosterClean_(cell);
  if (!s) return null;
  var f = s.match(/(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})/);          // 05/10/2569
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 31 && Number(f[2]) >= 1 && Number(f[2]) <= 12) {
    var y = rosterYearFromText_(' ' + f[3]) || rosterNormYear_(f[3]);
    return { day: Number(f[1]), month: Number(f[2]), year: y, dow: new Date(Date.UTC(y, Number(f[2]) - 1, Number(f[1]))).getUTCDay() };
  }
  var lead = s.match(/^(\d{1,2})(?!\d)\s*(.*)$/);                                      // "5 จ" / "5 ต.ค." / "5"
  if (!lead) return null;
  var day = Number(lead[1]);
  if (day < 1 || day > 31) return null;
  var rest = lead[2] || '';
  var mo = rosterMonthFromText_(rest);
  if (mo) return { day: day, month: mo, year: rosterYearFromText_(rest), dow: null };
  return { day: day, month: null, year: null, dow: rosterDowFromText_(rest) };
}

function normShiftCell_(raw) {
  if (raw === null || raw === undefined || raw instanceof Date) return '';
  return rosterClean_(raw).replace(/（/g, '(').replace(/）/g, ')');
}
/** isOffShift_ — ช่องว่าง / 0 / 0.0 / ขีด / หยุด = ไม่มีเวร (ตารางเวรใหม่ใส่ "0" ในวันหยุด) */
function isOffShift_(v) {
  v = normShiftCell_(v);
  return v === '' || /^[0\-–—.\s]+$/.test(v) || v === 'หยุด' || v === 'วันหยุด' || /^(off|x)$/i.test(v);
}
function isLeaveShift_(v) { v = normShiftCell_(v); return v.indexOf('ลา') === 0 || /^leave$/i.test(v); }

function rosterIsNameHeader_(cell) {
  return /^ชื่อ[\-–—]?(นาม)?สกุล$/.test(String(cell == null ? '' : cell).replace(/\s+/g, ''));
}

/** รายชื่อชีทตารางเวรที่ต้องพิจารณา: ตารางเวร, ตารางเวรถัดไป ก่อน แล้วตามด้วยชีทอื่นที่ชื่อขึ้นต้นด้วย "ตารางเวร" */
function rosterSheetNames_(ss) {
  var names = [SHEET_WORKTABLE, SHEET_WORKTABLE_NEXT];
  ss.getSheets().forEach(function (sh) {
    var n = sh.getName();
    if (n.indexOf(ROSTER_SHEET_PREFIX_) === 0 && names.indexOf(n) < 0) names.push(n);
  });
  return names;
}

/** readRosterSheet_ — อ่านชีทตารางเวร 1 ชีท (ไม่เจอชีท/ว่าง = null)
 *  คืน { sheetName, monthYear:{month,year|null}|null, monthSource, titleConflict, dayCol:{วัน:index}, dowByDay:{วัน:0-6|null}, staff:[…] } */
function readRosterSheet_(sheetName) {
  var ss = getWorktableSpreadsheet();
  var sh = ss.getSheetByName(sheetName);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  var tz = ss.getSpreadsheetTimeZone() || ROSTER_TZ_;

  // 1) แถวหัวตาราง (แถวที่มี "ชื่อ-สกุล") — ไม่เจอใช้แถวที่ 3 ตามรูปแบบเดิม
  var hdrIdx = -1;
  for (var h = 0; h < Math.min(12, data.length) && hdrIdx < 0; h++) {
    for (var c0 = 0; c0 < Math.min(4, data[h].length); c0++) if (rosterIsNameHeader_(data[h][c0])) { hdrIdx = h; break; }
  }
  if (hdrIdx < 0) hdrIdx = 2;
  if (hdrIdx >= data.length) return null;
  var hdr = data[hdrIdx] || [];

  // 2) เดือน/ปีจากหัวชีท (เฉพาะแถวเหนือหัวตาราง กันไปจับชื่อพนักงาน)
  var titleYm = null;
  for (var r0 = 0; r0 < hdrIdx && r0 < 6 && !(titleYm && titleYm.strong); r0++) {
    for (var c1 = 0; c1 < Math.min(4, data[r0].length); c1++) {
      var p = parseRosterTitleCell_(data[r0][c1], tz);
      if (!p) continue;
      var strong = String(data[r0][c1]).indexOf('ประจำเดือน') >= 0;
      if (!titleYm || strong) titleYm = { month: p.month, year: p.year, strong: strong };
      if (strong) break;
    }
  }

  // 3) คอลัมน์ข้อมูลบุคคล
  var col = { name: 0, nick: 1, phone: 2, role: 3 };
  hdr.forEach(function (cell, c) {
    var tx = String(cell == null ? '' : cell).replace(/\s+/g, '');
    if (rosterIsNameHeader_(cell)) col.name = c;
    else if (tx === 'ชื่อเล่น') col.nick = c;
    else if (tx.indexOf('เบอร์') === 0 || tx.indexOf('โทร') === 0) col.phone = c;
    else if (tx === 'บทบาท' || tx === 'ตำแหน่ง') col.role = c;
  });
  var lastInfoCol = Math.max(col.name, col.nick, col.phone, col.role);

  // 4) คอลัมน์วันที่ — อ่านหัวทุกช่องก่อน แล้วค่อยตัดสินเดือน
  var parsed = [];
  hdr.forEach(function (cell, c) {
    if (c <= lastInfoCol) return;
    var p = parseRosterDayHeader_(cell, tz);
    if (p) { p.col = c; parsed.push(p); }
  });
  // หัวตารางที่มี "วันที่เต็ม" (วัน/เดือน/ปี) → เชื่อวันที่ในหัวคอลัมน์มากกว่าข้อความหัวชีท
  var monthCount = {}, dated = 0;
  parsed.forEach(function (p) { if (p.month) { var k = (p.year || 0) + '-' + p.month; monthCount[k] = (monthCount[k] || 0) + 1; dated++; } });
  var ym = titleYm ? { month: titleYm.month, year: titleYm.year } : null, monthSource = titleYm ? 'title' : '', titleConflict = false;
  if (dated >= 5) {
    var bestK = Object.keys(monthCount).sort(function (a, b) { return monthCount[b] - monthCount[a]; })[0].split('-');
    var hm = { month: Number(bestK[1]), year: Number(bestK[0]) || (titleYm && titleYm.year) || null };
    if (ym && (ym.month !== hm.month)) titleConflict = true;
    ym = hm; monthSource = 'header-date';
  }

  var dayCol = {}, dowByDay = {}, minSeen = 99;
  parsed.forEach(function (p) {
    if (monthSource === 'header-date' && p.month && p.month !== ym.month) return;     // คอลัมน์ของเดือนอื่น
    if (p.day === 1 && minSeen >= 20 && minSeen < 99) { dayCol = {}; dowByDay = {}; } // ท้ายเดือนก่อนหน้า (29 30 31 | 1 2 …) ทิ้ง
    minSeen = Math.min(minSeen, p.day);
    if (dayCol[p.day] === undefined) { dayCol[p.day] = p.col; dowByDay[p.day] = p.dow; }
  });

  // 5) แถวพนักงาน
  var staff = [];
  for (var r = hdrIdx + 1; r < data.length; r++) {
    var row = data[r];
    var name = rosterClean_(row[col.name]);
    if (!name || name.indexOf('รวม') === 0 || name.indexOf('หมายเหตุ') === 0) continue; // ข้ามแถวสรุป เช่น "รวมเวร (จำนวนวัน)"
    staff.push({ name: name, nick: rosterClean_(row[col.nick]), phone: String(row[col.phone] == null ? '' : row[col.phone]).trim(),
                 role: rosterClean_(row[col.role]), row: row });
  }
  return { sheetName: sheetName, monthYear: ym, monthSource: monthSource, titleConflict: titleConflict,
           dayCol: dayCol, dowByDay: dowByDay, staff: staff };
}

/** rosterInferMonth_ — หัวชีทอ่านเดือนไม่ได้ → เดาเดือนจาก "วันในสัปดาห์" ของหัวคอลัมน์เทียบปฏิทิน (ต้องตรง ≥ 90% และมีคำตอบเดียว) */
function rosterInferMonth_(ro, cands) {
  var days = Object.keys(ro.dowByDay).filter(function (d) { return ro.dowByDay[d] !== null && ro.dowByDay[d] !== undefined; });
  if (days.length < 5) return null;
  var good = [];
  cands.forEach(function (cd) {
    var dim = new Date(Date.UTC(cd.year, cd.month, 0)).getUTCDate(), ok = 0, total = 0;
    days.forEach(function (d) {
      var dd = Number(d);
      if (dd > dim) return;
      total++;
      if (new Date(Date.UTC(cd.year, cd.month - 1, dd)).getUTCDay() === ro.dowByDay[d]) ok++;
    });
    if (total >= 5 && ok / total >= 0.9) good.push(cd);
  });
  return good.length === 1 ? good[0] : null;
}

function rosterMatchesMonth_(ro, month, year) {
  return !!ro.monthYear && ro.monthYear.month === month && (!ro.monthYear.year || ro.monthYear.year === year);
}
function rosterFilledCount_(ro, day) {
  var c = ro.dayCol[day];
  if (c === undefined) return 0;
  var n = 0;
  ro.staff.forEach(function (s) { if (normShiftCell_(s.row[c]) !== '') n++; });
  return n;
}
function rosterLabel_(ro) {
  return '"' + ro.sheetName + '" = ' + (ro.monthYear ? (ROSTER_MONTH_NAMES_[ro.monthYear.month] + (ro.monthYear.year ? ' ' + (ro.monthYear.year + 543) : '')) : 'อ่านเดือนไม่ได้');
}

/** getDutyForDate_ — ใครอยู่เวรอะไรในวันที่กำหนด (ค่าเริ่มต้น = วันนี้ เวลาไทย)
 *  คืน { status:'ok'|'empty'|'nosheet', message, warning, day, month, year(ค.ศ.), dowThai, sheetName, monthSource,
 *        people:[{name,nick,phone(เฉพาะตัวเลข),phoneRaw,role,shift}]   ← ทุกคนที่มีรหัสเวร (รวม "ช" ปกติ) เรียงตามชีท
 *        leave:[{name,nick,phone,phoneRaw,role,shift}], offCount } */
function getDutyForDate_(dateObj) {
  var d = dateObj || new Date();
  var day   = Number(Utilities.formatDate(d, ROSTER_TZ_, 'd'));
  var month = Number(Utilities.formatDate(d, ROSTER_TZ_, 'M'));
  var year  = Number(Utilities.formatDate(d, ROSTER_TZ_, 'yyyy'));
  var dow   = Number(Utilities.formatDate(d, ROSTER_TZ_, 'u')) % 7; // 1..7 (จ..อา) → 0=อาทิตย์
  var out = { status: 'nosheet', message: '', warning: '', day: day, month: month, year: year, dowThai: ROSTER_DOW_NAMES_[dow],
              sheetName: '', monthSource: '', people: [], leave: [], offCount: 0 };

  var ss = getWorktableSpreadsheet();
  var prev = { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year };
  var next = { month: month === 12 ? 1 : month + 1, year: month === 12 ? year + 1 : year };
  var cands = [prev, { month: month, year: year }, next];

  var rosters = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { console.warn('readRosterSheet_(' + nm + '): ' + e.message); }
    if (!ro) return;
    if (!ro.monthYear) {
      var inf = rosterInferMonth_(ro, cands);
      if (inf) { ro.monthYear = inf; ro.monthSource = 'weekday'; }
    }
    rosters.push(ro);
  });

  var matched = rosters.filter(function (ro) { return rosterMatchesMonth_(ro, month, year); });
  matched.forEach(function (ro) { ro.filled = rosterFilledCount_(ro, day); });
  var pick = matched.filter(function (ro) { return ro.filled > 0; })[0] || matched[0] || null; // ลำดับ: ตารางเวร → ตารางเวรถัดไป → ชีทอื่น

  if (!pick) {
    // อ่านเดือนจากชีทหลักไม่ได้เลย → ยอมใช้ชีท "ตารางเวร" (พร้อมเตือน) ดีกว่าไม่ส่งข้อมูลเวรเลย
    pick = rosters.filter(function (ro) { return !ro.monthYear && ro.sheetName === SHEET_WORKTABLE; })[0] || null;
    if (pick) out.warning = 'อ่านเดือนจากหัวชีท "' + pick.sheetName + '" ไม่ได้ — ใช้ข้อมูลตามที่มีในชีท กรุณาตรวจสอบ';
  }
  if (!pick) {
    out.message = 'ไม่พบตารางเวรของเดือน' + ROSTER_MONTH_NAMES_[month] + ' ' + (year + 543)
      + (rosters.length ? ' (พบ: ' + rosters.map(rosterLabel_).join(', ') + ')' : ' ในชีท "' + SHEET_WORKTABLE + '" หรือ "' + SHEET_WORKTABLE_NEXT + '"');
    return out;
  }
  out.sheetName = pick.sheetName;
  out.monthSource = pick.monthSource;

  var c = pick.dayCol[day];
  if (c === undefined) {
    if (Object.keys(pick.dayCol).length === 0) { c = day + 3; out.warning = out.warning || 'อ่านหัวคอลัมน์วันที่ไม่ได้ — ใช้ตำแหน่งคอลัมน์ตามรูปแบบเดิม'; }
    else { out.status = 'empty'; out.message = 'ตารางเวร (' + pick.sheetName + ') ไม่มีคอลัมน์ของวันที่ ' + day; return out; }
  }

  var filled = 0;
  pick.staff.forEach(function (s) {
    var val = normShiftCell_(s.row[c]);
    if (val !== '') filled++;
    if (isOffShift_(val)) { out.offCount++; return; }
    if (isLeaveShift_(val)) { out.leave.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone), phoneRaw: s.phone, role: s.role, shift: val }); return; }
    out.people.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone), phoneRaw: s.phone, role: s.role, shift: val });
  });
  if (filled === 0) { out.status = 'empty'; out.message = 'ตารางเวรของวันที่ ' + day + ' (' + pick.sheetName + ') ยังไม่ได้กรอกข้อมูล'; return out; }

  var hd = pick.dowByDay[day];
  if (hd !== undefined && hd !== null && hd !== dow) {
    out.warning = out.warning || ('วันในหัวตาราง (' + ROSTER_DOW_NAMES_[hd] + ') ไม่ตรงกับปฏิทินจริง (' + ROSTER_DOW_NAMES_[dow] + ') — กรุณาตรวจสอบชีท "' + pick.sheetName + '"');
  }
  if (pick.titleConflict) out.warning = out.warning || ('ชื่อเดือนในหัวชีท "' + pick.sheetName + '" ไม่ตรงกับวันที่ในหัวคอลัมน์ — ใช้ตามวันที่ในหัวคอลัมน์');
  out.status = 'ok';
  return out;
}

function rosterShortName_(p) { return p.nick || String(p.name || '').replace(/^(นาย|นางสาว|นาง)/, ''); }

/** buildDutyLines_ — ส่วน "ผู้อยู่เวรวันนี้" ของข้อความ LINE (tplKey = 'workSchedule' | 'myScheduleOverview') */
function buildDutyLines_(duty, tplKey) {
  var lines = [];
  if (duty.status !== 'ok') {
    lines.push(tpl_(tplKey, 'dutyWarnText', { message: duty.message || 'อ่านตารางเวรไม่ได้' }));
    return lines;
  }
  if (duty.people.length > 0) {
    lines.push(tpl_(tplKey, 'dutySectionTitle', { count: duty.people.length }));
    duty.people.forEach(function (p) {
      lines.push(tpl_(tplKey, 'dutyItem', {
        name: p.name, nickPart: (p.nick ? ' (' + p.nick + ')' : ''), phonePart: (p.phone ? '\n     📞 ' + p.phone : ''), shift: p.shift
      }));
    });
  } else {
    lines.push(tpl_(tplKey, 'dutyEmptyText', {}));
  }
  if (duty.leave.length) {
    lines.push(tpl_(tplKey, 'dutyLeaveText', { count: duty.leave.length, names: duty.leave.map(rosterShortName_).join(', ') }));
  }
  if (duty.warning) lines.push(tpl_(tplKey, 'dutyWarnText', { message: duty.warning }));
  return lines;
}

/** buildDutyHtml_ — ตารางผู้อยู่เวรสำหรับอีเมล */
function buildDutyHtml_(duty) {
  if (duty.status !== 'ok') return '<p style="color:#b45309">⚠️ ' + escapeHtml_(duty.message) + '</p>';
  var html = '';
  if (duty.people.length === 0) {
    html += '<p>วันนี้ไม่มีผู้อยู่เวร</p>';
  } else {
    html += '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:6px">'
      + '<tr style="background:#163251;color:#fff"><th>ผู้อยู่เวร</th><th>เบอร์โทร</th><th>เวร</th></tr>'
      + duty.people.map(function (p) {
          return '<tr><td>' + escapeHtml_(p.name + (p.nick ? ' (' + p.nick + ')' : '')) + '</td><td>' + escapeHtml_(p.phone) + '</td><td>' + escapeHtml_(p.shift) + '</td></tr>';
        }).join('')
      + '</table>';
  }
  if (duty.leave.length) html += '<p style="margin:6px 0 0">🏖️ ลา: ' + escapeHtml_(duty.leave.map(rosterShortName_).join(', ')) + '</p>';
  if (duty.warning) html += '<p style="color:#b45309;margin:6px 0 0">⚠️ ' + escapeHtml_(duty.warning) + '</p>';
  return html;
}


// ── ตารางเวรสำหรับหน้าเว็บ (getSchedule / getScheduleNext) — ใช้ตัวอ่านเดียวกับรายงาน LINE ──────────

/** rosterLoadAll_ — อ่านทุกชีทตารางเวรพร้อมเดือน/ปีที่ตรวจพบ (ถ้าหัวชีทอ่านไม่ได้ ลองเดาจากวันในสัปดาห์) */
function rosterLoadAll_(refDate) {
  var ss = getWorktableSpreadsheet();
  var d = refDate || new Date();
  var month = Number(Utilities.formatDate(d, ROSTER_TZ_, 'M'));
  var year  = Number(Utilities.formatDate(d, ROSTER_TZ_, 'yyyy'));
  var cands = [
    { month: month === 1 ? 12 : month - 1, year: month === 1 ? year - 1 : year },
    { month: month, year: year },
    { month: month === 12 ? 1 : month + 1, year: month === 12 ? year + 1 : year }
  ];
  var list = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { console.warn('rosterLoadAll_(' + nm + '): ' + e.message); }
    if (!ro) return;
    if (!ro.monthYear) {
      var inf = rosterInferMonth_(ro, cands);
      if (inf) { ro.monthYear = inf; ro.monthSource = 'weekday'; }
    }
    ro.filledTotal = 0;
    var days = Object.keys(ro.dayCol);
    ro.staff.forEach(function (s) {
      days.forEach(function (dd) { if (normShiftCell_(s.row[ro.dayCol[dd]]) !== '') ro.filledTotal++; });
    });
    list.push(ro);
  });
  return { rosters: list, month: month, year: year };
}

/** rosterPickByMonth_ — เลือกชีทของเดือน/ปีที่ต้องการ: ชีทที่มีข้อมูลก่อน แล้วตามลำดับ ตารางเวร → ตารางเวรถัดไป → ชีทอื่น */
function rosterPickByMonth_(rosters, month, year) {
  var m = rosters.filter(function (ro) { return rosterMatchesMonth_(ro, month, year); });
  return m.filter(function (ro) { return ro.filledTotal > 0; })[0] || m[0] || null;
}

/** rosterToScheduleResult_ — แปลงชีทเป็นรูปแบบที่หน้าเว็บใช้ { status, data:[{name,nick,phone,role,photo,schedule:{"1":"ช",…}}], month, year(พ.ศ.), extension } */
function rosterToScheduleResult_(ro, month, year, ext) {
  var photos = getStaffPhotosMap_();
  var hasCols = Object.keys(ro.dayCol).length > 0;
  var staff = ro.staff.map(function (s) {
    var schedule = {};
    for (var d = 1; d <= 31; d++) {
      var c = hasCols ? ro.dayCol[d] : d + 3;       // อ่านหัวคอลัมน์ไม่ได้ → ใช้ตำแหน่งตามรูปแบบเดิม
      if (c === undefined) continue;
      var val = normShiftCell_(s.row[c]);
      if (val !== '') schedule[String(d)] = val;    // "0" ยังส่งไปเหมือนเดิม (หน้าเว็บแสดงเป็นวันหยุด)
    }
    return { name: s.name, nick: s.nick, phone: s.phone, role: s.role || DEFAULT_STAFF_ROLE,
             photo: photos[normalizePhone_(s.phone)] || '', schedule: schedule };
  });
  return { status: 'ok', data: staff, month: month, year: year + 543, extension: ext, sheetName: ro.sheetName };
}

/** rosterDayColumn_ — เลขคอลัมน์ (1-based) ของวันที่ในชีทนั้น อ่านจากหัวตาราง; อ่านไม่ได้ → วันที่ + 4 ตามรูปแบบเดิม */
function rosterDayColumn_(sheetName, day) {
  try {
    var ro = readRosterSheet_(sheetName);
    if (ro && ro.dayCol[Number(day)] !== undefined) return ro.dayCol[Number(day)] + 1;
  } catch (e) { console.warn('rosterDayColumn_: ' + e.message); }
  return Number(day) + 4;
}

// ── เครื่องมือตรวจสอบ (รันจาก Apps Script Editor) ──────────────────────

/** debugRosterSheets — ดูว่าแต่ละชีทตารางเวรถูกอ่านเป็นเดือนอะไร/พบกี่คอลัมน์วัน ใช้ตรวจหลังแก้ชีทหรือขึ้นเดือนใหม่ */
function debugRosterSheets() {
  var ss = getWorktableSpreadsheet();
  var rows = [];
  rosterSheetNames_(ss).forEach(function (nm) {
    var ro = null;
    try { ro = readRosterSheet_(nm); } catch (e) { rows.push(nm + ': ERROR ' + e.message); return; }
    if (!ro) { rows.push(nm + ': (ไม่มีชีท/ว่าง)'); return; }
    var days = Object.keys(ro.dayCol).map(Number).sort(function (a, b) { return a - b; });
    rows.push(nm + ': เดือน=' + (ro.monthYear ? ro.monthYear.month + '/' + (ro.monthYear.year || '?') : 'อ่านไม่ได้') + ' (' + (ro.monthSource || '-') + ')'
      + (ro.titleConflict ? ' ⚠ หัวชีทขัดกับวันที่หัวคอลัมน์' : '')
      + ' | คอลัมน์วัน=' + days.length + (days.length ? ' [' + days[0] + '–' + days[days.length - 1] + ']' : '') + ' | พนักงาน=' + ro.staff.length);
  });
  console.log(rows.join('\n'));
  return rows;
}

/** previewDailyWorkScheduleReport — ดูข้อความรายงานตารางงานประจำวันที่จะส่ง (ไม่ส่งจริง) */
function previewDailyWorkScheduleReport() {
  var r = buildDailyWorkScheduleReport_();
  console.log(r.lineText);
  return r.lineText;
}


/** shortTime_ — "08:00:00" → "08:00" (ข้อความ LINE ไม่ต้องแสดงวินาที) ค่าอื่นคืนตามเดิม */
function shortTime_(t) {
  return String(t == null ? '' : t).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
}

/** buildScheduleOverviewReplyText_ — "ตารางงานของฉัน" สำหรับทุกบทบาท (real-time reply ตอนกด Rich Menu เท่านั้น ไม่ใช่ push)
 *  ✅ NEW: ทุกบทบาทไม่ต้องผูกเบอร์โทร/มีชื่อในตารางเวรอีกต่อไป — เช็คแค่บทบาทที่ตั้งไว้ในชีท LineUsers พอ
 *  แสดง "ภาพรวมของทุกคน" แทนเวรส่วนตัวรายบุคคล: ใครอยู่เวรวันนี้ทั้งหมด + ภารกิจทั้งหมดของวันนี้ (ไม่กรองเฉพาะคนใดคนหนึ่ง) */
function buildScheduleOverviewReplyText_() {
  var todayThai = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
  var todayYmd  = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');

  var lines = [];
  lines.push(tpl_('myScheduleOverview', 'header', { todayThai: todayThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  var duty;
  try { duty = getDutyForDate_(new Date()); }
  catch (e) { console.error('buildScheduleOverviewReplyText_ duty error:', e); duty = { status: 'error', message: 'อ่านตารางเวรไม่ได้ (' + e.message + ')', people: [], leave: [] }; }
  Array.prototype.push.apply(lines, buildDutyLines_(duty, 'myScheduleOverview'));

  lines.push('');

  var jobsRes  = getJobAssignments({});
  var todayJobs = ((jobsRes && jobsRes.data) || []).filter(function (j) { return j.date === todayYmd; });
  todayJobs.sort(function (a, b) { return String(a.timeOut || '').localeCompare(String(b.timeOut || '')); });

  if (todayJobs.length === 0) {
    lines.push(tpl_('myScheduleOverview', 'jobsEmptyText', {}));
  } else {
    lines.push(tpl_('myScheduleOverview', 'jobsListTitle', { count: todayJobs.length }));
    lines.push('');
    var phoneMap = buildStaffPhoneMap_(); // เบอร์โทร พขร. — แนบหลังชื่อผู้ขับแต่ละคน
    todayJobs.forEach(function (j, i) {
      lines.push(tpl_('myScheduleOverview', 'jobItem', {
        no: i + 1, timeOut: shortTime_(j.timeOut) || '-',
        timeBackPart: j.timeBack ? ('–' + shortTime_(j.timeBack)) : '',
        destination: j.destination || '-',
        missionPart: j.mission ? ('\n   🎯 ' + j.mission) : '',
        requester: j.requester || '-',
        driverPart: j.driver ? ('\n   🧑\u200d✈️ ผู้ขับ: ' + driverWithPhone_(j.driver, phoneMap)) : '',
        carPart: j.car ? ('\n   🚗 รถ: ' + j.car) : ''
      }));
      lines.push('');
    });
  }

  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('myScheduleOverview', 'footer', { dashboardUrl: DASHBOARD_URL }));

  return lines.join('\n');
}

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

// ═══════════════════════════════════════════════════════════════════
//  ระบบแลกเวร พขร. (swap.html)
//  Sheet ใหม่: SwapRequests (สร้างอัตโนมัติ ไม่กระทบชีทเดิม)
//  ใช้ sheet "ตารางเวร" / "ตารางเวรถัดไป" เดิมเป็นแหล่งข้อมูลรายชื่อ+เวร
//  และเขียนสลับเวรจริงลงชีทเดิมเมื่ออนุมัติ
// ═══════════════════════════════════════════════════════════════════

var SHEET_SWAP_REQUESTS = 'SwapRequests';
var SWAP_REQUEST_HEADERS = [
  'RequestID', 'เดือน', 'ชื่อผู้ขอแลก', 'เบอร์ผู้ขอแลก',
  'วันที่เดิมของผู้ขอแลก', 'เวรเดิมของผู้ขอแลก',
  'ชื่อผู้รับแลก', 'วันที่เดิมของผู้รับแลก', 'เวรเดิมของผู้รับแลก',
  'เหตุผล', 'สถานะ', 'บันทึกเมื่อ',
  'ดำเนินการโดย', 'ดำเนินการเมื่อ', 'เหตุผลที่ปฏิเสธ',
  'DocURL', 'PdfURL',
  'ประเภทคำขอ', // ✅ NEW: 'แลกเวร' (สลับกัน 2 ทาง, ค่าเริ่มต้น) หรือ 'ยกเวร' (ให้ทางเดียว ผู้รับแลกอาจมีเวรเดิมอยู่แล้ว)
  'ส่วนที่ยก' // ✅ NEW: เฉพาะโหมด "ยกเวร" กับเวรรวมเช้า-บ่าย (เช่น ช2บ1) — 'full' (ยกทั้งเวร, ค่าเริ่มต้น)
             //        'am' (ยกเฉพาะครึ่งเช้า คงเหลือครึ่งบ่ายไว้เอง) หรือ 'pm' (ยกเฉพาะครึ่งบ่าย คงเหลือครึ่งเช้าไว้เอง)
];

/** ✅ NEW: เพิ่มคอลัมน์ 'ประเภทคำขอ' ให้ sheet ที่สร้างไว้ก่อนฟีเจอร์ "ยกเวร" โดยไม่กระทบคอลัมน์/ข้อมูลเดิม
 *  (sheet เก่าที่มีอยู่แล้วจะไม่ถูกสร้างใหม่ผ่าน getOrCreateSheet ดังนั้นต้องเติมคอลัมน์ที่ขาดเองที่นี่) */
function ensureSwapRequestTypeColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var has = headerRow.some(function (h) { return String(h).trim() === 'ประเภทคำขอ'; });
  if (!has) {
    sheet.getRange(1, lastCol + 1).setValue('ประเภทคำขอ');
  }
}

/** ✅ NEW: เพิ่มคอลัมน์ 'ส่วนที่ยก' ให้ sheet ที่สร้างไว้ก่อนฟีเจอร์ "แบ่งครึ่งเวรยก" (เช่นเดียวกับ ensureSwapRequestTypeColumn_) */
function ensureSwapGivePartColumn_(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  var has = headerRow.some(function (h) { return String(h).trim() === 'ส่วนที่ยก'; });
  if (!has) {
    sheet.getRange(1, lastCol + 1).setValue('ส่วนที่ยก');
  }
}

function getSwapRequestsSheet_() {
  var sheet = getOrCreateSheet(getSpreadsheet(), SHEET_SWAP_REQUESTS, SWAP_REQUEST_HEADERS);
  ensureSwapRequestTypeColumn_(sheet);
  ensureSwapGivePartColumn_(sheet);
  return sheet;
}

/** ✅ NEW: สร้างแถวสำหรับ appendRow โดยอ้างอิงตำแหน่งคอลัมน์จริงของ sheet (idx จาก jobsHeaderIndex_)
 *  แทนการเรียงค่าแบบตายตัวตาม SWAP_REQUEST_HEADERS — ป้องกันข้อมูลเยื้องคอลัมน์ผิด
 *  กรณี sheet เก่าที่เพิ่งถูกเติมคอลัมน์ใหม่ (เช่น 'ประเภทคำขอ') ต่อท้ายให้ภายหลัง */
function buildSwapRequestRow_(idx, valuesByHeader) {
  var width = 0;
  Object.keys(idx).forEach(function (h) { width = Math.max(width, idx[h] + 1); });
  var row = new Array(width).fill('');
  Object.keys(valuesByHeader).forEach(function (h) {
    if (idx[h] != null) row[idx[h]] = valuesByHeader[h];
  });
  return row;
}

/** สร้างรหัสคำขอแลกเวรแบบไม่ซ้ำ เช่น SW260910-143502 */
function generateSwapRequestId_() {
  return 'SW' + Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyMMdd-HHmmss');
}

/** หา staff (name หรือ nick ตรงกัน) จากรายชื่อในตารางเวร */
function findSwapStaff_(list, nameOrNick) {
  var q = String(nameOrNick || '').trim();
  if (!q) return null;
  return (list || []).filter(function (s) {
    return s.name === q || s.nick === q;
  })[0] || null;
}

/** ดึงข้อมูล schedule (current+next) แล้วรวมเป็นรายชื่อ staff ไม่ซ้ำ (ใช้ name เป็น key หลัก) */
function getSwapCombinedStaff_() {
  var cur = getWorktableSchedule();
  var next = getWorktableScheduleNext();
  var byName = {};
  (cur.status === 'ok' ? cur.data : []).forEach(function (s) { byName[s.name] = s; });
  (next.status === 'ok' ? next.data : []).forEach(function (s) { if (!byName[s.name]) byName[s.name] = s; });
  return Object.keys(byName).map(function (k) { return byName[k]; });
}

// ── LOGIN ────────────────────────────────────────────────────────────
// ✅ รายชื่อเบอร์ที่ได้สิทธิ์แอดมินในระบบแลกเวรเสมอ (ดู/อนุมัติคำขอทุกคน + export ไฟล์ได้ทันที)
//    ไม่ผูกกับตำแหน่ง/role ในตารางเวร เผื่อกรณีตำแหน่งเปลี่ยนหรือยังไม่ได้ตั้ง role ไว้
//    - นายชัยพร มอญแสง (ชัย) หัวหน้างาน 0849484577
//    - นายกิตติพงศ์ เขื่อนแก้ว (หนุ่ย) รองหัวหน้างาน 0882665403
//    - นายกานต์นิธิ ทองอร (โบ๊ท) 0861004536
//    ใช้ร่วมกันทั้ง 3 จุด: ล็อกอินแลกเวร (swapLogin) · อนุมัติ/สร้างเอกสาร · แก้ไขเวรรายช่อง (verifyDriverPhone → canEditSchedule)
var SWAP_ADMIN_PHONES = ['0849484577', '0882665403', '0861004536'];

/** swapLogin — ใช้ตรรกะเดียวกับ verifyDriverPhone (เบอร์โทรใน "ตารางเวร" หรือรหัสแอดมิน)
 *  เพิ่มเติม: หัวหน้างาน/รองหัวหน้างาน และเบอร์ใน SWAP_ADMIN_PHONES ได้สิทธิ์ isAdmin ในระบบแลกเวรด้วย
 *  (ดูประวัติของทุกคนได้ทันทีโดยไม่ต้องติ๊กช่อง, อนุมัติ/ปฏิเสธคำขอได้, export ไฟล์ได้) */
function swapLogin(payload) {
  var v = verifyDriverPhone(payload);
  if (v.status !== 'ok') return v;
  if (!v.isAdmin) {
    var role = String(v.role || '');
    if (role.indexOf('หัวหน้างาน') >= 0) v.isAdmin = true;
  }
  if (!v.isAdmin && SWAP_ADMIN_PHONES.indexOf(normalizePhone_(v.phone)) >= 0) {
    v.isAdmin = true;
  }
  return v;
}

// ── STAFF LIST ───────────────────────────────────────────────────────
function getSwapStaffList() {
  try {
    var staff = getSwapCombinedStaff_().map(function (s) {
      return { name: s.name, nick: s.nick, role: s.role };
    });
    return { status: 'ok', staff: staff };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── SHIFT DAYS ของคนคนหนึ่ง (เดือนนี้ + เดือนถัดไป) ──────────────────
function getMyShiftDays(params) {
  try {
    var name = String((params && params.name) || '').trim();
    if (!name) return { status: 'error', message: 'ไม่พบชื่อพนักงาน' };

    var cur = getWorktableSchedule();
    var next = getWorktableScheduleNext();

    function buildBlock(res) {
      if (res.status !== 'ok') return { month: null, year: null, days: [] };
      var person = findSwapStaff_(res.data, name);
      if (!person) return { month: res.month, year: res.year, days: [] };
      var days = Object.keys(person.schedule || {})
        .map(function (d) { return { day: Number(d), shift: person.schedule[d] }; })
        .sort(function (a, b) { return a.day - b.day; });
      return { month: res.month, year: res.year, days: days };
    }

    return { status: 'ok', current: buildBlock(cur), next: buildBlock(next) };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

// ── เขียนสลับเวรจริงลงชีท "ตารางเวร" / "ตารางเวรถัดไป" ───────────────
/** applySwapToSheet_ — สลับค่าเวรของ 2 คนใน 2 วันที่ต่างกันบนชีทเดียวกัน
 *  requesterName รับ targetDay/targetShift ไปแทน · targetName รับ requesterDay/requesterShift ไปแทน */
function applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบ sheet ' + sheetName);

  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }

  function findRow(nameOrNick) {
    for (var r = dataStartRow; r < data.length; r++) {
      var nm = String(data[r][0] || '').trim();
      var nk = String(data[r][1] || '').trim();
      if (nm === nameOrNick || nk === nameOrNick) return r; // 0-based index into data[]
    }
    return -1;
  }

  var reqRow = findRow(requesterName);
  var tgtRow = findRow(targetName);
  if (reqRow < 0) throw new Error('ไม่พบชื่อผู้ขอแลกในตารางเวร: ' + requesterName);
  if (tgtRow < 0) throw new Error('ไม่พบชื่อผู้รับแลกในตารางเวร: ' + targetName);
  if (reqRow === tgtRow) throw new Error('ผู้ขอแลกและผู้รับแลกตรงกับแถวเดียวกันในตารางเวร (ชื่อ/ชื่อเล่นอาจซ้ำกัน) — กรุณาตรวจสอบชื่อให้ถูกต้อง');

  var reqDayCol = rosterDayColumn_(sheetName, requesterDay);  // 1-based column — อ่านจากหัวตาราง (ไม่พึ่งตำแหน่งตายตัว)
  var tgtDayCol = rosterDayColumn_(sheetName, targetDay);

  // ✅ FIX: ถ้าทั้งคู่แลกกันในวันเดียวกัน (แค่สลับประเภทเวรของวันนั้น) ให้ "สลับค่าโดยตรง"
  //    เดิมโค้ดล้าง(setValue(''))แล้วเติมทีหลัง แยกเป็น 4 ขั้นตอนตามลำดับ reqDayCol แล้วค่อย tgtDayCol
  //    เมื่อ reqDayCol === tgtDayCol (วันเดียวกัน) ขั้นตอนที่ 4 (ล้างค่าของผู้รับแลกที่คอลัมน์ tgtDayCol)
  //    จะไปเขียนทับคอลัมน์เดียวกับที่เพิ่งใส่ค่าไว้ในขั้นตอนที่ 1 ทำให้ข้อมูลของผู้รับแลกหายไป (ว่างเปล่า)
  //    — นี่คือสาเหตุที่ "ข้อมูลในชีทหน้าตารางเวรหายไป" เวลาแลกเวรกันในวันเดียวกัน (กรณีที่พบบ่อยที่สุด)
  if (reqDayCol === tgtDayCol) {
    sheet.getRange(reqRow + 1, reqDayCol).setValue(targetShift);
    sheet.getRange(tgtRow + 1, reqDayCol).setValue(requesterShift);
  } else {
    // ผู้รับแลก (target) เข้าเวรแทนในวันเดิมของผู้ขอแลก
    sheet.getRange(tgtRow + 1, reqDayCol).setValue(requesterShift);
    sheet.getRange(reqRow + 1, reqDayCol).setValue('');
    // ผู้ขอแลก (requester) เข้าเวรแทนในวันเดิมของผู้รับแลก
    sheet.getRange(reqRow + 1, tgtDayCol).setValue(targetShift);
    sheet.getRange(tgtRow + 1, tgtDayCol).setValue('');
  }

  SpreadsheetApp.flush();
}

// ── ยกเวร (ให้ทางเดียว) — คนละฟังก์ชันกับการ "แลกเวร" (สลับกัน 2 ทาง) ──────
/** รวมค่าเวรของวันเดียวกัน เมื่อผู้รับเวรแทนมีเวรเดิมอยู่แล้ว: เก็บทั้งสองเวรไว้ในเซลล์เดียว
 *  คั่นด้วย "/" เช่น ผู้รับแลกมีเวร "ด" อยู่แล้ว รับเวร "ช1บ2" มาเพิ่ม → "ด/ช1บ2"
 *  ป้องกันการซ้ำ (เช่น กดยกเวรรายการเดิมซ้ำ) — ถ้ามีอยู่แล้วในรายการจะไม่ต่อซ้ำ */
function swapCombineShiftValues_(existingShift, newShift) {
  var e = String(existingShift == null ? '' : existingShift).trim();
  var n = String(newShift == null ? '' : newShift).trim();
  if (!e || e === '0') return n;
  if (!n || n === '0') return e;
  var parts = e.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.indexOf(n) >= 0) return e; // ยกเวรรายการเดียวกันซ้ำ — ไม่ต่อซ้ำ
  parts.push(n);
  return parts.join('/');
}

// ── ✅ NEW: แบ่งครึ่ง "เวรรวม" เช้าต่อบ่าย (16 ชม.) ออกเป็น 2 ส่วนอิสระ ──────────
/** เวรรวมเช้าต่อบ่าย เช่น "ช2บ1" แท้จริงแล้วคือคนคนเดียวทำงาน 2 ช่วงต่อกัน:
 *  ช่วงเช้า (ช2, 08.00-16.00) + ช่วงบ่าย (บ1, 16.00-00.00) — แต่ละช่วงเป็นเวรที่สมบูรณ์ในตัวเอง
 *  ฟังก์ชันนี้ใช้ตรวจสอบว่ารหัสเวรที่ส่งมาเป็นเวรรวมรูปแบบนี้หรือไม่ (ตรงตามรูปแบบ ช[1-3]บ[1-3] เป๊ะๆ
 *  เท่านั้น — ไม่รวมเวรที่ถูก "รวม" ไว้แล้วด้วย "/" เช่น "ด/ช2บ1" เพราะแบ่งต่ออีกชั้นแล้วจะสับสน)
 *  คืนค่า {am:'ช2', pm:'บ1'} ถ้าแบ่งได้ / null ถ้าแบ่งไม่ได้ (เวรเดี่ยว, ดึก, EMS ฯลฯ) */
function swapSplitCombinedShift_(code) {
  var s = String(code == null ? '' : code).trim();
  var m = /^(ช[1-3])(บ[1-3])$/.exec(s);
  if (!m) return null;
  return { am: m[1], pm: m[2] };
}

/** เขียน "ยกเวรให้" ลงชีทตารางเวรจริง — ต่างจาก applySwapToSheet_ (สลับ 2 ทาง):
 *  ผู้ให้เวร (requesterName) ปกติล้างเวรวันนั้นทิ้ง (ไม่มีเวรแล้ว) — ยกเว้นกรณี "ยกครึ่งเวร" (ดู
 *  swapSplitCombinedShift_) ที่ผู้ให้เวรยังคงเหลืออีกครึ่งหนึ่งไว้กับตัวเอง (remainingRequesterShift)
 *  ผู้รับเวรแทน (targetName) ได้ค่าเวร "รวม" ของเวรเดิม(ถ้ามี) + เวรที่รับมา (givenShift) ในเซลล์เดียวกัน (วันเดียวกัน)
 *  เพื่อเป็นหลักฐานว่าผู้รับเวรแทนทำงาน 2 เวรในวันนั้นจริง (สำหรับกลุ่มงานการเงินจ่ายเงินเวรให้ถูกคน)
 *  @param {string} givenShift  ค่าเวรที่ "ยกให้" จริง — เวรเต็มวัน (ยกทั้งเวร) หรือครึ่งเดียว (ช_ หรือ บ_) เมื่อยกครึ่งเวร
 *  @param {string} [remainingRequesterShift] ค่าเวรที่ผู้ให้เวรยังเหลือไว้เอง — ว่างเปล่า ('') = ยกทั้งเวร (ค่าเริ่มต้น) */
function applyGiveShiftToSheet_(monthSheet, requesterName, day, givenShift, targetName, existingTargetShift, remainingRequesterShift) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบ sheet ' + sheetName);

  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }

  function findRow(nameOrNick) {
    for (var r = dataStartRow; r < data.length; r++) {
      var nm = String(data[r][0] || '').trim();
      var nk = String(data[r][1] || '').trim();
      if (nm === nameOrNick || nk === nameOrNick) return r;
    }
    return -1;
  }

  var reqRow = findRow(requesterName);
  var tgtRow = findRow(targetName);
  if (reqRow < 0) throw new Error('ไม่พบชื่อผู้ให้เวรในตารางเวร: ' + requesterName);
  if (tgtRow < 0) throw new Error('ไม่พบชื่อผู้รับเวรแทนในตารางเวร: ' + targetName);
  if (reqRow === tgtRow) throw new Error('ผู้ให้เวรและผู้รับเวรแทนตรงกับแถวเดียวกันในตารางเวร (ชื่อ/ชื่อเล่นอาจซ้ำกัน) — กรุณาตรวจสอบชื่อให้ถูกต้อง');

  var dayCol = rosterDayColumn_(sheetName, day); // 1-based column — อ่านจากหัวตาราง สอดคล้องกับ applySwapToSheet_
  var combined = swapCombineShiftValues_(existingTargetShift, givenShift);

  sheet.getRange(tgtRow + 1, dayCol).setValue(combined);
  sheet.getRange(reqRow + 1, dayCol).setValue(remainingRequesterShift || '');

  SpreadsheetApp.flush();
  return combined;
}

/** ป้ายชื่อเวรอ่านง่าย รองรับค่าที่ถูก "รวม" ไว้ด้วย "/" จาก applyGiveShiftToSheet_ เช่น "ด/ช1บ2"
 *  → "เวรดึก (ด) 00.00-08.00 น. + เวรเช้า1ต่อบ่าย2 (ช1บ2) 08.00-00.00 น." ใช้ในบันทึกข้อความ */
function swapShiftLabelCombined_(code) {
  var s = String(code == null ? '' : code).trim();
  if (!s) return '';
  var parts = s.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length <= 1) return swapShiftLabel_(s);
  return parts.map(swapShiftLabel_).join(' + ');
}

/** เวอร์ชันสั้น ของ swapShiftLabelCombined_ สำหรับตาราง "ใบแลกเวร" (คอลัมน์แคบ) */
function swapReportShiftShortCombined_(code) {
  var s = String(code == null ? '' : code).trim();
  if (!s || s === '0') return 'ไม่มีเวร';
  var parts = s.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
  if (parts.length <= 1) return swapReportShiftShort_(s);
  return parts.map(swapReportShiftShort_).join(' + ');
}

// ── แปลงรหัสเวรเป็นข้อความอ่านง่าย พร้อมช่วงเวลา สำหรับใส่ในบันทึกข้อความ ──
//    เวรดึก/ด       = 00.00–08.00 น.
//    เวรเช้า/ช       = 08.00–16.00 น.
//    ช2บ1, ช1บ2     = 08.00–00.00 น. (เช้าต่อบ่าย รวม 16 ชม.)
//    บ1, บ2 (เดี่ยวๆ) = 16.00–00.00 น. (ครึ่งบ่ายที่ถูกแยกออกจากเวรรวม — ดู swapSplitCombinedShift_)
//    ช3(Ems)        = 08.00–16.00 น.
function swapShiftLabel_(code) {
  var s = String(code || '');
  var l = s.toLowerCase();
  if (l.indexOf('ช1บ2') === 0) return 'เวรเช้า1ต่อบ่าย2 (' + s + ') 08.00-00.00 น.';
  if (l.indexOf('ช2บ1') === 0) return 'เวรเช้า2ต่อบ่าย1 (' + s + ') 08.00-00.00 น.';
  // ✅ NEW: ครึ่งบ่ายที่ถูกแยกออกมาจากเวรรวม (ดู swapSplitCombinedShift_) เช่น "บ1", "บ2"
  if (l.indexOf('บ') === 0) return 'เวรบ่าย' + s.charAt(1) + ' (' + s + ') 16.00-00.00 น.';
  if (l.indexOf('ช3') === 0 && l.indexOf('ems') >= 0) return 'เวรเช้า 3 (EMS) (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ems') >= 0) return 'เวร EMS (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ด') === 0) return 'เวรดึก (' + s + ') 00.00-08.00 น.';
  if (l.indexOf('ช1') === 0) return 'เวรเช้า 1 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช2') === 0) return 'เวรเช้า 2 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช3') === 0) return 'เวรเช้า 3 (' + s + ') 08.00-16.00 น.';
  if (l.indexOf('ช') === 0) return 'เวรเช้า (' + s + ') 08.00-16.00 น.';
  return s;
}

/** วันที่แบบไทยเต็ม สำหรับหัวบันทึกข้อความ เช่น "10 กันยายน 2569" */
function swapThaiFullDate_(d) {
  var months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return d.getDate() + ' ' + months[d.getMonth() + 1] + ' ' + (d.getFullYear() + 543);
}

/** เดือน/ปี(ไทย) ของ monthSheet ปัจจุบันหรือถัดไป → ใช้ประกอบวันที่เต็มของแต่ละฝ่าย */
function swapMonthYearFor_(monthSheet) {
  var res = monthSheet === 'next' ? getWorktableScheduleNext() : getWorktableSchedule();
  if (res.status !== 'ok') return { month: new Date().getMonth() + 1, year: new Date().getFullYear() + 543 };
  return { month: Number(res.month), year: Number(res.year) };
}
function swapDayFullLabel_(day, monthSheet) {
  var my = swapMonthYearFor_(monthSheet);
  var months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
    'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return Number(day) + ' ' + (months[my.month] || '') + ' ' + my.year;
}

// ── ส่งคำขอแลกเวร ─────────────────────────────────────────────────────
/** ✅ NEW: payload.requestType — 'swap' (ค่าเริ่มต้น, แลกเวรสลับกัน 2 ทาง) หรือ 'give' (ยกเวรให้ ทางเดียว)
 *  โหมด 'give': ผู้รับเวรแทน (targetName) ไม่ต้องเลือกวันเวรของตัวเองมาแลก — ระบบจะยึด "วันเดียวกัน"
 *  กับผู้ให้เวร แล้วดึงเวรเดิมของผู้รับเวรแทนในวันนั้นมา "รวม" กับเวรที่รับมา (คั่นด้วย "/") ลงเซลล์เดียว
 *  แม้ผู้รับเวรแทนจะมีเวรอยู่แล้วในวันนั้นก็ยกเวรให้ได้ — เพื่อเป็นหลักฐานว่าทำงาน 2 เวรจริงในวันเดียว */
function submitSwapRequest(payload) {
  try {
    // ✅ FIX (บั๊กสิทธิ์แอดมินแลกเวร): เดิมเรียก verifyDriverPhone() ตรงๆ ซึ่งให้ isAdmin=true
    // เฉพาะรหัสแอดมินหลัก (WORKTABLE_ADMIN_CODE) เท่านั้น — ไม่รู้จักเบอร์ใน SWAP_ADMIN_PHONES
    // (อีก 2 ไอดีที่อนุญาตให้เป็นแอดมินระบบแลกเวรได้ แม้ไม่ใช่หัวหน้างาน) ที่ swapLogin() ใช้ตอน
    // ล็อกอิน ผลคือคนที่ล็อกอินแล้วเห็น UI สิทธิ์แอดมิน (เพราะ session.isAdmin จาก swapLogin ถูก
    // ต้อง) แต่พอส่งคำขอแทนคนอื่นจริงจะถูกปฏิเสธสิทธิ์ที่ฝั่งเซิร์ฟเวอร์ (v.isAdmin เป็น false)
    // ใหม่: ใช้ swapLogin() แทน — ตรวจสอบเบอร์เหมือนเดิมทุกอย่าง แต่เพิ่มการเช็ค
    // SWAP_ADMIN_PHONES ให้ตรงกับตอนล็อกอินเสมอ
    var v = swapLogin({ phone: payload && payload.requesterPhone });
    if (v.status !== 'ok') return v;

    var requesterName = v.name;
    var isAdminReq = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;

    var isGive = String((payload && payload.requestType) || '') === 'give';
    var requestTypeLabel = isGive ? 'ยกเวร' : 'แลกเวร';
    // ✅ NEW: โหมด "ยกเวร" เฉพาะเวรรวมเช้า-บ่าย (เช่น ช2บ1) เลือกได้ว่าจะยก 'full' (ทั้งเวร, ค่าเริ่มต้น)
    //    'am' (เฉพาะครึ่งเช้า คงครึ่งบ่ายไว้เอง) หรือ 'pm' (เฉพาะครึ่งบ่าย คงครึ่งเช้าไว้เอง)
    var giveScope = isGive ? String((payload && payload.giveScope) || 'full') : 'full';
    if (giveScope !== 'am' && giveScope !== 'pm') giveScope = 'full';

    var monthSheet = (payload && payload.monthSheet) === 'next' ? 'next' : 'current';
    var targetName = String((payload && payload.targetName) || '').trim();
    var requesterDay = Number(payload && payload.requesterDay);
    var requesterShift = String((payload && payload.requesterShift) || '');
    // โหมด "ยกเวร": วันของผู้รับเวรแทน = วันเดียวกับผู้ให้เวรเสมอ (ไม่ต้องรับค่าจากฟอร์ม)
    var targetDay = isGive ? requesterDay : Number(payload && payload.targetDay);
    var targetShift = isGive ? '' : String((payload && payload.targetShift) || '');
    var reason = String((payload && payload.reason) || '').trim();

    var staffAll = getSwapCombinedStaff_();

    // ✅ NEW: แอดมิน (WORKTABLE_ADMIN_CODE) สามารถยื่น/แลกเวรแทนพนักงานคนใดก็ได้ทั้ง 2 ฝั่ง
    //    โดยระบุ payload.requesterName มาด้วย — ไม่ต้องเข้าสู่ระบบด้วยเบอร์โทรของพนักงานคนนั้นเอง
    var actingName = v.name; // ชื่อผู้ทำรายการจริง (เก็บไว้บันทึกลงคอลัมน์ "ดำเนินการโดย")
    if (v.isAdmin && payload && payload.requesterName) {
      requesterName = String(payload.requesterName).trim();
      if (!findSwapStaff_(staffAll, requesterName)) {
        return { status: 'error', message: 'ไม่พบชื่อพนักงานคนที่ 1 (ผู้ให้เวร) ในตารางเวร' };
      }
    }

    if (!requesterName) return { status: 'error', message: 'กรุณาเลือกพนักงานคนที่ 1 (ผู้ให้เวร)' };
    if (!targetName) return { status: 'error', message: 'กรุณาเลือกเพื่อนร่วมงานที่จะ' + requestTypeLabel + 'ด้วย' };
    if (!requesterDay || !requesterShift) return { status: 'error', message: 'ข้อมูลวันเวรของคุณไม่ถูกต้อง' };
    if (!isGive && (!targetDay || !targetShift)) return { status: 'error', message: 'ข้อมูลวันเวรของเพื่อนร่วมงานไม่ถูกต้อง' };
    if (!reason) return { status: 'error', message: 'กรุณาระบุเหตุผลการ' + requestTypeLabel };
    if (!payload || !payload.consent) return { status: 'error', message: 'กรุณายืนยันว่าตกลงกับเพื่อนร่วมงานแล้ว' };

    if (!findSwapStaff_(staffAll, targetName)) {
      return { status: 'error', message: 'ไม่พบชื่อเพื่อนร่วมงานในตารางเวร' };
    }
    if (targetName === requesterName) {
      return { status: 'error', message: 'ไม่สามารถ' + requestTypeLabel + 'กับตัวเองได้' };
    }

    // ✅ ป้องกันการขอแลกเวร/ยกเวรทับซ้อน/ผิดปกติ — เช็คฝั่งเซิร์ฟเวอร์เป็นด่านสุดท้ายเสมอ
    //    (กันข้อมูลค้างจากหน้าจอที่เปิดทิ้งไว้นาน หรือกดส่งซ้ำ/ส่งพร้อมกันจากหลายอุปกรณ์)
    // 1) วันเวรนี้มีคำขออื่น "รอตรวจสอบ" ค้างอยู่แล้วหรือไม่ (ทั้งฝั่งผู้ให้เวรและผู้รับเวรแทน)
    var reqPending = findSwapDayConflicts_(monthSheet, requesterName, requesterDay)
      .filter(function (c) { return c.status === 'รอตรวจสอบ'; });
    if (reqPending.length) {
      return {
        status: 'error',
        message: 'วันเวรของ ' + requesterName + ' วันที่ ' + requesterDay +
          ' มีคำขอแลกเวรอื่นรอตรวจสอบอยู่แล้ว (กับ ' + reqPending[0].withName + ') กรุณารอผลคำขอเดิมก่อน หรือแจ้งแอดมินให้ปฏิเสธคำขอเดิมก่อนยื่นใหม่'
      };
    }
    // โหมด "ยกเวร" ตั้งใจอนุญาตให้ผู้รับเวรแทนมีเวรอนุมัติแล้วในวันนั้นอยู่ก่อนได้ (นั่นคือจุดประสงค์ของฟีเจอร์นี้)
    // จึงเช็คเฉพาะคำขอ "รอตรวจสอบ" อื่นที่ค้างอยู่บนวันเดียวกันของผู้รับเวรแทน กันการยื่นซ้อนกันเท่านั้น
    var tgtPending = findSwapDayConflicts_(monthSheet, targetName, targetDay)
      .filter(function (c) { return c.status === 'รอตรวจสอบ'; });
    if (tgtPending.length) {
      return {
        status: 'error',
        message: 'วันเวรของ ' + targetName + ' วันที่ ' + targetDay +
          ' มีคำขอแลกเวรอื่นรอตรวจสอบอยู่แล้ว (กับ ' + tgtPending[0].withName + ') กรุณารอผลคำขอเดิมก่อน หรือแจ้งแอดมินให้ปฏิเสธคำขอเดิมก่อนยื่นใหม่'
      };
    }
    // 2) ข้อมูลเวรที่ส่งมาต้องตรงกับตารางเวร "จริง" ในขณะนี้ — กันกรณีวันนั้นถูกแลกไปแล้ว
    //    โดยคำขออื่นที่เพิ่งอนุมัติไป ระหว่างที่หน้าจอฝั่งผู้ใช้เปิดค้างไว้
    var actualReqShift = getActualShiftForCell_(monthSheet, requesterName, requesterDay);
    if (actualReqShift === null) {
      return { status: 'error', message: 'ไม่พบชื่อ ' + requesterName + ' ในตารางเวร' };
    }
    if (String(actualReqShift) !== String(requesterShift)) {
      return {
        status: 'error',
        message: 'ข้อมูลเวรของ ' + requesterName + ' วันที่ ' + requesterDay +
          ' มีการเปลี่ยนแปลงไปแล้ว (อาจถูกแลกไปก่อนหน้านี้) กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'
      };
    }

    // ✅ NEW: ถ้าเลือกยกเฉพาะครึ่งเวร (giveScope !== 'full') ต้องแบ่งเวรจริง (requesterShift ที่เพิ่ง
    //    ตรวจสอบตรงกับตารางเวรสดด้านบนแล้ว) ออกเป็น 2 ส่วน — ใช้ส่วนที่ "ยกให้" (givenShift) แทน
    //    requesterShift เต็มวันในการรวมเวรของผู้รับเวรแทน และเก็บส่วนที่เหลือ (remainingReqShift) ไว้
    //    ให้ผู้ให้เวรเอง (ไม่ล้างทิ้งเหมือนยกทั้งเวร)
    var givenShift = requesterShift;
    var remainingReqShift = '';
    if (isGive && giveScope !== 'full') {
      var splitParts = swapSplitCombinedShift_(requesterShift);
      if (!splitParts) {
        return {
          status: 'error',
          message: 'เวรของ ' + requesterName + ' วันที่ ' + requesterDay + ' (' + requesterShift + ') ' +
            'ไม่ใช่เวรรวมเช้า-บ่ายที่แบ่งครึ่งได้ (ต้องเป็นรูปแบบ เช้า+บ่าย เช่น ช1บ2 หรือ ช2บ1 เท่านั้น) กรุณาเลือก "ยกทั้งเวร" แทน'
        };
      }
      givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
      remainingReqShift = (giveScope === 'am') ? splitParts.pm : splitParts.am;
    }

    var actualTgtShift;
    if (isGive) {
      // ✅ โหมด "ยกเวร": ไม่รับ targetShift จากฟอร์ม — ดึงเวร "ปัจจุบันจริง" ของผู้รับเวรแทนในวันนั้นจากชีทเสมอ
      //    (อาจว่างเปล่า หมายถึงยังไม่มีเวร หรือมีอยู่แล้ว หมายถึงจะถูกนำไปรวมกับเวรที่รับมา)
      actualTgtShift = getActualShiftForCell_(monthSheet, targetName, targetDay);
      if (actualTgtShift === null) {
        return { status: 'error', message: 'ไม่พบชื่อ ' + targetName + ' ในตารางเวร' };
      }
      targetShift = String(actualTgtShift == null || actualTgtShift === 0 ? '' : actualTgtShift);
    } else {
      actualTgtShift = getActualShiftForCell_(monthSheet, targetName, targetDay);
      if (actualTgtShift === null) {
        return { status: 'error', message: 'ไม่พบชื่อ ' + targetName + ' ในตารางเวร' };
      }
      if (String(actualTgtShift) !== String(targetShift)) {
        return {
          status: 'error',
          message: 'ข้อมูลเวรของ ' + targetName + ' วันที่ ' + targetDay +
            ' มีการเปลี่ยนแปลงไปแล้ว (อาจถูกแลกไปก่อนหน้านี้) กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง'
        };
      }
    }

    var requestId = generateSwapRequestId_();
    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    var sheet = getSwapRequestsSheet_();
    var idx = jobsHeaderIndex_(sheet.getDataRange().getValues()[0]);
    // ✅ [ยกเวรให้] นำหน้าเหตุผลไว้ในบันทึก — ให้เห็นชัดทั้งในหน้าประวัติและ "ใบแลกเวร" ที่ยื่นฝ่ายการเงิน
    //    ✅ NEW: กรณียกครึ่งเวร ระบุชัดว่ายกส่วนไหน เหลือส่วนไหนไว้เอง กันสับสนตอนตรวจสอบย้อนหลัง
    var reasonForRecord = reason;
    if (isGive) {
      reasonForRecord = (giveScope !== 'full')
        ? '[ยกครึ่งเวร: ยก ' + givenShift + ' ให้ ' + targetName + ' / คงเหลือ ' + remainingReqShift + ' ไว้กับตนเอง] ' + reason
        : '[ยกเวรให้] ' + reason;
    }

    if (isAdminReq) {
      // แอดมิน/หัวหน้างาน ยื่นเอง → อนุมัติทันที + เขียนตารางจริง + สร้างบันทึกข้อความ
      var resultShift;
      if (isGive) {
        resultShift = applyGiveShiftToSheet_(monthSheet, requesterName, requesterDay, givenShift, targetName, targetShift, remainingReqShift);
      } else {
        applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift);
      }

      var memo = generateSwapMemoDoc({
        requesterName: requesterName,
        targetName: targetName,
        reason: reasonForRecord,
        oldDate: swapDayFullLabel_(requesterDay, monthSheet),
        oldShift: swapShiftLabel_(requesterShift),
        targetDate: swapDayFullLabel_(targetDay, monthSheet),
        targetShift: isGive ? swapShiftLabelCombined_(resultShift) : swapShiftLabel_(targetShift)
      });

      sheet.appendRow(buildSwapRequestRow_(idx, {
        'RequestID': requestId, 'เดือน': monthSheet, 'ชื่อผู้ขอแลก': requesterName, 'เบอร์ผู้ขอแลก': v.phone,
        'วันที่เดิมของผู้ขอแลก': requesterDay, 'เวรเดิมของผู้ขอแลก': requesterShift,
        'ชื่อผู้รับแลก': targetName, 'วันที่เดิมของผู้รับแลก': targetDay, 'เวรเดิมของผู้รับแลก': targetShift,
        'เหตุผล': reasonForRecord, 'สถานะ': 'อนุมัติอัตโนมัติ (แอดมิน)', 'บันทึกเมื่อ': now,
        'ดำเนินการโดย': actingName, 'ดำเนินการเมื่อ': now, 'เหตุผลที่ปฏิเสธ': '',
        'DocURL': memo.docUrl || '', 'PdfURL': memo.pdfUrl || '',
        'ประเภทคำขอ': requestTypeLabel, 'ส่วนที่ยก': giveScope
      }));

      return { status: 'ok', autoApproved: true, requestId: requestId, memo: memo };
    }

    sheet.appendRow(buildSwapRequestRow_(idx, {
      'RequestID': requestId, 'เดือน': monthSheet, 'ชื่อผู้ขอแลก': requesterName, 'เบอร์ผู้ขอแลก': v.phone,
      'วันที่เดิมของผู้ขอแลก': requesterDay, 'เวรเดิมของผู้ขอแลก': requesterShift,
      'ชื่อผู้รับแลก': targetName, 'วันที่เดิมของผู้รับแลก': targetDay, 'เวรเดิมของผู้รับแลก': targetShift,
      'เหตุผล': reasonForRecord, 'สถานะ': 'รอตรวจสอบ', 'บันทึกเมื่อ': now,
      'ดำเนินการโดย': '', 'ดำเนินการเมื่อ': '', 'เหตุผลที่ปฏิเสธ': '',
      'DocURL': '', 'PdfURL': '',
      'ประเภทคำขอ': requestTypeLabel, 'ส่วนที่ยก': giveScope
    }));

    return { status: 'ok', autoApproved: false, requestId: requestId };
  } catch (err) {
    console.error('submitSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── รายการรอตรวจสอบ (แอดมิน/หัวหน้างาน) ──────────────────────────────
function getPendingSwapRequests() {
  try {
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') continue;
      out.push({
        requestId: row[idx['RequestID']],
        monthSheet: row[idx['เดือน']],
        requesterName: row[idx['ชื่อผู้ขอแลก']],
        requesterDay: row[idx['วันที่เดิมของผู้ขอแลก']],
        requesterShift: row[idx['เวรเดิมของผู้ขอแลก']],
        targetName: row[idx['ชื่อผู้รับแลก']],
        targetDay: row[idx['วันที่เดิมของผู้รับแลก']],
        targetShift: row[idx['เวรเดิมของผู้รับแลก']],
        reason: row[idx['เหตุผล']],
        status: row[idx['สถานะ']],
        createdAt: row[idx['บันทึกเมื่อ']],
        // ✅ NEW: 'ยกเวร' (ให้ทางเดียว) หรือ 'แลกเวร' (สลับ 2 ทาง) — ดูค่าเริ่มต้นเผื่อคำขอเก่าก่อนมีคอลัมน์นี้
        requestType: (idx['ประเภทคำขอ'] != null && row[idx['ประเภทคำขอ']]) ? row[idx['ประเภทคำขอ']] : 'แลกเวร',
        // ✅ NEW: 'full' (ยกทั้งเวร) / 'am' (เฉพาะครึ่งเช้า) / 'pm' (เฉพาะครึ่งบ่าย) — ดูค่าเริ่มต้นเผื่อคำขอเก่า
        giveScope: (idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']]) ? row[idx['ส่วนที่ยก']] : 'full'
      });
    }
    out.reverse(); // ใหม่สุดก่อน
    return { status: 'ok', requests: out };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function findSwapRequestRow_(sheet, requestId) {
  var data = sheet.getDataRange().getValues();
  var idx = jobsHeaderIndex_(data[0]);
  for (var r = 1; r < data.length; r++) {
    if (String(data[r][idx['RequestID']]) === String(requestId)) {
      return { rowNum: r + 1, row: data[r], idx: idx };
    }
  }
  return null;
}

// ── อนุมัติคำขอ ───────────────────────────────────────────────────────
function approveSwapRequest(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ — เดิม verifyDriverPhone() ไม่รู้จัก
    // SWAP_ADMIN_PHONES (อีก 2 ไอดีที่ได้สิทธิ์แอดมินระบบแลกเวรแม้ไม่ใช่หัวหน้างาน) ทำให้คนกลุ่มนี้
    // ล็อกอินเห็น UI สิทธิ์แอดมิน (ปุ่มอนุมัติ/ปฏิเสธ) แต่กดอนุมัติจริงแล้วโดนปฏิเสธสิทธิ์เสมอ
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์อนุมัติคำขอแลกเวร' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx, row = found.row;
    if (String(row[idx['สถานะ']]) !== 'รอตรวจสอบ') {
      return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' };
    }

    var monthSheet = row[idx['เดือน']];
    var requesterName = row[idx['ชื่อผู้ขอแลก']];
    var requesterDay = row[idx['วันที่เดิมของผู้ขอแลก']];
    var requesterShift = row[idx['เวรเดิมของผู้ขอแลก']];
    var targetName = row[idx['ชื่อผู้รับแลก']];
    var targetDay = row[idx['วันที่เดิมของผู้รับแลก']];
    var targetShift = row[idx['เวรเดิมของผู้รับแลก']];
    var reason = row[idx['เหตุผล']];
    var isGive = idx['ประเภทคำขอ'] != null && String(row[idx['ประเภทคำขอ']] || '') === 'ยกเวร';
    // ✅ NEW: 'full' (ยกทั้งเวร, ค่าเริ่มต้น) / 'am' / 'pm' — ใช้แบ่งครึ่ง requesterShift (เก็บเป็นเวรรวมเต็ม
    //    ในคอลัมน์ 'เวรเดิมของผู้ขอแลก' เสมอ ไม่ว่าจะยกทั้งเวรหรือครึ่งเดียว) ตอนเขียนลงตารางเวรจริง
    var giveScope = idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']] ? String(row[idx['ส่วนที่ยก']]) : 'full';

    var memoTargetShiftLabel;
    if (isGive) {
      var givenShift = requesterShift;
      var remainingReqShift = '';
      if (giveScope !== 'full') {
        var splitParts = swapSplitCombinedShift_(requesterShift);
        if (splitParts) {
          givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
          remainingReqShift = (giveScope === 'am') ? splitParts.pm : splitParts.am;
        }
        // หมายเหตุ: ถ้าแบ่งไม่ได้ (ข้อมูลผิดปกติ) จะ fallback เป็นยกทั้งเวรเหมือนเดิม เพื่อไม่ให้คำขอค้าง
      }
      var resultShift = applyGiveShiftToSheet_(monthSheet, requesterName, requesterDay, givenShift, targetName, targetShift, remainingReqShift);
      memoTargetShiftLabel = swapShiftLabelCombined_(resultShift);
    } else {
      applySwapToSheet_(monthSheet, requesterName, requesterDay, requesterShift, targetName, targetDay, targetShift);
      memoTargetShiftLabel = swapShiftLabel_(targetShift);
    }

    var memo = generateSwapMemoDoc({
      requesterName: requesterName,
      targetName: targetName,
      reason: reason,
      oldDate: swapDayFullLabel_(requesterDay, monthSheet),
      oldShift: swapShiftLabel_(requesterShift),
      targetDate: swapDayFullLabel_(targetDay, monthSheet),
      targetShift: memoTargetShiftLabel
    });

    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sheet.getRange(found.rowNum, idx['สถานะ'] + 1).setValue('อนุมัติแล้ว');
    sheet.getRange(found.rowNum, idx['ดำเนินการโดย'] + 1).setValue(v.name);
    sheet.getRange(found.rowNum, idx['ดำเนินการเมื่อ'] + 1).setValue(now);
    sheet.getRange(found.rowNum, idx['DocURL'] + 1).setValue(memo.docUrl || '');
    sheet.getRange(found.rowNum, idx['PdfURL'] + 1).setValue(memo.pdfUrl || '');

    return { status: 'ok', memo: memo };
  } catch (err) {
    console.error('approveSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── สร้าง/สร้างใหม่เอกสารบันทึกข้อความ สำหรับคำขอที่อนุมัติแล้ว ──────────
// ✅ NEW: ใช้กับปุ่ม "สร้างเอกสาร" ในหน้ารออนุมัติ (หลังกดอนุมัติ) และหน้าประวัติ
//    เพื่อสร้าง/สร้างใหม่เอกสารได้ทันทีโดยไม่ต้องรออนุมัติซ้ำ — เช่น กรณีสร้างเอกสารครั้งแรกไม่สำเร็จ
//    หรือต้องการสร้างใหม่ด้วยเทมเพลตล่าสุด
function regenerateSwapMemo(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ (ดูคำอธิบายเดียวกับ approveSwapRequest)
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์สร้างเอกสารนี้' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx, row = found.row;

    var status = String(row[idx['สถานะ']] || '');
    if (status.indexOf('อนุมัติ') < 0) {
      return { status: 'error', message: 'สร้างเอกสารได้เฉพาะคำขอที่อนุมัติแล้วเท่านั้น' };
    }

    var monthSheet     = row[idx['เดือน']];
    var requesterName  = row[idx['ชื่อผู้ขอแลก']];
    var requesterDay   = row[idx['วันที่เดิมของผู้ขอแลก']];
    var requesterShift = row[idx['เวรเดิมของผู้ขอแลก']];
    var targetName     = row[idx['ชื่อผู้รับแลก']];
    var targetDay      = row[idx['วันที่เดิมของผู้รับแลก']];
    var targetShift    = row[idx['เวรเดิมของผู้รับแลก']];
    var reason         = row[idx['เหตุผล']];
    var isGive         = idx['ประเภทคำขอ'] != null && String(row[idx['ประเภทคำขอ']] || '') === 'ยกเวร';
    // ✅ NEW: 'full' (ยกทั้งเวร, ค่าเริ่มต้น) / 'am' / 'pm' — แบ่งครึ่ง requesterShift ก่อนคำนวณผลรวม
    var giveScope = idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']] ? String(row[idx['ส่วนที่ยก']]) : 'full';
    var givenShift = requesterShift;
    if (isGive && giveScope !== 'full') {
      var splitParts = swapSplitCombinedShift_(requesterShift);
      if (splitParts) givenShift = (giveScope === 'am') ? splitParts.am : splitParts.pm;
    }
    // ✅ NEW: โหมด "ยกเวร" แสดงผลรวมของเวรเดิม+เวรที่รับมาในเอกสาร (เช่น "ด/ช1บ2" หรือ "ด/บ1" ถ้ายกครึ่งเวร) ให้ตรงกับตารางเวรจริง
    var memoTargetShiftLabel = isGive
      ? swapShiftLabelCombined_(swapCombineShiftValues_(targetShift, givenShift))
      : swapShiftLabel_(targetShift);

    var memo = generateSwapMemoDoc({
      requesterName: requesterName,
      targetName: targetName,
      reason: reason,
      oldDate: swapDayFullLabel_(requesterDay, monthSheet),
      oldShift: swapShiftLabel_(requesterShift),
      targetDate: swapDayFullLabel_(targetDay, monthSheet),
      targetShift: memoTargetShiftLabel
    });

    if (memo.status === 'ok') {
      sheet.getRange(found.rowNum, idx['DocURL'] + 1).setValue(memo.docUrl || '');
      sheet.getRange(found.rowNum, idx['PdfURL'] + 1).setValue(memo.pdfUrl || '');
    }

    return { status: 'ok', memo: memo };
  } catch (err) {
    console.error('regenerateSwapMemo error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── ปฏิเสธคำขอ ───────────────────────────────────────────────────────
function rejectSwapRequest(payload) {
  try {
    // ✅ FIX: ใช้ swapLogin() แทน verifyDriverPhone() ตรงๆ (ดูคำอธิบายเดียวกับ approveSwapRequest)
    var v = swapLogin({ phone: payload && payload.approverPhone });
    if (v.status !== 'ok') return v;
    var isApprover = !!v.isAdmin || String(v.role || '').indexOf('หัวหน้างาน') >= 0;
    if (!isApprover) return { status: 'error', message: 'คุณไม่มีสิทธิ์ปฏิเสธคำขอแลกเวร' };

    var sheet = getSwapRequestsSheet_();
    var found = findSwapRequestRow_(sheet, payload && payload.requestId);
    if (!found) return { status: 'error', message: 'ไม่พบคำขอนี้' };
    var idx = found.idx;
    if (String(found.row[idx['สถานะ']]) !== 'รอตรวจสอบ') {
      return { status: 'error', message: 'คำขอนี้ถูกดำเนินการไปแล้ว' };
    }

    var now = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm:ss');
    sheet.getRange(found.rowNum, idx['สถานะ'] + 1).setValue('ปฏิเสธ');
    sheet.getRange(found.rowNum, idx['ดำเนินการโดย'] + 1).setValue(v.name);
    sheet.getRange(found.rowNum, idx['ดำเนินการเมื่อ'] + 1).setValue(now);
    sheet.getRange(found.rowNum, idx['เหตุผลที่ปฏิเสธ'] + 1).setValue(String((payload && payload.reason) || ''));

    return { status: 'ok' };
  } catch (err) {
    console.error('rejectSwapRequest error:', err);
    return { status: 'error', message: err.message };
  }
}

// ── ประวัติการแลกเวร ─────────────────────────────────────────────────
function getSwapHistory(params) {
  try {
    var phone = normalizePhone_((params && params.phone) || '');
    var sheet = getSwapRequestsSheet_();
    var data = sheet.getDataRange().getValues();
    var idx = jobsHeaderIndex_(data[0]);
    var out = [];
    for (var r = 1; r < data.length; r++) {
      var row = data[r];
      if (phone && normalizePhone_(row[idx['เบอร์ผู้ขอแลก']]) !== phone) continue;
      out.push({
        requestId: row[idx['RequestID']],
        requesterName: row[idx['ชื่อผู้ขอแลก']],
        requesterDay: row[idx['วันที่เดิมของผู้ขอแลก']],
        requesterShift: row[idx['เวรเดิมของผู้ขอแลก']],
        targetName: row[idx['ชื่อผู้รับแลก']],
        targetDay: row[idx['วันที่เดิมของผู้รับแลก']],
        targetShift: row[idx['เวรเดิมของผู้รับแลก']],
        reason: row[idx['เหตุผล']],
        status: row[idx['สถานะ']],
        createdAt: row[idx['บันทึกเมื่อ']],
        decidedBy: row[idx['ดำเนินการโดย']],
        decidedAt: row[idx['ดำเนินการเมื่อ']],
        rejectReason: row[idx['เหตุผลที่ปฏิเสธ']],
        docUrl: row[idx['DocURL']],
        pdfUrl: row[idx['PdfURL']],
        // ✅ NEW: 'ยกเวร' (ให้ทางเดียว) หรือ 'แลกเวร' (สลับ 2 ทาง) — ดูค่าเริ่มต้นเผื่อคำขอเก่าก่อนมีคอลัมน์นี้
        requestType: (idx['ประเภทคำขอ'] != null && row[idx['ประเภทคำขอ']]) ? row[idx['ประเภทคำขอ']] : 'แลกเวร',
        // ✅ NEW: 'full' (ยกทั้งเวร) / 'am' (เฉพาะครึ่งเช้า) / 'pm' (เฉพาะครึ่งบ่าย) — ดูค่าเริ่มต้นเผื่อคำขอเก่า
        giveScope: (idx['ส่วนที่ยก'] != null && row[idx['ส่วนที่ยก']]) ? row[idx['ส่วนที่ยก']] : 'full'
      });
    }
    out.reverse(); // ใหม่สุดก่อน
    return { status: 'ok', requests: out };
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

function setupSwapRequestsSheet() {
  getSwapRequestsSheet_();
  return { status: 'ok', message: 'ตั้งค่า sheet SwapRequests เรียบร้อยแล้ว' };
}

// ═══════════════════════════════════════════════════════════════════
//  ป้องกันการขอแลกเวรทับซ้อน / ผิดปกติ
//  - checkSwapConflicts: เรียกจากหน้าเว็บ (ก่อนส่งคำขอ) เพื่อ "เตือน" ผู้ใช้ ไม่บล็อก
//  - ด่านบังคับจริง (บล็อกการบันทึก) อยู่ใน submitSwapRequest ด้านบน — เช็คซ้ำที่นี่เผื่อ
//    ผู้ใช้ข้ามหน้าเว็บ (เช่น เรียก API ตรงๆ) หรือข้อมูลบนจอค้างจากตอนโหลดหน้า
// ═══════════════════════════════════════════════════════════════════

/** สถานะที่ถือว่า "ยังมีผลอยู่" ของคำขอแลกเวร (ไม่ใช่ถูกปฏิเสธ) — ใช้ตรวจว่าวันเวรนี้
 *  เคยถูกใช้ไปแล้ว (อนุมัติแล้ว) หรือยังมีคำขอค้างอยู่ (รอตรวจสอบ) */
function swapStatusIsActive_(status) {
  var s = String(status || '');
  return s === 'รอตรวจสอบ' || s.indexOf('อนุมัติ') === 0;
}

/** หาคำขอแลกเวร (ที่ยังไม่ถูกปฏิเสธ) ที่เกี่ยวข้องกับ "คนคนหนึ่ง" ในวันที่หนึ่ง ของเดือนหนึ่ง
 *  ไม่ว่าคนนั้นจะเคยเป็นฝั่งผู้ขอแลกหรือผู้รับแลกในคำขอเดิมก็ตาม */
function findSwapDayConflicts_(monthSheet, personName, day) {
  var sheet = getSwapRequestsSheet_();
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  var idx = jobsHeaderIndex_(data[0]);
  var out = [];
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    if (String(row[idx['เดือน']]) !== String(monthSheet)) continue;
    if (!swapStatusIsActive_(row[idx['สถานะ']])) continue;

    var isRequesterSide = row[idx['ชื่อผู้ขอแลก']] === personName &&
      Number(row[idx['วันที่เดิมของผู้ขอแลก']]) === Number(day);
    var isTargetSide = row[idx['ชื่อผู้รับแลก']] === personName &&
      Number(row[idx['วันที่เดิมของผู้รับแลก']]) === Number(day);
    if (!isRequesterSide && !isTargetSide) continue;

    out.push({
      requestId: row[idx['RequestID']],
      status: row[idx['สถานะ']],
      withName: isRequesterSide ? row[idx['ชื่อผู้รับแลก']] : row[idx['ชื่อผู้ขอแลก']],
      createdAt: row[idx['บันทึกเมื่อ']],
      decidedAt: row[idx['ดำเนินการเมื่อ']]
    });
  }
  return out;
}

/** เรียกจากหน้าเว็บ swap.html ก่อนส่งคำขอจริง — เช็คว่าวันเวรของ "ผู้ขอแลก" และ/หรือ "ผู้รับแลก"
 *  เคยมี/มีคำขอแลกเวรอยู่แล้วในเดือนเดียวกันหรือไม่ เพื่อแสดงคำเตือนบนหน้าจอ
 *  (ไม่บล็อกอัตโนมัติที่นี่ — ด่านบล็อกจริงอยู่ใน submitSwapRequest) */
function checkSwapConflicts(payload) {
  try {
    var monthSheet = (payload && payload.monthSheet) === 'next' ? 'next' : 'current';
    var requesterName = String((payload && payload.requesterName) || '').trim();
    var requesterDay = Number(payload && payload.requesterDay);
    var targetName = String((payload && payload.targetName) || '').trim();
    var targetDay = Number(payload && payload.targetDay);

    var result = { status: 'ok', requesterConflicts: [], targetConflicts: [] };
    if (requesterName && requesterDay) {
      result.requesterConflicts = findSwapDayConflicts_(monthSheet, requesterName, requesterDay);
    }
    if (targetName && targetDay) {
      result.targetConflicts = findSwapDayConflicts_(monthSheet, targetName, targetDay);
    }
    return result;
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

/** อ่านค่าเวร "จริง" ปัจจุบันของคนคนหนึ่งในวันหนึ่ง จากชีทตารางเวร (ไม่ใช่ค่าที่ส่งมาจากหน้าเว็บ)
 *  ใช้ตรวจสอบความผิดปกติ/ข้อมูลล้าสมัยก่อนบันทึกคำขอแลกเวรจริง เช่น กรณีเปิดหน้าจอค้างไว้นาน
 *  แล้ววันเวรนั้นถูกแลกไปแล้วโดยคำขออื่นที่อนุมัติไปก่อนหน้า — คืนค่า null ถ้าไม่พบชื่อในตาราง */
function getActualShiftForCell_(monthSheet, nameOrNick, day) {
  var ss = getWorktableSpreadsheet();
  var sheetName = monthSheet === 'next' ? SHEET_WORKTABLE_NEXT : SHEET_WORKTABLE;
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return null;
  var data = sheet.getDataRange().getValues();
  var dataStartRow = 3;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var v = String(data[i][0] || '').trim();
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { dataStartRow = i + 1; break; }
  }
  for (var r = dataStartRow; r < data.length; r++) {
    var nm = String(data[r][0] || '').trim();
    var nk = String(data[r][1] || '').trim();
    if (nm === nameOrNick || nk === nameOrNick) {
      var col = rosterDayColumn_(sheetName, day); // 1-based column — อ่านจากหัวตาราง สอดคล้องกับ applySwapToSheet_
      return data[r][col - 1];
    }
  }
  return null;
}

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