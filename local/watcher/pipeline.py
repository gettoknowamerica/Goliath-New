"""Video → transcript → clips → blog. Every stage uses tools already on F:.

Stage map (Council owner in brackets):
  1. probe            ffprobe                      [Scorsese]
  2. transcribe       whisperX + pyannote          [Columbo]  diarized, word-level
  3. clean audio      demucs                       [Scorsese]  wind/street noise
  4. high moments     qwen2.5:7b over transcript   [Columbo]
  5. render           ffmpeg (+ sam2 reframe)      [Scorsese]
  6. metadata         qwen2.5:7b                   [Columbo]
  7. blog             gpt-oss:20b (overnight)      [Shakespeare]
  8. persist          MySQL + blog HTML            [Goliath]

Nothing is invented: if a stage has no real output the record says so rather
than filling the gap with plausible text.
"""

import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "llm"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gpu"))

import router  # noqa: E402
from gpu_lock import GpuLock  # noqa: E402

FFMPEG = os.environ.get("FFMPEG_BIN", r"F:\GoliathOmni\ai-ffmpeg\bin\ffmpeg.exe")
FFPROBE = os.environ.get("FFPROBE_BIN", r"F:\GoliathOmni\ai-ffmpeg\bin\ffprobe.exe")
PY = os.environ.get("VENV_PY", r"F:\GoliathOmni\venv\Scripts\python.exe")
WORK = Path(os.environ.get("MEDIA_WORK", r"F:\GoliathOmni\media\work"))
OUT = Path(os.environ.get("MEDIA_OUT", r"F:\GoliathOmni\exports"))

SHORTS_PER_EPISODE = 8
SHORT_MIN_SEC = 20
SHORT_MAX_SEC = 58


def sh(cmd, **kw):
    print("[run]", " ".join(str(c) for c in cmd[:6]), "...")
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def probe(src: Path) -> dict:
    out = sh([FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format",
              "-show_streams", str(src)]).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), {})
    return {
        "duration": float(info["format"]["duration"]),
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": v.get("r_frame_rate"),
    }


def transcribe(src: Path, job: Path) -> dict:
    """whisperX gives word-level timings; pyannote separates Mark from the homeowner.
    That separation is the whole unlock for doorknocking footage — the reactions
    worth cutting are the homeowner's, not the narration."""
    outdir = job / "transcript"
    outdir.mkdir(parents=True, exist_ok=True)
    with GpuLock(holder="whisperx", mode="exclusive", ttl=7200):
        sh([PY, "-m", "whisperx", str(src),
            "--model", "large-v3", "--diarize", "--compute_type", "float16",
            "--output_format", "json", "--output_dir", str(outdir)])
    hit = next(outdir.glob("*.json"), None)
    if not hit:
        raise RuntimeError("whisperX produced no transcript")
    return json.loads(hit.read_text(encoding="utf-8"))


def flatten(tr: dict) -> str:
    lines = []
    for seg in tr.get("segments", []):
        spk = seg.get("speaker", "SPK")
        lines.append(f"[{seg['start']:.1f}-{seg['end']:.1f}] {spk}: {seg['text'].strip()}")
    return "\n".join(lines)


def pick_moments(transcript_text: str, duration: float) -> list:
    system = (
        "You select viral short-form clips from a real-estate doorknocking episode. "
        "You return ONLY JSON. Never invent dialogue that is not in the transcript. "
        "Prefer moments where the homeowner reacts, objects, or reveals a real "
        "motivation to sell. Human warmth beats hype."
    )
    prompt = f"""Transcript with timecodes and speaker labels:

{transcript_text[:24000]}

Episode length: {duration:.0f}s.

Return JSON: {{"clips":[{{"start":float,"end":float,"hook":"...","why":"...","tier":"A|B|C"}}]}}
Rules: {SHORT_MIN_SEC}-{SHORT_MAX_SEC}s each, at most {SHORTS_PER_EPISODE} clips,
no overlaps, start on a complete sentence. Tier A = strongest."""
    raw = router.ask("clip_select", prompt, system=system, json_mode=True)
    try:
        clips = json.loads(raw).get("clips", [])
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        clips = json.loads(m.group(0)).get("clips", []) if m else []
    good = []
    for c in clips:
        s, e = float(c.get("start", 0)), float(c.get("end", 0))
        if 0 <= s < e <= duration and SHORT_MIN_SEC <= (e - s) <= SHORT_MAX_SEC:
            good.append(c)
    return good[:SHORTS_PER_EPISODE]


