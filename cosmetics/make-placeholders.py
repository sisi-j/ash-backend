"""Draw ash's placeholder capes (spec 0004: real art is the product owner's
or commissioned). Each is a 64x32 PNG in the game's own cape layout: the
cape's faces in the 22x17 region at the top left, the elytra beside it.

    python cosmetics/make-placeholders.py

Rerunnable: the same input always draws the same bytes.
"""

from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent

# The cape's faces, as (x, y, width, height) in the 64x32 texture. OUTSIDE is
# the face seen from behind the player - checked in a 1.20.4 game, where a mark
# drawn here showed on the player's back; INSIDE is the one against them.
OUTSIDE = (1, 1, 10, 16)
INSIDE = (12, 1, 10, 16)
SIDES = [(0, 1, 1, 16), (11, 1, 1, 16)]
TOP_BOTTOM = [(1, 0, 10, 1), (11, 0, 10, 1)]
# The elytra wing, which the game draws from the same texture.
ELYTRA = (22, 0, 24, 22)


def fill(image, box, colour):
    x, y, w, h = box
    for i in range(x, x + w):
        for j in range(y, y + h):
            image.putpixel((i, j), colour)


def gradient(image, box, top, bottom):
    x, y, w, h = box
    for j in range(h):
        t = j / max(1, h - 1)
        colour = tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,)
        for i in range(x, x + w):
            image.putpixel((i, y + j), colour)


def cape(name, top, bottom, edge, mark):
    image = Image.new("RGBA", (64, 32), (0, 0, 0, 0))
    for face in (OUTSIDE, INSIDE):
        gradient(image, face, top, bottom)
    for face in SIDES + TOP_BOTTOM:
        fill(image, face, edge + (255,))
    gradient(image, ELYTRA, top, bottom)
    # A small mark on the outside, where other players see it, so the
    # preview shows which way it faces.
    for (dx, dy) in mark:
        image.putpixel((OUTSIDE[0] + dx, OUTSIDE[1] + dy), (255, 255, 255, 255))
        image.putpixel((ELYTRA[0] + 10 + dx, ELYTRA[1] + 4 + dy), (255, 255, 255, 255))
    image.save(HERE / f"{name}.png", optimize=False)


# An "a", for ash, in the middle of the back.
A = [(4, 5), (5, 5), (3, 6), (6, 6), (3, 7), (4, 7), (5, 7), (6, 7), (3, 8), (6, 8)]
# A small flame for ember, and three stars for midnight.
FLAME = [(5, 4), (4, 5), (5, 5), (4, 6), (5, 6), (6, 6), (3, 7), (4, 7), (5, 7), (6, 7), (4, 8), (5, 8)]
STARS = [(2, 3), (7, 5), (4, 9), (8, 11), (1, 12)]

cape("cape-ash", (88, 88, 94), (38, 38, 42), (24, 24, 28), A)
cape("cape-ember", (240, 120, 40), (120, 30, 20), (70, 20, 12), FLAME)
cape("cape-midnight", (40, 52, 110), (10, 12, 34), (6, 8, 22), STARS)
