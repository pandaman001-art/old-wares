// 貼り付けた明細が、目の前の 1 着とどれだけ同じものかで層に分ける。
//
// 中古服の相場がいちばん狂うのは統計のせいではなく、集めた価格が別商品だから。
// 「ノースフェイス ダウン」で集めれば子供用 3,000 円とヌプシ 60,000 円が
// 同じ中央値に溶ける。品番まで一致する明細が十分あるなら、そちらだけで出す。

import { BRANDS } from "./brands.js";
import { fold } from "./identify.js";

/** 一致の強さ。model > brand > loose の順に確か。 */
export const TIER_MODEL = "model";
export const TIER_BRAND = "brand";
export const TIER_LOOSE = "loose";

export const TIER_LABELS = {
  [TIER_MODEL]: "品番まで一致",
  [TIER_BRAND]: "ブランドのみ一致",
  [TIER_LOOSE]: "手がかりなし",
  all: "全件",
};

// この件数を下回る層は相場の土台にしない。中央値が 1 件の外れで動いてしまう
export const MIN_BASIS_COUNT = 3;

// 短すぎる品番は商品名の一部にたまたま含まれる。4 文字以上だけを照合に使う
const MIN_MODEL_LENGTH = 4;

/** ハイフンと空白を落とした照合キー。「ND-91841」と「ND91841」を同じにする。 */
function compact(text) {
  return fold(text).replace(/[-\s]/g, "");
}

/** そのブランドの表記ゆれ一覧。表に無いブランドは与えられた名前だけを使う。 */
export function brandAliases(name) {
  const folded = fold(name || "");
  if (!folded) return [];
  const entry = BRANDS.find((brand) =>
    [brand.canonical, ...brand.aliases].some((alias) => fold(alias) === folded)
  );
  return entry ? [entry.canonical, ...entry.aliases] : [name];
}

/**
 * 出品タイトル 1 件の一致の強さ。
 * target は identify() の結果（brand と modelNumbers を見る）。
 */
export function matchTier(title, target = {}) {
  const folded = fold(title);
  if (!folded) return TIER_LOOSE;

  const compacted = compact(title);
  const models = (target.modelNumbers || [])
    .map(compact)
    .filter((model) => model.length >= MIN_MODEL_LENGTH);
  if (models.some((model) => compacted.includes(model))) return TIER_MODEL;

  const brandName = target.brand?.canonical || target.brand || "";
  const aliases = brandAliases(brandName).map(fold).filter(Boolean);
  if (aliases.some((alias) => folded.includes(alias))) return TIER_BRAND;

  return TIER_LOOSE;
}

/** listing に tier を書き込んで返す（破壊的）。target が無ければ全件 loose。 */
export function classify(listings, target = null) {
  for (const listing of listings) {
    listing.tier = target ? matchTier(listing.title, target) : TIER_LOOSE;
  }
  return listings;
}

/**
 * どの層を相場の土台にするか決める。
 * 品番一致が足りればそれだけ、駄目ならブランド一致まで広げ、
 * それも足りなければ全件に落とす。落とした事実は呼び出し側で表示すること。
 */
export function chooseBasis(listings, { minCount = MIN_BASIS_COUNT, hasTarget = true } = {}) {
  const usable = listings.filter((listing) => !listing.excluded);
  const counts = {
    [TIER_MODEL]: usable.filter((l) => l.tier === TIER_MODEL).length,
    [TIER_BRAND]: usable.filter((l) => l.tier === TIER_BRAND).length,
    [TIER_LOOSE]: usable.filter((l) => l.tier === TIER_LOOSE).length,
  };

  let tier = "all";
  if (hasTarget) {
    if (counts[TIER_MODEL] >= minCount) tier = TIER_MODEL;
    else if (counts[TIER_MODEL] + counts[TIER_BRAND] >= minCount) tier = TIER_BRAND;
  }

  const inBasis = (listing) => {
    if (tier === "all") return true;
    if (tier === TIER_MODEL) return listing.tier === TIER_MODEL;
    return listing.tier === TIER_MODEL || listing.tier === TIER_BRAND;
  };
  for (const listing of listings) listing.inBasis = !listing.excluded && inBasis(listing);

  return { tier, counts, count: usable.filter(inBasis).length };
}