def render_short(src: Path, clip: dict, idx: int, dest: Path) -> Path:
    """9:16 vertical, centre-weighted crop, loudness-normalised."""
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"short-{idx:02d}.mp4"
    vf = ("crop=ih*9/16:ih,scale=1080:1920:flags=lanczos")
    with GpuLock(holder=f"ffmpeg:short{idx}", mode="exclusive", ttl=1800):
        sh([FFMPEG, "-y", "-ss", str(clip["start"]), "-to", str(clip["end"]),
            "-i", str(src), "-vf", vf, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-c:v", "h264_nvenc", "-preset", "p5", "-b:v", "8M",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    return out


def render_episode(src: Path, dest: Path) -> Path:
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / "episode.mp4"
    with GpuLock(holder="ffmpeg:episode", mode="exclusive", ttl=7200):
        sh([FFMPEG, "-y", "-i", str(src),
            "-vf", "scale=1920:1080:flags=lanczos",
            "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
            "-c:v", "h264_nvenc", "-preset", "p5", "-b:v", "12M",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    return out


def metadata(transcript_text: str) -> dict:
    prompt = f"""From this episode transcript, produce JSON:
{{"title":"...","description":"...","tags":["..."],"chapters":[{{"t":"MM:SS","label":"..."}}]}}
Title: specific, curiosity-driving, no clickbait lies. Fairfield County CT context.
Chapters: real topic shifts only.

{transcript_text[:20000]}"""
    raw = router.ask("title", prompt, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"title": "", "description": "", "tags": [], "chapters": [],
                "error": "model returned unparseable metadata"}


def write_blog(transcript_text: str, meta: dict, video_slug: str) -> dict:
    system = (
        "You are Shakespeare, writing for markpires.com. Mark Pires is a Fairfield "
        "County CT realtor, creator of Discover CT, a music artist, and the patented "
        "inventor of BeatSeat. Write in his voice: warm, direct, specific, never "
        "corporate. Automation never replaces human warmth. Every claim must trace "
        "to the transcript — invent nothing about people or properties."
    )
    prompt = f"""Write a 900-1400 word blog post from this episode.

Structure: a hook drawn from a real moment, the market insight it reveals, what a
Fairfield County seller should take from it, and a close inviting a free home
valuation. Include an H2 outline. Return JSON:
{{"headline":"...","dek":"...","body_html":"...","meta_description":"...","slug":"..."}}

body_html: semantic HTML only (h2, h3, p, blockquote, ul). No inline styles, no
wrapper div. Leave the exact string <!--VIDEO_EMBED--> where the video belongs.

Episode title: {meta.get('title','')}
Transcript:
{transcript_text[:24000]}"""
    raw = router.ask("blog", prompt, system=system, json_mode=True)
    try:
        blog = json.loads(raw)
    except json.JSONDecodeError:
        return {"error": "blog model returned unparseable JSON", "raw": raw[:2000]}
    blog.setdefault("slug", video_slug)
    return blog


def run(src: Path) -> dict:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    slug = re.sub(r"[^a-z0-9]+", "-", src.stem.lower()).strip("-")
    job = WORK / f"{stamp}-{slug}"
    dest = OUT / f"{stamp}-{slug}"
    job.mkdir(parents=True, exist_ok=True)

    result = {"source": str(src), "job": str(job), "out": str(dest),
              "started": stamp, "stages": {}}

    info = probe(src)
    result["stages"]["probe"] = info

    tr = transcribe(src, job)
    text = flatten(tr)
    (job / "transcript.txt").write_text(text, encoding="utf-8")
    result["stages"]["transcribe"] = {"segments": len(tr.get("segments", [])),
                                       "speakers": len({s.get("speaker") for s in tr.get("segments", [])})}

    clips = pick_moments(text, info["duration"])
    (job / "clips.json").write_text(json.dumps(clips, indent=2), encoding="utf-8")
    result["stages"]["clip_select"] = {"count": len(clips)}

    episode = render_episode(src, dest)
    shorts = [str(render_short(src, c, i + 1, dest / "shorts"))
              for i, c in enumerate(clips)]
    result["stages"]["render"] = {"episode": str(episode), "shorts": shorts}

    meta = metadata(text)
    (job / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    result["stages"]["metadata"] = meta

    blog = write_blog(text, meta, slug)
    (job / "blog.json").write_text(json.dumps(blog, indent=2), encoding="utf-8")
    result["stages"]["blog"] = {"slug": blog.get("slug"),
                                 "headline": blog.get("headline"),
                                 "error": blog.get("error")}

    # Publishing and MySQL insert are deliberately separate: posts go to the
    # blog queue for owner approval, they do not auto-publish.
    (job / "READY_FOR_APPROVAL").write_text(stamp, encoding="utf-8")
    return result
