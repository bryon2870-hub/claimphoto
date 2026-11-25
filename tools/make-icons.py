"""Generates the PWA icons (run once; PNGs are committed). Needs Pillow."""
from PIL import Image, ImageDraw
BLUE=(37,99,235); DARK=(15,23,42); WHITE=(255,255,255)
def draw(size, maskable=False):
    S=size*4  # supersample
    im=Image.new("RGBA",(S,S),(0,0,0,0)); d=ImageDraw.Draw(im)
    if maskable: d.rectangle([0,0,S,S],fill=BLUE)           # full-bleed; OS applies its own mask
    else: d.rounded_rectangle([0,0,S,S],radius=int(S*0.22),fill=BLUE)
    k=0.70 if maskable else 0.80                              # glyph scale (maskable needs a safe zone)
    cx,cy=S/2,S/2+S*0.02; w=S*0.58*k/0.8; h=S*0.40*k/0.8
    d.rounded_rectangle([cx-w/2,cy-h/2,cx+w/2,cy+h/2],radius=int(S*0.05),fill=WHITE)            # body
    d.rounded_rectangle([cx-w*0.22,cy-h/2-S*0.06,cx+w*0.10,cy-h/2+S*0.02],radius=int(S*0.02),fill=WHITE)  # top bump
    r=h*0.36; d.ellipse([cx-r,cy-r,cx+r,cy+r],fill=DARK)                                          # lens
    r2=r*0.62; d.ellipse([cx-r2,cy-r2,cx+r2,cy+r2],fill=BLUE)
    r3=r*0.22; d.ellipse([cx-r3-r*0.18,cy-r3-r*0.18,cx+r3-r*0.18,cy+r3-r*0.18],fill=WHITE)         # glint
    return im.resize((size,size),Image.LANCZOS)
for name,size,m in [("icon-192.png",192,False),("icon-512.png",512,False),("icon-maskable-512.png",512,True),("apple-touch-icon.png",180,True)]:
    draw(size,m).save("src/icons/"+name); print("wrote",name)
