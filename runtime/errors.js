// Mismo shape que el error del SDK original: el código de la app lee `status` y `code`.
export class Base44Error extends Error {
  constructor(message, status = 500, code = "ERROR", data = null) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.data = data;
    this.originalError = null;
  }
}

export function notSupported(what) {
  return new Base44Error(`${what} no está disponible en esta instalación (adaptador de Vercel).`, 501, "NOT_SUPPORTED");
}
