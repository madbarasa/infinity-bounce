import math
import os
import shutil
import subprocess

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
ICONS = os.path.join(ASSETS, "icons")
TMP = os.path.join(ASSETS, "_gen_assets_tmp")

W, H = 1536, 1024
SS = 4
SIZE = 128
WHITE = 255
TRANSPARENT = 0


def generate_background():
    # 垂直渐变底
    top = np.array([5.0, 7.0, 15.0], dtype=np.float32)
    bottom = np.array([18.0, 18.0, 42.0], dtype=np.float32)
    t = np.linspace(0.0, 1.0, H, dtype=np.float32)[:, None, None]
    arr = np.repeat(top[None, None, :] + (bottom - top)[None, None, :] * t,
                    W, axis=1).astype(np.float32)

    # 柔和光晕，加色混合
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    glows = [
        (360.0, 300.0, 420.0, (0.0, 245.0, 212.0), 0.20),
        (1180.0, 760.0, 470.0, (155.0, 93.0, 229.0), 0.18),
        (980.0, 220.0, 360.0, (0.0, 200.0, 190.0), 0.09),
    ]
    for gx, gy, radius, color, strength in glows:
        d2 = (xx - gx) ** 2 + (yy - gy) ** 2
        falloff = np.exp(-d2 / (2.0 * (radius * 0.55) ** 2)).astype(np.float32)
        falloff *= np.clip(1.0 - np.sqrt(d2) / (radius * 1.8), 0.0, 1.0)
        for c in range(3):
            arr[:, :, c] += color[c] * strength * falloff

    # 极轻噪点
    rng = np.random.default_rng(20261115)
    arr += rng.normal(0.0, 1.15, (H, W, 1)).astype(np.float32)
    np.clip(arr, 0, 255, out=arr)
    img = Image.fromarray(arr.astype(np.uint8), "RGB")

    # 几何砖块网格，低对比青紫细线
    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    tw, th = 128, 64
    for row, y in enumerate(range(0, H + th, th)):
        offset = 0 if row % 2 == 0 else tw // 2
        if y < H:
            gd.line([(0, y), (W, y)], fill=(96, 118, 170, 26), width=1)
        for x in range(-tw + offset, W + tw, tw):
            if 0 <= x <= W:
                gd.line([(x, y), (x, min(y + th, H))],
                        fill=(140, 104, 196, 20), width=1)
    img = Image.alpha_composite(img.convert("RGBA"), grid)

    # 稀疏光点粒子
    dots = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for _ in range(150):
        px = float(rng.uniform(0, W))
        py = float(rng.uniform(0, H))
        pr = float(rng.choice([0.7, 0.9, 1.2, 1.6, 2.1]))
        alpha = int(rng.integers(30, 115))
        color = (170, 230, 255, alpha) if rng.random() < 0.55 else (190, 160, 255, alpha)
        dd.ellipse((px - pr, py - pr, px + pr, py + pr), fill=color)
    img = Image.alpha_composite(img, dots.filter(ImageFilter.GaussianBlur(0.6)))
    rgb = img.convert("RGB")
    rgb.save(os.path.join(ASSETS, "bg.webp"), "WEBP", quality=88, method=6)


def new_canvas():
    img = Image.new("L", (SIZE * SS, SIZE * SS), TRANSPARENT)
    return img, ImageDraw.Draw(img)


def scaled(bbox):
    return tuple(int(round(v * SS)) for v in bbox)


def polygon(draw, points, value=WHITE):
    draw.polygon([(x * SS, y * SS) for x, y in points], fill=value)


def ellipse(draw, bbox, value=WHITE):
    draw.ellipse(scaled(bbox), fill=value)


def rect(draw, bbox, radius=0, value=WHITE):
    if radius:
        draw.rounded_rectangle(scaled(bbox), radius=radius * SS, fill=value)
    else:
        draw.rectangle(scaled(bbox), fill=value)


def rounded_line(draw, p1, p2, width, value=WHITE):
    # 粗圆角线：矩形线段加两端圆帽
    r = width / 2.0
    x1, y1 = p1
    x2, y2 = p2
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length:
        nx, ny = -dy / length * r, dx / length * r
        polygon(draw, [(x1 + nx, y1 + ny), (x2 + nx, y2 + ny),
                       (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)], value)
    for cx, cy in (p1, p2):
        polygon(draw, [(cx + r * math.cos(2 * math.pi * i / 24),
                        cy + r * math.sin(2 * math.pi * i / 24))
                       for i in range(24)], value)


