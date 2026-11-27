/* ============================================================
 *  sand-staff.js — ชื่อเล่นพนักงานขับรถ/เจ้าหน้าที่ (ใช้ร่วมทุกหน้า)
 *
 *  SandStaff.nick(name)   → "บาส"
 *  SandStaff.label(name)  → "นาย ธนวัฒน์ มอญแสง (บาส)"
 *  SandStaff.has(list, name) → true/false (เทียบชื่อโดยไม่สนช่องว่าง/คำนำหน้า)
 *
 *  - ค่า (value) ที่บันทึกลงชีทยังเป็นชื่อเดิมทุกประการ ไม่มีชื่อเล่นปน
 *    ใช้ label() เฉพาะ "ข้อความที่แสดง" เท่านั้น
 *  - ชื่อที่มีวงเล็บอยู่แล้วจะไม่ถูกเติมซ้ำ
 *  - เพิ่ม/แก้ชื่อเล่นได้ที่ตาราง NICK ด้านล่างจุดเดียว
 * ============================================================ */
(function (global) {
  'use strict';

  // key = ชื่อ+นามสกุล (ไม่มีคำนำหน้า ไม่มีช่องว่าง)
  var NICK = {
    'ชัยพรมอญแสง'      : 'ชัย',
    'กิตติพงศ์เขื่อนแก้ว': 'หนุ่ย',
    'กานต์นิธิทองอร'    : 'โบ๊ท',
    'นพดลคำปินคำ'      : 'โด้',
    'เก้าพิจิตร'        : 'เก้า',
    'ภาณุพงค์กางสำโรง' : 'อุ้ม',
    'เฉิมพลเลาแก้ว'    : 'แบงค์',
    'ชัยพรชัยศร'       : 'บอม',
    'คมสันต์ภายไธสงค์' : 'ก๊อต',
    'ธนวัฒน์มอญแสง'    : 'บาส'
  };

  function key(name) {
    return String(name == null ? '' : name)
      .replace(/\s+/g, '')
      .replace(/^(นางสาว|น\.ส\.|นาง|นาย)/, '')
      .toLowerCase();
  }

  function nick(name) { return NICK[key(name)] || ''; }

  function label(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s || s.indexOf('(') !== -1) return s;
    var n = nick(s);
    return n ? s + ' (' + n + ')' : s;
  }

  function has(list, name) {
    var k = key(name);
    for (var i = 0; i < (list || []).length; i++) if (key(list[i]) === k) return true;
    return false;
  }

  global.SandStaff = { NICK: NICK, key: key, nick: nick, label: label, has: has };
})(window);
