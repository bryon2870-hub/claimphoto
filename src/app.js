"use strict";
import { CameraCapture } from "./camera.jsx";
import { BackupPanel, backupIsStale } from "./BackupPanel.jsx";
import { buildBackup, backupFilename, downloadText, mergeByName, mergeStrings } from "./backup.js";

const {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo
} = React;

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_LABELS = ["Mileage", "Registration sticker", "License plate number", "VIN number", "Make", "Model", "Front", "Front/left corner", "Front/right corner", "Rear", "Rear/left corner", "Rear/right corner", "Left", "Right", "Interior", "Roof", "Engine compartment", "Undercarriage", "Other"];
const DEFAULT_NOTES = ["Overview", "Damage to front hood", "Damage to front fender", "Damage to front grill", "Damage to front headlight assembly", "Damage to front bumper cover", "Damage to front fog light assembly", "Front passenger door does not open due to impact", "Damage to rear bumper", "Damage to roof panel", "Total loss"];
// LABELS/NOTES are mutable runtime arrays — extended with user-saved macros on init
let LABELS = [...DEFAULT_LABELS];
let NOTES = [...DEFAULT_NOTES];
const EMPTY_CO = Object.freeze({
  id: null,
  name: "",
  address: "",
  phone: "",
  fax: "",
  email: "",
  web: ""
});
const PPG_MAP = Object.freeze({
  1: 1,
  2: 2,
  4: 4
});
const LAYOUT_OPTS = Object.freeze([{
  v: 1,
  icon: "━",
  label: "1 per page",
  sub: "Large format"
}, {
  v: 2,
  icon: "━━",
  label: "2 per page",
  sub: "Standard"
}, {
  v: 4,
  icon: "▪▪\n▪▪",
  label: "4 per page",
  sub: "Compact grid"
}]);
const LS = Object.freeze({
  plist: "cp5_plist",
  apid: "cp5_apid",
  cos: "cp5_cos",
  acoid: "cp5_acoid",
  lay: "cp5_lay",
  users: "cp5_users",
  auid: "cp5_auid",
  macros: "cp5_macros",
  lastBackup: "cp5_lastbackup"
});
const ACCENT_COLORS = ["#2563EB", "#7C3AED", "#0891B2", "#059669", "#DC2626", "#D97706"];

// ── Utilities ────────────────────────────────────────────────────────────────
let _uid = Date.now();
const uid = () => String(++_uid);
const getToday = () => new Date().toISOString().slice(0, 10);
function fmtDate(iso) {
  if (!iso) return "";
  const p = iso.split("-");
  return p.length === 3 ? `${+p[1]}/${+p[2]}/${p[0]}` : iso;
}
function fmtShort(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric"
    });
  } catch {
    return "";
  }
}
function fmtAgo(iso) {
  if (!iso) return "";
  try {
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    if (d === 0) return "Today";
    if (d === 1) return "Yesterday";
    if (d < 7) return `${d}d ago`;
    return fmtShort(iso);
  } catch {
    return "";
  }
}
function accentFor(id) {
  let h = 0;
  for (let i = 0; i < (id || "").length; i++) {
    h = h * 31 + id.charCodeAt(i) >>> 0;
  }
  return ACCENT_COLORS[h % ACCENT_COLORS.length];
}
function lsGet(k, d) {
  try {
    const v = localStorage.getItem(k);
    return v != null ? JSON.parse(v) : d;
  } catch {
    return d;
  }
}
function lsSet(k, v) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}
function toast(msg, ms = 2400) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}
async function compress(file, maxPx = 1100, q = 0.78) {
  return new Promise(res => {
    const url = URL.createObjectURL(file),
      img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let w = img.naturalWidth,
        h = img.naturalHeight;
      if (w > maxPx || h > maxPx) {
        if (w >= h) {
          h = Math.round(h * maxPx / w);
          w = maxPx;
        } else {
          w = Math.round(w * maxPx / h);
          h = maxPx;
        }
      }
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      res(c.toDataURL("image/jpeg", q));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      res(null);
    };
    img.src = url;
  });
}
async function loadFiles(list) {
  const files = Array.from(list).filter(f => f.type.startsWith("image/"));
  return Promise.all(files.map(async f => ({
    id: uid(),
    imageData: await compress(f),
    label: "",
    customLabel: "",
    notes: ""
  })));
}
function buildPages(photos, ppg) {
  const out = [];
  for (let i = 0; i < photos.length; i += ppg) out.push(photos.slice(i, i + ppg));
  return out;
}

// ── IndexedDB ────────────────────────────────────────────────────────────────
const IDB = (() => {
  let _db = null;
  const open = () => new Promise((res, rej) => {
    if (_db) return res(_db);
    const req = indexedDB.open("ClaimPhoto_v5", 1);
    req.onupgradeneeded = e => {
      if (!e.target.result.objectStoreNames.contains("projects")) e.target.result.createObjectStore("projects", {
        keyPath: "id"
      });
    };
    req.onsuccess = e => {
      _db = e.target.result;
      res(_db);
    };
    req.onerror = () => rej(req.error);
  });
  const run = (mode, fn) => new Promise(async (res, rej) => {
    const db = await open(),
      tx = db.transaction("projects", mode),
      req = fn(tx.objectStore("projects"));
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return {
    save: p => run("readwrite", os => os.put(p)),
    load: id => run("readonly", os => os.get(id)),
    del: id => run("readwrite", os => os.delete(id)),
    all: () => run("readonly", os => os.getAll())
  };
})();

// ── Project helpers ──────────────────────────────────────────────────────────
function makeProj(name = "Untitled report") {
  const now = new Date().toISOString();
  return {
    id: uid(),
    name,
    createdAt: now,
    updatedAt: now,
    claim: {
      insured: "",
      claimant: "",
      partyLabel: "insured",
      claimNum: "",
      policyNum: ""
    },
    photos: [],
    layout: 2
  };
}
const projMeta = p => {
  var _p$photos, _p$claim, _p$claim2;
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    photoCount: ((_p$photos = p.photos) === null || _p$photos === void 0 ? void 0 : _p$photos.length) || 0,
    insured: ((_p$claim = p.claim) === null || _p$claim === void 0 ? void 0 : _p$claim.insured) || "",
    claimNum: ((_p$claim2 = p.claim) === null || _p$claim2 === void 0 ? void 0 : _p$claim2.claimNum) || ""
  };
};

// ── Backup helpers (used by BackupPanel / dashboard export) ──────────────────
// App assigns this so exports include edits still waiting in the autosave debounce.
let flushPending = async () => {};
async function backupLoadAll() {
  await flushPending();
  return {
    projects: await IDB.all(),
    companies: lsGet(LS.cos, []),
    users: lsGet(LS.users, []),
    macros: lsGet(LS.macros, {
      labels: [],
      notes: []
    })
  };
}
async function backupApplyImport(parsed, plan) {
  await flushPending();
  for (const p of [...plan.add, ...plan.update]) await IDB.save(p);
  const all = await IDB.all();
  lsSet(LS.plist, all.map(projMeta).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)));
  lsSet(LS.cos, mergeByName(lsGet(LS.cos, []), parsed.companies).list);
  lsSet(LS.users, mergeByName(lsGet(LS.users, []), parsed.users).list);
  const cur = lsGet(LS.macros, {
    labels: [],
    notes: []
  });
  lsSet(LS.macros, {
    labels: mergeStrings(cur.labels || [], parsed.macros.labels).list,
    notes: mergeStrings(cur.notes || [], parsed.macros.notes).list
  });
  return {
    added: plan.add.length,
    updated: plan.update.length,
    skipped: plan.skip.length
  };
}
async function exportOneReport(id) {
  await flushPending();
  const p = await IDB.load(id);
  if (!p) throw new Error("Report not found");
  downloadText(backupFilename("report", new Date(), p.name), JSON.stringify(buildBackup({
    projects: [p],
    companies: lsGet(LS.cos, []),
    users: lsGet(LS.users, []),
    macros: lsGet(LS.macros, {
      labels: [],
      notes: []
    })
  }, "report")));
}

// ── Shared leaf components (module-level — no remount) ───────────────────────
// ── MacroSelect: dropdown for labels or notes with manage/add functionality ───
function MacroSelect({
  value,
  onChange,
  type,
  macros,
  onAddMacro,
  onDeleteMacro,
  placeholder,
  className
}) {
  const [showMgr, setShowMgr] = useState(false);
  const [newText, setNewText] = useState("");
  const isLabel = type === "label";
  const presets = isLabel ? DEFAULT_LABELS : DEFAULT_NOTES;
  const customs = macros || [];
  const hasVal = !!value;
  const isCustom = value && !presets.includes(value);
  const selectCls = `macro-select${isLabel && hasVal ? " has-val" : !isLabel && hasVal ? " has-note" : ""}`;
  const addMacro = () => {
    const t = newText.trim();
    if (!t || presets.includes(t) || customs.includes(t)) return;
    onAddMacro(type, t);
    setNewText("");
    toast(`Macro saved: "${t}"`);
  };
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "macro-row"
  }, /*#__PURE__*/React.createElement("select", {
    className: `${selectCls}${className ? " " + className : ""}`,
    value: value || "",
    onChange: e => {
      if (e.target.value === "__clear__") {
        onChange("");
        return;
      }
      onChange(e.target.value);
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, placeholder || (isLabel ? "Select label…" : "Select notes…")), value && /*#__PURE__*/React.createElement("option", {
    value: "__clear__"
  }, "✕ Clear selection"), /*#__PURE__*/React.createElement("optgroup", {
    label: "── Presets ──"
  }, presets.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v))), customs.length > 0 && /*#__PURE__*/React.createElement("optgroup", {
    label: "── My macros ──"
  }, customs.map(v => /*#__PURE__*/React.createElement("option", {
    key: v,
    value: v
  }, v)))), /*#__PURE__*/React.createElement("button", {
    className: "macro-mgr-btn",
    title: showMgr ? "Close macro manager" : "Add / manage macros",
    onClick: () => setShowMgr(v => !v)
  }, showMgr ? "✕" : "⊕")), showMgr && /*#__PURE__*/React.createElement("div", {
    className: "macro-mgr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "macro-mgr-hdr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "macro-mgr-title"
  }, isLabel ? "Label" : "Notes", " macros"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--text3)"
    }
  }, presets.length + customs.length, " total")), presets.map(v => /*#__PURE__*/React.createElement("div", {
    key: v,
    className: "macro-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "macro-item-text"
  }, v), /*#__PURE__*/React.createElement("span", {
    className: "macro-item-custom"
  }, "preset"))), customs.map(v => /*#__PURE__*/React.createElement("div", {
    key: v,
    className: "macro-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "macro-item-text"
  }, v), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: "var(--blue-600)",
      background: "var(--blue-50)",
      padding: "1px 6px",
      borderRadius: 99
    }
  }, "custom"), /*#__PURE__*/React.createElement("button", {
    className: "mini mini-d",
    onClick: () => onDeleteMacro(type, v),
    title: "Delete this macro"
  }, "✕"))), /*#__PURE__*/React.createElement("div", {
    className: "macro-add-row"
  }, /*#__PURE__*/React.createElement("input", {
    value: newText,
    onChange: e => setNewText(e.target.value),
    placeholder: `New ${isLabel ? "label" : "note"}…`,
    onKeyDown: e => e.key === "Enter" && addMacro()
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    style: {
      flexShrink: 0
    },
    disabled: !newText.trim(),
    onClick: addMacro
  }, "Save"))));
}

// Keep LabelChips / NoteChips as thin wrappers so bulk panel + split panel
// don't need to be rewritten — they already use MacroSelect via the main paths
function LabelChips({
  selected,
  onSelect
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, LABELS.map(l => /*#__PURE__*/React.createElement("button", {
    key: l,
    className: `chip${selected === l ? " ci" : ""}`,
    onClick: () => onSelect(l)
  }, l)));
}
function NoteChips({
  selected,
  onSelect
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, NOTES.map(n => /*#__PURE__*/React.createElement("button", {
    key: n,
    className: `chip${selected === n ? " cs" : ""}`,
    onClick: () => onSelect(n)
  }, n)));
}
function Field({
  label,
  value,
  onChange,
  cols,
  type,
  placeholder
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `frow${cols === 2 ? " s2" : ""}`
  }, label && /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, label), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    type: type || "text",
    value: value || "",
    placeholder: placeholder || "",
    onChange: e => onChange(e.target.value)
  }));
}

// ── GPS capture ── FIX: surface GeolocationPositionError codes to user ────────
async function getGPS() {
  return new Promise(res => {
    if (!navigator.geolocation) {
      res({
        error: "GPS not supported on this device"
      });
      return;
    }
    navigator.geolocation.getCurrentPosition(p => res({
      lat: +p.coords.latitude.toFixed(6),
      lng: +p.coords.longitude.toFixed(6)
    }), err => {
      const msg = err.code === 1 ? "Location permission denied — enable in browser settings" : err.code === 2 ? "GPS position unavailable" : "GPS timed out — try again outdoors";
      res({
        error: msg
      });
    }, {
      timeout: 8000,
      maximumAge: 30000
    });
  });
}

// ── GPS status button ── FIX: shows specific error messages from getGPS ────────
function GpsButton({
  gps,
  onCapture
}) {
  const [state, setState] = useState("idle"); // idle | requesting | got | err
  const [errMsg, setErrMsg] = useState("");
  const capture = useCallback(async () => {
    if (gps) {
      onCapture(null);
      setState("idle");
      return;
    } // toggle off
    setState("requesting");
    setErrMsg("");
    const result = await getGPS();
    if (result !== null && result !== void 0 && result.error) {
      setState("err");
      setErrMsg(result.error);
      setTimeout(() => {
        setState("idle");
        setErrMsg("");
      }, 4000);
    } else {
      setState("got");
      onCapture(result);
    }
  }, [gps, onCapture]);
  const label = gps ? fmtGPS(gps) : state === "requesting" ? "Getting GPS…" : state === "err" ? errMsg : "Add GPS";
  const cls = gps ? "got" : state === "err" ? "err" : state === "requesting" ? "req" : "";
  return /*#__PURE__*/React.createElement("button", {
    className: `gps-status${cls ? " " + cls : ""}`,
    onClick: capture,
    disabled: state === "requesting",
    title: gps ? "Tap to remove GPS location" : "Tap to capture current GPS location"
  }, "📍 ", /*#__PURE__*/React.createElement("span", null, label));
}
function fmtGPS(gps) {
  if (!gps) return "";
  const lat = gps.lat >= 0 ? `${gps.lat}°N` : `${Math.abs(gps.lat)}°S`;
  const lng = gps.lng >= 0 ? `${gps.lng}°E` : `${Math.abs(gps.lng)}°W`;
  return `${lat}, ${lng}`;
}

// ── Inspection checklist data ─────────────────────────────────────────────────
const CHECKLIST_TMPL = [{
  id: "vehicle",
  icon: "🚗",
  title: "Vehicle identification",
  items: [{
    id: "vin",
    label: "VIN number verified"
  }, {
    id: "plate",
    label: "License plate matches"
  }, {
    id: "reg",
    label: "Registration sticker current"
  }, {
    id: "mileage",
    label: "Odometer recorded"
  }, {
    id: "make",
    label: "Make / model / year confirmed"
  }]
}, {
  id: "exterior",
  icon: "🔍",
  title: "Exterior condition",
  items: [{
    id: "front",
    label: "Front end"
  }, {
    id: "rear",
    label: "Rear end"
  }, {
    id: "left-side",
    label: "Driver's side (left)"
  }, {
    id: "right-side",
    label: "Passenger's side (right)"
  }, {
    id: "roof",
    label: "Roof / sunroof"
  }, {
    id: "glass",
    label: "Windshield & glass"
  }, {
    id: "tires",
    label: "Tires & wheels"
  }]
}, {
  id: "damage",
  icon: "⚠️",
  title: "Damage documentation",
  items: [{
    id: "dmg-hood",
    label: "Hood"
  }, {
    id: "dmg-fender-l",
    label: "Left fender"
  }, {
    id: "dmg-fender-r",
    label: "Right fender"
  }, {
    id: "dmg-door-fl",
    label: "Front left door"
  }, {
    id: "dmg-door-fr",
    label: "Front right door"
  }, {
    id: "dmg-door-rl",
    label: "Rear left door"
  }, {
    id: "dmg-door-rr",
    label: "Rear right door"
  }, {
    id: "dmg-bumper-f",
    label: "Front bumper"
  }, {
    id: "dmg-bumper-r",
    label: "Rear bumper"
  }, {
    id: "dmg-lights",
    label: "Headlights / taillights"
  }]
}, {
  id: "interior",
  icon: "🪑",
  title: "Interior condition",
  items: [{
    id: "int-dash",
    label: "Dashboard & controls"
  }, {
    id: "int-seats",
    label: "Seats"
  }, {
    id: "int-airbags",
    label: "Airbags deployed?"
  }, {
    id: "int-belts",
    label: "Seat belts"
  }]
}, {
  id: "docs",
  icon: "📋",
  title: "Documentation complete",
  items: [{
    id: "doc-photos",
    label: "All required photos captured"
  }, {
    id: "doc-report",
    label: "Report information complete"
  }, {
    id: "doc-insured",
    label: "Insured / claimant info verified"
  }]
}];

