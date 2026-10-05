"""部署前的第二道閘門：HTML 裡所有相對路徑都必須指向實際存在的檔案。

只檢查相對路徑。站內錨點與外部連結不檢查——錨點由 JS 與版面保證，
外部連結在部署當下沒有理由被 CI 擋下來。

用法：python tools/check_links.py [根目錄]
"""

from __future__ import annotations

import pathlib
import re
import sys

ATTR = re.compile(r"""(?:href|src)\s*=\s*["']([^"']+)["']""", re.I)

SKIP_SCHEMES = ("#", "http://", "https://", "mailto:", "tel:", "data:", "//", "javascript:")


def main() -> int:
    root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

    problems: list[str] = []
    checked = 0
    pages = sorted(p for p in root.rglob("*.html") if ".git" not in p.parts)

    for page in pages:
        text = page.read_text(encoding="utf-8")
        for raw in ATTR.findall(text):
            url = raw.strip()
            if not url or url.startswith(SKIP_SCHEMES):
                continue
            path = url.split("#", 1)[0].split("?", 1)[0]
            if not path:
                continue
            checked += 1
            if not (page.parent / path).exists():
                problems.append(f"{page.as_posix()} → {raw}")

    if problems:
        print("::error::斷鏈")
        print("\n".join(problems))
        return 1

    print(f"OK：{len(pages)} 個頁面、{checked} 條相對連結全部指向存在的檔案")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
