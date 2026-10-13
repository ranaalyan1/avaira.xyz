#!/usr/bin/env python3
"""Draw AVAIRA's animated pixel plates frame by frame.

The site's art is pixel art on black in two hues, so it can be drawn exactly
instead of approximated: this script paints every frame into a small RGB buffer
and hands the sequence to ImageMagick, which maps it onto the locked palette and
writes both an animated GIF and the static PNG poster that ships in the markup.

Everything here is deterministic (seeded), so re-running the script reproduces
the committed art byte for byte.

Output (frontend/public/art/):
    hero.gif       corridor loop, the card walking the four planes  (home, gate)
    gauge.gif      Avaira Score needle sweeping to 87.4            (score)
    vault.gif      bonded plates stacking, particles rising        (clear)
    network.gif    lattice with pulses travelling the links        (insure)
    ledger.gif     ledger writing row after row                    (evidence)
    burn.gif       slashed collateral burning down                 (penalty)
plus the matching *.png poster for each scene.

Usage:  python3 scripts/pixel_scenes.py
"""

import math
import os
import random
import subprocess
import sys
import tempfile

# The palette is the design system's, in index order. Index 0 is the ground and
# index 6 is the only highlight; nothing else may appear in a frame.
BLACK, DEEP, PANEL, IND_DIM, IND_MID, ACCENT, HI, RED = range(8)
PALETTE = [
    (0x00, 0x00, 0x00),  # 0 black   ground, art bands
    (0x05, 0x06, 0x0A),  # 1 deep    page background
    (0x0B, 0x0D, 0x12),  # 2 panel   slabs
    (0x2A, 0x28, 0x70),  # 3 indigo  far geometry
    (0x4A, 0x48, 0xB8),  # 4 indigo  mid geometry
    (0x6E, 0x6B, 0xF2),  # 5 accent  close geometry
    (0xC9, 0xC7, 0xFF),  # 6 hi      lit pixel
    (0xF4, 0x5B, 0x69),  # 7 red     refused, slashed
]

# 4x4 ordered dither. Dithering is how this art gets its in-between tones: a
# blend is a pattern, never a third colour.
BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]


def dim(c, steps=1):
    """Walk a colour down the palette — the only fade this art allows."""
    for _ in range(steps):
        if c in (BLACK, DEEP, PANEL):
            c = BLACK
        elif c == RED:
            c = ACCENT
        else:
            c -= 1
    return c