// ── Annotation / Markup canvas ────────────────────────────────────────────────
function AnnotationEditor({
  imageData,
  existing,
  onSave,
  onClose
}) {
  const canvasRef = useRef();
  const [tool, setTool] = useState("arrow"); // arrow | rect | text | freehand
  const [color, setColor] = useState("#FF3B30");
  const [size, setSize] = useState(3);
  const [input, setInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const [inputPos, setInputPos] = useState({
    x: 0,
    y: 0
  });
  const drawing = useRef(false);
  const startPt = useRef(null);
  const freePoints = useRef([]);
  const snapshotRef = useRef(null);

  // Load image onto canvas on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      // Draw existing annotations on top
      if (existing) {
        const ann = new Image();
        ann.onload = () => ctx.drawImage(ann, 0, 0);
        ann.src = existing;
      }
    };
    img.src = imageData;
  }, [imageData, existing]);

  // FIX: ResizeObserver keeps the canvas CSS size tracked so pointer coordinates
  // stay aligned after window resize or phone orientation change.
  useEffect(() => {
    var _canvasRef$current;
    const wrap = (_canvasRef$current = canvasRef.current) === null || _canvasRef$current === void 0 ? void 0 : _canvasRef$current.parentElement;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      // canvas intrinsic size is fixed (set on image load) — only layout changes;
      // no action needed beyond forcing a repaint to avoid blurry scaling
      if (canvasRef.current) canvasRef.current.style.maxWidth = '100%';
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);
  const getPos = e => {
    var _e$touches$0$clientX, _e$touches, _e$touches$0$clientY, _e$touches2;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = (_e$touches$0$clientX = (_e$touches = e.touches) === null || _e$touches === void 0 || (_e$touches = _e$touches[0]) === null || _e$touches === void 0 ? void 0 : _e$touches.clientX) !== null && _e$touches$0$clientX !== void 0 ? _e$touches$0$clientX : e.clientX;
    const clientY = (_e$touches$0$clientY = (_e$touches2 = e.touches) === null || _e$touches2 === void 0 || (_e$touches2 = _e$touches2[0]) === null || _e$touches2 === void 0 ? void 0 : _e$touches2.clientY) !== null && _e$touches$0$clientY !== void 0 ? _e$touches$0$clientY : e.clientY;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };
  const setupCtx = ctx => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = size * 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  };
  const drawArrow = (ctx, x1, y1, x2, y2) => {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const head = Math.max(12, size * 5);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    if (len > head) {
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4));
      ctx.lineTo(x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fill();
    }
  };
  const onPointerDown = e => {
    if (e.type === "touchstart") e.preventDefault();
    if (tool === "text") {
      const p = getPos(e);
      setInputPos(p);
      setShowInput(true);
      return;
    }
    drawing.current = true;
    startPt.current = getPos(e);
    freePoints.current = [startPt.current];
    // snapshot canvas for live rubber-band preview
    const canvas = canvasRef.current;
    snapshotRef.current = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  };
  const onPointerMove = e => {
    if (!drawing.current || tool === "text") return;
    if (e.type === "touchmove") e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const pos = getPos(e);
    setupCtx(ctx);
    if (tool === "freehand") {
      freePoints.current.push(pos);
      const pts = freePoints.current;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    } else {
      // Restore snapshot for clean rubber-band
      ctx.putImageData(snapshotRef.current, 0, 0);
      const {
        x: x1,
        y: y1
      } = startPt.current;
      if (tool === "arrow") {
        drawArrow(ctx, x1, y1, pos.x, pos.y);
      } else if (tool === "rect") {
        ctx.strokeRect(x1, y1, pos.x - x1, pos.y - y1);
      } else if (tool === "circle") {
        const rx = (pos.x - x1) / 2,
          ry = (pos.y - y1) / 2;
        ctx.beginPath();
        ctx.ellipse(x1 + rx, y1 + ry, Math.abs(rx), Math.abs(ry), 0, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  };
  const onPointerUp = e => {
    if (!drawing.current) return;
    drawing.current = false;
    snapshotRef.current = null;
  };
  const addText = () => {
    if (!input.trim()) {
      setShowInput(false);
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const fs = Math.max(14, size * 8);
    ctx.font = `bold ${fs}px Arial`;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,.5)";
    ctx.lineWidth = 2;
    ctx.strokeText(input, inputPos.x, inputPos.y);
    ctx.fillText(input, inputPos.x, inputPos.y);
    setInput("");
    setShowInput(false);
  };
  const undo = () => {
    // Re-draw base image — simple single-level undo
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = new Image();
    img.onload = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = imageData;
  };
  const done = () => {
    const annotated = canvasRef.current.toDataURL("image/jpeg", 0.9);
    onSave(annotated);
  };
  const COLORS = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#007AFF", "#AF52DE", "#ffffff", "#000000"];
  const TOOLS = [{
    id: "arrow",
    icon: "↗",
    label: "Arrow"
  }, {
    id: "rect",
    icon: "▭",
    label: "Box"
  }, {
    id: "circle",
    icon: "○",
    label: "Circle"
  }, {
    id: "freehand",
    icon: "✏",
    label: "Draw"
  }, {
    id: "text",
    icon: "T",
    label: "Text"
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "markup-overlay",
    onTouchMove: e => e.preventDefault(),
    style: {
      userSelect: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "markup-toolbar"
  }, /*#__PURE__*/React.createElement("span", {
    className: "markup-toolbar-title"
  }, "Annotate"), TOOLS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.id,
    className: `mt-btn${tool === t.id ? " active" : ""}`,
    onClick: () => setTool(t.id)
  }, /*#__PURE__*/React.createElement("span", null, t.icon), /*#__PURE__*/React.createElement("span", null, t.label))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      alignItems: "center",
      marginLeft: 4
    }
  }, COLORS.map(c => /*#__PURE__*/React.createElement("div", {
    key: c,
    className: `mt-color-swatch${color === c ? " active" : ""}`,
    style: {
      background: c,
      outline: c === "#ffffff" ? "1px solid #666" : "none"
    },
    onClick: () => setColor(c)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginLeft: 4
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "rgba(255,255,255,.5)"
    }
  }, "Size"), /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: 1,
    max: 8,
    value: size,
    className: "size-slider",
    onChange: e => setSize(+e.target.value),
    style: {
      width: 70
    }
  })), /*#__PURE__*/React.createElement("button", {
    className: "mt-btn",
    onClick: undo,
    style: {
      marginLeft: "auto"
    }
  }, "↩ Undo")), /*#__PURE__*/React.createElement("div", {
    className: "markup-canvas-wrap"
  }, /*#__PURE__*/React.createElement("canvas", {
    ref: canvasRef,
    onMouseDown: onPointerDown,
    onMouseMove: onPointerMove,
    onMouseUp: onPointerUp,
    onTouchStart: onPointerDown,
    onTouchMove: onPointerMove,
    onTouchEnd: onPointerUp
  }), showInput && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "flex-start",
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      top: inputPos.y / 2,
      left: inputPos.x / 2,
      pointerEvents: "auto",
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "bp-input",
    autoFocus: true,
    value: input,
    onChange: e => setInput(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter") addText();
      if (e.key === "Escape") {
        setShowInput(false);
        setInput("");
      }
    },
    placeholder: "Type label…",
    style: {
      width: 180
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "mt-btn",
    onClick: addText
  }, "Add")))), /*#__PURE__*/React.createElement("div", {
    className: "markup-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "mt-btn",
    onClick: onClose
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "mt-btn active",
    onClick: done
  }, "Save annotations →")));
}

