// ════════════════════════════════════════════════════════════
//  4a) อ่านตารางเวร "ของวันนี้" สำหรับข้อความ LINE (รองรับตารางเวรรูปแบบใหม่)
//
//  รูปแบบตารางเวรใหม่ (ชีท "ตารางเวร" / "ตารางเวรถัดไป"):
//    • ทุกวันทำงานมีรหัสเวรกำกับ: ช = ปฏิบัติงานปกติ 08.00-16.00 | ด = เวรดึก 00.00-08.00
//      ช1บ2 / ช2บ1 = เช้าต่อบ่าย 08.00-00.00 | ช3(Ems) = เวร EMS 08.00-16.00 | บ1/บ2 = ครึ่งบ่าย 16.00-00.00
//      ลา = ลา | 0 = วันหยุด (ไม่มีเวร)   ← เดิมช่องว่างคือไม่มีเวร ตอนนี้เป็น "0" แทน
//    • อ่านเดือน/ปีจากชื่อชีทแถวที่ 2 ("ประจำเดือน ตุลาคม พ.ศ. 2569") ไม่เชื่อ MetaWorktable (อาจค้างเดือนเก่า)
//    • หาคอลัมน์ของแต่ละวันจากหัวตาราง (เช่น "5\nจ") แทนการนับตำแหน่งตายตัว
// ════════════════════════════════════════════════════════════

var THAI_MONTH_STEMS_ = [
  ['มกรา', 1], ['กุมภา', 2], ['มีนา', 3], ['เมษา', 4], ['พฤษภา', 5], ['มิถุนา', 6],
  ['กรกฎา', 7], ['สิงหา', 8], ['กันยา', 9], ['ตุลา', 10], ['พฤศจิก', 11], ['ธันวา', 12]
]; // จับด้วย "ต้นคำ" เพราะในชีทเคยพิมพ์ผิด เช่น "พฤศจิการยน"
var THAI_MONTH_FULL_ = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
var THAI_DOW_FULL_ = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

/** parseRosterMonthYear_ — "ประจำเดือน ตุลาคม พ.ศ. 2569" → { month:10, year:2026 } (ปี ค.ศ.) | null ถ้าอ่านไม่ได้ */
function parseRosterMonthYear_(text) {
  var t = String(text || '');
  var month = 0;
  for (var i = 0; i < THAI_MONTH_STEMS_.length; i++) {
    if (t.indexOf(THAI_MONTH_STEMS_[i][0]) >= 0) { month = THAI_MONTH_STEMS_[i][1]; break; }
  }
  var ym = t.match(/(\d{4})/);
  if (!month || !ym) return null;
  var year = Number(ym[1]);
  if (year > 2400) year -= 543;
  return { month: month, year: year };
}

