import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compute, histogram, iqrBounds, niceStep, percentile } from "../js/stats.js";

describe("compute", () => {
  it("要約統計を返す", () => {
    const result = compute([1000, 2000, 3000, 4000, 5000]);
    assert.equal(result.count, 5);
    assert.equal(result.min, 1000);
    assert.equal(result.max, 5000);
    assert.equal(result.median, 3000);
    assert.equal(result.mean, 3000);
    assert.equal(result.p25, 2000);
    assert.equal(result.p75, 4000);
    assert.equal(result.iqr, 2000);
  });

  it("空なら count 以外は null", () => {
    const result = compute([]);
    assert.equal(result.count, 0);
    assert.equal(result.median, null);
    assert.equal(result.iqr, null);
  });

  it("1 件でも落ちない", () => {
    const result = compute([5000]);
    assert.equal(result.count, 1);
    assert.equal(result.median, 5000);
    assert.equal(result.stdev, 0);
  });

  it("入力の順序に依存しない", () => {
    assert.deepEqual(compute([3, 1, 2, 5000]), compute([5000, 2, 1, 3]));
  });
});

describe("percentile", () => {
  it("線形補間する", () => {
    assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
    assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5);
  });

  it("要素 1 つならその値", () => {
    assert.equal(percentile([42], 0.9), 42);
  });
});

describe("iqrBounds", () => {
  it("件数が足りなければ除去しない", () => {
    assert.equal(iqrBounds([1, 2, 3]), null);
  });

  it("ばらつきが無ければ除去しない", () => {
    assert.equal(iqrBounds(new Array(20).fill(100)), null);
  });

  it("外れ値が境界の外に出る", () => {
    const bounds = iqrBounds([1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 900000]);
    assert.ok(bounds);
    assert.ok(900000 > bounds[1]);
    assert.ok(1000 >= bounds[0]);
  });
});

describe("niceStep", () => {
  it("キリのよい刻みに丸める", () => {
    assert.deepEqual([1, 3, 237, 1001, 0].map(niceStep), [1, 5, 250, 2000, 1]);
  });
});

describe("histogram", () => {
  it("すべての値がいずれかのビンに入る", () => {
    const h = histogram([
      { name: "a", prices: [1000, 2000, 9000] },
      { name: "b", prices: [1500, 8000] },
    ]);
    assert.deepEqual(h.series, ["a", "b"]);
    assert.ok(h.edges[0] <= 1000);
    assert.ok(h.edges[h.edges.length - 1] >= 9000);
    assert.equal(h.counts.length, h.edges.length - 1);
    assert.equal(h.counts.flat().reduce((a, b) => a + b, 0), 5);
  });

  it("最大値は最終ビンに含まれる", () => {
    const h = histogram([{ name: "a", prices: [100, 200, 300, 400, 500] }]);
    assert.equal(h.counts.flat().reduce((a, b) => a + b, 0), 5);
  });

  it("同じ値だけでも落ちない", () => {
    const h = histogram([{ name: "a", prices: [5000, 5000] }]);
    assert.equal(h.counts.flat().reduce((a, b) => a + b, 0), 2);
  });

  it("空なら空を返す", () => {
    assert.deepEqual(histogram([{ name: "a", prices: [] }]).counts, []);
  });
});
