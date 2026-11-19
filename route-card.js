/* ============================================================
   route-card.js — แผนที่เส้นทาง รพ. → ปลายทาง ในหน้าต่างรายละเอียดรถ (index.html)
   - แนวคิดจากคอมโพเนนต์ "expanded-map" (การ์ดแผนที่ที่กดขยายได้ + หมุดเด้ง) เขียนใหม่เป็น JS ล้วน
     เพราะระบบนี้ไม่ใช้ React/Next/Tailwind
   - พิกัดปลายทาง: ชีท Locations ผ่าน GAS ?action=getLocationPins (ชุดเดียวกับ routemap.html)
   - เส้นทางตามถนนจริง: OSRM (ไม่ใช้ API key) · ภาพแผนที่: ไทล์ OpenStreetMap/CARTO
     (ไม่ใช้ภาพจาก Google Maps โดยตรง เพราะต้องมี API key/ข้อกำหนดการใช้งาน — มีปุ่มเปิดเส้นทางเดียวกันใน Google Maps แทน)
   - ใช้ textContent/createElement เท่านั้น (ข้อมูลจากชีทไม่ถูกแทรกเป็น HTML)
   API:  SandRouteCard.update(info)  — เรียกทุกครั้งที่หน้าต่างรถถูกเติมข้อมูล
         SandRouteCard.reset()       — เรียกเมื่อปิดหน้าต่าง
   ============================================================ */
