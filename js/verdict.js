// 値札の金額が妥当かを判断する材料をそろえる。
//
// 相場はあくまで材料のひとつ。中央値ひとつで「買い」「高い」と言い切ると、
// 実物の状態やサイズを見ずに数字だけで決めることになる。
// ここでは判定と一緒に「なぜそう言えるのか」と「どれだけ当てにならないか」を返す。
//
// 自分で着るために買う前提。転売の手数料や送料は引かない。

import { percentile } from "./stats.js";
import { TIER_BRAND, TIER_MODEL } from "./match.js";

/** 実物の状態。状態が良いほど、相場の高いほうと比べる。 */
export const CONDITIONS = [
  { key: "new", label: "新品・タグ付き", quantile: 0.80 },
  { key: "mint", label: "美品", quantile: 0.65 },
  { key: "normal", label: "並・使用感あり", quantile: 0.50 },
  { key: "worn", label: "難あり・傷汚れ", quantile: 0.30 },
];

export const DEFAULT_CONDITION = "normal";

const conditionOf = (key) =>
  CONDITIONS.find((c) => c.key === key) || CONDITIONS.find((c) => c.key === DEFAULT_CONDITION);

/**
 * 値札 ÷ その状態の相場 で判定する。
 * 幅は中古服の値付けのばらつきに合わせてゆるめに取ってある。
 * ここを狭くすると「やや高い」が出続けて判断の役に立たない。
 */
const BANDS = [
  { key: "bargain", label: "安い", tone: "good", max: 0.75 },
  { key: "cheap", label: "やや安い", tone: "good", max: 0.92 },
  { key: "fair", label: "相場どおり", tone: "neutral", max: 1.12 },
  { key: "pricey", label: "やや高い", tone: "warning", max: 1.35 },
  { key: "overpriced", label: "高い", tone: "critical", max: Infinity },
];

// これを下回る件数では相場と呼べない
const MIN_PRICES = 3;

function bandFor(ratio) {
  return BANDS.find((band) => ratio <= band.max) || BANDS[BANDS.length - 1];
}

/** 相場の当てになり具合。素性・件数・ばらつきの 3 つで決める。 */
export function assessConfidence({ tier, count, median, iqr }) {
  const reasons = [];
  let score = 0;

  if (tier === TIER_MODEL) {
    score += 2;
    reasons.push({ tone: "good", text: "品番が一致した出品だけで計算している" });
  } else if (tier === TIER_BRAND) {
    score += 1;
    reasons.push({ tone: "warning", text: "ブランドしか一致していない。別の型が混ざっている可能性がある" });
  } else {
    reasons.push({ tone: "warning", text: "商品を特定していないため、何が混ざっているか分からない" });
  }

  if (count >= 12) {
    score += 2;
    reasons.push({ tone: "good", text: `${count} 件で計算している` });
  } else if (count >= 8) {
    score += 1;
    reasons.push({ tone: "neutral", text: `${count} 件。もう少し集めると安定する` });
  } else if (count >= 5) {
    reasons.push({ tone: "warning", text: `${count} 件。中央値が 1〜2 件の差で動く` });
  } else {
    score -= 1;
    reasons.push({ tone: "warning", text: `${count} 件しかない。相場と呼べる数ではない` });
  }

  const spread = median > 0 ? iqr / median : null;
  // 件数が少ないうちは、ばらつきが小さく見えてもそれは偶然。加点の材料にしない
  if (spread !== null) {
    if (spread <= 0.5 && count >= 8) {
      score += 1;
      reasons.push({ tone: "good", text: "価格のばらつきが小さい" });
    } else if (spread > 1.0) {
      score -= 1;
      reasons.push({ tone: "warning", text: "価格のばらつきが大きい。状態やサイズの差が効いている" });
    }
  }

  // 品番が一致していないのに「当てになる」とは言わせない。
  // 件数とばらつきがどれだけ良くても、別の型が混ざっていれば相場そのものが別物になる
  let level = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  if (tier !== TIER_MODEL && level === "high") level = "medium";
  // 5 件未満は何と一致していようが相場と呼べない
  if (count < 5) level = "low";
  return {
    level,
    label: { high: "高い", medium: "ふつう", low: "低い" }[level],
    score,
    spread: spread === null ? null : Math.round(spread * 100) / 100,
    reasons,
  };
}

