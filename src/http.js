import { ErrorDocumento, ErrorCatalogo, ErrorCliente, ErrorAuth, ErrorFidelizacion } from "core";
import { ErrorPedido } from "./errores.js";

const STATUS_DOCUMENTO = {
  DOCUMENTO_NO_ENCONTRADO: 404,
  CONFLICTO_VERSION: 409,
  PERMISO_INSUFICIENTE: 403,
};

function responder(res, e, next) {
  if (e instanceof ErrorPedido || e instanceof ErrorCatalogo || e instanceof ErrorCliente || e instanceof ErrorAuth || e instanceof ErrorFidelizacion)
    return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle ?? {}) });
  // Errores del kardex del núcleo (5.75). Se reconocen por nombre para no exigir que `core` ya los exporte.
  if (e?.name === "ErrorKardex") return res.status(e.status).json({ error: e.message, codigo: e.codigo, ...(e.detalle ? { detalle: e.detalle } : {}) });
  if (e instanceof ErrorDocumento)
    return res
      .status(STATUS_DOCUMENTO[e.codigo] ?? 400)
      .json({ error: e.message, codigo: e.codigo, ...(e.detalle ? { detalle: e.detalle } : {}) });
  return next(e);
}

/**
 * Rutas de tobt. Cada una sale con sus middlewares en orden
 * (autenticar → requierePermiso → estación del contexto de eventos → handler), así no se puede
 * olvidar ninguno. La estación la fija la ruta, nunca el cliente (arquitectura 5.4).
 *
 * Pedidos (lo que se cobra: todos los ítems de una mesa o persona)
 *   GET  /pedidos (?estado=a,b &limite= &saltar=)        documento:leer
 *   GET  /pedidos/:code (?version=)                       documento:leer
 *   POST /pedidos        { canal, mesa|referencia|entrega, items: [...] }   documento:crear
 *   POST /pedidos/:code/items   { items: [...] }          documento:crear   (más ítems en el mismo pedido)
 *   PUT  /pedidos/:code  { esperaVersion?, mesa, referencia, entrega, notas }   documento:editar
 *   PUT  /pedidos/:code/cliente  { clienteId|null, esperaVersion? }   documento:editar (solo abierto)
 *   POST /pedidos/:code/cobrar  { esperaVersion?, clienteId?, pago? }   documento:editar + estación administración (el motor)
 *        `pago`: { metodo: efectivo|tarjeta|yape|plin|transferencia|otro, propina?, recibido? } (5.32); responde con `recibo`
 *   POST /pedidos/:code/cobrar-items  { items: ["DOC_ITEM-…"], pago? }   igual (cuenta dividida: cobra solo esos ítems entregados;
 *        el pedido se cierra solo cuando no queda nada por cobrar)
 *   POST /pedidos/:code/anular  { motivo: { codigo, detalle? } }   igual
 *
 * Ítems (un ítem que se mueve por las estaciones; cocina trabaja con estos)
 *   GET  /items (?estado=a,b &limite= &saltar=)        documento:leer
 *   GET  /items/:code                                   documento:leer
 *   POST /items/:code/lista                             documento:editar + estación cocina (el motor)
 *   POST /items/:code/entregar                          documento:editar
 *   PUT  /items/:code/cliente  { clienteId|null, esperaVersion? }   documento:editar (a quién se le cobra el ítem)
 *   POST /items/:code/precio  { precio }                documento:editar + estación administración (solo el precio)
 *   POST /items/:code/anular  { motivo }                documento:editar (+ administración si ya salió de cocina)
 *   POST /items/:code/vale  { codigo, esperaVersion? }  documento:editar + fidelizacion:canjear (aplica un vale de fidelización a ESE ítem)
 *
 * Recibos (5.32, no fiscales)
 *   GET  /pedidos/:code/cuenta                          documento:leer   la cuenta del pedido (consumo, cobrado, falta); no se guarda
 *   GET  /pedidos/:code/recibos                         documento:leer   { recibos } de pago emitidos en ese pedido
 *   GET  /recibos/:code                                 documento:leer   un recibo de pago (RC-…)
 *
 * Reportes (5.35)
 *   GET  /reportes/ventas (?desde=AAAA-MM-DD &hasta= &dias=N &gran=dia|semana|mes)   reporte:leer   ventas cobradas (ítems pagados) resumidas
 *        por tiempo, categoría, mesero (quien cobra), cliente, plato, hora y canal, más propinas y formas de pago (recibos)
 *
 * Recetas (5.76; necesitan el kardex del núcleo, 5.75)
 *   GET    /recetas                                     kardex:leer      { recetas } de la empresa
 *   GET    /recetas/:platoCodigo                        kardex:leer      qué insumos gasta una porción del plato
 *   PUT    /recetas/:platoCodigo  { lineas: [{ insumoId, cantidad }] }   kardex:gestionar   crea o reemplaza (cantidad en la unidad base del insumo)
 *   DELETE /recetas/:platoCodigo                        kardex:gestionar quita la receta (lo ya consumido no cambia)
 *   Al crear un ítem se descuenta receta × cantidad y la respuesta puede traer `stockBajo` y `sinReceta` (avisos; nunca bloquean).
 *
 * Vales (5.30)
 *   GET  /vales/:codigo                                 fidelizacion:canjear   el vale, su beneficio y su cliente (no lo gasta)
 */
