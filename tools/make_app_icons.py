#!/usr/bin/env python3
"""สร้างโลโก้เว็บ/แอปจากชีตแบรนด์ SAND (assets/source/sand-sheet.webp)
ผลลัพธ์:
  assets/sand/app/   head.png, icon-512/192.png, maskable-512.png, apple-touch-180.png, favicon-32/16.png, favicon.ico
  assets/sand-logo-icon.png   (ตราหน้า header — หลายหน้าอ้างถึงไฟล์นี้)
ใช้: python3 tools/make_app_icons.py   (รันที่รากของ repo; ต้องมี pillow numpy opencv-python)
"""
import os
import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets/source/sand-sheet.webp')
OUT = os.path.join(ROOT, 'assets/sand/app')
os.makedirs(OUT, exist_ok=True)

NAVY = (30, 42, 94)
PURPLE = (107, 75, 184)


def cut_head():
    """ตัดหัวมาสคอตตัวใหญ่ออกจากชีต (หมวก+ใบหน้า) ด้วย GrabCut — เส้นขอบกรมท่าหนาช่วยให้ขอบสะอาด"""
    im = cv2.imread(SRC)
    x0, y0, x1, y1 = 255, 15, 660, 345
    crop = im[y0:y1, x0:x1].copy()
    h, w = crop.shape[:2]
    mask = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    cv2.ellipse(mask, (int(w * .55), int(h * .5)), (int(w * .36), int(h * .46)), 0, 0, 360, cv2.GC_PR_FGD, -1)
    cv2.ellipse(mask, (int(w * .55), int(h * .5)), (int(w * .22), int(h * .32)), 0, 0, 360, cv2.GC_FGD, -1)
    mask[:4, :] = mask[-4:, :] = cv2.GC_BGD
    mask[:, :4] = mask[:, -4:] = cv2.GC_BGD
    bg = np.zeros((1, 65)); fg = np.zeros((1, 65))
    cv2.grabCut(crop, mask, None, bg, fg, 8, cv2.GC_INIT_WITH_MASK)
    a = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(a)
    a = ((lab == 1 + np.argmax(st[1:, 4])) * 255).astype(np.uint8)
    a = cv2.morphologyEx(a, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    rgba = cv2.cvtColor(crop, cv2.COLOR_BGR2RGBA)
    rgba[:, :, 3] = cv2.GaussianBlur(a, (0, 0), .9)
    img = Image.fromarray(rgba)
    return img.crop(img.getbbox())


def badge(head, size, safe=1.0, round_=0.22, ring=True, drop=.06):
    """พื้นลาเวนเดอร์ไล่เฉด + หัวมาสคอตชิดล่าง (ถูกขอบตัดเหมือนรูปโปรไฟล์) + เส้นโค้งม่วงตามโลโก้
    safe<1 = เผื่อขอบสำหรับ maskable (ระบบจะตัดเป็นวงกลม/สควิร์เคิลเอง)"""
    S = size * 4                                     # วาด 4x แล้วย่อ เพื่อขอบเรียบ
    bgc = Image.new('RGBA', (S, S))
    px = bgc.load()
    top, bot = np.array((243, 244, 252)), np.array((214, 220, 248))
    col = [tuple(int(v) for v in (top + (bot - top) * y / (S - 1))) + (255,) for y in range(S)]
    for y in range(S):
        for x in range(S):
            px[x, y] = col[y]
    d = ImageDraw.Draw(bgc)
    if ring:
        w = int(S * .045)
        d.arc((int(-S * .25), int(S * .30), int(S * 1.05), int(S * 1.45)), 200, 330, fill=PURPLE + (255,), width=w)
    hw = int(S * (.80 if safe >= 1 else .70))
    hh = int(head.height * hw / head.width)
    h = head.resize((hw, hh), Image.LANCZOS)
    cx = int(S * .50)
    if safe < 1:                                     # maskable: อยู่กลางภาพ ไม่ชิดขอบ
        top_y = int(S * .5 - hh * .5 + S * .04)
    else:                                            # ชิดล่าง ปล่อยให้ขอบตัดคาง (ส่วนที่เคยโดนมือบังในชีต)
        top_y = int(S + hh * drop - hh)
    bgc.alpha_composite(h, (cx - hw // 2, top_y))
    out = bgc.resize((size, size), Image.LANCZOS)
    if round_:
        m = Image.new('L', (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle((0, 0, S - 1, S - 1), int(S * round_), fill=255)
        out.putalpha(m.resize((size, size), Image.LANCZOS))
    return out


def main():
    head = cut_head()
    head.save(os.path.join(OUT, 'head.png'))
    badge(head, 512).save(os.path.join(OUT, 'icon-512.png'))
    badge(head, 192).save(os.path.join(OUT, 'icon-192.png'))
    badge(head, 512, safe=.78, round_=0).save(os.path.join(OUT, 'maskable-512.png'))   # เต็มพื้น ไม่โค้งมุม
    badge(head, 180, round_=0).save(os.path.join(OUT, 'apple-touch-180.png'))           # iOS โค้งมุมให้เอง
    f32 = badge(head, 32, round_=.22, ring=False, drop=-.10)
    f16 = badge(head, 16, round_=.22, ring=False, drop=-.10)
    f32.save(os.path.join(OUT, 'favicon-32.png'))
    f16.save(os.path.join(OUT, 'favicon-16.png'))
    f32.save(os.path.join(OUT, 'favicon.ico'), sizes=[(16, 16), (32, 32)], append_images=[f16])
    badge(head, 192, round_=.5).save(os.path.join(ROOT, 'assets/sand-logo-icon.png'))   # ตราหน้า header (วงกลม)
    print('ok →', OUT)


if __name__ == '__main__':
    main()
