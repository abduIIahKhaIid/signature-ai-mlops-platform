"""Tiny SVG helper for hand-laid-out architecture diagrams.

Two outputs from the same drawing:
  page mode -> colours are CSS variables of the page (light + dark theme)
  file mode -> literal light-theme colours + white background (for docs/ and GitHub)
"""
from __future__ import annotations

from html import escape

LIGHT = {
    "bg": "#FFFFFF", "surface": "#FFFFFF", "ink": "#17202E", "muted": "#566175", "line": "#C9D0DB",
    "ec2": "#EEF2FA", "ec2-line": "#7C93C7", "s3": "#FBF3E6", "s3-line": "#C08A3E",
    "ext": "#F3F1F8", "ext-line": "#9488B6", "accent": "#0F766E", "accent-soft": "#E3F4F1",
    "good": "#15803D", "bad": "#B42318", "warn": "#B45309",
}
FONT_FILE = "'IBM Plex Sans', 'Segoe UI', Arial, sans-serif"
MONO_FILE = "'IBM Plex Mono', Consolas, monospace"


class Svg:
    def __init__(self, w: int, h: int, label: str, mode: str = "page"):
        self.w, self.h, self.label, self.mode = w, h, label, mode
        self.parts: list[str] = []
        self.ids = "".join(ch for ch in label.lower() if ch.isalnum())[:16]
        self._markers = set()

    # colours and fonts ---------------------------------------------------------------
    def c(self, token: str) -> str:
        return f"var(--d-{token})" if self.mode == "page" else LIGHT[token]

    def font(self, mono: bool = False) -> str:
        if self.mode == "page":
            return "var(--font-mono)" if mono else "var(--font-body)"
        return MONO_FILE if mono else FONT_FILE

    # primitives ----------------------------------------------------------------------
    def rect(self, x, y, w, h, fill="surface", stroke="line", rx=8, dash=False, sw=1.2):
        d = ";stroke-dasharray:5 4" if dash else ""
        self.parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" '
                          f'style="fill:{self.c(fill)};stroke:{self.c(stroke)};stroke-width:{sw}{d}"/>')

    def text(self, x, y, s, size=12, weight=400, color="ink", anchor="start", mono=False, italic=False):
        it = ";font-style:italic" if italic else ""
        lead = len(s) - len(s.lstrip(" "))
        s = "\u00a0" * lead + s.lstrip(" ")  # keep indentation (SVG collapses spaces)
        self.parts.append(f'<text x="{x}" y="{y}" text-anchor="{anchor}" style="font-family:{self.font(mono)};'
                          f'font-size:{size}px;font-weight:{weight};fill:{self.c(color)}{it}">{escape(s)}</text>')

    def lines(self, x, y, items, size=11.5, gap=15, color="muted", anchor="start", mono=False, weight=400):
        for i, s in enumerate(items):
            self.text(x, y + i * gap, s, size=size, color=color, anchor=anchor, mono=mono, weight=weight)

    def box(self, x, y, w, h, title, sub=(), fill="surface", stroke="line", mono_sub=False, center=False, tag=None,
            title_color="ink", sub_gap=15):
        self.rect(x, y, w, h, fill, stroke)
        tx = x + w / 2 if center else x + 12
        anchor = "middle" if center else "start"
        self.text(tx, y + 21, title, size=13, weight=600, color=title_color, anchor=anchor)
        if tag:
            self.text(x + w - 10, y + 20, tag, size=10.5, color="muted", anchor="end", mono=True)
        self.lines(tx, y + 39, list(sub), anchor=anchor, mono=mono_sub, gap=sub_gap)

    def frame(self, x, y, w, h, label, fill="ec2", stroke="ec2-line", sub=None, bottom=False):
        self.rect(x, y, w, h, fill, stroke, rx=12, dash=True)
        ty = y + h - (30 if sub else 14) if bottom else y + 22
        self.text(x + 14, ty, label, size=12.5, weight=700, color="ink")
        if sub:
            self.text(x + 14, ty + 16, sub, size=11, color="muted")

    def arrow(self, pts, label=None, at=None, color="ink", dash=False, anchor="middle", both=False, lsize=11,
              lcolor=None, bg=True):
        d = "M " + " L ".join(f"{px} {py}" for px, py in pts)
        mid = f"{self.ids}-arrow-{color}"
        dd = ";stroke-dasharray:6 4" if dash else ""
        start = f' marker-start="url(#{mid}-s)"' if both else ""
        self.parts.append(f'<path d="{d}" style="fill:none;stroke:{self.c(color)};stroke-width:1.5{dd}"'
                          f' marker-end="url(#{mid})"{start}/>')
        self._markers.add(color)
        if label:
            lx, ly = at if at else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2 - 6)
            for i, part in enumerate(label if isinstance(label, (list, tuple)) else [label]):
                if bg:
                    self._label_bg(lx, ly + i * 14, part, lsize, anchor)
                self.text(lx, ly + i * 14, part, size=lsize, color=lcolor or ("muted" if color == "ink" else color),
                          anchor=anchor)

    def _label_bg(self, x, y, s, size, anchor):
        w = len(s) * size * 0.56 + 6
        x0 = x - w / 2 if anchor == "middle" else (x - 3 if anchor == "start" else x - w + 3)
        self.parts.append(f'<rect x="{x0:.1f}" y="{y - size + 1:.1f}" width="{w:.1f}" height="{size + 4}" rx="3" '
                          f'style="fill:{self.c("bg")};opacity:0.92"/>')

    def badge(self, x, y, s, color="accent", fill="accent-soft"):
        w = len(s) * 6.4 + 14
        self.rect(x, y, w, 20, fill, color, rx=10, sw=1)
        self.text(x + w / 2, y + 14, s, size=10.5, weight=600, color=color, anchor="middle")
        return w

    def number(self, x, y, n, color="accent"):
        self.parts.append(f'<circle cx="{x}" cy="{y}" r="9" style="fill:{self.c(color)}"/>')
        self.text(x, y + 4, str(n), size=10.5, weight=700, color="bg", anchor="middle")

    # output --------------------------------------------------------------------------
    _markers: set

    def __enter__(self):
        self._markers = set()
        return self

    def __exit__(self, *a):
        return False

    def render(self) -> str:
        defs = []
        for color in sorted(self._markers):
            mid = f"{self.ids}-arrow-{color}"
            defs.append(f'<marker id="{mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                        f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" style="fill:{self.c(color)}"/></marker>')
            defs.append(f'<marker id="{mid}-s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                        f'orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" style="fill:{self.c(color)}"/></marker>')
        bg = "" if self.mode == "page" else f'<rect width="{self.w}" height="{self.h}" style="fill:#FFFFFF"/>'
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" role="img" '
                f'aria-label="{escape(self.label)}"><defs>{"".join(defs)}</defs>{bg}{"".join(self.parts)}</svg>')
