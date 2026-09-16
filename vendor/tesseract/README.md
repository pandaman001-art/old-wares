# 同梱している OCR エンジン

写真からタグの文字を読むために [Tesseract.js](https://github.com/naptha/tesseract.js) を
そのまま置いています。写真を外部に送らずに端末内で処理するため、CDN ではなく同梱しています。

| ファイル | 出どころ | ライセンス |
| --- | --- | --- |
| `tesseract.esm.min.js` / `worker.min.js` | tesseract.js 7.0.0 | Apache-2.0 |
| `tesseract-core-*-lstm.wasm.js` | tesseract.js-core 7.0.0 | Apache-2.0 |
| `lang/eng.traineddata` | @tesseract.js-data/eng 1.0.0 (4.0.0_best_int) | Apache-2.0 |
| `lang/jpn.traineddata` | @tesseract.js-data/jpn 1.0.0 (4.0.0_best_int) | Apache-2.0 |

traineddata は非圧縮で置いています。`.gz` のままだと配信側が `Content-Encoding` を
付けるかどうかで二重展開の事故が起きうるためです（`gzip: false` で読み込んでいます）。

コアは relaxedsimd / simd / 非 SIMD の 3 種類を置いてあります。端末の対応状況に応じて
tesseract.js が 1 つだけ選んで読み込むので、実際にダウンロードされるのは 1 つです。
OEM は LSTM のみ（`oem: 1`）なので `-lstm` 版だけで足ります。

これらは Service Worker の事前キャッシュには入れていません。「写真から文字を読む」を
最初に使ったときだけ読み込み、以後はキャッシュされます。