class Canvas:
    def __init__(self, w, h, bg=BLACK):
        self.w, self.h = w, h
        self.px = [[bg] * w for _ in range(h)]

    def put(self, x, y, c):
        x, y = int(x), int(y)
        if 0 <= x < self.w and 0 <= y < self.h:
            self.px[y][x] = c

    def rect(self, x0, y0, x1, y1, c, thick=1):
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        for t in range(thick):
            self.hline(x0, x1, y0 + t, c)
            self.hline(x0, x1, y1 - t, c)
            self.vline(x0 + t, y0, y1, c)
            self.vline(x1 - t, y0, y1, c)

    def fill(self, x0, y0, x1, y1, c):
        xs, ys = sorted((int(x0), int(x1))), sorted((int(y0), int(y1)))
        for y in range(max(0, ys[0]), min(self.h, ys[1] + 1)):
            row = self.px[y]
            for x in range(max(0, xs[0]), min(self.w, xs[1] + 1)):
                row[x] = c

    def hline(self, x0, x1, y, c):
        y = int(y)
        if 0 <= y < self.h:
            for x in range(max(0, int(min(x0, x1))), min(self.w, int(max(x0, x1)) + 1)):
                self.px[y][x] = c

    def vline(self, x, y0, y1, c):
        x = int(x)
        if 0 <= x < self.w:
            for y in range(max(0, int(min(y0, y1))), min(self.h, int(max(y0, y1)) + 1)):
                self.px[y][x] = c

    def line(self, x0, y0, x1, y1, c, thick=1):
        steps = int(max(abs(x1 - x0), abs(y1 - y0))) + 1
        for i in range(steps + 1):
            t = i / steps
            for o in range(thick):
                self.put(round(x0 + (x1 - x0) * t) + o, round(y0 + (y1 - y0) * t), c)

    def dither(self, x0, y0, x1, y1, c, density, phase=0):
        """Fill a rect with `c` at `density` (0..1) using the 4x4 ordered grid."""
        xs, ys = sorted((int(x0), int(x1))), sorted((int(y0), int(y1)))
        level = density * 16
        for y in range(max(0, ys[0]), min(self.h, ys[1] + 1)):
            for x in range(max(0, xs[0]), min(self.w, xs[1] + 1)):
                if BAYER[(y + phase) % 4][(x + phase) % 4] < level:
                    self.px[y][x] = c

    def disc(self, cx, cy, r, c, density=1.0):
        for y in range(int(cy - r), int(cy + r) + 1):
            for x in range(int(cx - r), int(cx + r) + 1):
                d = math.hypot(x - cx, y - cy)
                if d <= r and (density >= 1 or BAYER[y % 4][x % 4] < density * 16):
                    self.put(x, y, c)

    def ring(self, cx, cy, r, c, density=1.0):
        for y in range(int(cy - r - 1), int(cy + r) + 2):
            for x in range(int(cx - r - 1), int(cx + r) + 2):
                d = math.hypot(x - cx, y - cy)
                if r - 0.9 <= d <= r + 0.9 and (density >= 1 or BAYER[y % 4][x % 4] < density * 16):
                    self.put(x, y, c)

    def fade(self, steps):
        for y in range(self.h):
            row = self.px[y]
            for x in range(self.w):
                row[x] = dim(row[x], steps)

    def to_ppm(self, path):
        buf = bytearray()
        buf += b"P6 %d %d 255\n" % (self.w, self.h)
        for y in range(self.h):
            row = self.px[y]
            for x in range(self.w):
                buf += bytes(PALETTE[row[x]])
        with open(path, "wb") as fh:
            fh.write(buf)


def ease_out(u):
    return 1 - (1 - u) ** 3


def hold_loop(frames, fade=3, hold=0):
    """Build a frame timeline where the last `fade` frames dim to black and the
    first `fade` frames come back up, so the GIF loops without a cut."""
    return frames, fade


