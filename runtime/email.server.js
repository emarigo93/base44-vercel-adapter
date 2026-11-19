// integrations.Core.SendEmail de Base44, enviado con Resend (https://resend.com).
// Variables de entorno: RESEND_API_KEY y EMAIL_FROM ("Nombre <correo@dominio-verificado.com>").
// `from_name` de la app reemplaza el nombre de EMAIL_FROM; la dirección siempre es la verificada.
import TEMPLATES from "virtual:b44-emails";
import { Base44Error } from "./errors.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fill(text, variables, escape) {
  return String(text).replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, key) => {
    const value = key.split(".").reduce((v, k) => (v == null ? undefined : v[k]), variables || {});
    return escape ? escapeHtml(value) : String(value ?? "");
  });
}

function fromHeader(fromName) {
  const configured = process.env.EMAIL_FROM;
  if (!configured) throw new Base44Error("Falta EMAIL_FROM en las variables de entorno.", 500, "CONFIG");
  const address = (configured.match(/<([^>]+)>/) || [null, configured.trim()])[1];
  const name = fromName || (configured.includes("<") ? configured.slice(0, configured.indexOf("<")).trim() : "");
  return name ? `${name.replace(/[<>"]/g, "")} <${address}>` : address;
}

async function attachmentsFor(list = []) {
  const out = [];
  for (const file of list) {
    if (file.content) {
      out.push({ filename: file.filename, content: file.content });
    } else if (file.file_url) {
      out.push({ filename: file.filename, path: file.file_url });
    }
  }
  return out;
}

export async function sendEmail(params = {}) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Base44Error("Falta RESEND_API_KEY en las variables de entorno.", 500, "CONFIG");

  let { subject, html, text } = params;
  html ??= params.body;
  if (params.template_name) {
    const template = TEMPLATES[params.template_name];
    if (!template) throw new Base44Error(`Plantilla de correo desconocida: ${params.template_name}`, 400, "BAD_TEMPLATE");
    subject ??= fill(template.subject, params.variables, false);
    html = fill(template.html, params.variables, true);
  }
  const to = (Array.isArray(params.to) ? params.to : String(params.to || "").split(",")).map((v) => v.trim()).filter(Boolean);
  if (to.length === 0) throw new Base44Error("El correo no tiene destinatario.", 400, "BAD_EMAIL");

  let response;
  try {
    response = await fetch(process.env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromHeader(params.from_name),
      to,
      subject: subject || "(sin asunto)",
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(params.reply_to ? { reply_to: params.reply_to } : process.env.EMAIL_REPLY_TO ? { reply_to: process.env.EMAIL_REPLY_TO } : {}),
      ...(params.attachments?.length ? { attachments: await attachmentsFor(params.attachments) } : {}),
    }),
    });
  } catch (error) {
    console.error("No se pudo conectar con Resend:", error);
    return { success: false, message: "No se pudo enviar el correo." };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    // Mismo contrato que Base44: el código de la app puede revisar `success === false`.
    console.error(`Resend respondió ${response.status}: ${detail.slice(0, 300)}`);
    return { success: false, message: `No se pudo enviar el correo (${response.status}).` };
  }
  const result = await response.json().catch(() => ({}));
  return { success: true, id: result.id };
}
