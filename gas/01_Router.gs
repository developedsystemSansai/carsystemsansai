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
