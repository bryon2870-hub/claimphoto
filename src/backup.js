// Backup / restore for ClaimPhoto. Pure functions + small browser helpers (no React, no app globals).
export const BACKUP_VERSION = 1;
const APP_ID = "ClaimPhoto";

export function backupFilename(kind = "all", now = new Date(), label = "") {
  const d = now.toISOString().slice(0, 10);
  const safe = String(label).replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40);
  return kind === "report" ? `ClaimPhoto-${safe || "report"}-${d}.claimphoto.json` : `ClaimPhoto-backup-${d}.claimphoto.json`;
}

export function buildBackup({ projects = [], companies = [], users = [], macros = { labels: [], notes: [] } }, kind = "all") {
  return { app: APP_ID, version: BACKUP_VERSION, kind, exportedAt: new Date().toISOString(), projects, companies, users, macros };
}

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

/** Parse + validate a backup file's text. Throws Error(friendly message). Returns clean data. */
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't a ClaimPhoto backup (it couldn't be read)."); }
  if (!isObj(data) || data.app !== APP_ID) throw new Error("That file isn't a ClaimPhoto backup.");
  if (typeof data.version !== "number" || data.version > BACKUP_VERSION) throw new Error("This backup was made by a newer version of ClaimPhoto. Update the app and try again.");
  if (!Array.isArray(data.projects)) throw new Error("The backup file is damaged (no reports found).");
  const projects = [];
  for (const p of data.projects) {
    if (!isObj(p) || (typeof p.id !== "string" && typeof p.id !== "number")) continue;
    const photos = (Array.isArray(p.photos) ? p.photos : []).filter(isObj).map((ph) => ({
      ...ph,
      id: String(ph.id ?? Math.random().toString(36).slice(2)),
      // Only real embedded images are allowed as image sources
      imageData: typeof ph.imageData === "string" && ph.imageData.startsWith("data:image/") ? ph.imageData : null,
    }));
    projects.push({
      ...p,
      id: String(p.id),
      name: typeof p.name === "string" && p.name ? p.name : "Imported report",
      createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date(0).toISOString(),
      updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : new Date(0).toISOString(),
      claim: isObj(p.claim) ? p.claim : {},
      photos,
      checklist: isObj(p.checklist) ? p.checklist : {},
    });
  }
  const named = (arr) => (Array.isArray(arr) ? arr.filter((x) => isObj(x) && typeof x.name === "string" && x.name.trim()) : []);
  const strs = (arr) => (Array.isArray(arr) ? arr.filter((s) => typeof s === "string" && s.trim()) : []);
  const m = isObj(data.macros) ? data.macros : {};
  return { projects, companies: named(data.companies), users: named(data.users), macros: { labels: strs(m.labels), notes: strs(m.notes) }, exportedAt: data.exportedAt || null, kind: data.kind || "all" };
}

/**
 * Decide what importing does. Same report = same id AND same createdAt.
 * - not present            -> add
 * - present, imported newer -> update
 * - present, not newer      -> skip (unchanged)
 * - id used by a DIFFERENT report (e.g. from another device) -> add under a fresh id
 */
export function planImport(existing, incoming) {
  const byId = new Map(existing.map((p) => [String(p.id), p]));
  const taken = new Set(byId.keys());
  const plan = { add: [], update: [], skip: [] };
  for (const p of incoming) {
    const cur = byId.get(p.id);
    if (!cur) { plan.add.push(p); taken.add(p.id); continue; }
    if (cur.createdAt === p.createdAt) {
      if (new Date(p.updatedAt) > new Date(cur.updatedAt)) plan.update.push(p); else plan.skip.push(p);
      continue;
    }
    let nid = p.id + "-i"; let n = 1;
    while (taken.has(nid)) nid = p.id + "-i" + ++n;
    taken.add(nid);
    plan.add.push({ ...p, id: nid });
  }
  return plan;
}

/** Union by (case-insensitive) name; existing entries win. */
export function mergeByName(existing, incoming) {
  const seen = new Set(existing.map((x) => x.name.trim().toLowerCase()));
  const ids = new Set(existing.map((x) => String(x.id)));
  const out = [...existing]; let added = 0;
  for (const x of incoming) {
    const k = x.name.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); added++;
    let id = x.id != null ? String(x.id) : "";
    if (!id || ids.has(id)) id = String(Date.now()) + Math.floor(Math.random() * 1e6); // never clash with an existing entry
    ids.add(id);
    out.push({ ...x, id });
  }
  return { list: out, added };
}
export function mergeStrings(existing, incoming) {
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const out = [...existing]; let added = 0;
  for (const s of incoming) { if (seen.has(s.toLowerCase())) continue; seen.add(s.toLowerCase()); out.push(s); added++; }
  return { list: out, added };
}

// ── Browser helpers ──────────────────────────────────────────────────────────
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function canShareFiles() {
  try {
    if (!navigator.share || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File(["{}"], "x.json", { type: "application/json" })] });
  } catch { return false; }
}

/** Opens the phone's share sheet (email, Files, AirDrop…). Returns "shared" | "cancelled". */
export async function shareText(filename, text) {
  const file = new File([text], filename, { type: "application/json" });
  try { await navigator.share({ files: [file], title: filename }); return "shared"; }
  catch (e) { if (e && e.name === "AbortError") return "cancelled"; throw e; }
}

export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null };
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage ?? null; out.quota = e.quota ?? null; } } catch {}
  try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch {}
  return out;
}

export function fmtBytes(n) {
  if (n == null) return "?";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(1) + " GB";
}
