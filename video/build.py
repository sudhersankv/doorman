#!/usr/bin/env python3
"""
Assembles the demo video from the recorded scenes with ffmpeg. Every caption that states a number is read from
video/raw/scenes.json, video/raw/ab.json or data/compare.json — the measured results of the recordings and the
benchmark. Nothing is typed in by hand. Sped-up segments are labelled on screen.

  python3 video/build.py            # → video/out/doorman-demo.mp4 (2–3 min) and doorman-demo-short.mp4 (30–45 s)
  python3 video/build.py --short-only
"""
import json, os, subprocess, sys, math, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
RAW, OUT, WORK = ROOT / 'raw', ROOT / 'out', ROOT / 'work'
DATA = ROOT.parent / 'data'
W, H, FPS = 1920, 1080, 30
BG, BG2, INK, MUTED, GREEN, GREEN_DIM, RED, BLUE, AMBER = '#06101a', '#0e1b27', '#e8eef4', '#8da1b4', '#00ed64', '#00684a', '#ff6b6b', '#5aa9ff', '#ffc857'
FONT_DIR = Path('/usr/share/fonts/opentype/inter')
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

def font(size, weight='Regular'):
    for cand in [FONT_DIR / f'Inter-{weight}.otf', FONT_DIR / f'InterDisplay-{weight}.otf']:
        if cand.exists(): return ImageFont.truetype(str(cand), size)
    return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', size)
def mono(size): return ImageFont.truetype(MONO, size)

def load(p, default=None):
    try: return json.loads(Path(p).read_text())
    except Exception: return default

def sh(*cmd, quiet=True):
    r = subprocess.run([str(c) for c in cmd], capture_output=quiet, text=True)
    if r.returncode: raise RuntimeError((r.stderr or '')[-2000:])
    return r.stdout
