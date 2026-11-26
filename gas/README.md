# gas/ — Google Apps Script (Backend)

เดิมเป็นไฟล์เดียว `Code.gs` (11,515 บรรทัด) ตอนนี้แยกเป็น 23 ไฟล์ตามหมวดงาน **โดยไม่เปลี่ยนโค้ดแม้แต่บรรทัดเดียว**
(ตรวจแล้ว: ต่อไฟล์ทั้งหมดตามลำดับเลข = ได้ Code.gs เดิมทุกตัวอักษร ยกเว้นบรรทัดว่างตรงรอยต่อ)

## ลำดับไฟล์ (ห้ามสลับ)
Apps Script รวมทุกไฟล์เป็น global scope เดียว และโหลดตามลำดับไฟล์ ค่าคงที่ระดับบนสุด (`const`/`var`) ของไฟล์หลังอาจอ้างค่าจากไฟล์ก่อนหน้า
จึงต้องเรียงตามเลขนำหน้าเสมอ (ใน Editor ลากไฟล์ให้เรียง 00 → 22)

| ไฟล์ | หน้าที่ | หน้าเว็บที่เกี่ยวข้อง |
|---|---|---|
| `00_Config_Core.gs` | ค่าตั้งต้น · แคช · log · lock · `isAuthorized` | ทุกหน้า |
| `01_Router.gs` | `doGet` / `doPost` / `doPostCore_` (ตัวกระจายคำสั่ง) | ทุกหน้า |
| `02_Check_Photos.gs` | ตรวจสภาพรถ · อัปโหลดรูปขึ้น Drive · `getCheckData` | check.html |
| `03_Mile.gs` | บันทึกเลขไมล์ · รีเซตสถานะรถรายวัน | startmile.html |
| `04_MileEdit.gs` | ขอแก้ไข/ลบเลขไมล์ | editmile.html |
| `05_EMS.gs` | ตรวจอุปกรณ์ EMS | EMScheck.html |
| `06_StatusSummary.gs` | สรุปสถานะรถ | index / dashboard |
| `07_Vehicles_Config.gs` | รถ · พขร. · Config | หลายหน้า |
| `08_Anomaly_Utils.gs` | ตรวจไมล์ผิดปกติ · utilities | — |
| `09_Setup_Locations.gs` | setup ชีต · Location Pins | routemap.html |
| `10_Repair.gs` | แจ้งซ่อม | fixedcar.html |
| `11_Satisfaction.gs` | ประเมินความพึงพอใจ | satisfaction.html |
| `12_Worktable_Jobs.gs` | ตารางเวร · ตารางงาน · แก้เวรรายช่อง | worktable.html |
| `13_Maintenance_Reload.gs` | งานบำรุงรักษา · สัญญาณ reload | — |
| `14_Line_Config_Webhook.gs` | LINE config · webhook · เบอร์โทร | — |
| `15_Roster.gs` | อ่านผู้อยู่เวรวันนี้ | — |
| `16_Line_Send.gs` | LINE API (reply/push/multicast) + ประวัติการส่ง | linecontrol.html |
| `17_Line_Reports.gs` | รายงานอัตโนมัติ 3 ฉบับ | — |
| `18_Line_Control_Triggers.gs` | trigger + ศูนย์ควบคุม LINE | linecontrol.html |
| `19_Line_Tests.gs` | ฟังก์ชันทดสอบ (รันจาก Editor) | — |
| `20_Swap.gs` | ระบบแลกเวร | swap.html |
| `21_Swap_Report.gs` | ใบแลกเวร Excel · บันทึกข้อความ | swap.html |
| `22_Monthly_Report_Pdf.gs` | รายงานประจำเดือน PDF บน Drive | dashboard.html |

## วิธีย้ายเข้าโปรเจกต์ Apps Script เดิม
1. **ลบไฟล์ `.gs` เดิมทั้งหมดในโปรเจกต์** (รวม `Code.gs`, และ `admin` / `duty` / `send_core` ถ้ามี) — ถ้าเหลือไฟล์เก่าอยู่ ฟังก์ชันชื่อซ้ำจะทับกันและ `const` ซ้ำจะ error
2. สร้างไฟล์ใหม่ชื่อเดียวกับในโฟลเดอร์นี้ (ไม่ต้องใส่ `.gs`) วางโค้ด แล้วลากเรียงตามเลข
3. ไม่ต้องแตะ Script Properties / Triggers / ชีต — ชื่อฟังก์ชันเหมือนเดิมทุกตัว trigger เดิมยังทำงาน
4. **Deploy → Manage deployments → แก้ deployment เดิม → Version: New version** (URL เดิมไม่เปลี่ยน จึงไม่ต้องแก้ `GAS_URL` ในหน้าเว็บ)

### ใช้ clasp (ทางเลือก)
คัดลอก `.clasp.json.example` เป็น `.clasp.json` ใส่ `scriptId` แล้ว `clasp push` — `filePushOrder` ล็อกลำดับไฟล์ให้ครบ

## ข้อควรรู้
- `appsscript.json.example` เป็นแค่ตัวอย่าง (timezone/runtime) **อย่าเขียนทับ manifest จริง** ของโปรเจกต์ที่ตั้ง Web App/สิทธิ์ไว้แล้ว
- ไฟล์ `admin.js` · `duty.js` · `send_core.js` ที่เคยอยู่ที่รากของ repo เป็น **รุ่นเก่ากว่า** ฟังก์ชันชื่อเดียวกันใน `Code.gs` (เช่น ใช้ชีท log คนละระบบ, ตารางเวรรุ่นเก่า)
  จึงย้ายไป `archive/legacy-gas/` — ถ้าเอาไปวางคู่กับโค้ดชุดนี้ จะทับฟังก์ชันใหม่ด้วยรุ่นเก่าและทำให้ประวัติการส่ง LINE / ตารางเวรผิด
