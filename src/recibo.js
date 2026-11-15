import { ErrorPedido } from "./errores.js";

// Recibos de tobt (arquitectura 5.32). Lógica pura, sin base de datos.
//
// Dos clases, las dos NO fiscales (no son una factura ni una boleta electrónica):
//   · recibo de PAGO: se guarda al cobrar (cada cobro, entero o por ítems, genera uno). Tiene número (RC-0000001),
//     lo cobrado, la forma de pago, la propina y el vuelto. No cambia después.
//   · cuenta (recibo de CONSUMO): se arma al vuelo desde el pedido, en cualquier momento: lo consumido, lo ya
//     cobrado y lo que falta. No se guarda y no sirve como comprobante de pago.

export const METODOS_PAGO = Object.freeze({
  efectivo: "Efectivo",
  tarjeta: "Tarjeta",
  yape: "Yape",
  plin: "Plin",
  transferencia: "Transferencia",
  otro: "Otro",
});

const malo = (m) => new ErrorPedido("DATOS_INVALIDOS", m);
const centavos = (n) => Math.round(n * 100);
const dosDecimales = (n) => Math.abs(centavos(n) / 100 - n) < 1e-9;
const dinero = (c) => c / 100;
const SIN_PAGO = Object.freeze({ metodo: null, propina: 0, recibido: null, factura: null });

export const MAX_RUC_REFERENCIA = 30;
const RE_RUC_REFERENCIA = /^[\p{L}\p{N}][\p{L}\p{N} .\-/]*$/u;

/**
 * Si el cliente pide factura (5.86). `factura` es true/false y, solo con true, `rucReferencia` es obligatorio: el RUC del
 * cliente o, si no lo tiene a la mano, una referencia para emitirla después (letras, números, espacios y . - /; hasta 30).
 * Devuelve `{ requerida, rucReferencia }`, o null si no se declaró nada (cobros anteriores o sin esa pregunta).
 */
export function validarFactura(factura, rucReferencia) {
  if (factura === undefined || factura === null) {
    if (rucReferencia !== undefined && rucReferencia !== null && String(rucReferencia).trim() !== "")
      throw malo("pago.rucReferencia: solo se anota si se pide factura (pago.factura: true)");
    return null;
  }
  if (typeof factura !== "boolean") throw malo("pago.factura: true o false");
  if (!factura) {
    if (rucReferencia !== undefined && rucReferencia !== null && String(rucReferencia).trim() !== "")
      throw malo("pago.rucReferencia: solo se anota si se pide factura (pago.factura: true)");
    return { requerida: false, rucReferencia: null };
  }
  const t = typeof rucReferencia === "string" ? rucReferencia.trim().replace(/\s+/g, " ") : "";
  if (!t) throw malo("pago.rucReferencia: obligatorio cuando el cliente pide factura (RUC o referencia)");
  if (t.length > MAX_RUC_REFERENCIA) throw malo(`pago.rucReferencia: hasta ${MAX_RUC_REFERENCIA} caracteres`);
  if (!RE_RUC_REFERENCIA.test(t)) throw malo("pago.rucReferencia: solo letras, números, espacios y . - /");
  return { requerida: true, rucReferencia: t };
}

function monto(v, nombre, { max, positivo = false }) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (positivo && v === 0) || v > max || !dosDecimales(v))
    throw malo(`${nombre}: un número ${positivo ? "mayor que 0" : "de 0 o más"}, con 2 decimales como máximo (hasta ${max})`);
  return v;
}

/**
 * Valida lo que dice el cajero al cobrar: `{ metodo, propina?, recibido? }`. Sin `pago` el cobro sigue como antes
 * (método sin indicar, sin propina). `ventaCentavos` es lo que se va a cobrar por los ítems (null si algún ítem no
 * tiene precio): con `recibido` (solo efectivo) se comprueba que alcance y se calcula el vuelto.
 * Devuelve `{ metodo, propina, recibido }` normalizado.
 */
