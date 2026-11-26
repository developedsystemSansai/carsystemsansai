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
