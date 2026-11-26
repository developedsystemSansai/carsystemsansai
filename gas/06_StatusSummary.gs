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
