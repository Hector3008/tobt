import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ErrorPedido } from "../src/errores.js";
import { METODOS_PAGO, MAX_RUC_REFERENCIA, validarFactura, armarCuenta, armarRecibo, emisor, reciboDto, validarPago } from "../src/recibo.js";

const malo = (fn, re) => assert.throws(fn, (e) => e instanceof ErrorPedido && e.codigo === "DATOS_INVALIDOS" && (!re || re.test(e.message)));
const item = (code, nombre, cantidad, precio, extra = {}) => ({ code, nombre, codigo: nombre.toUpperCase(), cantidad, precio, subtotal: cantidad * precio, descuento: null, cliente: null, estado: "pagado", ...extra });
const pedido = { code: "PD-0000001", estado: "abierto", canal: "salon", mesa: "4", referencia: null, moneda: "PEN", cliente: null, creadoTs: "2026-10-17T20:00:00Z" };

describe("validarPago", () => {
  it("sin pago: método sin indicar y sin propina", () => {
    assert.deepEqual(validarPago(undefined), { metodo: null, propina: 0, recibido: null, factura: null });
    assert.deepEqual(validarPago(null), { metodo: null, propina: 0, recibido: null, factura: null });
  });
  it("método obligatorio y de la lista; propina opcional", () => {
    assert.deepEqual(validarPago({ metodo: "yape" }), { metodo: "yape", propina: 0, recibido: null, factura: null });
    assert.deepEqual(validarPago({ metodo: "tarjeta", propina: 2.5 }), { metodo: "tarjeta", propina: 2.5, recibido: null, factura: null });
    for (const m of Object.keys(METODOS_PAGO)) assert.equal(validarPago({ metodo: m }).metodo, m);
    malo(() => validarPago({}), /metodo/);
    malo(() => validarPago({ metodo: "cripto" }), /metodo/);
    malo(() => validarPago({ metodo: "Yape" }), /metodo/);
  });
  it("propina: 0 o más, 2 decimales, y no admite otros campos", () => {
    malo(() => validarPago({ metodo: "yape", propina: -1 }), /propina/);
    malo(() => validarPago({ metodo: "yape", propina: 1.555 }), /propina/);
    malo(() => validarPago({ metodo: "yape", propina: "2" }), /propina/);
    malo(() => validarPago({ metodo: "yape", propina: 2_000_000 }), /propina/);
    malo(() => validarPago({ metodo: "yape", otra: 1 }), /no admitidos/);
    malo(() => validarPago("yape"), /objeto/);
    malo(() => validarPago(["yape"]), /objeto/);
  });
  it("el efectivo recibido solo en efectivo, y tiene que alcanzar con la propina", () => {
    assert.deepEqual(validarPago({ metodo: "efectivo", recibido: 50 }, 3000), { metodo: "efectivo", propina: 0, recibido: 50, factura: null });
    assert.equal(validarPago({ metodo: "efectivo", recibido: 32, propina: 2 }, 3000).recibido, 32);
    malo(() => validarPago({ metodo: "efectivo", recibido: 31, propina: 2 }, 3000), /no alcanza \(faltan 1.00\)/);
    malo(() => validarPago({ metodo: "tarjeta", recibido: 50 }, 3000), /efectivo/);
    malo(() => validarPago({ metodo: "efectivo", recibido: 0 }, 3000), /recibido/);
    malo(() => validarPago({ metodo: "efectivo", recibido: 50 }, null), /sin precio/);
  });
});

