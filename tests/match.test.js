import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { brandAliases, chooseBasis, classify, matchTier, TIER_BRAND, TIER_LOOSE, TIER_MODEL } from "../js/match.js";

const TARGET = { brand: { canonical: "ノースフェイス" }, modelNumbers: ["ND91841"] };

describe("matchTier", () => {
  it("品番が含まれていれば model", () => {
    assert.equal(matchTier("THE NORTH FACE ヌプシ ND91841 L", TARGET), TIER_MODEL);
  });

  it("品番のハイフンや空白は無視して照合する", () => {
    assert.equal(matchTier("ノースフェイス ND-91841 ダウン", TARGET), TIER_MODEL);
    assert.equal(matchTier("ノースフェイス ND 91841 ダウン", TARGET), TIER_MODEL);
  });

  it("ブランドだけなら brand", () => {
    assert.equal(matchTier("ノースフェイス ヌプシ 700 M", TARGET), TIER_BRAND);
  });

  it("英字表記のブランドも brand として拾う", () => {
    assert.equal(matchTier("THE NORTH FACE マウンテンパーカー", TARGET), TIER_BRAND);
  });

  it("どちらも無ければ loose", () => {
    assert.equal(matchTier("アディダス ジャージ上下", TARGET), TIER_LOOSE);
  });

  it("短すぎる品番は照合に使わない（偶然の一致を防ぐ）", () => {
    assert.equal(matchTier("ノースフェイス 501 デニム", { modelNumbers: ["501"] }), TIER_LOOSE);
  });

  it("空のタイトルは loose", () => {
    assert.equal(matchTier("", TARGET), TIER_LOOSE);
  });
});

describe("brandAliases", () => {
  it("表にあるブランドは表記ゆれをすべて返す", () => {
    const aliases = brandAliases("ノースフェイス");
    assert.ok(aliases.includes("THE NORTH FACE"));
    assert.ok(aliases.includes("TNF"));
  });

  it("英字の別名からも引ける", () => {
    assert.ok(brandAliases("THE NORTH FACE").includes("ノースフェイス"));
  });

  it("表に無いブランドはその名前だけ", () => {
    assert.deepEqual(brandAliases("架空ブランド"), ["架空ブランド"]);
  });
});

describe("chooseBasis", () => {
  const make = (tiers) => tiers.map((tier, i) => ({ tier, price: 1000 + i, excluded: false }));

  it("品番一致が 3 件以上あればそれだけを土台にする", () => {
    const listings = make([TIER_MODEL, TIER_MODEL, TIER_MODEL, TIER_BRAND, TIER_LOOSE]);
    const basis = chooseBasis(listings);
    assert.equal(basis.tier, TIER_MODEL);
    assert.equal(basis.count, 3);
    assert.deepEqual(listings.map((l) => l.inBasis), [true, true, true, false, false]);
  });

  it("品番一致が足りなければブランド一致まで広げる", () => {
    const listings = make([TIER_MODEL, TIER_BRAND, TIER_BRAND, TIER_LOOSE]);
    const basis = chooseBasis(listings);
    assert.equal(basis.tier, TIER_BRAND);
    assert.equal(basis.count, 3);
    assert.deepEqual(listings.map((l) => l.inBasis), [true, true, true, false]);
  });

  it("どちらも足りなければ全件に落とす", () => {
    const listings = make([TIER_BRAND, TIER_LOOSE, TIER_LOOSE]);
    const basis = chooseBasis(listings);
    assert.equal(basis.tier, "all");
    assert.equal(basis.count, 3);
  });

  it("商品を特定していなければ層別しない", () => {
    const listings = make([TIER_LOOSE, TIER_LOOSE, TIER_LOOSE, TIER_LOOSE]);
    assert.equal(chooseBasis(listings, { hasTarget: false }).tier, "all");
  });

  it("除外済みの明細は土台に入れない", () => {
    const listings = make([TIER_MODEL, TIER_MODEL, TIER_MODEL]);
    listings[0].excluded = true;
    const basis = chooseBasis(listings);
    assert.equal(basis.counts[TIER_MODEL], 2);
    assert.equal(listings[0].inBasis, false);
  });
});

describe("classify", () => {
  it("target が無ければ全件 loose", () => {
    const listings = [{ title: "ノースフェイス ND91841" }];
    classify(listings, null);
    assert.equal(listings[0].tier, TIER_LOOSE);
  });

  it("target があれば一致の強さを書き込む", () => {
    const listings = [{ title: "ノースフェイス ND91841" }, { title: "アディダス" }];
    classify(listings, TARGET);
    assert.deepEqual(listings.map((l) => l.tier), [TIER_MODEL, TIER_LOOSE]);
  });
});
