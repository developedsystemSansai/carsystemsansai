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
//  รันซ้ำได้ปลอดภัย (ตรวจชื่อซ้ำก่อนเขียนทุกจุด; ถ้ามีชื่ออยู่แล้วจะเติมเฉพาะชื่อเล่น/เบอร์ที่ว่าง) — ชื่อเล่น บาส / เบอร์ 0834800121
// ════════════════════════════════════════════════════════════
function addDriverThanawat() {
  return addDriverToAllSheets_('นายธนวัฒน์ มอญแสง', 'ขร.501', 'บาส', '0834800121');
}

function addDriverToAllSheets_(fullName, plateKey, nick, phone) {
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
      var hdr = -1, colName = 0, colNick = 1, colPhone = 2;
      for (var h = 0; h < Math.min(12, data.length) && hdr < 0; h++) {
        for (var c = 0; c < Math.min(4, data[h].length); c++) {
          if (norm(data[h][c]).indexOf('ชื่อ-สกุล') === 0 || norm(data[h][c]) === 'ชื่อสกุล') { hdr = h; colName = c; break; }
        }
      }
      if (hdr < 0) { hdr = 2; colName = 0; }
      data[hdr].forEach(function (cell, ci) {
        var tx = norm(cell);
        if (tx === 'ชื่อเล่น') colNick = ci;
        else if (tx.indexOf('เบอร์') === 0 || tx.indexOf('โทร') === 0) colPhone = ci;
      });
      // เติมชื่อเล่น/เบอร์ (เฉพาะช่องที่ว่าง) — เบอร์เก็บเป็นข้อความเพื่อคงเลข 0 นำหน้า
      var fillInfo = function (rowNum, curNick, curPhone) {
        var did = false;
        if (nick && !String(curNick == null ? '' : curNick).trim()) { sh.getRange(rowNum, colNick + 1).setValue(nick); did = true; }
        if (phone && !String(curPhone == null ? '' : curPhone).trim()) { sh.getRange(rowNum, colPhone + 1).setNumberFormat('@').setValue(phone); did = true; }
        return did;
      };
      var lastStaff = -1, placeholder = -1, totalIdx = -1, exists = false, existIdx = -1;
      for (var rr = hdr + 1; rr < data.length; rr++) {
        var nm = String(data[rr][colName] == null ? '' : data[rr][colName]).trim();
        if (!nm) continue;
        if (nm.indexOf('รวม') === 0) { totalIdx = rr; break; }
        if (nm.indexOf('หมายเหตุ') === 0) continue;
        if (norm(nm) === target) { exists = true; existIdx = rr; }
        if (norm(nm) === norm('พขร.ใหม่')) placeholder = rr;
        lastStaff = rr;
      }
      if (exists) {
        var er = data[existIdx], filled = fillInfo(existIdx + 1, er[colNick], er[colPhone]);
        report.push(shName + ': มีชื่อนี้อยู่แล้ว' + (filled ? ' (เติมชื่อเล่น/เบอร์ที่ว่างให้)' : ''));
        return;
      }
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
