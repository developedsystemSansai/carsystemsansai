/* ============================================================
   monthly-report.js — รายงานประจำเดือน (PDF) เก็บบน Google Drive · dashboard.html
   ขั้นตอน: ดึงข้อมูลล่าสุดจาก Apps Script → สรุปสถิติเดือน (เทียบเดือนก่อน) → จัดหน้า A4
            → แปลงเป็น PDF ในเบราว์เซอร์ → ส่งไปเก็บในโฟลเดอร์ Drive (saveMonthlyReport)
            → แสดงรายการรายงานที่เก็บไว้ในหน้า Dashboard (เปิด/ดาวน์โหลดผ่านระบบ ไม่ต้องแชร์ไฟล์สาธารณะ)
   - ใช้ jsPDF + html2canvas (โหลดตอนใช้งานจริงเท่านั้น) — หน้ารายงานเรนเดอร์เป็น DOM แล้วจับภาพ จึงแสดงภาษาไทยตรงกับหน้าเว็บ
     (ข้อความใน PDF จึงเป็นภาพ ค้น/คัดลอกข้อความไม่ได้)
   - เปิด Dashboard ครั้งแรกหลังขึ้นเดือนใหม่ ถ้ายังไม่มีรายงานเดือนที่แล้ว จะสร้างและเก็บให้อัตโนมัติ 1 ครั้ง
     (ไม่มี trigger ฝั่งเซิร์ฟเวอร์ — ต้องมีคนเปิด Dashboard; ไม่เปิดเลยทั้งเดือนก็กดสร้างเองได้)
   - ข้อมูลจากชีทถูกใส่ผ่าน textContent เท่านั้น (ไม่แทรกเป็น HTML)
   - ส่วนท้ายรายงาน: วิเคราะห์เชิงพื้นที่ (GIS) แผนที่เส้นทาง/รัศมีการเดินรถ จาก รพ. (monthly-gis.js — โหลดเมื่อสร้างรายงาน) + เครดิตผู้จัดทำ
   ต้องใช้ global ของ dashboard.html: GAS_URL, tripFuel(), normalizeInspDate(), extractPlate(), ALL_VEHICLES
   ============================================================ */