(function () {
  'use strict';

  var HOSP = { lat: 18.9209926, lng: 98.9942253, name: 'รพ.สันทราย' };   // ตรงกับ HOSPITAL_LOCATION ใน routemap.html
  var DEST_GROUPS_KEY = 'sansaiRoutemapDestGroupsV1';                      // กลุ่มปลายทางที่ผู้ใช้จัดไว้ใน routemap.html (ถ้ามี)
  var PIN_TTL = 5 * 60 * 1000, OSRM_TIMEOUT = 7000, MAX_STOPS = 6;
  var NS = 'http://www.w3.org/2000/svg';

  var cur = { key: '', token: 0, open: true, info: null, timer: 0, route: null, stops: null };
  var pinCache = { t: 0, map: null, p: null };
  var routeCache = {};

  // ───────────── helpers ─────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function svgEl(tag, attrs) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function key(s) { return norm(s).toLowerCase().replace(/\s/g, ''); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function reduceMotion() { return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }

  // ชื่อปลายทางมาตรฐาน — กติกาเดียวกับ canonicalDestName ใน routemap.html เพื่อให้จับคู่กับหมุดที่ปักไว้ได้ตรงกัน
  function destGroups() { try { return JSON.parse(localStorage.getItem(DEST_GROUPS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function canonical(name) {
    var s = norm(name); if (!s) return s;
    var g = destGroups(); if (g[s]) return g[s];
    s = s.replace(/^โรงพยาบาล\s*/, 'รพ.');
    if (/^องค์การบริหารส่วนจังหวัด/.test(s)) s = 'อบจ.';
    if (/^อบจ\.?\s*(ชม\.?)?$/.test(s)) s = 'อบจ.';
    if (/^รับ\s*เลือ[ดก]\s*กาชาด$/.test(s)) s = 'กาชาด';
    if (/^(ส่งแฟ้ม\s*)?ศาลากลาง(จังหวัดเชียงใหม่)?$/.test(s)) s = 'ศาลากลาง';
    if (/^(ส่งแฟ้ม\s*)?สสจ\.?\s*(เชียงใหม่)?$/.test(s)) s = 'สสจ.เชียงใหม่';
    s = s.replace(/\s*\(([^)]*)\)\s*$/, function (m, inner) { return norm(inner) === 'เส้นทางในเมือง' ? '' : m; }).trim();
    return s;
  }
  function splitDest(raw) { return String(raw || '').split(/[,/]/).map(norm).filter(Boolean); }

  // เวลาไทยปัจจุบัน (นาทีของวัน) — ไม่พึ่ง timezone ของเครื่อง
  function nowMinutesBkk() {
    try {
      var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      var h = 0, m = 0; p.forEach(function (x) { if (x.type === 'hour') h = +x.value % 24; if (x.type === 'minute') m = +x.value; });
      return h * 60 + m;
    } catch (e) { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  }
  function parseHM(s) { var m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function fmtHM(min) { min = ((Math.round(min) % 1440) + 1440) % 1440; return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2); }
  function fmtDur(min) {
    min = Math.round(min); if (min < 1) return '< 1 นาที';
    if (min < 60) return min + ' นาที';
    var h = Math.floor(min / 60), m = min % 60; return h + ' ชม.' + (m ? ' ' + m + ' นาที' : '');
  }
  function haversineKm(a, b) {
    var R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ───────────── data ─────────────
  function loadPins() {
    var now = Date.now();
    if (pinCache.map && now - pinCache.t < PIN_TTL) return Promise.resolve(pinCache.map);
    if (pinCache.p) return pinCache.p;
    pinCache.p = fetch(GAS_URL + '?action=getLocationPins', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var map = {};
        ((j && j.data) || []).forEach(function (p) { if (p && p.name && isFinite(p.lat) && isFinite(p.lng)) map[key(p.name)] = { name: norm(p.name), lat: +p.lat, lng: +p.lng }; });
        pinCache.map = map; pinCache.t = Date.now(); pinCache.p = null; return map;
      })
      .catch(function (e) { pinCache.p = null; throw e; });
    return pinCache.p;
  }

  function resolveStops(rawDest, pins) {
    var stops = [], missing = [], seen = {};
    splitDest(rawDest).forEach(function (raw) {
      var name = canonical(raw), pin = pins[key(name)] || pins[key(raw)];
      if (pin) { if (!seen[key(pin.name)]) { seen[key(pin.name)] = 1; stops.push(pin); } }
      else missing.push(name || raw);
    });
    return { stops: stops.slice(0, MAX_STOPS), missing: missing, truncated: stops.length > MAX_STOPS };
  }

  // เส้นทางถนนจริงจาก OSRM (จุดแวะหลายจุดในคำขอเดียว) — ล้มเหลว/ช้า → เส้นตรง + ระบุว่าเป็นค่าประมาณ
  function fetchRoute(points) {
    var ck = points.map(function (p) { return p.lat.toFixed(5) + ',' + p.lng.toFixed(5); }).join('|');
    if (routeCache[ck]) return Promise.resolve(routeCache[ck]);
    var url = 'https://router.project-osrm.org/route/v1/driving/' + points.map(function (p) { return p.lng + ',' + p.lat; }).join(';') + '?overview=full&geometries=geojson';
    var ctl = window.AbortController ? new AbortController() : null, to = setTimeout(function () { if (ctl) ctl.abort(); }, OSRM_TIMEOUT);
    return fetch(url, ctl ? { signal: ctl.signal } : undefined)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        clearTimeout(to);
        var rt = j && j.routes && j.routes[0];
        if (!rt || !rt.geometry || !rt.geometry.coordinates || !rt.geometry.coordinates.length) throw new Error('no route');
        var res = { coords: rt.geometry.coordinates.map(function (c) { return { lat: c[1], lng: c[0] }; }), km: rt.distance / 1000, min: rt.duration / 60, approx: false };
        routeCache[ck] = res; return res;
      })
      .catch(function () {
        clearTimeout(to);
        var km = 0; for (var i = 0; i < points.length - 1; i++) km += haversineKm(points[i], points[i + 1]);
        return { coords: points.slice(), km: km, min: null, approx: true };       // ไม่เก็บ cache — ลองใหม่รอบหน้า
      });
  }

  // ───────────── map math (Web Mercator, เหมือนที่คอมโพเนนต์ expanded-map ใช้คำนวณไทล์) ─────────────
  function project(lat, lng, z) {
    var n = 256 * Math.pow(2, z), s = Math.sin(lat * Math.PI / 180);
    return { x: (lng + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function tileUrl(x, y, z) {
    var n = Math.pow(2, z), tx = ((x % n) + n) % n, sub = 'abcd'.charAt((tx + y) % 4);
    var r2 = (window.devicePixelRatio || 1) >= 1.5 ? '@2x' : '';
    return 'https://' + sub + '.basemaps.cartocdn.com/light_all/' + z + '/' + tx + '/' + y + r2 + '.png';
  }

  // ───────────── UI ─────────────
  function googleMapsUrl(stops, destText) {
    var u = 'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + HOSP.lat + ',' + HOSP.lng;
    if (stops && stops.length) {
      var last = stops[stops.length - 1];
      u += '&destination=' + last.lat + ',' + last.lng;
      if (stops.length > 1) u += '&waypoints=' + stops.slice(0, -1).map(function (s) { return s.lat + ',' + s.lng; }).join('%7C');
    } else {
      u += '&destination=' + encodeURIComponent(splitDest(destText)[0] + ' เชียงใหม่');
    }
    return u;
  }

  function mapIcon() {
    var s = svgEl('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', 'class': 'vpr-ico' });
    s.appendChild(svgEl('polygon', { points: '3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21' }));
    s.appendChild(svgEl('line', { x1: 9, x2: 9, y1: 3, y2: 18 })); s.appendChild(svgEl('line', { x1: 15, x2: 15, y1: 6, y2: 21 }));
    return s;
  }
  function chevron() {
    var s = svgEl('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', 'class': 'vpr-chev' });
    s.appendChild(svgEl('polyline', { points: '6 9 12 15 18 9' })); return s;
  }
  function pinSvg() {
    var s = svgEl('svg', { width: 32, height: 32, viewBox: '0 0 24 24', 'class': 'vpr-pinsvg', 'aria-hidden': 'true' });
    s.appendChild(svgEl('path', { d: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z', fill: '#34D399', stroke: '#fff', 'stroke-width': 1 }));
    s.appendChild(svgEl('circle', { cx: 12, cy: 9, r: 2.5, fill: '#fff' })); return s;
  }

  function shell(info, titleText) {
    var root = $('vpRoute'); root.textContent = '';
    root.hidden = false; root.classList.toggle('is-open', cur.open);

    var head = el('button', 'vpr-head'); head.type = 'button'; head.setAttribute('aria-expanded', cur.open ? 'true' : 'false');
    head.appendChild(mapIcon());
    head.appendChild(el('span', 'vpr-title', titleText));
    head.appendChild(chevron());
    head.addEventListener('click', function () {
      cur.open = !cur.open; root.classList.toggle('is-open', cur.open); head.setAttribute('aria-expanded', cur.open ? 'true' : 'false');
    });
    var wrap = el('div', 'vpr-collapse'), inner = el('div', 'vpr-inner'), body = el('div', 'vpr-body');
    inner.appendChild(body); wrap.appendChild(inner);
    root.appendChild(head); root.appendChild(wrap);
    return body;
  }

  function addActions(body, stops, destText) {
    var row = el('div', 'vpr-actions');
    var g = el('a', 'vpr-btn', 'เปิดใน Google Maps ↗'); g.href = googleMapsUrl(stops, destText); g.target = '_blank'; g.rel = 'noopener noreferrer';
    var m = el('a', 'vpr-btn ghost', 'แผนที่เส้นทางเต็ม'); m.href = 'routemap.html';
    row.appendChild(g); row.appendChild(m); body.appendChild(row);
  }

  function tile(label, value, cls) {
    var t = el('div', 'vp-tile' + (cls ? ' ' + cls : '')); t.appendChild(el('b', null, label)); var s = el('span', null, value); t.appendChild(s); t._val = s; return t;
  }

  function buildStats(info, route, stops) {
    var grid = el('div', 'vpr-stats');
    var single = stops.length === 1;
    var distTxt = route.km.toFixed(1) + ' กม.' + (route.approx ? ' (เส้นตรง)' : '');
    var tDist = tile('ระยะทาง (ไป)', distTxt);
    var tDur = tile('เวลาเดินทาง (ประมาณ)', route.min != null ? fmtDur(route.min) : '—');
    var tOut = tile('ออกจาก รพ.', info.outT || '—');
    var tEl = tile('ผ่านมาแล้ว', '—');
    var tEta = tile('คาดว่าถึง', '—');
    var tDrv = tile('ผู้ขับ (พขร.)', info.driver || '—');
    var items = [tDist, tDur, tOut, tEl, tEta, tDrv];
    if (single && !route.approx) items.splice(1, 0, tile('ไป-กลับ (ประมาณ)', (route.km * 2).toFixed(1) + ' กม.'));
    items.forEach(function (t) { grid.appendChild(t); });
    grid._refs = { el: tEl._val, eta: tEta._val };
    return grid;
  }

  function refreshElapsed() {
    var info = cur.info, route = cur.route, refs = cur.refs;
    if (!info || !route || !refs) return;
    var out = parseHM(info.outT);
    if (out == null) { refs.el.textContent = '—'; refs.eta.textContent = '—'; return; }
    var el_ = nowMinutesBkk() - out; if (el_ < 0) el_ += 1440;
    refs.el.textContent = fmtDur(el_);
    if (route.min != null) {
      var eta = out + route.min;
      refs.eta.textContent = el_ > route.min + 10 ? 'ควรถึงแล้ว (' + fmtHM(eta) + ')' : '~ ' + fmtHM(eta) + ' น.';
    } else refs.eta.textContent = '—';
  }

  function renderMap(box, route, stops) {
    box.textContent = '';
    var W = box.clientWidth || 304, H = box.clientHeight || 176;
    var padX = 34, padTop = 42, padBot = 26;
    var pts = route.coords, minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    pts.forEach(function (p) { if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat; if (p.lng < minLng) minLng = p.lng; if (p.lng > maxLng) maxLng = p.lng; });
    // ซูมแบบต่อเนื่อง: คำนวณให้เส้นทางพอดีกรอบ แล้วใช้ไทล์ระดับจำนวนเต็มที่ใกล้ที่สุดยืด/หดเล็กน้อย (ซูมจำนวนเต็มล้วนเหลือที่ว่างมาก)
    var a0 = project(maxLat, minLng, 0), b0 = project(minLat, maxLng, 0);
    var dx0 = Math.max(b0.x - a0.x, 1e-9), dy0 = Math.max(b0.y - a0.y, 1e-9);
    var zf = Math.log(Math.min((W - padX * 2) / dx0, (H - padTop - padBot) / dy0)) / Math.LN2;
    zf = clamp(zf, 3, 16.5);
    var z = clamp(Math.round(zf), 3, 17), sc = Math.pow(2, zf - z), ts = 256 * sc;      // z = ระดับไทล์, ts = ขนาดไทล์บนจอ (px)
    var tl = project(maxLat, minLng, zf), br = project(minLat, maxLng, zf);
    // วางกรอบเส้นทางให้อยู่กลางพื้นที่ที่เหลือหลังกันขอบบน (ป้ายชื่อ+หมุด) / ล่าง
    var cx = (tl.x + br.x) / 2, cy = (tl.y + br.y) / 2 - (padTop - padBot) / 2;
    var left = cx - W / 2, top = cy - H / 2;
    function xy(p) { var q = project(p.lat, p.lng, zf); return { x: q.x - left, y: q.y - top }; }

    // ไทล์
    var layer = el('div', 'vpr-tiles'); box.appendChild(layer);
    var maxT = Math.pow(2, z) - 1, total = 0, done = 0, finished = false;
    function ready() { if (finished) return; finished = true; box.classList.add('is-ready'); }
    var imgs = [];
    for (var ty = Math.floor(top / ts); ty <= Math.floor((top + H) / ts); ty++) {
      if (ty < 0 || ty > maxT) continue;
      for (var tx = Math.floor(left / ts); tx <= Math.floor((left + W) / ts); tx++) {
        var im = new Image(); im.alt = ''; im.draggable = false; im.decoding = 'async';
        im.style.width = (ts + 0.6) + 'px'; im.style.height = (ts + 0.6) + 'px';          // +0.6px กันรอยต่อระหว่างไทล์
        im.style.left = (tx * ts - left).toFixed(2) + 'px'; im.style.top = (ty * ts - top).toFixed(2) + 'px';
        im.style.transitionDelay = (imgs.length * 0.04) + 's';
        im.onload = function () { done++; if (done >= total) ready(); };
        im.onerror = function () { this.style.display = 'none'; done++; if (done >= total) ready(); };   // ไทล์โหลดไม่ได้ → ซ่อน ไม่โชว์ไอคอนรูปแตก
        im.src = tileUrl(tx, ty, z); layer.appendChild(im); imgs.push(im); total++;
      }
    }
    setTimeout(ready, 4000);

    // เส้นทาง (ลดจุดถ้าเยอะเกิน) — เส้นขาวรองพื้น + เส้นประสีน้ำเงินวิ่งตามทิศ รพ. → ปลายทาง
    var step = Math.max(1, Math.ceil(pts.length / 500)), d = '';
    for (var i = 0; i < pts.length; i += step) { var q = xy(pts[i]); d += (i ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); }
    var last = xy(pts[pts.length - 1]); d += 'L' + last.x.toFixed(1) + ' ' + last.y.toFixed(1);
    var svg = svgEl('svg', { 'class': 'vpr-svg', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { d: d, 'class': 'vpr-casing' }));
    svg.appendChild(svgEl('path', { d: d, 'class': 'vpr-line' + (route.approx ? ' approx' : '') + (reduceMotion() ? ' still' : '') }));
    box.appendChild(svg);

    // หมุด + ป้ายชื่อ
    // ป้ายชื่อวางข้างหมุด (ขวา; ถ้าชนขอบก็พลิกไปซ้าย) — ไม่ซ้อนกันเมื่อหมุดอยู่ใกล้กันในแนวตั้ง
    function label(text, x, y) {
      var l = el('div', 'vpr-lb', text); l.style.top = clamp(y - 10, 3, H - 24) + 'px'; l.style.visibility = 'hidden'; box.appendChild(l);
      var w = l.offsetWidth, fitsRight = x + 18 + w <= W - 4;
      if (fitsRight) l.style.left = (x + 18) + 'px'; else l.style.left = Math.max(4, x - 18 - w) + 'px';
      l.style.visibility = '';
    }
    var h = xy(HOSP), hm = el('div', 'vpr-mk vpr-h'); hm.style.left = h.x + 'px'; hm.style.top = h.y + 'px';
    hm.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/></svg>';   // ไอคอนคงที่ ไม่มีข้อมูลผู้ใช้
    box.appendChild(hm); label(HOSP.name, h.x, h.y);
    stops.forEach(function (s, i) {
      var p = xy(s), isLast = i === stops.length - 1, m;
      if (isLast) { m = el('div', 'vpr-mk vpr-pin'); m.appendChild(pinSvg()); }
      else { m = el('div', 'vpr-mk vpr-num', String(i + 1)); }
      m.style.left = p.x + 'px'; m.style.top = p.y + 'px'; m.style.animationDelay = (0.3 + i * 0.12) + 's'; box.appendChild(m);
      if (isLast || stops.length === 1) label((stops.length > 1 ? (i + 1) + '. ' : '') + s.name, p.x, isLast ? p.y - 16 : p.y);
    });
    var at = el('div', 'vpr-attr'); var a1 = el('a', null, '© OpenStreetMap'); a1.href = 'https://www.openstreetmap.org/copyright'; a1.target = '_blank'; a1.rel = 'noopener noreferrer';
    at.appendChild(a1); at.appendChild(document.createTextNode(' · © CARTO')); box.appendChild(at);
  }

  var rzTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(function () { if (cur.box && cur.route && cur.stops && cur.open) renderMap(cur.box, cur.route, cur.stops); }, 200);
  });

  // ───────────── public ─────────────
  function hide() { var r = $('vpRoute'); if (r) { r.hidden = true; r.textContent = ''; } clearInterval(cur.timer); cur.timer = 0; cur.route = null; cur.refs = null; cur.box = null; cur.stops = null; }

  function reset() { cur.token++; cur.key = ''; cur.info = null; cur.open = true; hide(); }

  function update(info) {
    var root = $('vpRoute'); if (!root) return;
    if (!info || info.state !== 'inuse' || !norm(info.dest)) { cur.token++; cur.key = ''; cur.info = null; hide(); return; }
    cur.info = info;
    var k = info.plate + '|' + info.dest;
    if (k === cur.key) { refreshElapsed(); return; }                // ข้อมูลเดิม (หน้ารีเฟรช) — แค่อัปเดตเวลา ไม่วาดใหม่/ไม่กระพริบ
    cur.key = k; var my = ++cur.token;
    clearInterval(cur.timer); cur.route = null; cur.refs = null; cur.box = null; cur.stops = null;

    var shortDest = splitDest(info.dest).join(' → ');
    var body = shell(info, 'เส้นทางจาก รพ. → ' + shortDest);
    var box = el('div', 'vpr-map'); box.appendChild(el('div', 'vpr-msg', 'กำลังโหลดเส้นทาง…')); body.appendChild(box);

    function fail(msg, stops) {
      if (my !== cur.token) return;
      box.className = 'vpr-note'; box.textContent = msg;
      addActions(body, stops || [], info.dest);
    }

    loadPins().then(function (pins) {
      if (my !== cur.token) return;
      var r = resolveStops(info.dest, pins);
      if (!r.stops.length) { fail('ยังไม่มีพิกัดปักหมุดของ “' + shortDest + '” ในระบบ จึงยังวาดเส้นทางไม่ได้ — ปักหมุดได้ที่หน้า “แผนที่เส้นทาง” หรือดูเส้นทางใน Google Maps ด้านล่าง'); return; }
      return fetchRoute([HOSP].concat(r.stops)).then(function (route) {
        if (my !== cur.token) return;
        cur.route = route; cur.stops = r.stops; cur.box = box;
        box.className = 'vpr-map'; renderMap(box, route, r.stops);
        var stats = buildStats(info, route, r.stops); cur.refs = stats._refs; body.appendChild(stats);
        if (r.stops.length > 1) {
          var lg = el('div', 'vpr-legend', r.stops.map(function (s, i) { return (i + 1) + '. ' + s.name; }).join('  →  ')); body.appendChild(lg);
        }
        var notes = [];
        if (r.missing.length) notes.push('ยังไม่ปักหมุด: ' + r.missing.join(', '));
        if (r.truncated) notes.push('แสดงสูงสุด ' + MAX_STOPS + ' จุดแรก');
        if (route.approx) notes.push('โหลดเส้นทางถนนไม่สำเร็จ แสดงเป็นเส้นตรงโดยประมาณ');
        notes.push('เวลาเดินทางเป็นค่าประมาณจากเส้นทางถนน ไม่ใช่ตำแหน่ง/เวลาจริงของรถ (ระบบไม่มี GPS)');
        body.appendChild(el('div', 'vpr-foot', notes.join(' · ')));
        addActions(body, r.stops, info.dest);
        refreshElapsed(); cur.timer = setInterval(refreshElapsed, 30000);
      });
    }).catch(function () { fail('โหลดพิกัดปลายทางไม่สำเร็จ — ลองเปิดใหม่อีกครั้ง หรือดูเส้นทางใน Google Maps ด้านล่าง'); });
  }

  window.SandRouteCard = { update: update, reset: reset };
})();
