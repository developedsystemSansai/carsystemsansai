/* ============================================================================
   monthly-html.js — รายงานประจำเดือนแบบ HTML โต้ตอบ (ไฟล์เดียว เปิดออฟไลน์ได้)
   ใช้ข้อมูลชุดเดียวกับรายงาน PDF (สถิติ + GIS) · เรียกจาก js/monthly-report.js
   window.SandMonthlyHtml.build(S, insights) → สตริง HTML ทั้งไฟล์
   ลูกเล่น: แท็บ · ค้นหา/เรียงตาราง · กดแถวดูรายละเอียดรถ · กราฟ hover · ขยายแผนที่ · โหมดมืด · พิมพ์/บันทึกไฟล์
   ============================================================================ */
(function () {
  'use strict';

  // ───────── โค้ดฝั่งไฟล์รายงาน (ถูก serialize ใส่ในไฟล์ HTML) ─────────
  function clientApp(D) {
    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
    var f0 = function (x) { return (+x || 0).toLocaleString('th-TH', { maximumFractionDigits: 0 }); };
    var f1 = function (x) { return (+x || 0).toLocaleString('th-TH', { maximumFractionDigits: 1, minimumFractionDigits: 1 }); };
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var tip = $('#tip');
    function bindTip(root) {
      $$('[data-tip]', root).forEach(function (e) {
        e.addEventListener('mousemove', function (ev) { tip.textContent = e.getAttribute('data-tip'); tip.style.display = 'block'; tip.style.left = Math.min(ev.clientX + 14, innerWidth - 220) + 'px'; tip.style.top = (ev.clientY + 14) + 'px'; });
        e.addEventListener('mouseleave', function () { tip.style.display = 'none'; });
      });
    }
    function delta(c, p) { if (!p) return ''; var d = Math.round((c - p) / p * 1000) / 10; return '<span class="dl ' + (d >= 0 ? 'up' : 'dn') + '">' + (d >= 0 ? '▲ ' : '▼ ') + Math.abs(d) + '%</span> <small>เทียบ ' + esc(D.prevLabel) + '</small>'; }
    function kpi(l, v, u, sub) { return '<div class="kpi"><div class="kl">' + l + '</div><div class="kv">' + v + '<small> ' + (u || '') + '</small></div><div class="ks">' + (sub || '&nbsp;') + '</div></div>'; }
    function bars(rows, o) {   // rows: [{name, v, extra?}] → แท่งแนวนอน
      o = o || {}; var mx = Math.max.apply(null, rows.map(function (r) { return r.v; }).concat([1]));
      return '<div class="bars">' + rows.map(function (r) {
        return '<div class="br" data-tip="' + esc(r.name + ' : ' + f0(r.v) + (o.unit ? ' ' + o.unit : '') + (r.extra ? ' · ' + r.extra : '')) + '"><span class="bn">' + esc(r.name) + '</span><span class="bt"><i style="width:' + (r.v / mx * 100) + '%;background:' + (r.c || o.c || 'var(--pri)') + '"></i></span><b>' + f0(r.v) + '</b></div>';
      }).join('') + '</div>';
    }
    function sortable(tbl, rows, cols, rowFn) {   // ตารางเรียงได้
      var st = { k: cols[0].k, d: -1 };
      function draw() {
        var data = rows().slice();
        data.sort(function (a, b) { var x = a[st.k], y = b[st.k]; if (typeof x === 'string' || typeof y === 'string') return -st.d * String(x == null ? '' : x).localeCompare(String(y == null ? '' : y), 'th'); return st.d * ((x == null ? -1e12 : x) - (y == null ? -1e12 : y)); });
        tbl.innerHTML = '<thead><tr>' + cols.map(function (c) { return '<th data-k="' + c.k + '" class="' + (c.n ? 'num ' : '') + (c.k === st.k ? 'on' : '') + '">' + c.t + (c.k === st.k ? (st.d < 0 ? ' ▼' : ' ▲') : '') + '</th>'; }).join('') + '</tr></thead><tbody>' + (data.map(rowFn).join('') || '<tr><td colspan="' + cols.length + '" class="empty">ไม่พบข้อมูล</td></tr>') + '</tbody>';
        $$('th', tbl).forEach(function (th) { th.onclick = function () { var k = th.getAttribute('data-k'); if (st.k === k) st.d = -st.d; else { st.k = k; st.d = -1; } draw(); }; });
        bindTip(tbl);
      }
      draw(); return draw;
    }

    // ── ภาพรวม ──
    var M = D.M, PM = D.PM, C = D.C, G = D.GIS;
    $('#ov-kpi').innerHTML = kpi('เที่ยวการใช้รถ', f0(M.trips), 'เที่ยว', delta(M.trips, PM.trips)) + kpi('ระยะทางรวม', f0(M.km), 'กม.', delta(M.km, PM.km))
      + kpi('ค่าน้ำมัน', f0(M.baht), 'บาท', delta(M.baht, PM.baht)) + kpi('น้ำมันที่เติม', f0(M.liters), 'ลิตร', D.kmpl ? 'เฉลี่ย ' + f1(D.kmpl) + ' กม./ลิตร' : '')
      + kpi('ตรวจสภาพรถ', f0(C.checks), 'ครั้ง', C.checks ? 'ผิดปกติ ' + f0(C.withIssue) + ' ครั้ง (' + f1(C.withIssue / C.checks * 100) + '%)' : '')
      + kpi('รถที่ใช้งาน', f0(D.vehicles.filter(function (v) { return v.trips > 0; }).length), '/ ' + D.vehTotal + ' คัน', 'ใช้งาน ' + D.activeDays + ' จาก ' + D.days + ' วัน');
    $('#ov-ins').innerHTML = D.insights.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    var mxs = Math.max.apply(null, D.series.concat([1])), bw = 100 / D.series.length;
    $('#ov-day').innerHTML = '<svg viewBox="0 0 100 40" preserveAspectRatio="none" class="dchart">' + D.series.map(function (v, i) {
      var h = v / mxs * 36; return '<rect x="' + (i * bw + bw * .12) + '" y="' + (38 - h) + '" width="' + bw * .76 + '" height="' + Math.max(h, .4) + '" rx=".5" data-tip="วันที่ ' + (i + 1) + ' : ' + v + ' เที่ยว"/>';
    }).join('') + '</svg><div class="dax"><span>1</span><span>' + Math.ceil(D.days / 2) + '</span><span>' + D.days + '</span></div>';
    bindTip($('#ov-day'));

    // ── รถ ──
    var vType = '', vQ = '';
    $('#v-type').innerHTML = '<option value="">ทุกประเภท</option>' + Object.keys(D.vehicles.reduce(function (a, v) { a[v.type || '—'] = 1; return a; }, {})).map(function (t) { return '<option>' + esc(t) + '</option>'; }).join('');
    var vdraw = sortable($('#v-tbl'), function () { return D.vehicles.filter(function (v) { return (!vType || (v.type || '—') === vType) && (!vQ || (v.plate + ' ' + v.type).toLowerCase().indexOf(vQ) >= 0); }); },
      [{ k: 'plate', t: 'ทะเบียน' }, { k: 'type', t: 'ประเภท' }, { k: 'trips', t: 'เที่ยว', n: 1 }, { k: 'km', t: 'กม.', n: 1 }, { k: 'kmpl', t: 'กม./ลิตร', n: 1 }, { k: 'baht', t: 'น้ำมัน(บาท)', n: 1 }, { k: 'issues', t: 'ผิดปกติ', n: 1 }],
      function (v) {
        return '<tr class="vr" data-p="' + esc(v.plate) + '"><td><b>' + esc(v.plate) + '</b></td><td>' + esc(v.type || '—') + '</td><td class="num">' + f0(v.trips) + '</td><td class="num">' + f0(v.km) + '</td><td class="num">' + (v.kmpl ? f1(v.kmpl) : '—') + '</td><td class="num">' + f0(v.baht) + '</td><td class="num">' + (v.issues ? '<span class="pill bad">' + v.issues + '</span>' : '0') + '</td></tr>';
      });
    $('#v-tbl').addEventListener('click', function (e) {
      var tr = e.target.closest('tr.vr'); if (!tr) return; var nx = tr.nextElementSibling;
      if (nx && nx.classList.contains('vd')) { nx.remove(); return; }
      var v = D.vehicles.filter(function (x) { return x.plate === tr.getAttribute('data-p'); })[0], p = G && G.plates ? G.plates.filter(function (x) { return x.plate === v.plate; })[0] : null;
      var d = document.createElement('tr'); d.className = 'vd';
      d.innerHTML = '<td colspan="7"><div class="vdet"><div><b>' + f0(v.fills) + '</b> ครั้งที่เติมน้ำมัน · ' + f1(v.liters) + ' ลิตร</div><div><b>' + f0(v.checks) + '</b> ครั้งที่ตรวจสภาพ · ผิดปกติ ' + f0(v.issues) + '</div><div>เฉลี่ย <b>' + (v.trips ? f1(v.km / v.trips) : '—') + '</b> กม./เที่ยว</div>' + (p ? '<div>วงรอบจริง มัธยฐาน <b>' + f1(p.med) + '</b> · สูงสุด <b>' + f0(p.max) + '</b> กม.</div>' : '') + '</div></td>';
      tr.parentNode.insertBefore(d, tr.nextSibling);
    });
    $('#v-type').onchange = function () { vType = this.value; vdraw(); };
    $('#v-q').oninput = function () { vQ = this.value.trim().toLowerCase(); vdraw(); };
    $('#v-idle').innerHTML = D.idle.length ? '<b>ไม่มีการใช้งานในเดือนนี้ (' + D.idle.length + ' คัน):</b> ' + D.idle.map(function (p) { return '<span class="pill">' + esc(p) + '</span>'; }).join(' ') : '';

    // ── พขร. / ปลายทาง ──
    $('#d-bars').innerHTML = bars(D.drivers.slice(0, 15).map(function (d) { return { name: d.name, v: d.trips, extra: f0(d.km) + ' กม.' }; }), { unit: 'เที่ยว' });
    var kmOf = {}; if (G) G.dests.forEach(function (d) { kmOf[d.name] = d.km; });
    var dN = 15, dQ = '';
    function drawDest() {
      var rows = D.dests.filter(function (d) { return !dQ || d.name.toLowerCase().indexOf(dQ) >= 0; });
      $('#t-bars').innerHTML = bars(rows.slice(0, dN).map(function (d) { return { name: d.name, v: d.count, extra: kmOf[d.name] ? f1(kmOf[d.name]) + ' กม. จาก รพ.' : '' }; }), { unit: 'ครั้ง', c: 'var(--acc)' });
      $('#t-more').style.display = rows.length > dN ? '' : 'none'; $('#t-more').textContent = 'แสดงเพิ่ม (' + (rows.length - dN) + ' รายการ)'; bindTip($('#t-bars'));
    }
    $('#t-q').oninput = function () { dQ = this.value.trim().toLowerCase(); dN = 15; drawDest(); };
    $('#t-more').onclick = function () { dN += 20; drawDest(); }; drawDest();

    // ── ตรวจสภาพ ──
    $('#c-kpi').innerHTML = kpi('ตรวจสภาพรถ', f0(C.checks), 'ครั้ง', delta(C.checks, D.PC.checks)) + kpi('พบความผิดปกติ', f0(C.withIssue), 'ครั้ง', C.checks ? f1(C.withIssue / C.checks * 100) + '% ของการตรวจ' : '') + kpi('รายการผิดปกติรวม', f0(C.issueItems), 'รายการ', '');
    $('#c-bars').innerHTML = D.items.length ? bars(D.items.map(function (i) { return { name: i.name, v: i.count }; }), { unit: 'ครั้ง', c: 'var(--bad)' }) : '<p class="empty">ไม่พบรายการผิดปกติ 🎉</p>';
    var risk = D.vehicles.filter(function (v) { return v.issues > 0; }).sort(function (a, b) { return b.issues - a.issues; }).slice(0, 10);
    $('#c-risk').innerHTML = risk.length ? bars(risk.map(function (v) { return { name: v.plate, v: v.issues, extra: 'ตรวจ ' + v.checks + ' ครั้ง' }; }), { unit: 'ครั้งที่ผิดปกติ', c: 'var(--bad)' }) : '<p class="empty">ไม่มีรถที่พบความผิดปกติ</p>';

    // ── GIS ──
    if (G && G.dests && G.dests.length) {
      $('#g-kpi').innerHTML = kpi('ในรัศมี 10 กม.', f1(G.within10), '%', '') + kpi('ในรัศมี 20 กม.', f1(G.within20), '%', '') + kpi('ระยะเดียวเฉลี่ย', f1(G.wAvg), 'กม.', 'มัธยฐาน ' + f1(G.wMedian)) + kpi('ครอบคลุมจุดคงที่', f1(G.coverage), '%', f0(G.mappedVisits) + ' จาก ' + f0(G.totalVisits) + ' ครั้ง');
      $('#g-map').innerHTML = G.mapUrl ? '<img src="' + G.mapUrl + '" alt="แผนที่เส้นทางการเดินรถ" title="คลิกเพื่อขยาย">' : '<p class="empty">ไม่มีแผนที่</p>';
      var im = $('#g-map img'); if (im) im.onclick = function () { $('#lb img').src = im.src; $('#lb').style.display = 'flex'; };
      $('#g-band').innerHTML = bars(G.bands.map(function (b) { return { name: b.label, v: b.visits, c: b.color, extra: b.dests + ' จุด' }; }), { unit: 'ครั้ง' });
      var mxv = Math.max.apply(null, G.sectors.map(function (s) { return s.v; }).concat([1]));
      $('#g-sec').innerHTML = '<svg viewBox="-60 -60 120 120" class="polar">' + [20, 40].map(function (r) { return '<circle r="' + r + '" class="ring"/>'; }).join('') + G.sectors.map(function (s, i) {
        var a0 = (i * 45 - 22.5 - 90) * Math.PI / 180, a1 = (i * 45 + 22.5 - 90) * Math.PI / 180, r = 8 + s.v / mxv * 32;
        return '<path d="M0 0L' + (r * Math.cos(a0)).toFixed(1) + ' ' + (r * Math.sin(a0)).toFixed(1) + 'A' + r + ' ' + r + ' 0 0 1 ' + (r * Math.cos(a1)).toFixed(1) + ' ' + (r * Math.sin(a1)).toFixed(1) + 'Z" class="sec" data-tip="ทิศ' + s.name + ' : ' + f0(s.v) + ' ครั้ง"/>';
      }).join('') + '<text y="-50" class="cl">เหนือ</text><text y="55" class="cl">ใต้</text><text x="52" y="2" class="cl">ออก</text><text x="-52" y="2" class="cl">ตก</text></svg>';
      bindTip($('#g-sec'));
      $('#g-trip').innerHTML = bars(G.tripBins.map(function (b) { return { name: b.name, v: b.v }; }), { unit: 'เที่ยว', c: 'var(--acc)' }) + '<p class="sub">วงรอบจากเลขไมล์จริง: เฉลี่ย ' + f1(G.trip.mean) + ' · มัธยฐาน ' + f0(G.trip.med) + ' · P90 ' + f0(G.trip.p90) + ' · สูงสุด ' + f0(G.trip.max) + ' กม.</p>';
      var gq = '', gdraw = sortable($('#g-tbl'), function () { return G.dests.filter(function (d) { return !gq || d.name.toLowerCase().indexOf(gq) >= 0; }); },
        [{ k: 'rank', t: '#', n: 1 }, { k: 'name', t: 'ปลายทาง' }, { k: 'count', t: 'ครั้ง', n: 1 }, { k: 'km', t: 'ระยะถนน (กม.)', n: 1 }, { k: 'straight', t: 'เส้นตรง (กม.)', n: 1 }],
        function (d) { return '<tr><td class="num">' + d.rank + '</td><td>' + esc(d.name) + (d.approx ? ' <span class="pill">ประมาณ</span>' : '') + '</td><td class="num">' + f0(d.count) + '</td><td class="num"><span class="dot" style="background:' + G.bands[d.band].color + '"></span>' + f1(d.km) + '</td><td class="num">' + f1(d.straight) + '</td></tr>'; });
      $('#g-q').oninput = function () { gq = this.value.trim().toLowerCase(); gdraw(); };
      $('#g-ins').innerHTML = (G.insights || []).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
    } else { $('#tab-gis').innerHTML = '<p class="empty">ไม่มีข้อมูลวิเคราะห์เชิงพื้นที่ในเดือนนี้</p>'; }

    // ── ความพึงพอใจ ──
    var S5 = D.SAT;
    $('#s-body').innerHTML = S5.count ? '<div class="sat"><div class="big">' + S5.avg + '<small>/ 5</small></div><div class="stars">' + [1, 2, 3, 4, 5].map(function (i) { return '<span class="' + (i <= Math.round(S5.avg) ? 'on' : '') + '">★</span>'; }).join('') + '<div class="sub">จาก ' + f0(S5.count) + ' การประเมิน</div></div></div>'
      + bars([5, 4, 3, 2, 1].map(function (k) { return { name: k + ' ดาว', v: S5.dist[k], c: '#e6a817' }; }), { unit: 'คน' }) : '<p class="empty">ยังไม่มีการประเมินในเดือนนี้</p>';

    // ── แท็บ / ธีม / พิมพ์ / บันทึก ──
    function show(id) { $$('.tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-t') === id); }); $$('section.pane').forEach(function (s) { s.hidden = s.id !== 'tab-' + id; }); try { history.replaceState(null, '', '#' + id); } catch (e) {} scrollTo(0, 0); }
    $$('.tab').forEach(function (b) { b.onclick = function () { show(b.getAttribute('data-t')); }; });
    var h0 = (location.hash || '').slice(1); show(['veh', 'drv', 'chk', 'gis', 'sat'].indexOf(h0) >= 0 ? h0 : 'ov');
    $('#theme').onclick = function () { var d = document.documentElement.getAttribute('data-theme') === 'dark'; document.documentElement.setAttribute('data-theme', d ? 'light' : 'dark'); };
    $('#print').onclick = function () { $$('section.pane').forEach(function (s) { s.hidden = false; }); print(); show('ov'); };
    $('#save').onclick = function () { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['<!doctype html>\n' + document.documentElement.outerHTML], { type: 'text/html' })); a.download = 'SAND_Monthly_' + D.ym + '.html'; a.click(); };
    $('#lb').onclick = function () { this.style.display = 'none'; };
    bindTip(document);
  }

  var CSS = ':root{--bg:#f4f6fb;--card:#fff;--ink:#1c2a44;--mut:#6b7a96;--line:#e2e8f3;--pri:#1f5fbf;--acc:#2a9d8f;--bad:#d64545;--ok:#1b9e77}'
    + ':root[data-theme=dark]{--bg:#0f1624;--card:#18223a;--ink:#e8eefc;--mut:#98a6c4;--line:#27344f;--pri:#6aa3ff;--acc:#4cc2b3;--bad:#ff7a7a}'
    + '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Noto Sans Thai","Sarabun","Leelawadee UI",Tahoma,system-ui,sans-serif}'
    + 'header{background:linear-gradient(135deg,#142d59,#1f5fbf);color:#fff;padding:22px 20px 14px}header h1{margin:0;font-size:1.35rem}header p{margin:4px 0 0;opacity:.85;font-size:.85rem}'
    + '.tools{position:absolute;right:14px;top:14px;display:flex;gap:6px}.tools button{background:rgba(255,255,255,.16);color:#fff;border:0;border-radius:8px;padding:6px 10px;cursor:pointer;font:inherit;font-size:.8rem}'
    + 'nav{position:sticky;top:0;z-index:5;display:flex;gap:4px;overflow-x:auto;background:var(--card);border-bottom:1px solid var(--line);padding:6px 10px}.tab{border:0;background:none;color:var(--mut);padding:8px 14px;border-radius:8px;cursor:pointer;font:inherit;white-space:nowrap}.tab.on{background:var(--pri);color:#fff}'
    + 'main{max-width:1100px;margin:0 auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}.card h2{margin:0 0 10px;font-size:1.02rem}'
    + '.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.two{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}'
    + '.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}.kl{color:var(--mut);font-size:.8rem}.kv{font-size:1.7rem;font-weight:700}.kv small,.ks{font-size:.78rem;color:var(--mut);font-weight:400}'
    + '.dl.up{color:var(--ok)}.dl.dn{color:var(--bad)}ul.ins{margin:0;padding-left:1.1em}ul.ins li{margin:4px 0}.sub{color:var(--mut);font-size:.82rem}.empty{color:var(--mut);text-align:center;padding:14px}'
    + '.bars .br{display:grid;grid-template-columns:minmax(90px,170px) 1fr 52px;gap:8px;align-items:center;margin:5px 0;font-size:.86rem}.bn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{background:var(--line);border-radius:6px;height:14px;overflow:hidden}.bt i{display:block;height:100%;border-radius:6px}.br b{text-align:right}'
    + '.dchart{width:100%;height:130px}.dchart rect{fill:var(--pri)}.dchart rect:hover{fill:var(--acc)}.dax{display:flex;justify-content:space-between;color:var(--mut);font-size:.75rem}'
    + 'table{width:100%;border-collapse:collapse;font-size:.86rem}th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}th{cursor:pointer;color:var(--mut);font-weight:600;white-space:nowrap;user-select:none}th.on{color:var(--pri)}.num{text-align:right}tr.vr{cursor:pointer}tr.vr:hover{background:var(--bg)}.vdet{display:flex;flex-wrap:wrap;gap:6px 22px;padding:4px 2px;color:var(--mut)}.vdet b{color:var(--ink)}.wrap{overflow-x:auto}'
    + '.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}input,select{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:.86rem}'
    + '.pill{display:inline-block;background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:0 9px;font-size:.78rem}.pill.bad{background:var(--bad);border-color:var(--bad);color:#fff}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}'
    + '#g-map img{width:100%;border-radius:10px;cursor:zoom-in}#lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:20;align-items:center;justify-content:center;cursor:zoom-out}#lb img{max-width:96vw;max-height:94vh}'
    + '.polar{width:100%;max-width:280px;display:block;margin:auto}.ring{fill:none;stroke:var(--line)}.sec{fill:var(--pri);opacity:.8}.sec:hover{opacity:1;fill:var(--acc)}.cl{font-size:7px;fill:var(--mut);text-anchor:middle}'
    + '.sat{display:flex;gap:18px;align-items:center;margin-bottom:8px}.big{font-size:2.6rem;font-weight:700}.big small{font-size:1rem;color:var(--mut)}.stars span{color:var(--line);font-size:1.6rem}.stars span.on{color:#e6a817}'
    + '#tip{display:none;position:fixed;z-index:30;background:#142d59;color:#fff;padding:5px 10px;border-radius:7px;font-size:.8rem;pointer-events:none;max-width:260px}footer{text-align:center;color:var(--mut);font-size:.78rem;padding:20px}'
    + '@media print{header .tools,nav{display:none}body{background:#fff}.card{break-inside:avoid}section.pane{display:block!important}}';

  function build(S, insights) {
    var G = S.GIS || null;
    var D = {
      ym: S.ym, label: S.label, prevLabel: S.prevLabel, days: S.days, series: S.series, activeDays: S.activeDays, vehTotal: S.vehTotal, kmpl: S.kmpl,
      M: { trips: S.M.trips, km: S.M.km, liters: S.M.liters, baht: S.M.baht, fills: S.M.fills }, PM: { trips: S.PM.trips, km: S.PM.km, baht: S.PM.baht },
      C: { checks: S.C.checks, withIssue: S.C.withIssue, issueItems: S.C.issueItems }, PC: { checks: S.PC.checks },
      vehicles: S.vehicles.map(function (v) { return { plate: v.plate, type: v.type, trips: v.trips, km: Math.round(v.km), fills: v.fills, liters: v.liters, baht: Math.round(v.baht), checks: v.checks, issues: v.issues, kmpl: v.kmpl }; }),
      idle: S.idle, drivers: S.drivers.map(function (d) { return { name: d.name, trips: d.trips, km: Math.round(d.km) }; }), dests: S.dests, items: S.items, SAT: S.SAT, insights: insights || [],
      GIS: G && { dests: G.dests.map(function (d) { return { rank: d.rank, name: d.name, count: d.count, km: d.km, straight: d.straight, band: d.band, approx: !!d.approx }; }),
        bands: G.bands, sectors: G.sectors, trip: G.trip, tripBins: G.tripBins, plates: G.plates, coverage: G.coverage, within10: G.within10, within20: G.within20,
        wAvg: G.wAvg, wMedian: G.wMedian, mappedVisits: G.mappedVisits, totalVisits: G.totalVisits, insights: G.insights || [], mapUrl: G.map && G.map.url || '' },
      made: new Date().toLocaleString('th-TH')
    };
    var json = JSON.stringify(D).replace(/</g, '\\u003c');
    var tabs = [['ov', 'ภาพรวม'], ['veh', 'รถ'], ['drv', 'พขร. & ปลายทาง'], ['chk', 'ตรวจสภาพ'], ['gis', 'เส้นทาง (GIS)'], ['sat', 'ความพึงพอใจ']];
    return '<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>รายงานประจำเดือน ' + S.label + ' — SAND</title><style>' + CSS + '</style></head><body>'
      + '<header><div class="tools"><button id="theme">🌓 โหมดมืด</button><button id="print">🖨 พิมพ์</button><button id="save">💾 บันทึกไฟล์</button></div><h1>รายงานสรุปการใช้งานระบบ SAND — ' + S.label + '</h1><p>กลุ่มงานยานพาหนะ โรงพยาบาลสันทราย · สร้างเมื่อ ' + D.made + '</p></header>'
      + '<nav>' + tabs.map(function (t) { return '<button class="tab" data-t="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</nav><main>'
      + '<section class="pane" id="tab-ov"><div class="grid" id="ov-kpi"></div><div class="card" style="margin-top:14px"><h2>สรุปประเด็นสำคัญ</h2><ul class="ins" id="ov-ins"></ul></div><div class="card"><h2>จำนวนเที่ยวรายวัน</h2><div id="ov-day"></div></div></section>'
      + '<section class="pane" id="tab-veh" hidden><div class="card"><div class="bar"><input id="v-q" placeholder="ค้นหาทะเบียน/ประเภท…"><select id="v-type"></select></div><div class="wrap"><table id="v-tbl"></table></div><p class="sub">คลิกที่แถวเพื่อดูรายละเอียดรถ · คลิกหัวตารางเพื่อเรียง</p><p id="v-idle" class="sub"></p></div></section>'
      + '<section class="pane" id="tab-drv" hidden><div class="two"><div class="card"><h2>พนักงานขับรถ (จำนวนเที่ยว)</h2><div id="d-bars"></div></div><div class="card"><h2>ปลายทางที่ไปบ่อย</h2><div class="bar"><input id="t-q" placeholder="ค้นหาปลายทาง…"></div><div id="t-bars"></div><button id="t-more" class="tab" style="display:none"></button></div></div></section>'
      + '<section class="pane" id="tab-chk" hidden><div class="grid" id="c-kpi"></div><div class="two" style="margin-top:14px"><div class="card"><h2>รายการที่พบผิดปกติบ่อย</h2><div id="c-bars"></div></div><div class="card"><h2>รถที่พบความผิดปกติ</h2><div id="c-risk"></div></div></div></section>'
      + '<section class="pane" id="tab-gis" hidden><div class="grid" id="g-kpi"></div><div class="two" style="margin-top:14px"><div class="card"><h2>แผนที่เส้นทางการเดินรถ</h2><div id="g-map"></div></div><div class="card"><h2>ระยะทางจาก รพ.</h2><div id="g-band"></div><h2 style="margin-top:14px">ทิศที่ไป</h2><div id="g-sec"></div></div></div><div class="card"><h2>วงรอบการใช้รถต่อเที่ยว</h2><div id="g-trip"></div></div><div class="card"><h2>ข้อสังเกต</h2><ul class="ins" id="g-ins"></ul></div><div class="card"><h2>ปลายทางทั้งหมด</h2><div class="bar"><input id="g-q" placeholder="ค้นหาปลายทาง…"></div><div class="wrap"><table id="g-tbl"></table></div></div></section>'
      + '<section class="pane" id="tab-sat" hidden><div class="card"><h2>ความพึงพอใจผู้ใช้บริการ</h2><div id="s-body"></div></div></section>'
      + '</main><footer>SAND — ระบบบริหารยานพาหนะ รพ.สันทราย · ไฟล์นี้เปิดดูได้โดยไม่ต้องต่ออินเทอร์เน็ต</footer><div id="lb"><img alt=""></div><div id="tip"></div>'
      + '<script>(' + clientApp.toString() + ')(' + json + ');<\/script></body></html>';
  }

  window.SandMonthlyHtml = { build: build };
})();
