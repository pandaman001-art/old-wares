"""取得元のレジストリ。"""

from __future__ import annotations

from ..cache import Cache
from .base import BaseSource, SourceError
from .mercari import MercariSource
from .sample import SampleSource
from .yahoo_auction import YahooAuctionSource

# 既定で使う取得元（この 2 つの平均が「相場」になる）
DEFAULT_SOURCES = ("yahoo", "mercari")
DEMO_SOURCES = ("demo-yahoo", "demo-mercari")


def build_source(key: str, *, timeout: float = 20.0, cache: Cache | None = None) -> BaseSource:
    if key == "yahoo":
        return YahooAuctionSource(timeout=timeout, cache=cache)
    if key == "mercari":
        return MercariSource(timeout=timeout, cache=cache)
    if key == "demo-yahoo":
        return SampleSource("demo-yahoo", "デモ：ヤフオク相当", center=9800, timeout=timeout, cache=cache)
    if key == "demo-mercari":
        return SampleSource("demo-mercari", "デモ：メルカリ相当", center=11200, timeout=timeout, cache=cache)
    raise KeyError(f"unknown source: {key}")


def available_sources() -> list[dict[str, str]]:
    return [
        {"key": "yahoo", "label": YahooAuctionSource.label, "kind": "live"},
        {"key": "mercari", "label": MercariSource.label, "kind": "live"},
        {"key": "demo-yahoo", "label": "デモ：ヤフオク相当", "kind": "demo"},
        {"key": "demo-mercari", "label": "デモ：メルカリ相当", "kind": "demo"},
    ]


__all__ = [
    "BaseSource",
    "SourceError",
    "MercariSource",
    "SampleSource",
    "YahooAuctionSource",
    "DEFAULT_SOURCES",
    "DEMO_SOURCES",
    "available_sources",
    "build_source",
]
