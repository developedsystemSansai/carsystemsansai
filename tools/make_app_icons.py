#!/usr/bin/env python3
"""สร้างชุดไอคอนแอป/เว็บ SAND จากหัวมาสคอต (assets/source/sand-head-cutout.png)
รัน:  python3 tools/make_app_icons.py   (ที่รากของ repo; ต้องมี pillow)
ผลลัพธ์: assets/sand/app/*  +  assets/sand-logo-icon.png (โลโก้ header)
"""
import os
from PIL import Image, ImageDraw, ImageFilter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'sand', 'app'); os.makedirs(OUT, exist_ok=True)
NAVY = (20, 45, 89, 255)

head = Image.open(os.path.join(ROOT, 'assets/source/sand-head-cutout.png')).convert('RGBA')
# ตัดที่แนวคาง (ทิ้งนิ้วโป้ง/เสื้อกั๊ก) แล้วเฟดขอบล่างเล็กน้อย
CHIN = 330
head = head.crop((0, 0, head.width, CHIN))
a = head.getchannel('A'); px = a.load()
for y in range(300, CHIN):               # ลบนิ้วโป้งมุมซ้ายล่าง + เฟดคอ/เสื้อ
    for x in range(head.width):
        f = (CHIN - y) / (CHIN - 300.0)
        if x < 160 and y > 297: f = 0
        px[x, y] = int(px[x, y] * f)
head.putalpha(a)
bb = head.getbbox(); head = head.crop(bb)

def gradient(size):
    g = Image.new('RGBA', (size, size)); d = ImageDraw.Draw(g)
    top, bot = (214, 226, 255), (238, 240, 251)
    for y in range(size):
        t = y / max(1, size - 1)
        d.line([(0, y), (size, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
    return g

def badge(size, safe=1.0, radius=.22, ring=True, flat=False, fill=True):
    """safe<1 = maskable (หัวอยู่ใน safe zone กลางภาพ) · flat=True = เต็มสี่เหลี่ยม (apple-touch)"""
    S = size * 4                                   # วาดใหญ่แล้วย่อเพื่อขอบเนียน
    bg = gradient(S) if fill else Image.new('RGBA', (S, S), (0, 0, 0, 0))
    hw = int(S * (.78 if safe >= 1 else .62)); hh = int(head.height * hw / head.width)
    h = head.resize((hw, hh), Image.LANCZOS)
    x = (S - hw) // 2
    y = (S - hh) // 2 + int(S * .03)
    bg.alpha_composite(h, (x, y))
    if not flat:
        m = Image.new('L', (S, S), 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], int(S * radius), fill=255)
        out = Image.new('RGBA', (S, S), (0, 0, 0, 0)); out.paste(bg, (0, 0), m); bg = out
        if ring:
            ImageDraw.Draw(bg).rounded_rectangle([int(S*.018)]*2 + [S - int(S*.018)]*2, int(S * radius), outline=NAVY, width=int(S * .035))
    return bg.resize((size, size), Image.LANCZOS)

def save(img, name):
    img.save(os.path.join(OUT, name), optimize=True)

save(badge(512), 'icon-512.png'); save(badge(192), 'icon-192.png')
save(badge(512, safe=.9, radius=0, ring=False, flat=True), 'maskable-512.png')
save(badge(180, radius=0, ring=False, flat=True), 'apple-touch-180.png')
f32, f16, f48 = badge(32, ring=False), badge(16, ring=False), badge(48, ring=False)
save(f32, 'favicon-32.png'); save(f16, 'favicon-16.png')
f48.save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)], append_images=[f32, f16])
# โลโก้ header (พื้นหลังหน้าเป็นสีกรมท่า) — วงกลมพื้นอ่อน ขอบขาว
S = 4 * 160; c = badge(160, radius=.5, ring=False)
c.save(os.path.join(ROOT, 'assets', 'sand-logo-icon.png'), optimize=True)
print('ok →', OUT)
