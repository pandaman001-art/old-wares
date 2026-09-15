"""取得元の共通インターフェース。"""

from __future__ import annotations

import abc
import json
import time

from ..cache import Cache
from ..models import Listing, SourceResult


class SourceError(RuntimeError):
    """取得元から正常な結果が得られなかった。"""


class BaseSource(abc.ABC):
    key: str = ""
    label: str = ""

    def __init__(self, *, timeout: float = 20.0, cache: Cache | None = None):
        self.timeout = timeout
        self.cache = cache

    # --- 実装すべきもの -------------------------------------------------
    @abc.abstractmethod
    def search_url(self, query: str, **options) -> str:
        """人間がブラウザで開ける検索 URL（UI から「元データを見る」ために使う）。"""

    @abc.abstractmethod
    def fetch(self, query: str, *, limit: int, **options) -> list[Listing]:
        """実売データを取得する。失敗時は SourceError を送出する。"""

    # --- 共通処理 -------------------------------------------------------
    def _cache_key(self, query: str, limit: int, options: dict) -> str:
        return json.dumps(
            {"source": self.key, "q": query, "limit": limit, "opt": options},
            sort_keys=True,
            ensure_ascii=False,
        )

    def collect(self, query: str, *, limit: int = 120, **options) -> SourceResult:
        """fetch をキャッシュ・計測・例外処理で包んで SourceResult にする。"""
        result = SourceResult(source=self.key, label=self.label)
        try:
            result.search_url = self.search_url(query, **options)
        except Exception:  # URL 生成の失敗で全体を落とさない
            result.search_url = None

        cache_key = self._cache_key(query, limit, options)
        if self.cache:
            cached = self.cache.get(cache_key)
            if cached is not None:
                result.listings = [Listing.from_dict(row) for row in cached]
                result.cached = True
                result.elapsed_ms = 0
                return result

        started = time.perf_counter()
        try:
            result.listings = self.fetch(query, limit=limit, **options)
        except SourceError as exc:
            result.error = str(exc)
        except Exception as exc:  # noqa: BLE001 - 片方が落ちても他方は返したい
            result.error = f"{type(exc).__name__}: {exc}"
        finally:
            result.elapsed_ms = int((time.perf_counter() - started) * 1000)

        if self.cache and result.ok and result.listings:
            self.cache.set(cache_key, [x.to_dict() for x in result.listings])
        return result
