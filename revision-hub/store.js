// ─────────────────────────────────────────────────────────────────────────────
// store.js — the ONLY module that touches localStorage.
// Rules: (1) schema version + migrate chain from day one;
//        (2) append-only events, derived values never stored;
//        (3) every visitor's data stays in their own browser.
// ─────────────────────────────────────────────────────────────────────────────

const STORE_KEY = "jih:store";
const SCHEMA_VERSION = 1;

function createStore() {
  return {
    version: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    reviews: [],    // { cardId, topicId, rating 0–5, ts ISO }
    fumbles: [],    // { topicId, ts ISO, note? }
    interviews: [], // { id, company, roleTags, seniority, scheduledAt, prepTimeMin }
    onboarding: { diagnosticDone: false },
  };
}

function load() {
  let raw;
  try { raw = localStorage.getItem(STORE_KEY); }
  catch (e) { console.warn("localStorage unavailable — in-memory store"); return createStore(); }
  if (!raw) return createStore();
  let data;
  try { data = JSON.parse(raw); }
  catch (e) { console.warn("corrupt store — starting fresh"); return createStore(); }
  return migrate(data);
}

function migrate(data) {
  const v = data.version || 0;
  if (v > SCHEMA_VERSION) { console.warn("store from a newer app version — best-effort load"); return data; }
  // future migrations chain here: if (v === 1) { ...; data.version = 2; }
  data.version = SCHEMA_VERSION;
  return data;
}

function save(store) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); return true; }
  catch (e) { return false; }
}

function appendReview(store, card) {
  store.reviews.push({ cardId: card.cardId, topicId: card.topicId, rating: card.rating, ts: new Date().toISOString() });
  save(store);
}

function appendFumble(store, topicId, note) {
  store.fumbles.push({ topicId: topicId, note: note, ts: new Date().toISOString() });
  save(store);
}

function addInterview(store, interview) {
  interview.id = "iv-" + Date.now();
  store.interviews.push(interview);
  save(store);
  return interview;
}

function exportStore(store) {
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "revision-hub-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click();
  URL.revokeObjectURL(url);
}

function importStore(store, fileText) {
  let incoming;
  try { incoming = JSON.parse(fileText); }
  catch (e) { return { ok: false, error: "Not a valid backup file" }; }
  if (!Array.isArray(incoming.reviews)) return { ok: false, error: "File doesn't look like a revision-hub backup" };
  const seen = new Set(store.reviews.map((r) => r.cardId + "|" + r.ts));
  const newReviews = incoming.reviews.filter((r) => !seen.has(r.cardId + "|" + r.ts));
  store.reviews = store.reviews.concat(newReviews);
  const fSeen = new Set(store.fumbles.map((f) => f.topicId + "|" + f.ts));
  store.fumbles = store.fumbles.concat((incoming.fumbles || []).filter((f) => !fSeen.has(f.topicId + "|" + f.ts)));
  store.interviews = (store.interviews || []).concat(incoming.interviews || []);
  save(store);
  return { ok: true, merged: newReviews.length };
}

export { STORE_KEY, SCHEMA_VERSION, createStore, load, save, migrate, appendReview, appendFumble, addInterview, exportStore, importStore };