describe("armarRecibo", () => {
  const items = [item("DOC_ITEM-1", "Café", 2, 6.5), item("DOC_ITEM-2", "Torta", 1, 5)];
  it("suma en centavos, agrega la propina y calcula el vuelto", () => {
    const r = armarRecibo({ pedido, items, pago: { metodo: "efectivo", propina: 1.1, recibido: 20 }, empresa: { nombre: "Café Central", slug: "x" } });
    assert.deepEqual([r.subtotal, r.propina, r.total, r.recibido, r.vuelto, r.descuentos], [18, 1.1, 19.1, 20, 0.9, 0]);
    assert.deepEqual(r.empresa, { nombre: "Café Central", razonSocial: null, idFiscal: null, etiquetaIdFiscal: "RUC", direccion: null, telefono: null, pie: null, logo: null });
    assert.equal(r.pedidoCode, "PD-0000001");
    assert.equal(r.moneda, "PEN");
    assert.deepEqual(r.lineas[0], { itemCode: "DOC_ITEM-1", nombre: "Café", codigo: "CAFÉ", cantidad: 2, precio: 6.5, subtotal: 13, descuento: null, promociones: [] });
  });
  it("sin pago: método null, propina 0, sin vuelto", () => {
    const r = armarRecibo({ pedido, items });
    assert.deepEqual([r.metodo, r.propina, r.total, r.recibido, r.vuelto, r.empresa], [null, 0, 18, null, null, null]);
  });
  it("un ítem sin precio deja los totales en null", () => {
    const r = armarRecibo({ pedido, items: [...items, item("DOC_ITEM-3", "Especial", 1, 0, { precio: null, subtotal: null })], pago: { metodo: "yape", propina: 1, recibido: null } });
    assert.deepEqual([r.subtotal, r.total, r.vuelto], [null, null, null]);
  });
  it("lleva el descuento de un vale y los clientes distintos de los ítems", () => {
    const con = item("DOC_ITEM-4", "Moka", 1, 8, { subtotal: 6, descuento: { vale: "K7M2QX", beneficio: "20%", monto: 2, subtotalAntes: 8 }, cliente: { id: "c1", nombre: "Ana" } });
    const otro = item("DOC_ITEM-5", "Flat", 1, 9, { cliente: { id: "c2", nombre: "Beto" } });
    const r = armarRecibo({ pedido, items: [con, otro, item("DOC_ITEM-6", "Té", 1, 3, { cliente: { id: "c1", nombre: "Ana" } })] });
    assert.deepEqual([r.subtotal, r.descuentos], [18, 2]);
    assert.deepEqual(r.clientes, [{ id: "c1", nombre: "Ana" }, { id: "c2", nombre: "Beto" }]);
    assert.deepEqual(r.lineas[0].descuento, { vale: "K7M2QX", beneficio: "20%", monto: 2 });
  });
});

describe("reciboDto", () => {
  it("devuelve el recibo guardado con el texto del método", () => {
    const doc = armarRecibo({ pedido, items: [item("DOC_ITEM-1", "Café", 1, 6.5)], pago: { metodo: "plin", propina: 0.5 } });
    const d = reciboDto({ code: "RC-0000007", createdAt: "2026-10-17T21:00:00Z", creadoPor: "u4", payload: { doc } });
    assert.deepEqual([d.code, d.tipo, d.metodo, d.metodoTexto, d.total, d.emitidoPor], ["RC-0000007", "pago", "plin", "Plin", 7, "u4"]);
    assert.equal(d.emitidoTs, "2026-10-17T21:00:00Z");
    assert.equal(reciboDto({ code: "RC-1", payload: {} }).metodoTexto, null);
    assert.deepEqual(reciboDto({ code: "RC-1", payload: {} }).lineas, []);
  });
});

describe("armarCuenta", () => {
  const items = [item("A", "Café", 1, 6.5), item("B", "Torta", 1, 5, { estado: "entregado" }), item("C", "Sándwich", 1, 12, { estado: "anulado" })];
  it("cuenta lo consumido sin lo anulado, lo cobrado y lo que falta", () => {
    const c = armarCuenta({ pedido: { ...pedido, items }, recibos: [{ code: "RC-1", total: 7, propina: 0.5, metodo: "yape", metodoTexto: "Yape", emitidoTs: "t" }], empresa: { nombre: "Café Central" } });
    assert.deepEqual([c.tipo, c.total, c.cobrado, c.porCobrar, c.propinas], ["consumo", 11.5, 6.5, 5, 0.5]);
    assert.deepEqual(c.lineas.map((l) => [l.nombre, l.pagado]), [["Café", true], ["Torta", false]]);
    assert.deepEqual(c.pagos, [{ code: "RC-1", total: 7, metodo: "yape", metodoTexto: "Yape", ts: "t" }]);
    assert.equal(c.empresa.nombre, "Café Central");
    assert.equal(c.mesa, "4");
  });
  it("pedido vacío o sin ítems no rompe", () => {
    const c = armarCuenta({ pedido: { ...pedido, items: [] } });
    assert.deepEqual([c.total, c.cobrado, c.porCobrar, c.lineas, c.pagos, c.empresa], [0, 0, 0, [], [], null]);
    assert.equal(armarCuenta({ pedido }).total, 0);
  });
});

