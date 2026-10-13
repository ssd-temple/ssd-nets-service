from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs('assets', exist_ok=True)
icon_path = os.path.join('assets', 'app-icon.ico')
size = 256
img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
for y in range(size):
    r = int(224 + (255 - 224) * (y / size))
    g = int(28 + (138 - 28) * (y / size))
    b = int(36 + (243 - 36) * (y / size))
    d.line([(0, y), (size, y)], fill=(r, g, b, 255))

mask = Image.new('L', (size, size), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, size, size], radius=40, fill=255)
img.putalpha(mask)

try:
    font = ImageFont.truetype('arial.ttf', 140)
except Exception:
    font = ImageFont.load_default()

text = 'HEB'
w, h = d.textsize(text, font=font)
d.text(((size - w) / 2, (size - h) / 2 - 10), text, font=font, fill=(255, 255, 255, 255))

icon_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
icon_images = [img.resize(s, Image.LANCZOS) for s in icon_sizes]
icon_images[0].save(icon_path, format='ICO', sizes=icon_sizes)
print(f'created {icon_path}')
