/* ============================================================
 *  sand-date.js — รูปแบบวันที่กลางของระบบ SAND : วัน/เดือน/ปี (dd/mm/yyyy)
 *
 *  1) SandDate.date(v)        → "27/11/2569"
 *     SandDate.dateTime(v)    → "27/11/2569 14:05"   (SandDate.dateTime(v,true) → มีวินาที)
 *     SandDate.month("2026-11") → "11/2569"
 *     SandDate.ymd(v)         → "2026-11-27" (ค่าภายใน — ไม่เปลี่ยน ใช้เทียบ/กรอง/ส่งเข้าชีท)
 *  2) <input type="date"> และ <input type="month"> ทุกช่อง (รวมที่สร้างทีหลัง) จะ "แสดง" เป็น
 *     วว/ดด/ปปปป แทนรูปแบบตามภาษาของเบราว์เซอร์ (เช่น mm/dd/yyyy)
 *     — ค่า .value ยังเป็น yyyy-MM-dd / yyyy-MM เหมือนเดิม โค้ดเดิมจึงไม่ต้องแก้
 *
 *  ปี: ค่าเริ่มต้นแสดงเป็น พ.ศ. (บวก 543) ให้ตรงกับหน้าตารางเวร
 *      ถ้าต้องการ ค.ศ. ให้ตั้ง  window.SAND_YEAR_OFFSET = 0  ก่อนโหลดไฟล์นี้
 *      หรือแก้ค่า DEFAULT_YEAR_OFFSET ด้านล่างเป็น 0
 * ============================================================ */
