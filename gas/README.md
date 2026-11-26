# gas/ — Google Apps Script (Backend)

ไฟล์เดียว: **`Code.gs`** (วางทับไฟล์เดิมในโปรเจกต์ Apps Script)

## วิธีอัปเดต
1. เปิดโปรเจกต์ Apps Script → ลบไฟล์ `.gs` อื่นที่เคยมี (เช่น `admin` / `duty` / `send_core`) ให้เหลือ `Code.gs` ไฟล์เดียว
2. วางโค้ดจาก `gas/Code.gs` ทับทั้งไฟล์ แล้วบันทึก
3. **Deploy → Manage deployments → แก้ deployment เดิม → Version: New version** (URL เดิมคงอยู่ ไม่ต้องแก้ `GAS_URL`)

## ข้อควรรู้
- ไฟล์ `admin.js` · `duty.js` · `send_core.js` ใน `archive/legacy-gas/` เป็นรุ่นเก่ากว่าฟังก์ชันชื่อเดียวกันใน `Code.gs` — **ห้ามวางคู่กัน**
