/* ============================================================
   monthly-gis.js — วิเคราะห์เชิงพื้นที่ (GIS) ของการเดินรถ สำหรับรายงานประจำเดือน (monthly-report.js)
   - อินพุต: แถวไมล์ของเดือน (ปลายทาง, ระยะทาง(กม.), เวลาออก/กลับ) + หมุดพิกัดจากชีต Locations (GAS ?action=getLocationPins)
   - ระยะทางถนนจริง รพ.สันทราย → ปลายทาง: OSRM /table (1 คำขอ/90 จุด) · เส้นทางบนแผนที่: OSRM /route (เฉพาะปลายทางอันดับต้นๆ)
     ถ้า OSRM ใช้ไม่ได้ → ประมาณจากระยะเส้นตรง × 1.35 (ระบุ "ประมาณ" ในรายงาน)
   - แผนที่: ไทล์ OpenStreetMap วาดลง <canvas> เอง (ไม่พึ่ง Leaflet/html2canvas จับภาพไทล์) แล้วส่งออกเป็นภาพ dataURL
     ถ้าไทล์โหลดไม่ได้/ติด CORS → วาดโครงรัศมี+เส้นทางบนพื้นเรียบแทน (รายงานยังออกได้)
   - ผลลัพธ์ระยะถนนเก็บใน localStorage (ต่อเบราว์เซอร์, อายุ 30 วัน) เพื่อลดการเรียก OSRM ซ้ำ
   - ตัวเลขทั้งหมดเป็นค่าประมาณเชิงสถิติ/พื้นที่ ไม่ใช่ไมล์จริง — ระยะวิ่งจริงต่อเที่ยวใช้เลขไมล์ที่บันทึกในชีตเท่านั้น
   API: SandMonthlyGIS.compute({ rows, plateOf, n, pins, ym }) → Promise<result|null>
   ============================================================ */
