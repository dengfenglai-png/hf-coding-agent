# -*- coding: utf-8 -*-
"""用 python-pptx 生成 16:9 汇报 slides。读取 content.py 的 SLIDES 数据。
约定：add_text 的 lines 是 list，每个元素是「run 列表」= [(text, size, color, bold), ...]。"""
from pathlib import Path

from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

from content import SLIDES

DARK = RGBColor(0x14, 0x21, 0x3D)
ACCENT = RGBColor(0x2E, 0x86, 0xDE)
BODY = RGBColor(0x33, 0x33, 0x33)
MUTED = RGBColor(0x6B, 0x74, 0x80)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
SOFT = RGBColor(0xC8, 0xD2, 0xE0)

FONT = "Microsoft YaHei"
SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


def set_font(run, size, color=BODY, bold=False, name=FONT):
    f = run.font
    f.size = Pt(size)
    f.bold = bold
    f.color.rgb = color
    f.name = name
    rPr = run._r.get_or_add_rPr()
    for tag in ("a:ea", "a:cs"):
        e = rPr.find(qn(tag))
        if e is None:
            e = rPr.makeelement(qn(tag), {})
            rPr.append(e)
        e.set("typeface", name)


def add_text(slide, left, top, width, height, lines, anchor=MSO_ANCHOR.TOP):
    """lines: list of run-list；每个 run = (text, size, color, bold)。"""
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for i, runs in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        for text, size, color, bold in runs:
            r = p.add_run()
            r.text = text
            set_font(r, size, color, bold)
    return box


def fill_bg(slide, color):
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color


def add_bar(slide, top, color=ACCENT):
    bar = slide.shapes.add_shape(1, Inches(0.6), top, Inches(0.09), Inches(0.28))
    bar.fill.solid()
    bar.fill.fore_color.rgb = color
    bar.line.fill.background()


def add_footer(slide, idx):
    add_text(slide, Inches(0.6), SLIDE_H - Inches(0.5), Inches(5), Inches(0.3),
             [[(f"pi-from-scratch · Agent Harness 技术原理 · {idx}", 10, MUTED, False)]])


def render_cover(prs, s, idx):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    fill_bg(slide, DARK)
    add_text(slide, Inches(0.9), Inches(2.2), Inches(11.5), Inches(1.4),
             [[(s["title"], 44, WHITE, True)]], anchor=MSO_ANCHOR.MIDDLE)
    add_text(slide, Inches(0.9), Inches(3.8), Inches(11.5), Inches(1.6),
             [[(ln, 18, SOFT, False)] for ln in s["subtitle"].split("\n")])


def render_toc(prs, s, idx):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_text(slide, Inches(0.6), Inches(0.5), Inches(12), Inches(0.8),
             [[(s["title"], 32, DARK, True)]])
    add_bar(slide, Inches(1.15))
    for i, b in enumerate(s["bullets"]):
        top = Inches(1.7) + Inches(1.35) * i
        marker = "●" if i == 0 else "—"
        add_text(slide, Inches(0.9), top, Inches(11.6), Inches(1.2),
                 [[(f"{marker} ", 18, ACCENT, True), (b, 18, BODY, False)]])


def render_content(prs, s, idx):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_text(slide, Inches(0.6), Inches(0.5), Inches(12), Inches(0.8),
             [[(s["title"], 30, DARK, True)]])
    add_bar(slide, Inches(1.15))
    top = Inches(1.75)
    for b in s.get("bullets", []):
        add_text(slide, Inches(0.9), top, Inches(11.5), Inches(1.4),
                 [[("▶ ", 16, ACCENT, True), (b, 16, BODY, False)]])
        top = Emu(int(top) + Inches(1.1))
    add_footer(slide, idx)


def render_image(prs, s, idx):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    add_text(slide, Inches(0.6), Inches(0.35), Inches(12), Inches(0.7),
             [[(s["title"], 28, DARK, True)]])
    add_bar(slide, Inches(0.95))

    img_path = Path(__file__).parent / s["image"]
    with Image.open(img_path) as im:
        ratio = im.height / im.width
    avail_w, avail_h = 12.1, 4.7
    w = avail_w
    h = w * ratio
    if h > avail_h:
        h = avail_h
        w = h / ratio
    left = (SLIDE_W - Inches(w)) / 2
    top = Inches(1.35) + (Inches(avail_h) - Inches(h)) / 2
    slide.shapes.add_picture(str(img_path), left, top, width=Inches(w))

    by = Inches(6.1)
    for b in s.get("bullets", []):
        add_text(slide, Inches(0.9), by, Inches(11.5), Inches(0.55),
                 [[("▶ ", 13, ACCENT, True), (b, 13, BODY, False)]])
        by = Emu(int(by) + Inches(0.5))
    add_footer(slide, idx)


def render_section(prs, s, idx):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    fill_bg(slide, DARK)
    add_text(slide, Inches(0.9), Inches(2.7), Inches(11.5), Inches(1.2),
             [[(s["title"], 40, WHITE, True)]], anchor=MSO_ANCHOR.MIDDLE)
    if s.get("subtitle"):
        add_text(slide, Inches(0.9), Inches(4.1), Inches(11.5), Inches(1.2),
                 [[(s["subtitle"], 16, SOFT, False)]], anchor=MSO_ANCHOR.MIDDLE)


def main():
    prs = Presentation()
    prs.slide_width = SLIDE_W
    prs.slide_height = SLIDE_H

    renderers = {
        "cover": render_cover,
        "toc": render_toc,
        "content": render_content,
        "image": render_image,
        "section": render_section,
    }
    for i, s in enumerate(SLIDES):
        renderers[s["kind"]](prs, s, i + 1)

    out = Path(__file__).parent / "agent-harness-汇报.pptx"
    prs.save(out)
    print(f"saved {out} · {len(SLIDES)} slides")


if __name__ == "__main__":
    main()