# --------------------------------------------------------------------------- #
# 01 · hero video · the corridor, one card walking the planes
# --------------------------------------------------------------------------- #
def scene_corridor(W=320, H=180, frames=32):
    vpx, vpy = W / 2, H * 0.47
    gates = [0.10, 0.27, 0.46, 0.67, 0.90, 1.16]
    rng = random.Random(7)
    dust = [(rng.random(), rng.random(), rng.uniform(0.6, 1.6), rng.uniform(0.2, 1.0))
            for _ in range(26)]

    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)

        # The ground is never flat black: a dithered glow sits behind the
        # vanishing point so the corridor reads as depth, not as a frame.
        cv.disc(vpx, vpy, H * 0.34, DEEP, density=1.0)
        cv.ring(vpx, vpy, H * 0.30, IND_DIM, density=0.35)
        cv.ring(vpx, vpy, H * 0.22, IND_DIM, density=0.18)

        # Floor and ceiling are the corridor's own walls, not a starburst: the
        # outer gate sets the width, the tone rises toward the viewer and only a
        # few seams converge on the vanishing point.
        outer = gates[-1] ** 1.45
        fw, fh = W * 0.42 * outer, H * 0.40 * outer
        for y in range(int(vpy), H):
            t = (y - vpy) / (H - vpy)
            cv.dither(vpx - fw, y, vpx + fw, y, IND_DIM, 0.10 + t * 0.34, phase=y % 4)
        for y in range(0, int(vpy)):
            t = (vpy - y) / vpy
            cv.dither(vpx - fw, y, vpx + fw, y, IND_DIM, 0.06 + t * 0.20, phase=y % 4)
        for k in range(-4, 5):
            ex = vpx + k * (fw / 4.0)
            cv.line(vpx + k * (fw / 22.0), vpy, ex, H if abs(k) > 0 else H,
                    IND_DIM if abs(k) % 2 else IND_MID)
            cv.line(vpx + k * (fw / 26.0), vpy, vpx + k * (fw / 2.1), 0, IND_DIM)

        # the card, travelling from the far plane to the near one
        z = 0.06 + (u ** 1.6) * 1.02
        s = z ** 1.45

        # gates, far to near, so the near ones overwrite the far ones
        for g in gates:
            gs = g ** 1.45
            hw, hh = W * 0.42 * gs, H * 0.40 * gs
            x0, y0, x1, y1 = vpx - hw, vpy - hh, vpx + hw, vpy + hh
            base = IND_DIM if g < 0.32 else (IND_MID if g < 0.72 else ACCENT)
            passed = z > g
            # a gate lights while the card is inside it, and stays warm after
            near = abs(z - g) < 0.09
            col = HI if near else (ACCENT if passed else base)
            cv.rect(x0, y0, x1, y1, col, thick=1 if g < 0.5 else 2)
            if near:
                cv.rect(x0 - 3, y0 - 3, x1 + 3, y1 + 3, ACCENT, thick=1)
                cv.dither(int(x0), int(y0), int(x1), int(y1), ACCENT, 0.05)

        # light pool on the floor under the card
        pool = vpy + H * 0.36 * s
        cv.dither(int(vpx - W * 0.3 * s), int(pool), int(vpx + W * 0.3 * s), int(pool + H * 0.06 * s),
                  ACCENT, 0.30)

        # the card itself: a lit plate with a two-step halo
        chw, chh = W * 0.030 * s + 1, H * 0.050 * s + 1
        cv.dither(int(vpx - chw * 2.4), int(vpy - chh * 2.4), int(vpx + chw * 2.4), int(vpy + chh * 2.4),
                  ACCENT, 0.34)
        cv.rect(vpx - chw * 1.9, vpy - chh * 1.9, vpx + chw * 1.9, vpy + chh * 1.9, ACCENT)
        cv.fill(vpx - chw, vpy - chh, vpx + chw, vpy + chh, HI)
        cv.put(vpx, vpy, ACCENT)
        cv.put(vpx - 1, vpy, ACCENT)

        # dust, drifting toward the viewer at its own depth
        for (px, py, sp, ph) in dust:
            dz = (ph + u * sp * 1.4) % 1.0
            ds = dz ** 1.45
            if ds < 0.12:
                continue
            x = vpx + (px - 0.5) * W * 0.9 * ds
            y = vpy + (py - 0.5) * H * 0.85 * ds
            cv.put(x, y, HI if dz > 0.75 else (ACCENT if dz > 0.4 else IND_MID))

        out.append(cv)

    # fade the tail and the head so the loop has no seam
    for i in range(3):
        out[i].fade(3 - i)
        out[-1 - i].fade(i + 1)
    return out


