#!/usr/bin/env python3
"""Создаёт иконки Android из icons/icon-512.png и icons/icon-maskable-512.png.
Запуск: python3 apk/make_icons.py <путь к android/app/src/main/res>"""
import os, sys
from PIL import Image, ImageDraw

BG = (10, 22, 40, 255)            # #0a1628 — фон иконки и заставки
FG_SCALE = 0.90                   # maskable-картинка уже содержит безопасные поля, лишнего уменьшения не нужно
res = sys.argv[1]
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
normal = Image.open(os.path.join(root, "icons", "icon-512.png")).convert("RGBA")
mask512 = Image.open(os.path.join(root, "icons", "icon-maskable-512.png")).convert("RGBA")

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPT = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

def circle(img):
    s = img.width
    m = Image.new("L", (s * 4, s * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, s * 4 - 1, s * 4 - 1), fill=255)
    m = m.resize((s, s), Image.LANCZOS)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), m)
    return out

for d in LEGACY:
    folder = os.path.join(res, f"mipmap-{d}")
    os.makedirs(folder, exist_ok=True)
    s = LEGACY[d]
    normal.resize((s, s), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
    # круглая версия для старых Android: картинка на фоне, обрезанная кругом
    base = Image.new("RGBA", (512, 512), BG)
    art = mask512.resize((int(512 * 1.3), int(512 * 1.3)), Image.LANCZOS)
    base.paste(art, ((512 - art.width) // 2, (512 - art.height) // 2), art)
    circle(base).resize((s, s), Image.LANCZOS).save(os.path.join(folder, "ic_launcher_round.png"))
    # передний план адаптивной иконки (холст 108dp, видна центральная часть ~66%)
    f = ADAPT[d]
    canvas = Image.new("RGBA", (f, f), (0, 0, 0, 0))
    inner = int(f * FG_SCALE)
    art = mask512.resize((inner, inner), Image.LANCZOS)
    canvas.paste(art, ((f - inner) // 2, (f - inner) // 2), art)
    canvas.save(os.path.join(folder, "ic_launcher_foreground.png"))

os.makedirs(os.path.join(res, "values"), exist_ok=True)
with open(os.path.join(res, "values", "ic_launcher_background.xml"), "w", encoding="utf-8") as fh:
    fh.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0a1628</color>\n</resources>\n')

# адаптивные иконки явно указывают на наши файлы (шаблон Capacitor мог ссылаться на свою векторную графику)
adaptive = ('<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@color/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n')
v26 = os.path.join(res, "mipmap-anydpi-v26")
os.makedirs(v26, exist_ok=True)
for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
    with open(os.path.join(v26, name), "w", encoding="utf-8") as fh:
        fh.write(adaptive)
print("icons ok")
