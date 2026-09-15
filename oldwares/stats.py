"""価格の要約統計・外れ値除去・ヒストグラム生成。"""

from __future__ import annotations

import math
import statistics
from collections.abc import Iterable, Sequence

from .models import Histogram, PriceStats

# IQR 法の係数。中古服は「まとめ売り」や「別物ヒット」で上振れしやすいので
# 既定は緩めの 1.5（Tukey の標準）にしておく。
DEFAULT_IQR_K = 1.5


def percentile(sorted_values: Sequence[float], q: float) -> float:
    """線形補間つきパーセンタイル（q は 0.0-1.0）。入力は昇順ソート済みであること。"""
    if not sorted_values:
        raise ValueError("empty sequence")
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    pos = (len(sorted_values) - 1) * q
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return float(sorted_values[int(pos)])
    frac = pos - lo
    return float(sorted_values[lo]) * (1 - frac) + float(sorted_values[hi]) * frac


def compute(prices: Iterable[int]) -> PriceStats:
    """要約統計を返す。金額は円単位の整数に丸める。"""
    values = sorted(int(p) for p in prices)
    if not values:
        return PriceStats(count=0)
    return PriceStats(
        count=len(values),
        min=values[0],
        p25=round(percentile(values, 0.25)),
        median=round(percentile(values, 0.50)),
        p75=round(percentile(values, 0.75)),
        max=values[-1],
        mean=round(statistics.fmean(values)),
        stdev=round(statistics.stdev(values)) if len(values) >= 2 else 0,
    )


def iqr_bounds(prices: Iterable[int], k: float = DEFAULT_IQR_K) -> tuple[float, float] | None:
    """外れ値判定の下限・上限。件数が少なすぎる場合は None（＝除去しない）。"""
    values = sorted(int(p) for p in prices)
    if len(values) < 8:
        return None
    q1 = percentile(values, 0.25)
    q3 = percentile(values, 0.75)
    spread = q3 - q1
    if spread <= 0:
        return None
    return (q1 - k * spread, q3 + k * spread)


def split_outliers(
    prices: Sequence[int], k: float = DEFAULT_IQR_K
) -> tuple[list[int], list[int]]:
    """(残す価格, 外れ値) に分ける。順序は入力順を保つ。"""
    bounds = iqr_bounds(prices, k)
    if bounds is None:
        return list(prices), []
    low, high = bounds
    kept = [p for p in prices if low <= p <= high]
    dropped = [p for p in prices if not (low <= p <= high)]
    # 全部落ちるような極端なケースでは除去しない
    if not kept:
        return list(prices), []
    return kept, dropped


def nice_step(raw: float) -> int:
    """raw 以上で最も小さい「キリのよい」刻み幅（1/2/2.5/5 × 10^n）を返す。"""
    if raw <= 0:
        return 1
    exp = math.floor(math.log10(raw))
    base = 10.0**exp
    for mult in (1, 2, 2.5, 5, 10):
        step = mult * base
        if step >= raw:
            return max(1, int(round(step)))
    return max(1, int(round(10 * base)))


def _suggest_bin_count(values: Sequence[int]) -> int:
    """Freedman-Diaconis 相当のビン数を 8-20 にクランプして返す。"""
    n = len(values)
    if n < 2:
        return 1
    ordered = sorted(values)
    spread = percentile(ordered, 0.75) - percentile(ordered, 0.25)
    width = ordered[-1] - ordered[0]
    if spread <= 0 or width <= 0:
        return max(1, min(8, n))
    fd_width = 2 * spread / (n ** (1 / 3))
    if fd_width <= 0:
        return 10
    return int(max(8, min(20, math.ceil(width / fd_width))))


def histogram(series_prices: dict[str, Sequence[int]], bins: int | None = None) -> Histogram:
    """取得元ごとに積み上げられるヒストグラムを作る。

    ビンの区切りは全取得元をプールした値域から決め、各取得元は同じ区切りで数える。
    """
    series = [name for name in series_prices]
    pooled = [p for name in series for p in series_prices[name]]
    if not pooled:
        return Histogram(edges=[], series=series, counts=[])

    lo, hi = min(pooled), max(pooled)
    if lo == hi:
        step = max(1, nice_step(max(1, lo // 10)))
        edges = [lo, lo + step]
    else:
        count = bins or _suggest_bin_count(pooled)
        step = nice_step((hi - lo) / count)
        start = (lo // step) * step
        edges = []
        edge = start
        while edge <= hi:
            edges.append(int(edge))
            edge += step
        edges.append(int(edge))

    counts = [[0 for _ in series] for _ in range(len(edges) - 1)]
    for s_idx, name in enumerate(series):
        for price in series_prices[name]:
            # 最終ビンだけ上端を含める
            idx = min(len(counts) - 1, max(0, (int(price) - edges[0]) // (edges[1] - edges[0])))
            counts[int(idx)][s_idx] += 1
    return Histogram(edges=edges, series=series, counts=counts)
