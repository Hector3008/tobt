// Recibos y cuenta en el front (5.32). Lógica pura: se valida lo mismo que el servidor para avisar antes de enviar;
// el servidor valida de verdad. Los recibos no son fiscales.

/** Formas de pago. El valor vacío es «sin indicar»: el cobro sigue como antes y el recibo no dice cómo se pagó. */
export const METODOS_PAGO = [
  ["efectivo", "Efectivo"],
  ["tarjeta", "Tarjeta"],
  ["yape", "Yape"],
  ["plin", "Plin"],
  ["transferencia", "Transferencia"],
  ["otro", "Otro"],
];

// `factura`: "no" | "si" — ¿el cliente va a pedir factura? (5.86). Con "si", `ruc` (RUC o referencia) es obligatorio.
export const PAGO_INICIAL = Object.freeze({ metodo: "", propina: "", recibido: "", factura: "no", ruc: "" });
export const MAX_RUC_REFERENCIA = 30;
const RE_RUC_REFERENCIA = /^[\p{L}\p{N}][\p{L}\p{N} .\-/]*$/u;
/** El RUC o referencia como se envía: sin espacios de más. */
export const limpiarRuc = (t) => String(t ?? "").trim().replace(/\s+/g, " ");

const aNumero = (t) => (String(t ?? "").trim() === "" ? null : Number(String(t).trim().replace(",", ".")));
const dosDecimales = (n) => Math.abs(Math.round(n * 100) / 100 - n) < 1e-9;

/** Lo que falla en el formulario de pago, o null si está bien. */
export function validarPagoForm(f) {
  if (f.factura === "si") {
    const ruc = limpiarRuc(f.ruc);
    if (!ruc) return "Escribe el RUC o la referencia para la factura.";
    if (ruc.length > MAX_RUC_REFERENCIA) return `El RUC o la referencia admite hasta ${MAX_RUC_REFERENCIA} caracteres.`;
    if (!RE_RUC_REFERENCIA.test(ruc)) return "El RUC o la referencia admite solo letras, números, espacios y . - /";
  }
  const propina = aNumero(f.propina);
  const recibido = aNumero(f.recibido);
  if (!f.metodo) {
    if (propina !== null || recibido !== null) return "Elige la forma de pago para anotar la propina o el efectivo recibido.";
    return null;
  }
  if (!METODOS_PAGO.some(([id]) => id === f.metodo)) return "Elige una forma de pago de la lista.";
  if (propina !== null && (!Number.isFinite(propina) || propina < 0 || !dosDecimales(propina))) return "La propina debe ser un número de 0 o más, con 2 decimales como máximo.";
  if (recibido !== null) {
    if (f.metodo !== "efectivo") return "El efectivo recibido solo se anota en un pago en efectivo.";
    if (!Number.isFinite(recibido) || recibido <= 0 || !dosDecimales(recibido)) return "El efectivo recibido debe ser un número mayor que 0, con 2 decimales como máximo.";
  }
  return null;
}

/**
 * El `pago` que se envía al cobrar. Siempre lleva la respuesta de la factura (5.86: «no» queda anotado); la forma de pago,
 * la propina y el efectivo solo si se indicaron. undefined si no hay formulario. Asume que el formulario ya es válido.
 */
export function cuerpoPago(f) {
  if (!f) return undefined;
  const factura = f.factura === "si" ? { factura: true, rucReferencia: limpiarRuc(f.ruc) } : { factura: false };
  if (!f.metodo) return factura;
  const propina = aNumero(f.propina);
  const recibido = f.metodo === "efectivo" ? aNumero(f.recibido) : null;
  return { metodo: f.metodo, ...(propina ? { propina } : {}), ...(recibido ? { recibido } : {}), ...factura };
}

/** «Sí · RUC / referencia: 20123456789» para el recibo, o "" si no se pidió factura (o el recibo es anterior a 5.86). */
export function textoFactura(r) {
  return r?.factura?.requerida ? `Sí · RUC / referencia: ${r.factura.rucReferencia ?? ""}` : "";
}

/** «21 oct 2026, 20:15» en hora local. Vacío si no hay fecha válida. */
export function formatoFechaHora(ts) {
  const d = new Date(ts);
  if (!ts || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** El título del documento: cada clase deja claro qué es y que no es fiscal. */
export const tituloRecibo = (r) => (r?.tipo === "pago" ? "Recibo de pago" : "Cuenta");
export const notaRecibo = (r) =>
  r?.tipo === "pago" ? "Documento no fiscal: no es una factura ni una boleta." : "Cuenta de consumo: no es un comprobante de pago.";

/** Lo que dice la línea del vale en un renglón: «Vale K7M2QX: −6,50». */
export const textoDescuentoLinea = (l, formato) => (l?.descuento ? `Vale ${l.descuento.vale}: −${formato(l.descuento.monto)}` : "");

/** Las promociones de un renglón: «Promo 2x1 en lattes: −12,00» (varias, separadas por « · »). Vacío si no hay. */
export const textoPromocionesLinea = (l, formato) =>
  (l?.promociones ?? []).map((p) => `Promo ${p.nombre}: −${formato(p.monto)}`).join(" · ");

/** Aviso tras cobrar: el recibo emitido o el problema. null si no se cobró nada nuevo. */
export function avisoRecibo(respuesta) {
  if (respuesta?.recibo?.code) return { code: respuesta.recibo.code };
  if (respuesta?.reciboError) return { error: true };
  return null;
}

/**
 * El encabezado impreso de un recibo o de una cuenta (5.34), línea por línea y sin las vacías.
 * La razón social solo se repite si es distinta del nombre comercial. Los recibos anteriores solo traen el nombre.
 */
export function encabezadoRecibo(r) {
  const e = r?.empresa;
  if (!e) return { nombre: "", lineas: [], pie: null, logo: null };
  const lineas = [];
  if (e.razonSocial && e.razonSocial.trim().toLowerCase() !== String(e.nombre ?? "").trim().toLowerCase()) lineas.push(e.razonSocial);
  if (e.idFiscal) lineas.push(`${e.etiquetaIdFiscal === "ID fiscal" ? "ID fiscal" : "RUC"}: ${e.idFiscal}`);
  if (e.direccion) lineas.push(e.direccion);
  if (e.telefono) lineas.push(`Tel: ${e.telefono}`);
  let logo = null;
  try {
    const u = new URL(e.logo ?? "");
    if (u.protocol === "https:" && !u.username && !u.password) logo = u.href;
  } catch {
    logo = null;
  }
  return { nombre: e.nombre ?? "", lineas, pie: e.pie || null, logo };
}
