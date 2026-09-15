"""検索の組み立て：複数取得元を並列に叩き、フィルタして相場を出す。"""

from __future__ import annotations

import statistics
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from . import stats as stats_mod
from .cache import Cache
from .models import Blend, Listing, SearchResult, SourceResult
from .normalize import DEFAULT_MAX_PRICE, DEFAULT_MIN_PRICE, apply_filters, dedupe, normalize_query
from .sources import DEFAULT_SOURCES, build_source

OUTLIER_REASON = "外れ値(IQR)"
MAX_LIMIT = 480


@dataclass
class SearchOptions:
    sources: tuple[str, ...] = DEFAULT_SOURCES
    limit: int = 120
    price_min: int | None = None
    price_max: int | None = None
    exclude_words: list[str] = field(default_factory=list)
    use_default_excludes: bool = True
    remove_outliers: bool = True
    iqr_k: float = stats_mod.DEFAULT_IQR_K
    timeout: float = 20.0
    cache_ttl: int = 30 * 60

    def clamped_limit(self) -> int:
        return max(1, min(MAX_LIMIT, self.limit))


def _mark_outliers(listings: list[Listing], k: float) -> int:
    """IQR の外にある出品に印をつけ、除いた件数を返す。"""
    kept = [x for x in listings if not x.excluded]
    bounds = stats_mod.iqr_bounds([x.price for x in kept], k)
    if bounds is None:
        return 0
    low, high = bounds
    removed = 0
    for listing in kept:
        if not (low <= listing.price <= high):
            listing.excluded = True
            listing.exclude_reason = OUTLIER_REASON
            removed += 1
    # 全件落ちる異常ケースでは巻き戻す
    if removed == len(kept):
        for listing in kept:
            if listing.exclude_reason == OUTLIER_REASON:
                listing.excluded = False
                listing.exclude_reason = None
        return 0
    return removed


def _finalize_source(result: SourceResult, query: str, options: SearchOptions) -> SourceResult:
    result.listings = dedupe(result.listings)
    apply_filters(
        result.listings,
        query=query,
        exclude_words=options.exclude_words,
        use_defaults=options.use_default_excludes,
        min_price=options.price_min or DEFAULT_MIN_PRICE,
        max_price=options.price_max or DEFAULT_MAX_PRICE,
    )
    result.excluded_count = sum(1 for x in result.listings if x.excluded)
    if options.remove_outliers:
        result.outlier_count = _mark_outliers(result.listings, options.iqr_k)
    result.stats = stats_mod.compute(x.price for x in result.kept)
    return result


def _blend(results: list[SourceResult]) -> Blend:
    """取得元ごとの代表値を等ウェイトで平均する（＝両サイトの平均）。"""
    usable = [r for r in results if r.stats and r.stats.count > 0]
    if not usable:
        return Blend()
    medians = [r.stats.median for r in usable if r.stats.median is not None]
    means = [r.stats.mean for r in usable if r.stats.mean is not None]
    pooled = [x.price for r in usable for x in r.kept]
    return Blend(
        equal_weight_median=round(statistics.fmean(medians)) if medians else None,
        equal_weight_mean=round(statistics.fmean(means)) if means else None,
        weighted_mean=round(statistics.fmean(pooled)) if pooled else None,
        sources_used=[r.source for r in usable],
    )


def search(query: str, options: SearchOptions | None = None) -> SearchResult:
    """query の相場を調べる。取得元の片方が落ちても、もう片方の結果は返す。"""
    options = options or SearchOptions()
    normalized = normalize_query(query)
    result = SearchResult(query=normalized)
    if not normalized:
        result.warnings.append("検索語が空です。")
        return result

    cache = Cache(ttl=options.cache_ttl)
    limit = options.clamped_limit()

    def run(key: str) -> SourceResult:
        try:
            source = build_source(key, timeout=options.timeout, cache=cache)
        except KeyError:
            return SourceResult(source=key, label=key, error=f"未知の取得元: {key}")
        return source.collect(
            normalized,
            limit=limit,
            price_min=options.price_min,
            price_max=options.price_max,
        )

    keys = list(options.sources) or list(DEFAULT_SOURCES)
    with ThreadPoolExecutor(max_workers=max(1, len(keys))) as pool:
        result.sources = list(pool.map(run, keys))

    for source_result in result.sources:
        if source_result.ok:
            _finalize_source(source_result, normalized, options)
        else:
            source_result.stats = stats_mod.compute([])
            result.warnings.append(f"{source_result.label}: {source_result.error}")

    pooled = [x.price for r in result.sources for x in r.kept]
    result.combined = stats_mod.compute(pooled)
    result.blend = _blend(result.sources)
    result.histogram = stats_mod.histogram(
        {r.label: [x.price for x in r.kept] for r in result.sources if r.kept}
    )

    thin = [r.label for r in result.sources if r.ok and r.stats and r.stats.count < 5]
    if thin:
        result.warnings.append(
            "サンプル数が少ないため相場の信頼度は低めです: " + " / ".join(thin)
        )
    if result.combined.count == 0 and not any(not r.ok for r in result.sources):
        result.warnings.append("条件に合う実売データが見つかりませんでした。検索語を短くしてみてください。")
    return result
