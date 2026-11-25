// Bundles src/ into ONE self-contained, offline HTML file: dist/ClaimPhoto.html
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const result = await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: ["es2018"],
  loader: { ".js": "jsx", ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "error",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = readFileSync("src/styles.css", "utf8");
const tpl = readFileSync("src/index.template.html", "utf8");
// function replacers avoid "$&"-style substitutions corrupting the output
const html = tpl.replace("/*__CSS__*/", () => css).replace("/*__JS__*/", () => js);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/ClaimPhoto.html", html);
// ── Installable web-app bundle (for hosting on https, e.g. GitHub Pages) ──
const build_id = createHash("sha256").update(html).digest("hex").slice(0, 10);
mkdirSync("dist/site", { recursive: true });
writeFileSync("dist/site/index.html", html);
writeFileSync("dist/site/sw.js", readFileSync("src/sw.js", "utf8").replace("__BUILD__", build_id));
copyFileSync("src/manifest.webmanifest", "dist/site/manifest.webmanifest");
for (const f of readdirSync("src/icons")) copyFileSync("src/icons/" + f, "dist/site/" + f);
writeFileSync("dist/site/.nojekyll", "");
// docs/ is what GitHub Pages serves (committed build output)
mkdirSync("docs", { recursive: true });
for (const f of readdirSync("dist/site", { withFileTypes: true })) if (f.isFile()) copyFileSync("dist/site/" + f.name, "docs/" + f.name);
console.log(`built dist/site (installable web app, build ${build_id})`);
console.log(`built dist/ClaimPhoto.html (${(html.length / 1024).toFixed(0)} KB)`);