(function (global) {
  'use strict';

  var DEFAULT_YEAR_OFFSET = 543;
  var OFFSET = (typeof global.SAND_YEAR_OFFSET === 'number') ? global.SAND_YEAR_OFFSET : DEFAULT_YEAR_OFFSET;
  var TZ = 'Asia/Bangkok';
  var MIN_YEAR = 1950;   // ปีต่ำกว่านี้ = ค่าเวลาล้วนของ Google Sheets (30/12/1899) → ไม่ใช่วันที่จริง

  function p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

  var bkkFmt = null;
  function bkkParts(d) {
    try {
      if (!bkkFmt) bkkFmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
      var o = {};
      bkkFmt.formatToParts(d).forEach(function (x) { o[x.type] = x.value; });
      return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour % 24, mm: +o.minute, ss: +o.second, hasTime: true };
    } catch (e) {
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), ss: d.getSeconds(), hasTime: true };
    }
  }

  // แปลงค่าอะไรก็ได้ → {y,m,d,hh,mm,ss,hasTime} (ปี ค.ศ.) หรือ null
  function parts(val) {
    if (val === null || val === undefined || val === '') return null;
    if (val instanceof Date) return isNaN(val.getTime()) ? null : bkkParts(val);
    var s = String(val).trim();
    if (!s || s === '—' || s === '-' || s === 'undefined' || s === 'null') return null;
    var m;
    // yyyy-MM-dd[ T]HH:mm[:ss][.sss][Z|+07:00]
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
    if (m) {
      if (m[7] && m[4] !== undefined) {              // มี timezone → แปลงเป็นเวลาไทย
        var dt = new Date(s);
        if (!isNaN(dt.getTime())) return bkkParts(dt);
      }
      return { y: +m[1], m: +m[2], d: +m[3], hh: m[4] !== undefined ? +m[4] : 0, mm: m[5] !== undefined ? +m[5] : 0, ss: m[6] !== undefined ? +m[6] : 0, hasTime: m[4] !== undefined };
    }
    // dd/MM/yyyy[ HH:mm[:ss]]
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      var yy = +m[3]; if (yy > 2400) yy -= 543;     // เผื่อมีค่าที่เก็บเป็น พ.ศ.
      return { y: yy, m: +m[2], d: +m[1], hh: m[4] !== undefined ? +m[4] : 0, mm: m[5] !== undefined ? +m[5] : 0, ss: m[6] !== undefined ? +m[6] : 0, hasTime: m[4] !== undefined };
    }
    // สตริงวันที่ของ JS เช่น "Sat Dec 30 1899 ..." / "Fri Nov 27 2026 ..."
    if (/[A-Za-z]{3}/.test(s)) {
      var d2 = new Date(s);
      if (!isNaN(d2.getTime())) return bkkParts(d2);
    }
    return null;
  }

  function validDate(p) { return p && p.y >= MIN_YEAR && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= 31; }

  function ymd(val) {
    var p = parts(val);
    return validDate(p) ? (p.y + '-' + p2(p.m) + '-' + p2(p.d)) : '';
  }
  function date(val) {
    var p = parts(val);
    if (!validDate(p)) return (p || val === null || val === undefined) ? '' : String(val);
    return p2(p.d) + '/' + p2(p.m) + '/' + (p.y + OFFSET);
  }
  function time(val, withSec) {
    var p = parts(val);
    if (!p || !p.hasTime) return '';
    return p2(p.hh) + ':' + p2(p.mm) + (withSec ? ':' + p2(p.ss) : '');
  }
  function dateTime(val, withSec) {
    var p = parts(val);
    if (!p) return (val === null || val === undefined) ? '' : String(val);
    if (!validDate(p)) return p.hasTime ? time(val, withSec) : '';
    var out = p2(p.d) + '/' + p2(p.m) + '/' + (p.y + OFFSET);
    if (p.hasTime) out += ' ' + p2(p.hh) + ':' + p2(p.mm) + (withSec ? ':' + p2(p.ss) : '');
    return out;
  }
  function month(val) {                                // "2026-11" | วันที่ใดๆ → "11/2569"
    var s = String(val == null ? '' : val).trim();
    var m = s.match(/^(\d{4})-(\d{1,2})$/);
    if (m) return p2(+m[2]) + '/' + (+m[1] + OFFSET);
    var p = parts(val);
    return validDate(p) ? p2(p.m) + '/' + (p.y + OFFSET) : s;
  }
  function todayYmd() { var p = bkkParts(new Date()); return p.y + '-' + p2(p.m) + '-' + p2(p.d); }

  /* ---------- ปรับช่องเลือกวันที่ให้แสดง วว/ดด/ปปปป ---------- */
  var CSS =
    'input.sd-input{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;' +
    'background-repeat:no-repeat!important;background-origin:padding-box!important}' +
    'input.sd-input::-webkit-datetime-edit{opacity:0}' +
    'input.sd-input::-webkit-date-and-time-value{opacity:0}' +
    'input.sd-input::-webkit-calendar-picker-indicator{cursor:pointer}';
  function injectCss() {
    if (document.getElementById('sd-style')) return;
    var st = document.createElement('style'); st.id = 'sd-style'; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var valueDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function enhance(inp) {
    if (!inp || inp.__sd || inp.tagName !== 'INPUT') return;
    var kind = inp.type;
    if (kind !== 'date' && kind !== 'month') return;   // เบราว์เซอร์ที่ไม่รองรับ month จะเป็น text → ข้าม
    if (inp.getAttribute('aria-hidden') === 'true' || inp.hasAttribute('data-sd-skip')) return;   // ช่องที่ซ่อนไว้ใช้เปิดปฏิทินอย่างเดียว
    inp.__sd = true;
    var inRender = false;

    function render() {
      if (inRender) return; inRender = true;
      try {
        var v = valueDesc.get.call(inp);
        var empty = !v;
        var txt = empty ? (kind === 'date' ? 'วว/ดด/ปปปป' : 'ดด/ปปปป') : (kind === 'date' ? date(v) : month(v));
        inp.classList.remove('sd-input');                 // อ่านสไตล์จริงก่อนซ่อนตัวอักษรเดิม
        var cs = getComputedStyle(inp);
        var fs = parseFloat(cs.fontSize) || 14;
        var color = empty ? '#94a3b8' : (cs.color && cs.color !== 'rgba(0, 0, 0, 0)' ? cs.color : '#1e293b');
        var family = String(cs.fontFamily || 'sans-serif').replace(/"/g, "'");
        var weight = cs.fontWeight || '400';
        var padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
        var ta = cs.textAlign;
        inp.classList.add('sd-input');
        var w = Math.ceil(txt.length * fs * 0.66) + 6, h = Math.ceil(fs * 1.7);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<text x="0" y="' + (h / 2) + '" dominant-baseline="central" font-family="' + esc(family) + '" font-size="' + fs +
          '" font-weight="' + esc(weight) + '" fill="' + esc(color) + '">' + esc(txt) + '</text></svg>';
        var pos = (ta === 'center') ? 'center center'
                : (ta === 'right' || ta === 'end') ? ('right ' + (padR + 28) + 'px center')
                : (padL + 1) + 'px center';
        inp.style.setProperty('background-image', 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '")', 'important');
        inp.style.setProperty('background-position', pos, 'important');
        inp.style.setProperty('background-size', w + 'px ' + h + 'px', 'important');
      } catch (e) { /* ห้ามให้ตัวช่วยแสดงผลทำให้หน้าพัง */ }
      inRender = false;
    }

    // ดักการตั้งค่า .value ด้วยโค้ด (เช่น picker.value = today) เพื่ออัปเดตข้อความที่แสดง
    try {
      Object.defineProperty(inp, 'value', {
        configurable: true,
        get: function () { return valueDesc.get.call(this); },
        set: function (x) { valueDesc.set.call(this, x); render(); }
      });
    } catch (e) {}
    ['input', 'change', 'focus', 'blur'].forEach(function (ev) { inp.addEventListener(ev, render); });
    // คลิกที่ช่อง → เปิดปฏิทินทันที (ส่วน วว/ดด/ปปปป ถูกซ่อน จึงพิมพ์ทีละช่องไม่สะดวก)
    inp.addEventListener('click', function () {
      try { if (!inp.disabled && !inp.readOnly && inp.showPicker) inp.showPicker(); } catch (e) {}
    });
    if (inp.form) inp.form.addEventListener('reset', function () { setTimeout(render, 0); });
    inp.__sdRender = render;
    render();
  }

  function enhanceAll(root) {
    root = root || document;
    if (root.nodeType === 1 && root.tagName === 'INPUT') { enhance(root); return; }
    if (!root.querySelectorAll) return;
    var list = root.querySelectorAll('input[type="date"],input[type="month"]');
    for (var i = 0; i < list.length; i++) enhance(list[i]);
  }

  function boot() {
    injectCss();
    enhanceAll(document);
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) if (added[j].nodeType === 1) enhanceAll(added[j]);
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    // ฟอนต์เว็บโหลดเสร็จช้า → วาดข้อความใหม่ให้ใช้ฟอนต์ถูกตัว
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () {
      var list = document.querySelectorAll('input.sd-input');
      for (var i = 0; i < list.length; i++) if (list[i].__sdRender) list[i].__sdRender();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  global.SandDate = {
    YEAR_OFFSET: OFFSET,
    parts: parts, ymd: ymd, date: date, time: time, dateTime: dateTime, month: month, today: todayYmd,
    enhance: enhanceAll
  };
})(window);