# --------------------------------------------------------------------------- #
# 02 · score · the needle sweeping to the recorded 87.4
# --------------------------------------------------------------------------- #
def scene_gauge(W=256, H=256, frames=30, value=0.874):
    cx, cy = W / 2, H * 0.54
    r = W * 0.37
    a0, a1 = -210.0, 30.0

    def pt(a_deg, rad):
        a = math.radians(a_deg)
        return cx + math.cos(a) * rad, cy + math.sin(a) * rad

    out = []
    for f in range(frames):
        u = f / frames
        if u < 0.62:                      # sweep to the value, over-then-settle
            p = ease_out(u / 0.62) * value
            p += math.sin(min(1.0, u / 0.62) * math.pi) * 0.035
        elif u < 0.86:                    # hold
            p = value
        else:                             # fall back for the next loop
            p = value * (1 - (u - 0.86) / 0.14)

        cv = Canvas(W, H)
        cv.dither(int(cx - r * 0.88), int(cy - r * 0.88), int(cx + r * 0.88), int(cy + r * 0.88),
                  DEEP, 0.55)

        # the track, then the part of it the score has claimed
        steps = int((a1 - a0) * 2)
        for i in range(steps + 1):
            a = a0 + (a1 - a0) * i / steps
            frac = i / steps
            x, y = pt(a, r)
            cv.put(x, y, IND_MID)                       # track: a hairline
            if frac <= p:                               # fill: a band, with a
                for off in (1, 2, 3):                   # lit leading edge
                    fx, fy = pt(a, r - off)
                    cv.put(fx, fy, HI if frac > p - 0.035 and off < 3 else ACCENT)
            if i % 40 == 0:               # a tick every 20 degrees, no more
                tx, ty = pt(a, r + 5)
                cv.line(x, y, tx, ty, IND_MID)
                cv.put(tx + (1 if tx > cx else -1), ty, IND_MID)

        # the leading edge of the fill gets a nub, so progress is legible even
        # when the needle is between ticks
        lead = a0 + (a1 - a0) * p
        lx, ly = pt(lead, r - 2)
        cv.disc(lx, ly, 2.4, HI)

        # needle
        na = a0 + (a1 - a0) * p
        nx, ny = pt(na, r - 4)
        cv.line(cx, cy, nx, ny, HI, thick=2)
        cv.disc(cx, cy, 6, ACCENT)
        cv.disc(cx, cy, 3, HI)
        cv.put(cx, cy, BLACK)

        out.append(cv)
    for i in range(2):
        out[i].fade(2 - i)
        out[-1 - i].fade(i + 1)
    return out


# --------------------------------------------------------------------------- #
# 03 · clear · bonded plates stacking, particles rising
# --------------------------------------------------------------------------- #
def scene_vault(W=288, H=160, frames=36, plates=4):
    base_y = H - 26
    sway = lambda i: (i % 2) * 2 - 1
    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        cv.dither(0, base_y + 12, W, H, IND_DIM, 0.26)
        cv.hline(W * 0.10, W * 0.90, base_y + 11, IND_MID)
        cv.dither(W * 0.10, base_y + 12, W * 0.90, base_y + 15, IND_DIM, 0.7)

        # plate i lands between u=0.06+i*0.14 and +0.10, sliding in from its side
        for i in range(plates):
            t0 = 0.05 + i * 0.13
            t = min(1.0, max(0.0, (u - t0) / 0.11))
            if t <= 0:
                continue
            e = ease_out(t)
            y1 = base_y - i * 18
            y0 = y1 - 14
            w = W * 0.46
            x0 = W / 2 - w / 2 + 12
            off = (1 - e) * (W * 0.72) * sway(i)
            # a plate is solid metal: dithered body, hard top edge, engraved
            # seams, and a shadow it casts on the plate below
            cv.dither(x0 + off, y0 + 3, x0 + w + off, y1, IND_MID, 0.40)
            cv.dither(x0 + off, y0 + 9, x0 + w + off, y1, IND_MID, 0.20)
            cv.dither(x0 + off, y0 + 2, x0 + w + off, y0 + 2, ACCENT, 0.9)
            cv.rect(x0 + off, y0, x0 + w + off, y1, ACCENT if t < 1 else IND_MID)
            cv.hline(x0 + off + 2, x0 + w + off - 2, y0 + 1, HI)
            cv.hline(x0 + off + 6, x0 + w + off - 6, y0 + 6, IND_MID)
            cv.hline(x0 + off + 6, x0 + w * 0.4 + off, y0 + 10, IND_MID)
            cv.dither(x0 + off + 2, y1 + 1, x0 + w + off + 2, y1 + 3, BLACK, 1.0)

        # a highlight rises through the finished stack, then the loop restarts
        sweep = max(0.0, (u - 0.62) / 0.30)
        if 0 < sweep < 1.05:
            sy = base_y - sweep * (plates * 17)
            cv.hline(W * 0.16, W * 0.84, sy, HI)

        # particles: periodic in the loop, and each one leaves a short trail so
        # the field reads as rising dust rather than random stars
        rng = random.Random(11)
        for _ in range(14):
            px = rng.uniform(0.10, 0.90)
            ph = rng.random()
            sp = rng.choice((1, 1, 2))
            h = (ph + u * sp) % 1.0
            y = base_y - h * (H * 0.88)
            x = W * px + math.sin((h + ph) * 6.28) * 3
            cv.put(x, y, HI if h > 0.7 else ACCENT)
            cv.put(x, y + 2, ACCENT)
            cv.put(x, y + 4, IND_MID)

        out.append(cv)
    for i in range(2):
        out[i].fade(2 - i)
        out[-1 - i].fade(i + 1)
    return out


