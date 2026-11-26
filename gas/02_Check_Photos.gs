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
