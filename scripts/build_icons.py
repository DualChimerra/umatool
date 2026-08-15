#!/usr/bin/env python3
"""Extract and downscale the icons the site needs.

Usage:  python3 scripts/build_icons.py <path to uma-tools checkout>

The upstream icon dump is ~400 MB of full-size PNGs covering every server. We
only keep what the Global data set actually references, re-encoded as small
WebP files so the whole image set stays a few megabytes.
"""
import json
import os
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "img"
DATA = ROOT / "docs" / "data"

SIZES = {"skill": 72, "chara": 112, "support": 160}


def save(src: Path, dst: Path, size: int) -> bool:
    if dst.exists():
        return True
    if not src.exists():
        return False
    img = Image.open(src).convert("RGBA")
    img.thumbnail((size, size), Image.LANCZOS)
    dst.parent.mkdir(parents=True, exist_ok=True)
    img.save(dst, "WEBP", quality=82, method=5)
    return True


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    src_root = Path(sys.argv[1])
    icons = json.loads((src_root / "icons.json").read_text())

    skills = json.loads((DATA / "skills.json").read_text())
    characters = json.loads((DATA / "characters.json").read_text())
    supports = json.loads((DATA / "supports.json").read_text())

    missing = {"skill": [], "chara": [], "support": []}

    icon_ids = {s["iconId"] for s in skills if s.get("iconId")}
    for icon_id in sorted(icon_ids):
        src = src_root / "icons" / "skill" / f"utx_ico_skill_{icon_id}.png"
        if not save(src, OUT / "skill" / f"{icon_id}.webp", SIZES["skill"]):
            missing["skill"].append(icon_id)

    for chara in characters:
        for outfit in chara["outfits"]:
            names = icons.get(outfit["id"]) or []
            if isinstance(names, str):
                names = [names]
            done = False
            for name in names:
                if save(src_root / "icons" / "chara" / f"{name}.png",
                        OUT / "chara" / f"{outfit['id']}.webp", SIZES["chara"]):
                    done = True
                    break
            if not done:
                missing["chara"].append(outfit["id"])

    for card in supports:
        if not card["global"]:
            continue
        found = False
        for stem in (f"support_card_s_{card['id']}", f"Support_card_s_{card['id']}"):
            if save(src_root / "icons" / "support" / f"{stem}.png",
                    OUT / "support" / f"{card['id']}.webp", SIZES["support"]):
                found = True
                break
        if not found:
            missing["support"].append(card["id"])

    for kind, ids in missing.items():
        print(f"{kind}: {len(ids)} missing" + (f" e.g. {ids[:6]}" if ids else ""))
    total = sum(len(list((OUT / k).glob('*.webp'))) for k in SIZES if (OUT / k).exists())
    size_mb = sum(f.stat().st_size for f in OUT.rglob("*.webp")) / 1e6
    print(f"{total} icons, {size_mb:.1f} MB in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
