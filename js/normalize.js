// 検索語の正規化と、相場から外すべき出品の判定。
//
// 中古服の実売データは「まとめ売り」「ジャンク」などが混ざると中央値が簡単に歪むので、
// 統計に入れる前に落とす。

/** 既定の除外ルール。理由つきで持っておき、UI に「なぜ落としたか」を出す。 */
export const DEFAULT_EXCLUDE_RULES = [
  [/まとめ売り|まとめて|おまとめ|大量|詰め合わせ|福袋/, "まとめ売り"],
  // 「セットアップ」は上下セットの正規商品なので除外しない
  [/セット(?!アップ)/, "セット売り"],
  // 「汚れあり」「破れ」単体は出品状態の記載としてよく使われ、正常な出品まで落とすので入れない
  [/ジャンク|訳あり|わけあり|難あり|要修理|補修前提/, "難あり"],
  [/レプリカ|コピー品|複製|偽物|疑い/, "レプリカ/真贋"],
  [/キッズ|子供服|こども服|ベビー|ペット用|犬用|猫用/, "対象違い"],
  [/型紙|生地のみ|カタログ|雑誌|写真集|ポスター|チラシ|DVD/, "商品違い"],
  [/ハンガーのみ|タグのみ|袋のみ|空箱|付属品のみ|パーツのみ/, "本体でない"],
];

// 中古服として現実的な価格帯の既定ガード
export const DEFAULT_MIN_PRICE = 300;
export const DEFAULT_MAX_PRICE = 3_000_000;

/** 全角英数・カナを正規化し、空白を詰める。比較・照合用。 */
export function normalizeText(text) {
  return (text || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export const normalizeQuery = normalizeText;

/** ユーザー指定の除外語。正規表現ではなく素の文字列として扱う。 */
export function compileExtraExcludes(words) {
  return (words || [])
    .map((word) => normalizeText(word))
    .filter(Boolean)
    .map((word) => [new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), `除外語: ${word}`]);
}

/**
 * 検索語自体に当たる既定ルールは無効化する。
 * 「キッズ ダウン」を探しているのに「キッズ」で全部落とす、といった事故を防ぐ。
 */
export function defaultRulesForQuery(query) {
  const normalized = normalizeText(query);
  return DEFAULT_EXCLUDE_RULES.filter(([pattern]) => !pattern.test(normalized));
}

/** 統計から外す理由。外す必要がなければ null。 */
export function exclusionReason(listing, {
  extraRules = [],
  defaultRules = DEFAULT_EXCLUDE_RULES,
  minPrice = DEFAULT_MIN_PRICE,
  maxPrice = DEFAULT_MAX_PRICE,
} = {}) {
  if (listing.price < minPrice) return `下限価格(${minPrice.toLocaleString("ja-JP")}円)未満`;
  if (listing.price > maxPrice) return `上限価格(${maxPrice.toLocaleString("ja-JP")}円)超`;

  const title = normalizeText(listing.title);
  for (const [pattern, reason] of [...defaultRules, ...extraRules]) {
    if (pattern.test(title)) return reason;
  }
  return null;
}

/** listing に excluded / excludeReason を書き込んで返す（破壊的）。 */
export function applyFilters(listings, {
  query = "",
  excludeWords = [],
  useDefaults = true,
  minPrice = DEFAULT_MIN_PRICE,
  maxPrice = DEFAULT_MAX_PRICE,
} = {}) {
  const extraRules = compileExtraExcludes(excludeWords);
  const defaultRules = useDefaults ? defaultRulesForQuery(query) : [];
  for (const listing of listings) {
    const reason = exclusionReason(listing, { extraRules, defaultRules, minPrice, maxPrice });
    listing.excluded = reason !== null;
    listing.excludeReason = reason;
  }
  return listings;
}