/** normShiftCell_ — ค่าในช่องเวร → ข้อความสะอาด ('' ถ้าว่าง) */
function normShiftCell_(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

/** isOffShift_ — ช่องว่าง/0/ขีด/หยุด = ไม่มีเวร (ตารางเวรใหม่ใส่ "0" ในวันหยุด) */
function isOffShift_(v) {
  v = normShiftCell_(v);
  return v === '' || /^[0\-–—.]+$/.test(v) || v === 'หยุด' || /^(off|x)$/i.test(v);
}

/** classifyShiftPart_ — จัดกลุ่มรหัสเวร 1 ส่วน (ไม่มี "/") ตัวอย่าง: ด → เวรดึก | ช1บ2 → เช้า1ต่อบ่าย2
 *  คืน { g, order, icon, name, time, kind } — kind: 'duty' (เวรพิเศษ) | 'normal' (ช ปกติ) | 'leave' */
function classifyShiftPart_(part) {
  var s = String(part || '').trim();
  var l = s.toLowerCase();
  if (l.indexOf('ลา') === 0)      return { g: 'leave',  order: 100, icon: '🏖️', name: 'ลา', time: '', kind: 'leave' };
  if (l.indexOf('ems') >= 0)      return { g: 'ems',    order: 2, icon: '🚑', name: 'เวร EMS (' + s + ')', time: '08.00–16.00 น.', kind: 'duty' };
  if (l.indexOf('ช1บ2') === 0)    return { g: 'ch1b2',  order: 3, icon: '🔵', name: 'เวรเช้า1ต่อบ่าย2 (' + s + ')', time: '08.00–00.00 น.', kind: 'duty' };
  if (l.indexOf('ช2บ1') === 0)    return { g: 'ch2b1',  order: 4, icon: '🟢', name: 'เวรเช้า2ต่อบ่าย1 (' + s + ')', time: '08.00–00.00 น.', kind: 'duty' };
  if (l.indexOf('บ') === 0)       return { g: 'b' + l.charAt(1), order: 5, icon: '🟠', name: 'เวรบ่าย' + s.charAt(1) + ' (' + s + ')', time: '16.00–00.00 น.', kind: 'duty' };
  if (l.indexOf('ด') === 0)       return { g: 'night',  order: 1, icon: '🌙', name: 'เวรดึก (' + s + ')', time: '00.00–08.00 น.', kind: 'duty' };
  if (l === 'ช')                  return { g: 'normal', order: 50, icon: '☀️', name: 'ปฏิบัติงานปกติ (ช)', time: '08.00–16.00 น.', kind: 'normal' };
  if (/^ช[123]/.test(l))          return { g: 'ch' + l.charAt(1), order: 6, icon: '⚪', name: 'เวรเช้า ' + l.charAt(1) + ' (' + s + ')', time: '08.00–16.00 น.', kind: 'duty' };
  return { g: 'other:' + s, order: 9, icon: '⚪', name: 'เวรอื่น ๆ (' + s + ')', time: '', kind: 'duty' };
}

/** readRosterSheet_ — อ่านชีทตารางเวร 1 ชีท (ไม่เจอชีท = null) */
function readRosterSheet_(sheetName) {
  var sh = getWorktableSpreadsheet().getSheetByName(sheetName);
  if (!sh) return null;
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return null;

  var monthYear = null;
  for (var i = 0; i < Math.min(6, data.length); i++) {
    var t = String(data[i][0] || '');
    if (t.indexOf('ประจำเดือน') >= 0) { monthYear = parseRosterMonthYear_(t); break; }
  }

  var hdrIdx = -1;
  for (var h = 0; h < Math.min(8, data.length); h++) {
    var v = String(data[h][0] || '').replace(/\s+/g, '');
    if (v === 'ชื่อ-สกุล' || v === 'ชื่อสกุล') { hdrIdx = h; break; }
  }
  if (hdrIdx < 0) hdrIdx = 2;
  var hdr = data[hdrIdx] || [];

  var col = { name: 0, nick: 1, phone: 2, role: 3 };
  hdr.forEach(function (cell, c) {
    var tx = String(cell == null ? '' : cell).replace(/\s+/g, '');
    if (tx === 'ชื่อ-สกุล' || tx === 'ชื่อสกุล') col.name = c;
    else if (tx === 'ชื่อเล่น') col.nick = c;
    else if (tx.indexOf('เบอร์') === 0) col.phone = c;
    else if (tx === 'บทบาท' || tx === 'ตำแหน่ง') col.role = c;
  });
  var lastInfoCol = Math.max(col.name, col.nick, col.phone, col.role);

  var dayCol = {};
  hdr.forEach(function (cell, c) {
    if (c <= lastInfoCol) return;
    var m = String(cell == null ? '' : cell).trim().match(/^(\d{1,2})(?!\d)/); // "5\nจ" → 5
    if (m) { var d = Number(m[1]); if (d >= 1 && d <= 31 && dayCol[d] === undefined) dayCol[d] = c; }
  });
  if (!Object.keys(dayCol).length) { for (var d2 = 1; d2 <= 31; d2++) dayCol[d2] = d2 + 3; } // fallback = รูปแบบเดิม

  var rows = [];
  for (var r = hdrIdx + 1; r < data.length; r++) {
    var row  = data[r];
    var name = String(row[col.name] || '').trim();
    if (!name) continue;
    if (name.indexOf('รวม') === 0) continue; // แถวสรุป "รวมเวร (จำนวนวัน)"
    rows.push({ name: name, nick: String(row[col.nick] || '').trim(), phone: String(row[col.phone] || '').trim(),
                role: String(row[col.role] || '').trim(), row: row });
  }
  return { sheetName: sheetName, monthYear: monthYear, dayCol: dayCol, staff: rows };
}

/** getDutyForDate_ — ใครอยู่เวรอะไรในวันที่กำหนด (ค่าเริ่มต้น = วันนี้ เวลาไทย)
 *  คืน { status:'ok'|'nosheet'|'empty', message, day, month, year, dowThai, sheetName,
 *        groups:[{key,name,time,icon,order,people:[{name,nick,phone,shift,composite}]}],   ← เวรพิเศษ (ด/EMS/ช1บ2/ช2บ1/บ่าย)
 *        dutyCount, normal:[{name,nick,phone}], leave:[{name,nick}], offCount } */
function getDutyForDate_(dateObj) {
  var d = dateObj || new Date();
  var day   = Number(Utilities.formatDate(d, 'Asia/Bangkok', 'd'));
  var month = Number(Utilities.formatDate(d, 'Asia/Bangkok', 'M'));
  var year  = Number(Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy'));
  var dow   = Number(Utilities.formatDate(d, 'Asia/Bangkok', 'u')) % 7; // 1..7 (จ..อา) → 0=อาทิตย์
  var out = { status: 'nosheet', message: '', day: day, month: month, year: year, dowThai: THAI_DOW_FULL_[dow], sheetName: '',
              groups: [], dutyCount: 0, normal: [], leave: [], offCount: 0 };

  var picked = null, unreadable = null;
  [SHEET_WORKTABLE, SHEET_WORKTABLE_NEXT].forEach(function (nm) {
    if (picked) return;
    var ro = readRosterSheet_(nm);
    if (!ro) return;
    if (ro.monthYear) { if (ro.monthYear.month === month && ro.monthYear.year === year) picked = ro; }
    else if (!unreadable) unreadable = ro;
  });
  if (!picked && unreadable && unreadable.sheetName === SHEET_WORKTABLE) picked = unreadable; // อ่านเดือนจากหัวชีทไม่ได้ → ถือว่าชีทหลักคือเดือนนี้
  if (!picked) {
    out.message = 'ไม่พบตารางเวรของเดือน' + THAI_MONTH_FULL_[month] + ' ' + (year + 543) + ' ในชีท "' + SHEET_WORKTABLE + '" หรือ "' + SHEET_WORKTABLE_NEXT + '"';
    return out;
  }
  out.sheetName = picked.sheetName;

  var c = picked.dayCol[day];
  if (c === undefined) { out.status = 'empty'; out.message = 'ตารางเวรไม่มีคอลัมน์ของวันที่ ' + day; return out; }

  var groupMap = {}, dutyKeys = {}, filled = 0;
  picked.staff.forEach(function (s) {
    var val = normShiftCell_(s.row[c]);
    if (val !== '') filled++;
    if (isOffShift_(val)) { out.offCount++; return; }

    var parts = val.split('/').map(function (p) { return p.trim(); }).filter(Boolean);
    var composite = parts.length > 1;
    parts.forEach(function (p) {
      var cl = classifyShiftPart_(p);
      if (cl.kind === 'leave')  { if (!out.leave.some(function (x) { return x.name === s.name; })) out.leave.push({ name: s.name, nick: s.nick }); return; }
      if (cl.kind === 'normal') { if (!out.normal.some(function (x) { return x.name === s.name; })) out.normal.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone) }); return; }
      if (!groupMap[cl.g]) groupMap[cl.g] = { key: cl.g, name: cl.name, time: cl.time, icon: cl.icon, order: cl.order, people: [] };
      groupMap[cl.g].people.push({ name: s.name, nick: s.nick, phone: linePhoneDigits_(s.phone), shift: val, composite: composite });
      dutyKeys[s.name] = true;
    });
  });

  out.groups = Object.keys(groupMap).map(function (k) { return groupMap[k]; }).sort(function (a, b) { return a.order - b.order; });
  out.dutyCount = Object.keys(dutyKeys).length;

  if (filled === 0) { out.status = 'empty'; out.message = 'ตารางเวรของวันที่ ' + day + ' ยังไม่ได้กรอกข้อมูล'; return out; }
  out.status = 'ok';
  return out;
}