/**
 * 値札の金額を、集めた価格と突き合わせる。
 *
 * prices は相場の土台にした明細の価格（外れ値を除いたあと）。
 * 返り値の factors が「判断材料」で、画面にはこれを並べる。
 */
export function judge({
  shopPrice,
  prices = [],
  condition = DEFAULT_CONDITION,
  tier = "all",
  // 画面に出している相場（両サイトの中央値の平均）。判定の基準をこれに合わせる。
  // 揃えないと「相場 ¥18,325」の隣で「相場 ¥18,500 と比べた」と出て、どちらが本当か分からなくなる
  anchor = null,
} = {}) {
  const values = [...prices].map(Number).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const cond = conditionOf(condition);

  if (!Number.isFinite(shopPrice) || shopPrice <= 0) {
    return { ok: false, reason: "値札の金額を入れてください。", condition: cond };
  }
  if (values.length < MIN_PRICES) {
    return {
      ok: false,
      reason: `相場を出すには実売データが ${MIN_PRICES} 件以上必要です（いま ${values.length} 件）。`,
      condition: cond,
    };
  }

  const mid = percentile(values, 0.5);
  const base = Number.isFinite(anchor) && anchor > 0 ? anchor : mid;
  // 状態が良ければ相場の高いほう、悪ければ低いほうと比べる。
  // 分布の形はそのままに、画面の相場を基準に伸縮させる
  const target = Math.round(mid > 0 ? base * (percentile(values, cond.quantile) / mid) : base);
  const median = Math.round(mid);
  const iqr = Math.round(percentile(values, 0.75) - percentile(values, 0.25));
  const ratio = target > 0 ? shopPrice / target : null;
  const band = bandFor(ratio);
  const cheaper = values.filter((v) => v < shopPrice).length;
  const positionPct = Math.round((cheaper / values.length) * 100);
  const confidence = assessConfidence({ tier, count: values.length, median, iqr });

  const factors = [
    {
      key: "ratio",
      label: "相場との差",
      value: `${Math.round(ratio * 100)}%`,
      note: `${cond.label}なら ${yen(target)} あたり。値札は ${yen(shopPrice)}`,
      tone: band.tone,
    },
    {
      key: "position",
      label: "分布の位置",
      value: `下から ${positionPct}%`,
      note: `集めた ${values.length} 件のうち ${cheaper} 件がこれより安い`,
      tone: "neutral",
    },
    {
      key: "basis",
      label: "何と比べたか",
      value: { [TIER_MODEL]: "品番一致", [TIER_BRAND]: "ブランド一致", all: "全件" }[tier] || "全件",
      note: confidence.reasons[0].text,
      tone: confidence.reasons[0].tone,
    },
    {
      key: "confidence",
      label: "相場の当てになり具合",
      value: confidence.label,
      note: confidence.reasons.slice(1).map((r) => r.text).join(" / "),
      tone: confidence.level === "high" ? "good" : confidence.level === "low" ? "warning" : "neutral",
    },
  ];

  return {
    ok: true,
    condition: cond,
    shopPrice,
    target,
    median,
    ratio: Math.round(ratio * 100) / 100,
    verdict: band,
    positionPct,
    count: values.length,
    confidence,
    factors,
    // 相場に出てこない材料。数字だけで決めさせないために必ず添える
    offBook: [
      "実物の傷・汚れ・毛玉・匂い（写真の出品より厳しく見る）",
      "サイズが自分に合うか（中古は返品できない）",
      "いま着る季節か（オフシーズンの相場は下がる）",
    ],
  };
}

function yen(n) {
  return "¥" + Number(n).toLocaleString("ja-JP");
}
