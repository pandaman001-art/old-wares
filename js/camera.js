// カメラの共通処理。バーコード読み取りと写真撮影で同じ映像を使う。
//
// 写真は端末のカメラアプリを呼ばず、映像の 1 フレームを切り出して作る。
// カメラアプリを起動しないのでシャッター音が鳴らない（日本の端末は
// カメラアプリ側で音を鳴らす仕様のため）。静かな店内でも使える。

// タグの小さい文字を読むには解像度が要る。取れるだけ大きく要求する
const DEFAULT_CONSTRAINTS = {
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 3840 },
    height: { ideal: 2160 },
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
  return {
    stream,
    stop() {
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    },
  };
}

/**
 * 写真を撮る。シャッター音は鳴らない（カメラアプリを起動しないため）。
 *
 * ImageCapture が使える端末では静止画の解像度で撮る。映像の 1 フレームは
 * 1080p 程度しかなく、タグの小さい文字はそれでは潰れてしまう。
 * 使えない端末では従来どおり映像から切り出す。
 */
export async function takePhoto(video, stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (track && typeof window !== "undefined" && "ImageCapture" in window) {
    try {
      const blob = await new window.ImageCapture(track).takePhoto();
      if (blob?.size) return blob;
    } catch {
      // 端末によっては takePhoto が動かない。そのときは映像から切り出す
    }
  }
  return captureFrame(video);
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