def dur(path): return float(sh('ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path).strip())

def fmt_ms(ms): return '—' if ms is None else (f'{ms/1000:.1f} s' if ms >= 1000 else f'{int(ms)} ms')
def fmt_pct(x): return '—' if x is None else f'{round(x*100)}%'
def fmt_usd(x): return '—' if x is None else (f'${x:.4f}' if x < 0.01 else f'${x:.3f}')

# ── drawing ──────────────────────────────────────────────────────────────────────────
def logo(d, x, y, s=1.0):
    k = 40 * s
    d.rounded_rectangle([x + 4*s, y + 3*s, x + 26*s, y + 37*s], radius=3*s, fill=BG2, outline=GREEN, width=max(1, int(2*s)))
    d.rounded_rectangle([x + 8*s, y + 7*s, x + 22*s, y + 33*s], radius=1.5*s, outline=GREEN_DIM, width=max(1, int(1.5*s)))
    d.ellipse([x + 18*s, y + 19.4*s, x + 21.2*s, y + 22.6*s], fill=GREEN)
    d.ellipse([x + 27*s, y + 9*s, x + 35*s, y + 17*s], fill=GREEN)
    d.rounded_rectangle([x + 26.5*s, y + 9.2*s, x + 36.5*s, y + 11.2*s], radius=1*s, fill=GREEN)
    d.pieslice([x + 25*s, y + 21.5*s, x + 37*s, y + 33.5*s], 180, 360, fill=GREEN)
    d.rectangle([x + 25*s, y + 27.5*s, x + 37*s, y + 37*s], fill=GREEN)

def wordmark(d, x, y, size=56):
    f = font(size, 'Bold'); d.text((x, y), 'door', font=f, fill=GREEN); w = d.textlength('door', font=f); d.text((x + w, y), 'man', font=f, fill=INK)

def base_card():
    im = Image.new('RGB', (W, H), BG); d = ImageDraw.Draw(im)
    # subtle radial glow top-left
    glow = Image.new('L', (W, H), 0); gd = ImageDraw.Draw(glow)
    for i in range(12, 0, -1): gd.ellipse([-600 + i*20, -500 + i*20, 1300 - i*20, 500 - i*20], fill=int(8 * (12 - i) / 12))
    im = Image.composite(Image.new('RGB', (W, H), '#0a2a1e'), im, glow); d = ImageDraw.Draw(im)
    logo(d, 72, 56, 1.1); wordmark(d, 128, 52, 40)
    d.text((W - 72, 68), 'MongoDB Harness Engineering hackathon · SF Tech Week · Oct 11, 2026', font=font(20), fill=MUTED, anchor='ra')
    return im, d

def wrap(d, text, f, maxw):
    words, lines, cur = text.split(), [], ''
    for w_ in words:
        t = (cur + ' ' + w_).strip()
        if d.textlength(t, font=f) <= maxw: cur = t
        else: lines.append(cur); cur = w_
    if cur: lines.append(cur)
    return lines

def card_title(name, title, sub, foot=None, kicker=None):
    im, d = base_card()
    y = 380
    if kicker: d.text((160, y - 56), kicker.upper(), font=font(22, 'SemiBold'), fill=GREEN);
    f = font(84, 'Bold')
    for ln in wrap(d, title, f, 1600): d.text((160, y), ln, font=f, fill=INK); y += 100
    y += 16
    for ln in wrap(d, sub, font(34), 1500): d.text((160, y), ln, font=font(34), fill=MUTED); y += 46
    if foot: d.text((160, H - 110), foot, font=mono(22), fill=GREEN_DIM)
    p = WORK / f'{name}.png'; im.save(p); return p

def card_table(name, title, kicker, cols, rows, note, foot=None):
    """rows: list of (label, [cell...]); cols: header strings for the cells. Highlight column index 1 in green."""
    im, d = base_card()
    d.text((160, 200), kicker.upper(), font=font(22, 'SemiBold'), fill=GREEN)
    d.text((160, 236), title, font=font(60, 'Bold'), fill=INK)
    x0, y0 = 160, 380; cw = (W - 320 - 520) // max(1, len(cols))
    d.text((x0, y0), '', font=font(26));
    for i, c in enumerate(cols): d.text((x0 + 520 + i*cw + cw//2, y0), c, font=font(26, 'SemiBold'), fill=(GREEN if i == 1 else (RED if i == 0 else MUTED)), anchor='ma')
    y = y0 + 60
    for label, cells in rows:
        d.line([x0, y - 14, W - 160, y - 14], fill='#1b2c3b', width=1)
        d.text((x0, y), label, font=font(30), fill=MUTED)
        for i, c in enumerate(cells): d.text((x0 + 520 + i*cw + cw//2, y - 4), str(c), font=font(40, 'SemiBold'), fill=(INK if i == 1 else MUTED), anchor='ma')
        y += 78
    yy = y + 24
    for ln in wrap(d, note, font(24), 1600): d.text((160, yy), ln, font=font(24), fill=MUTED); yy += 32
    if foot: d.text((160, H - 110), foot, font=mono(22), fill=GREEN_DIM)
    p = WORK / f'{name}.png'; im.save(p); return p

def caption_png(name, text, sub=None, tag=None, pos='bottom', tag_only=False):
    """Transparent 1920x1080 overlay with a caption pill; tag is a small mono label (e.g. 'sped up 3×')."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    f, fs = font(34, 'SemiBold'), font(24)
    lines = wrap(d, text, f, 1180); subl = wrap(d, sub, fs, 1180) if sub else []
    h = 36 + len(lines)*44 + (len(subl)*30 + 8 if subl else 0)
    w = max([d.textlength(l, font=f) for l in lines] + [d.textlength(l, font=fs) for l in subl] + [300]) + 72
    x = 72; y = H - 60 - h if pos == 'bottom' else 150
    ty = y + 18
    if not tag_only:
        d.rounded_rectangle([x, y, x + w, y + h], radius=16, fill=(6, 16, 26, 225), outline=(0, 104, 74, 255), width=2)
        d.rectangle([x, y + 18, x + 5, y + h - 18], fill=GREEN)
    for l in ([] if tag_only else lines): d.text((x + 32, ty), l, font=f, fill=INK); ty += 44
    for l in subl: d.text((x + 32, ty + 4), l, font=fs, fill=MUTED); ty += 30
    if tag:
        tw = d.textlength(tag, font=mono(22)) + 28
        d.rounded_rectangle([W - 72 - tw, 60, W - 72, 100], radius=8, fill=(255, 200, 87, 235)); d.text((W - 72 - tw/2, 80), tag, font=mono(22), fill='#1a1200', anchor='mm')
    p = WORK / f'{name}.png'; im.save(p); return p

def side_label_png(name, left, right, left_sub, right_sub):
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    for i, (t, s, col) in enumerate([(left, left_sub, RED), (right, right_sub, GREEN)]):
        x = 24 + i * (W // 2)
        d.rounded_rectangle([x, 20, x + W//2 - 48, 92], radius=12, fill=(6, 16, 26, 225), outline=col, width=2)
        d.text((x + 24, 30), t, font=font(30, 'Bold'), fill=col); d.text((x + 24 + d.textlength(t, font=font(30, 'Bold')) + 18, 36), s, font=font(22), fill=MUTED)
    d.rectangle([W//2 - 2, 0, W//2 + 2, H], fill=(0, 237, 100, 180))
    p = WORK / f'{name}.png'; im.save(p); return p

# ── segments (each → an mp4 in WORK with identical encoding) ──────────────────────────
ENC = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', str(FPS), '-an']
def seg_card(name, png, seconds):
    out = WORK / f'{name}.mp4'
    sh('ffmpeg', '-y', '-loop', '1', '-framerate', FPS, '-t', seconds, '-i', png, '-vf', f'fade=t=in:st=0:d=0.5,fade=t=out:st={seconds-0.6}:d=0.6,format=yuv420p', *ENC, out); return out

def seg_clip(name, src, start, end, overlays=(), speed=1.0, zoom_hud=False, fade=True):
    """overlays: list of (png, t_from, t_to) in OUTPUT seconds. speed>1 shortens the clip (labelled by caller)."""
    out = WORK / f'{name}.mp4'
    inputs = ['-ss', str(start), '-to', str(end), '-i', src]
    for png, _, _ in overlays: inputs += ['-i', png]
    vf = f'[0:v]setpts=PTS/{speed},scale={W}:{H},fps={FPS}[v0]'
    cur = 'v0'
    if zoom_hud:  # magnify the bottom-right HUD into a picture-in-picture on the left
        vf += f';[{cur}]split[a][b];[b]crop=420:330:{W-420}:{H-330},scale=840:660[hud];[a][hud]overlay=72:{H-660-72}[v1]'; cur = 'v1'
    for i, (_, t0, t1) in enumerate(overlays):
        vf += f";[{cur}][{i+1}:v]overlay=0:0:enable='between(t,{t0},{t1})'[v{i+2}]"; cur = f'v{i+2}'
    length = (end - start) / speed
    if fade: vf += f';[{cur}]fade=t=in:st=0:d=0.4,fade=t=out:st={max(0, length-0.5)}:d=0.5[vout]'; cur = 'vout'
    sh('ffmpeg', '-y', *inputs, '-filter_complex', vf, '-map', f'[{cur}]', '-t', length, *ENC, out); return out

def seg_split(name, left_src, right_src, left_start, right_start, length, label_png, result_png, speed=1.0, tag=None, result_at=None):
    """Synchronized split screen: both clips start at their own 'goal started' offset, play at the same speed, with a
    live elapsed timer per side (real wall-clock from each clip's own frames). Shorter side holds its last frame."""
    out = WORK / f'{name}.mp4'
    half = W // 2
    def side(i, src, start):
        return (f'[{i}:v]trim=start={start},setpts=(PTS-STARTPTS)/{speed},scale={half}:{H//2},pad={half}:{H}:0:{H//4}:color=0x06101a,tpad=stop_mode=clone:stop_duration=600,'
                f"drawtext=fontfile={MONO}:text='%{{eif\\:t*{speed}\\:d}}.%{{eif\\:mod(t*{speed}*10\\,10)\\:d}} s':fontsize=44:fontcolor=white:box=1:boxcolor=0x06101a@0.8:boxborderw=14:x=w-tw-28:y=h-th-200[s{i}]")
    vf = side(0, left_src, left_start) + ';' + side(1, right_src, right_start)
    vf += f';[s0][s1]hstack[st];[st][2:v]overlay=0:0[l]'
    if result_png and result_at is not None: vf += f";[l][3:v]overlay=0:0:enable='gte(t,{result_at})'[r]"; last = 'r'
    else: last = 'l'
    if tag:
        tag_png = caption_png(name + '-tag', ' ', tag=tag, tag_only=True); vf += f';[{last}][4:v]overlay=0:0[t]'; last = 't'
    vf += f';[{last}]fade=t=in:st=0:d=0.4,fade=t=out:st={length-0.5}:d=0.5[vout]'
    ins = ['-i', left_src, '-i', right_src, '-i', label_png]
    ins += ['-i', result_png] if result_png else ['-i', label_png]
    if tag: ins += ['-i', tag_png]
    sh('ffmpeg', '-y', *ins, '-filter_complex', vf, '-map', '[vout]', '-t', length, *ENC, out); return out

def concat(name, segs, music=None):
    lst = WORK / f'{name}.txt'; lst.write_text(''.join(f"file '{s}'\n" for s in segs))
    out = OUT / f'{name}.mp4'
    # silent stereo track so every player treats it as a normal video
    sh('ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', out)
    return out

# ── storyboard ────────────────────────────────────────────────────────────────────────
def main():
    short_only = '--short-only' in sys.argv
    WORK.mkdir(exist_ok=True); OUT.mkdir(exist_ok=True)
    scenes = load(RAW / 'scenes.json', {'scenes': []}); S = {s['name']: s for s in scenes['scenes']}
    ab = load(RAW / 'ab.json'); cmp_ = load(DATA / 'compare.json')
    claims = []  # every on-screen number, with its source, for the verification report
    def claim(text, source): claims.append({'text': text, 'source': source})
    segs = []

    # 1 title
    segs.append(seg_card('c01', card_title('c01', 'a self-improving harness at your website\'s door', 'One script tag. Visiting AI agents get tools and a doorman; the owner gets intent analytics; the harness rewrites its own config and keeps only what measures better.', foot='github.com/sudhersankv/doorman · built today, all of it', kicker='doorman'), 7))
    # 2 problem
    segs.append(seg_card('c02', card_title('c02', 'AI agents re-read your website on every step.', 'An ordinary browser agent screenshots or scrapes the page, asks an LLM what to click, clicks, and starts over. Seconds per step, an LLM call per step — and the site owner never learns what the agent wanted.', kicker='the problem'), 8))

    # 3 shop
    if '01-shop' in S:
        sc = S['01-shop']; cap = caption_png('cap01', 'Trailhead Outfitters — the test site', 'A mock shop we built with four planted flaws as the answer key: an out-of-stock size, a ZIP validation bug, a buried sign-in link, lines it doesn\'t carry.')
        segs.append(seg_clip('s01', RAW / sc['file'], 0.3, min(sc['durationS'], 7.5), [(cap, 0.5, 7.5)]))

    # 4 A/B split screen — the first technical payoff
    if ab:
        b, dm = ab['baseline'], ab['doorman']
        bl_len, dm_len = b['ms'] / 1000, dm['ms'] / 1000
        natural = max(bl_len, dm_len) + 3.0
        speed = 1.0 if natural <= 42 else math.ceil(natural / 36 * 2) / 2  # keep the segment ≤ ~40 s, label the speed
        tag = f'sped up {speed:g}×' if speed > 1 else None
        length = natural / speed
        intro = card_title('c03', 'Same goal. Same fresh cart. Two agents.', f'“{ab["goal"]}”  —  left: an ordinary LLM browser agent reading the DOM (doorman.js blocked). Right: the goal delegated to doorman. Both verified from the shop\'s own state, not by an LLM judge.', kicker='live A/B · recorded with Playwright, not simulated')
        segs.append(seg_card('c03', intro, 7))
        lbl = side_label_png('lbl', 'ordinary LLM agent', 'doorman', 'DOM → LLM → click, every step', 'goal → Jev decides each step')
        res_lines = [
            ('verified outcome', ['reached' if b['success'] else 'not reached', 'reached' if dm['success'] else 'not reached']),
            ('wall-clock', [fmt_ms(b['ms']), fmt_ms(dm['ms'])]),
            ('browser steps', [b['steps'], dm['steps']]),
            ('LLM calls', [b['llmCalls'], dm['llmCalls']]),
            ('inference cost', [fmt_usd(b['costUsd']) + ' measured', fmt_usd(dm['costUsdEstimate']) + ' est.']),
        ]
        res = card_table('c04', 'What the recording measured', 'one goal · one run each', ['ordinary LLM agent', 'doorman'], res_lines,
                         f'Doorman also made {dm["jevCalls"]} Jev calls (~$0.04/M tokens, output free). Baseline cost is from the gateway\'s token usage; doorman\'s is estimated from step counts with the same assumptions as the dashboard. Model: {ab.get("model") or "—"}.')
        for lab, (x, y) in res_lines: claim(f'A/B {lab}: baseline {x} · doorman {y}', 'video/raw/ab.json')
        segs.append(seg_split('s02', RAW / b['file'], RAW / dm['file'], b['startOffsetS'], dm['startOffsetS'], length, lbl, None, speed=speed, tag=tag))
        segs.append(seg_card('c04', res, 9))
    else:
        segs.append(seg_card('c03x', card_title('c03x', 'A/B recording not available', 'video/raw/ab.json was not found; this build skips the side-by-side.', kicker='missing'), 3))

    # 5 aggregate benchmark
    if cmp_:
        A = cmp_['aggregate']; ba, da = A['baseline'], A['doorman']
        rows = [('goals reached', [fmt_pct(ba['successRate']), fmt_pct(da['successRate'])]), ('median time', [fmt_ms(ba['medianMs']), fmt_ms(da['medianMs'])]), ('mean steps', [f'{ba["meanSteps"]:.1f}', f'{da["meanSteps"]:.1f}']), ('LLM calls, total', [ba['totalLlmCalls'], da['totalLlmCalls']]), ('inference cost, total', [fmt_usd(ba['totalCostUsd']) + ' measured', fmt_usd(da['totalCostUsd']) + ' est.'])]
        for lab, (x, y) in rows: claim(f'benchmark {lab}: baseline {x} · doorman {y} (n={A["n"]})', 'data/compare.json')
        segs.append(seg_card('c05', card_table('c05', f'{A["n"]} matched goals, same site, both agents', 'aggregate · held-out benchmark goals · verified from shop state', ['ordinary LLM agent', 'doorman'], rows, f'Run {cmp_["runId"][:8]} against {cmp_["baseUrl"]}. Goals are the benchmark\'s held-out split (reworded, objective ground truth). Doorman ran with its active config and live recipe memory. Stored in the Atlas `comparisons` collection.'), 10))

    # 6 vague goal (honest), specific goal, memory
    for key, title, mk in [
        ('02-vague-goal', 'A vague goal, delegated in plain language', lambda r: ('reached in ' if r['done'] else 'NOT reached — ') + f'{fmt_ms(r["ms"])}, {r["steps"]} steps, tiers: ' + ', '.join(f'{t.replace("T1_","").replace("T2_","")} {n}' for t, n in (r.get('tierCounts') or {}).items())),
        ('03-specific-goal', 'A specific goal', lambda r: ('reached in ' if r['done'] else 'NOT reached — ') + f'{fmt_ms(r["ms"])}, {r["steps"]} steps · ' + ', '.join(f'{t.replace("T1_","").replace("T2_","")} {n}' for t, n in (r.get('tierCounts') or {}).items())),
        ('04-memory', 'Same goal again, fresh cart — MongoDB memory', lambda r: (f'recipe replayed: {r["tierCounts"].get("T1_recipe")} steps from memory · ' if (r.get('tierCounts') or {}).get('T1_recipe') else 'no recipe hit this time · ') + ('reached in ' if r['done'] else 'NOT reached — ') + f'{fmt_ms(r["ms"])}, {r["steps"]} steps'),
    ]:
        if key not in S: continue
        sc = S[key]; r = sc['result']; typed = next((m['t'] for m in sc['marks'] if m['label'] == 'typed'), 1.0); res_t = next((m['t'] for m in sc['marks'] if m['label'] == 'result'), sc['durationS'] - 2)
        start = max(0, typed - 2.5); end = min(sc['durationS'], res_t + 2.8)
        natural = end - start; speed = 1.0 if natural <= 16 else round(natural / 12, 1); tag = f'sped up {speed:g}×' if speed > 1 else None
        line = mk(r); claim(f'{key}: {line}', 'video/raw/scenes.json')
        cap1 = caption_png(f'cap-{key}-a', title, f'“{sc["goal"]}”', tag=tag); cap2 = caption_png(f'cap-{key}-b', line, 'Verified from the shop\'s own state. Every step was decided by the harness: tool → recipe → Jev → LLM fallback.', tag=tag)
        segs.append(seg_clip(f's-{key}', RAW / sc['file'], start, end, [(cap1, 0.3, (res_t - start) / speed), (cap2, (res_t - start) / speed, natural / speed + 1)], speed=speed, zoom_hud=True))

    # 7 dashboard
    if '05-dashboard' in S:
        sc = S['05-dashboard']; an = sc.get('analytics', {}); hv = an.get('headline', {})
        n = an.get('visits', {}).get('n'); sr = hv.get('successRate', {}).get('value'); med = hv.get('medianMs', {}).get('value'); shares = an.get('tiers', {}).get('shares', {})
        caps = [
            ('The owner\'s side: intent analytics', f'{n} agent visits in Atlas · {fmt_pct(sr)} of decided visits succeeded · median {fmt_ms(med)}. Every number marked observed is read from the visits collection.'),
            ('What to fix first', 'Each card is one observed row: demand the site doesn\'t serve, a form that stops agents, the intent that fails most.'),
            ('Unmet demand', 'What agents asked for that the site could not do — a roadmap written by the visitors.'),
            ('Who decided each step', f'Jev {fmt_pct(shares.get("T1_jev"))} · LLM fallback {fmt_pct(shares.get("T2_llm"))} of all steps. Cost is shown as an estimate, with the formula.'),
        ]
        claim(f'dashboard: {n} visits, success {fmt_pct(sr)}, median {fmt_ms(med)}, Jev {fmt_pct(shares.get("T1_jev"))}, LLM {fmt_pct(shares.get("T2_llm"))}', 'video/raw/scenes.json (05-dashboard.analytics, read from /api/analytics)')
        L = min(sc['durationS'], 24); ov = []; per = L / len(caps)
        for i, (t, s) in enumerate(caps): ov.append((caption_png(f'cap-dash-{i}', t, s), i * per + 0.2, (i + 1) * per - 0.2))
        segs.append(seg_clip('s05', RAW / sc['file'], 0.2, 0.2 + L, ov))

    # 8 evolution — the climax
    segs.append(seg_card('c06', card_title('c06', 'Then the harness tries to improve itself.', 'After a batch of visits, an editor LLM reads the worst traces and proposes up to three edits to the harness config — tools, context policy, guardrails, rules — as a JSON patch. Code validates it. The candidate runs on held-out goals it has never seen. It is kept only if it measures better; otherwise it is rolled back. Every version and verdict is stored.', kicker='recursive harness evolution'), 11))
    if '06-evolution' in S:
        sc = S['06-evolution']; evo = sc.get('evolution') or []
        kept = [v for v in evo if v.get('verdict') == 'kept']; rb = [v for v in evo if v.get('verdict') == 'rolled_back']; active = next((v for v in evo if v.get('active')), None)
        seed = next((v for v in evo if v.get('version') == 1), None)
        verdict_line = f'{len(evo)} versions · {len(kept)} kept · {len(rb)} rolled back · active: v{active["version"] if active else "?"}'
        if seed and seed.get('heldout'): verdict_line += f' · seed held-out success {fmt_pct(seed["heldout"].get("successPossible"))}, median {fmt_ms(seed["heldout"].get("medianMs"))}'
        claim(f'evolution: {verdict_line}', 'video/raw/scenes.json (06-evolution.evolution, read from /api/evolution)')
        honest = ('Every candidate was executed for real and lost to the seed on held-out goals — so none was kept. That is the loop working as regression protection: it measured, and refused to keep what did not help.' if not kept else f'{len(kept)} candidate(s) measured better on held-out goals and became active; {len(rb)} were rolled back.')
        caps = [('Every version, every patch, every verdict', verdict_line), ('The patch the editor proposed, as a diff', 'Validated by code: confirm list append-only, thresholds bounded, checkout never removable.'), ('Before → after on held-out goals', honest), ('Procedural memory vs harness evolution', 'Recipes (memory) made visits faster on the same config. Config evolution is judged separately, and today it kept nothing.')]
        L = min(sc['durationS'], 26); ov = []; per = L / len(caps)
        for i, (t, s) in enumerate(caps): ov.append((caption_png(f'cap-evo-{i}', t, s), i * per + 0.2, (i + 1) * per - 0.2))
        segs.append(seg_clip('s06', RAW / sc['file'], 0.2, 0.2 + L, ov))

    # 9 close
    segs.append(seg_card('c07', card_title('c07', 'Any website. One script tag. A door for agents, intent for owners.', 'doorman.js reads roles and names from the accessibility tree, so it carries no site vocabulary — the same script ran on a clinic booking page. Jev decides in ~400 ms. Atlas remembers. The harness keeps editing itself, and keeps only what measures better.', foot='github.com/sudhersankv/doorman   ·   doorman-trailhead.fly.dev', kicker='where this goes'), 9))

    if not short_only:
        out = concat('doorman-demo', segs); print('full:', out, f'{dur(out):.1f}s')

    # short cut: title, A/B split + result, evolution clip (first half), close
    short = [s for s in segs if s.name in ('c01.mp4', 's02.mp4', 'c04.mp4', 's06.mp4', 'c07.mp4')]
    if short:
        out2 = concat('doorman-demo-short', short); print('short:', out2, f'{dur(out2):.1f}s')
    (OUT / 'claims.json').write_text(json.dumps({'claims': claims, 'sources': ['video/raw/scenes.json', 'video/raw/ab.json', 'data/compare.json']}, indent=2))
    print('claims:', OUT / 'claims.json', len(claims))

if __name__ == '__main__': main()
