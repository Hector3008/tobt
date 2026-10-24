// Reportes de ventas (5.35). Todo se calcula en el servidor, por agregación de MongoDB: el navegador solo
// recibe series ya resumidas.
//
// Qué es una venta: un ítem `doc_item` en estado `pagado` (lo cobrado; los anulados y los pedidos abiertos no
// cuentan). Su fecha es la del movimiento `→ pagado` del historial, no la de creación. Su importe es el subtotal
// del ítem (ya con el vale aplicado) y NO incluye propinas.
// El mesero de una venta es quien la cobró (decisión de Héctor, 19 de octubre): el usuario del movimiento `→ pagado`.
// Si ese movimiento lo hizo el sistema (sin usuario), la venta queda «sin atribuir».
// Promociones (5.43): el importe ya trae las promociones descontadas. Cada ítem cobrado guarda en `payload.doc.promociones`
// las que se le aplicaron ({ id, nombre, monto, unidades }); de ahí sale cuánto se descontó y por cuál promoción. Lo
// cobrado antes de 5.42 no las tiene y cuenta como sin promociones.
// Los días se agrupan en la zona horaria de la empresa (según su país).
import { ErrorPedido } from "./errores.js";
import { METODOS_PAGO } from "./recibo.js";

export const GRANULARIDADES = Object.freeze(["dia", "semana", "mes"]);
export const MAX_DIAS = 366;
export const DIAS_POR_DEFECTO = 30;
export const TOP_PLATOS = 10;
export const TOP_CLIENTES = 10;
export const TOP_CATEGORIAS = 8;
export const TOP_PROMOCIONES = 8;

// País de la empresa (ISO de 2 letras) → zona horaria. Un país con varias zonas usa la de su capital; uno que no
// está aquí agrupa en UTC (y la respuesta lo dice en `zona`, para no pasar un día por otro sin avisar).
export const ZONAS = Object.freeze({
  PE: "America/Lima",
  EC: "America/Guayaquil",
  CO: "America/Bogota",
  BO: "America/La_Paz",
  CL: "America/Santiago",
  AR: "America/Argentina/Buenos_Aires",
  UY: "America/Montevideo",
  PY: "America/Asuncion",
  MX: "America/Mexico_City",
  ES: "Europe/Madrid",
  US: "America/New_York",
});

export const zonaDe = (empresa) => ZONAS[String(empresa?.pais ?? "PE").toUpperCase()] ?? "UTC";

// ---------- fechas (sin librerías: Intl con la zona de la empresa) ----------

const pad = (n, w = 2) => String(n).padStart(w, "0");
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` real (rechaza 2026-02-30). Devuelve `{ y, m, d }` o null. */
export function partesDeFecha(texto) {
  const m = RE_FECHA.exec(String(texto ?? ""));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

const formateadores = new Map();
function partesEnZona(ms, zona) {
  let f = formateadores.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zona, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formateadores.set(zona, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Fecha local (`YYYY-MM-DD`) de un instante en la zona. */
export function fechaLocal(ms, zona) {
  const p = partesEnZona(ms, zona);
  return `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
}

const desfaseMs = (ms, zona) => {
  const p = partesEnZona(Math.floor(ms / 1000) * 1000, zona);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
};

/** El instante (UTC) en que empieza ese día local en la zona. */
export function inicioDelDia(fecha, zona) {
  const { y, m, d } = partesDeFecha(fecha);
  const nominal = Date.UTC(y, m - 1, d);
  let t = nominal - desfaseMs(nominal, zona);
  t = nominal - desfaseMs(t, zona); // el desfase puede cambiar entre la primera estimación y el instante real
  return t;
}

export function sumarDias(fecha, n) {
  const { y, m, d } = partesDeFecha(fecha);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export const diasEntre = (a, b) => {
  const [pa, pb] = [partesDeFecha(a), partesDeFecha(b)];
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
};

// ---------- cubetas del tiempo ----------

/** Lunes de la semana ISO a la que pertenece la fecha. */
export function lunesDe(fecha) {
  const { y, m, d } = partesDeFecha(fecha);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // lunes = 0
  return sumarDias(fecha, -dow);
}

/** Semana ISO (`2026-W43`): el año es el del jueves de esa semana. */
export function claveSemana(fecha) {
  const { y, m, d } = partesDeFecha(fecha);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dow + 3); // el jueves de esa semana decide el año
  const anio = t.getUTCFullYear();
  const ene4 = new Date(Date.UTC(anio, 0, 4));
  const semana = 1 + Math.round(((t - ene4) / 86_400_000 - 3 + ((ene4.getUTCDay() + 6) % 7)) / 7);
  return `${pad(anio, 4)}-W${pad(semana)}`;
}

