// Reemplazo de "cloudflare:workers" para correr en Node (Vercel Functions).
export const env = new Proxy({}, {
  get: (_, key) => (typeof key === "string" ? process.env[key] : undefined),
  ownKeys: () => Reflect.ownKeys(process.env),
  getOwnPropertyDescriptor: (_, key) =>
    key in process.env ? { enumerable: true, configurable: true, value: process.env[key] } : undefined,
});
export function waitUntil(promise) {
  Promise.resolve(promise).catch(() => {});
}
export default { env, waitUntil };
