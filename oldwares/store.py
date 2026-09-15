"""調べた相場を保存しておく。

たまにしか使わない道具なので、前回いくらだったかを後から見返せることに意味がある。
1 件 = 1 つの JSON ファイル。DB は使わない。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$")


def default_dir() -> Path:
    env = os.environ.get("OLDWARES_DATA_DIR")
    if env:
        return Path(env)
    return Path.home() / ".local" / "share" / "oldwares"


@dataclass
class Record:
    id: str
    query: str
    created_at: str
    groups: list[dict[str, str]] = field(default_factory=list)
    summary: dict[str, Any] = field(default_factory=dict)
    note: str = ""

    def meta(self) -> dict[str, Any]:
        """一覧表示用の軽い辞書（貼り付け本文は含めない）。"""
        return {
            "id": self.id,
            "query": self.query,
            "created_at": self.created_at,
            "note": self.note,
            "summary": self.summary,
        }

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class RecordStore:
    def __init__(self, directory: Path | str | None = None):
        self.dir = Path(directory) if directory else default_dir()

    def _path(self, record_id: str) -> Path:
        if not ID_RE.match(record_id):
            raise ValueError(f"不正な ID: {record_id}")
        return self.dir / f"{record_id}.json"

    @staticmethod
    def new_id(now: datetime | None = None) -> str:
        stamp = (now or datetime.now(timezone.utc)).strftime("%Y%m%d-%H%M%S")
        return f"{stamp}-{secrets.token_hex(2)}"

    def save(
        self,
        query: str,
        groups: list[dict[str, str]],
        summary: dict[str, Any],
        note: str = "",
    ) -> Record:
        now = datetime.now(timezone.utc)
        record = Record(
            id=self.new_id(now),
            query=query,
            created_at=now.isoformat(),
            groups=groups,
            summary=summary,
            note=note,
        )
        self.dir.mkdir(parents=True, exist_ok=True)
        # 途中で落ちても壊れた JSON を残さないよう、一時ファイル経由で置き換える
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(record.to_dict(), fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self._path(record.id))
        return record

    def get(self, record_id: str) -> Record | None:
        try:
            payload = json.loads(self._path(record_id).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        known = {"id", "query", "created_at", "groups", "summary", "note"}
        return Record(**{k: v for k, v in payload.items() if k in known})

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        """新しい順のメタ情報。壊れたファイルは黙って飛ばす。"""
        if not self.dir.exists():
            return []
        records = []
        for path in sorted(self.dir.glob("*.json"), reverse=True)[:limit]:
            record = self.get(path.stem)
            if record:
                records.append(record.meta())
        return records

    def delete(self, record_id: str) -> bool:
        try:
            self._path(record_id).unlink()
            return True
        except (OSError, ValueError):
            return False