export function claveDe(fecha, gran) {
  if (gran === "mes") return fecha.slice(0, 7);
  if (gran === "semana") return claveSemana(fecha);
  return fecha;
}

/** Primer día de la cubeta (el día, el lunes o el día 1) para rotularla. */
export function inicioDeCubeta(fecha, gran) {
  if (gran === "mes") return `${fecha.slice(0, 7)}-01`;
  if (gran === "semana") return lunesDe(fecha);
  return fecha;
}

/** Todas las cubetas del rango, también las sin ventas (para que la línea no salte días). */
export function cubetasDelRango(desde, hasta, gran) {
  const salida = [];
  const vistas = new Set();
  for (let f = desde, n = 0; diasEntre(f, hasta) >= 0 && n <= MAX_DIAS + 1; f = sumarDias(f, 1), n++) {
    const clave = claveDe(f, gran);
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    salida.push({ clave, inicio: inicioDeCubeta(f, gran) });
  }
  return salida;
}

// ---------- validación de lo que pide el cliente ----------

/**
 * `{ desde?, hasta?, dias?, gran? }` → rango en fechas locales, instantes UTC y granularidad.
 * Sin `hasta` es hoy (según la zona de la empresa); sin `desde`, `dias` días (30 por defecto) terminando en `hasta`.
 * `dias` es lo que usan los atajos «7 días», «30 días»: así «hoy» lo decide el servidor y no el reloj del navegador.
 */
export function validarConsulta(q, { zona, ahora = Date.now() }) {
  const malo = (m) => new ErrorPedido("DATOS_INVALIDOS", m);
  const gran = q?.gran === undefined || q?.gran === "" ? "dia" : q.gran;
  if (!GRANULARIDADES.includes(gran)) throw malo(`gran: uno de ${GRANULARIDADES.join(", ")}`);
  const dado = (v) => v !== undefined && v !== null && v !== "";
  if (dado(q?.hasta) && !partesDeFecha(q.hasta)) throw malo("hasta debe ser una fecha AAAA-MM-DD");
  if (dado(q?.desde) && !partesDeFecha(q.desde)) throw malo("desde debe ser una fecha AAAA-MM-DD");
  const hasta = dado(q?.hasta) ? q.hasta : fechaLocal(ahora, zona);
  let pedidos = DIAS_POR_DEFECTO;
  if (dado(q?.dias)) {
    pedidos = Number(q.dias);
    if (!Number.isInteger(pedidos) || pedidos < 1 || pedidos > MAX_DIAS) throw malo(`dias debe ser un entero de 1 a ${MAX_DIAS}`);
  }
  const desde = dado(q?.desde) ? q.desde : sumarDias(hasta, -(pedidos - 1));
  const dias = diasEntre(desde, hasta) + 1;
  if (dias < 1) throw malo("desde no puede ser posterior a hasta");
  if (dias > MAX_DIAS) throw malo(`el rango no puede pasar de ${MAX_DIAS} días`);
  return {
    desde, hasta, gran, dias,
    desdeTs: new Date(inicioDelDia(desde, zona)),
    hastaTs: new Date(inicioDelDia(sumarDias(hasta, 1), zona)), // exclusivo
  };
}

// ---------- agregación ----------

/**
 * Lo cobrado en el rango, en una sola pasada (`$facet`). El primer `$match` usa tipo y estado (índice
 * `{ empresaId, tipo, estado }`); el plugin de multiempresa antepone el filtro de la empresa. El `$lookup` trae el
 * canal del pedido y se limita a la misma empresa (el código `PD-0000001` existe en todas).
 */
