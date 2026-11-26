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
