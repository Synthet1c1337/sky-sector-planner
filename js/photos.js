// Site photos in IndexedDB (localStorage is too small for images). Photos are
// downscaled on the device before storing; jobs keep only the photo ids.

const DB_NAME = 'slp-photos';
const STORE = 'photos';
const MAX_EDGE = 1600;

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Photo storage is not available in this browser.')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open photo storage.'));
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export async function downscale(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
}

export async function addPhoto(file, jobId) {
  const blob = await downscale(file);
  const id = globalThis.crypto?.randomUUID?.() ?? `ph-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await tx('readwrite', (s) => s.put({ id, jobId, blob, takenAt: new Date().toISOString(), name: file.name ?? '' }));
  return id;
}

export async function getPhotoUrl(id) {
  const rec = await tx('readonly', (s) => s.get(id));
  return rec?.blob ? URL.createObjectURL(rec.blob) : null;
}

export async function deletePhoto(id) {
  await tx('readwrite', (s) => s.delete(id));
}
