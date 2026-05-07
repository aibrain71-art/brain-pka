// service-worker.js
// Handles incoming shares via Web Share Target API (POST multipart/form-data)

const CACHE = "brain-pka-v1";

self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(clients.claim());
});

// Intercept share POST requests
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // Only handle POST to our own origin (= share target)
  if (e.request.method !== "POST") return;

  e.respondWith((async () => {
    const formData = await e.request.formData();

    const title = formData.get("title") || "";
    const text  = formData.get("text")  || "";
    const link  = formData.get("url")   || "";
    const file  = formData.get("file");

    let fileText = "";
    let fileName = "";

    if (file && file instanceof File) {
      fileName = file.name;
      if (file.type === "application/pdf") {
        // PDF: raw bytes → extract printable chars
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let str = "";
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          if (c >= 32 && c < 127) str += String.fromCharCode(c);
          else if (c === 10 || c === 13) str += " ";
        }
        const chunks = str.match(/[A-Za-z\u00C0-\u024F0-9 .,;:!?'"\-]{20,}/g) || [];
        fileText = chunks.join(" ").replace(/\s+/g, " ").slice(0, 6000);
      } else {
        fileText = await file.text();
      }
    }

    // Build shared payload and store in IndexedDB for the page to pick up
    const payload = {
      id: Date.now().toString(36),
      title: title || fileName || "Geteilter Inhalt",
      text: fileText || text || link,
      url: link,
      fileName,
      ts: Date.now()
    };

    // Store in IndexedDB
    await storeSharedPayload(payload);

    // Redirect to app (GET) so page can read the payload
    return Response.redirect("/index.html?shared=1", 303);
  })());
});

// ── IndexedDB helpers ────────────────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open("brain-pka", 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore("shares", { keyPath: "id" });
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function storeSharedPayload(payload) {
  const db    = await openDB();
  const tx    = db.transaction("shares", "readwrite");
  const store = tx.objectStore("shares");
  store.put(payload);
  return new Promise(res => { tx.oncomplete = res; });
}
