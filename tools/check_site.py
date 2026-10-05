"""部署前的第一道閘門：網站內容不得出現簡體字。

刻意不使用 OpenCC 的 s2t 整句轉換——它連異體字與地區用詞也會動，
會把本來就正確的台灣繁體字改掉（例如「台灣」變「臺灣」、「游泳」變「遊泳」）。
這裡只認純「簡→繁」單字對照，而且黑名單裡每一個碼位都經過人工確認是**簡體字本身**，
不是它的繁體對應字，所以不需要 allow 清單。

黑名單以 Unicode 碼位表示，註解也不放簡體字實例，
否則檢查器會先抓到自己的黑名單。

唯一的例外：教學用途必須展示簡繁對照的那一行，可以加上
`data-audit="skip"` 明示豁免——豁免必須寫在畫面上，不藏在設定裡。

用法：python tools/check_site.py [根目錄]
"""

from __future__ import annotations

import pathlib
import sys

# 會讓繁體讀者看不懂的常用簡體字，以 Unicode 碼位表示
BLACKLIST_CP = (
    0x4E60,  # practice a skill (simplified-only form)
    0x5B66,  # study
    0x8F6F,  # soft
    0x7F51,  # net
    0x6570,  # number / digit
    0x89C6,  # view
    0x8BED,  # language
    0x542C,  # listen
    0x8BF4,  # speak
    0x8BFB,  # read
    0x5199,  # write
    0x76D1,  # monitor
    0x6D4B,  # test
    0x8BD5,  # try
    0x9645,  # international
    0x9898,  # question / topic
    0x7ED3,  # knot / result
    0x6784,  # construct
    0x7EC4,  # group
    0x89C1,  # see
    0x9875,  # page
    0x8F66,  # vehicle
    0x9A6C,  # horse
    0x9C7C,  # fish
    0x957F,  # long (simplified form; traditional is a different codepoint)
    0x95E8,  # gate
    0x95EE,  # ask
    0x98CE,  # wind
    0x98DE,  # fly
)

CHECK_SUFFIXES = {".html", ".css", ".js", ".md", ".yml", ".yaml", ".txt"}

# 本檔案自己含黑名單碼位，是預期的，不算違規
SELF = pathlib.Path(__file__).resolve()

SKIP_MARKER = 'data-audit="skip"'


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

    targets = [
        p
        for p in sorted(root.rglob("*"))
        if p.is_file()
        and p.suffix.lower() in CHECK_SUFFIXES
        and ".git" not in p.parts
        and p.resolve() != SELF
    ]

    hits: list[str] = []
    skipped = 0
    for path in targets:
        text = path.read_text(encoding="utf-8", errors="ignore")
        for lineno, line in enumerate(text.splitlines(), 1):
            if any(chr(cp) in line for cp in BLACKLIST_CP):
                if SKIP_MARKER in line:
                    skipped += 1
                    continue
                for cp in BLACKLIST_CP:
                    if chr(cp) in line:
                        hits.append(f"{path.as_posix()}:{lineno}  U+{cp:04X}")

    if hits:
        print("::error::發現簡體字")
        print("\n".join(hits[:40]))
        if len(hits) > 40:
            print(f"…另有 {len(hits) - 40} 處")
        return 1

    note = f"（{skipped} 行為明示豁免）" if skipped else ""
    print(f"OK：{len(targets)} 個檔案，0 處簡體字{note}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
