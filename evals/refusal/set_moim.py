#!/usr/bin/env python3
"""Set or remove AEGIS_MOIM_MESSAGE_TEXT in the aegis config.

  python set_moim.py --text "CANARIO ..."     # inline
  python set_moim.py --file tom_carrier.txt   # from file
  python set_moim.py --clear
"""

import argparse
import re
from pathlib import Path

CONFIG = Path("C:/Aegis-Proyects/state/config/config.yaml")
KEY = "AEGIS_MOIM_MESSAGE_TEXT"


def main() -> None:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--text")
    g.add_argument("--file")
    g.add_argument("--clear", action="store_true")
    args = ap.parse_args()

    cfg = CONFIG.read_text(encoding="utf-8")
    pattern = re.compile(rf"^{KEY}:.*?(?=^AEGIS_MODE:)", re.S | re.M)
    cfg = pattern.sub("", cfg)

    if args.clear:
        CONFIG.write_text(cfg, encoding="utf-8", newline="\n")
        print("cleared")
        return

    body = args.text if args.text is not None else Path(args.file).read_text(encoding="utf-8").strip()
    block = f"{KEY}: |\n" + "".join(("  " + line if line.strip() else "") + "\n" for line in body.splitlines())
    cfg = cfg.replace("AEGIS_MODE:", block + "AEGIS_MODE:", 1)
    CONFIG.write_text(cfg, encoding="utf-8", newline="\n")
    print(f"set: {len(body)} chars, {len(body.splitlines())} lines")


if __name__ == "__main__":
    main()
