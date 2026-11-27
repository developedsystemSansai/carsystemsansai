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
