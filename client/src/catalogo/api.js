// Cliente HTTP de la vista pública de la carta. La carta y los platos no necesitan sesión. La cuenta del cliente
// (`cuenta/...` y `cliente`) usa su cookie propia `cs_<slug>` (mismo origen) y, al escribir, `x-requested-with`.
// La página se sirve con <base href> en la raíz del montaje (`<base>/tobt/`), así que "../" lleva a `<base>/`
// sin conocer el BASE_PATH (igual que el front de personal).
const BASE = new URL("../", document.baseURI).pathname;

export class ErrorCarta extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

async function pedir(ruta, { metodo = "GET", cuerpo, cuenta = false } = {}) {
  let r;
  const headers = { Accept: "application/json" };
  if (metodo !== "GET") headers["x-requested-with"] = "catalogo";
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  try {
    r = await fetch(BASE + ruta, {
      method: metodo,
      headers,
      credentials: cuenta ? "same-origin" : "omit",
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  } catch {
    throw new ErrorCarta(0, "No se pudo conectar. Revisa tu conexión e intenta de nuevo.");
  }
  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    if (r.status === 404 && !cuenta) throw new ErrorCarta(404, datos?.error === "plato no encontrado" ? "No encontramos este plato." : "No encontramos esta carta. Revisa el enlace.");
    if (r.status === 429) throw new ErrorCarta(429, "Demasiadas consultas. Espera un momento y recarga.");
    const e = new ErrorCarta(r.status, datos?.error || "No se pudo cargar. Intenta de nuevo en un momento.");
    e.codigo = datos?.codigo ?? null;
    throw e;
  }
  return datos;
}

const enc = encodeURIComponent;

export const api = {
  carta: (slug) => pedir(`tobt/publico/${enc(slug)}/carta`),
  promociones: (slug) => pedir(`tobt/publico/${enc(slug)}/promociones`),
  anuncios: (slug) => pedir(`tobt/publico/${enc(slug)}/anuncios`),
  plato: (slug, codigo) => pedir(`tobt/publico/${enc(slug)}/plato/${enc(codigo)}`),
  // Cuenta del cliente. `cliente` responde { sesion: false } sin sesión.
  cliente: (slug) => pedir(`tobt/publico/${enc(slug)}/cliente`, { cuenta: true }),
  registro: (slug, cuerpo) => pedir(`tobt/publico/${enc(slug)}/cuenta/registro`, { metodo: "POST", cuerpo, cuenta: true }),
  login: (slug, cuerpo) => pedir(`tobt/publico/${enc(slug)}/cuenta/login`, { metodo: "POST", cuerpo, cuenta: true }),
  // Entrar con Google (5.51): `credencial` es el ID token que entrega el botón de Google
  google: (slug, cuerpo) => pedir(`tobt/publico/${enc(slug)}/cuenta/google`, { metodo: "POST", cuerpo, cuenta: true }),
  logout: (slug) => pedir(`tobt/publico/${enc(slug)}/cuenta/logout`, { metodo: "POST", cuerpo: {}, cuenta: true }),
  cambiarPassword: (slug, cuerpo) => pedir(`tobt/publico/${enc(slug)}/cuenta/password`, { metodo: "POST", cuerpo, cuenta: true }),
  // Beneficios y vales (5.30): { beneficios, vales } del cliente de la sesión
  vales: (slug) => pedir(`tobt/publico/${enc(slug)}/cuenta/vales`, { cuenta: true }),
  canjearVale: (slug, beneficioId) => pedir(`tobt/publico/${enc(slug)}/cuenta/vales`, { metodo: "POST", cuerpo: { beneficioId }, cuenta: true }),
  cancelarVale: (slug, codigo) => pedir(`tobt/publico/${enc(slug)}/cuenta/vales/${enc(codigo)}/cancelar`, { metodo: "POST", cuerpo: {}, cuenta: true }),
  consentimiento: (slug, otorgado) => pedir(`tobt/publico/${enc(slug)}/cuenta/consentimiento`, { metodo: "PUT", cuerpo: { otorgado }, cuenta: true }),
};
