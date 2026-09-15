// 価格の要約統計・外れ値判定・ヒストグラム生成。

export const DEFAULT_IQR_K = 1.5;

/** 線形補間つきパーセンタイル（q は 0.0-1.0）。入力は昇順ソート済みであること。 */
export function percentile(sorted, q) {
  if (!sorted.length) throw new Error("empty sequence");
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] * (hi - pos) + sorted[hi] * (pos - lo);
}

/** 要約統計。金額は円単位の整数に丸める。件数 0 なら count 以外 null。 */
export function compute(prices) {
  const values = [...prices].map(Number).sort((a, b) => a - b);
  if (!values.length) {
    return { count: 0, min: null, p25: null, median: null, p75: null, max: null,
             mean: null, stdev: null, iqr: null };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const p25 = Math.round(percentile(values, 0.25));
  const p75 = Math.round(percentile(values, 0.75));
  const variance = values.length >= 2
    ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return {
    count: values.length,
    min: values[0],
    p25,
    median: Math.round(percentile(values, 0.5)),
    p75,
    max: values[values.length - 1],
    mean: Math.round(mean),
    stdev: Math.round(Math.sqrt(variance)),
    iqr: p75 - p25,
  };
}

/** 外れ値判定の下限・上限。件数が少なすぎる／ばらつきが無い場合は null（＝除去しない）。 */
export function iqrBounds(prices, k = DEFAULT_IQR_K) {
  const values = [...prices].map(Number).sort((a, b) => a - b);
  if (values.length < 8) return null;
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const spread = q3 - q1;
  if (spread <= 0) return null;
  return [q1 - k * spread, q3 + k * spread];
}

/** raw 以上で最も小さい「キリのよい」刻み幅（1/2/2.5/5 × 10^n）。 */
export function niceStep(raw) {
  if (raw <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(raw));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    const step = mult * base;
    if (step >= raw) return Math.max(1, Math.round(step));
  }
  return Math.max(1, Math.round(10 * base));
}

/** Freedman-Diaconis 相当のビン数を 8-20 にクランプして返す。 */
function suggestBinCount(values) {
  const n = values.length;
  if (n < 2) return 1;
  const ordered = [...values].sort((a, b) => a - b);
  const spread = percentile(ordered, 0.75) - percentile(ordered, 0.25);
  const width = ordered[n - 1] - ordered[0];
  if (spread <= 0 || width <= 0) return Math.max(1, Math.min(8, n));
  const fdWidth = (2 * spread) / Math.cbrt(n);
  if (fdWidth <= 0) return 10;
  return Math.max(8, Math.min(20, Math.ceil(width / fdWidth)));
}

/**
 * 取得元ごとに積み上げられるヒストグラム。
 * series: [{ name, prices }] — ビンの区切りは全系列をプールした値域から決める。
 */
export function histogram(series, bins = null) {
  const names = series.map((s) => s.name);
  const pooled = series.flatMap((s) => s.prices);
  if (!pooled.length) return { edges: [], series: names, counts: [] };

  const lo = Math.min(...pooled);
  const hi = Math.max(...pooled);
  let edges;
  if (lo === hi) {
    const step = Math.max(1, niceStep(Math.max(1, Math.floor(lo / 10))));
    edges = [lo, lo + step];
  } else {
    const step = niceStep((hi - lo) / (bins || suggestBinCount(pooled)));
    edges = [];
    for (let edge = Math.floor(lo / step) * step; edge <= hi; edge += step) edges.push(edge);
    edges.push(edges[edges.length - 1] + step);
  }

  const width = edges[1] - edges[0];
  const counts = Array.from({ length: edges.length - 1 }, () => names.map(() => 0));
  series.forEach((entry, sIndex) => {
    for (const price of entry.prices) {
      // 最終ビンだけ上端を含める
      const index = Math.min(counts.length - 1, Math.max(0, Math.floor((price - edges[0]) / width)));
      counts[index][sIndex] += 1;
    }
  });
  return { edges, series: names, counts };
}
