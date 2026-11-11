"""Draw the simple generic icons used by aws_diagrams.py for non-AWS services (no brand logos)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "icons"
S = 256


def base(color):
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((8, 8, S - 8, S - 8), radius=44, fill=color)
    return im, d


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def dataset():  # stacked disks + ZIP label
    im, d = base((255, 176, 32))
    for i, y in enumerate((60, 100, 140)):
        d.ellipse((58, y, 198, y + 40), fill="white", outline=(150, 90, 0), width=6)
    d.rectangle((58, 80, 198, 160), fill="white")
    d.ellipse((58, 140, 198, 180), fill="white", outline=(150, 90, 0), width=6)
    d.line((58, 80, 58, 160), fill=(150, 90, 0), width=6)
    d.line((198, 80, 198, 160), fill=(150, 90, 0), width=6)
    d.ellipse((58, 60, 198, 100), fill="white", outline=(150, 90, 0), width=6)
    d.text((128, 210), "ZIP", font=font(40), fill="white", anchor="mm")
    return im


def gpu():  # chip with pins
    im, d = base((32, 120, 220))
    d.rectangle((74, 74, 182, 182), fill="white")
    d.rectangle((96, 96, 160, 160), fill=(32, 120, 220))
    for p in range(86, 180, 22):
        d.rectangle((p, 44, p + 8, 74), fill="white")
        d.rectangle((p, 182, p + 8, 212), fill="white")
        d.rectangle((44, p, 74, p + 8), fill="white")
        d.rectangle((182, p, 212, p + 8), fill="white")
    d.text((128, 128), "GPU", font=font(24), fill="white", anchor="mm")
    return im


def tracking():  # line chart
    im, d = base((124, 77, 255))
    d.line((50, 200, 206, 200), fill="white", width=8)
    d.line((50, 50, 50, 200), fill="white", width=8)
    pts = [(62, 175), (100, 140), (135, 150), (170, 95), (200, 70)]
    d.line(pts, fill="white", width=10, joint="curve")
    for x, y in pts:
        d.ellipse((x - 9, y - 9, x + 9, y + 9), fill="white")
    return im


def traces():  # log lines + spans
    im, d = base((255, 94, 58))
    for i, (x0, x1) in enumerate(((50, 200), (80, 190), (80, 150), (110, 170), (50, 120))):
        y = 58 + i * 34
        d.rounded_rectangle((x0, y, x1, y + 20), radius=8, fill="white")
    return im


def laptop():  # annotator PC
    im, d = base((46, 160, 110))
    d.rounded_rectangle((60, 60, 196, 160), radius=10, fill="white")
    d.rectangle((72, 72, 184, 148), fill=(46, 160, 110))
    d.rectangle((90, 90, 150, 130), outline="white", width=5)
    d.polygon([(40, 175), (216, 175), (200, 195), (56, 195)], fill="white")
    return im


def email():
    im, d = base((90, 100, 120))
    d.rectangle((48, 72, 208, 184), fill="white")
    d.line([(48, 72), (128, 140), (208, 72)], fill=(90, 100, 120), width=10)
    return im


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for name, fn in {"dataset": dataset, "gpu": gpu, "tracking": tracking, "traces": traces,
                     "laptop": laptop, "email": email}.items():
        fn().save(OUT / f"{name}.png")
        print("wrote", OUT / f"{name}.png")