/** dutyPersonLabel_ — "ชื่อ-สกุล (ชื่อเล่น) 📞 เบอร์" */
function dutyPersonLabel_(p) {
  var phone = linePhoneDigits_(p.phone);
  return (p.name || '') + (p.nick ? ' (' + p.nick + ')' : '') + (phone ? ' 📞 ' + phone : '');
}
function dutyNickOrName_(p) { return p.nick || String(p.name || '').replace(/^(นาย|นางสาว|นาง)/, ''); }

/** buildDutyLines_ — ส่วน "ผู้อยู่เวรวันนี้" ของข้อความ LINE (tplKey = 'workSchedule' | 'myScheduleOverview')
 *  grouped=true  → จัดกลุ่มตามประเภทเวร (ใช้ในตารางงานประจำวัน)
 *  grouped=false → รายชื่อเรียงต่อกัน ท้ายบรรทัดบอกรหัสเวร (ใช้ในภาพรวม Rich Menu เหมือนเดิม) */
function buildDutyLines_(duty, tplKey, grouped) {
  var lines = [];
  if (duty.status !== 'ok') {
    lines.push(tpl_(tplKey, 'dutyWarnText', { message: duty.message || 'อ่านตารางเวรไม่ได้' }));
    return lines;
  }
  if (duty.dutyCount > 0) {
    lines.push(tpl_(tplKey, 'dutySectionTitle', { count: duty.dutyCount }));
    if (grouped) {
      duty.groups.forEach(function (g) {
        lines.push(tpl_(tplKey, 'dutyGroupTitle', { icon: g.icon, groupName: g.name, timeRange: g.time, count: g.people.length }));
        g.people.forEach(function (p) {
          lines.push(tpl_(tplKey, 'dutyItem', {
            name: p.name, nickPart: (p.nick ? ' (' + p.nick + ')' : '') + (p.phone ? ' 📞 ' + p.phone : ''),
            shift: p.shift, shiftPart: p.composite ? ' [' + p.shift + ']' : ''
          }));
        });
      });
    } else {
      var seen = {};
      duty.groups.forEach(function (g) {
        g.people.forEach(function (p) {
          if (seen[p.name]) return; seen[p.name] = true;
          lines.push(tpl_(tplKey, 'dutyItem', {
            name: p.name, nickPart: (p.nick ? ' (' + p.nick + ')' : '') + (p.phone ? ' 📞 ' + p.phone : ''),
            shift: p.shift, shiftPart: p.composite ? ' [' + p.shift + ']' : ''
          }));
        });
      });
    }
  } else {
    lines.push(tpl_(tplKey, 'dutyEmptyText', {}));
  }
  if (duty.normal.length) {
    lines.push('');
    lines.push(tpl_(tplKey, 'dutyNormalText', { count: duty.normal.length, names: duty.normal.map(dutyNickOrName_).join(', ') }));
  }
  if (duty.leave.length) {
    lines.push(tpl_(tplKey, 'dutyLeaveText', { count: duty.leave.length, names: duty.leave.map(dutyNickOrName_).join(', ') }));
  }
  return lines;
}