describe("encabezado del recibo (5.34)", () => {
  it("emisor deja solo los campos del encabezado, con texto o null", () => {
    const e = emisor({ nombre: "Café Central", razonSocial: " Café Central SAC ", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: "Calle 1", telefono: "999", pie: "Gracias", logo: "https://e.com/l.png", otro: "x" });
    assert.deepEqual(e, { nombre: "Café Central", razonSocial: "Café Central SAC", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: "Calle 1", telefono: "999", pie: "Gracias", logo: "https://e.com/l.png" });
    assert.equal(emisor(null), null);
    assert.equal(emisor("x"), null);
    assert.deepEqual(emisor({ nombre: 5, pie: "   ", logo: 3, etiquetaIdFiscal: "otra" }), { nombre: "", razonSocial: null, idFiscal: null, etiquetaIdFiscal: "RUC", direccion: null, telefono: null, pie: null, logo: null });
  });
  it("el recibo guarda el encabezado que se le dio y la cuenta también", () => {
    const empresa = { nombre: "Café Central", razonSocial: "Café Central SAC", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: "Calle 1", telefono: "999", pie: "Gracias", logo: "https://e.com/l.png" };
    const pedido = { code: "PD-1", estado: "abierto", moneda: "PEN", items: [item("I1", "Café", 1, 6, { estado: "entregado" })] };
    assert.equal(armarRecibo({ pedido, items: pedido.items, empresa }).empresa.idFiscal, "20123456789");
    assert.equal(armarCuenta({ pedido, empresa }).empresa.direccion, "Calle 1");
  });
  it("un recibo anterior a 5.34 (solo con el nombre) se lee con el resto en null", () => {
    const d = reciboDto({ code: "RC-1", payload: { doc: { pedidoCode: "PD-1", empresa: { nombre: "Café Central" }, lineas: [] } } });
    assert.deepEqual(d.empresa, { nombre: "Café Central", razonSocial: null, idFiscal: null, etiquetaIdFiscal: "RUC", direccion: null, telefono: null, pie: null, logo: null });
    assert.equal(reciboDto({ code: "RC-2", payload: { doc: {} } }).empresa, null);
  });
});

describe("factura en el cobro (5.86)", () => {
  it("sin declarar nada, no hay factura; con «no», queda anotado que no", () => {
    assert.equal(validarFactura(undefined, undefined), null);
    assert.deepEqual(validarFactura(false), { requerida: false, rucReferencia: null });
    assert.deepEqual(validarFactura(false, ""), { requerida: false, rucReferencia: null });
    assert.equal(validarPago({ metodo: "yape" }).factura, null);
  });
  it("con «sí», el RUC o referencia es obligatorio, se limpia y se limita", () => {
    assert.deepEqual(validarFactura(true, "  20123456789 "), { requerida: true, rucReferencia: "20123456789" });
    assert.deepEqual(validarFactura(true, "Mesa 4  /  Juan-P."), { requerida: true, rucReferencia: "Mesa 4 / Juan-P." });
    malo(() => validarFactura(true), /obligatorio/);
    malo(() => validarFactura(true, "   "), /obligatorio/);
    malo(() => validarFactura(true, "x".repeat(MAX_RUC_REFERENCIA + 1)), /hasta 30/);
    malo(() => validarFactura(true, "20123; DROP"), /solo letras/);
    malo(() => validarFactura(true, "<b>1</b>"), /solo letras/);
    malo(() => validarFactura(true, 20123456789), /obligatorio/);
  });
  it("el RUC no se admite sin pedir factura, y `factura` es booleano", () => {
    malo(() => validarFactura(false, "20123456789"), /solo se anota si se pide factura/);
    malo(() => validarFactura(undefined, "20123456789"), /solo se anota si se pide factura/);
    malo(() => validarFactura("si", "1"), /true o false/);
    malo(() => validarFactura(1, "1"), /true o false/);
  });
  it("dentro del pago: con método, y sin método solo si lo único que se declara es la factura", () => {
    assert.deepEqual(validarPago({ metodo: "yape", factura: true, rucReferencia: "20123456789" }), { metodo: "yape", propina: 0, recibido: null, factura: { requerida: true, rucReferencia: "20123456789" } });
    assert.deepEqual(validarPago({ factura: true, rucReferencia: "20123456789" }), { metodo: null, propina: 0, recibido: null, factura: { requerida: true, rucReferencia: "20123456789" } });
    assert.deepEqual(validarPago({ factura: false }), { metodo: null, propina: 0, recibido: null, factura: { requerida: false, rucReferencia: null } });
    malo(() => validarPago({ factura: true, rucReferencia: "1", propina: 2 }), /metodo/);
    malo(() => validarPago({ factura: true }), /obligatorio/);
    malo(() => validarPago({ metodo: "yape", factura: true }), /obligatorio/);
  });
  it("queda en el recibo y en su DTO; los recibos anteriores no la traen", () => {
    const items = [item("DOC_ITEM-1", "Café", 2, 6.5)];
    const r = armarRecibo({ pedido, items, pago: validarPago({ metodo: "yape", factura: true, rucReferencia: "20123456789" }) });
    assert.deepEqual(r.factura, { requerida: true, rucReferencia: "20123456789" });
    assert.equal(armarRecibo({ pedido, items }).factura, null);
    assert.deepEqual(reciboDto({ code: "RC-1", payload: { doc: r } }).factura, { requerida: true, rucReferencia: "20123456789" });
    assert.equal(reciboDto({ code: "RC-0", payload: { doc: { total: 1 } } }).factura, null);
  });
});
