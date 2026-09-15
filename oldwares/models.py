"""アプリ全体で共有するデータ構造。"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any


def _jsonable(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _jsonable(v) for k, v in dataclasses.asdict(value).items()}
    return value


@dataclass
class Listing:
    """1 件の実売データ（落札 / 売り切れ）。"""

    source: str
    item_id: str
    title: str
    price: int
    url: str
    sold_at: date | None = None
    condition: str | None = None
    image_url: str | None = None
    # 除外フィルタに引っかかった場合、理由を残したうえで統計からは外す
    excluded: bool = False
    exclude_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(self)

    @classmethod
    def from_dict(cls, row: dict[str, Any]) -> "Listing":
        """to_dict() の逆変換（キャッシュの読み戻し用）。未知のキーは無視する。"""
        known = {f.name for f in dataclasses.fields(cls)}
        data = {k: v for k, v in row.items() if k in known}
        sold_at = data.get("sold_at")
        if isinstance(sold_at, str):
            try:
                data["sold_at"] = date.fromisoformat(sold_at[:10])
            except ValueError:
                data["sold_at"] = None
        return cls(**data)


@dataclass
class PriceStats:
    """価格の要約統計。件数 0 のときは count 以外すべて None。"""

    count: int
    min: int | None = None
    p25: int | None = None
    median: int | None = None
    p75: int | None = None
    max: int | None = None
    mean: int | None = None
    stdev: int | None = None

    @property
    def iqr(self) -> int | None:
        if self.p25 is None or self.p75 is None:
            return None
        return self.p75 - self.p25

    def to_dict(self) -> dict[str, Any]:
        out = _jsonable(self)
        out["iqr"] = self.iqr
        return out


@dataclass
class SourceResult:
    """1 つの取得元（ヤフオク / メルカリ）の結果。"""

    source: str
    label: str
    listings: list[Listing] = field(default_factory=list)
    stats: PriceStats | None = None
    excluded_count: int = 0
    outlier_count: int = 0
    search_url: str | None = None
    elapsed_ms: int | None = None
    error: str | None = None
    cached: bool = False

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def kept(self) -> list[Listing]:
        return [x for x in self.listings if not x.excluded]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "label": self.label,
            "ok": self.ok,
            "error": self.error,
            "cached": self.cached,
            "search_url": self.search_url,
            "elapsed_ms": self.elapsed_ms,
            "fetched_count": len(self.listings),
            "used_count": self.stats.count if self.stats else 0,
            "excluded_count": self.excluded_count,
            "outlier_count": self.outlier_count,
            "stats": self.stats.to_dict() if self.stats else None,
            "listings": [x.to_dict() for x in self.listings],
        }


@dataclass
class Blend:
    """複数取得元をまとめた「相場」の数値。"""

    # 取得元ごとの中央値を等ウェイトで平均したもの（本ツールの推奨値）
    equal_weight_median: int | None = None
    # 取得元ごとの平均を等ウェイトで平均したもの
    equal_weight_mean: int | None = None
    # 全件をプールした平均（＝件数で加重した平均と一致する）
    weighted_mean: int | None = None
    sources_used: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(self)


@dataclass
class Histogram:
    """価格分布。bins × series のカウントを持つ。"""

    edges: list[int] = field(default_factory=list)
    series: list[str] = field(default_factory=list)
    counts: list[list[int]] = field(default_factory=list)  # counts[bin][series]

    def to_dict(self) -> dict[str, Any]:
        return _jsonable(self)


@dataclass
class SearchResult:
    query: str
    sources: list[SourceResult] = field(default_factory=list)
    combined: PriceStats | None = None
    blend: Blend | None = None
    histogram: Histogram | None = None
    warnings: list[str] = field(default_factory=list)
    generated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        return {
            "query": self.query,
            "generated_at": self.generated_at.isoformat(),
            "sources": [s.to_dict() for s in self.sources],
            "combined": self.combined.to_dict() if self.combined else None,
            "blend": self.blend.to_dict() if self.blend else None,
            "histogram": self.histogram.to_dict() if self.histogram else None,
            "warnings": list(self.warnings),
        }
