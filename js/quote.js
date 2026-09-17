// 貼り付けられた明細から相場を組み立てる。

import { chooseBasis, classify, TIER_LABELS } from "./match.js";
import { applyFilters, DEFAULT_MAX_PRICE, DEFAULT_MIN_PRICE, normalizeQuery } from "./normalize.js";
import { parsePastedText } from "./parsing.js";
import { compute, DEFAULT_IQR_K, histogram, iqrBounds } from "./stats.js";

export const OUTLIER_REASON = "外れ値(IQR)";

// 警告文で使う、層を土台とみなす最小件数（match.js の MIN_BASIS_COUNT と揃える）
const MIN_MATCHES_FOR_NOTE = 3;

/** 既定の入力グループ（この 2 つの中央値の平均が「相場」になる）。 */
export const DEFAULT_GROUPS = [
  { key: "yahoo", label: "ヤフオク（落札価格）" },
  { key: "mercari", label: "メルカリ（売り切れ）" },
];

// 検索ページを開くためのリンク。ここから先は人が見てコピーする
const SEARCH_PAGE_TEMPLATES = {
  yahoo: (q) => `https://auctions.yahoo.co.jp/closedsearch/closedsearch?p=${q}&n=100&s1=end&o1=d`,
  mercari: (q) => `https://jp.mercari.com/search?keyword=${q}&status=sold_out&order=desc&sort=created_time`,
};

/** 利用者が自分でブラウザで開くための検索ページ URL。 */
export function searchPageUrl(key, query) {
  const template = SEARCH_PAGE_TEMPLATES[key];
  return template ? template(encodeURIComponent(query)) : "";
}

/** IQR の外にある明細に印をつけ、除いた件数を返す。相場の土台にした層だけを見る。 */
function markOutliers(listings, k) {
  const kept = listings.filter((x) => !x.excluded && x.inBasis);
  const bounds = iqrBounds(kept.map((x) => x.price), k);
  if (!bounds) return 0;
  const [low, high] = bounds;
  const removed = kept.filter((x) => x.price < low || x.price > high);
  if (removed.length === kept.length) return 0; // 全件落ちる異常ケースでは何もしない
  for (const listing of removed) {
    listing.excluded = true;
    listing.excludeReason = OUTLIER_REASON;
    listing.inBasis = false;
  }
  return removed.length;
}