# --------------------------------------------------------------------------- #
# 04 · insure · lattice with pulses travelling the links
# --------------------------------------------------------------------------- #
def scene_network(W=288, H=160, frames=40, cycles=2):
    rng = random.Random(23)
    nodes = []
    for gy in range(3):
        for gx in range(5):
            nodes.append((W * 0.12 + gx * W * 0.19 + rng.uniform(-7, 7),
                          H * 0.22 + gy * H * 0.28 + rng.uniform(-7, 7)))
    links = []
    for i, (ax, ay) in enumerate(nodes):
        for j, (bx, by) in enumerate(nodes):
            if j <= i:
                continue
            d = math.hypot(ax - bx, ay - by)
            if d < W * 0.235 and rng.random() < 0.75:
                links.append((i, j))

    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        for (i, j) in links:
            ax, ay = nodes[i]
            bx, by = nodes[j]
            cv.line(ax, ay, bx, by, IND_DIM)
        # one pulse per link, offset by the link's own seed, integer cycles per
        # loop so the last frame lands exactly on the first
        for (i, j) in links:
            ax, ay = nodes[i]
            bx, by = nodes[j]
            off = (i * 7 + j * 3) % frames / frames
            t = ((u + off) * cycles) % 1.0
            x = ax + (bx - ax) * t
            y = ay + (by - ay) * t
            cv.put(x, y, HI)
            cv.put(x + 1, y, ACCENT)
        # nodes light when a pulse is leaving or arriving
        for i, (x, y) in enumerate(nodes):
            phase = ((u + (i % 5) / 5.0) * cycles) % 1.0
            lit = phase < 0.12 or phase > 0.88
            cv.disc(x, y, 4.5, HI if lit else ACCENT)
            cv.put(x, y, BLACK if lit else HI)
            if lit:
                cv.ring(x, y, 7, ACCENT, density=0.5)
        out.append(cv)
    return out


