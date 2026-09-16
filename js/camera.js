// カメラの共通処理。バーコード読み取りと写真撮影で同じ映像を使う。
//
// 写真は端末のカメラアプリを呼ばず、映像の 1 フレームを切り出して作る。
// カメラアプリを起動しないのでシャッター音が鳴らない（日本の端末は
// カメラアプリ側で音を鳴らす仕様のため）。静かな店内でも使える。

const DEFAULT_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
  audio: false,
};

/** この端末でカメラが使えるか。 */
export function cameraSupported() {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * 背面カメラを開いて video に流す。
 * 戻り値の stop() で必ず止めること（止めないとカメラが点きっぱなしになる）。
 */
export async function startCamera(video, constraints = DEFAULT_CONSTRAINTS) {
  if (!cameraSupported()) throw new Error("この端末ではカメラを使えません");
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  video.setAttribute("playsinline", "");
  video.muted = true;
  await video.play();
  // 1 フレーム目が来るまでは videoWidth が 0 なので待つ
  if (!video.videoWidth) {
    await new Promise((resolve) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      setTimeout(resolve, 2000);
    });
  }
  return () => {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
}

/** いま映っている 1 フレームを JPEG にする。シャッター音は鳴らない。 */
export async function captureFrame(video, quality = 0.9) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("まだ映像が来ていません");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(video, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("写真を作れませんでした");
  return blob;
}
