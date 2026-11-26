// ============================================================
//  secure-fetch.js — SAND ระบบยานพาหนะ รพ.สันทราย
//  แทนที่ GAS Proxy เดิม: ฝัง apikey + clientIp เข้าไปในทุก request
//  ที่ยิงไปยัง GAS_URL โดยอัตโนมัติ — ไม่ต้องแก้ fetch() เดิมในแต่ละหน้าเลย
//
//  วิธีใช้: ใส่ <script src="secure-fetch.js"></script> ไว้ "ก่อน" แท็ก
//  <script> ที่ประกาศ const GAS_URL = '...'; ของแต่ละหน้า (ลำดับไม่กระทบ
//  การทำงานจริงเพราะฟังก์ชันจะถูกเรียกหลังหน้าโหลดเสร็จเสมอ แต่ใส่ก่อนไว้ดูง่ายกว่า)
//
//  ⚠️ ระบบนี้ใช้เฉพาะภายในหน่วยงาน (ผู้บริหาร + พขร.) ไม่เผยแพร่สู่สาธารณะ
//     API_KEY ที่ฝังในไฟล์นี้จึงยังมีความเสี่ยงเชิง "ใครมีลิงก์เว็บก็เห็นได้"
//     เท่ากับความเสี่ยงเดิมที่ proxy เคยมี — แต่ระบบยุบ proxy ได้เพราะกลุ่มผู้ใช้ปิด
// ============================================================

const API_KEY = '8358d83f-8270-4a84-9c73-9a22efacce82';

// ── เก็บ IP ของผู้เข้าใช้งาน (client-reported, best-effort) ──
// หมายเหตุ: Apps Script ไม่ส่ง IP ผู้เรียกมาให้ backend อ่านได้เอง (ข้อจำกัดแพลตฟอร์ม)
// จึงต้องให้ browser ไปถาม IP ตัวเองจากบริการสาธารณะ แล้วแนบมากับ request แทน
// ค่านี้ผู้ใช้แก้ไขเองได้หากจงใจปลอม (ไม่ใช่หลักฐานยืนยันตัวตน แค่ log เพื่อสังเกตการณ์)
let _sandClientIp = 'unknown';
(function fetchClientIp() {
  fetch('https://api.ipify.org?format=json')
    .then(function (r) { return r.json(); })
    .then(function (d) { _sandClientIp = d.ip || 'unknown'; })
    .catch(function () { _sandClientIp = 'unknown'; });
})();

(function installSecureFetch() {
  const originalFetch = window.fetch.bind(window);

  function injectIntoJsonString(jsonStr) {
    try {
      const obj = JSON.parse(jsonStr);
      obj.apikey = API_KEY;
      obj.clientIp = _sandClientIp;
      return JSON.stringify(obj);
    } catch (err) {
      // parse ไม่ได้ (เช่น payload รูปภาพขนาดใหญ่ที่ raw ไม่ใช่ JSON ล้วน) — ปล่อยผ่านตามเดิม
      return jsonStr;
    }
  }

  window.fetch = function (url, options) {
    const isGasCall = typeof url === 'string'
      && typeof GAS_URL !== 'undefined'
      && GAS_URL
      && url.indexOf(GAS_URL) === 0;

    if (!isGasCall) return originalFetch(url, options);

    const method = (options && options.method || 'GET').toUpperCase();

    // ---- GET: แนบ apikey + clientIp เป็น query string ----
    if (method === 'GET') {
      const sep = url.indexOf('?') === -1 ? '?' : '&';
      const newUrl = url + sep + 'apikey=' + encodeURIComponent(API_KEY)
        + '&clientIp=' + encodeURIComponent(_sandClientIp);
      return originalFetch(newUrl, options);
    }

    // ---- POST: รองรับ 3 รูปแบบ body ที่ใช้อยู่ในระบบ ----
    const opts = Object.assign({}, options);
    const body = opts.body;

    if (body instanceof URLSearchParams) {
      const raw = body.get('payload');
      if (raw != null) {
        const newParams = new URLSearchParams();
        newParams.set('payload', injectIntoJsonString(raw));
        opts.body = newParams;
      }
    } else if (typeof body === 'string') {
      if (body.indexOf('payload=') === 0) {
        // form-urlencoded: "payload=<encoded JSON>"
        const raw = decodeURIComponent(body.slice('payload='.length));
        opts.body = 'payload=' + encodeURIComponent(injectIntoJsonString(raw));
      } else if (body.trim().indexOf('{') === 0) {
        // raw JSON body
        opts.body = injectIntoJsonString(body);
      }
    }

    return originalFetch(url, opts);
  };
})();