// ── Inspection Checklist ──────────────────────────────────────────────────────
function InspectionChecklist({
  checklist,
  setChecklist
}) {
  const [open, setOpen] = useState(new Set(["vehicle", "damage"]));
  const total = CHECKLIST_TMPL.reduce((s, sec) => s + sec.items.length, 0);
  const done = Object.values(checklist || {}).filter(v => v.status === "ok" || v.status === "issue").length;
  const setStatus = (itemId, status) => {
    setChecklist(prev => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        status
      }
    }));
  };
  const setNote = (itemId, note) => {
    setChecklist(prev => ({
      ...prev,
      [itemId]: {
        ...(prev[itemId] || {}),
        note
      }
    }));
  };
  const toggleSection = id => {
    setOpen(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "checklist-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "checklist-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "checklist-hdr-title"
  }, "Inspection Checklist"), /*#__PURE__*/React.createElement("div", {
    className: "checklist-progress"
  }, /*#__PURE__*/React.createElement("div", {
    className: "checklist-prog-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "checklist-prog-fill",
    style: {
      width: `${total ? Math.round(done / total * 100) : 0}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "checklist-prog-text"
  }, done, "/", total))), CHECKLIST_TMPL.map(sec => {
    const secDone = sec.items.filter(it => {
      var _it$id;
      const s = (_it$id = (checklist || {})[it.id]) === null || _it$id === void 0 ? void 0 : _it$id.status;
      return s === "ok" || s === "issue";
    }).length;
    const isOpen = open.has(sec.id);
    return /*#__PURE__*/React.createElement("div", {
      key: sec.id,
      className: "cl-section"
    }, /*#__PURE__*/React.createElement("div", {
      className: "cl-section-hdr",
      onClick: () => toggleSection(sec.id)
    }, /*#__PURE__*/React.createElement("span", {
      className: "cl-section-icon"
    }, sec.icon), /*#__PURE__*/React.createElement("span", {
      className: "cl-section-title"
    }, sec.title), /*#__PURE__*/React.createElement("span", {
      className: "cl-section-count"
    }, secDone, "/", sec.items.length), /*#__PURE__*/React.createElement("span", {
      className: `cl-section-chevron${isOpen ? " open" : ""}`
    }, "›")), isOpen && /*#__PURE__*/React.createElement("div", {
      className: "cl-items"
    }, sec.items.map(item => {
      var _item$id, _item$id2;
      const st = (_item$id = (checklist || {})[item.id]) === null || _item$id === void 0 ? void 0 : _item$id.status;
      const nt = ((_item$id2 = (checklist || {})[item.id]) === null || _item$id2 === void 0 ? void 0 : _item$id2.note) || "";
      return /*#__PURE__*/React.createElement("div", {
        key: item.id,
        className: "cl-item",
        onClick: () => {}
      }, /*#__PURE__*/React.createElement("div", {
        className: `cl-check${st === "ok" ? " done" : st === "na" ? " na" : ""}`
      }, st === "ok" ? "✓" : st === "issue" ? "!" : st === "na" ? "—" : ""), /*#__PURE__*/React.createElement("div", {
        className: "cl-item-body"
      }, /*#__PURE__*/React.createElement("div", {
        className: "cl-item-label"
      }, item.label), /*#__PURE__*/React.createElement("div", {
        className: "cl-status-row"
      }, /*#__PURE__*/React.createElement("button", {
        className: `cl-status-btn${st === "ok" ? " ok" : ""}`,
        onClick: () => setStatus(item.id, "ok")
      }, "✓ OK"), /*#__PURE__*/React.createElement("button", {
        className: `cl-status-btn${st === "issue" ? " issue" : ""}`,
        onClick: () => setStatus(item.id, "issue")
      }, "! Issue"), /*#__PURE__*/React.createElement("button", {
        className: `cl-status-btn${st === "na" ? " na-s" : ""}`,
        onClick: () => setStatus(item.id, "na")
      }, "N/A")), (st === "issue" || nt) && /*#__PURE__*/React.createElement("div", {
        className: "cl-item-note"
      }, /*#__PURE__*/React.createElement("input", {
        placeholder: "Note about this item…",
        value: nt,
        onClick: e => e.stopPropagation(),
        onChange: e => setNote(item.id, e.target.value)
      }))));
    })));
  }));
}

// ── Rotate image via canvas ───────────────────────────────────────────────────
// deg must be 90, 180, or 270. Returns a new base64 JPEG.
async function rotateImage(dataUrl, deg) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const swap = deg === 90 || deg === 270;
      const w = swap ? img.naturalHeight : img.naturalWidth;
      const h = swap ? img.naturalWidth : img.naturalHeight;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.translate(w / 2, h / 2);
      ctx.rotate(deg * Math.PI / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      res(c.toDataURL("image/jpeg", 0.88));
    };
    img.src = dataUrl;
  });
}

// ── Updated loadFilesWithGPS ──────────────────────────────────────────────────
async function loadFilesWithGPS(list, gps) {
  const files = Array.from(list).filter(f => f.type.startsWith("image/"));
  return Promise.all(files.map(async f => ({
    id: uid(),
    imageData: await compress(f),
    label: "",
    customLabel: "",
    notes: "",
    gps: gps || null
  })));
}

// ── Report print components ──────────────────────────────────────────────────
function RpImg({
  p
}) {
  return p !== null && p !== void 0 && p.imageData ? /*#__PURE__*/React.createElement("img", {
    src: p.imageData,
    alt: ""
  }) : /*#__PURE__*/React.createElement("div", {
    className: "rph"
  });
}
function RpHeader({
  co,
  claim
}) {
  const c = co || EMPTY_CO;
  const contact = [c.phone && `D. ${c.phone}`, c.fax && `F. ${c.fax}`, c.email && `E. ${c.email}`].filter(Boolean).join(" | ");
  const insuredLabel = claim.partyLabel === "claimant" ? "Claimant:" : "Insured:";
  return /*#__PURE__*/React.createElement("div", {
    className: "rp-hdr"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "rp-title"
  }, "Photo Sheet"), c.name && /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700
    }
  }, c.name), c.address && /*#__PURE__*/React.createElement("div", {
    style: {
      whiteSpace: "pre-line"
    }
  }, c.address), contact && /*#__PURE__*/React.createElement("div", null, contact), c.web && /*#__PURE__*/React.createElement("div", null, c.web)), /*#__PURE__*/React.createElement("div", {
    className: "rp-rt"
  }, claim.insured && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "rp-mu"
  }, insuredLabel, "\xA0\xA0"), claim.insured), claim.claimant && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "rp-mu"
  }, "Claimant:\xA0\xA0"), claim.claimant), claim.claimNum && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "rp-mu"
  }, "Claim #:\xA0\xA0"), claim.claimNum), claim.policyNum && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    className: "rp-mu"
  }, "Policy #:\xA0\xA0"), claim.policyNum)));
}
function ReportPage({
  photos,
  co,
  claim,
  dateStr,
  pageNum,
  layout
}) {
  const c = co || EMPTY_CO;
  return /*#__PURE__*/React.createElement("div", {
    className: `rp rp-l${layout}`
  }, /*#__PURE__*/React.createElement(RpHeader, {
    co: co,
    claim: claim
  }), layout === 4 ? /*#__PURE__*/React.createElement("div", {
    className: "rp-grid"
  }, photos.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    className: "rp-cell"
  }, /*#__PURE__*/React.createElement(RpImg, {
    p: p
  }), /*#__PURE__*/React.createElement("div", {
    className: "rmt"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rpn"
  }, "Inspection Photos - ", p.num, "-", p.label || "Unlabeled"), /*#__PURE__*/React.createElement("div", null, "Date: ", fmtDate(p.dateTaken), " \xA0 By: ", p.takenBy || ""), p.gps && /*#__PURE__*/React.createElement("div", {
    className: "rp-gps"
  }, "📍 ", fmtGPS(p.gps)), p.notes && /*#__PURE__*/React.createElement("div", null, p.notes))))) : photos.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    className: "rp-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rim"
  }, /*#__PURE__*/React.createElement(RpImg, {
    p: p
  })), /*#__PURE__*/React.createElement("div", {
    className: "rmt"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rpn"
  }, "Inspection Photos \xA0- ", p.num, "-", p.label || "Unlabeled"), /*#__PURE__*/React.createElement("div", null, "Date Taken:\xA0\xA0", fmtDate(p.dateTaken)), /*#__PURE__*/React.createElement("div", null, "Taken By:\xA0\xA0\xA0\xA0", p.takenBy || ""), p.gps && /*#__PURE__*/React.createElement("div", {
    className: "rp-gps"
  }, "📍 ", fmtGPS(p.gps)), p.notes && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, p.notes)))), /*#__PURE__*/React.createElement("div", {
    className: "rp-foot"
  }, /*#__PURE__*/React.createElement("span", null, "Photo Sheet"), /*#__PURE__*/React.createElement("span", null, "- ", pageNum, " -"), /*#__PURE__*/React.createElement("span", null, dateStr)));
}

// ── Project Dropdown ─────────────────────────────────────────────────────────
function ProjectDropdown({
  projList,
  activeId,
  projName,
  setProjName,
  onNew,
  onLoad,
  onDelete,
  onClose
}) {
  const ref = useRef();
  useEffect(() => {
    const fn = e => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const esc = e => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", fn);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fn);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  return /*#__PURE__*/React.createElement("div", {
    className: "dd-panel",
    ref: ref,
    style: {
      minWidth: 380
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr-title"
  }, "Reports"), /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr-sub"
  }, projList.length, " saved in this browser · IndexedDB")), /*#__PURE__*/React.createElement("div", {
    className: "dd-name-row"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11,
      marginBottom: 4
    }
  }, "Current report name"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: projName,
    onChange: e => setProjName(e.target.value),
    placeholder: "Untitled report",
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "dd-list"
  }, !projList.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px",
      fontSize: 13,
      color: "var(--text3)",
      textAlign: "center"
    }
  }, "No reports yet."), projList.map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    className: `dd-row${p.id === activeId ? " act" : ""}`,
    onClick: () => p.id !== activeId && onLoad(p.id)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: accentFor(p.id),
      flexShrink: 0
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-rn"
  }, p.name), /*#__PURE__*/React.createElement("div", {
    className: "dd-rs"
  }, p.insured && `${p.insured} · `, p.photoCount, " photo", p.photoCount !== 1 ? "s" : "", " · ", fmtAgo(p.updatedAt))), p.id === activeId ? /*#__PURE__*/React.createElement("span", {
    className: "badge b-blue",
    style: {
      fontSize: 10
    }
  }, "Active") : /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    onClick: e => {
      e.stopPropagation();
      onDelete(p.id);
    }
  }, "Delete")))), /*#__PURE__*/React.createElement("div", {
    className: "dd-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: onNew
  }, "+ New report")));
}

// ── Company Dropdown ─────────────────────────────────────────────────────────
function CompanyDropdown({
  companies,
  setCompanies,
  activeCo,
  setActiveCo,
  onClose
}) {
  var _form$name2;
  const [mode, setMode] = useState("list");
  const [form, setForm] = useState({
    ...EMPTY_CO
  });
  const ref = useRef();
  useEffect(() => {
    const fn = e => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const esc = e => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", fn);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fn);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const sf = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const save = useCallback(() => {
    var _form$name;
    if (!((_form$name = form.name) !== null && _form$name !== void 0 && _form$name.trim())) return;
    let updated, active;
    if (mode === "add") {
      active = {
        ...form,
        id: uid()
      };
      updated = [...companies, active];
    } else {
      active = {
        ...form
      };
      updated = companies.map(c => c.id === form.id ? active : c);
    }
    setCompanies(updated);
    lsSet(LS.cos, updated);
    setActiveCo(active);
    lsSet(LS.acoid, active.id);
    setMode("list");
  }, [form, mode, companies, setCompanies, setActiveCo]);
  const del = useCallback((e, id) => {
    e.stopPropagation();
    const u = companies.filter(c => c.id !== id);
    setCompanies(u);
    lsSet(LS.cos, u);
    if ((activeCo === null || activeCo === void 0 ? void 0 : activeCo.id) === id) {
      setActiveCo(null);
      lsSet(LS.acoid, null);
    }
  }, [companies, activeCo, setCompanies, setActiveCo]);
  return /*#__PURE__*/React.createElement("div", {
    className: "dd-panel",
    ref: ref
  }, mode === "list" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr-title"
  }, "Company profiles"), /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr-sub"
  }, "Saved permanently · populate every report header")), /*#__PURE__*/React.createElement("div", {
    className: "dd-list"
  }, !companies.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px",
      fontSize: 13,
      color: "var(--text3)",
      textAlign: "center"
    }
  }, "No profiles saved yet."), companies.map(c => /*#__PURE__*/React.createElement("div", {
    key: c.id,
    className: `dd-row${(activeCo === null || activeCo === void 0 ? void 0 : activeCo.id) === c.id ? " act" : ""}`,
    onClick: () => {
      setActiveCo(c);
      lsSet(LS.acoid, c.id);
      onClose();
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 32,
      height: 32,
      borderRadius: "var(--r-sm)",
      background: "var(--blue-50)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 14,
      flexShrink: 0
    }
  }, "🏢"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-rn"
  }, c.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    onClick: e => {
      e.stopPropagation();
      setForm({
        ...c
      });
      setMode("edit");
    }
  }, "Edit"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    onClick: e => del(e, c.id)
  }, "✕"))))), /*#__PURE__*/React.createElement("div", {
    className: "dd-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: () => {
      setForm({
        ...EMPTY_CO
      });
      setMode("add");
    }
  }, "+ Add company"), activeCo && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      setActiveCo(null);
      lsSet(LS.acoid, null);
      onClose();
    }
  }, "Clear"))), (mode === "add" || mode === "edit") && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dd-hdr-title"
  }, mode === "add" ? "New company profile" : "Edit profile")), /*#__PURE__*/React.createElement("div", {
    className: "dd-form"
  }, /*#__PURE__*/React.createElement("div", {
    className: "g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "frow s2"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Company name"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.name || "",
    onChange: e => sf("name", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow s2"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Address"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.address || "",
    onChange: e => sf("address", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Phone"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.phone || "",
    onChange: e => sf("phone", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Fax"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.fax || "",
    onChange: e => sf("fax", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow s2"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Email"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.email || "",
    onChange: e => sf("email", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow s2"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      fontSize: 11
    }
  }, "Website"), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    value: form.web || "",
    onChange: e => sf("web", e.target.value),
    style: {
      padding: "7px 10px",
      fontSize: 13
    }
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => setMode("list")
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    disabled: !((_form$name2 = form.name) !== null && _form$name2 !== void 0 && _form$name2.trim()),
    onClick: save
  }, "Save profile")))));
}

// ── User avatar background (deterministic from name) ─────────────────────────
const USER_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#dc2626", "#d97706", "#db2777", "#0284c7"];
function userColor(name) {
  let h = 0;
  for (let i = 0; i < (name || "").length; i++) {
    h = h * 31 + name.charCodeAt(i) >>> 0;
  }
  return USER_COLORS[h % USER_COLORS.length];
}
function userInitials(name) {
  const w = (name || "").trim().split(/\s+/);
  return w.length >= 2 ? (w[0][0] + w[w.length - 1][0]).toUpperCase() : name.slice(0, 2).toUpperCase() || "?";
}

// ── User Dropdown ─────────────────────────────────────────────────────────────
function UserDropdown({
  users,
  setUsers,
  activeUser,
  setActiveUser,
  onClose
}) {
  const [mode, setMode] = useState("list"); // list | add | edit
  const [form, setForm] = useState({
    id: null,
    name: "",
    role: ""
  });
  const ref = useRef();
  useEffect(() => {
    const fn = e => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const esc = e => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", fn);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", fn);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const sf = (k, v) => setForm(f => ({
    ...f,
    [k]: v
  }));
  const save = () => {
    if (!form.name.trim()) return;
    let updated, active;
    if (mode === "add") {
      active = {
        ...form,
        id: uid()
      };
      updated = [...users, active];
    } else {
      active = {
        ...form
      };
      updated = users.map(u => u.id === form.id ? active : u);
    }
    setUsers(updated);
    lsSet(LS.users, updated);
    setActiveUser(active);
    lsSet(LS.auid, active.id);
    setMode("list");
  };
  const del = (e, id) => {
    e.stopPropagation();
    const u = users.filter(x => x.id !== id);
    setUsers(u);
    lsSet(LS.users, u);
    if ((activeUser === null || activeUser === void 0 ? void 0 : activeUser.id) === id) {
      setActiveUser(null);
      lsSet(LS.auid, null);
    }
  };
  const pick = u => {
    setActiveUser(u);
    lsSet(LS.auid, u.id);
    onClose();
  };
  const startEdit = (e, u) => {
    e.stopPropagation();
    setForm({
      ...u
    });
    setMode("edit");
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "user-menu",
    ref: ref
  }, mode === "list" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "user-menu-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "user-menu-hdr-title"
  }, "Field users"), /*#__PURE__*/React.createElement("div", {
    className: "user-menu-hdr-sub"
  }, "Active user auto-fills \"Taken by\" on every photo")), /*#__PURE__*/React.createElement("div", {
    className: "user-list"
  }, !users.length && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "14px 16px",
      fontSize: 13,
      color: "var(--text3)",
      textAlign: "center"
    }
  }, "No users added yet."), users.map(u => /*#__PURE__*/React.createElement("div", {
    key: u.id,
    className: `user-row${(activeUser === null || activeUser === void 0 ? void 0 : activeUser.id) === u.id ? " act" : ""}`,
    onClick: () => pick(u)
  }, /*#__PURE__*/React.createElement("div", {
    className: "user-avatar",
    style: {
      background: userColor(u.name)
    }
  }, userInitials(u.name)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "user-name"
  }, u.name), u.role && /*#__PURE__*/React.createElement("div", {
    className: "user-role"
  }, u.role)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 4,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    onClick: e => startEdit(e, u)
  }, "Edit"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    onClick: e => del(e, u.id)
  }, "✕"))))), /*#__PURE__*/React.createElement("div", {
    className: "user-menu-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: () => {
      setForm({
        id: null,
        name: "",
        role: ""
      });
      setMode("add");
    }
  }, "+ Add user"), activeUser && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      setActiveUser(null);
      lsSet(LS.auid, null);
      onClose();
    }
  }, "Clear"))), (mode === "add" || mode === "edit") && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "user-menu-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "user-menu-hdr-title"
  }, mode === "add" ? "New user" : "Edit user")), /*#__PURE__*/React.createElement("div", {
    className: "user-form"
  }, /*#__PURE__*/React.createElement("div", {
    className: "frow"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Full name"), /*#__PURE__*/React.createElement("input", {
    value: form.name || "",
    onChange: e => sf("name", e.target.value),
    placeholder: "e.g. Bryon Edwards"
  })), /*#__PURE__*/React.createElement("div", {
    className: "frow"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Title / role ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      textTransform: "none",
      letterSpacing: 0,
      color: "var(--text3)"
    }
  }, "— optional")), /*#__PURE__*/React.createElement("input", {
    value: form.role || "",
    onChange: e => sf("role", e.target.value),
    placeholder: "e.g. Senior Field Adjuster"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => setMode("list")
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    disabled: !form.name.trim(),
    onClick: save
  }, "Save")))));
}

// ── TakenBySelect — dropdown populated from saved users + free-text fallback ──
// FIX: removed duplicate value="__manual__" on two options (caused select to always
// resolve to first match). "Enter manually…" now uses value="__clear__" to distinguish.
// FIX: removed unused `isManual` computed variable.
function TakenBySelect({
  value,
  onChange,
  users,
  placeholder
}) {
  const matchedUser = users.find(u => u.name === value);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("select", {
    className: "takenby-select",
    value: matchedUser ? value : "",
    onChange: e => {
      if (e.target.value === "") return; // prompt option — do nothing
      onChange(e.target.value);
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, matchedUser ? matchedUser.name : placeholder || "Select saved user…"), users.map(u => /*#__PURE__*/React.createElement("option", {
    key: u.id,
    value: u.name
  }, u.name, u.role ? ` — ${u.role}` : ""))), /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: value || "",
    placeholder: placeholder || "Or type name…",
    onChange: e => onChange(e.target.value),
    style: {
      fontSize: 13,
      padding: "7px 10px"
    }
  }));
}

// ── App Header ───────────────────────────────────────────────────────────────
function AppHeader({
  projList,
  activeId,
  projName,
  setProjName,
  onNew,
  onLoad,
  onDelete,
  companies,
  setCompanies,
  activeCo,
  setActiveCo,
  users,
  setUsers,
  activeUser,
  setActiveUser,
  showPrint,
  onPrint
}) {
  const [showProj, setShowProj] = useState(false);
  const [showCo, setShowCo] = useState(false);
  const [showUser, setShowUser] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [lastBackup, setLastBackup] = useState(() => lsGet(LS.lastBackup, 0));
  const closeBackup = useCallback(() => setShowBackup(false), []);
  const photoTotal = projList.reduce((n, p) => n + (p.photoCount || 0), 0);
  const closeProj = useCallback(() => setShowProj(false), []);
  const closeCo = useCallback(() => setShowCo(false), []);
  const closeUser = useCallback(() => setShowUser(false), []);
  return /*#__PURE__*/React.createElement("header", {
    className: "app-hdr no-print"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-hdr-inner"
  }, /*#__PURE__*/React.createElement("div", {
    className: "app-logo"
  }, /*#__PURE__*/React.createElement("div", {
    className: "logo-mark"
  }, "📷"), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "logo-text"
  }, "ClaimPhoto"), /*#__PURE__*/React.createElement("div", {
    className: "logo-sub"
  }, "FIELD INSPECTION"))), /*#__PURE__*/React.createElement("div", {
    className: "hdr-spacer"
  }), showPrint && /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: onPrint,
    style: {
      background: "rgba(37,99,235,.6)",
      borderColor: "rgba(37,99,235,.8)",
      color: "#fff"
    }
  }, "🖨 ", /*#__PURE__*/React.createElement("span", {
    className: "hdr-btn-label"
  }, "Print / PDF")), /*#__PURE__*/React.createElement("div", {
    className: "dd-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: () => setShowBackup(v => !v),
    "aria-label": "Backup and restore",
    "data-testid": "backup-btn"
  }, "💾", backupIsStale(lastBackup, photoTotal) && /*#__PURE__*/React.createElement("span", {
    className: "bk-dot",
    "data-testid": "backup-dot"
  }), " ", /*#__PURE__*/React.createElement("span", {
    className: "hdr-btn-label"
  }, "Backup"), " ▾"), showBackup && /*#__PURE__*/React.createElement(BackupPanel, {
    loadAll: backupLoadAll,
    applyImport: backupApplyImport,
    lastBackup: lastBackup,
    onBackedUp: ts => {
      lsSet(LS.lastBackup, ts);
      setLastBackup(ts);
    },
    photoTotal: photoTotal,
    onClose: closeBackup
  })), /*#__PURE__*/React.createElement("div", {
    className: "dd-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: () => setShowProj(v => !v)
  }, "📁 ", /*#__PURE__*/React.createElement("span", {
    className: "hdr-btn-label"
  }, projList.length, " Report", projList.length !== 1 ? "s" : ""), " ▾"), showProj && /*#__PURE__*/React.createElement(ProjectDropdown, {
    projList: projList,
    activeId: activeId,
    projName: projName,
    setProjName: setProjName,
    onNew: onNew,
    onLoad: onLoad,
    onDelete: onDelete,
    onClose: closeProj
  })), /*#__PURE__*/React.createElement("div", {
    className: "dd-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: () => setShowCo(v => !v)
  }, activeCo && /*#__PURE__*/React.createElement("span", {
    className: "hdr-dot"
  }), "🏢 ", /*#__PURE__*/React.createElement("span", {
    className: "hdr-btn-label"
  }, activeCo ? activeCo.name : "Company"), " ▾"), showCo && /*#__PURE__*/React.createElement(CompanyDropdown, {
    companies: companies,
    setCompanies: setCompanies,
    activeCo: activeCo,
    setActiveCo: setActiveCo,
    onClose: closeCo
  })), /*#__PURE__*/React.createElement("div", {
    className: "dd-wrap"
  }, /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: () => setShowUser(v => !v)
  }, activeUser ? /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: "50%",
      background: userColor(activeUser.name),
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 9,
      fontWeight: 700,
      color: "#fff",
      flexShrink: 0
    }
  }, userInitials(activeUser.name)) : "👤", /*#__PURE__*/React.createElement("span", {
    className: "hdr-btn-label"
  }, activeUser ? activeUser.name : "Users"), " ▾"), showUser && /*#__PURE__*/React.createElement(UserDropdown, {
    users: users,
    setUsers: setUsers,
    activeUser: activeUser,
    setActiveUser: setActiveUser,
    onClose: closeUser
  }))));
}

// ── Sub-header with steps ────────────────────────────────────────────────────
function SubHeader({
  projName,
  setProjName,
  editorTab,
  setEditorTab,
  claim,
  photos,
  checklist,
  saveState,
  onBack
}) {
  const claimDone = claim.insured && claim.claimNum;
  const photosDone = photos.length > 0 && photos.every(p => p.label);
  const clTotal = CHECKLIST_TMPL.reduce((s, sec) => s + sec.items.length, 0);
  const clDone = Object.values(checklist || {}).filter(v => v.status === "ok" || v.status === "issue").length;
  const steps = [{
    id: "claim",
    label: "Claim info",
    done: !!claimDone,
    num: "1"
  }, {
    id: "photos",
    label: `Photos (${photos.length})`,
    done: !!photosDone,
    num: "2"
  }, {
    id: "checklist",
    label: `Checklist (${clDone}/${clTotal})`,
    done: clDone === clTotal && clTotal > 0,
    num: "3"
  }, {
    id: "preview",
    label: "Preview",
    done: false,
    num: "4"
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "sub-hdr no-print"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sub-hdr-inner"
  }, /*#__PURE__*/React.createElement("button", {
    className: "back-link",
    onClick: onBack
  }, "← Reports"), /*#__PURE__*/React.createElement("input", {
    className: "report-name-input",
    value: projName,
    onChange: e => setProjName(e.target.value),
    placeholder: "Report name…",
    title: "Click to rename report"
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "steps"
  }, steps.map((s, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: s.id
  }, i > 0 && /*#__PURE__*/React.createElement("div", {
    className: "step-sep"
  }), /*#__PURE__*/React.createElement("button", {
    className: `step-btn${editorTab === s.id ? " step-active" : ""}${s.done && editorTab !== s.id ? " step-done" : ""}`,
    onClick: () => setEditorTab(s.id)
  }, /*#__PURE__*/React.createElement("span", {
    className: "step-num"
  }, s.done && editorTab !== s.id ? "✓" : s.num), /*#__PURE__*/React.createElement("span", {
    className: "step-lbl"
  }, s.label))))), /*#__PURE__*/React.createElement("div", {
    className: `save-state${saveState === "saved" ? " saved" : ""}`
  }, saveState === "saving" && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      width: 11,
      height: 11
    }
  }), " Saving…"), saveState === "saved" && /*#__PURE__*/React.createElement(React.Fragment, null, "✓ Saved"))));
}

// ── Dashboard ────────────────────────────────────────────────────────────────
function ReportCard({
  proj,
  isActive,
  onOpen,
  onDelete,
  onExport
}) {
  var _proj$photos, _proj$photos2, _proj$claim, _proj$claim2, _proj$photos3;
  const accent = accentFor(proj.id);
  const thumbs = ((_proj$photos = proj.photos) === null || _proj$photos === void 0 ? void 0 : _proj$photos.slice(0, 4)) || [];
  const unlabeled = ((_proj$photos2 = proj.photos) === null || _proj$photos2 === void 0 ? void 0 : _proj$photos2.filter(p => !p.label).length) || 0;
  return /*#__PURE__*/React.createElement("div", {
    className: `rc${isActive ? " rc-active" : ""}`,
    onClick: () => onOpen(proj.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "rc-stripe",
    style: {
      background: `linear-gradient(90deg,${accent},${accent}88)`
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "rc-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rc-name"
  }, proj.name), /*#__PURE__*/React.createElement("div", {
    className: "rc-claim"
  }, ((_proj$claim = proj.claim) === null || _proj$claim === void 0 ? void 0 : _proj$claim.claimNum) || ((_proj$claim2 = proj.claim) === null || _proj$claim2 === void 0 ? void 0 : _proj$claim2.insured) || "No claim info yet"), thumbs.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "rc-preview"
  }, thumbs.map(p => p.imageData ? /*#__PURE__*/React.createElement("img", {
    key: p.id,
    className: "rc-thumb",
    src: p.imageData,
    alt: ""
  }) : /*#__PURE__*/React.createElement("div", {
    key: p.id,
    className: "rc-thumb-ph"
  }, "📷")), (((_proj$photos3 = proj.photos) === null || _proj$photos3 === void 0 ? void 0 : _proj$photos3.length) || 0) > 4 && /*#__PURE__*/React.createElement("div", {
    className: "rc-thumb-ph",
    style: {
      fontSize: 11,
      fontWeight: 700,
      color: "var(--text2)"
    }
  }, "+", proj.photos.length - 4)), /*#__PURE__*/React.createElement("div", {
    className: "rc-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "stat-pill"
  }, "📸 ", proj.photoCount || 0, " photo", proj.photoCount !== 1 ? "s" : ""), isActive && /*#__PURE__*/React.createElement("span", {
    className: "badge b-green",
    style: {
      fontSize: 10
    }
  }, "● Active"), unlabeled > 0 && /*#__PURE__*/React.createElement("span", {
    className: "badge b-amber",
    style: {
      fontSize: 10
    }
  }, "⚠ ", unlabeled, " unlabeled"))), /*#__PURE__*/React.createElement("div", {
    className: "rc-footer"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text2)"
    }
  }, fmtAgo(proj.updatedAt)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6
    },
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    onClick: () => onExport && onExport(proj.id),
    title: "Save this report as a file",
    "data-testid": "export-one"
  }, "Export"), !isActive && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    onClick: () => onDelete(proj.id)
  }, "Delete"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-primary",
    onClick: () => onOpen(proj.id)
  }, isActive ? "Continue →" : "Open →"))));
}
function Dashboard({
  projList,
  activeId,
  onOpen,
  onDelete,
  onNew,
  onExport
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "page"
  }, /*#__PURE__*/React.createElement("div", {
    className: "dash-hdr"
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "dash-title"
  }, "Inspection Reports"), /*#__PURE__*/React.createElement("div", {
    className: "dash-sub"
  }, projList.length, " report", projList.length !== 1 ? "s" : "", " saved in this browser")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: onNew
  }, "+ New Report")), !projList.length ? /*#__PURE__*/React.createElement("div", {
    className: "empty-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "empty-icon"
  }, "📋"), /*#__PURE__*/React.createElement("div", {
    className: "empty-ttl"
  }, "No reports yet"), /*#__PURE__*/React.createElement("div", {
    className: "empty-sub"
  }, "Create your first inspection report to get started."), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: onNew
  }, "Create first report")) : /*#__PURE__*/React.createElement("div", {
    className: "report-grid"
  }, [...projList].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).map(p => /*#__PURE__*/React.createElement(ReportCard, {
    key: p.id,
    proj: p,
    onExport: onExport,
    isActive: p.id === activeId,
    onOpen: onOpen,
    onDelete: onDelete
  }))));
}

// ── Claim Form ───────────────────────────────────────────────────────────────
function ClaimForm({
  claim,
  set,
  onNext
}) {
  const done = claim.insured && claim.claimNum && claim.policyNum;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-title"
  }, "Claim details"), /*#__PURE__*/React.createElement("div", {
    className: "g2"
  }, /*#__PURE__*/React.createElement("div", {
    className: "s2"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: claim.partyLabel || "insured",
    onChange: e => set("partyLabel", e.target.value),
    style: {
      width: "auto",
      padding: "4px 30px 4px 10px",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: ".03em",
      textTransform: "uppercase",
      color: "var(--text2)",
      borderColor: "var(--bdr)",
      borderRadius: "var(--r-sm)",
      background: "var(--surface2)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: "insured"
  }, "Insured name"), /*#__PURE__*/React.createElement("option", {
    value: "claimant"
  }, "Claimant name"))), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    type: "text",
    value: claim.insured || "",
    placeholder: claim.partyLabel === "claimant" ? "Full name of claimant" : "Full name of insured party",
    onChange: e => set("insured", e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "s2"
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Claimant name ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 400,
      textTransform: "none",
      letterSpacing: 0,
      color: "var(--text3)"
    }
  }, "— if different from insured")), /*#__PURE__*/React.createElement("input", {
    className: "inp",
    type: "text",
    value: claim.claimant || "",
    placeholder: "Claimant's full name (optional)",
    onChange: e => set("claimant", e.target.value)
  })), /*#__PURE__*/React.createElement(Field, {
    label: "Claim number",
    value: claim.claimNum,
    onChange: v => set("claimNum", v),
    placeholder: "e.g. 2026-HGA01499"
  }), /*#__PURE__*/React.createElement(Field, {
    label: "Policy number",
    value: claim.policyNum,
    onChange: v => set("policyNum", v),
    placeholder: "e.g. HGA-147315-000"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: onNext
  }, done ? "Continue to photos →" : "Save & continue →")));
}

// ── Photo Reviewer ────────────────────────────────────────────────────────────
function PhotoReviewer({
  items,
  setItems,
  batchDate,
  setBatchDate,
  batchTakenBy,
  setBatchTakenBy,
  users,
  macros,
  onAddMacro,
  onDeleteMacro,
  onConfirm,
  onBack,
  onCamera
}) {
  var _items$cur;
  const [cur, setCur] = useState(0);
  const [drag, setDrag] = useState(false);
  const [loading, setLoading] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSel, setBulkSel] = useState(new Set());
  const [batchGps, setBatchGps] = useState(null);
  const fileRef = useRef();
  const stripRef = useRef();
  const item = (_items$cur = items[cur]) !== null && _items$cur !== void 0 ? _items$cur : null;
  // FIX Bug 1: reset GPS on every mount so stale coordinates from a previous
  // batch session don't silently stamp all new photos with old coordinates.
  useEffect(() => {
    setBatchGps(null);
  }, []);
  useEffect(() => {
    var _stripRef$current;
    (_stripRef$current = stripRef.current) === null || _stripRef$current === void 0 || (_stripRef$current = _stripRef$current.querySelectorAll(".film-f")[cur]) === null || _stripRef$current === void 0 || _stripRef$current.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center"
    });
  }, [cur]);
  useEffect(() => {
    const fn = e => {
      if (bulkMode) return;
      if (e.key === "ArrowRight") setCur(c => Math.min(c + 1, items.length - 1));
      if (e.key === "ArrowLeft") setCur(c => Math.max(c - 1, 0));
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [items.length, bulkMode]);
  const addFiles = useCallback(async fl => {
    setLoading(true);
    const loaded = await loadFilesWithGPS(fl, batchGps);
    setLoading(false);
    if (!loaded.length) return;
    const start = items.length;
    setItems(q => [...q, ...loaded]);
    if (!bulkMode) setCur(start);
  }, [items.length, bulkMode, setItems, batchGps]);
  const upd = useCallback(patch => {
    setItems(q => q.map((x, i) => i === cur ? {
      ...x,
      ...patch
    } : x));
  }, [cur, setItems]);
  const del = useCallback(() => {
    if (bulkMode && bulkSel.size) {
      setItems(q => q.filter((_, i) => !bulkSel.has(i)));
      setBulkSel(new Set());
      setCur(0);
    } else setItems(q => {
      const n = q.filter((_, i) => i !== cur);
      setCur(c => Math.max(0, Math.min(c, n.length - 1)));
      return n;
    });
  }, [cur, bulkMode, bulkSel, setItems]);
  // onLabelPick removed — MacroSelect onChange handles label selection directly
  const bulkLabel = useCallback(l => {
    if (!bulkSel.size) return;
    setItems(q => q.map((x, i) => bulkSel.has(i) ? {
      ...x,
      label: l,
      customLabel: ""
    } : x));
    toast(`"${l}" applied to ${bulkSel.size} photo${bulkSel.size > 1 ? "s" : ""}`);
    setBulkSel(new Set());
  }, [bulkSel, setItems]);
  const bulkNote = useCallback(n => {
    if (!bulkSel.size) return;
    setItems(q => q.map((x, i) => bulkSel.has(i) ? {
      ...x,
      notes: n
    } : x));
    toast(`Note applied to ${bulkSel.size} photo${bulkSel.size > 1 ? "s" : ""}`);
  }, [bulkSel, setItems]);
  const toggleFrame = useCallback(i => {
    setBulkSel(s => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });
  }, []);
  const selectAll = () => setBulkSel(new Set(items.map((_, i) => i)));
  const selectUnlabeled = () => setBulkSel(new Set(items.reduce((a, it, i) => !it.label && !it.customLabel.trim() ? [...a, i] : a, [])));
  const unlabeled = items.filter(it => !(it.label || it.customLabel.trim())).length;
  const allOk = items.length > 0; // photos may be added unlabeled and labeled later
  const unlabeledCount = items.filter(it => !it.label && !it.customLabel.trim()).length;
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    style: {
      border: "1.5px solid var(--bdr2)"
    },
    onClick: onBack
  }, "← Back"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 700
    }
  }, "Label photos ", loading && /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      marginLeft: 6
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      var _fileRef$current;
      return (_fileRef$current = fileRef.current) === null || _fileRef$current === void 0 ? void 0 : _fileRef$current.click();
    }
  }, "+ Add more"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: onCamera
  }, "📷 Camera"), /*#__PURE__*/React.createElement("input", {
    ref: fileRef,
    type: "file",
    accept: "image/*",
    multiple: true,
    onChange: e => {
      addFiles(e.target.files);
      e.target.value = "";
    }
  }))), items.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: `dz${drag ? " over" : ""}`,
    style: {
      minHeight: 260
    },
    onDragOver: e => {
      e.preventDefault();
      setDrag(true);
    },
    onDragLeave: () => setDrag(false),
    onDrop: e => {
      e.preventDefault();
      setDrag(false);
      addFiles(e.dataTransfer.files);
    },
    onClick: () => {
      var _fileRef$current2;
      return (_fileRef$current2 = fileRef.current) === null || _fileRef$current2 === void 0 ? void 0 : _fileRef$current2.click();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "dz-icon"
  }, "📸"), /*#__PURE__*/React.createElement("div", {
    className: "dz-title"
  }, "Tap or drag photos here"), /*#__PURE__*/React.createElement("div", {
    className: "dz-sub"
  }, "Select multiple files at once · JPG / PNG · Shift+click for range"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    style: {
      marginTop: 16
    },
    onClick: e => {
      e.stopPropagation();
      onCamera();
    }
  }, "📷 Take photos with camera")) : /*#__PURE__*/React.createElement("div", {
    className: "reviewer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rev-prog-row"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rev-prog-track"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rev-prog-fill",
    style: {
      width: `${(cur + 1) / items.length * 100}%`
    }
  })), /*#__PURE__*/React.createElement("span", {
    className: "rev-cnt"
  }, cur + 1, " / ", items.length), unlabeledCount > 0 && /*#__PURE__*/React.createElement("span", {
    className: "badge b-amber",
    style: {
      fontSize: 11
    }
  }, unlabeledCount, " unlabeled")), !bulkMode && /*#__PURE__*/React.createElement("div", {
    className: "rev-main"
  }, item !== null && item !== void 0 && item.imageData ? /*#__PURE__*/React.createElement("img", {
    src: item.imageData,
    alt: ""
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#555",
      fontSize: 13
    }
  }, "No image"), cur > 0 && /*#__PURE__*/React.createElement("button", {
    className: "rev-nav prev",
    onClick: () => setCur(c => c - 1)
  }, "‹"), cur < items.length - 1 && /*#__PURE__*/React.createElement("button", {
    className: "rev-nav next",
    onClick: () => setCur(c => c + 1)
  }, "›"), item && (item.label || item.customLabel.trim()) && /*#__PURE__*/React.createElement("span", {
    className: "rev-overlay"
  }, item.customLabel.trim() || item.label)), /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      marginBottom: 6,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm${bulkMode ? " btn-primary" : ""}`,
    onClick: () => {
      setBulkMode(b => !b);
      setBulkSel(new Set());
    }
  }, bulkMode ? `✓ ${bulkSel.size} selected` : "Select multiple"), bulkMode && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: bulkSel.size === items.length ? {
      background: "var(--blue-50)",
      color: "var(--blue-700)",
      borderColor: "var(--blue-300)"
    } : {},
    onClick: bulkSel.size === items.length ? () => setBulkSel(new Set()) : selectAll
  }, bulkSel.size === items.length ? `✓ Deselect all` : `Select all ${items.length}`), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    onClick: selectUnlabeled
  }, "Unlabeled only"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    onClick: () => setBulkSel(new Set())
  }, "Clear"), bulkSel.size > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    onClick: del
  }, "Remove ", bulkSel.size))), /*#__PURE__*/React.createElement("div", {
    ref: stripRef,
    className: "filmstrip"
  }, items.map((it, i) => {
    const ok = it.label || it.customLabel.trim();
    const sel = bulkMode && bulkSel.has(i);
    return /*#__PURE__*/React.createElement("div", {
      key: it.id,
      className: `film-f${!bulkMode && i === cur ? " on" : ""}${sel ? " sel-f" : ""}`,
      onClick: () => bulkMode ? toggleFrame(i) : setCur(i)
    }, it.imageData && /*#__PURE__*/React.createElement("img", {
      src: it.imageData,
      alt: ""
    }), sel ? /*#__PURE__*/React.createElement("span", {
      className: "film-bd film-sl"
    }, "✓") : ok ? /*#__PURE__*/React.createElement("span", {
      className: "film-bd film-ok"
    }, "✓") : /*#__PURE__*/React.createElement("span", {
      className: "film-bd film-wn"
    }, "!"));
  }))), /*#__PURE__*/React.createElement("div", {
    className: "rev-panel"
  }, bulkMode && /*#__PURE__*/React.createElement("div", {
    className: "hint hint-blue"
  }, bulkSel.size === 0 ? "Select photos in the filmstrip above, then tap a label or note to apply to all." : `Tap a label or note → applies to all ${bulkSel.size} selected photo${bulkSel.size > 1 ? "s" : ""}`), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "rev-section-ttl"
  }, "Photo label"), bulkMode ? /*#__PURE__*/React.createElement(MacroSelect, {
    type: "label",
    value: "",
    onChange: bulkLabel,
    macros: (macros === null || macros === void 0 ? void 0 : macros.labels) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Apply label to selected…"
  }) : /*#__PURE__*/React.createElement(MacroSelect, {
    type: "label",
    value: (item === null || item === void 0 ? void 0 : item.customLabel) || (item === null || item === void 0 ? void 0 : item.label) || "",
    onChange: v => {
      const all = [...DEFAULT_LABELS, ...((macros === null || macros === void 0 ? void 0 : macros.labels) || [])];
      all.includes(v) ? upd({
        label: v,
        customLabel: ""
      }) : upd({
        label: "",
        customLabel: v
      });
    },
    macros: (macros === null || macros === void 0 ? void 0 : macros.labels) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add label…"
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "rev-section-ttl"
  }, "Notes (optional)"), bulkMode ? /*#__PURE__*/React.createElement(MacroSelect, {
    type: "note",
    value: "",
    onChange: bulkNote,
    macros: (macros === null || macros === void 0 ? void 0 : macros.notes) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Apply notes to selected…"
  }) : /*#__PURE__*/React.createElement(MacroSelect, {
    type: "note",
    value: (item === null || item === void 0 ? void 0 : item.notes) || "",
    onChange: v => upd({
      notes: v
    }),
    macros: (macros === null || macros === void 0 ? void 0 : macros.notes) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add notes…"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "rev-footer"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      margin: 0,
      whiteSpace: "nowrap",
      fontSize: 11
    }
  }, "Date:"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: batchDate,
    className: "inp",
    style: {
      width: "auto",
      fontSize: 13,
      padding: "6px 10px"
    },
    onChange: e => setBatchDate(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl",
    style: {
      margin: 0,
      whiteSpace: "nowrap",
      fontSize: 11
    }
  }, "Taken by:"), /*#__PURE__*/React.createElement(TakenBySelect, {
    value: batchTakenBy,
    onChange: setBatchTakenBy,
    users: users,
    placeholder: "Adjuster name…"
  })), /*#__PURE__*/React.createElement(GpsButton, {
    gps: batchGps,
    onCapture: g => {
      setBatchGps(g);
      if (g) setItems(q => q.map(it => ({
        ...it,
        gps: g
      })));
    }
  })), !bulkMode && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs btn-danger",
    disabled: !items.length,
    onClick: del
  }, "Remove"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 8,
      alignItems: "center"
    }
  }, unlabeled > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--amber-600)",
      fontWeight: 500
    }
  }, "⚠ ", unlabeled, " unlabeled — you can label them later"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    disabled: !allOk,
    onClick: onConfirm
  }, "Add ", items.length, " photo", items.length > 1 ? "s" : "", " →")))));
}