/** jobHeadcountPart_ — " · 2 คน" (ว่าง/0 = ไม่แสดง) */
function jobHeadcountPart_(j) {
  var n = Number(j && j.headcount);
  return (n > 0) ? (' · ' + n + ' คน') : '';
}

/** shortTime_ — "08:00:00" → "08:00" (ข้อความ LINE ไม่ต้องแสดงวินาที) */
function shortTime_(t) {
  return String(t == null ? '' : t).replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
}

/** sortJobsByTime_ — เรียงตามเวลาไป (เร็วสุดก่อน) งานที่ไม่ได้ใส่เวลาไว้ท้ายสุด */
function sortJobsByTime_(jobs) {
  return jobs.sort(function (a, b) {
    return String(a.timeOut || '99:99').localeCompare(String(b.timeOut || '99:99'));
  });
}

// ════════════════════════════════════════════════════════════
//  4b) รายงานที่ 3 (NEW): ตารางงานประจำวัน (ทุกวัน เวลา 07:30 น.) — ส่งให้ รองฯ + พขร. เท่านั้น
// ════════════════════════════════════════════════════════════

/** buildDailyWorkScheduleReport_ — สรุป "ผู้อยู่เวรวันนี้" (ตารางเวร) + "งานที่ต้องไป" (ตารางงาน) ของวันนี้ สำหรับ รองฯ + พขร.
 *  ✅ แก้: เดิมส่งเฉพาะตารางงาน ไม่มีข้อมูลเวร และถ้าอ่านตารางงานไม่สำเร็จจะบอกว่า "ไม่มีงาน" ทั้งที่จริงคืออ่านไม่ได้ */
