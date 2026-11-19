// Plugin de Vite que reemplaza las piezas de Base44 por equivalentes que corren en Vercel:
//   @base44/sdk        → runtime/sdk.server.js (servidor) o runtime/sdk.browser.js (navegador)
//   base44:document    → runtime/document.js (sin scripts de Base44)
//   base44:runtime     → runtime/runtime.js (secretos = variables de entorno)
//   cloudflare:workers → runtime/cloudflare-workers.js
// y genera los módulos virtuales con los esquemas de entidades y las plantillas de correo.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (name) => path.join(here, name);

const VIRTUAL_ENTITIES = "virtual:b44-entities";
const VIRTUAL_EMAILS = "virtual:b44-emails";
const KNOWN_BASE44_MODULES = { "base44:document": file("document.js"), "base44:runtime": file("runtime.js") };

// JSON con comentarios y comas finales (los .jsonc de Base44).
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function loadEntities(root) {
  const dir = path.join(root, "base44", "entities");
  const schemas = {};
  if (!existsSync(dir)) return schemas;
  for (const name of readdirSync(dir)) {
    if (!/\.(jsonc?|json)$/.test(name)) continue;
    try {
      const schema = parseJsonc(readFileSync(path.join(dir, name), "utf8"));
      const entity = schema.name || name.replace(/\.(jsonc?|json)$/, "");
      schemas[entity] = { properties: schema.properties || {}, required: schema.required || [] };
    } catch (error) {
      throw new Error(`No se pudo leer el esquema base44/entities/${name}: ${error.message}`);
    }
  }
  return schemas;
}

function loadEmails(root) {
  const dir = path.join(root, "base44", "emails");
  const templates = {};
  if (!existsSync(dir)) return templates;
  const requireFromApp = createRequire(path.join(root, "package.json"));
  let mjml;
  for (const name of readdirSync(dir).sort()) {
    if (!/\.(html|mjml)$/.test(name)) continue;
    const source = readFileSync(path.join(dir, name), "utf8");
    let html = source;
    if (/<mjml[\s>]/.test(source)) {
      mjml ??= requireFromApp("mjml");
      const result = mjml(source, { validationLevel: "soft" });
      if (result.errors?.length) console.warn(`[base44-adapter] ${name}:`, result.errors.map((e) => e.formattedMessage).join("; "));
      html = result.html;
    }
    const subject = (source.match(/<mj-title>([\s\S]*?)<\/mj-title>/) || source.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.trim() || "";
    templates[name.replace(/\.(html|mjml)$/, "")] = { subject, html };
  }
  return templates;
}

// Nombres internos de Base44 que quedan visibles en el HTML o en el JavaScript del navegador
// (atributos data-*, eventos, claves de localStorage). Se renombran para no dejar rastro.
const COSMETIC_RENAMES = [
  [/data-base44-/g, "data-app-"],
  [/base44:image-replace/g, "app:image-replace"],
  [/base44_access_token/g, "app_access_token"],
  [/media\.base44\.com/g, "media.invalid"],
];

export default function base44Adapter() {
  let root = process.cwd();
  return {
    name: "base44-vercel-adapter",
    enforce: "pre",
    config(config) {
      root = config.root ? path.resolve(config.root) : process.cwd();
      const src = path.join(root, "src");
      return { resolve: { alias: [{ find: /^@\/(.*)$/, replacement: `${src}/$1` }] } };
    },
    resolveId(id, _importer, options) {
      if (id === "@base44/sdk") {
        const isClient = this.environment ? this.environment.config.consumer === "client" : !options?.ssr;
        return file(isClient ? "sdk.browser.js" : "sdk.server.js");
      }
      if (id.startsWith("@base44/sdk/")) {
        this.error(`[base44-adapter] "${id}" no está soportado. Usa solo los exports de "@base44/sdk".`);
      }
      if (id === "cloudflare:workers") return file("cloudflare-workers.js");
      if (id in KNOWN_BASE44_MODULES) return KNOWN_BASE44_MODULES[id];
      if (id.startsWith("base44:")) {
        this.error(`[base44-adapter] El módulo "${id}" de Base44 todavía no tiene reemplazo. Hay que añadirlo al adaptador.`);
      }
      if (id === VIRTUAL_ENTITIES || id === VIRTUAL_EMAILS) return `\0${id}`;
      return null;
    },
    transform(code, id) {
      if (!id.startsWith(path.join(root, "src")) || id.includes("node_modules")) return null;
      if (!/\.(jsx?|tsx?|mjs)$/.test(id.split("?")[0])) return null;
      let next = code;
      for (const [pattern, replacement] of COSMETIC_RENAMES) next = next.replace(pattern, replacement);
      return next === code ? null : { code: next, map: null };
    },
    load(id) {
      if (id === `\0${VIRTUAL_ENTITIES}`) return `export default ${JSON.stringify(loadEntities(root))};`;
      if (id === `\0${VIRTUAL_EMAILS}`) return `export default ${JSON.stringify(loadEmails(root))};`;
      return null;
    },
  };
}