// ── Edit Single Photo (with prev/next scroll navigation) ─────────────────────
function EditPhotoView({
  draft,
  setDraft,
  onSave,
  onCancel,
  photoIdx,
  photosCount,
  onNavigate,
  users,
  macros,
  onAddMacro,
  onDeleteMacro
}) {
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showAnnotate, setShowAnnotate] = useState(false);
  const fr = useRef();
  const swipeRef = useRef();
  const upd = useCallback(p => setDraft(d => ({
    ...d,
    ...p
  })), [setDraft]);
  const rotate = useCallback(async deg => {
    if (!draft.imageData || rotating) return;
    setRotating(true);
    const rotated = await rotateImage(draft.imageData, deg);
    upd({
      imageData: rotated,
      annotation: null
    });
    setRotating(false);
    toast(`Rotated ${deg === 90 ? "clockwise" : "counter-clockwise"}`);
  }, [draft.imageData, rotating, upd]);
  const navTo = useCallback(newIdx => {
    onNavigate(newIdx);
  }, [onNavigate]);
  useEffect(() => {
    const fn = e => {
      var _document$activeEleme;
      if (["INPUT", "TEXTAREA", "SELECT"].includes((_document$activeEleme = document.activeElement) === null || _document$activeEleme === void 0 ? void 0 : _document$activeEleme.tagName)) return;
      if (e.key === "ArrowRight" && photoIdx < photosCount - 1) navTo(photoIdx + 1);
      if (e.key === "ArrowLeft" && photoIdx > 0) navTo(photoIdx - 1);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [photoIdx, photosCount, navTo]);
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginBottom: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-ghost",
    style: {
      border: "1.5px solid var(--bdr2)"
    },
    onClick: onCancel
  }, "← Back"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 700,
      flex: 1
    }
  }, "Edit photo ", (loading || rotating) && /*#__PURE__*/React.createElement("span", {
    className: "spinner"
  })), photosCount > 1 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "var(--text3)"
    }
  }, "← → keys"), /*#__PURE__*/React.createElement("div", {
    className: "edit-nav-bar"
  }, /*#__PURE__*/React.createElement("button", {
    className: "edit-nav-btn",
    disabled: photoIdx === 0,
    onClick: () => navTo(photoIdx - 1)
  }, "‹"), /*#__PURE__*/React.createElement("span", {
    className: "edit-nav-count"
  }, photoIdx + 1, " / ", photosCount), /*#__PURE__*/React.createElement("button", {
    className: "edit-nav-btn",
    disabled: photoIdx === photosCount - 1,
    onClick: () => navTo(photoIdx + 1)
  }, "›")))), /*#__PURE__*/React.createElement("div", {
    className: "edit-2col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "edit-photo-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "edit-photo-viewer",
    ref: swipeRef,
    style: {
      marginBottom: 10
    },
    onTouchStart: e => {
      swipeRef.current._sx = e.touches[0].clientX;
    },
    onTouchEnd: e => {
      const dx = e.changedTouches[0].clientX - (swipeRef.current._sx || 0);
      if (Math.abs(dx) > 50) {
        if (dx < 0 && photoIdx < photosCount - 1) navTo(photoIdx + 1);
        if (dx > 0 && photoIdx > 0) navTo(photoIdx - 1);
      }
    }
  }, draft.imageData ? /*#__PURE__*/React.createElement("img", {
    src: draft.imageData,
    alt: ""
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#555",
      fontSize: 13,
      padding: "2rem",
      textAlign: "center"
    }
  }, "No image")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      var _fr$current;
      return (_fr$current = fr.current) === null || _fr$current === void 0 ? void 0 : _fr$current.click();
    }
  }, "📷 Change"), /*#__PURE__*/React.createElement("input", {
    ref: fr,
    type: "file",
    accept: "image/*",
    onChange: async e => {
      const f = e.target.files[0];
      if (!f) return;
      setLoading(true);
      upd({
        imageData: await compress(f),
        annotation: null
      });
      setLoading(false);
    }
  }), draft.imageData && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    disabled: rotating,
    onClick: () => rotate(270),
    title: "Rotate CCW"
  }, "↺"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    disabled: rotating,
    onClick: () => rotate(90),
    title: "Rotate CW"
  }, "↻"), /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm${draft.annotation ? " btn-primary" : ""}`,
    onClick: () => setShowAnnotate(true)
  }, "✏", draft.annotation ? " Annotated" : " Annotate")), /*#__PURE__*/React.createElement(GpsButton, {
    gps: draft.gps,
    onCapture: g => upd({
      gps: g
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      display: "flex",
      gap: 8,
      flexWrap: "wrap",
      alignItems: "center"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: onCancel
  }, "Cancel"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: onSave
  }, "Save changes"), photosCount > 1 && photoIdx > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn",
    onClick: () => navTo(photoIdx - 1)
  }, "← Prev"), photosCount > 1 && photoIdx < photosCount - 1 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => navTo(photoIdx + 1)
  }, "Save & next →"))), /*#__PURE__*/React.createElement("div", {
    className: "edit-fields-col"
  }, /*#__PURE__*/React.createElement("div", {
    className: "edit-fields-inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "edit-fields-label"
  }, "Photo label"), /*#__PURE__*/React.createElement(MacroSelect, {
    type: "label",
    value: draft.label || draft.customLabel || "",
    onChange: v => {
      if (DEFAULT_LABELS.includes(v) || ((macros === null || macros === void 0 ? void 0 : macros.labels) || []).includes(v)) {
        upd({
          label: v,
          customLabel: ""
        });
      } else {
        upd({
          label: "",
          customLabel: v
        });
      }
    },
    macros: (macros === null || macros === void 0 ? void 0 : macros.labels) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add label…"
  })), /*#__PURE__*/React.createElement("div", {
    className: "edit-fields-inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "edit-fields-label"
  }, "Notes"), /*#__PURE__*/React.createElement(MacroSelect, {
    type: "note",
    value: draft.notes || "",
    onChange: v => upd({
      notes: v
    }),
    macros: (macros === null || macros === void 0 ? void 0 : macros.notes) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add notes…"
  }), draft.notes && ![...DEFAULT_NOTES, ...((macros === null || macros === void 0 ? void 0 : macros.notes) || [])].includes(draft.notes) && /*#__PURE__*/React.createElement("input", {
    className: "inp",
    style: {
      marginTop: 6,
      fontSize: 13,
      padding: "7px 10px"
    },
    placeholder: "Custom notes…",
    value: draft.notes || "",
    onChange: e => upd({
      notes: e.target.value
    })
  }), !draft.notes && /*#__PURE__*/React.createElement("input", {
    className: "inp",
    style: {
      marginTop: 6,
      fontSize: 13,
      padding: "7px 10px"
    },
    placeholder: "Or type custom notes…",
    value: draft.notes || "",
    onChange: e => upd({
      notes: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    className: "edit-fields-inner"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 10,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 140
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "edit-fields-label"
  }, "Date taken"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: draft.dateTaken || "",
    className: "inp",
    style: {
      width: "auto",
      fontSize: 13,
      padding: "7px 10px"
    },
    onChange: e => upd({
      dateTaken: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 160
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "edit-fields-label"
  }, "Taken by"), /*#__PURE__*/React.createElement(TakenBySelect, {
    value: draft.takenBy || "",
    onChange: v => upd({
      takenBy: v
    }),
    users: users,
    placeholder: "Select adjuster…"
  })))))), showAnnotate && draft.imageData && /*#__PURE__*/React.createElement(AnnotationEditor, {
    imageData: draft.annotation || draft.imageData,
    existing: null,
    onSave: annotated => {
      upd({
        annotation: annotated,
        imageData: annotated
      });
      setShowAnnotate(false);
      toast("Annotations saved");
    },
    onClose: () => setShowAnnotate(false)
  }));
}
// ── Photo Grid (drag-to-reorder + full bulk edit panel) ──────────────────────
function PhotoGrid({
  photos,
  onAdd,
  onCamera,
  onEdit,
  onDelete,
  onNext,
  layout,
  onBulkUpdate,
  onBulkDelete,
  onReorder,
  users,
  clearSplitToken,
  macros,
  onAddMacro,
  onDeleteMacro
}) {
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [viewMode, setViewMode] = useState("grid");
  const [splitId, setSplitId] = useState(null);
  const [splitDraft, setSplitDraft] = useState(null);

  // FIX Bug 2: reset the token after consuming it so the effect cannot re-fire
  // on subsequent renders while the same token value is still set.
  useEffect(() => {
    if (clearSplitToken && clearSplitToken === splitId) {
      setSplitId(null);
      setSplitDraft(null);
    }
    // Always clear the token after each effect run regardless of match
    // (parent's setClearSplitToken(null) call keeps it clean)
  }, [clearSplitToken, splitId]);
  // bulk field values
  const [bkLabel, setBkLabel] = useState("");
  const [bkCustomL, setBkCustomL] = useState("");
  const [bkNotes, setBkNotes] = useState("");
  const [bkCustomN, setBkCustomN] = useState("");
  const [bkDate, setBkDate] = useState("");
  const [bkTakenBy, setBkTakenBy] = useState("");
  // drag state
  const dragId = useRef(null);
  const [dragFromId, setDragFromId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  // scroll indicators
  const [scrollTop, setScrollTop] = useState(false);
  const [scrollBot, setScrollBot] = useState(false);
  const scrollRaf = useRef(null);
  const ppg = PPG_MAP[layout] || 2;
  const pgCount = Math.ceil(photos.length / ppg);
  const labeled = photos.filter(p => p.label).length;
  const toggleSel = useCallback(id => {
    setSelected(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }, []);
  const exitSel = () => {
    setSelMode(false);
    setSelected(new Set());
    setBkLabel("");
    setBkCustomL("");
    setBkNotes("");
    setBkCustomN("");
    setBkDate("");
    setBkTakenBy("");
  };
  const isAllSelected = photos.length > 0 && selected.size === photos.length;
  const selectAll = () => setSelected(new Set(photos.map(p => p.id)));
  const deselectAll = () => setSelected(new Set());
  const bulkHasValue = bkLabel || bkCustomL.trim() || bkNotes || bkCustomN.trim() || bkDate || bkTakenBy.trim();
  const applyBulk = () => {
    const patch = {};
    const label = bkCustomL.trim() || bkLabel;
    const notes = bkCustomN.trim() || bkNotes;
    if (label) patch.label = label;
    if (notes) patch.notes = notes;
    if (bkDate) patch.dateTaken = bkDate;
    if (bkTakenBy.trim()) patch.takenBy = bkTakenBy.trim();
    if (!Object.keys(patch).length) return;
    onBulkUpdate(selected, patch);
    exitSel();
  };

  // ── Desktop drag ──────────────────────────────────────────────────────────
  const onDragStart = (e, id) => {
    dragId.current = id;
    setDragFromId(id);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e, id) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (id !== dragId.current) setDragOverId(id);
  };
  const onDrop = (e, toId) => {
    e.preventDefault();
    if (dragId.current && dragId.current !== toId) onReorder(dragId.current, toId);
    setDragOverId(null);
    dragId.current = null;
    setDragFromId(null);
  };
  const onDragEnd = () => {
    setDragOverId(null);
    dragId.current = null;
    setDragFromId(null);
  };

  // ── Touch drag with auto-scroll ───────────────────────────────────────────
  const touchDragId = useRef(null);
  const touchClone = useRef(null);
  const SCROLL_EDGE = 100; // px from top/bottom that triggers scroll
  const SCROLL_SPD = 8; // px per animation frame

  const stopScroll = () => {
    if (scrollRaf.current) {
      cancelAnimationFrame(scrollRaf.current);
      scrollRaf.current = null;
    }
    setScrollTop(false);
    setScrollBot(false);
  };
  const onTouchStart = (e, id) => {
    if (selMode) return;
    touchDragId.current = id;
    setDragFromId(id);
    const el = e.currentTarget,
      rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true);
    clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;opacity:.78;pointer-events:none;z-index:9999;border-radius:var(--r-lg);box-shadow:0 10px 30px rgba(0,0,0,.3);transition:none;`;
    document.body.appendChild(clone);
    touchClone.current = clone;
  };
  const onTouchMove = useCallback(e => {
    var _card$dataset;
    if (!touchDragId.current) return;
    e.preventDefault();
    const t = e.touches[0];
    // Move clone
    if (touchClone.current) {
      touchClone.current.style.top = `${t.clientY - 40}px`;
      touchClone.current.style.left = `${t.clientX - 60}px`;
    }
    // Highlight drop target
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const card = el === null || el === void 0 ? void 0 : el.closest("[data-photoid]");
    const overId = (card === null || card === void 0 || (_card$dataset = card.dataset) === null || _card$dataset === void 0 ? void 0 : _card$dataset.photoid) || null;
    setDragOverId(overId && overId !== touchDragId.current ? overId : null);
    // Auto-scroll when finger near edge
    const vh = window.innerHeight;
    const nearTop = t.clientY < SCROLL_EDGE;
    const nearBot = t.clientY > vh - SCROLL_EDGE;
    setScrollTop(nearTop);
    setScrollBot(nearBot);
    if (nearTop || nearBot) {
      if (!scrollRaf.current) {
        const scroll = () => {
          window.scrollBy(0, nearBot ? SCROLL_SPD : -SCROLL_SPD);
          scrollRaf.current = requestAnimationFrame(scroll);
        };
        scrollRaf.current = requestAnimationFrame(scroll);
      }
    } else {
      if (scrollRaf.current) {
        cancelAnimationFrame(scrollRaf.current);
        scrollRaf.current = null;
      }
    }
  }, [selMode]);
  const onTouchEnd = useCallback(e => {
    var _card$dataset2;
    if (!touchDragId.current) return;
    stopScroll();
    if (touchClone.current) {
      document.body.removeChild(touchClone.current);
      touchClone.current = null;
    }
    const t = e.changedTouches[0];
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const card = el === null || el === void 0 ? void 0 : el.closest("[data-photoid]");
    const toId = card === null || card === void 0 || (_card$dataset2 = card.dataset) === null || _card$dataset2 === void 0 ? void 0 : _card$dataset2.photoid;
    if (toId && toId !== touchDragId.current) onReorder(touchDragId.current, toId);
    touchDragId.current = null;
    setDragFromId(null);
    setDragOverId(null);
  }, [onReorder, selMode]);

  // ── Split view: open photo in right panel ─────────────────────────────────
  const openSplit = useCallback(p => {
    setSplitId(p.id);
    const isPreset = LABELS.includes(p.label);
    setSplitDraft({
      label: isPreset ? p.label : "",
      customLabel: isPreset ? "" : p.label || "",
      notes: p.notes || "",
      dateTaken: p.dateTaken || "",
      takenBy: p.takenBy || "",
      imageData: p.imageData || null,
      gps: p.gps || null
    });
  }, []);
  const saveSplit = useCallback(() => {
    if (!splitDraft || !splitId) return;
    const label = splitDraft.customLabel.trim() || splitDraft.label;
    // FIX: was passing ||undefined which caused bulkUpdate to skip empty values,
    // meaning a cleared label/notes would never be written. Pass the value directly;
    // bulkUpdate already does Object.entries filter for undefined — use null to signal clear.
    const patch = {};
    if (label !== undefined) patch.label = label;
    if (splitDraft.notes !== undefined) patch.notes = splitDraft.notes;
    if (splitDraft.dateTaken !== undefined) patch.dateTaken = splitDraft.dateTaken;
    if (splitDraft.takenBy !== undefined) patch.takenBy = splitDraft.takenBy;
    if (Object.keys(patch).length) onBulkUpdate(new Set([splitId]), patch);
    toast("Saved");
    setSplitId(null);
    setSplitDraft(null);
  }, [splitDraft, splitId, onBulkUpdate]);
  const updSplit = patch => setSplitDraft(d => ({
    ...d,
    ...patch
  }));
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: `scroll-zone-top${scrollTop ? " active" : ""}`
  }), /*#__PURE__*/React.createElement("div", {
    className: `scroll-zone-bot${scrollBot ? " active" : ""}`
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 14,
      gap: 8,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap"
    }
  }, photos.length > 0 && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      fontWeight: 600
    }
  }, photos.length, " photo", photos.length !== 1 ? "s" : ""), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text2)"
    }
  }, "· ", pgCount, " page", pgCount !== 1 ? "s" : ""), labeled < photos.length && /*#__PURE__*/React.createElement("span", {
    className: "badge b-amber"
  }, photos.length - labeled, " unlabeled"), labeled === photos.length && photos.length > 0 && /*#__PURE__*/React.createElement("span", {
    className: "badge b-green"
  }, "All labeled ✓"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 6,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, photos.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "view-toggle"
  }, /*#__PURE__*/React.createElement("button", {
    className: `vt-btn${viewMode === "grid" ? " vt-on" : ""}`,
    onClick: () => {
      setViewMode("grid");
      setSplitId(null);
      setSplitDraft(null);
    }
  }, "⊞ Grid"), /*#__PURE__*/React.createElement("button", {
    className: `vt-btn${viewMode === "split" ? " vt-on" : ""}`,
    onClick: () => {
      setViewMode("split");
      setSplitId(null);
      setSplitDraft(null);
    }
  }, "⫿ Split")), photos.length > 0 && /*#__PURE__*/React.createElement("button", {
    className: `btn btn-sm${selMode ? " btn-primary" : ""}`,
    onClick: () => selMode ? exitSel() : setSelMode(true)
  }, selMode ? "Done" : "Select"), selMode && photos.length > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    style: isAllSelected ? {
      background: "var(--blue-50)",
      color: "var(--blue-700)",
      borderColor: "var(--blue-300)"
    } : {},
    onClick: isAllSelected ? deselectAll : selectAll
  }, isAllSelected ? `✓ All ${photos.length} selected` : `Select all ${photos.length}`), selMode && selected.size > 0 && !isAllSelected && /*#__PURE__*/React.createElement("span", {
    className: "badge b-blue"
  }, selected.size, " selected"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    onClick: onAdd
  }, "+ Add photos"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: onCamera
  }, "📷 Camera"))), viewMode === "grid" && /*#__PURE__*/React.createElement(React.Fragment, null, !photos.length ? /*#__PURE__*/React.createElement("div", {
    className: "dz",
    onClick: onAdd
  }, /*#__PURE__*/React.createElement("div", {
    className: "dz-icon"
  }, "🖼"), /*#__PURE__*/React.createElement("div", {
    className: "dz-title"
  }, "Add your first inspection photos"), /*#__PURE__*/React.createElement("div", {
    className: "dz-sub"
  }, "Upload multiple at once · camera supported on mobile")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "photo-grid"
  }, photos.map((p, i) => {
    const isSel = selected.has(p.id);
    const isDragOver = dragOverId === p.id;
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      "data-photoid": p.id,
      className: `photo-card${isSel ? " selected" : ""}${dragFromId === p.id ? " dragging" : ""}${isDragOver ? " drag-over" : ""}`,
      draggable: !selMode,
      onDragStart: e => onDragStart(e, p.id),
      onDragOver: e => onDragOver(e, p.id),
      onDrop: e => onDrop(e, p.id),
      onDragEnd: onDragEnd,
      onTouchStart: e => onTouchStart(e, p.id),
      onTouchMove: onTouchMove,
      onTouchEnd: onTouchEnd
    }, /*#__PURE__*/React.createElement("div", {
      className: "pt",
      onClick: () => selMode ? toggleSel(p.id) : onEdit(p, i)
    }, p.imageData ? /*#__PURE__*/React.createElement("img", {
      src: p.imageData,
      alt: ""
    }) : /*#__PURE__*/React.createElement("div", {
      className: "no-img-ph"
    }, "📷"), /*#__PURE__*/React.createElement("span", {
      className: "pt-num"
    }, "#", p.num), !p.label && !selMode && /*#__PURE__*/React.createElement("span", {
      className: "pt-warn"
    }, "⚠ Label"), p.annotation && /*#__PURE__*/React.createElement("span", {
      className: "pt-annotated"
    }, "✏"), p.gps && /*#__PURE__*/React.createElement("span", {
      className: "gps-badge"
    }, /*#__PURE__*/React.createElement("span", {
      className: "gps-badge-pin"
    }, "📍"), fmtGPS(p.gps)), selMode && /*#__PURE__*/React.createElement("span", {
      className: "pt-chk"
    }, isSel ? "✓" : "")), /*#__PURE__*/React.createElement("div", {
      className: "pm"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pm-label"
    }, p.label || /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--at)"
      }
    }, "Unlabeled")), p.notes && /*#__PURE__*/React.createElement("div", {
      className: "pm-note"
    }, p.notes), !selMode && /*#__PURE__*/React.createElement("div", {
      className: "pm-actions"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 3
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-xs btn-ghost",
      style: {
        border: "1px solid var(--bdr)",
        width: 28,
        padding: 0,
        height: 26
      },
      onClick: () => {
        var _photos;
        return onReorder(p.id, (_photos = photos[i - 1]) === null || _photos === void 0 ? void 0 : _photos.id);
      },
      disabled: i === 0
    }, "↑"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-xs btn-ghost",
      style: {
        border: "1px solid var(--bdr)",
        width: 28,
        padding: 0,
        height: 26
      },
      onClick: () => {
        var _photos2;
        return onReorder(p.id, (_photos2 = photos[i + 1]) === null || _photos2 === void 0 ? void 0 : _photos2.id);
      },
      disabled: i === photos.length - 1
    }, "↓")), /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        gap: 4
      }
    }, /*#__PURE__*/React.createElement("button", {
      className: "btn btn-xs",
      onClick: () => onEdit(p, i)
    }, "Edit"), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-xs btn-danger",
      onClick: () => onDelete(p.id)
    }, "✕")))));
  })), photos.length > 1 && !selMode && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6,
      marginBottom: 4,
      fontSize: 11,
      color: "var(--text3)"
    }
  }, /*#__PURE__*/React.createElement("span", null, "⠿"), /*#__PURE__*/React.createElement("span", null, "Drag any card to reorder · hold & drag on mobile · page auto-scrolls near edges")))), viewMode === "split" && /*#__PURE__*/React.createElement("div", {
    className: "split-layout"
  }, /*#__PURE__*/React.createElement("div", {
    className: "split-list"
  }, !photos.length ? /*#__PURE__*/React.createElement("div", {
    className: "dz",
    onClick: onAdd
  }, /*#__PURE__*/React.createElement("div", {
    className: "dz-icon"
  }, "🖼"), /*#__PURE__*/React.createElement("div", {
    className: "dz-title"
  }, "Add photos to get started")) : /*#__PURE__*/React.createElement("div", {
    className: "split-photo-grid"
  }, photos.map((p, i) => {
    const isSel = selected.has(p.id);
    const isActive = splitId === p.id;
    return /*#__PURE__*/React.createElement("div", {
      key: p.id,
      "data-photoid": p.id,
      className: `split-photo-card${isActive ? " spc-active" : ""}${isSel ? " selected" : ""}`,
      draggable: !selMode,
      onDragStart: e => onDragStart(e, p.id),
      onDragOver: e => onDragOver(e, p.id),
      onDrop: e => onDrop(e, p.id),
      onDragEnd: onDragEnd,
      onTouchStart: e => onTouchStart(e, p.id),
      onTouchMove: onTouchMove,
      onTouchEnd: onTouchEnd,
      onClick: () => selMode ? toggleSel(p.id) : openSplit(p)
    }, p.imageData ? /*#__PURE__*/React.createElement("img", {
      className: "split-thumb",
      src: p.imageData,
      alt: ""
    }) : /*#__PURE__*/React.createElement("div", {
      className: "split-thumb-ph"
    }, "📷"), /*#__PURE__*/React.createElement("div", {
      className: "split-card-info"
    }, /*#__PURE__*/React.createElement("div", {
      className: "split-card-num"
    }, "#", p.num), /*#__PURE__*/React.createElement("div", {
      className: "split-card-label"
    }, p.label || /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--at)"
      }
    }, "Unlabeled")), p.notes && /*#__PURE__*/React.createElement("div", {
      className: "split-card-note"
    }, p.notes), /*#__PURE__*/React.createElement("div", {
      className: "split-card-badges"
    }, p.takenBy && /*#__PURE__*/React.createElement("span", {
      className: "badge b-slate",
      style: {
        fontSize: 10
      }
    }, "👤 ", p.takenBy), p.gps && /*#__PURE__*/React.createElement("span", {
      className: "badge b-green",
      style: {
        fontSize: 10
      }
    }, "📍 GPS"), p.annotation && /*#__PURE__*/React.createElement("span", {
      className: "badge b-blue",
      style: {
        fontSize: 10
      }
    }, "✏ Annotated"))), selMode && /*#__PURE__*/React.createElement("span", {
      className: "pt-chk",
      style: {
        position: "static",
        margin: "auto 10px auto 0",
        flexShrink: 0
      }
    }, isSel ? "✓" : ""));
  }))), /*#__PURE__*/React.createElement("div", null, !splitDraft ? /*#__PURE__*/React.createElement("div", {
    className: "split-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "split-panel-empty"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 30,
      opacity: .25
    }
  }, "←"), /*#__PURE__*/React.createElement("span", null, "Tap any photo to edit fields here"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "var(--text3)"
    }
  }, "Drag photos on the left to reorder"))) : /*#__PURE__*/React.createElement("div", {
    className: "split-panel"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "#0a0a0a",
      borderRadius: "var(--r-lg)",
      overflow: "hidden",
      marginBottom: 12,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      minHeight: 160,
      maxHeight: 220
    }
  }, splitDraft.imageData ? /*#__PURE__*/React.createElement("img", {
    src: splitDraft.imageData,
    alt: "",
    style: {
      maxWidth: "100%",
      maxHeight: 220,
      objectFit: "contain",
      display: "block"
    }
  }) : /*#__PURE__*/React.createElement("div", {
    style: {
      color: "#555",
      fontSize: 13
    }
  }, "No image")), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Label"), /*#__PURE__*/React.createElement(MacroSelect, {
    type: "label",
    value: splitDraft.customLabel || splitDraft.label || "",
    onChange: v => {
      const all = [...DEFAULT_LABELS, ...((macros === null || macros === void 0 ? void 0 : macros.labels) || [])];
      all.includes(v) ? updSplit({
        label: v,
        customLabel: ""
      }) : updSplit({
        label: "",
        customLabel: v
      });
    },
    macros: (macros === null || macros === void 0 ? void 0 : macros.labels) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add label…"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Notes"), /*#__PURE__*/React.createElement(MacroSelect, {
    type: "note",
    value: splitDraft.notes || "",
    onChange: v => updSplit({
      notes: v
    }),
    macros: (macros === null || macros === void 0 ? void 0 : macros.notes) || [],
    onAddMacro: onAddMacro,
    onDeleteMacro: onDeleteMacro,
    placeholder: "Select or add notes…"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      marginBottom: 14,
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Date taken"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: splitDraft.dateTaken || "",
    className: "inp",
    style: {
      width: "auto",
      fontSize: 13,
      padding: "7px 10px"
    },
    onChange: e => updSplit({
      dateTaken: e.target.value
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 120
    }
  }, /*#__PURE__*/React.createElement("label", {
    className: "lbl"
  }, "Taken by"), /*#__PURE__*/React.createElement(TakenBySelect, {
    value: splitDraft.takenBy || "",
    onChange: v => updSplit({
      takenBy: v
    }),
    users: users,
    placeholder: "Adjuster…"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 8,
      alignItems: "center",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary btn-sm",
    onClick: saveSplit
  }, "Save changes"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-danger",
    onClick: () => onDelete(splitId)
  }, "Delete photo"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    style: {
      marginLeft: "auto"
    },
    onClick: () => onEdit(photos.find(p => p.id === splitId), photos.findIndex(p => p.id === splitId))
  }, "Full edit →"))))), selMode && selected.size > 0 && /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-hdr"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bulk-panel-cnt"
  }, selected.size === photos.length ? `All ${photos.length} photo${photos.length !== 1 ? "s" : ""} selected` : `${selected.size} of ${photos.length} selected`), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: isAllSelected ? {
      background: "rgba(37,99,235,.35)",
      color: "#93c5fd",
      border: "1px solid rgba(37,99,235,.5)"
    } : {
      color: "rgba(255,255,255,.75)",
      border: "1px solid rgba(255,255,255,.2)",
      background: "rgba(255,255,255,.08)"
    },
    onClick: isAllSelected ? deselectAll : selectAll
  }, isAllSelected ? "✓ Deselect all" : `Select all ${photos.length}`), photos.some(p => !p.label) && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: {
      color: "rgba(255,255,255,.7)",
      border: "1px solid rgba(255,255,255,.2)",
      background: "rgba(255,255,255,.08)"
    },
    onClick: () => setSelected(new Set(photos.filter(p => !p.label).map(p => p.id)))
  }, "Unlabeled"), selected.size > 0 && /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: {
      color: "rgba(255,255,255,.45)",
      border: "1px solid rgba(255,255,255,.1)",
      background: "transparent"
    },
    onClick: deselectAll
  }, "Clear")), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-grid"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Label"), /*#__PURE__*/React.createElement("select", {
    className: "bp-select",
    value: bkLabel,
    onChange: e => {
      setBkLabel(e.target.value);
      setBkCustomL("");
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "— select —"), LABELS.map(l => /*#__PURE__*/React.createElement("option", {
    key: l,
    value: l
  }, l)))), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Custom label"), /*#__PURE__*/React.createElement("input", {
    className: "bp-input",
    placeholder: "Type custom label…",
    value: bkCustomL,
    onChange: e => {
      setBkCustomL(e.target.value);
      setBkLabel("");
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Notes"), /*#__PURE__*/React.createElement("select", {
    className: "bp-select",
    value: bkNotes,
    onChange: e => {
      setBkNotes(e.target.value);
      setBkCustomN("");
    }
  }, /*#__PURE__*/React.createElement("option", {
    value: ""
  }, "— select —"), NOTES.map(n => /*#__PURE__*/React.createElement("option", {
    key: n,
    value: n
  }, n)))), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Custom notes"), /*#__PURE__*/React.createElement("input", {
    className: "bp-input",
    placeholder: "Type custom notes…",
    value: bkCustomN,
    onChange: e => {
      setBkCustomN(e.target.value);
      setBkNotes("");
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Date taken"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    className: "bp-input",
    value: bkDate,
    onChange: e => setBkDate(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-field"
  }, /*#__PURE__*/React.createElement("span", {
    className: "bplbl"
  }, "Taken by"), /*#__PURE__*/React.createElement(TakenBySelect, {
    value: bkTakenBy,
    onChange: setBkTakenBy,
    users: users,
    placeholder: "All selected…"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "bulk-panel-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "bulk-apply",
    disabled: !bulkHasValue,
    onClick: applyBulk
  }, "Apply to ", selected.size, " photo", selected.size !== 1 ? "s" : ""), /*#__PURE__*/React.createElement("button", {
    className: "bulk-del",
    onClick: () => {
      onBulkDelete(selected);
      exitSel();
    }
  }, "🗑 Delete ", selected.size), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: {
      marginLeft: "auto",
      color: "rgba(255,255,255,.6)",
      border: "1px solid rgba(255,255,255,.15)",
      background: "transparent",
      fontFamily: "inherit",
      cursor: "pointer"
    },
    onClick: exitSel
  }, "Done"))), photos.length > 0 && !selMode && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: onNext
  }, "Continue to checklist →")));
}

