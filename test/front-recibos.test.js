import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RUC_REFERENCIA, textoFactura, limpiarRuc, METODOS_PAGO, PAGO_INICIAL, avisoRecibo, encabezadoRecibo, cuerpoPago, formatoFechaHora, notaRecibo, textoDescuentoLinea, textoPromocionesLinea, tituloRecibo, validarPagoForm } from "../client/src/recibos.js";

test("formulario de pago: sin forma de pago no hay propina ni efectivo; con ella se valida", () => {
  assert.equal(validarPagoForm(PAGO_INICIAL), null);
  assert.match(validarPagoForm({ metodo: "", propina: "2", recibido: "" }), /forma de pago/);
  assert.match(validarPagoForm({ metodo: "", propina: "", recibido: "20" }), /forma de pago/);
  assert.equal(validarPagoForm({ metodo: "yape", propina: "", recibido: "" }), null);
  assert.equal(validarPagoForm({ metodo: "efectivo", propina: "1,50", recibido: "20" }), null);
  assert.match(validarPagoForm({ metodo: "yape", propina: "-1", recibido: "" }), /propina/);
  assert.match(validarPagoForm({ metodo: "yape", propina: "1,555", recibido: "" }), /propina/);
  assert.match(validarPagoForm({ metodo: "yape", propina: "abc", recibido: "" }), /propina/);
  assert.match(validarPagoForm({ metodo: "tarjeta", propina: "", recibido: "20" }), /efectivo/);
  assert.match(validarPagoForm({ metodo: "efectivo", propina: "", recibido: "0" }), /recibido/);
  assert.match(validarPagoForm({ metodo: "cripto", propina: "", recibido: "" }), /lista/);
  assert.equal(METODOS_PAGO.length, 6);
});

test("cuerpoPago arma el pago a enviar; siempre lleva la respuesta de la factura", () => {
  assert.deepEqual(cuerpoPago(PAGO_INICIAL), { factura: false });
  assert.equal(cuerpoPago(undefined), undefined);
  assert.deepEqual(cuerpoPago({ metodo: "yape", propina: "", recibido: "" }), { metodo: "yape", factura: false });
  assert.deepEqual(cuerpoPago({ metodo: "tarjeta", propina: "2,5", recibido: "" }), { metodo: "tarjeta", propina: 2.5, factura: false });
  assert.deepEqual(cuerpoPago({ metodo: "efectivo", propina: "1", recibido: "50" }), { metodo: "efectivo", propina: 1, recibido: 50, factura: false });
  assert.deepEqual(cuerpoPago({ metodo: "plin", propina: "0", recibido: "50" }), { metodo: "plin", factura: false }, "el recibido solo va con efectivo");
});

test("textos del recibo: título, nota no fiscal, descuento y fecha", () => {
  assert.equal(tituloRecibo({ tipo: "pago" }), "Recibo de pago");
  assert.equal(tituloRecibo({ tipo: "consumo" }), "Cuenta");
  assert.match(notaRecibo({ tipo: "pago" }), /no fiscal/);
  assert.match(notaRecibo({ tipo: "consumo" }), /no es un comprobante de pago/);
  assert.equal(textoDescuentoLinea({ descuento: { vale: "K7M2QX", monto: 6.5 } }, (v) => v.toFixed(2)), "Vale K7M2QX: −6.50");
  assert.equal(textoDescuentoLinea({ descuento: null }, String), "");
  assert.equal(formatoFechaHora(undefined), "");
  assert.equal(formatoFechaHora("no es fecha"), "");
  assert.match(formatoFechaHora("2026-10-17T20:15:00-05:00"), /2026/);
});

test("avisoRecibo: el recibo emitido, el error o nada", () => {
  assert.deepEqual(avisoRecibo({ recibo: { code: "RC-0000001" } }), { code: "RC-0000001" });
  assert.deepEqual(avisoRecibo({ reciboError: true }), { error: true });
  assert.equal(avisoRecibo({}), null);
  assert.equal(avisoRecibo(undefined), null);
});

