# อัปโหลดขึ้น GitHub — ส่วนวิเคราะห์ GIS ในรายงานประจำเดือน

โครงสร้างในชุดนี้ตรงกับ root ของ repo `developedsystemSansai/carsystemsansai` (วางทับได้เลย ไม่มีโฟลเดอร์ซ้อน)

| ไฟล์ | สถานะ | หมายเหตุ |
|---|---|---|
| `js/monthly-gis.js` | **ใหม่** | วิเคราะห์ระยะ/ทิศ/วงรอบ + วาดแผนที่ OSM (โหลดเองตอนสร้างรายงาน) |
| `js/monthly-report.js` | แก้ไข | เพิ่มหน้า GIS (ส่วนที่ 2) + เครดิตผู้จัดทำท้ายรายงาน |
| `css/monthly-report.css` | แก้ไข | เพิ่มสไตล์ท้ายไฟล์ (.mr-h2 .mr-map .mr-legend .mr-credit) |

ไม่ต้องแก้ `Code.gs` และ `dashboard.html` (ใช้ action `getLocationPins` ที่มีอยู่แล้ว)

```bash
git clone https://github.com/developedsystemSansai/carsystemsansai.git
cd carsystemsansai
git checkout -b feat/monthly-report-gis
# คัดลอก 3 ไฟล์จากชุดนี้ทับในโฟลเดอร์ repo
git add js/monthly-gis.js js/monthly-report.js css/monthly-report.css
git commit -m "feat: monthly report GIS map + radius analysis + author credit"
git push -u origin feat/monthly-report-gis   # แล้วเปิด Pull Request / merge เมื่อทดสอบแล้ว
```

ทดสอบหลังขึ้นเว็บ: เปิด Dashboard → รายงานประจำเดือน → "สร้างใหม่" ของเดือนล่าสุด → ตรวจหน้า 3–4 (แผนที่ + ตาราง) และเครดิตท้ายรายงาน
ต้องมีพิกัดปลายทางในชีต Locations (ปักหมุดที่ routemap.html) ปลายทางที่ไม่มีพิกัดจะไม่ถูกนับ

ย้อนกลับ: ลบ `js/monthly-gis.js` และใช้ `js/monthly-report.js` และ `css/monthly-report.css` เวอร์ชันก่อนหน้า (หรือ `git revert`) — รายงานเดิมทำงานได้เหมือนเดิม

## เครดิต
นายจันทกรณ์ จีกัน (Chanthakon Chikan) · นักวิชาการสาธารณสุขชำนาญการ · กลุ่มงานพัฒนาคุณภาพบริการและมาตรฐาน · โรงพยาบาลสันทราย จังหวัดเชียงใหม่ · โทร 053-921-199 ต่อ 168