export function validarPago(pago, ventaCentavos = null) {
  if (pago === undefined || pago === null) return { ...SIN_PAGO };
  if (typeof pago !== "object" || Array.isArray(pago)) throw malo("pago debe ser un objeto");
  const extra = Object.keys(pago).filter((k) => !["metodo", "propina", "recibido", "factura", "rucReferencia"].includes(k));
  if (extra.length) throw malo(`pago: campos no admitidos (${extra.join(", ")})`);
  const factura = validarFactura(pago.factura, pago.rucReferencia);
  // La forma de pago puede quedar sin indicar solo cuando lo que se declara es la factura (5.86); entonces no hay propina ni efectivo
  if ((pago.metodo === undefined || pago.metodo === null) && factura !== null && (pago.propina ?? null) === null && (pago.recibido ?? null) === null)
    return { metodo: null, propina: 0, recibido: null, factura };
  if (!Object.hasOwn(METODOS_PAGO, pago.metodo)) throw malo(`pago.metodo: uno de ${Object.keys(METODOS_PAGO).join(", ")}`);
  const propina = pago.propina === undefined || pago.propina === null ? 0 : monto(pago.propina, "pago.propina", { max: 1_000_000 });
  let recibido = null;
  if (pago.recibido !== undefined && pago.recibido !== null) {
    if (pago.metodo !== "efectivo") throw malo("pago.recibido: solo se anota en un pago en efectivo");
    recibido = monto(pago.recibido, "pago.recibido", { max: 10_000_000, positivo: true });
    if (ventaCentavos === null) throw malo("pago.recibido: no se puede calcular el vuelto porque hay ítems sin precio");
    const faltan = ventaCentavos + centavos(propina) - centavos(recibido);
    if (faltan > 0) throw malo(`pago.recibido: no alcanza (faltan ${dinero(faltan).toFixed(2)})`);
  }
  return { metodo: pago.metodo, propina, recibido, factura };
}

const sumar = (cs) => (cs.some((c) => c === null) ? null : cs.reduce((n, c) => n + c, 0));
const subtotalC = (i) => (typeof i.subtotal === "number" ? centavos(i.subtotal) : null);
const montoDescuento = (i) => (i.descuento ? centavos(Number(i.descuento.monto) || 0) : 0);
// Lo descontado por promociones en un ítem (5.42), en centavos
const montoPromociones = (i) => (Array.isArray(i.promociones) ? i.promociones.reduce((n, p) => n + centavos(Number(p.monto) || 0), 0) : 0);

const texto = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * El encabezado de un recibo o una cuenta (5.34): nombre, razón social, identificación fiscal, dirección, teléfono, pie y
 * logo de la empresa. En un recibo de pago es una COPIA de lo que decía al emitirse (no cambia si la empresa luego cambia
 * sus datos); en la cuenta son los datos de ahora. Los recibos anteriores a 5.34 solo traen el nombre.
 */
export function emisor(e) {
  if (!e || typeof e !== "object") return null;
  return {
    nombre: typeof e.nombre === "string" ? e.nombre : "",
    razonSocial: texto(e.razonSocial),
    idFiscal: texto(e.idFiscal),
    etiquetaIdFiscal: e.etiquetaIdFiscal === "ID fiscal" ? "ID fiscal" : "RUC",
    direccion: texto(e.direccion),
    telefono: texto(e.telefono),
    pie: texto(e.pie),
    logo: texto(e.logo),
  };
}

/** Los ítems de un recibo o de una cuenta: lo que el cliente ve en cada renglón. */
const linea = (i) => ({
  itemCode: i.code,
  nombre: i.nombre,
  codigo: i.codigo ?? null,
  cantidad: i.cantidad,
  precio: i.precio ?? null,
  subtotal: i.subtotal ?? null,
  descuento: i.descuento ? { vale: i.descuento.vale, beneficio: i.descuento.beneficio ?? null, monto: i.descuento.monto } : null,
  // Promociones aplicadas a este renglón (5.42): el subtotal ya viene con ellas. Los recibos anteriores no traen el campo.
  promociones: Array.isArray(i.promociones) ? i.promociones.map((p) => ({ nombre: p.nombre, monto: p.monto })) : [],
});

const clientesDe = (items) => {
  const mapa = new Map();
  for (const i of items) if (i.cliente?.id) mapa.set(i.cliente.id, { id: i.cliente.id, nombre: i.cliente.nombre ?? "" });
  return [...mapa.values()];
};

/**
 * El contenido de un recibo de pago. `items` son los ítems recién cobrados (formato `resumenItem`), `pedido` el
 * resumen del pedido, `pago` ya validado. `vuelto` solo con efectivo recibido.
 */
