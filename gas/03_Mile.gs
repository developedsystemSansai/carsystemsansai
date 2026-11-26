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
