// 写真の取り込み。
//
// 写真から商品を判別することはしない（そのための画像認識は積んでいない）。
// 「あとで見返したときにどの服だったか分かる」ための記録用。
// スマホの写真はそのままだと数 MB あるので、保存前に縮小する。

const MAX_EDGE = 1024;
const QUALITY = 0.8;

/** 長辺を maxEdge 以内に縮めた JPEG を返す。失敗したら元のファイルをそのまま返す。 */
export async function shrinkImage(file, maxEdge = MAX_EDGE, quality = QUALITY) {
  if (!file || !file.type?.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob || file;
  } catch {
    // 端末やファイル形式によっては縮小できない。そのときは元のまま保存する
    return file;
  }
}
