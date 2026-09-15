"""取得結果の簡易ディスクキャッシュ。

同じ語で何度も叩いて相手サイトに負荷をかけないための最低限の仕組み。
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

DEFAULT_TTL_SECONDS = 30 * 60


def default_dir() -> Path:
    env = os.environ.get("OLDWARES_CACHE_DIR")
    if env:
        return Path(env)
    return Path.home() / ".cache" / "oldwares"


class Cache:
    def __init__(self, directory: Path | str | None = None, ttl: int = DEFAULT_TTL_SECONDS):
        self.dir = Path(directory) if directory else default_dir()
        self.ttl = ttl
        self.enabled = ttl > 0

    def _path(self, key: str) -> Path:
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
        return self.dir / f"{digest}.json"

    def get(self, key: str) -> Any | None:
        if not self.enabled:
            return None
        path = self._path(key)
        try:
            payload = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if time.time() - payload.get("stored_at", 0) > self.ttl:
            return None
        return payload.get("value")

    def set(self, key: str, value: Any) -> None:
        if not self.enabled:
            return
        path = self._path(key)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            # 同時実行で壊れた JSON を読まないよう、一時ファイル経由で置き換える
            fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump({"stored_at": time.time(), "value": value}, fh, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError:
            # キャッシュは best-effort。書けなくても検索自体は続行する
            pass

    def clear(self) -> int:
        removed = 0
        if not self.dir.exists():
            return 0
        for path in self.dir.glob("*.json"):
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
        return removed