export function pipelineVentas({ desdeTs, hastaTs, zona: zonaEmpresa }) {
  // MongoDB acepta nombres de zona (`America/Lima`) y desfases (`+00:00`); UTC va como desfase, que no depende del alias.
  const zona = zonaEmpresa === "UTC" ? "+00:00" : zonaEmpresa;
  // El servidor agrupa siempre por DÍA local (a lo más 366 filas); la semana y el mes se arman aquí con `claveDe`, así
  // la clave de la cubeta es una sola y no depende de cómo cada motor escriba `%G-W%V`.
  const f = (formato) => ({ $dateToString: { format: formato, date: "$_pago.ts", timezone: zona } });
  const suma = { $sum: "$importe" };
  const sinCliente = { "snapshot.cliente.clienteId": null };
  return [
    { $match: { tipo: "doc_item", estado: "pagado", historial: { $elemMatch: { a: "pagado", ts: { $gte: desdeTs, $lt: hastaTs } } } } },
    { $addFields: { _pago: { $last: { $filter: { input: "$historial", as: "h", cond: { $eq: ["$$h.a", "pagado"] } } } } } },
    { $match: { "_pago.ts": { $gte: desdeTs, $lt: hastaTs } } },
    {
      $lookup: {
        from: "documentos",
        let: { c: "$payload.doc.pedidoCode", e: "$empresaId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$code", "$$c"] }, { $eq: ["$empresaId", "$$e"] }, { $eq: ["$tipo", "pedido"] }] } } },
          { $project: { _id: 0, canal: "$payload.doc.canal" } },
        ],
        as: "_pedido",
      },
    },
    {
      $addFields: {
        importe: { $ifNull: ["$payload.doc.subtotal", 0] },
        unidades: { $ifNull: ["$payload.doc.cantidad", 1] },
        cubeta: f("%Y-%m-%d"),
        hora: { $hour: { date: "$_pago.ts", timezone: zona } },
        dia: { $isoDayOfWeek: { date: "$_pago.ts", timezone: zona } },
        cobrador: { $cond: [{ $eq: ["$_pago.sistema", true] }, null, { $ifNull: ["$_pago.usuarioId", null] }] },
        canal: { $ifNull: [{ $arrayElemAt: ["$_pedido.canal", 0] }, null] },
        plato: { $ifNull: ["$snapshot.item.codigo", { $concat: ["libre:", { $ifNull: ["$snapshot.item.nombre", "?"] }] }] },
      },
    },
    {
      $facet: {
        resumen: [{ $group: { _id: null, ventas: suma, items: { $sum: 1 }, unidades: { $sum: "$unidades" } } }],
        pedidos: [{ $group: { _id: "$payload.doc.pedidoCode" } }, { $count: "n" }],
        serie: [{ $group: { _id: "$cubeta", ventas: suma, items: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        categorias: [
          { $group: { _id: { $ifNull: ["$snapshot.item.categoria", null] }, ventas: suma, items: { $sum: 1 } } },
          { $sort: { ventas: -1 } },
        ],
        meseros: [
          { $group: { _id: "$cobrador", ventas: suma, items: { $sum: 1 }, pedidos: { $addToSet: "$payload.doc.pedidoCode" } } },
          { $project: { ventas: 1, items: 1, pedidos: { $size: "$pedidos" } } },
          { $sort: { ventas: -1 } },
        ],
        clientes: [
          { $match: { "snapshot.cliente.clienteId": { $ne: null } } },
          { $group: { _id: "$snapshot.cliente.clienteId", nombre: { $first: "$snapshot.cliente.nombre" }, ventas: suma, items: { $sum: 1 } } },
          { $sort: { ventas: -1 } },
          { $limit: TOP_CLIENTES },
        ],
        sinCliente: [{ $match: sinCliente }, { $group: { _id: null, ventas: suma, items: { $sum: 1 } } }],
        platos: [
          { $group: { _id: "$plato", nombre: { $first: "$snapshot.item.nombre" }, categoria: { $first: "$snapshot.item.categoria" }, cantidad: { $sum: "$unidades" }, ventas: suma } },
          { $sort: { cantidad: -1, ventas: -1 } },
          { $limit: TOP_PLATOS },
        ],
        // Una fila por cada promoción aplicada a un ítem cobrado (un ítem sin promociones no entra).
        promociones: [
          { $unwind: "$payload.doc.promociones" },
          {
            $group: {
              _id: "$payload.doc.promociones.id",
              nombre: { $last: "$payload.doc.promociones.nombre" },
              ahorro: { $sum: { $ifNull: ["$payload.doc.promociones.monto", 0] } },
              items: { $sum: 1 },
              unidades: { $sum: { $ifNull: ["$payload.doc.promociones.unidades", 0] } },
            },
          },
          { $sort: { ahorro: -1, _id: 1 } },
        ],
        horas: [{ $group: { _id: { d: "$dia", h: "$hora" }, ventas: suma, items: { $sum: 1 } } }],
        canales: [{ $group: { _id: "$canal", ventas: suma, items: { $sum: 1 } } }, { $sort: { ventas: -1 } }],
      },
    },
  ];
}

/** Propinas y formas de pago salen de los recibos (existen desde 5.32; lo cobrado antes no los tiene). */
export function pipelineRecibos({ desdeTs, hastaTs }) {
  return [
    { $match: { tipo: "recibo", createdAt: { $gte: desdeTs, $lt: hastaTs } } },
    {
      $group: {
        _id: { $ifNull: ["$payload.doc.metodo", null] },
        recibos: { $sum: 1 },
        cobrado: { $sum: { $ifNull: ["$payload.doc.subtotal", 0] } },
        propinas: { $sum: { $ifNull: ["$payload.doc.propina", 0] } },
      },
    },
    { $sort: { cobrado: -1 } },
  ];
}

// ---------- forma de la respuesta ----------

const redondear = (n) => Math.round((Number(n) || 0) * 100) / 100;
const texto = (id) => (id === null || id === undefined ? null : String(id));
const participacion = (parte, total) => (total > 0 ? Math.round((parte / total) * 1000) / 10 : 0);

/** Deja los N primeros y junta el resto en «Otros» (nunca se inventa un color para el noveno). */
export function plegar(filas, max, { clave = "ventas", resto = { nombre: "Otros" } } = {}) {
  if (filas.length <= max) return filas;
  const cabeza = filas.slice(0, max - 1);
  const cola = filas.slice(max - 1);
  const otros = { ...resto, otros: true, [clave]: redondear(cola.reduce((n, f) => n + f[clave], 0)) };
  if (cola[0] && "items" in cola[0]) otros.items = cola.reduce((n, f) => n + f.items, 0);
  return [...cabeza, otros];
}

/**
 * Resultado crudo de `$facet` + recibos + nombres de usuarios → la respuesta de la API.
 * `usuarios`: Map id → nombre (o correo).
 */
export function armarReporte({ facet, recibos, usuarios, empresa, zona, consulta, moneda }) {
  const f = facet ?? {};
  const resumen = f.resumen?.[0] ?? { ventas: 0, items: 0, unidades: 0 };
  const ventas = redondear(resumen.ventas);
  const pedidos = f.pedidos?.[0]?.n ?? 0;

  // Ventas por día (del servidor) → cubetas del tamaño pedido. Cada día cae en exactamente una cubeta.
  const porClave = new Map();
  for (const d of f.serie ?? []) {
    const clave = claveDe(d._id, consulta.gran);
    const previo = porClave.get(clave) ?? { ventas: 0, items: 0 };
    porClave.set(clave, { ventas: previo.ventas + d.ventas, items: previo.items + d.items });
  }
  const serie = cubetasDelRango(consulta.desde, consulta.hasta, consulta.gran).map((c) => {
    const s = porClave.get(c.clave);
    return { clave: c.clave, inicio: c.inicio, ventas: redondear(s?.ventas), items: s?.items ?? 0 };
  });

  const categorias = plegar(
    (f.categorias ?? []).map((c) => ({
      nombre: c._id ?? "Sin categoría", sinCategoria: c._id === null, ventas: redondear(c.ventas), items: c.items,
      porcentaje: participacion(c.ventas, resumen.ventas),
    })),
    TOP_CATEGORIAS,
  ).map((c) => ({ ...c, porcentaje: c.otros ? participacion(c.ventas, ventas) : c.porcentaje }));

  const meseros = (f.meseros ?? []).map((m) => {
    const id = texto(m._id);
    return {
      id, sinAtribuir: id === null,
      nombre: id === null ? "Sin atribuir" : usuarios?.get(id) ?? "Usuario eliminado",
      ventas: redondear(m.ventas), items: m.items, pedidos: m.pedidos, porcentaje: participacion(m.ventas, resumen.ventas),
    };
  });

  const clientesTop = (f.clientes ?? []).map((c) => ({
    id: texto(c._id), nombre: c.nombre || "Cliente", ventas: redondear(c.ventas), items: c.items, porcentaje: participacion(c.ventas, resumen.ventas),
  }));
  const sinCliente = f.sinCliente?.[0] ?? { ventas: 0, items: 0 };
  const visible = clientesTop.reduce((n, c) => n + c.ventas, 0);
  const otrosVentas = redondear(ventas - redondear(sinCliente.ventas) - visible);
  const clientes = {
    top: clientesTop,
    otros: otrosVentas > 0 ? { ventas: otrosVentas, porcentaje: participacion(otrosVentas, ventas) } : null,
    sinCliente: { ventas: redondear(sinCliente.ventas), items: sinCliente.items, porcentaje: participacion(sinCliente.ventas, resumen.ventas) },
  };

  const platos = (f.platos ?? []).map((p) => ({
    codigo: String(p._id).startsWith("libre:") ? null : String(p._id),
    nombre: p.nombre ?? String(p._id), categoria: p.categoria ?? null, cantidad: p.cantidad, ventas: redondear(p.ventas),
  }));

  // Mapa de calor lunes (1) a domingo (7) × hora (0 a 23); siempre 7 × 24 celdas.
  const celdas = new Map((f.horas ?? []).map((h) => [`${h._id.d}-${h._id.h}`, h]));
  const horas = [];
  for (let d = 1; d <= 7; d++)
    for (let h = 0; h < 24; h++) {
      const c = celdas.get(`${d}-${h}`);
      horas.push({ dia: d, hora: h, ventas: redondear(c?.ventas), items: c?.items ?? 0 });
    }

  // Promociones: el ahorro total es la suma de todas (aunque solo se listen las TOP_PROMOCIONES primeras; el resto va en `otras`).
  const filasPromos = (f.promociones ?? []).map((p) => ({
    id: texto(p._id), nombre: p.nombre ?? "Promoción", ahorro: redondear(p.ahorro), items: p.items, unidades: p.unidades,
  }));
  const ahorro = redondear(filasPromos.reduce((n, p) => n + p.ahorro, 0));
  const antes = redondear(ventas + ahorro);
  const visibles = filasPromos.slice(0, TOP_PROMOCIONES).map((p) => ({ ...p, porcentaje: participacion(p.ahorro, ahorro) }));
  const resto = filasPromos.slice(TOP_PROMOCIONES);
  const promociones = {
    ahorro,
    ventasAntes: antes, // lo que habría sido sin promociones
    porcentaje: participacion(ahorro, antes), // del valor a precio completo
    items: filasPromos.reduce((n, p) => n + p.items, 0),
    porPromocion: visibles,
    otras: resto.length ? { cantidad: resto.length, ahorro: redondear(resto.reduce((n, p) => n + p.ahorro, 0)), items: resto.reduce((n, p) => n + p.items, 0) } : null,
  };

  const canales = (f.canales ?? []).map((c) => ({
    canal: c._id ?? null, ventas: redondear(c.ventas), items: c.items, porcentaje: participacion(c.ventas, resumen.ventas),
  }));

  const filasRecibos = recibos ?? [];
  const pagos = filasRecibos.map((r) => ({
    metodo: r._id ?? null, metodoTexto: r._id ? METODOS_PAGO[r._id] ?? r._id : "Sin indicar",
    recibos: r.recibos, cobrado: redondear(r.cobrado), propinas: redondear(r.propinas),
  }));

  return {
    desde: consulta.desde, hasta: consulta.hasta, gran: consulta.gran, dias: consulta.dias, zona,
    moneda: moneda ?? empresa?.moneda ?? null,
    resumen: {
      ventas, items: resumen.items, unidades: resumen.unidades, pedidos,
      ticketPromedio: pedidos > 0 ? redondear(ventas / pedidos) : null,
      propinas: redondear(filasRecibos.reduce((n, r) => n + (r.propinas ?? 0), 0)),
      recibos: filasRecibos.reduce((n, r) => n + r.recibos, 0),
    },
    serie, categorias, meseros, clientes, platos, horas, canales, pagos, promociones,
  };
}

// ---------- servicio ----------

/**
 * `deps` son los modelos del núcleo (`core.modelos`): `Documento` (con tenancy), `Empresa` y `Usuario` (globales).
 * Cada operación corre dentro de la empresa activa y exige el permiso `reporte:leer`.
 */
export function crearReportes({ conEmpresa, permite, modelos, ahora = () => Date.now() }) {
  const exigir = (actor, permiso) => {
    if (!actor || !permite(actor.permisos ?? [], permiso))
      throw new ErrorPedido("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  async function ventas({ empresaId, actor, ...q }) {
    exigir(actor, "reporte:leer");
    const empresa = (await modelos.Empresa.findById(empresaId).lean()) ?? null;
    const zona = zonaDe(empresa);
    const consulta = validarConsulta(q, { zona, ahora: ahora() });
    return await conEmpresa(empresaId, async () => {
      const [facet, recibos] = await Promise.all([
        modelos.Documento.aggregate(pipelineVentas({ ...consulta, zona })),
        modelos.Documento.aggregate(pipelineRecibos(consulta)),
      ]);
      const ids = (facet[0]?.meseros ?? []).map((m) => m._id).filter((id) => id !== null && id !== undefined);
      const usuarios = new Map();
      if (ids.length) {
        const filas = await modelos.Usuario.find({ _id: { $in: ids } }).select("nombre correo").lean();
        for (const u of filas) usuarios.set(String(u._id), u.nombre || u.correo || "Sin nombre");
      }
      return armarReporte({ facet: facet[0], recibos, usuarios, empresa, zona, consulta });
    });
  }

  return { ventas };
}
