"""Builds taranmis-kitap.pdf: a scanned-style PDF whose pages are images compressed the way book scanners save them
(CCITT G4 and JBIG2-class bilevel decoding goes through pdf.js's jbig2.wasm; the last page is JPEG 2000 / openjpeg.wasm).
Usage: python make-scanned-pdf.py <font.ttf> <out.pdf> [pages]
With [pages], builds a long book instead (every page CCITT G4, each saying its own page number) for capacity tests."""
import io
import sys
import textwrap

from PIL import Image, ImageDraw, ImageFont

FONT, OUT = sys.argv[1], sys.argv[2]
LONG = int(sys.argv[3]) if len(sys.argv) > 3 else 0
W, H = 1240, 1754  # A5-ish at 200 dpi

PAGES = [
    ('g4', 'Chapter One', 'A tired old clockmaker lived at the edge of a small town. Every morning he opened his shop '
     'and repaired broken clocks one by one. One day a wet cat walked in through the door and hid under the counter.'),
    ('g4', 'Chapter Two', 'The cat never left the shop after that day. Customers came to see her and stayed to talk. '
     'Soon everyone in the town knew her name: Cotton.'),
    ('jpx', 'Üçüncü Bölüm', 'Yaşlı saatçi kediye pencerenin önünde oturmayı öğretti. Her akşam kasabanın ışıklarının '
     'birer birer yanışını izlediler, ta ki bütün sokak parıldayana dek.'),
]


FONTS = {size: ImageFont.truetype(FONT, size) for size in (40, 46, 64)}


def render(title, body):
    img = Image.new('L', (W, H), 255)
    d = ImageDraw.Draw(img)
    d.text((110, 160), title, font=FONTS[64], fill=0)
    y = 300
    for line in textwrap.wrap(body, 38):
        d.text((110, y), line, font=FONTS[46], fill=0)
        y += 70
    d.text((W // 2 - 20, H - 140), str(len(objs) // 3 + 1), font=FONTS[40], fill=0)
    return img


def g4(img):
    # Single strip, so the TIFF's strip is exactly the CCITT stream PDF expects. Black pixels encode as CCITT black.
    bw = img.point(lambda v: 255 if v > 128 else 0).convert('1')
    buf = io.BytesIO()
    bw.save(buf, 'TIFF', compression='group4', tiffinfo={278: H, 262: 0})
    t = Image.open(io.BytesIO(buf.getvalue()))
    off, size = t.tag_v2[273][0], t.tag_v2[279][0]
    data = buf.getvalue()[off:off + size]
    return data, f'/Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns {W} /Rows {H} /BlackIs1 true >>'


def jpx(img):
    buf = io.BytesIO()
    img.save(buf, 'JPEG2000', quality_mode='rates', quality_layers=[20])
    return buf.getvalue(), f'/Width {W} /Height {H} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /JPXDecode'


if LONG:
    PAGES = [('g4', f'Bölüm {n}', f'Bu uzun kitabın {n}. sayfasıdır. Sayfa numarası {n} olarak okunmalı ve '
              'sesli okuma bu sayfayı kaldığı yerden devam ettirebilmeli.') for n in range(1, LONG + 1)]

objs = []  # (dict, stream)
for kind, title, body in PAGES:
    data, params = (g4 if kind == 'g4' else jpx)(render(title, body))
    n = len(objs) + 3
    objs.append((f'<< /Type /XObject /Subtype /Image {params} /Length {len(data)} >>', data))
    content = f'q 420 0 0 595 0 0 cm /Im0 Do Q'.encode()
    objs.append((f'<< /Length {len(content)} >>', content))
    objs.append((f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /XObject << /Im0 {n} 0 R >> >> /Contents {n + 1} 0 R >>', None))

pages = [i + 3 for i in range(len(objs)) if objs[i][1] is None]
head = [('<< /Type /Catalog /Pages 2 0 R >>', None), (f'<< /Type /Pages /Kids [{" ".join(f"{p} 0 R" for p in pages)}] /Count {len(pages)} >>', None)]
out = io.BytesIO()
out.write(b'%PDF-1.6\n%\xe2\xe3\xcf\xd3\n')
offsets = []
for i, (d, s) in enumerate(head + objs, start=1):
    offsets.append(out.tell())
    out.write(f'{i} 0 obj\n{d}\n'.encode())
    if s is not None:
        out.write(b'stream\n' + s + b'\nendstream\n')
    out.write(b'endobj\n')
xref = out.tell()
out.write(f'xref\n0 {len(offsets) + 1}\n0000000000 65535 f \n'.encode())
for o in offsets:
    out.write(f'{o:010d} 00000 n \n'.encode())
out.write(f'trailer\n<< /Size {len(offsets) + 1} /Root 1 0 R /Info << /Producer (scanner) >> >>\nstartxref\n{xref}\n%%EOF\n'.encode())
open(OUT, 'wb').write(out.getvalue())
print(OUT, out.tell(), 'bytes')
