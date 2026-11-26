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