(function () {
  'use strict';

  var JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  var H2C_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  var NS = 'http://www.w3.org/2000/svg';
  var TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  var PAGE_W = 794, PAGE_H = 1123;                     // A4 @96dpi
  var CHK_LABELS = {
    // คอลัมน์ตรวจแบบเดิม (ยังมีในข้อมูลเก่า) — ป้ายตรงกับ CHECK_ITEM_LABELS_ ใน Code.gs
    eq_oil: 'น้ำมันเครื่อง/กระจกมองข้าง', eq_battery: 'แบตเตอรี่/ระบบเบรค', eq_tire: 'ยาง/น้ำหม้อน้ำ',
    chk_mirror: 'กระจก', chk_brake: 'เบรค', chk_coolant: 'น้ำหม้อน้ำ', chk_suspension: 'ช่วงล่าง',
    chk_oilLevel: 'ระดับน้ำมันเครื่อง', chk_tirePressure: 'ลมยาง', chk_headlight: 'ไฟหน้า', chk_taillight: 'ไฟท้าย',
    chk_reverseLight: 'ไฟถอย', chk_horn: 'แตร', chk_wiper: 'ที่ปัดน้ำฝน', chk_aircon: 'แอร์',
    chk_exteriorClean: 'ความสะอาดภายนอก', chk_interiorClean: 'ความสะอาดภายใน', chk_o2Level: 'ระดับ O2',
    chk_emergencyLight: 'ไฟฉุกเฉิน', chk_siren: 'ไซเรน', chk_stretcherLock: 'เปลและระบบล็อกเปล', chk_suction: 'เครื่อง Suction', chk_aed: 'AED'
  };

  var st = { busy: false, list: [], listLoaded: false, libs: null, gis: null };

  // ───────────── helpers ─────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svg(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function n(v) { var x = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(x) ? x : 0; }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function fmt(x, d) { return (Number(x) || 0).toLocaleString('th-TH', { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: 0 }); }
  function pad2(v) { return ('0' + v).slice(-2); }
  function todayBkk() {                                  // yyyy-MM-dd ตามเวลาไทย
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  }
  function nowBkkText() {
    try { return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' }).format(new Date()) + ' น.'; }
    catch (e) { return new Date().toLocaleString('th-TH'); }
  }
  function ymOf(iso) { return String(iso || '').slice(0, 7); }
  function prevYm(ym) { var p = ym.split('-'), y = +p[0], m = +p[1] - 1; if (m < 1) { m = 12; y--; } return y + '-' + pad2(m); }
  function monthLabel(ym) { var p = ym.split('-'); return TH_MONTHS[+p[1] - 1] + ' ' + (+p[0] + 543); }
  function daysIn(ym) { var p = ym.split('-'); return new Date(+p[0], +p[1], 0).getDate(); }
  function recentMonths(count) {                         // [ym ล่าสุด → เก่า]
    var cur = ymOf(todayBkk()), out = [cur];
    while (out.length < count) out.push(prevYm(out[out.length - 1]));
    return out;
  }
  function fileNameOf(ym) { return 'SAND_Monthly_' + ym + '.pdf'; }
  function fmtBytes(b) { b = +b || 0; return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  function fmtDT(iso) {
    if (!iso) return '—';
    try { return new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)); } catch (e) { return String(iso); }
  }
  function getJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script'); s.src = url; s.onload = resolve;
      s.onerror = function () { reject(new Error('โหลดไลบรารีไม่สำเร็จ: ' + url)); };
      document.head.appendChild(s);
    });
  }
  function ensureLibs() {
    if (window.jspdf && window.html2canvas) return Promise.resolve();
    if (st.libs) return st.libs;
    st.libs = Promise.all([window.jspdf ? 1 : loadScript(JSPDF_URL), window.html2canvas ? 1 : loadScript(H2C_URL)])
      .catch(function (e) { st.libs = null; throw e; });
    return st.libs;
  }
  // โมดูล GIS โหลดเมื่อสร้างรายงานเท่านั้น (ไม่กระทบเวลาเปิด Dashboard) — โหลดไม่ได้ก็ออกรายงานได้ตามเดิมโดยไม่มีส่วน GIS
  function loadGis() {
    if (window.SandMonthlyGIS) return Promise.resolve(window.SandMonthlyGIS);
    if (st.gis) return st.gis;
    st.gis = loadScript('js/monthly-gis.js?v=3').then(function () { return window.SandMonthlyGIS; }).catch(function (e) { st.gis = null; throw e; });
    return st.gis;
  }
  function computeGis(S, mileRows, pinsRes) {
    var rows = mileRows.filter(function (r) { return ymOf(normalizeInspDate(r['วันที่'])) === S.ym; });
    return loadGis().then(function (g) {
      return g.compute({ rows: rows, plateOf: plateOf, n: n, pins: (pinsRes && pinsRes.data) || [], ym: S.ym });
    }).catch(function (e) { if (window.console) console.warn('monthly-report: ข้ามส่วน GIS —', e); return null; });
  }

  // ───────────── สถิติประจำเดือน ─────────────
  function plateOf(s) { return typeof extractPlate === 'function' ? extractPlate(String(s || '')) : String(s || '').split(' ')[0]; }
  function vehMeta(plate) {
    var v = (typeof ALL_VEHICLES !== 'undefined' ? ALL_VEHICLES : []).filter(function (x) { return plateOf(x.plate) === plate; })[0];   // ชีต Vehicles อาจมีคำต่อท้าย (เช่น "นง.86 ชม.") — เทียบแบบเดียวกับเลขไมล์
    return v ? { type: v.type || '', sys: v.sys || '' } : { type: '', sys: '' };
  }
  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }
  function delta(cur, prev) { if (!prev) return null; return Math.round(((cur - prev) / prev) * 1000) / 10; }

  function summarizeMile(rows, ym) {
    var inM = rows.filter(function (r) { return ymOf(normalizeInspDate(r['วันที่'])) === ym; });
    var S = { trips: 0, km: 0, liters: 0, baht: 0, fills: 0, byPlate: {}, byDriver: {}, byDest: {}, byDay: {}, gapKm: 0 };
    inM.forEach(function (r) {
      var plate = plateOf(r['ทะเบียน/รถ'] || r.carType), day = normalizeInspDate(r['วันที่']);
      var km = Math.max(0, n(r['ระยะทาง(กม.)'])), f = tripFuel(r);
      S.trips++; S.km += km; S.liters += f.liters; S.baht += f.price; S.gapKm += Math.max(0, n(r['ระยะทางที่หายไป (กม.)']));
      var fill = (f.liters > 0 || f.price > 0);
      if (fill) S.fills++;
      var p = S.byPlate[plate] || (S.byPlate[plate] = { plate: plate, trips: 0, km: 0, fills: 0, liters: 0, baht: 0, checks: 0, issues: 0 });
      p.trips++; p.km += km; p.liters += f.liters; p.baht += f.price; if (fill) p.fills++;
      var dn = String(r['พนักงานขับรถ'] || '').trim();
      if (dn) { var d = S.byDriver[dn] || (S.byDriver[dn] = { name: dn, trips: 0, km: 0 }); d.trips++; d.km += km; }
      String(r['ปลายทาง'] || '').split(/[,/]/).forEach(function (x) { x = x.replace(/\s+/g, ' ').trim(); if (x) S.byDest[x] = (S.byDest[x] || 0) + 1; });
      if (day) S.byDay[day] = (S.byDay[day] || 0) + 1;
    });
    return S;
  }

  function summarizeCheck(rows, ym) {
    var inM = rows.filter(function (r) { return ymOf(normalizeInspDate(r.inspDate || r['วันที่'])) === ym; });
    var C = { checks: 0, withIssue: 0, issueItems: 0, days: {}, byItem: {}, byPlate: {} };
    inM.forEach(function (r) {
      var plate = plateOf(r.carType), day = normalizeInspDate(r.inspDate || r['วันที่']), cnt = 0;
      C.checks++; if (day) C.days[day] = 1;
      Object.keys(CHK_LABELS).forEach(function (k) {
        if (String(r[k] || '').indexOf('ผิดปกติ') >= 0) { cnt++; C.byItem[k] = (C.byItem[k] || 0) + 1; }
      });
      if (cnt > 0) { C.withIssue++; C.issueItems += cnt; }
      var p = C.byPlate[plate] || (C.byPlate[plate] = { checks: 0, issues: 0 }); p.checks++; if (cnt > 0) p.issues++;
    });
    return C;
  }

  function summarizeSat(res, ym) {
    var d = ((res && res.data) || []).filter(function (x) {
      var m = String(x.date || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);       // dd/MM/yyyy → ต้องอยู่ในเดือนที่เลือก
      return !m || (m[3] + '-' + pad2(+m[2])) === ym;
    }), dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, sum = 0, cnt = 0, purposes = {};
    d.forEach(function (x) {
      var k = Math.round(n(x.rating)); if (k >= 1 && k <= 5) { dist[k]++; sum += k; cnt++; }
      var pu = String(x.purpose || '').trim(); if (pu) purposes[pu] = (purposes[pu] || 0) + 1;
    });
    return { count: cnt, avg: cnt ? Math.round((sum / cnt) * 100) / 100 : null, dist: dist, purposes: purposes };
  }

  function buildStats(ym, checkRows, mileRows, satRes) {
    var M = summarizeMile(mileRows, ym), PM = summarizeMile(mileRows, prevYm(ym));
    var C = summarizeCheck(checkRows, ym), PC = summarizeCheck(checkRows, prevYm(ym));
    var SAT = summarizeSat(satRes, ym);
    Object.keys(C.byPlate).forEach(function (pl) {
      var p = M.byPlate[pl] || (M.byPlate[pl] = { plate: pl, trips: 0, km: 0, fills: 0, liters: 0, baht: 0, checks: 0, issues: 0 });
      p.checks = C.byPlate[pl].checks; p.issues = C.byPlate[pl].issues;
    });
    var vehicles = Object.keys(M.byPlate).filter(function (k) { return k; }).map(function (k) {
      var v = M.byPlate[k], meta = vehMeta(k);
      v.type = meta.type; v.sys = meta.sys; v.kmpl = (v.liters > 0 && v.km > 0) ? v.km / v.liters : null; return v;
    }).sort(function (a, b) { return b.trips - a.trips || b.km - a.km; });
    var master = (typeof ALL_VEHICLES !== 'undefined' ? ALL_VEHICLES : []).map(function (v) { return plateOf(v.plate); });
    var idle = master.filter(function (p) { return !M.byPlate[p] || (!M.byPlate[p].trips && !M.byPlate[p].checks); });
    var drivers = Object.keys(M.byDriver).map(function (k) { return M.byDriver[k]; }).sort(function (a, b) { return b.trips - a.trips || b.km - a.km; });
    var dests = Object.keys(M.byDest).map(function (k) { return { name: k, count: M.byDest[k] }; }).sort(function (a, b) { return b.count - a.count; });
    var items = Object.keys(C.byItem).map(function (k) { return { name: CHK_LABELS[k], count: C.byItem[k] }; }).sort(function (a, b) { return b.count - a.count; });
    var days = daysIn(ym), series = [];
    for (var d = 1; d <= days; d++) series.push(M.byDay[ym + '-' + pad2(d)] || 0);
    var activeDays = series.filter(function (x) { return x > 0; }).length;
    return {
      ym: ym, label: monthLabel(ym), prevLabel: monthLabel(prevYm(ym)), days: days, series: series, activeDays: activeDays,
      M: M, PM: PM, C: C, PC: PC, SAT: SAT, vehicles: vehicles, idle: idle, drivers: drivers, dests: dests, items: items,
      vehTotal: master.length || vehicles.length,
      kmpl: (M.liters > 0 && M.km > 0) ? M.km / M.liters : null,
      hasData: (M.trips + C.checks) > 0
    };
  }

  function insights(S) {
    var out = [], M = S.M, PM = S.PM, C = S.C;
    out.push('เดือน ' + S.label + ' มีการใช้รถ ' + fmt(M.trips) + ' เที่ยว ระยะทางรวม ' + fmt(M.km) + ' กม. ใช้งานรถ ' + S.vehicles.filter(function (v) { return v.trips > 0; }).length + ' จาก ' + S.vehTotal + ' คัน (มีการใช้งาน ' + S.activeDays + ' จาก ' + S.days + ' วัน)');
    var tp = delta(M.trips, PM.trips);
    if (tp !== null) out.push('เทียบกับ ' + S.prevLabel + ': จำนวนเที่ยว' + (tp >= 0 ? 'เพิ่มขึ้น ' : 'ลดลง ') + Math.abs(tp) + '% (' + fmt(PM.trips) + ' → ' + fmt(M.trips) + ' เที่ยว)');
    if (S.vehicles[0] && S.vehicles[0].trips) out.push('รถที่ใช้มากที่สุด: ' + S.vehicles[0].plate + ' (' + fmt(S.vehicles[0].trips) + ' เที่ยว, ' + fmt(S.vehicles[0].km) + ' กม.)' + (S.drivers[0] ? ' · พขร. ที่ขับมากที่สุด: ' + S.drivers[0].name + ' (' + fmt(S.drivers[0].trips) + ' เที่ยว)' : ''));
    out.push('น้ำมัน: เติม ' + fmt(M.fills) + ' ครั้ง รวม ' + fmt(M.liters, 2) + ' ลิตร ค่าใช้จ่าย ' + fmt(M.baht) + ' บาท' + (S.kmpl ? ' (เฉลี่ยโดยประมาณ ' + fmt(S.kmpl, 1) + ' กม./ลิตร)' : ''));
    out.push('ตรวจสภาพรถ ' + fmt(C.checks) + ' ครั้ง พบรายการผิดปกติ ' + fmt(C.withIssue) + ' ครั้ง' + (C.checks ? ' (' + pct(C.withIssue, C.checks) + '%)' : '') + (S.items[0] ? ' · พบบ่อยที่สุด: ' + S.items[0].name + ' ' + S.items[0].count + ' ครั้ง' : ''));
    if (S.SAT.count) out.push('ความพึงพอใจผู้ใช้บริการ: เฉลี่ย ' + S.SAT.avg + ' / 5 จาก ' + fmt(S.SAT.count) + ' การประเมิน');
    return out;
  }

  // ───────────── จัดหน้า A4 ─────────────
  function Pager(S) {
    this.S = S; this.pages = [];
    this.root = el('div', 'mr-stage');
    this.root.style.cssText = 'position:fixed;left:-12000px;top:0;width:' + PAGE_W + 'px;z-index:-1;pointer-events:none;';
    document.body.appendChild(this.root);
    this.newPage();
  }
  Pager.prototype.newPage = function () {
    var first = this.pages.length === 0;
    var page = el('div', 'mr-page'); page.style.width = PAGE_W + 'px'; page.style.height = PAGE_H + 'px';
    var hd = el('div', first ? 'mr-head' : 'mr-head slim');
    var logo = new Image(); logo.src = 'assets/sand-logo-icon.png'; logo.alt = ''; logo.className = 'mr-logo'; hd.appendChild(logo);
    var tt = el('div', 'mr-htext');
    tt.appendChild(el('div', 'mr-title', first ? 'รายงานสรุปการใช้งานระบบ SAND ประจำเดือน ' + this.S.label : 'รายงานประจำเดือน ' + this.S.label + ' (ต่อ)'));
    tt.appendChild(el('div', 'mr-sub', 'SAND · Sansai Administration Network Drive · โรงพยาบาลสันทราย'));
    hd.appendChild(tt);
    if (first) { var mt = el('div', 'mr-hmeta'); mt.appendChild(el('div', null, 'จัดทำเมื่อ')); mt.appendChild(el('b', null, nowBkkText())); hd.appendChild(mt); }
    var body = el('div', 'mr-body'), ft = el('div', 'mr-foot');
    ft.appendChild(el('span', null, 'ข้อมูลจากระบบ SAND · สร้างโดยอัตโนมัติจากข้อมูลในชีท'));
    var pg = el('span', 'mr-pg'); ft.appendChild(pg);
    page.appendChild(hd); page.appendChild(body); page.appendChild(ft);
    this.root.appendChild(page);
    this.pages.push({ el: page, body: body, pg: pg });
    return this.pages[this.pages.length - 1];
  };
  Pager.prototype.cur = function () { return this.pages[this.pages.length - 1]; };
  function overflows(p) { return p.body.scrollHeight > p.body.clientHeight + 1; }
  Pager.prototype.add = function (node) {
    var p = this.cur(); p.body.appendChild(node);
    if (overflows(p) && p.body.children.length > 1) { p.body.removeChild(node); p = this.newPage(); p.body.appendChild(node); }
  };
  // ตารางที่ตัดต่อหน้าได้ (ส่วนหัวตารางซ้ำทุกหน้า)
  Pager.prototype.addTable = function (title, cols, rows, opts) {
    opts = opts || {};
    var self = this, idx = 0, cont = false;
    if (!rows.length) rows = [[{ t: 'ไม่มีข้อมูลในเดือนนี้', span: cols.length, cls: 'mr-empty' }]];
    while (idx < rows.length) {
      var blk = el('div', 'mr-block'), tbl = el('table', 'mr-table'), tbody = el('tbody');
      blk.appendChild(el('h3', 'mr-h3', title + (cont ? ' (ต่อ)' : '')));
      var thead = el('thead'), htr = el('tr');
      cols.forEach(function (c) { var th = el('th', c.cls || '', c.label); htr.appendChild(th); });
      thead.appendChild(htr); tbl.appendChild(thead); tbl.appendChild(tbody); blk.appendChild(tbl);
      var p = this.cur(); p.body.appendChild(blk);
      if (overflows(p) && p.body.children.length > 1) { p.body.removeChild(blk); p = this.newPage(); p.body.appendChild(blk); }
      var placed = 0;
      while (idx < rows.length) {
        var tr = el('tr');
        rows[idx].forEach(function (c, ci) {
          var td = el('td', (c.cls || (cols[ci] && cols[ci].cls) || ''), c.t); if (c.span) td.colSpan = c.span; tr.appendChild(td);
        });
        tbody.appendChild(tr);
        if (overflows(p) && placed > 0) { tbody.removeChild(tr); break; }
        placed++; idx++;
      }
      if (idx < rows.length) { cont = true; this.newPage(); }
    }
  };
  Pager.prototype.finish = function () {
    var total = this.pages.length;
    this.pages.forEach(function (p, i) { p.pg.textContent = 'หน้า ' + (i + 1) + ' / ' + total; });
  };
  Pager.prototype.destroy = function () { if (this.root.parentNode) this.root.parentNode.removeChild(this.root); };

  function kpiCard(label, value, unit, deltaPct, goodWhenUp) {
    var c = el('div', 'mr-kpi');
    c.appendChild(el('div', 'mr-kl', label));
    var v = el('div', 'mr-kv'); v.appendChild(document.createTextNode(value)); if (unit) v.appendChild(el('small', null, ' ' + unit)); c.appendChild(v);
    var d = el('div', 'mr-kd');
    if (deltaPct === null || deltaPct === undefined) { d.textContent = 'เทียบเดือนก่อน: —'; d.className += ' flat'; }
    else {
      var up = deltaPct > 0, same = deltaPct === 0;
      var good = same ? null : (goodWhenUp === null ? null : (up === goodWhenUp));
      d.textContent = (same ? '■ ' : (up ? '▲ ' : '▼ ')) + Math.abs(deltaPct) + '% เทียบเดือนก่อน';
      d.className += good === null ? ' flat' : (good ? ' good' : ' bad');
    }
    c.appendChild(d); return c;
  }

  function dailyChart(S) {
    var blk = el('div', 'mr-block'); blk.appendChild(el('h3', 'mr-h3', 'จำนวนเที่ยวรายวัน'));
    var W = 720, H = 150, pl = 26, pb = 22, pt = 10, max = Math.max.apply(null, S.series.concat([1]));
    var s = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'mr-chart' });
    var inner = W - pl - 4, bw = inner / S.series.length, ch = H - pb - pt;
    [0, 0.5, 1].forEach(function (f) {
      var y = pt + ch - ch * f; s.appendChild(svg('line', { x1: pl, x2: W - 4, y1: y, y2: y, stroke: '#e3e8f0', 'stroke-width': 1 }));
      var t = svg('text', { x: pl - 4, y: y + 3, 'text-anchor': 'end', 'font-size': 9, fill: '#7a8ea5' }); t.textContent = Math.round(max * f); s.appendChild(t);
    });
    S.series.forEach(function (v, i) {
      var h = v ? Math.max(2, ch * v / max) : 0, x = pl + i * bw + bw * 0.15;
      if (v) s.appendChild(svg('rect', { x: x, y: pt + ch - h, width: Math.max(2, bw * 0.7), height: h, rx: 2, fill: '#1d6fb5' }));
      if ((i + 1) % 5 === 0 || i === 0) { var t = svg('text', { x: x + bw * 0.35, y: H - 7, 'text-anchor': 'middle', 'font-size': 9, fill: '#7a8ea5' }); t.textContent = i + 1; s.appendChild(t); }
    });
    blk.appendChild(s); blk.appendChild(el('div', 'mr-note', 'แกนนอน = วันที่ของเดือน · แกนตั้ง = จำนวนเที่ยวต่อวัน'));
    return blk;
  }

  function twoCol(a, b) { var w = el('div', 'mr-two'); w.appendChild(a); w.appendChild(b); return w; }
  function miniList(title, rows, unit) {
    var blk = el('div', 'mr-block'); blk.appendChild(el('h3', 'mr-h3', title));
    if (!rows.length) { blk.appendChild(el('div', 'mr-note', 'ไม่มีข้อมูลในเดือนนี้')); return blk; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
    rows.forEach(function (r) {
      var line = el('div', 'mr-bar'); line.appendChild(el('span', 'mr-bn', r.name));
      var tr = el('span', 'mr-bt'), fill = el('i'); fill.style.width = Math.max(3, r.v / max * 100) + '%'; tr.appendChild(fill); line.appendChild(tr);
      line.appendChild(el('b', 'mr-bv', fmt(r.v) + (unit ? ' ' + unit : ''))); blk.appendChild(line);
    });
    return blk;
  }

  function buildReport(S) {
    var pg = new Pager(S), M = S.M, PM = S.PM, C = S.C, PC = S.PC;

    // สรุปภาพรวม
    var sum = el('div', 'mr-block mr-sum'); sum.appendChild(el('h3', 'mr-h3', 'สรุปผลการใช้งานระบบ'));
    var ul = el('ul'); insights(S).forEach(function (t) { ul.appendChild(el('li', null, t)); }); sum.appendChild(ul); pg.add(sum);

    // KPI
    var g = el('div', 'mr-kpis');
    g.appendChild(kpiCard('เที่ยวรวม', fmt(M.trips), 'เที่ยว', delta(M.trips, PM.trips), null));
    g.appendChild(kpiCard('ระยะทางรวม', fmt(M.km), 'กม.', delta(M.km, PM.km), null));
    g.appendChild(kpiCard('น้ำมันที่เติม', fmt(M.liters, 1), 'ลิตร', delta(M.liters, PM.liters), null));
    g.appendChild(kpiCard('ค่าน้ำมันรวม', fmt(M.baht), 'บาท', delta(M.baht, PM.baht), false));
    g.appendChild(kpiCard('ตรวจสภาพรถ', fmt(C.checks), 'ครั้ง', delta(C.checks, PC.checks), true));
    g.appendChild(kpiCard('พบรายการผิดปกติ', fmt(C.withIssue), 'ครั้ง', delta(C.withIssue, PC.withIssue), false));
    g.appendChild(kpiCard('รถที่ใช้งาน', S.vehicles.filter(function (v) { return v.trips > 0; }).length + ' / ' + S.vehTotal, 'คัน', null, null));
    g.appendChild(kpiCard('ความพึงพอใจเฉลี่ย', S.SAT.avg === null ? '—' : String(S.SAT.avg), S.SAT.avg === null ? '' : '/ 5', null, null));
    pg.add(g);

    // ตารางรายคัน
    pg.addTable('สรุปการใช้งานรายคัน', [
      { label: 'ทะเบียน' }, { label: 'ประเภท' },
      { label: 'เที่ยว', cls: 'r' }, { label: 'กม.', cls: 'r' }, { label: 'เติมน้ำมัน (ครั้ง)', cls: 'r' },
      { label: 'ลิตร', cls: 'r' }, { label: 'บาท', cls: 'r' }, { label: 'กม./ลิตร*', cls: 'r' }, { label: 'ตรวจ (ครั้ง)', cls: 'r' }, { label: 'ผิดปกติ', cls: 'r' }
    ], S.vehicles.map(function (v) {
      return [{ t: v.plate, cls: 'b' }, { t: v.type || '—' }, { t: fmt(v.trips), cls: 'r' }, { t: fmt(v.km), cls: 'r' }, { t: fmt(v.fills), cls: 'r' },
        { t: v.liters ? fmt(v.liters, 1) : '—', cls: 'r' }, { t: v.baht ? fmt(v.baht) : '—', cls: 'r' }, { t: v.kmpl ? fmt(v.kmpl, 1) : '—', cls: 'r' },
        { t: fmt(v.checks), cls: 'r' }, { t: v.issues ? fmt(v.issues) : '0', cls: 'r' + (v.issues ? ' warn' : '') }];
    }).concat(S.vehicles.length ? [[{ t: 'รวม', cls: 'b tot' }, { t: '', cls: 'tot' }, { t: fmt(M.trips), cls: 'r b tot' }, { t: fmt(M.km), cls: 'r b tot' }, { t: fmt(M.fills), cls: 'r b tot' },
      { t: fmt(M.liters, 1), cls: 'r b tot' }, { t: fmt(M.baht), cls: 'r b tot' }, { t: S.kmpl ? fmt(S.kmpl, 1) : '—', cls: 'r b tot' }, { t: fmt(C.checks), cls: 'r b tot' }, { t: fmt(C.withIssue), cls: 'r b tot' }]] : []));
    var note = el('div', 'mr-note', '* กม./ลิตร = ระยะทางรวมของเดือน ÷ น้ำมันที่บันทึกในเดือนนั้น (ค่าประมาณ — ขึ้นกับความครบถ้วนของการบันทึกน้ำมัน) · น้ำมันนับรวมที่เติมตอนออกและตอนกลับ'
      + (S.idle.length ? ' · รถที่ไม่มีการใช้งาน/ตรวจในเดือนนี้: ' + S.idle.join(', ') : ''));
    pg.add(note);

    pg.add(dailyChart(S));

    pg.add(twoCol(
      miniList('พนักงานขับรถ (จำนวนเที่ยว, 10 อันดับแรก)', S.drivers.slice(0, 10).map(function (d) { return { name: d.name, v: d.trips }; }), 'เที่ยว'),
      miniList('ปลายทางที่ไปบ่อย (10 อันดับแรก)', S.dests.slice(0, 10).map(function (d) { return { name: d.name, v: d.count }; }), 'ครั้ง')
    ));

    var insp = el('div', 'mr-block'); insp.appendChild(el('h3', 'mr-h3', 'การตรวจสภาพรถ'));
    var il = el('ul', 'mr-ul');
    il.appendChild(el('li', null, 'ตรวจทั้งหมด ' + fmt(C.checks) + ' ครั้ง ครอบคลุม ' + Object.keys(C.days).length + ' จาก ' + S.days + ' วัน'));
    il.appendChild(el('li', null, 'พบรายการผิดปกติ ' + fmt(C.withIssue) + ' ครั้ง' + (C.checks ? ' (' + pct(C.withIssue, C.checks) + '% ของการตรวจ)' : '') + ' รวม ' + fmt(C.issueItems) + ' รายการ'));
    if (!S.items.length) il.appendChild(el('li', null, 'ไม่พบรายการผิดปกติที่ต้องติดตาม'));
    insp.appendChild(il);
    if (S.items.length) insp.appendChild(miniList('รายการที่พบผิดปกติบ่อย (5 อันดับแรก)', S.items.slice(0, 5).map(function (x) { return { name: x.name, v: x.count }; }), 'ครั้ง'));

    var sat = el('div', 'mr-block'); sat.appendChild(el('h3', 'mr-h3', 'ความพึงพอใจผู้ใช้บริการ'));
    if (!S.SAT.count) sat.appendChild(el('div', 'mr-note', 'ไม่มีการประเมินความพึงพอใจในเดือนนี้'));
    else {
      sat.appendChild(el('div', 'mr-note', 'คะแนนเฉลี่ย ' + S.SAT.avg + ' / 5 จาก ' + fmt(S.SAT.count) + ' การประเมิน'));
      sat.appendChild(miniList('การกระจายคะแนน', [5, 4, 3, 2, 1].map(function (k) { return { name: k + ' ดาว', v: S.SAT.dist[k] }; }), 'คน'));
    }
    pg.add(twoCol(insp, sat));
    if (M.gapKm > 0) pg.add(el('div', 'mr-note', 'หมายเหตุ: ระยะทางที่หายไประหว่างเลขไมล์ของทริปติดกัน (ตามที่ระบบตรวจพบ) รวม ' + fmt(M.gapKm) + ' กม. ในเดือนนี้'));

    if (S.GIS) addGis(pg, S.GIS);
    pg.add(creditBlock());
    // กันเครดิตไปอยู่หน้าเดียวโดดๆ: ถ้าหน้าสุดท้ายมีแต่เครดิต ย้ายบล็อกสุดท้ายของหน้าก่อนหน้ามาอยู่กับเครดิต
    var lastPg = pg.cur();
    if (lastPg.body.children.length === 1 && pg.pages.length > 1) {
      var mv = pg.pages[pg.pages.length - 2].body.lastElementChild; if (mv) lastPg.body.insertBefore(mv, lastPg.body.firstChild);
    }

    pg.finish();
    return pg;
  }


  // ───────────── ส่วนวิเคราะห์เชิงพื้นที่ (GIS) + เครดิต ─────────────
  function smallTable(title, cols, rows) {
    var blk = el('div', 'mr-block'); blk.appendChild(el('h3', 'mr-h3', title));
    var tbl = el('table', 'mr-table'), thead = el('thead'), htr = el('tr'), tb = el('tbody');
    cols.forEach(function (c) { htr.appendChild(el('th', c.cls || '', c.label)); });
    thead.appendChild(htr); tbl.appendChild(thead);
    rows.forEach(function (r) { var tr = el('tr'); r.forEach(function (c, i) { tr.appendChild(el('td', c.cls || (cols[i] && cols[i].cls) || '', c.t)); }); tb.appendChild(tr); });
    tbl.appendChild(tb); blk.appendChild(tbl); return blk;
  }
  function gisKpi(label, value, unit, sub) {
    var c = el('div', 'mr-kpi'); c.appendChild(el('div', 'mr-kl', label));
    var v = el('div', 'mr-kv'); v.appendChild(document.createTextNode(value)); if (unit) v.appendChild(el('small', null, ' ' + unit)); c.appendChild(v);
    c.appendChild(el('div', 'mr-kd flat', sub || ' ')); return c;
  }
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }

  function addGis(pg, G) {
    var B = window.SandMonthlyGIS, M = G.map;
    pg.newPage();
    var h2 = el('h2', 'mr-h2', 'ส่วนที่ 2 · การวิเคราะห์เชิงพื้นที่ (GIS): แผนที่เส้นทางและรัศมีการเดินรถ'); pg.add(h2);

    if (M && M.url) {
      var mb = el('div', 'mr-block'); mb.appendChild(el('h3', 'mr-h3', 'แผนที่เส้นทางจาก รพ.สันทราย ไปยังปลายทาง (เดือนนี้)'));
      var im = new Image(); im.src = M.url; im.alt = 'แผนที่เส้นทางและรัศมีการเดินรถ'; im.className = 'mr-map'; im.width = M.w; im.height = M.h;
      mb.appendChild(im);
      var lg = el('div', 'mr-legend'); lg.appendChild(el('span', 'mr-lg-t', 'สีเส้น/หมุด = ระยะทางถนนจาก รพ.:'));
      B.BAND_LABELS.forEach(function (lb, i) { var s = el('span', 'mr-lg'); var d = el('i'); d.style.background = B.BAND_COL[i]; s.appendChild(d); s.appendChild(document.createTextNode(lb)); lg.appendChild(s); });
      mb.appendChild(lg);
      mb.appendChild(el('div', 'mr-note', 'เส้น = เส้นทางตามถนนจริงจาก รพ. · ความหนาเส้น = จำนวนครั้งที่ไป · หมายเลข = ลำดับในตารางปลายทาง' +
        (M.tilesOk ? '' : ' · (โหลดภาพแผนที่พื้นหลังไม่สำเร็จ — แสดงเฉพาะรัศมีและเส้นทาง)') +
        (G.dests.length > 12 ? ' · แสดงหมายเลข 12 อันดับแรก ปลายทางที่เหลือแสดงเป็นจุดเล็ก' : '')));
      pg.add(mb);
    }

    if (G.dests.length) {
      var k = el('div', 'mr-kpis');
      k.appendChild(gisKpi('ปลายทางที่มีพิกัด', fmt(G.dests.length), 'จุด', 'ครอบคลุม ' + G.coverage + '% ของการไป'));
      k.appendChild(gisKpi('ระยะทางเดียวเฉลี่ย*', fmt(G.wAvg, 1), 'กม.', 'ไป-กลับ ≈ ' + fmt(G.wAvg * 2, 1) + ' กม.'));
      k.appendChild(gisKpi('ไกลที่สุด', G.farthest ? fmt(G.farthest.km, 1) : '—', 'กม.', G.farthest ? G.farthest.name : ''));
      k.appendChild(gisKpi('รัศมีกระจายตัว*', fmt(G.stdDist, 1), 'กม.', 'Standard Distance'));
      k.appendChild(gisKpi('ในรัศมี 20 กม.', G.within20 + '', '%', 'ในรัศมี 10 กม. ' + G.within10 + '%'));
      k.appendChild(gisKpi('วงรอบจริง/เที่ยว', fmt(G.trip.mean, 1), 'กม.', 'มัธยฐาน ' + fmt(G.trip.med, 1) + ' กม.'));
      k.appendChild(gisKpi('P90 ต่อเที่ยว', fmt(G.trip.p90, 1), 'กม.', 'เที่ยวไกลสุด ' + fmt(G.trip.max, 1) + ' กม.'));
      k.appendChild(gisKpi('เที่ยวแวะ ≥ 2 จุด', G.multiStopPct + '', '%', G.durMed ? 'ออก-กลับ ~' + Math.round(G.durMed) + ' นาที' : ''));
      pg.add(k);

      pg.add(twoCol(
        smallTable('ช่วงรัศมีทางถนน', [{ label: 'ช่วง' }, { label: 'จุด', cls: 'r' }, { label: 'ครั้ง', cls: 'r' }, { label: '%', cls: 'r' }, { label: 'กม. (ไป-กลับ)*', cls: 'r' }],
          G.bands.map(function (b) { return [{ t: b.label, cls: 'b' }, { t: fmt(b.dests), cls: 'r' }, { t: fmt(b.visits), cls: 'r' }, { t: b.pct + '%', cls: 'r' }, { t: fmt(b.estKm), cls: 'r' }]; })),
        miniList('ทิศของปลายทางจาก รพ. (จำนวนครั้ง)', G.sectors.filter(function (s) { return s.v > 0; }).sort(function (a, b) { return b.v - a.v; }).map(function (s) { return { name: s.name, v: s.v }; }), 'ครั้ง')
      ));

      var top = G.dests.slice(0, 12);
      pg.addTable('ปลายทางที่ไปบ่อย — ระยะทางและเวลาเดินทาง' + (G.dests.length > 12 ? ' (12 อันดับแรก จาก ' + G.dests.length + ' จุด)' : ''), [
        { label: '#', cls: 'r' }, { label: 'ปลายทาง' }, { label: 'ช่วง (กม.)' }, { label: 'ครั้ง', cls: 'r' }, { label: 'ทางเดียว (กม.)', cls: 'r' }, { label: 'ไป-กลับ (กม.)', cls: 'r' }, { label: 'เวลาทางเดียว (นาที)', cls: 'r' }, { label: 'รวม (กม.)*', cls: 'r' }
      ], top.map(function (d) {
        var ap = d.approx ? '≈' : '';
        return [{ t: String(d.rank), cls: 'r' }, { t: d.name, cls: 'b' }, { t: B.BAND_LABELS[d.band].replace(' กม.', '') }, { t: fmt(d.count), cls: 'r' }, { t: ap + fmt(d.km, 1), cls: 'r' }, { t: ap + fmt(d.km * 2, 1), cls: 'r' }, { t: ap + fmt(d.min), cls: 'r' }, { t: fmt(d.count * 2 * d.km), cls: 'r' }];
      }));
    }

    pg.add(twoCol(
      miniList('วงรอบจริงต่อเที่ยว (จากเลขไมล์) — จำนวนเที่ยว', G.tripBins.filter(function (x) { return x.v > 0; }), 'เที่ยว'),
      smallTable('วงรอบรายคัน (กม./เที่ยว)', [{ label: 'ทะเบียน' }, { label: 'เที่ยว', cls: 'r' }, { label: 'เฉลี่ย', cls: 'r' }, { label: 'มัธยฐาน', cls: 'r' }, { label: 'สูงสุด', cls: 'r' }],
        G.plates.slice(0, 6).map(function (p) { return [{ t: p.plate, cls: 'b' }, { t: fmt(p.trips), cls: 'r' }, { t: fmt(p.avg, 1), cls: 'r' }, { t: fmt(p.med, 1), cls: 'r' }, { t: fmt(p.max, 1), cls: 'r' }]; }))
    ));

    var an = el('div', 'mr-block mr-sum'); an.appendChild(el('h3', 'mr-h3', 'ข้อวิเคราะห์เชิงพื้นที่'));
    var ul = el('ul'); G.insights.forEach(function (t) { ul.appendChild(el('li', null, t)); }); an.appendChild(ul); pg.add(an);

    var noteTxt = '* วิธีการ: ระยะทางเดียว = ระยะทางถนนจริงจาก รพ.สันทราย (OSRM/OpenStreetMap) ไปยังหมุดพิกัดในชีต Locations; ค่า ≈ = ประมาณจากเส้นตรง × 1.35 เมื่อเรียกบริการเส้นทางไม่ได้ · '
      + '"กม. (ไป-กลับ)" และ "รวม" = ระยะทางเดียว × 2 × จำนวนครั้ง (สมมติเที่ยวละ 1 จุด จึงเป็นค่าเทียบเคียง ไม่ใช่ไมล์จริง — ไมล์จริงดูที่ "วงรอบจริง" ซึ่งมาจากเลขไมล์ที่บันทึก) · '
      + 'เที่ยวที่แวะหลายจุดนับทุกจุดที่ไป · Standard Distance = รากที่สองของค่าเฉลี่ยกำลังสองของระยะทางเดียว ถ่วงน้ำหนักตามจำนวนครั้ง';
    if (G.unmapped.length) noteTxt += ' · ปลายทางที่ยังไม่ปักหมุดจึงไม่ถูกนับ: ' + G.unmapped.slice(0, 8).map(function (u) { return u.name + ' (' + u.count + ')'; }).join(', ') + (G.unmapped.length > 8 ? ' ฯลฯ' : '');
    if (G.outside && G.outside.length) noteTxt += ' · ปลายทางนอกกรอบแผนที่ (แสดงเป็นลูกศรที่ขอบ): ' + G.outside.map(function (o) { return o.name + ' ' + fmt(o.km) + ' กม.'; }).join(', ');
    if (G.localVisits) noteTxt += ' · ไม่นับงานภายใน รพ.สันทราย ' + fmt(G.localVisits) + ' ครั้ง';
    pg.add(el('div', 'mr-note', noteTxt));
  }

  function creditBlock() {
    var c = el('div', 'mr-credit');
    c.appendChild(el('div', 'mr-cr-k', 'ผู้จัดทำรายงาน'));
    c.appendChild(el('div', 'mr-cr-n', 'นายจันทกรณ์ จีกัน (Chanthakon Chikan)'));
    c.appendChild(el('div', null, 'นักวิชาการสาธารณสุขชำนาญการ · กลุ่มงานพัฒนาคุณภาพบริการและมาตรฐาน · โรงพยาบาลสันทราย จังหวัดเชียงใหม่'));
    c.appendChild(el('div', null, 'โทรศัพท์: 053-921-199 ต่อ 168'));
    return c;
  }

  // ───────────── สร้าง PDF + บันทึก ─────────────
  function setStatus(msg, kind) {
    var b = $('mrStatus'); if (!b) return;
    b.className = 'mr-status' + (kind ? ' ' + kind : ''); b.textContent = msg || '';
    b.style.display = msg ? 'block' : 'none';
  }
  function setBusy(on) {
    st.busy = on;
    ['mrCreate', 'mrMonth', 'mrHtml'].forEach(function (id) { var e = $(id); if (e) e.disabled = on; });
    var c = $('mrCreate'); if (c) c.textContent = on ? 'กำลังสร้างรายงาน…' : 'สร้างรายงาน & บันทึกลง Google Drive';
  }

  function generate(ym, opts) {
    opts = opts || {};
    if (st.busy) return Promise.resolve({ status: 'busy' });
    setBusy(true); setStatus('กำลังดึงข้อมูลล่าสุดของเดือน ' + monthLabel(ym) + '…', 'info');
    var p0 = ym.split('-'), last = daysIn(ym);
    var sd = '01/' + p0[1] + '/' + p0[0], ed = pad2(last) + '/' + p0[1] + '/' + p0[0];
    var pager = null;
    return Promise.all([
      getJson(GAS_URL + '?action=getData'),
      getJson(GAS_URL + '?action=getMileData'),
      getJson(GAS_URL + '?action=getSatisfactionData&limit=2000&startDate=' + sd + '&endDate=' + ed).catch(function () { return { data: [] }; }),
      getJson(GAS_URL + '?action=getLocationPins').catch(function () { return { data: [] }; })
    ]).then(function (res) {
      if (!res[0] || res[0].status === 'error') throw new Error((res[0] && res[0].message) || 'ดึงข้อมูลการตรวจสภาพไม่สำเร็จ');
      if (!res[1] || res[1].status === 'error') throw new Error((res[1] && res[1].message) || 'ดึงข้อมูลไมล์ไม่สำเร็จ');
      var S = buildStats(ym, res[0].data || [], res[1].data || [], res[2]);
      if (!S.hasData) { var e = new Error('ไม่มีข้อมูลการใช้งานในเดือน ' + S.label); e.noData = true; throw e; }
      setStatus('กำลังวิเคราะห์เส้นทางและรัศมีการเดินรถ (GIS)…', 'info');
      return computeGis(S, res[1].data || [], res[3]).then(function (gis) {
        S.GIS = gis; setStatus('กำลังจัดทำรายงาน PDF…', 'info');
        return ensureLibs();
      }).then(function () {
        pager = buildReport(S);
        var fonts = document.fonts && document.fonts.load ? Promise.all([
          document.fonts.load('400 14px "Noto Sans Thai"'), document.fonts.load('700 14px "Noto Sans Thai"'), document.fonts.ready
        ]).catch(function () {}) : Promise.resolve();
        return fonts;
      }).then(function () { return renderPdf(S, pager); });
    }).then(function (pdfB64) {
      setStatus('กำลังบันทึกไฟล์ลง Google Drive…', 'info');
      return fetch(GAS_URL, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'saveMonthlyReport', ym: ym, fileName: fileNameOf(ym), pdfBase64: pdfB64, overwrite: !!opts.overwrite, source: opts.auto ? 'auto' : 'manual' })
      }).then(function (r) { return r.json(); });
    }).then(function (j) {
      if (pager) pager.destroy();
      if (j.status === 'exists') { setStatus('มีรายงานเดือน ' + monthLabel(ym) + ' เก็บไว้แล้ว (ไม่ได้บันทึกทับ)', 'info'); return loadList().then(function () { return j; }); }
      if (j.status !== 'ok') throw new Error(j.message || 'บันทึกไม่สำเร็จ');
      setStatus((opts.auto ? 'บันทึกรายงานเดือน ' + monthLabel(ym) + ' อัตโนมัติแล้ว ✓' : 'บันทึกรายงานเดือน ' + monthLabel(ym) + ' ลง Google Drive เรียบร้อย ✓'), 'ok');
      return loadList().then(function () { return j; });
    }).catch(function (e) {
      if (pager) pager.destroy();
      setStatus(e.noData ? e.message : 'สร้างรายงานไม่สำเร็จ: ' + (e && e.message ? e.message : e), e.noData ? 'info' : 'err');
      return { status: 'error', message: String(e && e.message || e), noData: !!e.noData };
    }).then(function (r) { setBusy(false); return r; });
  }

  // ───────────── รายงานแบบ HTML โต้ตอบ (เปิดในแท็บใหม่ / บันทึกเป็นไฟล์จากในหน้ารายงาน) ─────────────
  function openHtml(ym) {
    if (st.busy) return Promise.resolve({ status: 'busy' });
    var w = null; try { w = window.open('', '_blank'); } catch (e) { w = null; }          // เปิดแท็บทันทีตอนคลิก กัน popup blocker
    if (w) try { w.document.write('<p style="font:16px sans-serif;padding:24px">กำลังสร้างรายงาน…</p>'); } catch (e) {}
    setBusy(true); setStatus('กำลังดึงข้อมูลเดือน ' + monthLabel(ym) + ' เพื่อสร้างรายงาน HTML…', 'info');
    var p0 = ym.split('-'), sd = '01/' + p0[1] + '/' + p0[0], ed = pad2(daysIn(ym)) + '/' + p0[1] + '/' + p0[0];
    return Promise.all([
      getJson(GAS_URL + '?action=getData'), getJson(GAS_URL + '?action=getMileData'),
      getJson(GAS_URL + '?action=getSatisfactionData&limit=2000&startDate=' + sd + '&endDate=' + ed).catch(function () { return { data: [] }; }),
      getJson(GAS_URL + '?action=getLocationPins').catch(function () { return { data: [] }; }),
      loadScript('js/monthly-html.js?v=1')
    ]).then(function (res) {
      if (!res[0] || res[0].status === 'error') throw new Error((res[0] && res[0].message) || 'ดึงข้อมูลการตรวจสภาพไม่สำเร็จ');
      if (!res[1] || res[1].status === 'error') throw new Error((res[1] && res[1].message) || 'ดึงข้อมูลไมล์ไม่สำเร็จ');
      var S = buildStats(ym, res[0].data || [], res[1].data || [], res[2]);
      if (!S.hasData) { var e = new Error('ไม่มีข้อมูลการใช้งานในเดือน ' + S.label); e.noData = true; throw e; }
      setStatus('กำลังวิเคราะห์เส้นทาง (GIS)…', 'info');
      return computeGis(S, res[1].data || [], res[3]).then(function (gis) {
        S.GIS = gis;
        var html = window.SandMonthlyHtml.build(S, insights(S));
        var url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        if (w) w.location.href = url; else window.open(url, '_blank');
        setTimeout(function () { URL.revokeObjectURL(url); }, 600000);
        setStatus('เปิดรายงาน HTML เดือน ' + S.label + ' แล้ว — กด "💾 บันทึกไฟล์" ในหน้ารายงานเพื่อเก็บไว้ ✓', 'ok');
      });
    }).catch(function (e) {
      if (w) try { w.close(); } catch (_) {}
      setStatus(e.noData ? e.message : 'สร้างรายงาน HTML ไม่สำเร็จ: ' + (e && e.message ? e.message : e), e.noData ? 'info' : 'err');
    }).then(function () { setBusy(false); });
  }

  function renderPdf(S, pager) {
    var JsPDF = window.jspdf.jsPDF;
    var pdf = new JsPDF({ unit: 'pt', format: 'a4', compress: true, orientation: 'portrait' });
    pdf.setProperties({ title: 'รายงานสรุปการใช้งานระบบ SAND ประจำเดือน ' + S.label, subject: 'SAND Monthly Report ' + S.ym, author: 'SAND — โรงพยาบาลสันทราย', creator: 'SAND' });
    var W = pdf.internal.pageSize.getWidth(), H = pdf.internal.pageSize.getHeight();
    var imgs = [].slice.call(pager.root.querySelectorAll('img')).map(function (im) { return im.decode ? im.decode().catch(function () {}) : Promise.resolve(); });
    var chain = Promise.all(imgs);                           // รอแผนที่/โลโก้ถอดรหัสเสร็จก่อนจับภาพ
    pager.pages.forEach(function (p, i) {
      chain = chain.then(function () {
        setStatus('กำลังจัดทำรายงาน PDF… (หน้า ' + (i + 1) + ' / ' + pager.pages.length + ')', 'info');
        return window.html2canvas(p.el, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: PAGE_W, height: PAGE_H, windowWidth: PAGE_W })
          .then(function (cv) {
            if (i > 0) pdf.addPage();
            pdf.addImage(cv.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W, H, undefined, 'FAST');
          });
      });
    });
    return chain.then(function () { return pdf.output('datauristring').split(',')[1]; });
  }

  // ───────────── รายการรายงานที่เก็บไว้ ─────────────
  function loadList() {
    var box = $('mrList'); if (box && !st.listLoaded) box.textContent = 'กำลังโหลดรายการ…';
    return getJson(GAS_URL + '?action=getMonthlyReports').then(function (j) {
      if (j.status !== 'ok') throw new Error(j.message || 'โหลดรายการไม่สำเร็จ');
      st.list = j.data || []; st.listLoaded = true; renderList();
    }).catch(function (e) {
      st.listLoaded = true; if (box) { box.textContent = ''; box.appendChild(el('div', 'mr-empty-row', 'โหลดรายการรายงานไม่สำเร็จ: ' + (e.message || e))); }
    });
  }

  function renderList() {
    var box = $('mrList'); if (!box) return; box.textContent = '';
    if (!st.list.length) { box.appendChild(el('div', 'mr-empty-row', 'ยังไม่มีรายงานที่เก็บไว้ — เลือกเดือนแล้วกด "สร้างรายงาน" ได้เลย')); return; }
    st.list.forEach(function (f) {
      var row = el('div', 'mr-row');
      var ic = el('div', 'mr-ico', 'PDF'); row.appendChild(ic);
      var info = el('div', 'mr-info');
      info.appendChild(el('div', 'mr-rt', 'รายงานประจำเดือน ' + monthLabel(f.ym)));
      info.appendChild(el('div', 'mr-rs', fmtBytes(f.size) + ' · บันทึกเมื่อ ' + fmtDT(f.updated)));
      row.appendChild(info);
      var act = el('div', 'mr-act');
      var b1 = el('button', 'mr-btn', 'เปิดดู'); b1.type = 'button'; b1.addEventListener('click', function () { openFile(f, false, b1); });
      var b2 = el('button', 'mr-btn ghost', 'ดาวน์โหลด'); b2.type = 'button'; b2.addEventListener('click', function () { openFile(f, true, b2); });
      var a3 = el('a', 'mr-btn ghost', 'Drive ↗'); a3.href = f.url; a3.target = '_blank'; a3.rel = 'noopener noreferrer'; a3.title = 'เปิดใน Google Drive (ต้องมีสิทธิ์เข้าถึงโฟลเดอร์)';
      var b4 = el('button', 'mr-btn ghost', 'สร้างใหม่'); b4.type = 'button'; b4.title = 'สร้างรายงานเดือนนี้ใหม่จากข้อมูลล่าสุดและบันทึกทับ';
      b4.addEventListener('click', function () { if (confirm('สร้างรายงานเดือน ' + monthLabel(f.ym) + ' ใหม่และบันทึกทับไฟล์เดิมหรือไม่?')) generate(f.ym, { overwrite: true }); });
      act.appendChild(b1); act.appendChild(b2); act.appendChild(a3); act.appendChild(b4); row.appendChild(act);
      box.appendChild(row);
    });
  }

  function b64ToBlob(b64, mime) {
    var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/pdf' });
  }
  function openFile(f, download, btn) {
    var w = null, old = btn.textContent; btn.disabled = true; btn.textContent = 'กำลังโหลด…';
    if (!download) { try { w = window.open('', '_blank'); } catch (e) { w = null; } }   // เปิดแท็บทันทีตอนคลิก กัน popup blocker
    getJson(GAS_URL + '?action=getMonthlyReportFile&id=' + encodeURIComponent(f.id)).then(function (j) {
      if (j.status !== 'ok' || !j.base64) throw new Error(j.message || 'ดึงไฟล์ไม่สำเร็จ');
      var url = URL.createObjectURL(b64ToBlob(j.base64, j.mime));
      if (!download && w) { w.location.href = url; }
      else { var a = document.createElement('a'); a.href = url; a.download = f.name || fileNameOf(f.ym); document.body.appendChild(a); a.click(); a.remove(); }
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function (e) {
      if (w) try { w.close(); } catch (_) {}
      setStatus('เปิดไฟล์ไม่สำเร็จ: ' + (e.message || e), 'err');
    }).then(function () { btn.disabled = false; btn.textContent = old; });
  }

  // ───────────── init / UI ─────────────
  function buildUI() {
    var host = $('monthlyReportBody'); if (!host || host.getAttribute('data-ready')) return; host.setAttribute('data-ready', '1');
    var bar = el('div', 'mr-bar2');
    var lab = el('label', 'mr-lab', 'เลือกเดือน'); lab.setAttribute('for', 'mrMonth');
    var sel = el('select', 'mr-sel'); sel.id = 'mrMonth';
    recentMonths(12).forEach(function (ym, i) { var o = el('option', null, monthLabel(ym) + (i === 0 ? ' (เดือนนี้ — ยังไม่ครบเดือน)' : '')); o.value = ym; sel.appendChild(o); });
    sel.value = prevYm(ymOf(todayBkk()));                  // ค่าเริ่มต้น = เดือนที่แล้ว (รายงานที่ครบเดือน)
    var go = el('button', 'mr-go', 'สร้างรายงาน & บันทึกลง Google Drive'); go.id = 'mrCreate'; go.type = 'button';
    go.addEventListener('click', function () {
      var ym = sel.value, ex = st.list.filter(function (x) { return x.ym === ym; })[0];
      if (ex && !confirm('มีรายงานเดือน ' + monthLabel(ym) + ' เก็บไว้แล้ว ต้องการสร้างใหม่และบันทึกทับหรือไม่?')) return;
      generate(ym, { overwrite: !!ex });
    });
    var hb = el('button', 'mr-go', 'ดูรายงานแบบ HTML (โต้ตอบได้)'); hb.id = 'mrHtml'; hb.type = 'button'; hb.title = 'เปิดรายงานแบบมีแท็บ ค้นหา เรียงตาราง และกราฟ — ไม่บันทึกลง Drive';
    hb.addEventListener('click', function () { openHtml(sel.value); });
    bar.appendChild(lab); bar.appendChild(sel); bar.appendChild(go); bar.appendChild(hb); host.appendChild(bar);
    var s = el('div', 'mr-status'); s.id = 'mrStatus'; s.setAttribute('role', 'status'); s.setAttribute('aria-live', 'polite'); s.style.display = 'none'; host.appendChild(s);
    var l = el('div', 'mr-list'); l.id = 'mrList'; host.appendChild(l);
    host.appendChild(el('div', 'mr-hint', 'ไฟล์ถูกเก็บในโฟลเดอร์ "SAND รายงานประจำเดือน" บน Google Drive ของเจ้าของระบบ · เปิดดู/ดาวน์โหลดจากหน้านี้ได้โดยไม่ต้องแชร์ไฟล์ · '
      + 'เมื่อขึ้นเดือนใหม่ ระบบจะสร้างรายงานเดือนที่แล้วให้อัตโนมัติเมื่อมีคนเปิดหน้า Dashboard'));
  }

  function autoPrevious() {
    var prev = prevYm(ymOf(todayBkk()));
    if (st.list.some(function (x) { return x.ym === prev; })) return;
    var key = 'sandMrAuto:' + prev, last = 0;
    try { last = +localStorage.getItem(key) || 0; } catch (e) {}
    if (Date.now() - last < 6 * 3600 * 1000) return;       // ลองไม่ถี่เกินไปถ้าครั้งก่อนล้มเหลว/ไม่มีข้อมูล
    try { localStorage.setItem(key, String(Date.now())); } catch (e) {}
    generate(prev, { auto: true, overwrite: false });
  }

  var inited = false;
  function init() {
    if (inited) return; inited = true; buildUI();
    loadList().then(function () { setTimeout(function () { if (!st.busy) autoPrevious(); }, 4000); });
  }

  window.SandMonthlyReport = { init: init, generate: generate, _stats: buildStats, _build: buildReport };
})();
