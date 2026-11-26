# ⚠️ ห้าม deploy — ไฟล์ GAS รุ่นเก่า

`admin.js` · `duty.js` · `send_core.js` เคยอยู่ที่รากของ repo (เป็นชิ้นส่วนที่แยกจาก `Code.gs` ในอดีต)
ตรวจเทียบกับ `Code.gs` ปัจจุบันแล้วพบว่า **ฟังก์ชันชื่อเดียวกัน 19 ตัวมีโค้ดต่างกัน และรุ่นใน `Code.gs` ใหม่กว่า** เช่น

- `send_core.js` ใช้ `LINE_SEND_CTX_` / `getLineSendLogSheet_` ส่วน `Code.gs` ใช้ `lineLogCallBase_` / `getOrCreateLineSendLogSheet_`
- `duty.js` คืนโครงสร้างผลลัพธ์คนละแบบ (`groups`/`dutyCount`) กับ `Code.gs` (`people`/`warning`) และ `Code.gs` อ่านตารางเวรเดือนก่อน/ปัจจุบัน/ถัดไป

เก็บไว้เพื่ออ้างอิงเท่านั้น ถ้าวางลง Apps Script คู่กับ `gas/` จะทับฟังก์ชันใหม่ด้วยรุ่นเก่า
