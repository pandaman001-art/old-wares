import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRequest, DEFAULT_MODEL, parseResponse } from "../js/ai.js";

describe("buildRequest", () => {
  const request = buildRequest("QkFTRTY0");

  it("画像とプロンプトを 1 つの内容として送る", () => {
    assert.equal(request.contents.length, 1);
    const [image, prompt] = request.contents[0].parts;
    assert.deepEqual(image.inlineData, { mimeType: "image/jpeg", data: "QkFTRTY0" });
    assert.ok(prompt.text.includes("タグ"));
  });

  it("上下逆さまでも読むよう指示している", () => {
    assert.match(request.contents[0].parts[1].text, /逆さま/);
  });

  it("推測で埋めないよう指示している", () => {
    assert.match(request.contents[0].parts[1].text, /推測/);
  });

  it("ぶれないよう temperature 0 で JSON を要求する", () => {
    assert.equal(request.generationConfig.temperature, 0);
    assert.equal(request.generationConfig.responseMimeType, "application/json");
    assert.equal(request.generationConfig.responseSchema.required[0], "text");
  });

  it("返してほしい項目を schema で指定している", () => {
    const keys = Object.keys(request.generationConfig.responseSchema.properties);
    assert.deepEqual(keys.sort(), ["brand", "made_in", "materials", "model_numbers", "sizes", "text"]);
  });
});

describe("parseResponse", () => {
  const wrap = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

  it("構造化された結果を取り出す", () => {
    const { text, hint } = parseResponse(wrap({
      text: "GU\n336N004N",
      brand: "GU",
      model_numbers: ["336N004N", "331-359039"],
      sizes: ["M"],
      materials: ["ポリエステル"],
      made_in: "中国",
    }));
    assert.equal(text, "GU\n336N004N");
    assert.equal(hint.brand, "GU");
    assert.deepEqual(hint.modelNumbers, ["336N004N", "331-359039"]);
    assert.deepEqual(hint.sizes, ["M"]);
    assert.equal(hint.madeIn, "中国");
  });

  it("空の項目は null や空配列にそろえる", () => {
    const { hint } = parseResponse(wrap({ text: "よくわからない", brand: "", model_numbers: [] }));
    assert.equal(hint.brand, null);
    assert.deepEqual(hint.modelNumbers, []);
  });

  it("前後の空白を落とす", () => {
    const { text, hint } = parseResponse(wrap({ text: " GU ", brand: " GU ", model_numbers: [" 336N "] }));
    assert.equal(text, "GU");
    assert.equal(hint.brand, "GU");
    assert.deepEqual(hint.modelNumbers, ["336N"]);
  });

  it("JSON になっていなくても本文が読めれば使う", () => {
    const { text, hint } = parseResponse({ candidates: [{ content: { parts: [{ text: "GU 336N004N" }] } }] });
    assert.equal(text, "GU 336N004N");
    assert.deepEqual(hint, {});
  });

  it("写真が拒否されたら理由を伝える", () => {
    assert.throws(
      () => parseResponse({ promptFeedback: { blockReason: "SAFETY" } }),
      /受け付けられませんでした（SAFETY）/
    );
  });

  it("空の返事はエラーにする", () => {
    assert.throws(() => parseResponse({ candidates: [{ content: { parts: [] } }] }), /空でした/);
  });

  it("返事が無い場合もエラーにする", () => {
    assert.throws(() => parseResponse({}), /空でした/);
  });
});

describe("既定のモデル", () => {
  it("画像を読める flash 系を既定にする", () => {
    assert.match(DEFAULT_MODEL, /^gemini-.*flash/);
  });
});
