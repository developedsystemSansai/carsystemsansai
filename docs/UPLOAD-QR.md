# ติดตั้ง QR ประเมินความพึงพอใจรายคัน

ไฟล์ที่ทับ repo: `satisfaction.html` · `qr-satisfaction.html` (ใหม่) · ไฟล์ Apps Script ในโฟลเดอร์ `gas/` (`11_Satisfaction.gs`, `01_Router.gs`)

## ลำดับ (สำคัญ: ทำ 1 ก่อน 2)
1. **Apps Script** → วางไฟล์ใน `gas/` ที่เปลี่ยน ทับไฟล์เดิมในโปรเจกต์ → Deploy → Manage deployments → แก้ deployment เดิม → Version: **New version** → Deploy
   (ใช้ URL เดิม จึงไม่ต้องแก้ `GAS_URL` ในหน้าเว็บ) · ชีท SatisfactionLog จะเติมคอลัมน์ใหม่เองตอนมีการบันทึกครั้งแรก (หรือเรียก `?action=setupSheets` / รัน `setupSatisfactionSheet` เอง)
2. **GitHub** (developedsystemSansai/carsystemsansai): คัดลอก `satisfaction.html` และ `qr-satisfaction.html` ทับ/เพิ่มที่ root แล้ว commit
3. เปิด `qr-satisfaction.html` **จากเว็บจริง** (ไม่ใช่ไฟล์ในเครื่อง) → รายการรถโหลดจากชีท Vehicles → ตรวจช่อง "ที่อยู่ของ satisfaction.html" → พิมพ์/บันทึก PDF → ติดในรถ

## ทดสอบก่อนติดจริง
เปิด `satisfaction.html?car=ขธ.9302%20ชม.` (ใช้ทะเบียนจริง) → ต้องเห็นการ์ดสถานะรถ + 3 แท็บ → ส่งประเมิน 1 รายการ → ดูแถวใหม่ใน SatisfactionLog (TripID / วัน-เวลาที่ใช้รถ / ที่มา)

## ย้อนกลับ
คืน `satisfaction.html` เดิม (หน้าเดิมทำงานได้เหมือนเดิม) · Code.gs ย้อน Version ใน Manage deployments · คอลัมน์ใหม่ใน SatisfactionLog ปล่อยทิ้งได้