(function () {
  'use strict';

  var HOSP = { lat: 18.9209926, lng: 98.9942253, name: 'รพ.สันทราย' };   // ตรงกับ HOSPITAL_LOCATION ใน routemap.html / route-card.js
  var OSRM = 'https://router.project-osrm.org';
  var TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png', 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'];   // OSM ก่อน, ล้มเหลวค่อยลอง CARTO (แผนที่ถนนจริงเช่นกัน)
  var DEST_GROUPS_KEY = 'sansaiRoutemapDestGroupsV1';
  var CACHE_KEY = 'sandGisDistV1', CACHE_TTL = 30 * 24 * 3600 * 1000;
  var DETOUR = 1.35, FALLBACK_KMH = 40, TOP_ROUTES = 12, TOP_MARKERS = 12;
  var BAND_EDGES = [5, 10, 20, 30];
  var BAND_LABELS = ['ไม่เกิน 5 กม.', '5–10 กม.', '10–20 กม.', '20–30 กม.', 'มากกว่า 30 กม.'];
  var BAND_COL = ['#1b9e77', '#7fb23d', '#e6a817', '#e8702a', '#c0392b'];
  var TRIP_EDGES = [10, 20, 40, 80];
  var TRIP_LABELS = ['ไม่เกิน 10 กม.', '10–20 กม.', '20–40 กม.', '40–80 กม.', 'มากกว่า 80 กม.'];
  var SECTORS = ['เหนือ', 'ตะวันออกเฉียงเหนือ', 'ตะวันออก', 'ตะวันออกเฉียงใต้', 'ใต้', 'ตะวันตกเฉียงใต้', 'ตะวันตก', 'ตะวันตกเฉียงเหนือ'];
  var MAP_W = 726, MAP_H = 640, DPR = 2;

  // ───────────── helpers ─────────────
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function key(s) { return norm(s).toLowerCase().replace(/\s/g, ''); }
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  // ชื่อปลายทางมาตรฐาน — กติกาเดียวกับ canonicalDestName ใน routemap.html / canonical ใน route-card.js (จับคู่กับหมุดได้ตรงกัน)
  function destGroups() { try { return JSON.parse(localStorage.getItem(DEST_GROUPS_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function canonical(name, groups) {
    var s = norm(name); if (!s) return s;
    if (groups && groups[s]) return groups[s];
    s = s.replace(/^โรงพยาบาล\s*/, 'รพ.');
    if (/^องค์การบริหารส่วนจังหวัด/.test(s)) s = 'อบจ.';
    if (/^อบจ\.?\s*(ชม\.?)?$/.test(s)) s = 'อบจ.';
    if (/^รับ\s*เลือ[ดก]\s*กาชาด$/.test(s)) s = 'กาชาด';
    if (/^(ส่งแฟ้ม\s*)?ศาลากลาง(จังหวัดเชียงใหม่)?$/.test(s)) s = 'ศาลากลาง';
    if (/^(ส่งแฟ้ม\s*)?สสจ\.?\s*(เชียงใหม่)?$/.test(s)) s = 'สสจ.เชียงใหม่';
    s = s.replace(/\s*\(([^)]*)\)\s*$/, function (m, inner) { return norm(inner) === 'เส้นทางในเมือง' ? '' : m; }).trim();
    return s;
  }
  function splitDest(raw, groups) {
    var seen = {}, out = [];
    String(raw || '').split(/[,/]/).forEach(function (x) {
      var c = canonical(x, groups); if (c && !seen[c]) { seen[c] = 1; out.push(c); }
    });
    return out;
  }
  function isHospitalSelf(name) { return /^รพ\.?\s*สันทราย$/.test(name) || /^โรงพยาบาลสันทราย$/.test(name); }

  function haversine(a, b) {
    var dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  function bearing(a, b) {
    var y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    var x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function destPoint(p, brg, km) {
    var d = km / 6371.0088, b = rad(brg), la1 = rad(p.lat), lo1 = rad(p.lng);
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    var lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return { lat: deg(la2), lng: deg(lo2) };
  }
  function sortedNums(a) { return a.slice().sort(function (x, y) { return x - y; }); }
  function pctile(sorted, p) {
    if (!sorted.length) return 0;
    var i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  }
  function edgeIndex(v, edges) { for (var i = 0; i < edges.length; i++) if (v <= edges[i]) return i; return edges.length; }
  function r1(x) { return Math.round(x * 10) / 10; }
  function fmt(x, d) { return (Number(x) || 0).toLocaleString('th-TH', { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: d == null ? 0 : d }); }
  function parseHM(s) { var m = String(s || '').match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }

  function fetchJson(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 8000);
    return fetch(url, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      clearTimeout(t); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json();
    }, function (e) { clearTimeout(t); throw e; });
  }

  // ───────────── ระยะทางถนน (OSRM table) ─────────────
  function pk(p) { return p.lat.toFixed(4) + ',' + p.lng.toFixed(4); }
  function loadCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { return {}; } }
  function saveCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* โควตาเต็ม/โหมดส่วนตัว — ข้าม */ } }

  function resolveDistances(dests) {
    var cache = loadCache(), now = Date.now(), need = [];
    dests.forEach(function (d) {
      var c = cache[pk(d)];
      if (c && now - c.t < CACHE_TTL && c.km >= 0) { d.km = c.km; d.min = c.min; d.approx = false; }
      else need.push(d);
    });
    var chunks = []; for (var i = 0; i < need.length; i += 90) chunks.push(need.slice(i, i + 90));
    var chain = Promise.resolve();
    chunks.forEach(function (ch) {
      chain = chain.then(function () {
        var coords = [HOSP].concat(ch).map(function (c) { return c.lng.toFixed(6) + ',' + c.lat.toFixed(6); }).join(';');
        return fetchJson(OSRM + '/table/v1/driving/' + coords + '?sources=0&annotations=distance,duration', 12000).then(function (j) {
          if (j.code !== 'Ok' || !j.distances || !j.distances[0]) throw new Error('OSRM table: ' + j.code);
          ch.forEach(function (d, k) {
            var m = j.distances[0][k + 1], s = j.durations && j.durations[0] ? j.durations[0][k + 1] : null;
            if (typeof m === 'number' && m >= 0) {
              d.km = m / 1000; d.min = typeof s === 'number' ? s / 60 : d.km / FALLBACK_KMH * 60; d.approx = false;
              cache[pk(d)] = { km: d.km, min: d.min, t: now };
            }
          });
        }).catch(function (e) { if (window.console) console.warn('monthly-gis: OSRM table ล้มเหลว → ใช้เส้นตรง×' + DETOUR, e); });
      });
    });
    return chain.then(function () {
      dests.forEach(function (d) {
        if (d.approx === undefined) { d.km = d.straight * DETOUR; d.min = d.km / FALLBACK_KMH * 60; d.approx = true; }
      });
      saveCache(cache);
    });
  }

  // เส้นทางตามถนนสำหรับวาดแผนที่ (เฉพาะอันดับต้นๆ — ที่เหลือวาดเป็นเส้นตรง)
  function resolveGeometry(top) {
    var idx = 0, workers = [];
    function next() {
      if (idx >= top.length) return Promise.resolve();
      var d = top[idx++];
      var url = OSRM + '/route/v1/driving/' + HOSP.lng.toFixed(6) + ',' + HOSP.lat.toFixed(6) + ';' + d.lng.toFixed(6) + ',' + d.lat.toFixed(6) + '?overview=simplified&geometries=geojson';
      return fetchJson(url, 8000).then(function (j) {
        if (j.code === 'Ok' && j.routes && j.routes[0] && j.routes[0].geometry) d.geom = j.routes[0].geometry.coordinates;
      }).catch(function () { /* ใช้เส้นตรง */ }).then(next);
    }
    for (var w = 0; w < 4; w++) workers.push(next());
    return Promise.all(workers);
  }

  // ───────────── วิเคราะห์ ─────────────
  function analyze(o) {
    var groups = destGroups(), pinMap = {};
    (o.pins || []).forEach(function (p) {
      if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return;
      var P = { lat: +p.lat, lng: +p.lng };
      pinMap[key(p.name)] = P; pinMap[key(canonical(p.name, groups))] = P;
    });
    var counts = {}, trips = [], plates = {}, durs = [], localVisits = 0;
    o.rows.forEach(function (r) {
      var km = Math.max(0, o.n(r['ระยะทาง(กม.)'])), plate = o.plateOf(r['ทะเบียน/รถ'] || r.carType);
      var stops = splitDest(r['ปลายทาง'], groups).filter(function (s) { if (isHospitalSelf(s)) { localVisits++; return false; } return true; });
      stops.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; });
      trips.push({ km: km, stops: stops.length });
      if (km > 0) {
        var P = plates[plate] || (plates[plate] = { plate: plate, trips: 0, km: 0, list: [] });
        P.trips++; P.km += km; P.list.push(km);
      }
      var a = parseHM(r['เวลาออก']), b = parseHM(r['เวลากลับ']);
      if (a !== null && b !== null && b - a >= 5 && b - a <= 960) durs.push(b - a);
    });

    var dests = [], unmapped = [], totalVisits = 0, mappedVisits = 0;
    Object.keys(counts).forEach(function (name) {
      totalVisits += counts[name];
      var pin = pinMap[key(name)];
      if (!pin) { unmapped.push({ name: name, count: counts[name] }); return; }
      var P = { lat: pin.lat, lng: pin.lng }, st = haversine(HOSP, P);
      dests.push({ name: name, count: counts[name], lat: pin.lat, lng: pin.lng, straight: st, bearing: bearing(HOSP, P) });
      mappedVisits += counts[name];
    });
    dests.sort(function (a, b) { return b.count - a.count || a.straight - b.straight; });
    unmapped.sort(function (a, b) { return b.count - a.count; });

    var tripKms = sortedNums(trips.filter(function (t) { return t.km > 0; }).map(function (t) { return t.km; }));
    var withStops = trips.filter(function (t) { return t.stops > 0; });
    return { dests: dests, unmapped: unmapped, totalVisits: totalVisits, mappedVisits: mappedVisits, localVisits: localVisits,
      tripKms: tripKms, tripCount: trips.length, multiStop: withStops.filter(function (t) { return t.stops >= 2; }).length, withStops: withStops.length,
      plates: plates, durs: sortedNums(durs) };
  }

  function summarize(A, ym) {
    var D = A.dests, W = A.mappedVisits, R = { ym: ym };
    D.forEach(function (d, i) { d.rank = i + 1; d.band = edgeIndex(d.km, BAND_EDGES); d.sector = Math.round(d.bearing / 45) % 8; });
    R.dests = D; R.unmapped = A.unmapped; R.totalVisits = A.totalVisits; R.mappedVisits = W; R.localVisits = A.localVisits;
    R.coverage = A.totalVisits ? Math.round(W / A.totalVisits * 1000) / 10 : 0;
    R.approxCount = D.filter(function (d) { return d.approx; }).length;

    // ระยะถนนเดียว: เฉลี่ยถ่วงน้ำหนัก / มัธยฐานถ่วงน้ำหนัก / Standard Distance / ไกลสุด
    var sw = 0, sw2 = 0, estRound = 0;
    D.forEach(function (d) { sw += d.count * d.km; sw2 += d.count * d.km * d.km; estRound += d.count * 2 * d.km; });
    R.wAvg = W ? sw / W : 0; R.stdDist = W ? Math.sqrt(sw2 / W) : 0; R.estRoundKm = estRound;
    var byKm = D.slice().sort(function (a, b) { return a.km - b.km; }), cum = 0; R.wMedian = 0;
    for (var i = 0; i < byKm.length; i++) { cum += byKm[i].count; if (cum >= W / 2) { R.wMedian = byKm[i].km; break; } }
    R.farthest = D.length ? D.slice().sort(function (a, b) { return b.km - a.km; })[0] : null;
    R.maxStraight = D.reduce(function (m, d) { return Math.max(m, d.straight); }, 0);

    // ช่วงรัศมี
    R.bands = BAND_LABELS.map(function (lb, k) { return { label: lb, color: BAND_COL[k], dests: 0, visits: 0, estKm: 0 }; });
    D.forEach(function (d) { var b = R.bands[d.band]; b.dests++; b.visits += d.count; b.estKm += d.count * 2 * d.km; });
    R.bands.forEach(function (b) { b.pct = W ? Math.round(b.visits / W * 1000) / 10 : 0; });
    R.within20 = W ? Math.round((R.bands[0].visits + R.bands[1].visits + R.bands[2].visits) / W * 1000) / 10 : 0;
    R.within10 = W ? Math.round((R.bands[0].visits + R.bands[1].visits) / W * 1000) / 10 : 0;

    // ทิศทาง
    R.sectors = SECTORS.map(function (nm) { return { name: nm, v: 0 }; });
    D.forEach(function (d) { R.sectors[d.sector].v += d.count; });

    // วงรอบ (จากเลขไมล์จริง)
    var K = A.tripKms; R.trip = { n: K.length, mean: K.length ? K.reduce(function (a, b) { return a + b; }, 0) / K.length : 0, med: pctile(K, 0.5), p90: pctile(K, 0.9), max: K.length ? K[K.length - 1] : 0 };
    R.tripBins = TRIP_LABELS.map(function (lb) { return { name: lb, v: 0 }; });
    K.forEach(function (v) { R.tripBins[edgeIndex(v, TRIP_EDGES)].v++; });
    R.multiStopPct = A.withStops ? Math.round(A.multiStop / A.withStops * 1000) / 10 : 0;
    R.durMed = A.durs.length ? pctile(A.durs, 0.5) : null;
    R.plates = Object.keys(A.plates).map(function (k) {
      var P = A.plates[k], s = sortedNums(P.list);
      return { plate: P.plate, trips: P.trips, km: P.km, avg: P.km / P.trips, med: pctile(s, 0.5), max: s[s.length - 1] };
    }).sort(function (a, b) { return b.km - a.km; });

    // ปลายทางใกล้กันที่ถูกเดินแยกเที่ยว (โอกาสรวมเที่ยว)
    var top = D.slice(0, 14).filter(function (d) { return d.straight > 3; }), grp = top.map(function (d, i) { return i; });
    function find(i) { while (grp[i] !== i) i = grp[i] = grp[grp[i]]; return i; }
    for (var a = 0; a < top.length; a++) for (var b = a + 1; b < top.length; b++) if (haversine(top[a], top[b]) <= 3) grp[find(a)] = find(b);
    var cl = {};
    top.forEach(function (d, i) { var g = find(i); (cl[g] || (cl[g] = { items: [], n: 0 })); cl[g].items.push(d); cl[g].n += d.count; });
    R.clusters = Object.keys(cl).map(function (k) { return cl[k]; }).filter(function (c) { return c.items.length >= 2; }).sort(function (x, y) { return y.n - x.n; }).slice(0, 2);

    // ข้อสรุป
    var L = [], nm = function (d) { return d.name; };
    if (!D.length) {
      L.push('ยังไม่มีปลายทางที่ปักหมุดพิกัดในชีต Locations จึงวิเคราะห์ระยะทางเชิงพื้นที่ไม่ได้ — ปักหมุดได้ที่หน้า "แผนที่เส้นทาง" (routemap.html)');
    } else {
      L.push('ปลายทางที่มีพิกัด ' + fmt(D.length) + ' จุด ครอบคลุม ' + R.coverage + '% ของการไปปลายทางทั้งหมด (' + fmt(W) + ' จาก ' + fmt(A.totalVisits) + ' ครั้ง)'
        + (A.unmapped.length ? ' · ยังไม่ปักหมุด ' + fmt(A.unmapped.length) + ' จุด' : ''));
      L.push('รูปแบบการเดินรถเป็นแบบศูนย์กลาง-แฉก (hub-and-spoke) จาก ' + HOSP.name + ': ' + R.within20 + '% ของการไปอยู่ในรัศมีทางถนน 20 กม. และ ' + R.within10 + '% อยู่ในรัศมี 10 กม.');
      L.push('ระยะทางเดียวเฉลี่ยถ่วงน้ำหนักตามจำนวนครั้ง ' + r1(R.wAvg) + ' กม. (ไป-กลับ ≈ ' + r1(R.wAvg * 2) + ' กม.) · มัธยฐาน ' + r1(R.wMedian) + ' กม. · รัศมีการกระจายตัว (Standard Distance) ' + r1(R.stdDist) + ' กม.'
        + (R.farthest ? ' · ไกลสุด: ' + nm(R.farthest) + ' ' + r1(R.farthest.km) + ' กม.' : ''));
      var ds = R.sectors.slice().sort(function (x, y) { return y.v - x.v; });
      if (ds[0].v) L.push('ทิศที่ไปมากที่สุด: ' + ds[0].name + ' (' + Math.round(ds[0].v / W * 100) + '% ของการไป)' + (ds[1].v ? ' รองลงมา ' + ds[1].name + ' (' + Math.round(ds[1].v / W * 100) + '%)' : ''));
    }
    if (R.trip.n) {
      var cmp = '';
      if (D.length && R.wAvg > 0) {
        var ratio = R.trip.mean / (R.wAvg * 2);
        cmp = ratio > 1.3 ? ' — สูงกว่าระยะไป-กลับแบบจุดเดียว ' + r1(ratio) + ' เท่า สะท้อนว่าหลายเที่ยวแวะมากกว่า 1 จุดหรือวิ่งนอกเส้นทางหลัก'
          : ratio < 0.8 ? ' — ต่ำกว่าระยะไป-กลับแบบจุดเดียว (หลายเที่ยวเป็นงานระยะสั้นในพื้นที่ หรือเลขไมล์ขาดบางเที่ยว)' : ' — สอดคล้องกับระยะไป-กลับแบบจุดเดียว';
      }
      L.push('วงรอบการใช้รถ (จากเลขไมล์จริง): เฉลี่ย ' + r1(R.trip.mean) + ' กม./เที่ยว · มัธยฐาน ' + r1(R.trip.med) + ' · P90 ' + r1(R.trip.p90) + ' · สูงสุด ' + r1(R.trip.max) + ' กม.' + cmp);
      if (A.withStops) L.push('เที่ยวที่แวะ 2 จุดขึ้นไปมี ' + R.multiStopPct + '% ของเที่ยวที่ระบุปลายทาง' + (R.durMed ? ' · ระยะเวลาออก-กลับมัธยฐาน ' + Math.round(R.durMed) + ' นาที/เที่ยว' : ''));
    }
    R.clusters.forEach(function (c) {
      L.push('ข้อเสนอ: ปลายทางกลุ่มที่อยู่ใกล้กัน (ห่างกันไม่เกิน 3 กม. เส้นตรง) ได้แก่ ' + c.items.map(function (d) { return d.name; }).join(', ') + ' รวม ' + fmt(c.n) + ' ครั้ง — พิจารณารวมเที่ยวเมื่อมีงานช่วงเวลาใกล้กัน');
    });
    R.insights = L;
    return R;
  }

  // ───────────── แผนที่ (OSM tiles → canvas) ─────────────
  function mu(lng) { return (lng + 180) / 360; }
  function mv(lat) { var s = Math.sin(rad(lat)); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }

  function loadTile(z, x, y, k) {
    k = k || 0;
    if (k >= TILES.length) return Promise.resolve(null);
    return new Promise(function (res) {
      var im = new Image(), t = setTimeout(function () { im.onload = im.onerror = null; res(null); }, 9000);
      im.crossOrigin = 'anonymous';
      im.onload = function () { clearTimeout(t); res(im); };
      im.onerror = function () { clearTimeout(t); res(null); };
      im.src = TILES[k].replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }).then(function (im) { return im || loadTile(z, x, y, k + 1); });
  }

  function drawMap(R) {
    var FONT = '"Noto Sans Thai","Sarabun",sans-serif';
    // กรอบแผนที่ = ปลายทางที่ครอบคลุม ≥95% ของการไป (ปลายทางไกลมากที่เหลือแสดงเป็นลูกศรที่ขอบ ไม่ทำให้ภาพเล็กลง)
    var byS = R.dests.slice().sort(function (a, b) { return a.straight - b.straight; }), cum = 0, cut = 0;
    for (var q = 0; q < byS.length; q++) { cum += byS[q].count; cut = byS[q].straight; if (cum >= 0.95 * R.mappedVisits) break; }
    var lim = Math.max(cut * 1.15, 8);
    var core = R.dests.filter(function (d) { return d.straight <= lim; }), outside = R.dests.filter(function (d) { return d.straight > lim; });
    R.outside = outside.map(function (d) { return { name: d.name, km: d.km, count: d.count }; });
    var coreMax = core.reduce(function (m, d) { return Math.max(m, d.straight); }, 0);
    var pts = [HOSP].concat(core);
    var minU = 9, maxU = -9, minV = 9, maxV = -9;
    pts.forEach(function (p) { var u = mu(p.lng), v = mv(p.lat); minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); });
    var pad = 50, spanU = Math.max(maxU - minU, 0.0004), spanV = Math.max(maxV - minV, 0.0004);
    var zf = clamp(Math.log(Math.min((MAP_W - 2 * pad) / (spanU * 256), (MAP_H - 2 * pad) / (spanV * 256))) / Math.LN2, 8, 15.5);
    var uc = (minU + maxU) / 2, vc = (minV + maxV) / 2, S = 256 * Math.pow(2, zf);   // พิกเซล CSS ต่อ 1 หน่วยโลก
    function sx(lng) { return (mu(lng) - uc) * S + MAP_W / 2; }
    function sy(lat) { return (mv(lat) - vc) * S + MAP_H / 2; }

    var zt = clamp(Math.round(zf + 1), 0, 18), n = Math.pow(2, zt), tiles = [];
    var x0 = Math.floor((uc - MAP_W / 2 / S) * n), x1 = Math.floor((uc + MAP_W / 2 / S) * n);
    var y0 = Math.floor((vc - MAP_H / 2 / S) * n), y1 = Math.floor((vc + MAP_H / 2 / S) * n);
    for (var tx = x0; tx <= x1; tx++) for (var ty = y0; ty <= y1; ty++) if (tx >= 0 && ty >= 0 && tx < n && ty < n && tiles.length < 90) tiles.push({ x: tx, y: ty });

    var fontReady = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('700 12px "Noto Sans Thai"'), document.fonts.load('400 12px "Noto Sans Thai"')]).catch(function () {}) : Promise.resolve();
    return Promise.all([fontReady, Promise.all(tiles.map(function (t) { return loadTile(zt, t.x, t.y).then(function (im) { t.im = im; }); }))]).then(function () {
      var loaded = tiles.filter(function (t) { return t.im; }).length;

      function paint(useTiles) {
        var cv = document.createElement('canvas'); cv.width = MAP_W * DPR; cv.height = MAP_H * DPR;
        var c = cv.getContext('2d'); c.scale(DPR, DPR);
        c.fillStyle = '#eef2f6'; c.fillRect(0, 0, MAP_W, MAP_H);
        if (useTiles) {
          var ts = S / n;
                    tiles.forEach(function (t) { if (t.im) c.drawImage(t.im, (t.x / n - uc) * S + MAP_W / 2, (t.y / n - vc) * S + MAP_H / 2, ts + 0.6, ts + 0.6); });
        } else {
          c.strokeStyle = '#dbe3ee'; c.lineWidth = 1;
          for (var g = 0; g <= MAP_W; g += 58) { c.beginPath(); c.moveTo(g, 0); c.lineTo(g, MAP_H); c.stroke(); }
          for (var h = 0; h <= MAP_H; h += 58) { c.beginPath(); c.moveTo(0, h); c.lineTo(MAP_W, h); c.stroke(); }
        }
        function halo(txt, x, y, size, weight, color, align) {
          c.font = weight + ' ' + size + 'px ' + FONT; c.textAlign = align || 'center'; c.textBaseline = 'middle';
          c.lineJoin = 'round'; c.lineWidth = 4; c.strokeStyle = 'rgba(255,255,255,.92)'; c.strokeText(txt, x, y);
          c.fillStyle = color; c.fillText(txt, x, y);
        }
        // เส้นทาง (หนาตามจำนวนครั้ง — วาดเส้นน้อย→มาก)
        var maxC = R.dests.reduce(function (m, d) { return Math.max(m, d.count); }, 1);
        R.dests.slice().reverse().forEach(function (d) {
          var line = d.geom && d.geom.length > 1 ? d.geom.map(function (q) { return [q[1], q[0]]; }) : [[HOSP.lat, HOSP.lng], [d.lat, d.lng]];
          var w = 1.6 + 4.2 * Math.sqrt(d.count / maxC);
          [['rgba(255,255,255,.9)', w + 2.4], [BAND_COL[d.band], w]].forEach(function (st) {
            c.beginPath(); line.forEach(function (q, i) { var X = sx(q[1]), Y = sy(q[0]); if (i) c.lineTo(X, Y); else c.moveTo(X, Y); });
            c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = st[0]; c.lineWidth = st[1]; c.globalAlpha = st[0].charAt(0) === 'r' ? 1 : 0.85; c.stroke(); c.globalAlpha = 1;
          });
          if (!d.geom) { /* เส้นตรง = ประมาณ */ }
        });
        // หมุดปลายทาง
        R.dests.slice().reverse().forEach(function (d) {
          var X = sx(d.lng), Y = sy(d.lat);
          if (d.rank <= TOP_MARKERS) {
            c.beginPath(); c.arc(X, Y, 10.5, 0, 7); c.fillStyle = BAND_COL[d.band]; c.fill(); c.lineWidth = 2.2; c.strokeStyle = '#fff'; c.stroke();
            c.font = '700 11px ' + FONT; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.fillText(String(d.rank), X, Y + 0.5);
          } else {
            c.beginPath(); c.arc(X, Y, 4, 0, 7); c.fillStyle = BAND_COL[d.band]; c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#fff'; c.stroke();
          }
        });
        // ชื่อปลายทาง (อันดับต้นๆ) — เลี่ยงการทับกัน ถ้าไม่มีที่ว่างจะเหลือแต่หมายเลข
        var placed = [[sx(HOSP.lng) - 40, sy(HOSP.lat) - 16, 80, 44], [0, MAP_H - 48, 190, 48], [MAP_W - 260, MAP_H - 22, 260, 22]];
        function hit(r) { return placed.some(function (q) { return r[0] < q[0] + q[2] && r[0] + r[2] > q[0] && r[1] < q[1] + q[3] && r[1] + r[3] > q[1]; }); }
        c.font = '700 11px ' + FONT;
        R.dests.filter(function (d) { return d.rank <= TOP_MARKERS && sx(d.lng) > 0 && sx(d.lng) < MAP_W && sy(d.lat) > 0 && sy(d.lat) < MAP_H; }).forEach(function (d) {
          var X = sx(d.lng), Y = sy(d.lat), tw = c.measureText(d.name).width + 4, th = 15;
          [[15, -th / 2, 'left'], [-15 - tw, -th / 2, 'right'], [-tw / 2, -27, 'center'], [-tw / 2, 14, 'center']].some(function (o) {
            var r = [X + o[0], Y + o[1], tw, th];
            if (r[0] < 2 || r[0] + tw > MAP_W - 2 || r[1] < 2 || r[1] + th > MAP_H - 2 || hit(r)) return false;
            placed.push(r); halo(d.name, r[0] + tw / 2, r[1] + th / 2, 11, '700', '#142d59'); return true;
          });
        });
        // ปลายทางนอกกรอบแผนที่ → ลูกศรที่ขอบ
        var hx0 = sx(HOSP.lng), hy0 = sy(HOSP.lat);
        outside.forEach(function (d) {
          var vx = sx(d.lng) - hx0, vy = sy(d.lat) - hy0, L = Math.sqrt(vx * vx + vy * vy) || 1;
          var tx = vx > 0 ? (MAP_W - 30 - hx0) / vx : vx < 0 ? (30 - hx0) / vx : 1e9, ty = vy > 0 ? (MAP_H - 40 - hy0) / vy : vy < 0 ? (40 - hy0) / vy : 1e9;
          var t = Math.min(tx, ty), ax = hx0 + vx * t, ay = hy0 + vy * t, ux = vx / L, uy = vy / L;
          c.beginPath(); c.moveTo(ax + ux * 11, ay + uy * 11); c.lineTo(ax - uy * 8 - ux * 6, ay + ux * 8 - uy * 6); c.lineTo(ax + uy * 8 - ux * 6, ay - ux * 8 - uy * 6); c.closePath();
          c.fillStyle = BAND_COL[edgeIndex(d.km, BAND_EDGES)]; c.fill(); c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke();
          var right = ax > MAP_W / 2;
          halo(d.name + ' ' + fmt(d.km) + ' กม. ' + (right ? '→' : '←'), ax + (right ? -16 : 16), ay + (ay > MAP_H / 2 ? -14 : 14), 11, '700', '#142d59', right ? 'right' : 'left');
        });
        // รพ.
        var hx = sx(HOSP.lng), hy = sy(HOSP.lat);
        c.beginPath(); c.arc(hx, hy, 14, 0, 7); c.fillStyle = '#c62828'; c.fill(); c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke();
        c.fillStyle = '#fff'; c.fillRect(hx - 2.2, hy - 7, 4.4, 14); c.fillRect(hx - 7, hy - 2.2, 14, 4.4);
        halo(HOSP.name, hx, hy + 24, 12, '700', '#8e1b1b');
        // สเกล
        var mpp = 40075016.686 * Math.cos(rad(HOSP.lat)) / S, nice = [1, 2, 5, 10, 20, 50], km = 1;
        nice.forEach(function (v) { if (v * 1000 / mpp <= 130) km = v; });
        var sw = km * 1000 / mpp, bx = 14, by = MAP_H - 30;
        c.fillStyle = 'rgba(255,255,255,.88)'; c.fillRect(bx - 6, by - 14, sw + 44, 34);
        c.strokeStyle = '#142d59'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(bx, by - 4); c.lineTo(bx, by + 4); c.lineTo(bx + sw, by + 4); c.lineTo(bx + sw, by - 4); c.stroke();
        c.font = '700 11px ' + FONT; c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillStyle = '#142d59'; c.fillText(km + ' กม.', bx + sw + 6, by + 2);
        // ทิศเหนือ
        var nx = MAP_W - 28, ny = 30;
        c.fillStyle = 'rgba(255,255,255,.88)'; c.fillRect(nx - 16, ny - 22, 32, 52);
        c.beginPath(); c.moveTo(nx, ny - 14); c.lineTo(nx + 7, ny + 8); c.lineTo(nx, ny + 3); c.lineTo(nx - 7, ny + 8); c.closePath(); c.fillStyle = '#142d59'; c.fill();
        c.font = '700 12px ' + FONT; c.textAlign = 'center'; c.fillText('N', nx, ny + 21);
        // เครดิตแผนที่
        var at = '© OpenStreetMap contributors · เส้นทาง: OSRM';
        c.font = '400 9.5px ' + FONT; var aw = c.measureText(at).width;
        c.fillStyle = 'rgba(255,255,255,.88)'; c.fillRect(MAP_W - aw - 14, MAP_H - 18, aw + 14, 18);
        c.fillStyle = '#44556b'; c.textAlign = 'right'; c.fillText(at, MAP_W - 7, MAP_H - 9);
        return cv;
      }

      var tilesOk = loaded > 0, cv = paint(tilesOk), url;
      try { url = cv.toDataURL('image/jpeg', 0.9); }
      catch (e) { tilesOk = false; cv = paint(false); url = cv.toDataURL('image/jpeg', 0.9); }   // canvas ถูก taint (CORS) → วาดใหม่ไม่ใช้ไทล์
      return { url: url, tilesOk: tilesOk, tiles: loaded + '/' + tiles.length, w: MAP_W, h: MAP_H };
    });
  }

  // ───────────── entry ─────────────
  function compute(o) {
    var A = analyze(o);
    if (!A.tripCount) return Promise.resolve(null);
    return resolveDistances(A.dests).then(function () {
      var R = summarize(A, o.ym);
      var top = R.dests.slice(0, TOP_ROUTES);
      return resolveGeometry(top).then(function () { return R.dests.length ? drawMap(R) : null; }).then(function (map) {
        R.map = map; return R;
      });
    });
  }

  window.SandMonthlyGIS = { compute: compute, HOSP: HOSP, BAND_COL: BAND_COL, BAND_LABELS: BAND_LABELS, MAP_W: MAP_W, MAP_H: MAP_H, _analyze: analyze, _summarize: summarize };
})();
