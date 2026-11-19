// Reemplazo de `@base44/sdk` en el servidor. Mismo API que usan las apps de Base44
// (createClientFromRequest, entities, integrations.Core.SendEmail, auth), pero sobre
// Postgres y Resend. No hace ninguna llamada a servidores de Base44.
import { entitiesModule } from "./db.server.js";
import { sendEmail } from "./email.server.js";
import { Base44Error, notSupported } from "./errors.js";

export { Base44Error };

const unauthorized = () => Promise.reject(new Base44Error("No hay sesión iniciada.", 401, "UNAUTHORIZED"));

function strictModule(name, members = {}) {
  return new Proxy(members, {
    get(target, key) {
      if (key in target || typeof key !== "string" || key === "then") return target[key];
      return () => Promise.reject(notSupported(`${name}.${key}`));
    },
  });
}

function buildClient() {
  const entities = entitiesModule(null);
  const integrations = {
    Core: strictModule("integrations.Core", {
      SendEmail: (params) => sendEmail(params),
    }),
  };
  const auth = strictModule("auth", {
    me: unauthorized,
    isAuthenticated: async () => false,
    updateMe: unauthorized,
    logout: async () => {},
    setToken: () => {},
    hasToken: () => false,
  });
  const noop = strictModule("analytics", { track: () => {}, identify: () => {} });
  const client = {
    entities,
    integrations,
    auth,
    analytics: noop,
    appLogs: strictModule("appLogs", { logUserInApp: async () => {} }),
    functions: strictModule("functions"),
    agents: strictModule("agents"),
    connectors: strictModule("connectors"),
    users: strictModule("users"),
    payments: strictModule("payments"),
    aiGateway: strictModule("aiGateway", {
      connection: () => {
        throw notSupported("aiGateway");
      },
    }),
    cleanup: () => {},
  };
  // asServiceRole es el mismo cliente: el adaptador no tiene usuarios, todo corre como la app.
  client.asServiceRole = client;
  return client;
}

let shared;
const getClient = () => (shared ??= buildClient());

export function createClient() {
  return getClient();
}

export function createClientFromRequest() {
  return getClient();
}

export function getAccessToken() {
  return null;
}

export function saveAccessToken() {}
export function removeAccessToken() {}
export function getLoginUrl() {
  return "/";
}