// ── Preview View ─────────────────────────────────────────────────────────────
function PreviewView({
  pages,
  co,
  claim,
  dateStr,
  layout,
  setLayout
}) {
  if (!pages.length) return /*#__PURE__*/React.createElement("div", {
    className: "empty-state"
  }, /*#__PURE__*/React.createElement("div", {
    className: "empty-icon"
  }, "📋"), /*#__PURE__*/React.createElement("div", {
    className: "empty-ttl"
  }, "No photos added yet"), /*#__PURE__*/React.createElement("div", {
    className: "empty-sub"
  }, "Go to the Photos tab to add inspection photos."));
  return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    className: "card",
    style: {
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-title"
  }, "Layout — photos per page"), /*#__PURE__*/React.createElement("div", {
    className: "lo-grid"
  }, LAYOUT_OPTS.map(o => /*#__PURE__*/React.createElement("button", {
    key: o.v,
    className: `lo-btn${layout === o.v ? " lo-on" : ""}`,
    onClick: () => setLayout(o.v)
  }, /*#__PURE__*/React.createElement("span", {
    className: "lo-icon"
  }, o.icon), /*#__PURE__*/React.createElement("div", {
    className: "lo-label"
  }, o.label), /*#__PURE__*/React.createElement("div", {
    className: "lo-sub"
  }, o.sub))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text2)"
    }
  }, pages.length, " page", pages.length > 1 ? "s" : "", " · ", pages.flat().length, " photos"), !co && /*#__PURE__*/React.createElement("span", {
    className: "badge b-amber"
  }, "No company header set")), /*#__PURE__*/React.createElement("div", {
    className: "preview-wrap"
  }, pages.map((group, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "preview-pg"
  }, /*#__PURE__*/React.createElement(ReportPage, {
    photos: group,
    co: co,
    claim: claim,
    dateStr: dateStr,
    pageNum: i + 1,
    layout: layout
  })))));
}

