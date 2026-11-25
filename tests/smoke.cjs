// Smoke tests: run with `npm test` (builds first). Uses a real headless Chromium.
const { chromium } = require("playwright");
const path = require("path");
const http = require("http");
const fs = require("fs");
const APP = "file://" + path.resolve(__dirname, "../dist/ClaimPhoto.html");
const results = [];
let browser;


// Tiny static server for the installable bundle (service workers need http, not file://)
function serveSite() {
  const root = path.resolve(__dirname, "../dist/site");
  const types = { ".html": "text/html", ".js": "text/javascript", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  const srv = http.createServer((req, res) => {
    let f = path.join(root, decodeURIComponent(req.url.split("?")[0])); if (f.endsWith(path.sep) || req.url === "/") f = path.join(root, "index.html");
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end("nf"); }
    res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: "http://127.0.0.1:" + srv.address().port + "/" })));
}

async function makeImages(page, n) {
  const urls = await page.evaluate((n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("canvas"); c.width = 1200; c.height = 900;
      const g = c.getContext("2d"); g.fillStyle = `hsl(${i * 70},60%,45%)`; g.fillRect(0, 0, 1200, 900);
      g.fillStyle = "#fff"; g.font = "80px sans-serif"; g.fillText("Photo " + (i + 1), 100, 200);
      out.push(c.toDataURL("image/jpeg", 0.8));
    }
    return out;
  }, n);
  return urls.map((u, i) => ({ name: `p${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(u.split(",")[1], "base64") }));
}

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 1280, height: 800 }, permissions: ["geolocation", "camera"], geolocation: { latitude: 40.7, longitude: -74 } });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000);
  if (opts.initScript) await page.addInitScript(opts.initScript);
  page.errs = [];
  page.on("pageerror", (e) => page.errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL|ERR_INTERNET|ERR_NAME|fonts\.g/.test(m.text())) page.errs.push("console: " + m.text()); });
  await page.goto(APP); await page.waitForSelector("text=Continue →, text=+ New Report", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(500);
  return page;
}

async function labelAll(page, n) {
  for (let k = 0; k < n; k++) {
    await page.locator("select").filter({ hasText: "Select or add label" }).first().selectOption({ index: 2 + k });
    const nx = page.locator('button:has-text("›")'); if (await nx.count()) await nx.first().click();
    await page.waitForTimeout(150);
  }
}

async function createReportWithPhotos(page, n = 4, name = "Smoke Test") {
  await page.click("text=+ New Report");
  await page.fill('input[placeholder="Report name…"]', name);
  await page.fill('input[placeholder^="Full name of insured"]', "John Insured");
  await page.fill('input[placeholder^="e.g. 2026"]', "2026-TEST-001");
  await page.click("text=Save & continue");
  await page.click("text=+ Add photos");
  await page.setInputFiles("input[type=file]", await makeImages(page, n));
  await page.waitForSelector('select:has-text("Select or add label")', { timeout: 15000 });
  await labelAll(page, n);
  await page.click(`button:has-text("Add ${n} photos")`);
  await page.waitForSelector(`button:has-text("Photos (${n})")`);
}

async function test(name, fn) {
  let page;
  try { page = await fn.length ? await newPage(fn.opts) : null; } catch (e) { results.push([name, false, "setup: " + e.message.split("\n")[0]]); return; }
  try { await fn(page); if (page.errs.length) throw new Error("JS errors: " + page.errs.join(" | ")); results.push([name, true, ""]); }
  catch (e) { results.push([name, false, e.message.split("\n")[0].slice(0, 220)]); try { await page.screenshot({ path: path.resolve(__dirname, "fail_" + name.replace(/\W+/g, "_") + ".png") }); } catch {} }
  finally { if (page) await page.context().close(); }
}
const phone = (fn) => { fn.opts = { viewport: { width: 390, height: 844 } }; return fn; };
const withOpts = (opts, fn) => { fn.opts = opts; return fn; };
async function openReport(page, name = "Cam Test") {
  await page.click("text=+ New Report"); await page.fill('input[placeholder="Report name…"]', name);
  await page.fill('input[placeholder^="Full name of insured"]', "A"); await page.click("text=Save & continue");
}

(async () => {
  browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });

  await test("app boots and renders", async (p) => { if (!(await p.locator("text=+ New Report").count())) throw new Error("dashboard not rendered"); });
  await test("New Report on a blank install reuses the blank report (no pile-up)", async (p) => {
    await p.click("text=+ New Report"); await p.click("text=← Reports"); await p.waitForTimeout(300);
    const t = await p.locator("body").innerText(); if (!/1 report/i.test(t)) throw new Error("expected 1 report, page says: " + (t.match(/\d+ reports?/i) || ["?"])[0]);
  });
  await test("closing the tab right after an edit does not lose it (flush on pagehide)", async (p) => {
    await createReportWithPhotos(p, 2, "Flush Test");
    await p.evaluate(() => window.dispatchEvent(new Event("pagehide"))); await p.waitForTimeout(300);
    await p.reload(); await p.waitForTimeout(1000); await p.mouse.click(5, 400);
    if (!/Flush Test/.test(await p.locator("body").innerText())) throw new Error("edit lost: report not found after reload");
  });
  await test("create report, upload 4, label, add", async (p) => { await createReportWithPhotos(p); });
  await test("photos can be added before labeling", async (p) => {
    await p.click("text=+ New Report"); await p.fill('input[placeholder="Report name…"]', "X"); await p.fill('input[placeholder^="Full name of insured"]', "A"); await p.click("text=Save & continue");
    await p.click("text=+ Add photos"); await p.setInputFiles("input[type=file]", await makeImages(p, 2)); await p.waitForSelector('select:has-text("Select or add label")', { timeout: 15000 });
    if (await p.locator('button:has-text("Add 2 photos")').isDisabled()) throw new Error("'Add photos' disabled until every photo is labeled");
  });
  await test("edit: rotate, label, annotate, save", async (p) => {
    await createReportWithPhotos(p);
    await p.locator('button:has-text("Edit")').first().click();
    await p.locator("button:has-text('↻')").first().click(); await p.waitForTimeout(500);
    await p.locator("select").first().selectOption({ index: 5 });
    await p.locator("button:has-text('Annotate')").first().click();
    const bb = await p.locator("canvas").first().boundingBox();
    await p.mouse.move(bb.x + 60, bb.y + 60); await p.mouse.down(); await p.mouse.move(bb.x + 200, bb.y + 160, { steps: 8 }); await p.mouse.up();
    await p.click("text=Save annotations"); await p.click('button:has-text("Save changes")'); await p.click("text=Split"); await p.waitForSelector("text=Annotated");
  });
  await test("grid/split views, select all, bulk apply", async (p) => {
    await createReportWithPhotos(p);
    await p.click("text=Split"); await p.click("text=Grid"); await p.click('button:has-text("Select")');
    await p.click("text=/Select all/"); await p.locator("select").filter({ hasText: "— select —" }).first().selectOption({ index: 6 });
    await p.click("text=Apply to 4 photos"); await p.waitForTimeout(400);
  });
  await test("checklist, preview layouts 1/2/4, print to PDF", async (p) => {
    await createReportWithPhotos(p);
    await p.click("text=Continue to checklist"); await p.locator("button:has-text('✓ OK')").first().click();
    await p.click('button:has-text("4"):has-text("Preview")');
    for (const l of ["1 per page", "2 per page", "4 per page"]) await p.locator(`button:has-text("${l}")`).click();
    await p.emulateMedia({ media: "print" }); const pdf = await p.pdf({ format: "Letter", printBackground: true });
    if (pdf.length < 5000) throw new Error("PDF suspiciously small");
  });
  await test("report + photos survive reload", async (p) => {
    await createReportWithPhotos(p, 2, "Persist Test"); await p.waitForTimeout(900);
    await p.reload(); await p.waitForTimeout(1000); await p.mouse.click(5, 400);
    await p.locator("div").filter({ hasText: /Persist Test/ }).locator('button:has-text("Continue →"), button:has-text("Open →")').last().click(); await p.waitForSelector('button:has-text("Photos (2)")');
    await p.locator('button:has-text("Photos")').first().click(); await p.waitForTimeout(400);
    const n = await p.$$eval("img", (e) => e.filter((i) => i.naturalWidth > 0).length); if (!n) throw new Error("no decoded images after reload");
  });
  await test("phone: no horizontal scroll", phone(async (p) => {
    await createReportWithPhotos(p, 2);
    if (await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error("horizontal scroll on 390px");
  }));
  await test("phone: Reports dropdown stays inside screen", phone(async (p) => {
    await p.click("button:has-text('Report')"); await p.waitForTimeout(300);
    const off = await p.evaluate(() => [...document.querySelectorAll("*")].filter((e) => { const s = getComputedStyle(e); return (s.position === "absolute" || s.position === "fixed") && e.offsetWidth > 150 && e.getBoundingClientRect().left < -1; }).length);
    if (off) throw new Error("dropdown runs off the left edge of the screen");
  }));
  await test("Escape closes Reports dropdown", async (p) => {
    await p.click("button:has-text('Report')"); await p.keyboard.press("Escape"); await p.waitForTimeout(200);
    if (await p.locator(".dd-panel").count()) throw new Error("dropdown still open after Escape");
  });


  await test("camera: live viewfinder, 3 shots, Done -> label screen -> report", async (p) => {
    await openReport(p); await p.click("text=📷 Camera");
    await p.waitForFunction(() => { const v = document.querySelector(".cam-video"); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
    for (let i = 0; i < 3; i++) { await p.click(".cam-shutter"); await p.waitForTimeout(250); }
    await p.waitForSelector("text=3 taken"); await p.click("text=Done (3)");
    await p.waitForSelector('select:has-text("Select or add label")', { timeout: 15000 });
    if (await p.locator(".cam").count()) throw new Error("camera overlay did not close");
    await labelAll(p, 3); await p.click('button:has-text("Add 3 photos")'); await p.waitForSelector('button:has-text("Photos (3)")');
    await p.click("text=Split"); await p.waitForTimeout(400);
    const stamped = await p.locator("text=GPS").count();
    if (stamped < 3) throw new Error("expected 3 GPS-stamped camera photos, found " + stamped);
  });
  await test("camera: photos saved from camera survive reload", async (p) => {
    await openReport(p, "Cam Persist"); await p.click("text=📷 Camera");
    await p.waitForFunction(() => { const v = document.querySelector(".cam-video"); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
    await p.click(".cam-shutter"); await p.waitForTimeout(300); await p.click("text=Done (1)");
    await p.waitForSelector('select:has-text("Select or add label")', { timeout: 15000 }); await labelAll(p, 1);
    await p.click('button:has-text("Add 1 photo")'); await p.waitForSelector('button:has-text("Photos (1)")'); await p.waitForTimeout(900);
    await p.reload(); await p.waitForTimeout(1000); await p.mouse.click(5, 400);
    await p.locator("div").filter({ hasText: /Cam Persist/ }).locator('button:has-text("Continue →"), button:has-text("Open →")').last().click();
    await p.waitForSelector('button:has-text("Photos (1)")');
    const n = await p.$$eval("img", (e) => e.filter((i) => i.naturalWidth > 0).length); if (!n) throw new Error("no decoded image after reload");
  });
  await test("camera: remove a shot, discard, no photos added", async (p) => {
    await openReport(p, "Cam Discard"); await p.click("text=📷 Camera");
    await p.waitForFunction(() => { const v = document.querySelector(".cam-video"); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
    await p.click(".cam-shutter"); await p.waitForTimeout(300); await p.click(".cam-shutter"); await p.waitForSelector("text=2 taken");
    await p.locator(".cam-thumb").first().click(); await p.waitForSelector("text=1 taken");
    await p.click('[aria-label="Close camera"]'); await p.click("text=Discard"); await p.waitForTimeout(300);
    if (await p.locator(".cam").count()) throw new Error("camera still open after discard");
    if (await p.locator("select").filter({ hasText: "Select or add label" }).count()) throw new Error("discarded photos still queued");
  });
  await test("camera: permission denied shows friendly message + library fallback", withOpts({ initScript: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })); } }, async (p) => {
    await openReport(p, "Cam Denied"); await p.click("text=📷 Camera"); await p.waitForSelector('[data-testid="cam-error"]');
    if (!/permission/i.test(await p.locator('[data-testid="cam-error"]').innerText())) throw new Error("unhelpful error text");
    await p.setInputFiles('.cam input[type=file]', await makeImages(p, 1));
    await p.waitForSelector('select:has-text("Select or add label")', { timeout: 15000 });
  }));
  await test("phone: camera controls fit the screen", withOpts({ viewport: { width: 390, height: 844 } }, async (p) => {
    await openReport(p, "Cam Phone"); await p.click("text=📷 Camera");
    await p.waitForFunction(() => { const v = document.querySelector(".cam-video"); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
    const bad = await p.evaluate(() => [".cam-shutter", ".cam-done", '[aria-label="Close camera"]', '[aria-label="Flip camera"]'].filter((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight || r.width < 44 || r.height < 44; }));
    if (bad.length) throw new Error("controls off-screen or <44px: " + bad.join(", "));
  }));


  const site = await serveSite();
  await test("PWA: manifest + icons valid, service worker installs", async (p) => {
    await p.goto(site.url); await p.waitForSelector("text=+ New Report");
    const m = await p.evaluate(async () => { const r = await fetch("manifest.webmanifest"); return r.json(); });
    if (m.display !== "standalone" || !m.name || !m.start_url) throw new Error("manifest incomplete");
    for (const ic of m.icons) { const st = await p.evaluate(async (s) => (await fetch(s)).status, ic.src); if (st !== 200) throw new Error("icon missing: " + ic.src); }
    if (!m.icons.some((i) => i.sizes === "512x512") || !m.icons.some((i) => i.sizes === "192x192")) throw new Error("need 192 and 512 icons");
    await p.evaluate(() => navigator.serviceWorker.ready); const ctl = await p.evaluate(async () => { await navigator.serviceWorker.ready; return !!navigator.serviceWorker.getRegistration; });
    if (!ctl) throw new Error("no service worker support");
  });
  await test("PWA: service worker cache name has a real build id (placeholder replaced)", async (p) => {
    await p.goto(site.url); await p.waitForSelector("text=+ New Report");
    const sw = await p.evaluate(async () => (await fetch("sw.js")).text());
    if (/__BUILD__/.test(sw.split("\n").filter((l) => l.startsWith("const CACHE")).join())) throw new Error("CACHE name still contains the __BUILD__ placeholder");
    if (!/const CACHE = "claimphoto-[0-9a-f]{10}"/.test(sw)) throw new Error("CACHE name is not claimphoto-<10 hex chars>");
  });
  await test("PWA: works fully offline after first load (reload with network off)", async (p) => {
    await p.goto(site.url); await p.waitForSelector("text=+ New Report"); await p.evaluate(() => navigator.serviceWorker.ready);
    await p.reload(); await p.waitForTimeout(800); // now controlled by the SW
    await p.context().setOffline(true); await p.reload(); await p.waitForSelector("text=+ New Report", { timeout: 8000 });
    await createReportWithPhotos(p, 2, "Offline Report"); // full flow with no network
  });
  await test("PWA: camera available on a secure origin (http://127.0.0.1)", async (p) => {
    await p.goto(site.url); await p.waitForSelector("text=+ New Report");
    if (!(await p.evaluate(() => window.isSecureContext && !!navigator.mediaDevices))) throw new Error("not a secure context");
    await openReport(p, "Cam Site"); await p.click("text=📷 Camera");
    await p.waitForFunction(() => { const v = document.querySelector(".cam-video"); return v && v.videoWidth > 0; }, null, { timeout: 8000 });
  });
  await test("PWA: asks browser for persistent storage", async (p) => {
    await p.addInitScript(() => { window.__persist = 0; if (navigator.storage) navigator.storage.persist = () => { window.__persist++; return Promise.resolve(true); }; });
    await p.goto(site.url); await p.waitForSelector("text=+ New Report"); await p.waitForTimeout(500);
    if (!(await p.evaluate(() => window.__persist))) throw new Error("navigator.storage.persist() never called");
  });
  site.srv.close();

  await browser.close();
  let fail = 0;
  for (const [n, ok, msg] of results) { console.log((ok ? "PASS " : "FAIL ") + n + (msg ? "\n       " + msg : "")); if (!ok) fail++; }
  console.log(`\n${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
})();