def arc_band(draw, bbox, start_deg, end_deg, width, step_deg=4, value=WHITE):
    # 粗圆弧：内外椭圆弧围成的带状多边形，两端补圆帽
    cx = (bbox[0] + bbox[2]) / 2.0
    cy = (bbox[1] + bbox[3]) / 2.0
    rx = (bbox[2] - bbox[0]) / 2.0
    ry = (bbox[3] - bbox[1]) / 2.0
    half = width / 2.0
    n = max(12, int(abs(end_deg - start_deg) / step_deg))
    angles = [math.radians(start_deg + (end_deg - start_deg) * i / n)
              for i in range(n + 1)]
    outer = [(cx + (rx + half) * math.cos(a), cy + (ry + half) * math.sin(a))
             for a in angles]
    inner = [(cx + (rx - half) * math.cos(a), cy + (ry - half) * math.sin(a))
             for a in reversed(angles)]
    polygon(draw, outer + inner, value)
    for a in (angles[0], angles[-1]):
        px, py = cx + rx * math.cos(a), cy + ry * math.sin(a)
        polygon(draw, [(px + half * math.cos(2 * math.pi * k / 20),
                        py + half * math.sin(2 * math.pi * k / 20))
                       for k in range(20)], value)


def ring(draw, bbox, width):
    ellipse(draw, bbox, WHITE)
    ellipse(draw, (bbox[0] + width, bbox[1] + width,
                   bbox[2] - width, bbox[3] - width), TRANSPARENT)


def hole(draw, bbox):
    ellipse(draw, bbox, TRANSPARENT)


def icon_settings():
    img, d = new_canvas()
    cx, cy = 64, 64
    ellipse(d, (35, 35, 93, 93))
    for i in range(8):
        a = 2 * math.pi * i / 8
        half_in = math.radians(12)
        half_out = math.radians(8)
        rin, rout = 24, 38
        polygon(d, [
            (cx + rin * math.cos(a - half_in), cy + rin * math.sin(a - half_in)),
            (cx + rout * math.cos(a - half_out), cy + rout * math.sin(a - half_out)),
            (cx + rout * math.cos(a + half_out), cy + rout * math.sin(a + half_out)),
            (cx + rin * math.cos(a + half_in), cy + rin * math.sin(a + half_in)),
        ])
    # 中心镂空圆，留出粗圆环
    hole(d, (50, 50, 78, 78))
    return img


def icon_back():
    img, d = new_canvas()
    polygon(d, [(30, 64), (61, 35), (61, 93)])
    rect(d, (57, 55, 98, 73), radius=4)
    return img


def icon_help():
    img, d = new_canvas()
    ring(d, (26, 26, 102, 102), 8)
    # 问号：圆弧、斜接、竖笔与圆点，全部几何绘制
    arc_band(d, (48, 41, 80, 69), 195, 350, 8, step_deg=4)
    rounded_line(d, (75, 53), (64, 66), 8)
    rect(d, (59, 64, 69, 76), radius=2)
    ellipse(d, (58, 82, 70, 94))
    return img


def icon_close():
    img, d = new_canvas()
    rounded_line(d, (38, 38), (90, 90), 13)
    rounded_line(d, (90, 38), (38, 90), 13)
    return img


def icon_sound():
    img, d = new_canvas()
    rect(d, (28, 54, 44, 74), radius=2)
    polygon(d, [(44, 54), (66, 36), (66, 92), (44, 74)])
    arc_band(d, (70, 48, 90, 80), -62, 62, 6, step_deg=3)
    arc_band(d, (76, 38, 100, 90), -60, 60, 6, step_deg=3)
    return img


def icon_vibrate():
    img, d = new_canvas()
    d.rounded_rectangle(scaled((48, 28, 80, 100)), radius=8 * SS,
                        outline=WHITE, width=5 * SS)
    rect(d, (58, 34, 70, 38), radius=2)
    arc_band(d, (32, 46, 42, 82), 125, 235, 5, step_deg=6)
    arc_band(d, (27, 40, 38, 88), 125, 235, 5, step_deg=6)
    arc_band(d, (86, 46, 96, 82), -55, 55, 5, step_deg=6)
    arc_band(d, (90, 40, 101, 88), -55, 55, 5, step_deg=6)
    return img


def semicircle(draw, cx, top_y, radius, value=WHITE):
    # 半圆形肩部：上方平直、下方半圆
    pts = [(cx - radius, top_y), (cx + radius, top_y)]
    pts += [(cx + radius * math.cos(math.pi * i / 24),
             top_y + radius * math.sin(math.pi * i / 24))
            for i in range(25)]
    polygon(draw, pts, value)


def icon_credits():
    img, d = new_canvas()
    ellipse(d, (45, 33, 63, 51))
    semicircle(d, 54, 57, 22)
    ellipse(d, (72, 40, 86, 54))
    semicircle(d, 79, 62, 18)
    return img