test("encabezadoRecibo: nombre, líneas sin vacíos, razón social solo si es distinta, pie y logo https", () => {
  const e = { nombre: "Café Central", razonSocial: "Café Central SAC", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: "Av. 1", telefono: "999 111", pie: "Gracias", logo: "https://e.com/l.png" };
  assert.deepEqual(encabezadoRecibo({ empresa: e }), { nombre: "Café Central", lineas: ["Café Central SAC", "RUC: 20123456789", "Av. 1", "Tel: 999 111"], pie: "Gracias", logo: "https://e.com/l.png" });
  // misma razón social que el nombre: no se repite; otro país: «ID fiscal»
  assert.deepEqual(encabezadoRecibo({ empresa: { ...e, razonSocial: " café central ", etiquetaIdFiscal: "ID fiscal", direccion: null, telefono: null } }).lineas, ["ID fiscal: 20123456789"]);
  // un recibo anterior (solo con el nombre) y la ausencia de empresa no rompen
  assert.deepEqual(encabezadoRecibo({ empresa: { nombre: "Café" } }), { nombre: "Café", lineas: [], pie: null, logo: null });
  assert.deepEqual(encabezadoRecibo({}), { nombre: "", lineas: [], pie: null, logo: null });
  assert.deepEqual(encabezadoRecibo(null), { nombre: "", lineas: [], pie: null, logo: null });
  for (const logo of ["http://e.com/l.png", "javascript:alert(1)", "/l.png", "https://u:p@e.com/l.png", null]) assert.equal(encabezadoRecibo({ empresa: { ...e, logo } }).logo, null, String(logo));
});

test("textoPromocionesLinea: «Promo nombre: −monto», varias con « · », vacío si no hay (5.42)", () => {
  const f = (v) => v.toFixed(2);
  assert.equal(textoPromocionesLinea({ promociones: [{ nombre: "2x1 en lattes", monto: 10 }] }, f), "Promo 2x1 en lattes: −10.00");
  assert.equal(textoPromocionesLinea({ promociones: [{ nombre: "A", monto: 1 }, { nombre: "B", monto: 2 }] }, f), "Promo A: −1.00 · Promo B: −2.00");
  assert.equal(textoPromocionesLinea({ promociones: [] }, f), "");
  assert.equal(textoPromocionesLinea({}, f), "");
  assert.equal(textoPromocionesLinea(null, f), "");
});

test("factura en el cobro (5.86): se valida el RUC o referencia y se envía limpio", () => {
  assert.equal(validarPagoForm({ ...PAGO_INICIAL, factura: "si", ruc: "20123456789" }), null);
  assert.equal(validarPagoForm({ ...PAGO_INICIAL, metodo: "yape", factura: "si", ruc: "Mesa 4 / Juan-P." }), null);
  assert.match(validarPagoForm({ ...PAGO_INICIAL, factura: "si", ruc: "" }), /RUC o la referencia/);
  assert.match(validarPagoForm({ ...PAGO_INICIAL, factura: "si", ruc: "   " }), /Escribe el RUC/);
  assert.match(validarPagoForm({ ...PAGO_INICIAL, factura: "si", ruc: "x".repeat(MAX_RUC_REFERENCIA + 1) }), /hasta 30/);
  assert.match(validarPagoForm({ ...PAGO_INICIAL, factura: "si", ruc: "<b>1</b>" }), /solo letras/);
  assert.equal(validarPagoForm({ ...PAGO_INICIAL, factura: "no", ruc: "<b>1</b>" }), null, "con «no» el RUC se ignora");
  assert.deepEqual(cuerpoPago({ ...PAGO_INICIAL, factura: "si", ruc: "  20123456789 " }), { factura: true, rucReferencia: "20123456789" });
  assert.deepEqual(cuerpoPago({ ...PAGO_INICIAL, metodo: "yape", factura: "si", ruc: "20123456789" }), { metodo: "yape", factura: true, rucReferencia: "20123456789" });
  assert.deepEqual(cuerpoPago({ ...PAGO_INICIAL, factura: "no", ruc: "20123456789" }), { factura: false }, "con «no» no viaja el RUC");
  assert.equal(limpiarRuc("  a   b "), "a b");
  assert.equal(textoFactura({ factura: { requerida: true, rucReferencia: "20123456789" } }), "Sí · RUC / referencia: 20123456789");
  assert.equal(textoFactura({ factura: { requerida: false, rucReferencia: null } }), "");
  assert.equal(textoFactura({}), "");
});
