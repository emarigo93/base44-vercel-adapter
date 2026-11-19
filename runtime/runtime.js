// Reemplazo de "base44:runtime": los secretos de Base44 se leen de las variables de entorno de Vercel.
export const secrets = {
  get(name) {
    return process.env[name];
  },
  has(name) {
    return process.env[name] !== undefined;
  },
};
export default { secrets };
