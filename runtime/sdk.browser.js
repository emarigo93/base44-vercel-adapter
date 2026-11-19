// Reemplazo de `@base44/sdk` en el navegador. Las apps de Base44 (plantilla TanStack Start)
// leen y escriben datos solo desde funciones del servidor, así que aquí no hay acceso a la
// base de datos: el visitante siempre es anónimo y nada llama a servidores de Base44.
import { Base44Error, notSupported } from "./errors.js";

export { Base44Error };

const unauthorized = () => Promise.reject(new Base44Error("No hay sesión iniciada.", 401, "UNAUTHORIZED"));

function strictModule(name, members = {}) {
  return new Proxy(members, {
    get(target, key) {
      if (key in target || typeof key !== "string" || key === "then") return target[key];
      return () => Promise.reject(notSupported(`${name}.${key} en el navegador`));
    },
  });
}

const entities = new Proxy(
  {},
  {
    get(_, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      return strictModule(`entities.${name}`, { subscribe: () => () => {} });
    },
  },
);

function buildClient() {
  const client = {
    entities,
    integrations: new Proxy({}, { get: (_, ns) => strictModule(`integrations.${String(ns)}`) }),
    auth: strictModule("auth", {
      me: unauthorized,
      isAuthenticated: async () => false,
      logout: async () => {},
      setToken: () => {},
      hasToken: () => false,
      redirectToLogin: () => {},
      loginWithProvider: () => Promise.reject(notSupported("auth.loginWithProvider")),
    }),
    analytics: strictModule("analytics", { track: () => {}, identify: () => {} }),
    appLogs: strictModule("appLogs", { logUserInApp: async () => {} }),
    functions: strictModule("functions"),
    agents: strictModule("agents"),
    cleanup: () => {},
  };
  client.asServiceRole = client;
  return client;
}

let shared;
export function createClient() {
  return (shared ??= buildClient());
}
export const createClientFromRequest = createClient;
export function getAccessToken() {
  return null;
}
export function saveAccessToken() {}
export function removeAccessToken() {}
export function getLoginUrl() {
  return "/";
}