def icon_pause():
    img, d = new_canvas()
    rect(d, (40, 32, 55, 96), radius=3)
    rect(d, (73, 32, 88, 96), radius=3)
    return img


def icon_play():
    img, d = new_canvas()
    polygon(d, [(44, 32), (44, 96), (96, 64)])
    return img


def icon_restart():
    img, d = new_canvas()
    arc_band(d, (32, 32, 96, 96), 305, -30, 10, step_deg=4)
    # 顺时针箭头头部，位于圆弧终点右上方
    a = math.radians(-30)
    cx, cy, r = 64, 64, 32
    tx, ty = cx + r * math.cos(a), cy + r * math.sin(a)
    tang = a + math.pi / 2
    nx, ny = math.cos(tang), math.sin(tang)
    px, py = -ny, nx
    polygon(d, [
        (tx + px * 13, ty + py * 13),
        (tx - px * 13, ty - py * 13),
        (tx + nx * 16, ty + ny * 16),
    ])
    return img


ICON_FUNCS = {
    "settings": icon_settings,
    "back": icon_back,
    "help": icon_help,
    "close": icon_close,
    "sound": icon_sound,
    "vibrate": icon_vibrate,
    "credits": icon_credits,
    "pause": icon_pause,
    "play": icon_play,
    "restart": icon_restart,
}


def generate_icons():
    for name, func in ICON_FUNCS.items():
        mask = func().resize((SIZE, SIZE), Image.LANCZOS)
        alpha = np.array(mask, dtype=np.uint8)
        # 清除 LANCZOS 远端振铃，保证背景 alpha 恒为 0
        alpha[alpha < 4] = 0
        rgb = np.full((SIZE, SIZE, 3), 255, dtype=np.uint8)
        rgb[alpha == 0] = 0
        out = Image.fromarray(np.dstack((rgb, alpha)), "RGBA")
        out.save(os.path.join(ICONS, name + ".png"), "PNG")


BADGE_URL = ("https://img.shields.io/badge/powered_by-dsh-4D6BFE"
             "?style=flat-square&logo=deepseek&logoColor=white")
BADGE_PNG_URL = ("https://img.shields.io/badge/powered_by-dsh-4D6BFE.png"
                 "?style=flat-square&logo=deepseek&logoColor=white")


def is_png(path):
    with open(path, "rb") as f:
        return f.read(8) == b"\x89PNG\r\n\x1a\n"


def download_badge():
    tmp_png = os.path.join(TMP, "badge.png")
    # 指定地址、官方 PNG 栅格地址、指定地址重试一次
    for url in (BADGE_URL, BADGE_PNG_URL, BADGE_URL):
        subprocess.run(
            ["curl", "-sSL", "--max-time", "30", "-o", tmp_png, url],
            check=True,
        )
        if is_png(tmp_png):
            with Image.open(tmp_png) as im:
                im.load()
            shutil.copyfile(tmp_png, os.path.join(ICONS, "powered-by-dsh.png"))
            os.remove(tmp_png)
            return
        os.remove(tmp_png)
    raise RuntimeError("shields.io 未返回合法 PNG 徽章")


def badge_report():
    path = os.path.join(ICONS, "powered-by-dsh.png")
    with Image.open(path) as im:
        im.load()
        print("badge: powered-by-dsh.png size=%s mode=%s" % (im.size, im.mode))


def verify():
    webp = os.path.join(ASSETS, "bg.webp")
    with Image.open(webp) as im:
        im.load()
        assert im.size == (W, H), "bg.webp"
        print("verify: bg.webp size=%s mode=%s bytes=%s" % (im.size, im.mode, os.path.getsize(webp)))
    paths = [os.path.join(ICONS, name + ".png") for name in ICON_FUNCS]
    for path in paths:
        with Image.open(path) as im:
            im.load()
            arr = np.array(im)
            name = os.path.basename(path)
            assert im.size == (SIZE, SIZE), name
            assert im.mode == "RGBA", name
            alpha = arr[:, :, 3]
            rgb = arr[:, :, :3]
            white = rgb[alpha == 255]
            assert alpha.min() == 0 and alpha.max() == 255, name
            assert np.all(white == 255), name
            ys, xs = np.where(alpha > 0)
            box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
            # 四周保留 20px 以上内边距
            assert box[0] >= 20 and box[1] >= 20 and \
                box[2] <= 107 and box[3] <= 107, (name, box)
            print("verify: %s size=%s mode=%s alpha_min=%s alpha_max=%s "
                  "rgb_on_opaque_min=%s rgb_on_opaque_max=%s bbox=%s" % (
                      name, im.size, im.mode, alpha.min(), alpha.max(),
                      white.min(), white.max(), box))


def main():
    os.makedirs(ICONS, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    try:
        generate_background()
        generate_icons()
        download_badge()
        badge_report()
        verify()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
