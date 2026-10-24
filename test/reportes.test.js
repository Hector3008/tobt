import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Aggregator } from "mingo";
import { conEmpresa, empresaActual, permite } from "core";
import {
  crearReportes, validarConsulta, zonaDe, partesDeFecha, fechaLocal, inicioDelDia, sumarDias, diasEntre,
  claveSemana, lunesDe, claveDe, cubetasDelRango, plegar, MAX_DIAS,
} from "../src/reportes.js";
import { montarRutas } from "../src/http.js";

// La agregación se ejecuta de verdad con `mingo` (un intérprete de pipelines de MongoDB) sobre documentos con la
// forma real de `documentos`: así se comprueba el pipeline y no solo la forma de la respuesta. Lo que mingo no
// garantiza (índices, rendimiento, límites de memoria) solo se ve contra MongoDB real.

const ms = (iso) => new Date(iso).getTime();

describe("reportes: fechas y zonas", () => {
  it("la zona sale del país de la empresa; sin país es Perú; un país desconocido agrupa en UTC", () => {
    assert.equal(zonaDe({ pais: "PE" }), "America/Lima");
    assert.equal(zonaDe({}), "America/Lima");
    assert.equal(zonaDe(null), "America/Lima");
    assert.equal(zonaDe({ pais: "ar" }), "America/Argentina/Buenos_Aires");
    assert.equal(zonaDe({ pais: "JP" }), "UTC");
  });

  it("partesDeFecha rechaza fechas que no existen", () => {
    assert.deepEqual(partesDeFecha("2026-10-20"), { y: 2026, m: 10, d: 20 });
    for (const malo of ["2026-02-30", "2026-13-01", "2026-1-1", "20/10/2026", "", null, undefined, "2026-10-20T00:00"])
      assert.equal(partesDeFecha(malo), null, String(malo));
    assert.notEqual(partesDeFecha("2028-02-29"), null, "2028 es bisiesto");
    assert.equal(partesDeFecha("2027-02-29"), null);
  });

  it("inicioDelDia: Lima no cambia de hora; Nueva York y Madrid sí (días de 23 y 25 horas)", () => {
    assert.equal(new Date(inicioDelDia("2026-10-20", "America/Lima")).toISOString(), "2026-10-20T05:00:00.000Z");
    assert.equal(new Date(inicioDelDia("2026-10-20", "UTC")).toISOString(), "2026-10-20T00:00:00.000Z");
    assert.equal(new Date(inicioDelDia("2026-03-08", "America/New_York")).toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(new Date(inicioDelDia("2026-03-09", "America/New_York")).toISOString(), "2026-03-09T04:00:00.000Z");
    assert.equal(new Date(inicioDelDia("2026-10-25", "Europe/Madrid")).toISOString(), "2026-10-24T22:00:00.000Z");
    assert.equal(new Date(inicioDelDia("2026-10-26", "Europe/Madrid")).toISOString(), "2026-10-25T23:00:00.000Z");
  });

  it("fechaLocal: el mismo instante cae en otro día según la zona", () => {
    assert.equal(fechaLocal(ms("2026-10-20T04:59:59Z"), "America/Lima"), "2026-10-19");
    assert.equal(fechaLocal(ms("2026-10-20T05:00:00Z"), "America/Lima"), "2026-10-20");
    assert.equal(fechaLocal(ms("2026-10-20T04:59:59Z"), "UTC"), "2026-10-20");
  });

  it("sumarDias y diasEntre cruzan meses, años y bisiestos", () => {
    assert.equal(sumarDias("2026-12-31", 1), "2027-01-01");
    assert.equal(sumarDias("2028-03-01", -1), "2028-02-29");
    assert.equal(sumarDias("2026-10-20", -29), "2026-09-21");
    assert.equal(diasEntre("2026-10-19", "2026-10-21"), 2);
    assert.equal(diasEntre("2026-10-21", "2026-10-19"), -2);
  });

  it("la semana ISO: el número coincide con `%V` de MongoDB y el año es el del jueves, en todos los días de tres años", () => {
    const fechas = [];
    for (let f = "2024-12-20"; diasEntre(f, "2027-01-10") >= 0; f = sumarDias(f, 1)) fechas.push(f);
    const docs = fechas.map((f) => ({ f, t: new Date(`${f}T12:00:00Z`) }));
    const r = new Aggregator([{ $project: { f: 1, v: { $dateToString: { format: "%V", date: "$t" } } } }]).run(docs);
    assert.equal(r.length, fechas.length);
    for (const x of r) {
      assert.equal(claveSemana(x.f).slice(-2), x.v, `${x.f}: número de semana`);
      // El año ISO es el del jueves de la misma semana (lunes a domingo)
      const jueves = sumarDias(lunesDe(x.f), 3);
      assert.equal(claveSemana(x.f).slice(0, 4), jueves.slice(0, 4), `${x.f}: año ISO`);
    }
  });

  it("semanas ISO conocidas: la 1 de 2025 empieza el lunes 30 de diciembre de 2024; 2026 tiene 53", () => {
    const esperado = {
      "2024-12-29": "2024-W52", "2024-12-30": "2025-W01", "2025-01-05": "2025-W01", "2025-01-06": "2025-W02",
      "2026-01-01": "2026-W01", "2026-10-19": "2026-W43", "2026-12-31": "2026-W53", "2027-01-01": "2026-W53", "2027-01-04": "2027-W01",
    };
    for (const [f, k] of Object.entries(esperado)) assert.equal(claveSemana(f), k, f);
  });

  it("lunesDe y claveDe", () => {
    assert.equal(lunesDe("2026-10-20"), "2026-10-19");
    assert.equal(lunesDe("2026-10-19"), "2026-10-19");
    assert.equal(lunesDe("2026-10-25"), "2026-10-19");
    assert.equal(lunesDe("2027-01-01"), "2026-12-28");
    assert.equal(claveDe("2026-10-20", "mes"), "2026-10");
    assert.equal(claveDe("2026-10-20", "dia"), "2026-10-20");
  });

  it("cubetasDelRango rellena los días sin ventas y agrupa por semana y mes", () => {
    assert.deepEqual(cubetasDelRango("2026-10-19", "2026-10-21", "dia").map((c) => c.clave), ["2026-10-19", "2026-10-20", "2026-10-21"]);
    const sem = cubetasDelRango("2026-10-14", "2026-10-27", "semana");
    assert.deepEqual(sem.map((c) => c.clave), ["2026-W42", "2026-W43", "2026-W44"]);
    assert.deepEqual(sem.map((c) => c.inicio), ["2026-10-12", "2026-10-19", "2026-10-26"], "cada semana se rotula con su lunes");
    const mes = cubetasDelRango("2026-09-30", "2026-11-02", "mes");
    assert.deepEqual(mes.map((c) => [c.clave, c.inicio]), [["2026-09", "2026-09-01"], ["2026-10", "2026-10-01"], ["2026-11", "2026-11-01"]]);
  });
});

describe("reportes: validar la consulta", () => {
  const zona = "America/Lima";
  const ahora = ms("2026-10-20T08:00:00Z"); // martes 20, 03:00 en Lima
  const v = (q) => validarConsulta(q, { zona, ahora });
  const rechaza = (q, texto) => assert.throws(() => v(q), (e) => e.codigo === "DATOS_INVALIDOS" && e.status === 400 && texto.test(e.message), JSON.stringify(q));

  it("sin nada pide los últimos 30 días terminando hoy (hoy según la empresa, no según UTC)", () => {
    const c = v({});
    assert.deepEqual([c.desde, c.hasta, c.gran, c.dias], ["2026-09-21", "2026-10-20", "dia", 30]);
    assert.equal(c.desdeTs.toISOString(), "2026-09-21T05:00:00.000Z");
    assert.equal(c.hastaTs.toISOString(), "2026-10-21T05:00:00.000Z", "el límite superior es el comienzo del día siguiente (exclusivo)");
    // 02:00 UTC del 21 todavía es el 20 en Lima
    assert.equal(validarConsulta({}, { zona, ahora: ms("2026-10-21T02:00:00Z") }).hasta, "2026-10-20");
  });

  it("acepta un rango, una sola fecha y cadenas vacías como ausentes", () => {
    assert.equal(v({ desde: "2026-10-19", hasta: "2026-10-21", gran: "semana" }).dias, 3);
    assert.equal(v({ desde: "2026-10-20", hasta: "2026-10-20" }).dias, 1);
    assert.deepEqual([v({ desde: "", hasta: "", gran: "" }).dias, v({ gran: "" }).gran], [30, "dia"]);
    assert.equal(v({ hasta: "2026-10-10" }).desde, "2026-09-11", "solo hasta: 30 días hacia atrás");
  });

  it("`dias` fija cuántos días terminan en hoy (o en `hasta`); `desde` manda sobre `dias`", () => {
    assert.deepEqual([v({ dias: "7" }).desde, v({ dias: "7" }).hasta, v({ dias: 7 }).dias], ["2026-10-14", "2026-10-20", 7]);
    assert.deepEqual([v({ dias: "1" }).desde, v({ dias: "1" }).hasta], ["2026-10-20", "2026-10-20"]);
    assert.equal(v({ dias: "10", hasta: "2026-10-10" }).desde, "2026-10-01");
    assert.equal(v({ dias: "7", desde: "2026-10-01", hasta: "2026-10-03" }).dias, 3);
    assert.equal(v({ dias: "366" }).dias, 366);
  });

  it("rechaza fechas mal escritas o inexistentes, rangos al revés, demasiado largos y granularidades desconocidas", () => {
    rechaza({ desde: "2026-02-30" }, /desde/);
    rechaza({ hasta: "ayer" }, /hasta/);
    rechaza({ desde: "2026-10-21", hasta: "2026-10-20" }, /posterior/);
    rechaza({ desde: "2025-01-01", hasta: "2026-10-20" }, new RegExp(String(MAX_DIAS)));
    rechaza({ gran: "hora" }, /gran/);
    for (const malo of ["0", "-3", "1.5", "abc", "367", "1e3"]) rechaza({ dias: malo }, /dias/);
    assert.equal(v({ desde: "2025-10-20", hasta: "2026-10-20" }).dias, 366, "366 días justos sí");
  });
});

describe("reportes: plegar", () => {
  const filas = Array.from({ length: 12 }, (_, i) => ({ nombre: `C${i}`, ventas: 100 - i, items: 1 }));
  it("deja N-1 y suma el resto en «Otros» sin perder importe", () => {
    const r = plegar(filas, 8);
    assert.equal(r.length, 8);
    assert.deepEqual(r.slice(0, 7).map((x) => x.nombre), ["C0", "C1", "C2", "C3", "C4", "C5", "C6"]);
    const otros = r[7];
    assert.equal(otros.nombre, "Otros");
    assert.equal(otros.otros, true);
    assert.equal(otros.items, 5);
    assert.equal(r.reduce((n, x) => n + x.ventas, 0), filas.reduce((n, x) => n + x.ventas, 0));
  });
  it("no toca una lista que ya cabe", () => {
    assert.deepEqual(plegar(filas.slice(0, 8), 8), filas.slice(0, 8));
  });
});

// ---------- el servicio contra la agregación real (mingo) ----------

function item({ code, empresaId = "e1", estado = "pagado", pedido = "PD-0000001", cantidad = 1, subtotal, nombre, codigo, categoria, cliente, pagadoPor = "u1", sistema = false, pagadoTs, origen = "catalogo", promociones }) {
  const historial = [{ de: null, a: "en_cocina", usuarioId: "u1", ts: new Date("2026-10-01T10:00:00Z") }];
  if (estado === "pagado") historial.push({ de: "entregado", a: "pagado", usuarioId: sistema ? null : pagadoPor, sistema, ts: new Date(pagadoTs) });
  if (estado === "anulado") historial.push({ de: "en_cocina", a: "anulado", usuarioId: "u1", ts: new Date("2026-10-20T15:00:00Z") });
  return {
    empresaId, tipo: "doc_item", code, estado,
    payload: { doc: { pedidoCode: pedido, cantidad, subtotal, moneda: "PEN", ...(promociones ? { promociones } : {}) } },
    snapshot: { item: { origen, codigo: codigo ?? null, nombre, categoria: categoria ?? null }, ...(cliente ? { cliente } : {}) },
    historial,
  };
}
const pedidoDoc = (code, canal, empresaId = "e1") => ({ empresaId, tipo: "pedido", code, estado: "pagado", payload: { doc: { canal } } });
const recibo = (code, metodo, subtotal, propina, createdAt, empresaId = "e1") => ({ empresaId, tipo: "recibo", code, estado: "emitido", createdAt: new Date(createdAt), payload: { doc: { metodo, subtotal, propina } } });

// Semana del lunes 19 al domingo 25 de octubre de 2026. En Lima, 05:00Z es la medianoche.
function datos() {
  return [
    // Lunes 19, 22:30 en Lima (ya es martes en UTC): es venta del 19
    item({ code: "DOC_ITEM-1", cantidad: 2, subtotal: 13, nombre: "Latte", codigo: "LATTE", categoria: "Cafés", cliente: { clienteId: "c1", nombre: "Ana" }, pagadoPor: "u1", pagadoTs: "2026-10-20T03:30:00Z" }),
    // Martes 20, 10:00
    item({ code: "DOC_ITEM-2", subtotal: 5, nombre: "Moka", codigo: "MOKA", categoria: "Cafés", pagadoPor: "u2", pagadoTs: "2026-10-20T15:00:00Z" }),
    // Martes 20, 20:00: línea libre, la cobró el sistema, otro pedido (delivery) y otro cliente
    item({ code: "DOC_ITEM-3", pedido: "PD-0000002", subtotal: 8, nombre: "Torta casera", origen: "libre", cliente: { clienteId: "c2", nombre: "Beto" }, sistema: true, pagadoTs: "2026-10-21T01:00:00Z" }),
    // No cuentan: anulado, en cocina, cobrado fuera del rango y cobrado en otra empresa
    item({ code: "DOC_ITEM-4", estado: "anulado", subtotal: 99, nombre: "Anulado", codigo: "X", categoria: "Cafés" }),
    item({ code: "DOC_ITEM-5", estado: "en_cocina", subtotal: 99, nombre: "En cocina", codigo: "X", categoria: "Cafés" }),
    item({ code: "DOC_ITEM-6", subtotal: 99, nombre: "Septiembre", codigo: "X", categoria: "Cafés", pagadoTs: "2026-09-01T15:00:00Z" }),
    item({ code: "DOC_ITEM-7", empresaId: "e2", pedido: "PD-0000001", subtotal: 99, nombre: "Otra empresa", codigo: "X", categoria: "Cafés", pagadoTs: "2026-10-20T15:00:00Z" }),
    pedidoDoc("PD-0000001", "salon"),
    pedidoDoc("PD-0000002", "delivery"),
    pedidoDoc("PD-0000001", "llevar", "e2"), // mismo código en otra empresa: no debe confundirse
    recibo("RC-0000001", "yape", 13, 1, "2026-10-20T04:00:00Z"),
    recibo("RC-0000002", "efectivo", 5, 0.5, "2026-10-20T15:05:00Z"),
    recibo("RC-0000003", null, 8, 0, "2026-10-21T01:05:00Z"),
    recibo("RC-0000004", "tarjeta", 99, 9, "2026-09-01T15:00:00Z"), // fuera del rango
    recibo("RC-0000005", "tarjeta", 99, 9, "2026-10-20T15:05:00Z", "e2"),
  ];
}

// Un «Documento» que hace lo que el plugin de multiempresa: antepone el filtro de la empresa activa.
function modelosFalsos(docs, { pais = "PE", moneda = "PEN" } = {}) {
  const usuarios = [
    { _id: "u1", nombre: "Luz Mesera", correo: "luz@x.com" },
    { _id: "u2", nombre: "", correo: "pablo@x.com" },
  ];
  const consultas = [];
  return {
    consultas,
    Documento: {
      async aggregate(pipeline) {
        const empresaId = empresaActual();
        assert.ok(empresaId, "el reporte debe correr dentro de la empresa activa (conEmpresa)");
        consultas.push(pipeline);
        return new Aggregator([{ $match: { empresaId } }, ...pipeline], { collectionResolver: () => docs }).run(docs);
      },
    },
    Empresa: { findById: (id) => ({ lean: async () => ({ _id: id, pais, moneda }) }) },
    Usuario: {
      find: (f) => ({
        select: () => ({ lean: async () => usuarios.filter((u) => f._id.$in.includes(u._id)) }),
      }),
    },
  };
}

const ADMIN = { usuarioId: "u1", permisos: ["*"] };
const AHORA = ms("2026-10-21T14:00:00Z");
const servicio = (docs, opciones) => {
  const modelos = modelosFalsos(docs, opciones);
  return { modelos, svc: crearReportes({ conEmpresa, permite, modelos, ahora: () => AHORA }) };
};
const consulta = { empresaId: "e1", actor: ADMIN, desde: "2026-10-19", hasta: "2026-10-21" };

describe("reportes: ventas (agregación real con mingo)", () => {
  let r;
  before(async () => {
    r = await servicio(datos()).svc.ventas(consulta);
  });

  it("cuenta solo lo cobrado, de esta empresa y dentro del rango", () => {
    assert.equal(r.resumen.ventas, 26);
    assert.equal(r.resumen.items, 3);
    assert.equal(r.resumen.unidades, 4);
    assert.equal(r.resumen.pedidos, 2);
    assert.equal(r.resumen.ticketPromedio, 13);
    assert.deepEqual([r.desde, r.hasta, r.gran, r.dias, r.zona, r.moneda], ["2026-10-19", "2026-10-21", "dia", 3, "America/Lima", "PEN"]);
  });

  it("agrupa por día en la zona de la empresa (22:30 del lunes en Lima es lunes, no martes) y rellena días vacíos", () => {
    assert.deepEqual(r.serie.map((s) => [s.clave, s.ventas, s.items]), [["2026-10-19", 13, 1], ["2026-10-20", 13, 2], ["2026-10-21", 0, 0]]);
  });

  it("por semana y por mes: una sola cubeta con todo", async () => {
    const sem = await servicio(datos()).svc.ventas({ ...consulta, gran: "semana" });
    assert.deepEqual(sem.serie.map((s) => [s.clave, s.inicio, s.ventas]), [["2026-W43", "2026-10-19", 26]]);
    const mes = await servicio(datos()).svc.ventas({ ...consulta, gran: "mes" });
    assert.deepEqual(mes.serie.map((s) => [s.clave, s.ventas]), [["2026-10", 26]]);
  });

  it("la serie suma siempre el total, en día, semana y mes, también cuando el rango cruza semanas y meses", async () => {
    const docs = [];
    // Un cobro por día entre el 25 de dic de 2024 y el 5 de ene de 2025: cruza el año ISO (30 dic = 2025-W01)
    for (let f = "2024-12-25", i = 0; diasEntre(f, "2025-01-05") >= 0; f = sumarDias(f, 1), i++)
      docs.push(item({ code: `DOC_ITEM-${i}`, subtotal: i + 1, nombre: "a", codigo: "A", categoria: "k", pagadoTs: `${f}T15:00:00Z` }));
    const total = docs.reduce((n, d) => n + d.payload.doc.subtotal, 0);
    for (const gran of ["dia", "semana", "mes"]) {
      const x = await servicio(docs).svc.ventas({ ...consulta, desde: "2024-12-25", hasta: "2025-01-05", gran });
      assert.equal(x.resumen.ventas, total, gran);
      assert.equal(Math.round(x.serie.reduce((n, s) => n + s.ventas, 0) * 100) / 100, total, `serie ${gran}`);
      assert.equal(x.serie.reduce((n, s) => n + s.items, 0), docs.length, `items ${gran}`);
    }
    const sem = await servicio(docs).svc.ventas({ ...consulta, desde: "2024-12-25", hasta: "2025-01-05", gran: "semana" });
    assert.deepEqual(sem.serie.map((s) => s.clave), ["2024-W52", "2025-W01"]);
    const mes = await servicio(docs).svc.ventas({ ...consulta, desde: "2024-12-25", hasta: "2025-01-05", gran: "mes" });
    assert.deepEqual(mes.serie.map((s) => s.clave), ["2024-12", "2025-01"]);
  });

  it("por categoría, con «Sin categoría» y el porcentaje", () => {
    assert.deepEqual(r.categorias.map((c) => [c.nombre, c.ventas, c.porcentaje, c.sinCategoria]), [["Cafés", 18, 69.2, false], ["Sin categoría", 8, 30.8, true]]);
  });

  it("por mesero: quien cobra; lo cobrado por el sistema queda «sin atribuir» y los nombres salen de los usuarios", () => {
    assert.deepEqual(
      r.meseros.map((m) => [m.id, m.nombre, m.ventas, m.items, m.pedidos, m.sinAtribuir]),
      [["u1", "Luz Mesera", 13, 1, 1, false], [null, "Sin atribuir", 8, 1, 1, true], ["u2", "pablo@x.com", 5, 1, 1, false]],
    );
  });

  it("por cliente: los mejores, los que no tienen cliente y que todo cuadre con el total", () => {
    assert.deepEqual(r.clientes.top.map((c) => [c.id, c.nombre, c.ventas]), [["c1", "Ana", 13], ["c2", "Beto", 8]]);
    assert.deepEqual([r.clientes.sinCliente.ventas, r.clientes.sinCliente.items], [5, 1]);
    assert.equal(r.clientes.otros, null);
    const suma = r.clientes.top.reduce((n, c) => n + c.ventas, 0) + r.clientes.sinCliente.ventas + (r.clientes.otros?.ventas ?? 0);
    assert.equal(suma, r.resumen.ventas);
  });

  it("platos más vendidos: por cantidad, desempate por importe, la línea libre sin código", () => {
    assert.deepEqual(r.platos.map((p) => [p.nombre, p.codigo, p.cantidad, p.ventas]), [["Latte", "LATTE", 2, 13], ["Torta casera", null, 1, 8], ["Moka", "MOKA", 1, 5]]);
  });

  it("horas pico: siempre 7 × 24 celdas, lunes = 1, hora local de la empresa", () => {
    assert.equal(r.horas.length, 168);
    const con = r.horas.filter((h) => h.items > 0).map((h) => [h.dia, h.hora, h.ventas]);
    assert.deepEqual(con, [[1, 22, 13], [2, 10, 5], [2, 20, 8]]);
    assert.deepEqual([r.horas[0].dia, r.horas[0].hora, r.horas[167].dia, r.horas[167].hora], [1, 0, 7, 23]);
  });

  it("canales: el del pedido, sin mezclar el mismo código de otra empresa", () => {
    assert.deepEqual(r.canales.map((c) => [c.canal, c.ventas]), [["salon", 18], ["delivery", 8]]);
  });

  it("propinas y formas de pago salen de los recibos del rango y de esta empresa", () => {
    assert.deepEqual(r.pagos.map((p) => [p.metodo, p.metodoTexto, p.cobrado, p.propinas]), [["yape", "Yape", 13, 1], [null, "Sin indicar", 8, 0], ["efectivo", "Efectivo", 5, 0.5]]);
    assert.equal(r.resumen.propinas, 1.5);
    assert.equal(r.resumen.recibos, 3);
  });
});

describe("reportes: promociones (5.43)", () => {
  const T = "2026-10-20T15:00:00Z";
  const promo = (id, nombre, monto, unidades = 1) => ({ id, nombre, monto, unidades });
  const docs = () => [
    // 2×1: dos lattes de 10; uno sale gratis. El ítem pagó 10 en vez de 20 (ahorro 10)
    item({ code: "DOC_ITEM-1", cantidad: 1, subtotal: 0, nombre: "Latte", codigo: "LATTE", categoria: "Cafés", pagadoTs: T, promociones: [promo("p-2x1", "2×1 en lattes", 10)] }),
    item({ code: "DOC_ITEM-2", cantidad: 1, subtotal: 10, nombre: "Latte", codigo: "LATTE", categoria: "Cafés", pagadoTs: T }),
    // un ítem con dos promociones distintas
    item({ code: "DOC_ITEM-3", cantidad: 1, subtotal: 6, nombre: "Torta", codigo: "TORTA", categoria: "Postres", pagadoTs: T, promociones: [promo("p-2x1", "2×1 en lattes (renombrada)", 2.5), promo("p-torta", "Torta 10 %", 1.5)] }),
    // sin promociones y de antes de 5.42 (sin el campo)
    item({ code: "DOC_ITEM-4", subtotal: 4, nombre: "Moka", codigo: "MOKA", categoria: "Cafés", pagadoTs: T }),
    item({ code: "DOC_ITEM-5", subtotal: 3, nombre: "Té", codigo: "TE", categoria: "Cafés", pagadoTs: T, promociones: [] }),
    // no cuentan: anulado, en cocina, otra empresa, fuera del rango
    item({ code: "DOC_ITEM-6", estado: "anulado", subtotal: 0, nombre: "A", codigo: "A", promociones: [promo("p-anulada", "Anulada", 50)] }),
    item({ code: "DOC_ITEM-7", estado: "en_cocina", subtotal: 0, nombre: "B", codigo: "B", promociones: [promo("p-cocina", "En cocina", 50)] }),
    item({ code: "DOC_ITEM-8", empresaId: "e2", subtotal: 0, nombre: "C", codigo: "C", pagadoTs: T, promociones: [promo("p-otra", "Otra empresa", 50)] }),
    item({ code: "DOC_ITEM-9", subtotal: 0, nombre: "D", codigo: "D", pagadoTs: "2026-09-01T15:00:00Z", promociones: [promo("p-vieja", "Septiembre", 50)] }),
    pedidoDoc("PD-0000001", "salon"),
  ];

  it("suma lo descontado por promoción, con el nombre más reciente y ordenado por ahorro", async () => {
    const { promociones: p } = await servicio(docs()).svc.ventas(consulta);
    assert.deepEqual(p.porPromocion.map((x) => [x.id, x.ahorro, x.items, x.unidades]), [["p-2x1", 12.5, 2, 2], ["p-torta", 1.5, 1, 1]]);
    assert.equal(p.porPromocion[0].nombre, "2×1 en lattes (renombrada)"); // el nombre guardado en el ítem cobrado más reciente
    assert.deepEqual(p.porPromocion.map((x) => x.porcentaje), [89.3, 10.7]);
  });

  it("el ahorro total, lo que habría sido sin promociones y su porcentaje", async () => {
    const r = await servicio(docs()).svc.ventas(consulta);
    assert.equal(r.resumen.ventas, 23); // 0 + 10 + 6 + 4 + 3: lo cobrado ya trae los descuentos
    assert.equal(r.promociones.ahorro, 14);
    assert.equal(r.promociones.ventasAntes, 37);
    assert.equal(r.promociones.porcentaje, 37.8);
    assert.equal(r.promociones.items, 3); // entradas de promoción (el ítem 3 tiene dos)
    assert.equal(r.promociones.otras, null);
  });

  it("sin promociones: ceros, sin dividir por cero", async () => {
    for (const d of [[], datos()]) {
      const { promociones: p, resumen } = await servicio(d).svc.ventas(consulta);
      assert.deepEqual([p.ahorro, p.porcentaje, p.items, p.porPromocion.length, p.otras], [0, 0, 0, 0, null]);
      assert.equal(p.ventasAntes, resumen.ventas);
    }
  });

  it("más de 8 promociones: se listan las 8 con más ahorro y el resto va en «otras», sin perder el total", async () => {
    const muchas = Array.from({ length: 11 }, (_, i) =>
      item({ code: `DOC_ITEM-${i + 1}`, subtotal: 5, nombre: "X", codigo: "X", pagadoTs: T, promociones: [promo(`p${i}`, `Promo ${i}`, 11 - i)] }));
    const { promociones: p } = await servicio(muchas).svc.ventas(consulta);
    assert.equal(p.porPromocion.length, 8);
    assert.deepEqual(p.otras, { cantidad: 3, ahorro: 6, items: 3 }); // 3 + 2 + 1
    assert.equal(p.ahorro, 66);
    assert.equal(p.porPromocion.reduce((n, x) => n + x.ahorro, 0) + p.otras.ahorro, p.ahorro);
  });

  it("no mezcla empresas ni cuenta anulados, abiertos o fuera del rango (ya probado arriba con ids propios)", async () => {
    const { promociones: p } = await servicio(docs()).svc.ventas(consulta);
    const ids = p.porPromocion.map((x) => x.id);
    for (const mal of ["p-anulada", "p-cocina", "p-otra", "p-vieja"]) assert.equal(ids.includes(mal), false, mal);
  });
});

describe("reportes: casos de borde", () => {
  it("sin ventas: ceros, ticket promedio null, series completas y sin dividir por cero", async () => {
    const r = await servicio([]).svc.ventas(consulta);
    assert.deepEqual([r.resumen.ventas, r.resumen.items, r.resumen.pedidos, r.resumen.ticketPromedio, r.resumen.propinas], [0, 0, 0, null, 0]);
    assert.equal(r.serie.length, 3);
    assert.ok(r.serie.every((s) => s.ventas === 0));
    assert.equal(r.horas.length, 168);
    assert.deepEqual([r.categorias, r.meseros, r.platos, r.canales, r.pagos], [[], [], [], [], []]);
    assert.deepEqual(r.clientes, { top: [], otros: null, sinCliente: { ventas: 0, items: 0, porcentaje: 0 } });
  });

  it("el límite inferior entra y el superior no: 05:00Z es el comienzo del 20, 04:59:59Z todavía es el 19", async () => {
    const docs = [
      item({ code: "DOC_ITEM-1", subtotal: 1, nombre: "a", codigo: "A", categoria: "k", pagadoTs: "2026-10-20T04:59:59Z" }),
      item({ code: "DOC_ITEM-2", subtotal: 2, nombre: "b", codigo: "B", categoria: "k", pagadoTs: "2026-10-20T05:00:00Z" }),
      item({ code: "DOC_ITEM-3", subtotal: 4, nombre: "c", codigo: "C", categoria: "k", pagadoTs: "2026-10-21T04:59:59Z" }),
      item({ code: "DOC_ITEM-4", subtotal: 8, nombre: "d", codigo: "D", categoria: "k", pagadoTs: "2026-10-21T05:00:00Z" }),
    ];
    const { svc } = servicio(docs);
    const solo20 = await svc.ventas({ ...consulta, desde: "2026-10-20", hasta: "2026-10-20" });
    assert.equal(solo20.resumen.ventas, 6, "b y c");
    const solo19 = await svc.ventas({ ...consulta, desde: "2026-10-19", hasta: "2026-10-19" });
    assert.equal(solo19.resumen.ventas, 1, "a");
    // En UTC (país sin zona conocida) los límites son otros
    const utc = await servicio(docs, { pais: "JP" }).svc.ventas({ ...consulta, desde: "2026-10-20", hasta: "2026-10-20" });
    assert.equal(utc.zona, "UTC");
    assert.equal(utc.resumen.ventas, 3, "a (04:59Z ya es el 20 en UTC) y b; c es del 21 en UTC");
  });

  it("un ítem cobrado dos veces en el historial cuenta una sola vez, con la última fecha de pago", async () => {
    const d = item({ code: "DOC_ITEM-1", subtotal: 10, nombre: "a", codigo: "A", categoria: "k", pagadoTs: "2026-10-19T15:00:00Z" });
    d.historial.push({ de: "pagado", a: "pagado", usuarioId: "u2", ts: new Date("2026-10-20T15:00:00Z") });
    const r = await servicio([d]).svc.ventas(consulta);
    assert.equal(r.resumen.items, 1);
    assert.equal(r.resumen.ventas, 10);
    assert.deepEqual(r.serie.map((s) => s.ventas), [0, 10, 0], "se toma el último movimiento a «pagado»");
  });

  it("un ítem sin subtotal (sin precio) no suma ni rompe; sin pedido encontrado el canal queda null", async () => {
    const d1 = item({ code: "DOC_ITEM-1", subtotal: undefined, nombre: "sin precio", codigo: "S", categoria: "k", pagadoTs: "2026-10-20T15:00:00Z" });
    const d2 = item({ code: "DOC_ITEM-2", pedido: "PD-0000099", subtotal: 3.1, nombre: "huérfano", codigo: "H", categoria: "k", pagadoTs: "2026-10-20T15:00:00Z" });
    const r = await servicio([d1, d2]).svc.ventas(consulta);
    assert.equal(r.resumen.ventas, 3.1);
    assert.equal(r.resumen.items, 2);
    assert.deepEqual(r.canales.map((c) => [c.canal, c.ventas]), [[null, 3.1]]);
  });

  it("los céntimos no se desvían por la suma de decimales (0,1 + 0,2 + ...)", async () => {
    const docs = Array.from({ length: 10 }, (_, i) => item({ code: `DOC_ITEM-${i}`, subtotal: 0.1, nombre: "a", codigo: "A", categoria: "k", pagadoTs: "2026-10-20T15:00:00Z" }));
    const r = await servicio(docs).svc.ventas(consulta);
    assert.equal(r.resumen.ventas, 1);
    assert.equal(r.categorias[0].ventas, 1);
  });

  it("más de 8 categorías: las 7 mayores y «Otros»; más de 10 clientes: los 10 mejores y «Otros clientes» cuadra con el total", async () => {
    const docs = [];
    for (let i = 0; i < 12; i++)
      docs.push(item({ code: `DOC_ITEM-${i}`, pedido: `PD-${i}`, subtotal: 100 - i, nombre: `p${i}`, codigo: `P${i}`, categoria: `Cat ${i}`, cliente: { clienteId: `c${i}`, nombre: `Cliente ${i}` }, pagadoTs: "2026-10-20T15:00:00Z" }));
    const r = await servicio(docs).svc.ventas(consulta);
    assert.equal(r.categorias.length, 8);
    assert.equal(r.categorias[7].nombre, "Otros");
    assert.equal(r.categorias[7].otros, true);
    assert.equal(r.categorias.reduce((n, c) => n + c.ventas, 0), r.resumen.ventas);
    assert.equal(r.clientes.top.length, 10);
    assert.equal(r.clientes.top[0].nombre, "Cliente 0");
    const suma = r.clientes.top.reduce((n, c) => n + c.ventas, 0) + r.clientes.sinCliente.ventas + r.clientes.otros.ventas;
    assert.equal(Math.round(suma * 100) / 100, r.resumen.ventas);
    assert.equal(r.clientes.otros.ventas, 100 - 10 + 100 - 11);
  });

  it("un mesero ya borrado del sistema se ve como «Usuario eliminado», no rompe", async () => {
    const d = item({ code: "DOC_ITEM-1", subtotal: 4, nombre: "a", codigo: "A", categoria: "k", pagadoPor: "u-borrado", pagadoTs: "2026-10-20T15:00:00Z" });
    const r = await servicio([d]).svc.ventas(consulta);
    assert.deepEqual(r.meseros.map((m) => [m.id, m.nombre]), [["u-borrado", "Usuario eliminado"]]);
  });
});

describe("reportes: permisos y multiempresa", () => {
  it("exige reporte:leer: sin él (o sin actor) es PERMISO_INSUFICIENTE y no consulta nada", async () => {
    const { svc, modelos } = servicio(datos());
    for (const actor of [{ usuarioId: "u1", permisos: ["documento:leer", "estacion:administracion"] }, { usuarioId: "u1", permisos: [] }, null, undefined]) {
      await assert.rejects(svc.ventas({ ...consulta, actor }), (e) => e.codigo === "PERMISO_INSUFICIENTE" && e.status === 403);
    }
    assert.equal(modelos.consultas.length, 0);
  });

  it("acepta el permiso exacto, el del recurso (reporte:*) y el total", async () => {
    for (const permisos of [["reporte:leer"], ["reporte:*"], ["*"]]) {
      const r = await servicio(datos()).svc.ventas({ ...consulta, actor: { usuarioId: "u1", permisos } });
      assert.equal(r.resumen.ventas, 26);
    }
  });

  it("la otra empresa ve sus propias ventas y nunca las de la primera", async () => {
    const r = await servicio(datos()).svc.ventas({ ...consulta, empresaId: "e2" });
    assert.equal(r.resumen.ventas, 99);
    assert.equal(r.resumen.pedidos, 1);
    assert.deepEqual(r.canales.map((c) => [c.canal, c.ventas]), [["llevar", 99]], "el canal sale del pedido de e2, no del de e1");
    assert.equal(r.resumen.propinas, 9);
  });

  it("el pipeline filtra por tipo y estado primero (aprovecha el índice) y el `$lookup` se limita a la misma empresa", async () => {
    const { svc, modelos } = servicio(datos());
    await svc.ventas(consulta);
    const [ventas, recibos] = modelos.consultas;
    assert.deepEqual(Object.keys(ventas[0].$match).slice(0, 2), ["tipo", "estado"]);
    const look = ventas.find((e) => e.$lookup).$lookup;
    assert.equal(JSON.stringify(look.pipeline[0]).includes('"$$e"'), true);
    assert.equal(recibos[0].$match.tipo, "recibo");
  });
});

describe("reportes: ruta GET /reportes/ventas", () => {
  let server, url, sesion;
  before(async () => {
    const svc = { reportes: crearReportes({ conEmpresa, permite, modelos: modelosFalsos(datos()), ahora: () => AHORA }) };
    const router = express.Router();
    const ctx = {
      autenticar: () => (req, res, next) => {
        if (req.headers["x-sin-sesion"]) return res.status(401).json({ error: "no autenticado" });
        Object.assign(req, structuredClone(sesion));
        next();
      },
      requierePermiso: (permiso) => (req, res, next) => {
        req.permisoPedido = permiso;
        next();
      },
      eventos: { middleware: ({ estacion }) => (req, res, next) => { req.estacionDeRuta = estacion; next(); } },
      auth: { exigirCsrf() {} },
    };
    montarRutas(router, ctx, svc);
    const app = express();
    app.use("/tobt", router);
    await new Promise((r) => (server = app.listen(0, r)));
    url = `http://127.0.0.1:${server.address().port}/tobt`;
  });
  after(() => server.close());
  const con = (permisos) => (sesion = { auth: { usuarioId: "u1", empresaId: "e1" }, rol: { permisos } });
  const pedir = (q = "") => fetch(`${url}/reportes/ventas${q}`);

  it("200 con reporte:leer; la respuesta no se guarda en caché", async () => {
    con(["reporte:leer"]);
    const r = await pedir("?desde=2026-10-19&hasta=2026-10-21&gran=semana");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const j = await r.json();
    assert.equal(j.resumen.ventas, 26);
    assert.equal(j.gran, "semana");
  });

  it("403 sin el permiso (aunque la ruta no lo comprobara, el servicio lo hace)", async () => {
    con(["documento:leer"]);
    const r = await pedir();
    assert.equal(r.status, 403);
    assert.equal((await r.json()).codigo, "PERMISO_INSUFICIENTE");
  });

  it("401 sin sesión; 400 con fechas o granularidad inválidas, con el mensaje", async () => {
    con(["*"]);
    assert.equal((await fetch(`${url}/reportes/ventas`, { headers: { "x-sin-sesion": "1" } })).status, 401);
    for (const q of ["?desde=hoy", "?hasta=2026-02-30", "?gran=hora", "?desde=2026-10-21&hasta=2026-10-20", "?desde=2020-01-01&hasta=2026-10-20"]) {
      const r = await pedir(q);
      assert.equal(r.status, 400, q);
      assert.equal((await r.json()).codigo, "DATOS_INVALIDOS");
    }
  });

  it("es una lectura: no pide x-requested-with y los POST no existen", async () => {
    con(["*"]);
    assert.equal((await pedir()).status, 200);
    assert.equal((await fetch(`${url}/reportes/ventas`, { method: "POST", headers: { "x-requested-with": "x" } })).status, 404);
  });
});
