// In-app camera: live viewfinder, multi-shot, front/back flip.
// Photos are handed back as { file, gps } shots and go through the same
// compress/label pipeline as uploaded files.
import React, { useState, useRef, useEffect, useCallback } from "react";

const MAX_PX = 2000; // longest side of a captured frame (the app compresses again for storage)

function explain(err) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return "Live camera isn't available here. It needs a secure (https) page or an installed app. You can still use your phone's camera app below.";
  }
  switch (err && err.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera permission was denied. Allow camera access for this site in your browser settings, or use your phone's camera app below.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No camera was found on this device. You can pick photos from your library instead.";
    case "NotReadableError":
      return "The camera is busy in another app. Close that app and try again.";
    default:
      return "Couldn't start the camera. You can use your phone's camera app below instead.";
  }
}

export function CameraCapture({ onDone, onClose, getGps }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const fallbackRef = useRef(null);
  const [facing, setFacing] = useState("environment");
  const [status, setStatus] = useState("starting"); // starting | live | error
  const [errMsg, setErrMsg] = useState("");
  const [shots, setShots] = useState([]); // { id, file, url, gps }
  const [flash, setFlash] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  // (Re)start the stream whenever the facing mode changes
  useEffect(() => {
    let cancelled = false;
    setStatus("starting");
    stopStream();
    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unsupported");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const v = videoRef.current;
        if (v) { v.srcObject = stream; await v.play().catch(() => {}); }
        setStatus("live");
      } catch (err) {
        if (cancelled) return;
        setErrMsg(explain(err));
        setStatus("error");
      }
    })();
    return () => { cancelled = true; stopStream(); };
  }, [facing]);

  // Warm the GPS cache once so each shot can be stamped instantly
  useEffect(() => { if (getGps) getGps(); }, []);

  // Free thumbnail URLs on unmount
  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);

  const finish = useCallback(() => {
    const list = shotsRef.current;
    stopStream();
    onDone(list.map((s) => ({ file: s.file, gps: s.gps })));
  }, [onDone]);

  const requestClose = useCallback(() => {
    if (shotsRef.current.length) setConfirmClose(true);
    else { stopStream(); onClose(); }
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const snap = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    let w = v.videoWidth, h = v.videoHeight;
    const scale = Math.min(1, MAX_PX / Math.max(w, h));
    w = Math.round(w * scale); h = Math.round(h * scale);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    setFlash(true); setTimeout(() => setFlash(false), 120);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
    c.toBlob((blob) => {
      if (!blob) return;
      const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
      const file = new File([blob], `camera-${id}.jpg`, { type: "image/jpeg" });
      const shot = { id, file, url: URL.createObjectURL(blob), gps: null };
      setShots((s) => [...s, shot]);
      if (getGps) {
        getGps().then((r) => {
          if (r && !r.error) setShots((s) => s.map((x) => (x.id === id ? { ...x, gps: r } : x)));
        });
      }
    }, "image/jpeg", 0.9);
  }, [getGps]);

  const removeShot = (id) => setShots((s) => {
    const gone = s.find((x) => x.id === id);
    if (gone) URL.revokeObjectURL(gone.url);
    return s.filter((x) => x.id !== id);
  });

  const n = shots.length;
  return (
    <div className="cam" role="dialog" aria-label="Camera">
      <div className="cam-stage">
        <video ref={videoRef} className="cam-video" playsInline muted autoPlay />
        {flash && <div className="cam-flash" />}
        {status === "starting" && <div className="cam-msg">Starting camera…</div>}
        {status === "error" && (
          <div className="cam-msg cam-err">
            <div style={{ fontSize: 36, marginBottom: 10 }}>📵</div>
            <div data-testid="cam-error">{errMsg}</div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => fallbackRef.current && fallbackRef.current.click()}>
              Use phone camera app / library
            </button>
            <input
              ref={fallbackRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                e.target.value = "";
                if (files.length) onDone(files.map((file) => ({ file, gps: null })));
              }}
            />
          </div>
        )}
      </div>

      <div className="cam-top">
        <button className="cam-btn" onClick={requestClose} aria-label="Close camera">✕</button>
        {n > 0 && <span className="cam-count" data-testid="cam-count">{n} taken</span>}
        <button className="cam-btn" onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))} aria-label="Flip camera" disabled={status === "error"}>⟲</button>
      </div>

      <div className="cam-bottom">
        <div className="cam-strip">
          {shots.slice(-5).map((s) => (
            <button key={s.id} className="cam-thumb" onClick={() => removeShot(s.id)} title="Tap to remove">
              <img src={s.url} alt="" />
            </button>
          ))}
        </div>
        <button className="cam-shutter" onClick={snap} disabled={status !== "live"} aria-label="Take photo"><span /></button>
        <button className="btn btn-primary cam-done" onClick={finish} disabled={!n}>Done{n ? ` (${n})` : ""}</button>
      </div>

      {confirmClose && (
        <div className="cam-confirm">
          <div className="cam-confirm-box">
            <div style={{ fontWeight: 700, marginBottom: 12 }}>Keep your {n} photo{n > 1 ? "s" : ""}?</div>
            <button className="btn btn-primary" style={{ width: "100%", marginBottom: 8 }} onClick={finish}>Keep &amp; label</button>
            <button className="btn" style={{ width: "100%", marginBottom: 8 }} onClick={() => setConfirmClose(false)}>Keep shooting</button>
            <button className="btn btn-danger" style={{ width: "100%" }} onClick={() => { stopStream(); onClose(); }}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
