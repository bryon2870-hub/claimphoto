// Backup panel: export everything, share, import with preview, storage + last-backup status.
import React, { useState, useRef, useEffect } from "react";
import { buildBackup, parseBackup, planImport, backupFilename, downloadText, shareText, canShareFiles, storageInfo, fmtBytes } from "./backup.js";

const DAY = 86400000;
export function agoText(ts) {
  if (!ts) return "never";
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return Math.floor(d / 60000) + " min ago";
  if (d < DAY) return Math.floor(d / 3600000) + " h ago";
  const days = Math.floor(d / DAY);
  return days + (days === 1 ? " day ago" : " days ago");
}
export function backupIsStale(lastBackup, photoTotal) {
  return photoTotal > 0 && (!lastBackup || Date.now() - lastBackup > 7 * DAY);
}

export function BackupPanel({ loadAll, applyImport, lastBackup, onBackedUp, photoTotal, onClose }) {
  const ref = useRef(null);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { ok, text }
  const [pending, setPending] = useState(null); // { name, parsed, plan }
  const [store, setStore] = useState(null);
  const canShare = canShareFiles();

  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", esc); };
  }, []);
  useEffect(() => { storageInfo().then(setStore); }, []);

  const exportAll = async (mode) => {
    setBusy(true); setMsg(null);
    try {
      const data = await loadAll();
      const text = JSON.stringify(buildBackup(data));
      const name = backupFilename("all");
      if (mode === "share") {
        if ((await shareText(name, text)) === "cancelled") { setBusy(false); return; }
      } else downloadText(name, text);
      onBackedUp(Date.now());
      setMsg({ ok: true, text: `Saved ${data.projects.length} report${data.projects.length === 1 ? "" : "s"} (${fmtBytes(text.length)}) as ${name}` });
    } catch (e) {
      setMsg({ ok: false, text: "Export failed: " + (e && e.message ? e.message : "unknown error") });
    }
    setBusy(false);
  };

  const pickFile = async (file) => {
    if (!file) return;
    setBusy(true); setMsg(null); setPending(null);
    try {
      const parsed = parseBackup(await file.text());
      const existing = (await loadAll()).projects;
      setPending({ name: file.name, parsed, plan: planImport(existing, parsed.projects) });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
    setBusy(false);
  };

  const confirmImport = async () => {
    setBusy(true);
    try {
      const s = await applyImport(pending.parsed, pending.plan);
      setPending(null);
      setMsg({ ok: true, text: `Imported: ${s.added} new, ${s.updated} updated, ${s.skipped} unchanged. Reloading…` });
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setMsg({ ok: false, text: "Import failed: " + (e && e.message ? e.message : "unknown error") + ". Nothing was lost." });
      setBusy(false);
    }
  };

  const pct = store && store.usage != null && store.quota ? Math.min(100, (store.usage / store.quota) * 100) : null;
  const stale = backupIsStale(lastBackup, photoTotal);
  const plan = pending && pending.plan;

  return (
    <div className="dd-panel" ref={ref} data-testid="backup-panel">
      <div className="dd-hdr">
        <div className="dd-hdr-title">Backup &amp; restore</div>
        <div className="dd-hdr-sub">Reports live only on this device. Save a copy so they can't be lost.</div>
      </div>

      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--bdr)" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: stale ? "var(--amber-600)" : "var(--text)" }} data-testid="last-backup">
          {stale ? "⚠ " : ""}Last backup: {agoText(lastBackup)}
        </div>
        {stale && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 2 }}>You have photos that aren't backed up. Export a copy now.</div>}
        {store && (
          <div style={{ marginTop: 10 }} data-testid="storage-info">
            <div style={{ fontSize: 12, color: "var(--text2)", marginBottom: 4 }}>
              Storage used: {fmtBytes(store.usage)}{store.quota ? ` of ${fmtBytes(store.quota)}` : ""}
            </div>
            {pct != null && (
              <div style={{ height: 6, borderRadius: 3, background: "var(--slate-200)", overflow: "hidden" }}>
                <div style={{ width: Math.max(2, pct) + "%", height: "100%", background: pct > 70 ? "var(--amber-600)" : "var(--blue-600)" }} />
              </div>
            )}
            {pct != null && pct > 70 && <div style={{ fontSize: 12, color: "var(--amber-600)", marginTop: 4 }}>Storage is getting full. Export a backup, then delete old reports.</div>}
            {store.persisted === false && <div style={{ fontSize: 12, color: "var(--text2)", marginTop: 4 }}>Your browser may clear this data if the device runs low on space. Exporting regularly keeps you safe.</div>}
          </div>
        )}
      </div>

      <div style={{ padding: 16, display: "grid", gap: 8 }}>
        {canShare && <button className="btn btn-primary" disabled={busy} onClick={() => exportAll("share")} data-testid="share-all">📤 Share backup (email, Files…)</button>}
        <button className={"btn " + (canShare ? "" : "btn-primary")} disabled={busy} onClick={() => exportAll("download")} data-testid="export-all">💾 Download backup file</button>
        <button className="btn" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()} data-testid="import-btn">📥 Import backup…</button>
        <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }} data-testid="import-input"
          onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; pickFile(f); }} />
      </div>

      {pending && (
        <div style={{ padding: "0 16px 16px" }} data-testid="import-preview">
          <div style={{ background: "var(--blue-50)", border: "1px solid var(--blue-200)", borderRadius: 12, padding: 12, fontSize: 13 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>{pending.name}</div>
            <div>Reports in file: {pending.parsed.projects.length}</div>
            <div>
              <b>{plan.add.length}</b> new · <b>{plan.update.length}</b> newer than yours · <b>{plan.skip.length}</b> already up to date
            </div>
            {(pending.parsed.companies.length + pending.parsed.users.length) > 0 && (
              <div style={{ color: "var(--text2)", marginTop: 2 }}>Also: {pending.parsed.companies.length} companies, {pending.parsed.users.length} users (new ones are added)</div>
            )}
            <div style={{ color: "var(--text2)", marginTop: 6 }}>Nothing on this device is deleted. Reports that are already here are only replaced if the file's copy is newer.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="btn btn-primary" disabled={busy} onClick={confirmImport} data-testid="import-confirm">Import</button>
              <button className="btn" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <div data-testid="backup-msg" style={{ margin: "0 16px 16px", padding: 10, borderRadius: 10, fontSize: 13, background: msg.ok ? "var(--green-50, #f0fdf4)" : "var(--red-50, #fef2f2)", color: msg.ok ? "#166534" : "#991b1b" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
