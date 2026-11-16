/* ============================================================
   sand-brand.js — SAND ชุดแบรนด์ + วิดเจ็ต "รถที่ยังไม่ตรวจสภาพ"
   1) วิดเจ็ตมุมขวาล่าง แสดงเฉพาะก่อน 10:00 น. (เวลาไทย) และเมื่อยังมีรถไม่ตรวจ
      - ค่าเริ่มต้นเป็นปุ่มกลมเล็ก (56px) ไม่บังเนื้อหา · แตะเพื่อขยายรายการ
      - หลบ UI ที่ fixed/sticky ชิดขอบล่างอยู่เดิมอัตโนมัติ · ซ่อนเองเมื่อถึง 10:00 โดยไม่ต้องรีโหลด
   2) ใส่ไอคอนประจำหน้าใน header
   ใช้ข้อมูลจาก GAS ?action=getStatusSummary (notCheckedToday) — ไม่ต้องแก้ Code.gs
   ============================================================ */
(function () {
  'use strict';

  var CFG = {
    cutoffMinutes: 10 * 60,                          // 10:00 น.
    tz: 'Asia/Bangkok',
    pollMs: 90 * 1000,                               // ดึงข้อมูลใหม่ทุก 90 วินาที (backend แคช 30 วิ)
    reminderPages: ['index', 'worktable'],           // หน้าฟอร์ม/แผนที่/แดชบอร์ดที่มีหน้ารหัสผ่านทับ ไม่ใส่ เพื่อไม่บังช่องกรอก
    checkUrl: 'check.html',
    maxListed: 4
  };
  var PAGE_ICON = {
    check: 'icons/inspect-96.webp', startmile: 'icons/odometer-96.webp', editmile: 'icons/odometer-96.webp',
    worktable: 'icons/schedule-96.webp', fixedcar: 'icons/repair-96.webp', EMScheck: 'icons/ems-96.webp',
    emsDashboard: 'icons/ems-96.webp', dashboard: 'icons/report-96.webp', routemap: 'icons/route-96.webp',
    linecontrol: 'icons/alert-96.webp', swap: 'icons/swap-96.webp', satisfaction: 'poses/cheer.webp'
  };

  var script = document.currentScript;
  var BASE = ((script && script.src) || '').replace(/sand-brand\.js.*$/, '') + 'assets/sand/';
  var page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html?$/i, '') || 'index';

  /* ---------- เวลา/วันที่ไทย ---------- */
  function bkk() {
    var parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: CFG.tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date())
      .forEach(function (p) { parts[p.type] = p.value; });
    return { ymd: parts.year + '-' + parts.month + '-' + parts.day, minutes: (+parts.hour) * 60 + (+parts.minute) };
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  /* ---------- 1) วิดเจ็ตแจ้งเตือน ---------- */
  var nc = null, list = [], vmeta = {}, timer = null;

  function build() {
    var root = document.createElement('div');
    root.className = 'sand-nc'; root.hidden = true;
    root.setAttribute('role', 'region'); root.setAttribute('aria-label', 'แจ้งเตือนรถที่ยังไม่ตรวจสภาพ');
    root.innerHTML =
      '<section class="sand-nc-card" id="sand-nc-card" hidden aria-label="รายการรถที่ยังไม่ตรวจสภาพ">' +
        '<div class="sand-nc-head"><picture><source srcset="' + BASE + 'anim/alert-still.webp" media="(prefers-reduced-motion: reduce)">' +
        '<img src="' + BASE + 'anim/alert.webp" alt="" width="48" height="40"></picture>' +
        '<div><strong id="sand-nc-title"></strong><span>ตรวจก่อน 10:00 น. เพื่อให้พร้อมออกปฏิบัติงาน</span></div>' +
        '<button type="button" class="sand-nc-x" aria-label="ย่อ">&times;</button></div>' +
        '<ul class="sand-nc-list" id="sand-nc-list"></ul><p class="sand-nc-more" id="sand-nc-more" hidden></p>' +
        '<div class="sand-nc-foot"><button type="button" class="sand-nc-hide">ซ่อนวันนี้</button>' +
        '<a href="' + CFG.checkUrl + '">ไปตรวจสภาพรถ</a></div></section>' +
      '<button type="button" class="sand-nc-fab" aria-expanded="false" aria-controls="sand-nc-card">' +
        '<picture><source srcset="' + BASE + 'anim/alert-still.webp" media="(prefers-reduced-motion: reduce)">' +
        '<img src="' + BASE + 'anim/alert.webp" alt="" width="52" height="52"></picture>' +
        '<span class="sand-nc-badge" id="sand-nc-badge"></span></button>';
    document.body.appendChild(root);
    var card = root.querySelector('.sand-nc-card'), fab = root.querySelector('.sand-nc-fab');
    function toggle(open) {
      card.hidden = !open; root.classList.toggle('is-open', open); fab.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) relayout();
    }
    fab.addEventListener('click', function () { toggle(card.hidden); });
    root.querySelector('.sand-nc-x').addEventListener('click', function () { toggle(false); fab.focus(); });
    root.querySelector('.sand-nc-hide').addEventListener('click', function () { lsSet('sand_nc_hide_' + bkk().ymd, '1'); toggle(false); evaluate(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !card.hidden) { toggle(false); fab.focus(); } });
    return { root: root, card: card, fab: fab };
  }

  function render() {
    var n = list.length;
    document.getElementById('sand-nc-badge').textContent = n > 99 ? '99+' : n;
    document.getElementById('sand-nc-title').textContent = 'ยังไม่ตรวจสภาพ ' + n + ' คัน';
    nc.fab.setAttribute('aria-label', 'รถยังไม่ตรวจสภาพ ' + n + ' คัน เปิดรายการ');
    document.getElementById('sand-nc-list').innerHTML = list.slice(0, CFG.maxListed).map(function (p) {
      var m = vmeta[p] || {};
      return '<li><b>' + esc(p) + '</b><em>' + esc(m.type || '') + '</em></li>';
    }).join('');
    var more = document.getElementById('sand-nc-more');
    more.hidden = n <= CFG.maxListed; more.textContent = n > CFG.maxListed ? 'และอีก ' + (n - CFG.maxListed) + ' คัน' : '';
  }

  /* ควรแสดงไหม: ก่อน 10:00 · ยังมีรถไม่ตรวจ · ยังไม่กดซ่อนของวันนี้ */
  function evaluate() {
    if (!nc) return;
    var t = bkk();
    var show = t.minutes < CFG.cutoffMinutes && list.length > 0 && lsGet('sand_nc_hide_' + t.ymd) !== '1';
    nc.root.hidden = !show;
    document.documentElement.classList.toggle('sand-nc-on', show);
    if (!show) { nc.card.hidden = true; nc.root.classList.remove('is-open'); }
    else { render(); relayout(); }
  }

  function ingest(json) {
    if (!json || json.status !== 'ok') return;
    var arr = json.notCheckedToday || [];
    list = arr.map(function (s) { return String(s).replace(/\s*ชม\.?\s*$/, '').trim(); }).filter(Boolean);
    vmeta = {};
    (json.vehicles || []).forEach(function (v) { vmeta[String(v.plate || '').replace(/\s*ชม\.?\s*$/, '').trim()] = v; });
    evaluate();
  }

  function load() {
    if (bkk().minutes >= CFG.cutoffMinutes) { evaluate(); return; }       // หลัง 10:00 ไม่ต้องยิง API เลย
    if (typeof GAS_URL === 'undefined' || !GAS_URL) return;
    fetch(GAS_URL + '?action=getStatusSummary').then(function (r) { return r.json(); }).then(ingest).catch(function () {});
  }

  /* วาดจากแคชของหน้าแรก (idx_status) ทันที ถ้าเป็นข้อมูลของวันนี้ — เห็นเร็ว ไม่รอเครือข่าย */
  function paintFromCache() {
    try {
      var c = JSON.parse(lsGet('idx_status') || 'null');
      if (c && c.json && c.json.today === bkk().ymd && Date.now() - c.ts < 15 * 60 * 1000) ingest(c.json);
    } catch (_) {}
  }

  /* ---------- หลบ UI เดิมที่ fixed/sticky ชิดล่างขวา ---------- */
  function relayout() {
    if (!nc || nc.root.hidden) return;
    var vw = window.innerWidth, vh = window.innerHeight, lift = 12, right = 12;
    var els = document.body.getElementsByTagName('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (nc.root.contains(el) || el === nc.root) continue;
      var cs = getComputedStyle(el), pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none' || +cs.opacity === 0) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      if (r.width >= vw * 0.9 && r.height >= vh * 0.9) continue;                      // overlay เต็มจอ (modal) ไม่นับ
      if (pos === 'sticky' && (r.bottom < vh - 40 || r.top < vh * 0.5)) continue;     // sticky ที่ไม่ได้ติดขอบล่างจริง
      if (r.bottom < vh * 0.4 || r.top > vh) continue;
      if (r.right < vw - 120 || r.left > vw - 8) continue;                            // ไม่ทับโซนมุมขวา
      lift = Math.max(lift, Math.round(vh - r.top + 10));
    }
    lift = Math.min(lift, Math.round(vh * 0.4));
    nc.root.style.setProperty('--sand-nc-bottom', lift + 'px');
    var vv = window.visualViewport;                                                   // หน้าที่เนื้อหากว้างเกินจอ: ดึงกลับเข้ากรอบที่เห็นจริง
    if (vv) right = Math.max(12, Math.round(window.innerWidth - (vv.offsetLeft + vv.width) + 12));
    nc.root.style.setProperty('--sand-nc-right', right + 'px');
  }

  function initReminder() {
    if (CFG.reminderPages.indexOf(page) < 0) return;
    nc = build();
    paintFromCache();
    load();
    timer = setInterval(function () { evaluate(); }, 20 * 1000);                      // เช็กเวลา 10:00 / ข้ามวัน
    setInterval(load, CFG.pollMs);
    window.addEventListener('resize', relayout);
    window.addEventListener('orientationchange', relayout);
    if (window.visualViewport) { visualViewport.addEventListener('resize', relayout); visualViewport.addEventListener('scroll', relayout); }
    setInterval(relayout, 3000);                                                       // UI เดิมอาจโผล่/หายทีหลัง (แถบล่าง, toast)
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { load(); evaluate(); } });
  }

  /* ---------- 2) ไอคอนประจำหน้าใน header ---------- */
  function addPageIcon() {
    var src = PAGE_ICON[page];
    if (!src || document.querySelector('.sand-page-ico')) return;
    var titles = document.querySelector('.site-header .header-titles, .site-header .header-title');
    var anchor = titles || document.querySelector('header h1');
    if (!anchor) return;
    var img = new Image();
    img.className = 'sand-page-ico' + (titles ? '' : ' is-inline');
    img.alt = ''; img.decoding = 'async'; img.src = BASE + src;
    anchor.parentNode.insertBefore(img, anchor);
  }

  function ready() { addPageIcon(); initReminder(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
