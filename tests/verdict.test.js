import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessConfidence, CONDITIONS, judge } from "../js/verdict.js";

// 10,000 〜 25,000 円に散らばる 16 件。中央値 17,150
const PRICES = [9800, 11800, 12500, 13200, 14000, 14800, 15500, 16800,
                17500, 18500, 18800, 19800, 20000, 21000, 21500, 23800];

describe("judge", () => {
  it("相場よりだいぶ安ければ「安い」", () => {
    const result = judge({ shopPrice: 8000, prices: PRICES, tier: "model" });
    assert.equal(result.ok, true);
    assert.equal(result.verdict.label, "安い");
    assert.equal(result.verdict.tone, "good");
  });

  it("相場どおりなら「相場どおり」", () => {
    assert.equal(judge({ shopPrice: 17500, prices: PRICES }).verdict.label, "相場どおり");
  });

  it("相場よりだいぶ高ければ「高い」", () => {
    const result = judge({ shopPrice: 30000, prices: PRICES });
    assert.equal(result.verdict.label, "高い");
    assert.equal(result.verdict.tone, "critical");
  });

  it("状態が良いほど高い値段まで許す", () => {
    const worn = judge({ shopPrice: 17000, prices: PRICES, condition: "worn" });
    const mint = judge({ shopPrice: 17000, prices: PRICES, condition: "mint" });
    assert.ok(mint.target > worn.target);
    assert.ok(mint.ratio < worn.ratio);
  });

  it("画面に出している相場（anchor）を判定の基準にする", () => {
    // anchor を渡すと、並のときの基準はちょうどその値になる
    const result = judge({ shopPrice: 10000, prices: PRICES, condition: "normal", anchor: 20000 });
    assert.equal(result.target, 20000);
  });

  it("anchor が無ければ集めた価格の中央値を使う", () => {
    assert.equal(judge({ shopPrice: 10000, prices: PRICES, condition: "normal" }).target, 17150);
  });

  it("分布の中での位置を返す", () => {
    const result = judge({ shopPrice: 15000, prices: PRICES });
    assert.equal(result.positionPct, 38); // 16 件中 6 件がこれより安い
  });

  it("値段を入れていなければ判定しない", () => {
    assert.equal(judge({ shopPrice: NaN, prices: PRICES }).ok, false);
    assert.equal(judge({ shopPrice: 0, prices: PRICES }).ok, false);
  });

  it("件数が足りなければ判定せず、理由を返す", () => {
    const result = judge({ shopPrice: 5000, prices: [1000, 2000] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /3 件以上/);
  });

  it("判断材料を 4 つ返す", () => {
    const keys = judge({ shopPrice: 15000, prices: PRICES }).factors.map((f) => f.key);
    assert.deepEqual(keys, ["ratio", "position", "basis", "confidence"]);
  });

  it("相場に出てこない材料を必ず添える", () => {
    assert.ok(judge({ shopPrice: 15000, prices: PRICES }).offBook.length >= 3);
  });
});

describe("assessConfidence", () => {
  const solid = { count: 16, median: 17000, iqr: 6000 };

  it("品番一致・件数十分・ばらつき小なら高い", () => {
    assert.equal(assessConfidence({ tier: "model", ...solid }).level, "high");
  });

  it("品番が一致していなければ、他が良くても高いとは言わない", () => {
    assert.equal(assessConfidence({ tier: "brand", ...solid }).level, "medium");
    assert.equal(assessConfidence({ tier: "all", ...solid }).level, "medium");
  });

  it("件数が少なければ低い", () => {
    assert.equal(assessConfidence({ tier: "model", count: 3, median: 17000, iqr: 6000 }).level, "low");
  });

  it("ばらつきが大きければ下がる", () => {
    const tight = assessConfidence({ tier: "model", count: 16, median: 17000, iqr: 5000 });
    const wide = assessConfidence({ tier: "model", count: 16, median: 17000, iqr: 25000 });
    assert.ok(wide.score < tight.score);
  });

  it("なぜそう判断したかを文章で返す", () => {
    const reasons = assessConfidence({ tier: "brand", ...solid }).reasons;
    assert.ok(reasons.length >= 2);
    assert.ok(reasons.every((r) => typeof r.text === "string" && r.text.length > 0));
  });
});

describe("CONDITIONS", () => {
  it("状態が良いほど高いほうの分位を見る", () => {
    const quantiles = CONDITIONS.map((c) => c.quantile);
    assert.deepEqual(quantiles, [...quantiles].sort((a, b) => b - a));
  });
});
