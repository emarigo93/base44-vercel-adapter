#!/usr/bin/env node
// Prepara una app exportada de Base44 (TanStack Start) para compilar en Vercel.
// Corre en la carpeta del proyecto ANTES de `npm install`. No necesita dependencias.
//
//   1. Cambia vite.config.js por uno con Nitro (Vercel) y el plugin del adaptador.
//   2. Quita de package.json los paquetes de Base44 y Cloudflare y añade los que hacen falta.
//   3. Descarga las imágenes guardadas en Base44 a public/media y cambia las URLs.
//   4. Cambia los enlaces al dominio *.base44.app por el dominio del sitio.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const ADAPTER_REL = "./" + path.relative(ROOT, ADAPTER_DIR).split(path.sep).join("/");

const ADD_DEPENDENCIES = {
  nitro: "3.0.261103-rc",
  postgres: "^3.4.7",
  mjml: "^4.15.3",
};
const REMOVE_PACKAGES = ["@base44/sdk", "@base44/vite-plugin", "@cloudflare/vite-plugin", "wrangler"];
const TEXT_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".css", ".html", ".mjml", ".json", ".jsonc", ".md", ".txt", ".xml", ".webmanifest", ".svg"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".b44adapter", "dist", ".output", ".vercel", ".tanstack", ".wrangler"]);

const log = (...args) => console.log("[base44-adapter]", ...args);
const warn = (...args) => console.warn("[base44-adapter] ATENCIÓN:", ...args);

function siteUrl() {
  const explicit = process.env.SITE_URL?.replace(/\/+$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  return vercel ? `https://${vercel}` : "";
}

// ---------- 1. vite.config.js ----------
function writeViteConfig() {
  const target = path.join(ROOT, "vite.config.js");
  const config = `// Generado por base44-vercel-adapter. Base44 lo vuelve a escribir en cada exportación; no lo edites aquí.
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import base44Adapter from "${ADAPTER_REL}/runtime/vite-plugin.js";

export default defineConfig({
  plugins: [base44Adapter(), tanstackStart({ srcDirectory: "src" }), nitro(), react()],
});
`;
  for (const name of ["vite.config.ts", "vite.config.mjs"]) rmSync(path.join(ROOT, name), { force: true });
  writeFileSync(target, config);
  log("vite.config.js listo (Nitro + adaptador).");
}

// ---------- 2. package.json ----------
function patchPackageJson() {
  const file = path.join(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const name of REMOVE_PACKAGES) delete pkg[section]?.[name];
  }
  pkg.dependencies = { ...pkg.dependencies, ...ADD_DEPENDENCIES };
  pkg.scripts = { ...pkg.scripts, build: "vite build" };
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  rmSync(path.join(ROOT, "wrangler.jsonc"), { force: true });
  rmSync(path.join(ROOT, "wrangler.toml"), { force: true });
  log(`package.json listo (quitados: ${REMOVE_PACKAGES.join(", ")}).`);
}

// ---------- 3 y 4. imágenes y enlaces ----------
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(name).toLowerCase()) && stat.size < 5_000_000) out.push(full);
  }
  return out;
}

const MEDIA_URL = /https?:\/\/(?:(?:[a-z0-9-]+\.)*base44\.(?:app|com)\/[^\s"'`)<>\\]*(?:\/files\/|\/storage\/)[^\s"'`)<>\\]+|media\.base44\.com\/[^\s"'`)<>\\]+|[a-z0-9]+\.supabase\.co\/storage\/v1\/object\/public\/base44-prod\/[^\s"'`)<>\\]+)/gi;
const APP_URL = /https?:\/\/[a-z0-9-]+\.base44\.app(?=[/"'`\s)<>]|$)/gi;

function fileNameFor(url, used) {
  const raw = decodeURIComponent(new URL(url).pathname.split("/").pop() || "file");
  let name = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "file";
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += ".bin";
  let candidate = name;
  for (let i = 2; used.has(candidate) && used.get(candidate) !== url; i++) candidate = `${i}-${name}`;
  used.set(candidate, url);
  return candidate;
}

async function download(url, dest) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (error) {
      if (attempt === 3) {
        warn(`no se pudo descargar ${url}: ${error.message}. Se deja la URL original.`);
        return false;
      }
    }
  }
}

async function localizeMedia() {
  const base = siteUrl();
  const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "base44", "emails")), ...walk(path.join(ROOT, "public"))];
  const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
  const urls = new Set();
  for (const text of contents.values()) for (const m of text.matchAll(MEDIA_URL)) urls.add(m[0]);

  const mediaDir = path.join(ROOT, "public", "media");
  mkdirSync(mediaDir, { recursive: true });
  const used = new Map();
  const replacements = new Map();
  await Promise.all(
    [...urls].map(async (url) => {
      const name = fileNameFor(url, used);
      if (await download(url, path.join(mediaDir, name))) replacements.set(url, `/media/${name}`);
    }),
  );

  // Las URLs más largas primero, para no cortar una dentro de otra.
  const ordered = [...replacements.entries()].sort((a, b) => b[0].length - a[0].length);
  let changed = 0;
  for (const [file, original] of contents) {
    const inEmail = file.includes(path.join("base44", "emails"));
    let text = original;
    // En el sitio, rutas relativas (funcionan en cualquier dominio); en los correos, absolutas.
    for (const [url, local] of ordered) text = text.split(url).join(inEmail ? `${base}${local}` : local);
    if (base) text = text.replace(APP_URL, base);
    else if (new RegExp(APP_URL.source, "i").test(text)) warn(`${path.relative(ROOT, file)} enlaza al dominio de Base44 y no hay SITE_URL para cambiarlo.`);
    if (text !== original) {
      writeFileSync(file, text);
      changed++;
    }
  }
  log(`imágenes: ${replacements.size}/${urls.size} descargadas a public/media; ${changed} archivos actualizados.`);
  if (!base) warn("no se encontró SITE_URL ni VERCEL_PROJECT_PRODUCTION_URL: los correos tendrán imágenes con rutas relativas.");
}

writeViteConfig();
patchPackageJson();
await localizeMedia();
log("Listo. Sigue npm install y vite build.");