# --------------------------------------------------------------------------- #
# 05 · evidence · the ledger writing itself
# --------------------------------------------------------------------------- #
def scene_ledger(W=288, H=160, frames=36, rows=7):
    rng = random.Random(31)
    widths = [rng.uniform(0.30, 0.72) for _ in range(rows)]
    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        cv.rect(10, 10, W - 11, H - 11, IND_DIM)
        cv.hline(10, W - 11, 26, IND_MID)

        head = u * (rows + 1)
        for r in range(rows):
            y = 36 + r * 17
            written = r < head
            just = head - 1 < r < head + 0.6
            ink = HI if just else (ACCENT if written else IND_DIM)
            cv.fill(20, y, 20 + (W - 40) * 0.10, y + 3, ink)                     # key
            cv.fill(20 + (W - 40) * 0.14, y,
                    20 + (W - 40) * (0.14 + widths[r] * 0.6), y + 3,
                    ink if written else IND_DIM)                                  # value
            cv.fill(W - 44, y, W - 26, y + 3, ACCENT if written else IND_DIM)     # state
            cv.fill(20, y + 1, 20 + (W - 40) * 0.06, y + 2, IND_MID)
            if just:
                cv.hline(14, W - 15, y - 4, ACCENT)
        # the write head
        hy = 36 + min(head, rows) * 17
        cv.dither(14, hy - 8, W - 15, hy + 4, ACCENT, 0.22)
        cv.hline(14, W - 15, hy + 5, HI)
        # stacked pages behind the sheet
        cv.hline(16, W - 17, H - 6, IND_DIM)
        cv.hline(20, W - 21, H - 4, IND_DIM)
        out.append(cv)
    for i in range(2):
        out[i].fade(2 - i)
        out[-1 - i].fade(i + 1)
    return out


# --------------------------------------------------------------------------- #
# 06 · penalty · slashed collateral burning down
# --------------------------------------------------------------------------- #
def scene_burn(W=192, H=288, frames=32):
    rng = random.Random(43)
    out = []
    base_y = H - 54
    stack = 4
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        # the bond, one plate per unit of collateral
        for i in range(stack):
            y1 = base_y - i * 18
            cv.dither(W * 0.18, y1 - 13, W * 0.82, y1, IND_MID, 0.38)
            cv.dither(W * 0.18, y1 - 5, W * 0.82, y1, IND_MID, 0.20)
            cv.rect(W * 0.18, y1 - 13, W * 0.82, y1, IND_MID)
            cv.hline(W * 0.20, W * 0.80, y1 - 12, ACCENT)
        cv.dither(0, base_y + 8, W, H, IND_DIM, 0.24)

        # flame: a plume, not confetti — the body is a dithered cone whose
        # half-width shrinks with height, and the flicker is a phase offset
        top = base_y - stack * 18
        H_plume = H * 0.42
        for row in range(int(H_plume)):
            y = top - row
            t = row / H_plume
            # the envelope wanders on two frequencies and the edge is roughened
            # per row, so the plume reads as tongues rather than a cone
            waver = math.sin(u * 6.283 * 2 + t * 5.1) * (3 + t * 9)
            waver += math.sin(t * 17.0 + u * 3.1) * (1.5 + t * 3.5)
            half = (W * 0.17) * (1 - t) ** 0.62 * (1 + 0.22 * math.sin(t * 9.4 + u * 6.283))
            half = max(0.0, half + math.sin(t * 23.0) * 1.6)
            for k in range(-int(half) - 1, int(half) + 2):
                if abs(k) > half + 0.6:
                    continue
                x = W * 0.5 + k + waver
                inner = abs(k) / max(1.0, half)
                core = 1 - inner * 0.95
                dens = core * (1 - t * 0.85)
                dens += math.sin((row * 0.9) + u * 12.56) * 0.10
                if t > 0.55:                      # the top breaks into pieces
                    dens -= (t - 0.55) * 0.9 * (0.5 + 0.5 * math.sin(row * 2.7))
                col = HI if t < 0.10 and inner < 0.5 else (ACCENT if t < 0.40 else IND_MID)
                if dens > 0 and BAYER[int(y) % 4][int(x) % 4] < dens * 16:
                    cv.put(x, y, col)
        # embers above the plume
        for i in range(16):
            ph = rng.random()
            h = (ph + u * rng.choice((1, 2))) % 1.0
            cv.put(W * rng.uniform(0.3, 0.7) + math.sin(h * 6.28) * 6,
                   top - H_plume - h * (H * 0.16),
                   HI if h < 0.3 else IND_MID)

        # the slash: a short red bar that falls, bites into the top plate and
        # dissolves — the burn is the point, not the stripe
        sy = top - 30 + u * (base_y - top + 40)
        w = W * 0.34
        cv.hline(W * 0.5 - w / 2, W * 0.5 + w / 2, sy, RED)
        cv.hline(W * 0.5 - w / 2 + 4, W * 0.5 + w / 2 - 4, sy + 1, RED)
        cv.dither(W * 0.5 - w / 2, sy + 2, W * 0.5 + w / 2, sy + 5, RED, 0.30)
        cv.dither(W * 0.5 - w * 0.7, sy - 4, W * 0.5 + w * 0.7, sy - 1, RED, 0.12)
        out.append(cv)
    for i in range(2):
        out[i].fade(2 - i)
        out[-1 - i].fade(i + 1)
    return out