function buildGroup(group, query, options) {
  const result = {
    source: group.key,
    label: group.label,
    listings: [],
    stats: compute([]),
    excludedCount: 0,
    outlierCount: 0,
    parse: { mode: "flow", lines: 0, pricesFound: 0, untitled: 0, ignoredSamples: [] },
    error: null,
  };

  let entries;
  if (group.entries) {
    entries = group.entries;
    result.parse = { mode: "direct", lines: entries.length, pricesFound: entries.length, untitled: 0, ignoredSamples: [] };
  } else {
    const report = parsePastedText(group.text || "");
    entries = report.entries;
    result.parse = report;
    if (report.lines && !entries.length) {
      result.error =
        "貼り付けたテキストから金額を 1 件も読み取れませんでした。" +
        "価格が「¥12,800」や「12,800円」の形で含まれているか確認してください。";
      return result;
    }
  }

  result.listings = entries.map((entry, i) => ({
    source: group.key,
    itemId: `${group.key}-${String(i).padStart(4, "0")}`,
    title: entry.title,
    price: entry.price,
    excluded: false,
    excludeReason: null,
  }));

  applyFilters(result.listings, {
    query,
    excludeWords: options.excludeWords,
    useDefaults: options.useDefaultExcludes,
    minPrice: options.priceMin || DEFAULT_MIN_PRICE,
    maxPrice: options.priceMax || DEFAULT_MAX_PRICE,
  });
  return result;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

/** 入力グループごとの代表値を等ウェイトで平均する（＝両サイトの平均）。 */
function blend(results) {
  const usable = results.filter((r) => r.stats.count > 0);
  if (!usable.length) {
    return { equalWeightMedian: null, equalWeightMean: null, weightedMean: null, sourcesUsed: [] };
  }
  const pooled = usable.flatMap((r) => basisOf(r).map((x) => x.price));
  return {
    equalWeightMedian: Math.round(mean(usable.map((r) => r.stats.median))),
    equalWeightMean: Math.round(mean(usable.map((r) => r.stats.mean))),
    weightedMean: Math.round(mean(pooled)),
    sourcesUsed: usable.map((r) => r.source),
  };
}

/** 相場の土台にした明細。 */
const basisOf = (source) => source.listings.filter((x) => x.inBasis);

/** 貼り付け内容から相場を出す。1 グループだけでも成立する。 */
export function quote(query, groups, options = {}) {
  const opts = {
    priceMin: null,
    priceMax: null,
    excludeWords: [],
    useDefaultExcludes: true,
    removeOutliers: true,
    iqrK: DEFAULT_IQR_K,
    target: null,
    ...options,
  };
  const normalized = normalizeQuery(query);
  const sources = groups.map((group) => buildGroup(group, normalized, opts));

  // 一致の強さで層に分け、どの層を相場の土台にするかは両サイトまとめて決める。
  // サイトごとに土台が違うと、平均する 2 つの中央値が別のものを指してしまう
  const all = sources.flatMap((source) => source.listings);
  const hasTarget = Boolean(opts.target?.modelNumbers?.length || opts.target?.brand);
  classify(all, hasTarget ? opts.target : null);
  const basis = chooseBasis(all, { hasTarget });

  for (const source of sources) {
    if (opts.removeOutliers) source.outlierCount = markOutliers(source.listings, opts.iqrK);
    source.excludedCount = source.listings.filter((x) => x.excluded).length;
    source.stats = compute(basisOf(source).map((x) => x.price));
  }

  const result = {
    query: normalized,
    generatedAt: new Date().toISOString(),
    sources,
    match: {
      ...basis,
      hasTarget,
      label: TIER_LABELS[basis.tier] || TIER_LABELS.all,
      // 土台にした明細の価格。判定（verdict.js）はこれを使う
      prices: sources.flatMap((source) => basisOf(source).map((x) => x.price)),
    },
    combined: compute(sources.flatMap((r) => basisOf(r).map((x) => x.price))),
    blend: blend(sources),
    histogram: histogram(
      sources.filter((r) => basisOf(r).length).map((r) => ({ name: r.label, prices: basisOf(r).map((x) => x.price) }))
    ),
    warnings: [],
  };

  for (const source of sources) {
    if (source.error) result.warnings.push(`${source.label}: ${source.error}`);
  }
  if (hasTarget && basis.tier === "all") {
    result.warnings.push(
      `品番もブランドも一致する出品が ${MIN_MATCHES_FOR_NOTE} 件に届かないため、貼り付けた全件で計算しています。` +
      "別の商品が混ざっている可能性があるので、この相場は参考程度にしてください。"
    );
  } else if (basis.tier === "brand" && basis.counts.model > 0) {
    result.warnings.push(
      `品番が一致したのは ${basis.counts.model} 件だけなので、ブランド一致まで広げて計算しています。`
    );
  }
  const thin = sources.filter((r) => !r.error && r.stats.count > 0 && r.stats.count < 5).map((r) => r.label);
  if (thin.length) result.warnings.push("件数が少ないため相場の信頼度は低めです: " + thin.join(" / "));
  if (result.combined.count === 0 && !sources.some((r) => r.error)) {
    result.warnings.push("価格が入力されていません。検索結果をコピーして貼り付けてください。");
  } else if (result.blend.sourcesUsed.length === 1) {
    result.warnings.push("片方のサイトだけで計算しています。両方貼るとサイト差を均した相場になります。");
  }
  return result;
}
