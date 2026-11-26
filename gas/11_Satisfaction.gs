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
