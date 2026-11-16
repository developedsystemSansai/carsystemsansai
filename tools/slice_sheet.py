#!/usr/bin/env python3
"""ตัดชีตแบรนด์ SAND → ไอคอน/ท่ามาสคอต/โลโก้ PNG-WebP โปร่งใส + แปลง GIF → WebP เคลื่อนไหว
ใช้: python3 tools/slice_sheet.py   (รันที่รากของ repo; ต้องมี pillow numpy opencv-python)
"""
import os, cv2, numpy as np
from PIL import Image, ImageSequence

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets/source')
OUT = os.path.join(ROOT, 'assets/sand')
sheet = cv2.cvtColor(cv2.imread(os.path.join(SRC, 'sand-sheet.webp')), cv2.COLOR_BGR2RGB)

# (key, x, top, w) — ตำแหน่งบนชีต 1536x1024 ; ไอคอนตัดสูง CROP_H (กันป้ายชื่อใต้ไอคอนหลุดเข้ามา)
ICONS = [('vehicle',707,63,182),('fuel',924,64,170),('odometer',1134,64,172),('inspect',1340,62,166),
         ('repair',718,289,166),('schedule',926,289,171),('swap',1142,289,167),('ems',1342,289,166),
         ('route',724,501,156),('report',931,501,165),('alert',1147,501,161),('settings',1349,501,158)]
CROP_H = {'fuel':160,'route':142,'report':142,'alert':142,'settings':142}
POSES = [('ok',678,725,217,234),('laptop',910,729,217,242),('idea',1128,715,187,255),('cheer',1324,715,204,255)]

def cutout(rgb, thr=244, keep_all=False, drop_box=None):
    """ลบพื้นหลังขาวที่ต่อกับขอบภาพ (flood fill) แล้วทำขอบนุ่ม 1px"""
    h, w = rgb.shape[:2]
    near_white = (rgb.min(axis=2) >= thr).astype(np.uint8)
    pad = cv2.copyMakeBorder(near_white, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    ff = np.zeros((h + 4, w + 4), np.uint8)
    flood = pad.copy() * 255
    # flood fill จากมุม บนพื้นที่ near_white เท่านั้น
    mask = (pad == 0).astype(np.uint8)
    mask = cv2.copyMakeBorder(mask, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=1)
    cv2.floodFill(flood, mask, (0, 0), 128)
    bg = (flood[1:-1, 1:-1] == 128).astype(np.uint8)
    alpha = (1 - bg) * 255
    alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 0.8)
    alpha = np.clip((alpha - 40) * 1.25, 0, 255).astype(np.uint8)
    # เก็บเฉพาะก้อนหลัก (ตัดเศษข้อความ/จุดที่หลุดมา)
    n, lab, st, _ = cv2.connectedComponentsWithStats((alpha > 20).astype(np.uint8), connectivity=8)
    if n > 1 and keep_all:   # โลโก้/ไอคอนที่ประกอบจากหลายก้อน (ตัวอักษร+ภูเขา, หมุด+แผนที่) เก็บทุกก้อนที่ไม่เล็กเกินไป
        keep = np.zeros_like(alpha)
        for i in range(1, n):
            x0, y0, bw, bh, ar = st[i]
            if drop_box and x0 >= drop_box[0] and y0 + bh <= drop_box[3] and x0 + bw <= drop_box[2]: continue
            if ar >= 120: keep[cv2.dilate((lab == i).astype(np.uint8), np.ones((5,5), np.uint8)) > 0] = 255
        alpha = np.minimum(alpha, keep)
    elif n > 1:
        big = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]); keep = np.zeros_like(alpha)
        grown = cv2.dilate((lab == big).astype(np.uint8), np.ones((5, 5), np.uint8))
        keep[grown > 0] = 255; alpha = np.minimum(alpha, keep)
    return np.dstack([rgb, alpha])

def trim(rgba, pad=4):
    ys, xs = np.where(rgba[..., 3] > 12)
    y0, y1, x0, x1 = max(ys.min()-pad,0), ys.max()+pad+1, max(xs.min()-pad,0), xs.max()+pad+1
    return rgba[y0:y1, x0:x1]

def save(im, path, **kw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, **kw); print('  ok', os.path.relpath(path, ROOT), f'{os.path.getsize(path)/1024:.1f}KB', im.size)

def square(rgba, size):
    im = Image.fromarray(trim(rgba)); s = max(im.size)
    cv = Image.new('RGBA', (s, s), (0,0,0,0)); cv.paste(im, ((s-im.width)//2, (s-im.height)//2))
    return cv.resize((size, size), Image.LANCZOS)

print('ไอคอน')
for key, x, top, w in ICONS:
    crop = sheet[top-4: top + CROP_H.get(key, 168), x-4: x+w+4]
    r = cutout(crop, keep_all=(key == 'route'))
    for size, suf in ((192, ''), (96, '-96')):
        save(square(r, size), f'{OUT}/icons/{key}{suf}.webp', quality=90, method=6)
    save(square(r, 192), f'{OUT}/icons/{key}.png', optimize=True)

print('ท่าทางมาสคอต')
for key, x, y, w, h in POSES:
    r = trim(cutout(sheet[y-8: y+h+8, x-8: x+w+8]))
    im = Image.fromarray(r); im = im.resize((round(im.width*240/im.height), 240), Image.LANCZOS)
    save(im, f'{OUT}/poses/{key}.webp', quality=90, method=6)

print('โลโก้ / ฉากหลัก')
# ลบรองเท้า/เงามาสคอตที่ซ้อนมุมบนขวาของโลโก้ (ไม่แตะตัว D ซึ่งเริ่มต่ำกว่าแถวนี้)
lg = sheet[705:1000, 10:500].copy(); lg[0:88, 349:] = 255; lg[0:115, 372:] = 255
logo = trim(cutout(lg, keep_all=True))
save(Image.fromarray(logo), f'{OUT}/logo/sand-logo.webp', quality=92, method=6)
hero = trim(cutout(sheet[10:800, 10:690], thr=246)); im = Image.fromarray(hero); im = im.resize((round(im.width*560/im.height), 560), Image.LANCZOS)
save(im, f'{OUT}/hero/hero-scene.webp', quality=88, method=6)

print('ภาพเคลื่อนไหว GIF → WebP')
def anim(src, name, width):
    g = Image.open(os.path.join(SRC, src)); frames, dur = [], []
    for f in ImageSequence.Iterator(g):
        frames.append(f.convert('RGBA')); dur.append(f.info.get('duration', 150))
    bb = None
    for f in frames:
        b = f.getbbox()
        bb = b if bb is None else (min(bb[0],b[0]),min(bb[1],b[1]),max(bb[2],b[2]),max(bb[3],b[3]))
    frames = [f.crop(bb) for f in frames]
    h = round(frames[0].height * width / frames[0].width)
    frames = [f.resize((width, h), Image.LANCZOS) for f in frames]
    save(frames[0], f'{OUT}/anim/{name}-still.webp', quality=88, method=6)          # สำหรับ prefers-reduced-motion
    save(frames[0], f'{OUT}/anim/{name}.webp', save_all=True, append_images=frames[1:], duration=dur, loop=0, quality=80, method=6)
anim('sand-wave.gif', 'wave', 300); anim('sand-loading.gif', 'loading', 200); anim('sand-alert.gif', 'alert', 200)