# --------------------------------------------------------------------------- #
# 07 · permit · a single-use permit being signed and sealed
# --------------------------------------------------------------------------- #
def scene_permit(W=288, H=160, frames=32):
    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        x0, y0, x1, y1 = W * 0.14, H * 0.16, W * 0.86, H * 0.84
        cv.fill(x0, y0, x1, y1, PANEL)
        cv.rect(x0, y0, x1, y1, ACCENT)
        cv.hline(x0 + 2, x1 - 2, y0 + 1, IND_MID)
        # header rule and the fields, drawn as bars
        cv.fill(x0 + 14, y0 + 14, x0 + 14 + W * 0.20, y0 + 17, HI)
        for i in range(3):
            cv.fill(x0 + 14, y0 + 36 + i * 15, x0 + 14 + W * (0.34 - i * 0.05), y0 + 38 + i * 15, IND_MID)
        # the signature draws itself left to right
        sig = min(1.0, u / 0.45)
        cv.line(x0 + 14, y1 - 30, x0 + 14 + (W * 0.34) * sig, y1 - 30, HI, thick=2)
        if sig >= 1:
            cv.hline(x0 + 14, x0 + 14 + W * 0.34, y1 - 24, IND_DIM)
        # the seal is part of the permit from the first frame — it lands early
        # and then only breathes, so the plate never reads as an empty circle
        drop = min(1.0, max(0.0, u / 0.22))
        scx, scy = x1 - 52, y1 - 48
        r = 21
        sy = scy - (1 - ease_out(drop)) * 34
        breathe = int((math.sin(u * 6.283 * 2) + 1) * 1.5)
        cv.dither(scx - r, sy - r, scx + r, sy + r, ACCENT, 0.85)
        cv.disc(scx, sy, r * 0.74, HI)
        cv.disc(scx, sy, r * 0.46, ACCENT)
        cv.disc(scx, sy, r * 0.20, HI)
        cv.ring(scx, scy, r + 5 + breathe, ACCENT, density=0.35)
        # one ripple leaves the seal per loop
        rip = (u * 1.0) % 1.0
        cv.ring(scx, scy, r + 4 + rip * 26, ACCENT, density=max(0.0, 0.5 - rip * 0.5))
        out.append(cv)
    return out