// ── Root App ─────────────────────────────────────────────────────────────────
function App() {
  const [ready, setReady] = useState(false);
  const [screen, setScreen] = useState("dashboard");
  const [editorTab, setEditorTab] = useState("claim");
  const [view, setView] = useState("grid");
  const [projList, setProjList] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [projName, setProjName] = useState("Untitled report");
  const [projCrAt, setProjCrAt] = useState(null);
  const [claim, setClaim] = useState({
    insured: "",
    claimNum: "",
    policyNum: ""
  });
  const [photos, setPhotos] = useState([]);
  const [layout, setLayout] = useState(2);
  const [editDraft, setEditDraft] = useState(null);
  const [editId, setEditId] = useState(null);
  const [editIdx, setEditIdx] = useState(0);
  const [batchQ, setBatchQ] = useState([]);
  const [camOpen, setCamOpen] = useState(false);
  // Photos taken with the in-app camera go through the same pipeline as uploads
  const addShots = useCallback(async shots => {
    setCamOpen(false);
    if (!shots.length) return;
    const parts = await Promise.all(shots.map(s => loadFilesWithGPS([s.file], s.gps)));
    const loaded = parts.flat();
    if (loaded.length) setBatchQ(q => [...q, ...loaded]);
  }, []);
  const [batchDate, setBatchDate] = useState(getToday);
  const [batchTakenBy, setBatchTakenBy] = useState("");
  const [companies, setCompanies] = useState([]);
  const [activeCo, setActiveCo] = useState(null);
  const [users, setUsers] = useState([]);
  const [activeUser, setActiveUser] = useState(null);
  const [macros, setMacros] = useState({
    labels: [],
    notes: []
  });
  const [sessionDate, setSessionDate] = useState(getToday);
  const [saveState, setSaveState] = useState("idle");
  const [checklist, setChecklist] = useState({});

  // ── Init ────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const cos = lsGet(LS.cos, []),
          acoid = lsGet(LS.acoid, null),
          lay = lsGet(LS.lay, 2);
        const plist = lsGet(LS.plist, []),
          apid = lsGet(LS.apid, null);
        const savedUsers = lsGet(LS.users, []),
          auid = lsGet(LS.auid, null);
        const savedMacros = lsGet(LS.macros, {
          labels: [],
          notes: []
        });
        setCompanies(cos);
        setLayout(lay);
        setUsers(savedUsers);
        setMacros(savedMacros);
        // Sync mutable LABELS/NOTES with saved custom macros
        LABELS = [...DEFAULT_LABELS, ...(savedMacros.labels || [])];
        NOTES = [...DEFAULT_NOTES, ...(savedMacros.notes || [])];
        if (acoid) setActiveCo(cos.find(c => c.id === acoid) || null);
        if (auid) setActiveUser(savedUsers.find(u => u.id === auid) || null);
        let proj = apid ? await IDB.load(apid) : null;
        if (!proj && plist.length) proj = await IDB.load(plist[plist.length - 1].id);
        if (!proj) {
          proj = makeProj();
          await IDB.save(proj);
          const meta = [projMeta(proj)];
          setProjList(meta);
          lsSet(LS.plist, meta);
        } else {
          setProjList(plist.length ? plist : [projMeta(proj)]);
        }
        setActiveId(proj.id);
        setProjName(proj.name);
        setProjCrAt(proj.createdAt);
        setClaim(proj.claim || {
          insured: "",
          claimant: "",
          partyLabel: "insured",
          claimNum: "",
          policyNum: ""
        });
        setPhotos(proj.photos || []);
        setLayout(proj.layout || lay);
        setChecklist(proj.checklist || {});
        lsSet(LS.apid, proj.id);
      } catch (err) {
        console.error("Init error", err);
        const p = makeProj();
        setActiveId(p.id);
        setProjName(p.name);
        setProjCrAt(p.createdAt);
        setProjList([projMeta(p)]);
      }
      setReady(true);
    })();
  }, []);

  // ── Auto-save (debounced 300ms) ──────────────────────────────────────────
  const saveTimer = useRef(null);
  // Latest snapshot for callbacks: is the active report still blank (nothing entered)?
  const curRef = useRef({ activeId: null, blank: false });
  curRef.current = {
    activeId,
    blank: photos.length === 0 && !claim.insured && !claim.claimant && !claim.claimNum && !claim.policyNum && projName === "Untitled report"
  };
  // Latest unsaved snapshot, so it can be flushed immediately if the page is hidden/closed
  const pendingRef = useRef(null);
  // Save any edit still waiting in the debounce right now (used before backups/exports)
  const flushNow = useCallback(async () => {
    const proj = pendingRef.current;
    if (!proj) return;
    pendingRef.current = null;
    clearTimeout(saveTimer.current);
    try {
      await IDB.save(proj);
      const meta = projMeta(proj);
      setProjList(ps => {
        const u = ps.some(p => p.id === proj.id) ? ps.map(p => p.id === proj.id ? meta : p) : [...ps, meta];
        lsSet(LS.plist, u);
        return u;
      });
    } catch (e) {
      console.warn("Flush error", e);
    }
  }, []);
  useEffect(() => {
    flushPending = flushNow;
  }, [flushNow]);
  useEffect(() => {
    if (!ready || !activeId) return;
    clearTimeout(saveTimer.current);
    setSaveState("saving");
    const proj = {
      id: activeId,
      name: projName,
      createdAt: projCrAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      claim,
      photos,
      layout,
      checklist
    };
    pendingRef.current = proj;
    saveTimer.current = setTimeout(async () => {
      try {
        await IDB.save(proj);
        if (pendingRef.current === proj) pendingRef.current = null;
        lsSet(LS.lay, layout);
        const meta = projMeta(proj);
        setProjList(ps => {
          const u = ps.some(p => p.id === activeId) ? ps.map(p => p.id === activeId ? meta : p) : [...ps, meta];
          lsSet(LS.plist, u);
          return u;
        });
        setSaveState("saved");
        setTimeout(() => setSaveState("idle"), 2000);
      } catch (e) {
        console.warn("Save error", e);
        setSaveState("idle");
      }
    }, 300);
    return () => clearTimeout(saveTimer.current);
  }, [ready, activeId, projName, projCrAt, claim, photos, layout, checklist]);

  // Flush any unsaved edits right away when the tab is hidden, backgrounded or closed
  useEffect(() => {
    const flush = () => {
      const proj = pendingRef.current;
      if (!proj) return;
      pendingRef.current = null;
      clearTimeout(saveTimer.current);
      try {
        IDB.save(proj);
        const meta = projMeta(proj);
        const list = lsGet(LS.plist, []);
        lsSet(LS.plist, list.some(p => p.id === proj.id) ? list.map(p => p.id === proj.id ? meta : p) : [...list, meta]);
      } catch (e) {
        console.warn("Flush error", e);
      }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  // ── Project actions ──────────────────────────────────────────────────────
  const newProject = useCallback(async () => {
    if (curRef.current.blank) {
      // Already on an empty report: reuse it instead of piling up blank ones
      setEditorTab("claim");
      setView("grid");
      setScreen("editor");
      return;
    }
    const p = makeProj();
    try {
      await IDB.save(p);
    } catch {}
    const meta = projMeta(p);
    setProjList(ps => {
      const u = [...ps, meta];
      lsSet(LS.plist, u);
      return u;
    });
    setActiveId(p.id);
    setProjName(p.name);
    setProjCrAt(p.createdAt);
    setClaim({
      insured: "",
      claimant: "",
      partyLabel: "insured",
      claimNum: "",
      policyNum: ""
    });
    setPhotos([]);
    setLayout(2);
    setChecklist({});
    setEditorTab("claim");
    setView("grid");
    setScreen("editor");
    lsSet(LS.apid, p.id);
    toast("New report created");
  }, []);
  const loadProject = useCallback(async id => {
    try {
      const p = await IDB.load(id);
      if (!p) {
        toast("Report not found");
        return;
      }
      if (curRef.current.blank && curRef.current.activeId && curRef.current.activeId !== p.id) {
        // Leaving an empty report behind: remove it so the list stays clean
        const blankId = curRef.current.activeId;
        try {
          await IDB.del(blankId);
        } catch {}
        setProjList(ps => {
          const u = ps.filter(x => x.id !== blankId);
          lsSet(LS.plist, u);
          return u;
        });
      }
      setActiveId(p.id);
      setProjName(p.name);
      setProjCrAt(p.createdAt);
      setClaim(p.claim || {
        insured: "",
        claimant: "",
        partyLabel: "insured",
        claimNum: "",
        policyNum: ""
      });
      setPhotos(p.photos || []);
      setLayout(p.layout || 2);
      setChecklist(p.checklist || {});
      setEditorTab("photos");
      setView("grid");
      setScreen("editor");
      lsSet(LS.apid, p.id);
      toast(`Opened: ${p.name}`);
    } catch {
      toast("Failed to load report");
    }
  }, []);
  const deleteProject = useCallback(async id => {
    if (id === activeId) return;
    if (!window.confirm("Delete this report permanently?")) return;
    try {
      await IDB.del(id);
    } catch {}
    setProjList(ps => {
      const u = ps.filter(p => p.id !== id);
      lsSet(LS.plist, u);
      return u;
    });
    toast("Report deleted");
  }, [activeId]);

  // ── Photo actions ────────────────────────────────────────────────────────
  const saveBatch = useCallback(() => {
    const base = photos.length;
    setPhotos(ps => [...ps, ...batchQ.map((it, i) => ({
      id: uid(),
      num: base + i + 1,
      label: it.customLabel.trim() || it.label,
      notes: it.notes,
      dateTaken: batchDate,
      takenBy: batchTakenBy,
      gps: it.gps || null,
      annotation: it.annotation || null,
      imageData: it.imageData
    }))]);
    const cnt = batchQ.length;
    setBatchQ([]);
    setBatchTakenBy("");
    setView("grid");
    setEditorTab("photos");
    toast(`${cnt} photo${cnt > 1 ? "s" : ""} added`);
  }, [batchQ, batchDate, batchTakenBy, photos.length]);

  // FIX Bug 1: was useCallback([]) — stale closure always used the initial sessionDate
  // and activeUser values. Added sessionDate and activeUser to deps.
  const openEdit = useCallback((p, idx = 0) => {
    setEditId(p.id);
    setEditIdx(typeof idx === "number" ? idx : 0);
    const isPreset = LABELS.includes(p.label);
    setEditDraft({
      label: isPreset ? p.label : "",
      customLabel: isPreset ? "" : p.label || "",
      notes: p.notes || "",
      dateTaken: p.dateTaken || sessionDate,
      takenBy: p.takenBy || (activeUser === null || activeUser === void 0 ? void 0 : activeUser.name) || "",
      imageData: p.imageData || null,
      gps: p.gps || null,
      annotation: p.annotation || null
    });
    setView("edit");
  }, [sessionDate, activeUser]);

  // FIX Bug 2+3: was useCallback([]) — stale closure + setState-inside-setState
  // anti-pattern (setEditDraft called inside setPhotos updater).
  // Separated into two distinct state updates; deps now include sessionDate + activeUser.
  const saveAndNavigate = useCallback((newIdx, currentDraft, currentId) => {
    const label = currentDraft.customLabel.trim() || currentDraft.label;
    // Step 1: persist current photo
    setPhotos(ps => ps.map(p => p.id === currentId ? {
      ...p,
      label,
      notes: currentDraft.notes,
      dateTaken: currentDraft.dateTaken,
      takenBy: currentDraft.takenBy,
      gps: currentDraft.gps,
      annotation: currentDraft.annotation,
      imageData: currentDraft.imageData
    } : p));
    // Step 2: open the target photo — runs in the next render after setPhotos
    setPhotos(ps => {
      const target = ps[newIdx];
      if (target) {
        const isPreset = LABELS.includes(target.label);
        // Use setTimeout(0) to escape the functional updater — calling setEditDraft
        // inside setPhotos updater is a React anti-pattern that causes batching issues
        setTimeout(() => {
          setEditId(target.id);
          setEditIdx(newIdx);
          setEditDraft({
            label: isPreset ? target.label : "",
            customLabel: isPreset ? "" : target.label || "",
            notes: target.notes || "",
            dateTaken: target.dateTaken || sessionDate,
            takenBy: target.takenBy || (activeUser === null || activeUser === void 0 ? void 0 : activeUser.name) || "",
            imageData: target.imageData || null,
            gps: target.gps || null,
            annotation: target.annotation || null
          });
        }, 0);
      }
      return ps; // no mutation, just reading
    });
  }, [sessionDate, activeUser]);

  // FIX Bug 8: reorderPhotos useCallback — deps list was empty. setPhotos is
  // stable from useState so [] would not cause real staleness here, but explicit
  // empty dep arrays on non-trivial callbacks are fragile. Kept [] intentionally
  // since this fn only uses the functional updater form of setPhotos (no outer deps).
  const addMacro = useCallback((type, text) => {
    setMacros(m => {
      const key = type === "label" ? "labels" : "notes";
      const arr = m[key] || [];
      if (arr.includes(text)) return m;
      const next = {
        ...m,
        [key]: [...arr, text]
      };
      lsSet(LS.macros, next);
      // Keep mutable runtime arrays in sync
      if (type === "label") LABELS = [...DEFAULT_LABELS, ...next.labels];else NOTES = [...DEFAULT_NOTES, ...next.notes];
      return next;
    });
  }, []);
  const deleteMacro = useCallback((type, text) => {
    setMacros(m => {
      const key = type === "label" ? "labels" : "notes";
      const next = {
        ...m,
        [key]: (m[key] || []).filter(v => v !== text)
      };
      lsSet(LS.macros, next);
      if (type === "label") LABELS = [...DEFAULT_LABELS, ...next.labels];else NOTES = [...DEFAULT_NOTES, ...next.notes];
      return next;
    });
  }, []);
  const reorderPhotos = useCallback((fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return; // guard undefined toId from up/down btns
    setPhotos(ps => {
      const a = [...ps];
      const fi = a.findIndex(p => p.id === fromId);
      const ti = a.findIndex(p => p.id === toId);
      if (fi < 0 || ti < 0 || fi === ti) return ps;
      const [moved] = a.splice(fi, 1);
      a.splice(ti, 0, moved);
      return a.map((p, k) => ({
        ...p,
        num: k + 1
      }));
    });
  }, []);
  const saveEdit = useCallback(() => {
    const label = editDraft.customLabel.trim() || editDraft.label;
    setPhotos(ps => ps.map(p => p.id === editId ? {
      ...p,
      label,
      notes: editDraft.notes,
      dateTaken: editDraft.dateTaken,
      takenBy: editDraft.takenBy,
      gps: editDraft.gps,
      annotation: editDraft.annotation,
      imageData: editDraft.imageData
    } : p));
    setView("grid");
    toast("Photo updated");
  }, [editDraft, editId]);
  const [clearSplitToken, setClearSplitToken] = useState(null);
  // FIX Bug 2: setClearSplitToken(id) signals PhotoGrid to clear its split panel.
  // Reset to null after a tick so the useEffect in PhotoGrid only fires once per delete.
  const delPhoto = useCallback(id => {
    setPhotos(ps => ps.filter(p => p.id !== id).map((p, i) => ({
      ...p,
      num: i + 1
    })));
    setClearSplitToken(id);
    setTimeout(() => setClearSplitToken(null), 0);
  }, []);
  const bulkUpdate = useCallback((ids, patch) => {
    // FIX: filter only strict undefined — empty string "" is a valid value that
    // clears a field (e.g. removing a label). Was previously filtering falsy values.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(clean).length) return;
    setPhotos(ps => ps.map(p => ids.has(p.id) ? {
      ...p,
      ...clean
    } : p));
    toast(`Updated ${ids.size} photo${ids.size > 1 ? "s" : ""}`);
  }, []);
  const bulkDelete = useCallback(ids => {
    if (!window.confirm(`Delete ${ids.size} photo${ids.size > 1 ? "s" : ""}`)) return;
    setPhotos(ps => ps.filter(p => !ids.has(p.id)).map((p, i) => ({
      ...p,
      num: i + 1
    })));
    toast(`Deleted ${ids.size} photo${ids.size > 1 ? "s" : ""}`);
  }, []);

  // ── Derived ──────────────────────────────────────────────────────────────
  const ppg = PPG_MAP[layout] || 2;
  const pages = useMemo(() => buildPages(photos, ppg), [photos, ppg]);
  const dateStr = useMemo(() => fmtDate(getToday()), []);
  if (!ready) {
    return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(AppHeader, {
      projList: [],
      activeId: null,
      projName: "",
      setProjName: () => {},
      onNew: () => {},
      onLoad: () => {},
      onDelete: () => {},
      companies: [],
      setCompanies: () => {},
      activeCo: null,
      setActiveCo: () => {},
      showPrint: false,
      onPrint: () => {}
    }), /*#__PURE__*/React.createElement("div", {
      className: "loader-screen"
    }, /*#__PURE__*/React.createElement("span", {
      className: "spinner",
      style: {
        width: 24,
        height: 24,
        borderWidth: 3
      }
    }), /*#__PURE__*/React.createElement("span", null, "Loading your reports…")));
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "print-only"
  }, pages.map((grp, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "rp-break"
  }, /*#__PURE__*/React.createElement(ReportPage, {
    photos: grp,
    co: activeCo || EMPTY_CO,
    claim: claim,
    dateStr: dateStr,
    pageNum: i + 1,
    layout: layout
  })))), /*#__PURE__*/React.createElement("div", {
    className: "no-print",
    id: "root"
  }, /*#__PURE__*/React.createElement(AppHeader, {
    projList: projList,
    activeId: activeId,
    projName: projName,
    setProjName: setProjName,
    onNew: newProject,
    onLoad: loadProject,
    onDelete: deleteProject,
    companies: companies,
    setCompanies: setCompanies,
    activeCo: activeCo,
    setActiveCo: setActiveCo,
    users: users,
    setUsers: setUsers,
    activeUser: activeUser,
    setActiveUser: setActiveUser,
    showPrint: screen === "editor" && editorTab === "preview" && photos.length > 0 && view === "grid",
    onPrint: () => window.print()
  }), screen === "editor" && /*#__PURE__*/React.createElement("div", {
    className: "session-bar no-print"
  }, /*#__PURE__*/React.createElement("div", {
    className: "session-bar-inner"
  }, /*#__PURE__*/React.createElement("span", {
    className: "session-lbl"
  }, "Date"), /*#__PURE__*/React.createElement("input", {
    type: "date",
    className: "session-date-input",
    value: sessionDate,
    onChange: e => setSessionDate(e.target.value),
    title: "Set default date for new photos"
  }), /*#__PURE__*/React.createElement("div", {
    className: "session-sep"
  }), /*#__PURE__*/React.createElement("span", {
    className: "session-lbl"
  }, "Taken by"), activeUser ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 20,
      height: 20,
      borderRadius: "50%",
      background: userColor(activeUser.name),
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 9,
      fontWeight: 700,
      color: "#fff",
      flexShrink: 0
    }
  }, userInitials(activeUser.name)), /*#__PURE__*/React.createElement("span", {
    className: "session-val"
  }, activeUser.name), activeUser.role && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      color: "rgba(255,255,255,.4)"
    }
  }, activeUser.role)) : /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: "rgba(255,255,255,.35)"
    }
  }, "No user selected — set in Users ▾"), activeCo && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "session-sep"
  }), /*#__PURE__*/React.createElement("span", {
    className: "session-lbl"
  }, "Company"), /*#__PURE__*/React.createElement("span", {
    className: "session-val"
  }, activeCo.name)))), screen === "editor" && view === "grid" && /*#__PURE__*/React.createElement(SubHeader, {
    projName: projName,
    setProjName: setProjName,
    editorTab: editorTab,
    setEditorTab: setEditorTab,
    claim: claim,
    photos: photos,
    checklist: checklist,
    saveState: saveState,
    onBack: () => setScreen("dashboard")
  }), screen === "editor" && view === "grid" && activeCo && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 780,
      margin: "12px auto 0",
      padding: "0 16px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "co-banner no-print"
  }, /*#__PURE__*/React.createElement("span", {
    className: "co-banner-text"
  }, "🏢 Header: ", /*#__PURE__*/React.createElement("strong", null, activeCo.name)), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-xs",
    style: {
      color: "var(--blue-700)",
      borderColor: "var(--blue-300)"
    },
    onClick: () => {
      var _document$querySelect;
      return (_document$querySelect = document.querySelector(".hdr-btn:nth-of-type(2)")) === null || _document$querySelect === void 0 ? void 0 : _document$querySelect.click();
    }
  }, "Change"))), screen === "dashboard" && /*#__PURE__*/React.createElement(Dashboard, {
    projList: projList,
    activeId: activeId,
    onOpen: loadProject,
    onDelete: deleteProject,
    onNew: newProject,
    onExport: async id => {
      try {
        await exportOneReport(id);
        toast("Report saved as a file");
      } catch (e) {
        toast("Export failed");
      }
    }
  }), screen === "editor" && /*#__PURE__*/React.createElement("div", {
    className: "page",
    style: {
      paddingTop: 16
    }
  }, view === "grid" && editorTab === "claim" && /*#__PURE__*/React.createElement(ClaimForm, {
    claim: claim,
    set: (k, v) => setClaim(c => ({
      ...c,
      [k]: v
    })),
    onNext: () => setEditorTab("photos")
  }), view === "grid" && editorTab === "photos" && /*#__PURE__*/React.createElement(PhotoGrid, {
    photos: photos,
    layout: layout,
    onAdd: () => {
      setBatchQ([]);
      setBatchDate(sessionDate);
      setBatchTakenBy((activeUser === null || activeUser === void 0 ? void 0 : activeUser.name) || "");
      setView("review");
    },
    onCamera: () => {
      setBatchQ([]);
      setBatchDate(sessionDate);
      setBatchTakenBy((activeUser === null || activeUser === void 0 ? void 0 : activeUser.name) || "");
      setView("review");
      setCamOpen(true);
    },
    onEdit: openEdit,
    onDelete: delPhoto,
    onReorder: reorderPhotos,
    onNext: () => setEditorTab("checklist"),
    onBulkUpdate: bulkUpdate,
    onBulkDelete: bulkDelete,
    users: users,
    clearSplitToken: clearSplitToken,
    macros: macros,
    onAddMacro: addMacro,
    onDeleteMacro: deleteMacro
  }), view === "grid" && editorTab === "checklist" && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 16,
      flexWrap: "wrap",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 700
    }
  }, "Inspection Checklist"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: "var(--text2)",
      marginTop: 2
    }
  }, "Document vehicle condition item by item before generating the report")), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => setEditorTab("preview")
  }, "Preview report →")), /*#__PURE__*/React.createElement(InspectionChecklist, {
    checklist: checklist,
    setChecklist: setChecklist
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16,
      display: "flex",
      justifyContent: "flex-end"
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-primary",
    onClick: () => setEditorTab("preview")
  }, "Preview report →"))), view === "grid" && editorTab === "preview" && /*#__PURE__*/React.createElement(PreviewView, {
    pages: pages,
    co: activeCo,
    claim: claim,
    dateStr: dateStr,
    layout: layout,
    setLayout: setLayout
  }), view === "review" && /*#__PURE__*/React.createElement(PhotoReviewer, {
    items: batchQ,
    setItems: setBatchQ,
    batchDate: batchDate,
    setBatchDate: setBatchDate,
    batchTakenBy: batchTakenBy,
    setBatchTakenBy: setBatchTakenBy,
    users: users,
    macros: macros,
    onAddMacro: addMacro,
    onDeleteMacro: deleteMacro,
    onConfirm: saveBatch,
    onBack: () => setView("grid"),
    onCamera: () => setCamOpen(true)
  }), camOpen && /*#__PURE__*/React.createElement(CameraCapture, {
    onDone: addShots,
    onClose: () => setCamOpen(false),
    getGps: getGPS
  }), view === "edit" && /*#__PURE__*/React.createElement(EditPhotoView, {
    draft: editDraft,
    setDraft: setEditDraft,
    onSave: saveEdit,
    onCancel: () => setView("grid"),
    photoIdx: editIdx,
    photosCount: photos.length,
    onNavigate: newIdx => saveAndNavigate(newIdx, editDraft, editId),
    users: users,
    macros: macros,
    onAddMacro: addMacro,
    onDeleteMacro: deleteMacro
  }))));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));