function buildDailyWorkScheduleReport_() {
  var now       = new Date();
  var todayYmd  = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd');
  var todayThai = Utilities.formatDate(now, 'Asia/Bangkok', 'dd/MM/yyyy');

  var duty    = getDutyForDate_(now);
  var jobsRes = getJobAssignments({});
  var jobsOk  = !!(jobsRes && jobsRes.status === 'ok');
  var todayJobs = sortJobsByTime_(((jobsRes && jobsRes.data) || []).filter(function (j) { return j.date === todayYmd; }));

  var lines = [];
  lines.push(tpl_('workSchedule', 'header', { todayThai: todayThai }));
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  // ── ส่วนที่ 1: เวรวันนี้ ──
  Array.prototype.push.apply(lines, buildDutyLines_(duty, 'workSchedule', true));
  lines.push('');
  lines.push(REPORT_DIVIDER_);
  lines.push('');

  // ── ส่วนที่ 2: งานที่ต้องไป ──
  var phoneMap = buildStaffPhoneMap_(); // เบอร์โทร พขร. — แนบหลังชื่อผู้ขับแต่ละคน
  if (!jobsOk) {
    lines.push('⚠️ ดึงตารางงานไม่สำเร็จ' + (jobsRes && jobsRes.message ? ' (' + jobsRes.message + ')' : '') + ' — กรุณาตรวจสอบที่ Dashboard');
  } else if (todayJobs.length === 0) {
    lines.push(tpl_('workSchedule', 'emptyText', {}));
  } else {
    lines.push(tpl_('workSchedule', 'listTitle', { count: todayJobs.length }));
    lines.push('');
    todayJobs.forEach(function (j, i) {
      lines.push(tpl_('workSchedule', 'item', {
        no: i + 1, timeOut: shortTime_(j.timeOut) || '-',
        timeBackPart: j.timeBack ? ('–' + shortTime_(j.timeBack)) : '',
        destination: j.destination || '-',
        missionPart: j.mission ? (' (' + j.mission + ')') : '',
        requester: j.requester || '-',
        headcountPart: jobHeadcountPart_(j),
        driver: j.driver ? driverWithPhone_(j.driver, phoneMap) : 'ยังไม่ระบุ',
        carPart: j.car ? (' · รถ: ' + j.car) : ''
      }));
      lines.push('');
    });
  }

  lines.push(REPORT_DIVIDER_);
  lines.push(tpl_('workSchedule', 'footer', { dashboardUrl: DASHBOARD_URL }));

  var lineText = lines.join('\n');

  // ── อีเมล ──
  var dutyHtml = '';
  if (duty.status !== 'ok') {
    dutyHtml = '<p style="color:#b45309">⚠️ ' + escapeHtml_(duty.message) + '</p>';
  } else {
    var dutyRows = '';
    duty.groups.forEach(function (g) {
      g.people.forEach(function (p) {
        dutyRows += '<tr><td>' + escapeHtml_(g.icon + ' ' + g.name) + '</td><td>' + escapeHtml_(g.time) + '</td><td>'
          + escapeHtml_(p.name + (p.nick ? ' (' + p.nick + ')' : '')) + '</td><td>' + escapeHtml_(p.phone) + '</td></tr>';
      });
    });
    dutyHtml = (duty.dutyCount === 0 ? '<p>วันนี้ไม่มีผู้อยู่เวรพิเศษ (ด/บ/EMS)</p>'
        : '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:6px">'
          + '<tr style="background:#163251;color:#fff"><th>ประเภทเวร</th><th>เวลา</th><th>ผู้อยู่เวร</th><th>เบอร์โทร</th></tr>' + dutyRows + '</table>')
      + (duty.normal.length ? '<p style="margin:8px 0 0">☀️ ปฏิบัติงานปกติ (ช) ' + duty.normal.length + ' คน: ' + escapeHtml_(duty.normal.map(dutyNickOrName_).join(', ')) + '</p>' : '')
      + (duty.leave.length ? '<p style="margin:4px 0 0">🏖️ ลา: ' + escapeHtml_(duty.leave.map(dutyNickOrName_).join(', ')) + '</p>' : '');
  }

  var rowsHtml = todayJobs.map(function (j) {
    return '<tr><td>' + escapeHtml_(j.timeOut) + (j.timeBack ? '–' + escapeHtml_(j.timeBack) : '') + '</td><td>' +
      escapeHtml_(j.destination) + '</td><td>' + escapeHtml_(j.mission) + '</td><td>' + escapeHtml_(j.requester) + escapeHtml_(jobHeadcountPart_(j)) +
      '</td><td>' + escapeHtml_(j.driver) + '</td><td>' + escapeHtml_(j.car) + '</td></tr>';
  }).join('');

  var emailBody = ''
    + '<div style="font-family:sans-serif">'
    + '<h2 style="margin-bottom:4px">🗓️ ตารางงานประจำวัน — โรงพยาบาลสันทราย</h2>'
    + '<p style="color:#555;margin-top:0">วันที่ ' + todayThai + '</p>'
    + '<h3 style="margin:14px 0 4px">🧑‍✈️ ผู้อยู่เวรวันนี้</h3>' + dutyHtml
    + '<h3 style="margin:18px 0 4px">📋 งานที่ต้องไป</h3>'
    + (!jobsOk ? '<p style="color:#b45309">⚠️ ดึงตารางงานไม่สำเร็จ</p>'
        : todayJobs.length === 0
        ? '<p>ยังไม่มีงานที่บันทึกไว้สำหรับวันนี้</p>'
        : '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;font-size:13px;width:100%;margin-top:6px">'
          + '<tr style="background:#0a2540;color:#fff"><th>เวลา</th><th>สถานที่ไป</th><th>ภารกิจ</th><th>ผู้ขอรถ</th><th>พขร.</th><th>รถ</th></tr>'
          + rowsHtml + '</table>')
    + '<p style="margin-top:24px">📊 ดูรายละเอียด/แก้ไขได้ที่ Dashboard:</p>'
    + '<p><a href="' + DASHBOARD_URL + '" style="display:inline-block;background:#0a2540;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:bold">เปิด Dashboard</a></p>'
    + '</div>';

  return {
    lineText: lineText,
    emailSubject: '[SAND] ตารางงานประจำวัน ' + todayThai,
    emailBody: emailBody,
    jobCount: todayJobs.length,
    dutyCount: duty.dutyCount,
    dutyStatus: duty.status
  };
}

