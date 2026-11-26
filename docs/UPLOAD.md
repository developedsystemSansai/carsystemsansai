# อัปโหลดขึ้น GitHub (developedsystemSansai/carsystemsansai)

ไฟล์ที่เปลี่ยน: `index.html` `worktable.html` `swap.html` และทุกหน้า `*.html` (เพิ่ม 2 บรรทัดโหลด css/js หลัง `js/secure-fetch.js`) · `README.md`
ไฟล์ใหม่: `css/sand-brand.css` `js/sand-brand.js` `brand.html` `assets/sand/**` `assets/source/**` `tools/slice_sheet.py` `skills/sand-brand-kit/**`

```bash
git clone https://github.com/developedsystemSansai/carsystemsansai.git
cd carsystemsansai
# คัดลอกไฟล์จากชุดนี้ทับ (โฟลเดอร์ assets/ เดิมของคุณคงอยู่ — เพิ่มเฉพาะ assets/sand และ assets/source)
git checkout -b feat/sand-brand-kit
git add -A && git commit -m "feat: SAND brand kit — mascot, icons, 10:00 unchecked-vehicle reminder"
git push -u origin feat/sand-brand-kit   # แล้วเปิด Pull Request / หรือ merge เข้า main เมื่อทดสอบแล้ว
```

ย้อนกลับ: ลบ 2 บรรทัด `css/sand-brand.css` / `js/sand-brand.js` ออกจากหน้า — ระบบเดิมทำงานได้เหมือนเดิม (ไม่มีหน้าใดแก้ logic เดิม)
