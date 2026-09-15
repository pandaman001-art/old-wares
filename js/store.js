// 調べた相場を端末内に保存する（IndexedDB）。
//
// たまにしか使わない道具なので、前回いくらだったかを後から見返せることに意味がある。
// サーバーは無いので、データはこの端末のブラウザから出ない。

const DB_NAME = "oldwares";
const DB_VERSION = 1;
const STORE = "records";
const DRAFT_KEY = "oldwares.draft";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function transact(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request ? request.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export function newId(now = new Date()) {
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;
}

/** 貼り付け内容ごと保存する。後から開き直して再計算できる。 */
export async function saveRecord({ query, groups, summary, note = "", photo = null, tagText = "", barcode = "" }) {
  const record = {
    id: newId(), query, createdAt: new Date().toISOString(),
    groups, summary, note, photo, tagText, barcode,
  };
  await transact("readwrite", (store) => store.put(record));
  return record;
}

/** 新しい順のメタ情報（貼り付け本文は含めない）。 */
export async function listRecords(limit = 50) {
  const all = (await transact("readonly", (store) => store.getAll())) || [];
  return all
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    // 貼り付け本文は重いので一覧では返さない。写真はサムネイルに使うので残す
    .map(({ id, query, createdAt, note, summary, photo }) => ({ id, query, createdAt, note, summary, photo }));
}

export function getRecord(id) {
  return transact("readonly", (store) => store.get(id));
}

export function deleteRecord(id) {
  return transact("readwrite", (store) => store.delete(id));
}

/** 入力中の内容の退避。保存を押さなくてもリロードで消えないように。 */
export function saveDraft(draft) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // プライベートウィンドウなどでは保存できない。機能には影響しない
  }
}

export function loadDraft() {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
  } catch {
    return null; // 壊れた下書きは無視する
  }
}
