import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BRANDS } from "../js/brands.js";
import { buildQueries, identify } from "../js/identify.js";

const NORTH_FACE_TAG = `THE NORTH FACE
ND91841
ヌプシ ジャケット
SIZE: L
表地 ナイロン100%
中わた ダウン90%
MADE IN CHINA`;

describe("ブランドの読み取り", () => {
  it("英字表記からカナの通称を引く", () => {
    assert.equal(identify("THE NORTH FACE").brand.canonical, "ノースフェイス");
    assert.equal(identify("patagonia").brand.canonical, "パタゴニア");
    assert.equal(identify("Levi's").brand.canonical, "リーバイス");
  });

  it("カナ表記でも引ける", () => {
    assert.equal(identify("ノースフェイス ダウン").brand.canonical, "ノースフェイス");
  });

  it("長い別名を優先する", () => {
    // CARHARTT WIP が CARHARTT に食われない
    assert.equal(identify("CARHARTT WIP").brand.matched, "CARHARTT WIP");
  });

  it("知らないブランドは null", () => {
    assert.equal(identify("ステンカラーコート").brand, null);
  });

  it("別名に重複が無い", () => {
    const all = BRANDS.flatMap((b) => [b.canonical, ...b.aliases].map((a) => a.toUpperCase()));
    assert.equal(new Set(all).size, all.length);
  });
});

describe("品番の読み取り", () => {
  it("英字＋数字の品番を拾う", () => {
    assert.deepEqual(identify(NORTH_FACE_TAG).modelNumbers, ["ND91841"]);
  });

  it("行をまたいで繋げない", () => {
    // 「RETRO-X」の X と次の行の 23056 を繋いで X23056 にしない
    const found = identify("patagonia\nRETRO-X\n23056\nSIZE M");
    assert.deepEqual(found.modelNumbers, ["23056"]);
  });

  it("数字だけの行も品番として扱う", () => {
    assert.deepEqual(identify("Levi's\n501\nW32 L34").modelNumbers, ["501"]);
  });

  it("サイズとして妥当な数字は品番にしない", () => {
    const found = identify("ユニクロ\nキッズ ダウンジャケット\n120");
    assert.deepEqual(found.modelNumbers, []);
    assert.deepEqual(found.sizes, ["120"]);
  });

  it("ラベル語を品番と間違えない", () => {
    assert.deepEqual(identify("SIZE 1234").modelNumbers, []);
  });
});

describe("サイズの読み取り", () => {
  it("ラベル付きのサイズ", () => {
    assert.deepEqual(identify("SIZE: L").sizes, ["L"]);
    assert.deepEqual(identify("サイズ M").sizes, ["M"]);
  });

  it("行まるごとがサイズ表記", () => {
    assert.deepEqual(identify("ダウンジャケット\nXL").sizes, ["XL"]);
  });

  it("ウエスト表記", () => {
    assert.deepEqual(identify("Levi's\nW32 L34").sizes, ["W32L34"]);
  });

  it("501 はサイズではない", () => {
    assert.ok(!identify("Levi's\n501").sizes.includes("501"));
  });
});

describe("その他の読み取り", () => {
  it("産地と素材", () => {
    const found = identify(NORTH_FACE_TAG);
    assert.equal(found.madeIn, "CHINA");
    assert.deepEqual(found.materials, ["ナイロン", "ダウン"]);
  });

  it("日本製を拾う", () => {
    assert.equal(identify("ステンカラーコート\n日本製").madeIn, "日本製");
  });

  it("組成や取扱表示は検索語にしない", () => {
    const { keywords } = identify(NORTH_FACE_TAG);
    assert.deepEqual(keywords, ["ヌプシ", "ジャケット"]);
  });

  it("空文字でも落ちない", () => {
    const found = identify("");
    assert.equal(found.brand, null);
    assert.deepEqual(found.modelNumbers, []);
    assert.deepEqual(found.keywords, []);
  });
});

describe("検索語の候補", () => {
  it("絞り込みの強い順に並ぶ", () => {
    const queries = buildQueries(identify(NORTH_FACE_TAG));
    assert.equal(queries[0].query, "ノースフェイス ND91841");
    assert.equal(queries[1].query, "ND91841");
    assert.ok(queries.some((q) => q.query === "ノースフェイス"));
    // 落とす先が必ずある
    assert.ok(queries.length >= 3);
  });

  it("バーコードがあれば最優先", () => {
    const queries = buildQueries(identify(NORTH_FACE_TAG), { barcode: "4901234567894" });
    assert.equal(queries[0].query, "4901234567894");
  });

  it("品番が無いときにブランドだけの語を先頭に出さない", () => {
    const queries = buildQueries(identify("ユニクロ\nキッズ ダウンジャケット\n120"));
    assert.equal(queries[0].query, "ユニクロ キッズ ダウンジャケット 120");
    assert.equal(queries.at(-1).query, "キッズ ダウンジャケット");
  });

  it("ブランドが分からなくても候補を作る", () => {
    const queries = buildQueries(identify("ステンカラーコート\nサイズ M"));
    assert.deepEqual(queries.map((q) => q.query), ["ステンカラーコート M", "ステンカラーコート"]);
  });

  it("手入力の言葉を特徴として混ぜる", () => {
    const queries = buildQueries(identify("THE NORTH FACE\nSIZE L"), { note: "ヌプシ" });
    assert.ok(queries.some((q) => q.query === "ノースフェイス ヌプシ L"));
  });

  it("重複した候補は 1 つにまとめる", () => {
    const queries = buildQueries(identify("CHAMPION"));
    assert.equal(new Set(queries.map((q) => q.query)).size, queries.length);
  });

  it("何も無ければ空", () => {
    assert.deepEqual(buildQueries(identify("")), []);
  });
});