# --------------------------------------------------------------------------- #
# 08 · refuse · the barrier coming down across the corridor
# --------------------------------------------------------------------------- #
def scene_refuse(W=288, H=160, frames=32):
    vpx, vpy = W / 2, H * 0.5
    out = []
    for f in range(frames):
        u = f / frames
        cv = Canvas(W, H)
        cv.disc(vpx, vpy, H * 0.4, DEEP)
        for g, c in ((0.42, IND_DIM), (0.78, IND_MID), (1.15, ACCENT)):
            hw, hh = W * 0.40 * g, H * 0.38 * g
            cv.rect(vpx - hw, vpy - hh, vpx + hw, vpy + hh, c)
        for k in range(-6, 7):
            cv.line(vpx, vpy, vpx + k * (W * 0.1), H, IND_DIM)
        cv.dither(W * 0.2, vpy, W * 0.8, H, IND_DIM, 0.18)

        # the card stops short of the last plane
        z = 0.1 + ease_out(min(1.0, u / 0.35)) * 0.55
        s = z ** 1.45
        chw, chh = W * 0.030 * s + 1, H * 0.050 * s + 1
        cv.rect(vpx - chw * 1.9, vpy - chh * 1.9, vpx + chw * 1.9, vpy + chh * 1.9, ACCENT)
        cv.fill(vpx - chw, vpy - chh, vpx + chw, vpy + chh, HI)

        # the barrier: down hard at a third of the loop, held, then lifted
        bar = 0.34
        if u < bar:
            t = ease_out(u / bar)
        elif u < 0.82:
            t = 1.0
        else:
            t = 1 - (u - 0.82) / 0.18
        y = vpy - H * 0.34 + t * (H * 0.52)
        cv.fill(W * 0.16, y, W * 0.84, y + 5, RED)
        cv.hline(W * 0.16, W * 0.84, y - 1, HI)
        cv.hline(W * 0.16, W * 0.84, y + 6, IND_DIM)
        if 0 < t <= 1:
            cv.dither(W * 0.16, y - 6, W * 0.84, y + 12, RED, 0.3 * t)
        # chevrons on the standing barrier, so it reads as a stop not a stripe
        if t > 0.5:
            for k in range(6):
                cx = W * 0.22 + k * W * 0.11
                cv.line(cx, y + 1, cx + 9, y + 4, BLACK, thick=1)
        out.append(cv)
    for i in range(2):
        out[i].fade(2 - i)
        out[-1 - i].fade(i + 1)
    return out


# stem, scene, per-frame delay in 1/100 s, where the pair is used
SCENES = [
    ("hero", scene_corridor, 8, "home and gate page heads"),
    ("score", scene_gauge, 7, "the score page head and the Rate pillar"),
    ("underwrite", scene_vault, 7, "the Clear pillar"),
    ("network", scene_network, 7, "the Insure pillar"),
    ("ledger", scene_ledger, 7, "the evidence page head"),
    ("burn", scene_burn, 8, "the penalty band on /score"),
    ("permit", scene_permit, 7, "the permit trace on /gate"),
    ("refuse", scene_refuse, 7, "the refusal trace on /gate"),
]


def write_scene(out_dir, name, frames, delay):
    tmp = tempfile.mkdtemp(prefix="px-")
    for i, cv in enumerate(frames):
        cv.to_ppm(os.path.join(tmp, "f%03d.ppm" % i))
    # the poster is a real frame of the loop, so the static plate and the
    # animated one are the same scene and the swap is invisible
    frames[len(frames) // 3].to_ppm(os.path.join(tmp, "poster.ppm"))
    palette = os.path.join(tmp, "palette.png")
    subprocess.run(
        ["convert"] + ["xc:%s" % ("#%02x%02x%02x" % c) for c in PALETTE] + ["+append", palette],
        check=True)
    gif = os.path.join(out_dir, name + ".gif")
    subprocess.run(
        ["convert", "-delay", str(delay), "-loop", "0"] +
        [os.path.join(tmp, "f%03d.ppm" % i) for i in range(len(frames))] +
        ["-map", palette, "-layers", "optimize", "-strip", gif],
        check=True)
    png = os.path.join(out_dir, name + ".png")
    subprocess.run(["convert", os.path.join(tmp, "poster.ppm"), "-map", palette, "-strip", png], check=True)
    subprocess.run(["rm", "-rf", tmp], check=True)
    return gif, png


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "public", "art")
    os.makedirs(out_dir, exist_ok=True)
    for name, fn, delay, where in SCENES:
        frames = fn()
        gif, png = write_scene(out_dir, name, frames, delay)
        print("%-8s %2d frames  gif %6.1f kB  png %5.1f kB  -> %s"
              % (name, len(frames), os.path.getsize(gif) / 1024,
                 os.path.getsize(png) / 1024, where))
    return 0


if __name__ == "__main__":
    sys.exit(main())
