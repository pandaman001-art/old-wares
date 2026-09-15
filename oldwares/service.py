"""貼り付けられた明細から相場を組み立てる。"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field

from . import stats as stats_mod
from .models import Blend, Listing, SearchResult, SourceResult
from .normalize import DEFAULT_MAX_PRICE, DEFAULT_MIN_PRICE, apply_filters, normalize_query
from .parsing import ParsedEntry, parse_pasted_text

OUTLIER_REASON = "外れ値(IQR)"

# 既定の入力グループ（この 2 つの中央値の平均が「相場」になる）
DEFAULT_GROUPS: tuple[tuple[str, str], ...] = (
    ("yahoo", "ヤフオク（落札価格）"),
    ("mercari", "メルカリ（売り切れ）"),
)

# 検索ページを開くためのリンク。ここから先は人が見てコピーする
SEARCH_PAGE_TEMPLATES = {
    "yahoo": "https://auctions.yahoo.co.jp/closedsearch/closedsearch?p={q}&n=100&s1=end&o1=d",
    "mercari": "https://jp.mercari.com/search?keyword={q}&status=sold_out&order=desc&sort=created_time",
}


@dataclass
class InputGroup:
    """1 サイトぶんの貼り付け内容。"""

    key: str
    label: str
    text: str = ""
    entries: list[ParsedEntry] | None = None


@dataclass
class QuoteOptions:
    price_min: int | None = None
    price_max: int | None = None
    exclude_words: list[str] = field(default_factory=list)
    use_default_excludes: bool = True
    remove_outliers: bool = True
    iqr_k: float = stats_mod.DEFAULT_IQR_K


def _mark_outliers(listings: list[Listing], k: float) -> int:
    """IQR の外にある明細に印をつけ、除いた件数を返す。"""
    kept = [x for x in listings if not x.excluded]
    bounds = stats_mod.iqr_bounds([x.price for x in kept], k)
    if bounds is None:
        return 0
    low, high = bounds
    removed = [x for x in kept if not (low <= x.price <= high)]
    if len(removed) == len(kept):  # 全件落ちる異常ケースでは何もしない
        return 0
    for listing in removed:
        listing.excluded = True
        listing.exclude_reason = OUTLIER_REASON
    return len(removed)


def _to_listings(key: str, entries: list[ParsedEntry]) -> list[Listing]:
    return [
        Listing(source=key, item_id=f"{key}-{i:04d}", title=entry.title, price=entry.price)
        for i, entry in enumerate(entries)
    ]


def _build_group(group: InputGroup, query: str, options: QuoteOptions) -> SourceResult:
    result = SourceResult(source=group.key, label=group.label)
    if group.entries is not None:
        entries = list(group.entries)
        result.parse = {"mode": "direct", "prices_found": len(entries), "untitled": 0, "lines": len(entries)}
    else:
        report = parse_pasted_text(group.text)
        entries = report.entries
        result.parse = report.to_dict()
        if report.lines and not entries:
            result.error = (
                "貼り付けたテキストから金額を 1 件も読み取れませんでした。"
                "価格が「¥12,800」や「12,800円」の形で含まれているか確認してください。"
            )
            result.stats = stats_mod.compute([])
            return result

    result.listings = _to_listings(group.key, entries)
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
    """入力グループごとの代表値を等ウェイトで平均する（＝両サイトの平均）。"""
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


def search_page_url(key: str, query: str) -> str:
    """ユーザーが自分でブラウザで開くための検索ページ URL。"""
    from urllib.parse import quote as urlquote

    template = SEARCH_PAGE_TEMPLATES.get(key)
    return template.format(q=urlquote(query)) if template else ""


def quote(query: str, groups: list[InputGroup], options: QuoteOptions | None = None) -> SearchResult:
    """貼り付け内容から相場を出す。1 グループだけでも成立する。"""
    options = options or QuoteOptions()
    normalized = normalize_query(query)
    result = SearchResult(query=normalized)

    result.sources = [_build_group(group, normalized, options) for group in groups]

    pooled = [x.price for r in result.sources for x in r.kept]
    result.combined = stats_mod.compute(pooled)
    result.blend = _blend(result.sources)
    result.histogram = stats_mod.histogram(
        {r.label: [x.price for x in r.kept] for r in result.sources if r.kept}
    )

    for source_result in result.sources:
        if source_result.error:
            result.warnings.append(f"{source_result.label}: {source_result.error}")

    thin = [r.label for r in result.sources if not r.error and r.stats and 0 < r.stats.count < 5]
    if thin:
        result.warnings.append("件数が少ないため相場の信頼度は低めです: " + " / ".join(thin))
    if result.combined.count == 0 and not any(r.error for r in result.sources):
        result.warnings.append("価格が入力されていません。検索結果をコピーして貼り付けてください。")
    elif len(result.blend.sources_used) == 1:
        result.warnings.append(
            "片方のサイトだけで計算しています。両方貼るとサイト差を均した相場になります。"
        )
    return result
