// タグに書かれた文字やバーコードから、検索に使える語を組み立てる。
//
// 画像認識はしない。タグの文字（手で打つか、そのまま貼る）と JAN コードだけを見て、
// ブランド・品番・サイズを取り出し、絞り込みの強さ順に検索語の候補を並べる。
// 中古サイトは語を増やすほど件数が減るので、当たらなかったときに落とす先が要る。

import { BRANDS } from "./brands.js";

/** 照合用に整える。全角→半角、記号を空白に、大文字化。 */
function fold(text) {
  return (text || "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[・･,、。／/|｜:：;；()（）\[\]【】{}"'`~^*_＋+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BRAND_INDEX = BRANDS.flatMap((brand) =>
  [brand.canonical, ...brand.aliases].map((alias) => ({
    brand,
    alias,
    folded: fold(alias),
  }))
  // 長い別名から先に照合する（CARHARTT WIP が CARHARTT に食われないように）
).sort((a, b) => b.folded.length - a.folded.length);

// 品番。ND91841 / NP61800-K のような英字＋数字の並び（行をまたがないよう 1 行ずつ見る）
const MODEL_PATTERNS = [
  /\b[A-Z]{2,4}[- ]?\d{4,7}(?:[- ][A-Z0-9]{1,3})?\b/g,
  // 英字と数字が混ざった 5-14 文字の並び（ND91841 / 336N004N など）
  /\b(?=[A-Z0-9-]{5,14}\b)(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g,
  // 数字だけのハイフン付き品番（331-359039 など）。62-06 のような短いものは拾わない
  /\b\d{3}-\d{4,7}\b/g,
];
// 品番と紛らわしいが品番ではないもの
const MODEL_DENY = /^(?:JAN|EAN|UPC|NO|LOT|ART|STYLE|COLOR|SIZE|US|EU|UK|JP|FW|SS|AW)$/;
// 行まるごとが数字のとき、品番とみなす桁数（パタゴニアの 23056、リーバイスの 501 など）
const BARE_MODEL = /^\d{3,7}$/;
// 身長・ウエストとして現実的な範囲。これに収まる裸の数字はサイズとして扱う
const PLAUSIBLE_NUMERIC_SIZE = (value) => (value >= 70 && value <= 190) || (value >= 23 && value <= 46);

const SIZE_TOKEN = /^(?:XXS|XS|S|M|L|XL|XXL|XXXL|[234]XL|F|FREE|ONE SIZE|W\d{2}(?:\s*L\d{2})?|\d{2,3}\s*インチ|\d{2,3})$/;
const SIZE_LABEL = /(?:サイズ|SIZE|寸法)\s*[:：]?\s*([A-Z0-9インチ ]{1,12})/gi;

const MADE_IN = /(?:MADE IN\s+([A-Z]+)|(日本製|中国製|ベトナム製|イタリア製|アメリカ製|米国製))/i;
const MATERIAL = /(綿|コットン|COTTON|ウール|WOOL|ナイロン|NYLON|ポリエステル|POLYESTER|カシミヤ|CASHMERE|リネン|LINEN|レーヨン|RAYON|ダウン|DOWN|レザー|LEATHER|シルク|SILK)/gi;

// 検索語として役に立たない一般語
const STOP_WORDS = new Set([
  "MADE", "IN", "JAPAN", "CHINA", "VIETNAM", "USA", "ITALY", "KOREA", "OF", "THE", "AND",
  "SIZE", "COLOR", "COLOUR", "STYLE", "ART", "NO", "LOT", "CARE", "WASH", "DRY", "IRON",
  "BLEACH", "TUMBLE", "MACHINE", "HAND", "COLD", "WARM", "DO", "NOT", "PRODUCT", "IMPORTED",
  "取扱", "表示", "洗濯", "品質", "表示者", "製造", "販売", "株式会社", "有限会社",
  "表地", "裏地", "中わた", "中綿", "組成", "素材", "本体", "部分", "詰め物", "原産国",
  "液温", "上限", "手洗", "乾燥", "漂白", "アイロン", "生産国", "サイズ", "寸法", "品番", "型番",
  "日本製", "中国製", "ベトナム製", "イタリア製", "アメリカ製", "米国製",
]);

/** サイズ表記として妥当なら正規化した文字列、そうでなければ null。 */
function asSize(token) {
  const value = token.trim().replace(/\s+/g, " ");
  if (!value || !SIZE_TOKEN.test(value)) return null;
  const bare = value.match(/^(\d{2,3})$/);
  // 裸の数字は身長・ウエストの範囲に収まるときだけサイズ扱い（501 はサイズではない）
  if (bare && !PLAUSIBLE_NUMERIC_SIZE(Number(bare[1]))) return null;
  return value.replace(/\s+/g, "");
}

/** ブランド名らしい文字列を、中古サイトで使われる表記に寄せる。分からなければそのまま返す。 */
export function canonicalBrand(name) {
  const folded = fold(name || "");
  if (!folded) return null;
  const hit = BRAND_INDEX.find((entry) => entry.folded && folded.includes(entry.folded));
  return hit ? hit.brand.canonical : (name || "").trim() || null;
}

/**
 * タグのテキストから、ブランド・品番・サイズなどを取り出す。
 *
 * hint は AI に読ませたときの構造化結果。こちらのほうが確かなので優先する。
 * hint が無ければ従来どおりテキストだけから判定する。
 */
export function identify(text, hint = {}) {
  const raw = (text || "").trim();
  const normalized = raw.normalize("NFKC");
  const folded = fold(raw);
  const lines = normalized.split(/\r?\n/).map((line) => fold(line)).filter(Boolean);

  const brandHit = BRAND_INDEX.find((entry) => entry.folded && folded.includes(entry.folded));
  const brand = brandHit ? { canonical: brandHit.brand.canonical, matched: brandHit.alias } : null;

  const sizes = [];
  const pushSize = (token) => {
    const size = asSize(token);
    if (size && !sizes.includes(size)) sizes.push(size);
  };
  for (const match of normalized.matchAll(SIZE_LABEL)) pushSize(fold(match[1]));
  // ラベルが無くても、行まるごとがサイズ表記ならそれと見なす
  for (const line of lines) pushSize(line);

  const modelNumbers = [];
  const pushModel = (value) => {
    if (value && !modelNumbers.includes(value)) modelNumbers.push(value);
  };
  for (const line of lines) {
    for (const pattern of MODEL_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const value = match[0].replace(/\s+/g, "");
        if (MODEL_DENY.test(value.replace(/[-\d].*$/, ""))) continue;
        pushModel(value);
      }
    }
    // 行が数字だけ、かつサイズとして妥当でないなら品番とみなす
    if (BARE_MODEL.test(line) && !sizes.includes(line)) pushModel(line);
  }

  const madeInMatch = normalized.match(MADE_IN);
  const madeIn = madeInMatch ? madeInMatch[1] || madeInMatch[2] : null;
  const materials = [...new Set([...raw.matchAll(MATERIAL)].map((m) => m[1]))];

  // 残った語のうち、検索の足しになりそうなものだけ拾う
  const consumed = new Set([
    ...(brand ? fold(brand.matched).split(" ") : []),
    ...modelNumbers,
    ...sizes,
  ]);
  const materialWords = new Set(materials.map((m) => m.toUpperCase()));
  const keywords = folded
    .split(" ")
    .filter((word) => word.length >= 2 && !consumed.has(word) && !STOP_WORDS.has(word))
    // 「ナイロン100%」のような組成表記は検索の役に立たない
    .filter((word) => !/[\d%]/.test(word))
    .filter((word) => !materialWords.has(word))
    .filter((word, i, all) => all.indexOf(word) === i)
    .slice(0, 6);

  const merged = {
    brand: hint.brand ? { canonical: canonicalBrand(hint.brand), matched: hint.brand } : brand,
    modelNumbers: hint.modelNumbers?.length ? [...new Set(hint.modelNumbers)] : modelNumbers,
    sizes: hint.sizes?.length ? [...new Set(hint.sizes)] : sizes,
    madeIn: hint.madeIn || madeIn,
    materials: hint.materials?.length ? [...new Set(hint.materials)] : materials,
    keywords,
    raw,
  };
  // hint で埋まった語は「特徴」から外す（同じ語が二重に入らないように）
  const consumedByHint = new Set([
    ...(merged.brand ? fold(merged.brand.canonical).split(" ") : []),
    ...merged.modelNumbers.map((value) => fold(value)),
    ...merged.sizes.map((value) => fold(value)),
  ]);
  merged.keywords = merged.keywords.filter((word) => !consumedByHint.has(word));
  return merged;
}

/**
 * 絞り込みの強い順に検索語の候補を返す。
 * 中古サイトは語が多いほど 0 件になりやすいので、落とす先を必ず用意する。
 */
export function buildQueries(identified, extras = {}) {
  const { brand, modelNumbers, sizes, keywords } = identified;
  const { barcode = "", note = "" } = extras;
  const noteWords = fold(note).split(" ").filter(Boolean);
  const brandName = brand?.canonical || "";
  const model = modelNumbers[0] || "";
  const size = sizes[0] || "";
  const topic = [...noteWords, ...keywords].slice(0, 2).join(" ");

  // 候補の「決め手になる部分」が無いものは並べない。
  // 品番が無いのに「ブランド＋品番」を出すと、ブランドだけの弱い語が先頭に来てしまう。
  const candidates = [
    { parts: [barcode], label: "バーコードの番号で探す", needs: barcode },
    { parts: [brandName, model], label: "ブランド＋品番（いちばん絞れる）", needs: brandName && model },
    { parts: [model], label: "品番だけ", needs: model },
    { parts: [brandName, topic, size], label: "ブランド＋特徴＋サイズ", needs: brandName && topic && size },
    { parts: [brandName, topic], label: "ブランド＋特徴", needs: brandName && topic },
    { parts: [topic, size], label: "特徴＋サイズ", needs: !brandName && topic && size },
    { parts: [brandName, size], label: "ブランド＋サイズ", needs: brandName && size },
    { parts: [brandName], label: "ブランドだけ（件数は多い）", needs: brandName },
    { parts: [topic], label: "特徴だけ", needs: topic },
  ].filter((candidate) => candidate.needs);

  const seen = new Set();
  const queries = [];
  for (const candidate of candidates) {
    const query = candidate.parts.filter(Boolean).join(" ").trim();
    if (!query || seen.has(query)) continue;
    seen.add(query);
    queries.push({ query, label: candidate.label });
  }
  return queries;
}