export function montarRutas(router, core, servicio) {
  const { autenticar, requierePermiso, eventos, auth } = core;
  const { pedidos, items, vales, recibos, reportes, recetas } = servicio;

  const envolver = (escribe, fn) => async (req, res, next) => {
    try {
      if (escribe) auth.exigirCsrf(req);
      await fn(req, res);
    } catch (e) {
      responder(res, e, next);
    }
  };
  const base = (req) => ({
    empresaId: req.auth.empresaId,
    actor: { usuarioId: req.auth.usuarioId, permisos: req.rol?.permisos ?? [] },
  });
  const con = (permiso, estacion) => [autenticar(), requierePermiso(permiso), eventos.middleware({ estacion })];
  const leer = con("documento:leer", "creacion");
  const crear = con("documento:crear", "creacion");
  const editar = (estacion) => con("documento:editar", estacion);

  const estados = (q) => (q.estado ? String(q.estado).split(",").filter(Boolean) : undefined);
  const versionDe = (q) => {
    const v = q?.version;
    if (v === undefined) return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n)) throw new ErrorPedido("DATOS_INVALIDOS", "version debe ser un entero");
    return n;
  };

  // ---------- pedidos ----------
  router.get(
    "/pedidos",
    ...leer,
    envolver(false, async (req, res) => {
      const q = req.query ?? {};
      res.status(200).json({ pedidos: await pedidos.listar({ ...base(req), estado: estados(q), limite: q.limite, saltar: q.saltar }) });
    }),
  );
  router.get(
    "/pedidos/:code",
    ...leer,
    envolver(false, async (req, res) =>
      res.status(200).json(await pedidos.obtener({ ...base(req), code: req.params.code, version: versionDe(req.query) })),
    ),
  );
  router.post(
    "/pedidos",
    ...crear,
    envolver(true, async (req, res) => res.status(201).json(await pedidos.crear({ ...base(req), ...(req.body ?? {}) }))),
  );
  router.post(
    "/pedidos/:code/items",
    ...crear,
    envolver(true, async (req, res) =>
      res.status(201).json(await pedidos.agregarItems({ ...base(req), code: req.params.code, ...(req.body ?? {}) })),
    ),
  );
  router.put(
    "/pedidos/:code",
    ...editar("creacion"),
    envolver(true, async (req, res) => {
      const { esperaVersion, ...cuerpo } = req.body ?? {};
      res.status(200).json(await pedidos.editar({ ...base(req), code: req.params.code, esperaVersion, ...cuerpo }));
    }),
  );
  router.put(
    "/pedidos/:code/cliente",
    ...editar("creacion"),
    envolver(true, async (req, res) => {
      const { esperaVersion, clienteId } = req.body ?? {};
      res.status(200).json(
        await pedidos.asociarCliente({ ...base(req), code: req.params.code, esperaVersion, clienteId: clienteId ?? null }),
      );
    }),
  );
  const pasoPedido = (ruta, metodo) =>
    router.post(
      `/pedidos/:code/${ruta}`,
      ...editar("administracion"),
      envolver(true, async (req, res) => {
        const { esperaVersion, motivo, clienteId, pago } = req.body ?? {};
        res.status(200).json(
          await pedidos[metodo]({ ...base(req), code: req.params.code, esperaVersion, motivo, ...(clienteId !== undefined ? { clienteId } : {}), ...(pago !== undefined ? { pago } : {}) }),
        );
      }),
    );
  pasoPedido("cobrar", "cobrar");
  router.post(
    "/pedidos/:code/cobrar-items",
    ...editar("administracion"),
    envolver(true, async (req, res) =>
      res.status(200).json(await pedidos.cobrarItems({ ...base(req), code: req.params.code, items: req.body?.items, ...(req.body?.pago !== undefined ? { pago: req.body.pago } : {}) })),
    ),
  );
  pasoPedido("anular", "anular");

  // ---------- recibos (5.32) ----------
  router.get(
    "/pedidos/:code/cuenta",
    ...leer,
    envolver(false, async (req, res) => res.status(200).json(await pedidos.cuenta({ ...base(req), code: req.params.code }))),
  );
  router.get(
    "/pedidos/:code/recibos",
    ...leer,
    envolver(false, async (req, res) => res.status(200).json({ recibos: await pedidos.recibos({ ...base(req), code: req.params.code }) })),
  );
  router.get(
    "/recibos/:code",
    ...leer,
    envolver(false, async (req, res) => res.status(200).json(await recibos.obtener({ ...base(req), code: req.params.code }))),
  );

  // ---------- reportes (5.35) ----------
  // Solo con `reporte:leer` (el administrador lo tiene por `*`; ninguna plantilla de rol lo trae). Son lecturas: no
  // piden `x-requested-with`. La estación del contexto de eventos es la de administración.
  if (reportes)
    router.get(
      "/reportes/ventas",
      ...con("reporte:leer", "administracion"),
      envolver(false, async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        const { desde, hasta, dias, gran } = req.query ?? {};
        res.status(200).json(await reportes.ventas({ ...base(req), desde, hasta, dias, gran }));
      }),
    );

  // ---------- ítems (ítems) ----------
  router.get(
    "/items",
    ...leer,
    envolver(false, async (req, res) => {
      const q = req.query ?? {};
      res.status(200).json({ items: await items.listar({ ...base(req), estado: estados(q), limite: q.limite, saltar: q.saltar }) });
    }),
  );
  router.get(
    "/items/:code",
    ...leer,
    envolver(false, async (req, res) => res.status(200).json(await items.obtener({ ...base(req), code: req.params.code }))),
  );
  const pasoItem = (ruta, metodo, estacion) =>
    router.post(
      `/items/:code/${ruta}`,
      ...editar(estacion),
      envolver(true, async (req, res) => {
        const { esperaVersion, motivo } = req.body ?? {};
        res.status(200).json(await items[metodo]({ ...base(req), code: req.params.code, esperaVersion, motivo }));
      }),
    );
  pasoItem("lista", "marcarLista", "cocina");
  pasoItem("entregar", "entregar", "creacion");
  pasoItem("anular", "anular", "creacion");
  router.put(
    "/items/:code/cliente",
    ...editar("creacion"),
    envolver(true, async (req, res) => {
      const { esperaVersion, clienteId } = req.body ?? {};
      res.status(200).json(await items.asociarCliente({ ...base(req), code: req.params.code, esperaVersion, clienteId: clienteId ?? null }));
    }),
  );
  router.post(
    "/items/:code/vale",
    ...editar("creacion"),
    envolver(true, async (req, res) => {
      const { esperaVersion, codigo } = req.body ?? {};
      res.status(200).json(await items.aplicarVale({ ...base(req), code: req.params.code, codigo, esperaVersion }));
    }),
  );
  // ---------- recetas (5.76) ----------
  const inventarioRuta = (permiso) => [autenticar(), requierePermiso(permiso), eventos.middleware({ estacion: "administracion" })];
  router.get("/recetas", ...inventarioRuta("kardex:leer"), envolver(false, async (req, res) => res.status(200).json({ recetas: await recetas.listar({ ...base(req) }) })));
  router.get(
    "/recetas/:platoCodigo",
    ...inventarioRuta("kardex:leer"),
    envolver(false, async (req, res) => res.status(200).json(await recetas.obtener({ ...base(req), platoCodigo: req.params.platoCodigo }))),
  );
  router.put(
    "/recetas/:platoCodigo",
    ...inventarioRuta("kardex:gestionar"),
    envolver(true, async (req, res) =>
      res.status(200).json(await recetas.guardar({ ...base(req), platoCodigo: req.params.platoCodigo, lineas: req.body?.lineas })),
    ),
  );
  router.delete(
    "/recetas/:platoCodigo",
    ...inventarioRuta("kardex:gestionar"),
    envolver(true, async (req, res) => res.status(200).json(await recetas.borrar({ ...base(req), platoCodigo: req.params.platoCodigo }))),
  );
  router.get(
    "/vales/:codigo",
    autenticar(),
    requierePermiso("fidelizacion:canjear"),
    envolver(false, async (req, res) => res.status(200).json(await vales.consultar({ ...base(req), codigo: req.params.codigo }))),
  );
  router.post(
    "/items/:code/precio",
    ...editar("administracion"),
    envolver(true, async (req, res) => {
      const { esperaVersion, ...cuerpo } = req.body ?? {};
      res.status(200).json(await items.cambiarPrecio({ ...base(req), code: req.params.code, esperaVersion, ...cuerpo }));
    }),
  );

  return router;
}