export function armarRecibo({ pedido, items, pago = SIN_PAGO, empresa = null, moneda = null }) {
  const venta = sumar(items.map(subtotalC));
  const propina = centavos(pago.propina ?? 0);
  const total = venta === null ? null : venta + propina;
  const vuelto = pago.recibido != null && total !== null ? centavos(pago.recibido) - total : null;
  return {
    pedidoCode: pedido.code,
    canal: pedido.canal ?? null,
    mesa: pedido.mesa ?? null,
    referencia: pedido.referencia ?? null,
    moneda: moneda ?? pedido.moneda ?? null,
    empresa: emisor(empresa),
    lineas: items.map(linea),
    clientes: clientesDe(items),
    subtotal: venta === null ? null : dinero(venta),
    descuentos: dinero(items.reduce((n, i) => n + montoDescuento(i), 0)),
    promociones: dinero(items.reduce((n, i) => n + montoPromociones(i), 0)),
    propina: dinero(propina),
    total: total === null ? null : dinero(total),
    metodo: pago.metodo ?? null,
    recibido: pago.recibido ?? null,
    vuelto: vuelto === null ? null : dinero(vuelto),
    // ¿El cliente pidió factura? (5.86) { requerida, rucReferencia }; null si no se preguntó
    factura: pago.factura ?? null,
  };
}

/** Un documento `recibo` del motor → lo que devuelve la API. */
export function reciboDto(d) {
  const x = d.payload?.doc ?? {};
  return {
    code: d.code,
    tipo: "pago",
    pedidoCode: x.pedidoCode ?? null,
    emitidoTs: d.createdAt ?? null,
    emitidoPor: d.creadoPor ?? null,
    canal: x.canal ?? null,
    mesa: x.mesa ?? null,
    referencia: x.referencia ?? null,
    moneda: x.moneda ?? null,
    empresa: emisor(x.empresa),
    lineas: x.lineas ?? [],
    clientes: x.clientes ?? [],
    subtotal: x.subtotal ?? null,
    descuentos: x.descuentos ?? 0,
    promociones: x.promociones ?? 0,
    propina: x.propina ?? 0,
    total: x.total ?? null,
    metodo: x.metodo ?? null,
    metodoTexto: x.metodo ? METODOS_PAGO[x.metodo] ?? x.metodo : null,
    recibido: x.recibido ?? null,
    vuelto: x.vuelto ?? null,
    factura: x.factura ? { requerida: x.factura.requerida === true, rucReferencia: x.factura.rucReferencia ?? null } : null,
  };
}

/**
 * La cuenta (recibo de consumo) de un pedido: todo lo consumido (sin lo anulado), cuánto se cobró ya y cuánto falta.
 * `pedido` es el pedido completo (con `items`), `recibos` los recibos de pago ya emitidos (de `reciboDto`).
 */
export function armarCuenta({ pedido, recibos = [], empresa = null }) {
  const vivos = (pedido.items ?? []).filter((i) => i.estado !== "anulado");
  const total = sumar(vivos.map(subtotalC));
  const cobrado = sumar(vivos.filter((i) => i.estado === "pagado").map(subtotalC));
  const faltaC = sumar(vivos.filter((i) => i.estado !== "pagado").map(subtotalC));
  return {
    tipo: "consumo",
    pedidoCode: pedido.code,
    estadoPedido: pedido.estado,
    canal: pedido.canal ?? null,
    mesa: pedido.mesa ?? null,
    referencia: pedido.referencia ?? null,
    moneda: pedido.moneda ?? null,
    empresa: emisor(empresa),
    cliente: pedido.cliente ?? null,
    emitidoTs: pedido.creadoTs ?? null,
    lineas: vivos.map((i) => ({ ...linea(i), estado: i.estado, pagado: i.estado === "pagado" })),
    descuentos: dinero(vivos.reduce((n, i) => n + montoDescuento(i), 0)),
    promociones: dinero(vivos.reduce((n, i) => n + montoPromociones(i), 0)),
    total: total === null ? null : dinero(total),
    cobrado: cobrado === null ? null : dinero(cobrado),
    porCobrar: faltaC === null ? null : dinero(faltaC),
    propinas: dinero(recibos.reduce((n, r) => n + centavos(r.propina ?? 0), 0)),
    pagos: recibos.map((r) => ({ code: r.code, total: r.total, metodo: r.metodo, metodoTexto: r.metodoTexto, ts: r.emitidoTs })),
  };
}
