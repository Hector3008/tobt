import { ErrorPedido } from "./errores.js";

/**
 * Rutas públicas de tobt (SIN sesión): la carta de una empresa y el cliente que la mira.
 *
 *   GET /catalogo/:empresa              la página (HTML) de la carta; `:empresa` es el slug
 *   GET /publico/:empresa/carta         { empresa: { nombre, slug, moneda, marca }, categorias: [{ nombre, items }] }
 *   GET /publico/:empresa/promociones   { empresa, hoy, promociones: [{ nombre, tipo, …regla, vigenteAhora }] }   (5.43)
 *   GET /publico/:empresa/anuncios      { empresa, hoy, eventos: [{ titulo, fecha, hora, lugar, imagen, … }], publicidad: [...] }   (5.49)
 *   GET /publico/:empresa/plato/:codigo  { empresa, plato: { codigo, nombre, categoria, precio, descripcion, imagen }, resenas }
 *
 * Cuenta del cliente final (con sesión propia `cs_<slug>`; los maneja core.cuentasCliente, ver core/docs/cuentas-cliente.md):
 *   GET  /publico/:empresa/cliente                  { sesion:false } | { sesion:true, cliente, puntos }
 *   POST /publico/:empresa/cuenta/registro          { nombre, telefono?, correo?, password, quierePuntos? }
 *   POST /publico/:empresa/cuenta/login             { usuario, password }
 *   POST /publico/:empresa/cuenta/google            { credencial, quierePuntos?, codigoReferido? }   entrar con Google (5.51); solo si el núcleo lo trae
 *   POST /publico/:empresa/cuenta/logout
 *   POST /publico/:empresa/cuenta/password          { passwordActual, passwordNueva }
 *   PUT  /publico/:empresa/cuenta/consentimiento    { otorgado }
 *   GET  /publico/:empresa/cuenta/vales             { beneficios, vales }          (publico-vales.js, 5.30)
 *   POST /publico/:empresa/cuenta/vales             { beneficioId }                canjea puntos por un vale
 *   POST /publico/:empresa/cuenta/vales/:codigo/cancelar                           devuelve los puntos
 *
 * Solo lectura (GET), así que no necesitan `x-requested-with`. Como no hay sesión que limite el abuso, llevan
 * un límite de frecuencia por IP, en memoria (como los de auth: se reinicia con el servidor y no se comparte
 * entre instancias; ver sección 6).
 */

const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = 60;

export function limitadorPorIp({ ventanaMs = VENTANA_MS, max = MAX_POR_VENTANA, ahora = Date.now } = {}) {
  const cuentas = new Map(); // ip -> { desde, n }
  return (req, res, next) => {
    const t = ahora();
    if (cuentas.size > 5000) for (const [ip, c] of cuentas) if (t - c.desde >= ventanaMs) cuentas.delete(ip);
    const ip = req.ip ?? "desconocida";
    let c = cuentas.get(ip);
    if (!c || t - c.desde >= ventanaMs) {
      c = { desde: t, n: 0 };
      cuentas.set(ip, c);
    }
    c.n += 1;
    if (c.n > max) {
      res.setHeader("Retry-After", String(Math.ceil((c.desde + ventanaMs - t) / 1000)));
      return res.status(429).json({ error: "Demasiadas consultas. Espera un momento.", codigo: "DEMASIADAS_CONSULTAS" });
    }
    next();
  };
}

const escaparAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * La página vive en `<base>/tobt/catalogo/<slug>`, una ruta más profunda que la del front de personal
 * (`<base>/tobt/`). Los archivos compilados se piden en relativo, así que se fija `<base href>` a la
 * raíz del montaje: así el HTML sirve con cualquier BASE_PATH y api.js calcula bien la ruta de la API.
 */
export function paginaCatalogo(html, baseUrl) {
  const base = `${baseUrl.replace(/\/+$/, "")}/`;
  return html.replace("<head>", `<head>\n    <base href="${escaparAttr(base)}" />`);
}

export function montarRutasPublicas(router, publico, htmlCatalogo, limitador = limitadorPorIp(), cuentas = null, vales = null) {
  const envolver = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (e instanceof ErrorPedido) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
      next(e);
    }
  };

  router.get("/catalogo/:empresa", limitador, (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(paginaCatalogo(htmlCatalogo, req.baseUrl));
  });

  router.get(
    "/publico/:empresa/carta",
    limitador,
    envolver(async (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      res.status(200).json(await publico.carta({ slug: req.params.empresa }));
    }),
  );

  // Promociones vigentes (5.43). Cambian con la hora del día: caché corta.
  router.get(
    "/publico/:empresa/promociones",
    limitador,
    envolver(async (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      res.status(200).json(await publico.promociones({ slug: req.params.empresa }));
    }),
  );

  // Eventos y publicidad (5.49). Cambian con el día de la empresa: caché corta.
  router.get(
    "/publico/:empresa/anuncios",
    limitador,
    envolver(async (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      res.status(200).json(await publico.anuncios({ slug: req.params.empresa }));
    }),
  );

  router.get(
    "/publico/:empresa/plato/:codigo",
    limitador,
    envolver(async (req, res) => {
      res.setHeader("Cache-Control", "public, max-age=30");
      res.status(200).json(await publico.plato({ slug: req.params.empresa, codigo: req.params.codigo }));
    }),
  );

  // Cuenta del cliente: solo si el núcleo la trae. Los manejadores ya traducen sus errores y exigen CSRF al escribir.
  if (cuentas) {
    router.get("/publico/:empresa/cliente", limitador, cuentas.yo);
    router.post("/publico/:empresa/cuenta/registro", limitador, cuentas.registro);
    router.post("/publico/:empresa/cuenta/login", limitador, cuentas.login);
    // Entrar con Google (5.51): un núcleo anterior no trae el manejador y la ruta simplemente no existe.
    if (typeof cuentas.google === "function") router.post("/publico/:empresa/cuenta/google", limitador, cuentas.google);
    router.post("/publico/:empresa/cuenta/logout", limitador, cuentas.logout);
    router.post("/publico/:empresa/cuenta/password", limitador, cuentas.password);
    router.put("/publico/:empresa/cuenta/consentimiento", limitador, cuentas.consentimiento);
  }

  // Vales del cliente (5.30): la sesión del cliente es la que dice de quién son.
  if (vales) {
    router.get("/publico/:empresa/cuenta/vales", limitador, vales.sesion, vales.listar);
    router.post("/publico/:empresa/cuenta/vales", limitador, vales.sesion, vales.emitir);
    router.post("/publico/:empresa/cuenta/vales/:codigo/cancelar", limitador, vales.sesion, vales.cancelar);
  }
}
