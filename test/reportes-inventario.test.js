// Reportes del inventario (5.78): consumo por insumo, costo de ventas y margen por plato. La agregación corre de verdad con
// `mingo` sobre documentos con la forma real de `documentos` y `kardex_movimientos`; no se probó contra MongoDB real.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { Aggregator } from "mingo";
import { conEmpresa, empresaActual, permite } from "core";
import { crearReportesInventario, armarConsumo, armarPlatos, resumirInventario } from "../src/reportes-inventario.js";
import { montarRutas } from "../src/http.js";

const ms = (iso) => new Date(iso).getTime();

function item({ code, empresaId = "e1", estado = "pagado", cantidad = 1, subtotal, nombre, codigo, categoria, pagadoTs = "2026-10-20T15:00:00Z" }) {
  const historial = [{ de: null, a: "en_cocina", usuarioId: "u1", ts: new Date("2026-10-01T10:00:00Z") }];
  if (estado === "pagado") historial.push({ de: "entregado", a: "pagado", usuarioId: "u1", sistema: false, ts: new Date(pagadoTs) });
  return {
    empresaId, tipo: "doc_item", code, estado,
    payload: { doc: { pedidoCode: "PD-1", cantidad, subtotal } },
    snapshot: { item: { origen: codigo ? "catalogo" : "libre", codigo: codigo ?? null, nombre, categoria: categoria ?? null } },
    historial,
  };
}
const oid = (n) => `0000000000000000000000${n}`;
const mov = ({ insumo, tipo, cantidad, valor, ts = "2026-10-20T15:00:00Z", referencia = null, anulaTipo = null, empresaId = "e1" }) => ({
  empresaId, insumoId: oid(insumo), tipo, cantidad, valor, costoUnitario: Math.abs(valor / cantidad || 0), referencia, anulaTipo, ts: new Date(ts),
});

function datos() {
  return [
    // Vendidos y cobrados el 20: dos lattes (con consumo), una moka (sin receta) y una torta libre
    item({ code: "DOC_ITEM-1", cantidad: 2, subtotal: 13, nombre: "Latte", codigo: "LATTE", categoria: "Cafés" }),
    item({ code: "DOC_ITEM-2", subtotal: 6.5, nombre: "Latte", codigo: "LATTE", categoria: "Cafés" }),
    item({ code: "DOC_ITEM-3", subtotal: 5, nombre: "Moka", codigo: "MOKA", categoria: "Cafés" }),
    item({ code: "DOC_ITEM-4", subtotal: 8, nombre: "Torta casera" }),
    // No cuentan: en cocina, fuera del rango, de otra empresa
    item({ code: "DOC_ITEM-5", estado: "en_cocina", subtotal: 99, nombre: "En cocina", codigo: "X" }),
    item({ code: "DOC_ITEM-6", subtotal: 99, nombre: "Septiembre", codigo: "X", pagadoTs: "2026-09-01T15:00:00Z" }),
    item({ code: "DOC_ITEM-1", empresaId: "e2", subtotal: 99, nombre: "Otra", codigo: "X" }),
    // Libro del kardex. Insumo 1 = café (g), 2 = leche (ml)
    mov({ insumo: 1, tipo: "compra", cantidad: 1000, valor: 80, ts: "2026-10-19T14:00:00Z" }),
    mov({ insumo: 1, tipo: "consumo", cantidad: -36, valor: -2.88, referencia: "DOC_ITEM-1" }),
    mov({ insumo: 1, tipo: "consumo", cantidad: -18, valor: -1.44, referencia: "DOC_ITEM-2" }),
    mov({ insumo: 1, tipo: "merma", cantidad: -50, valor: -4, ts: "2026-10-20T16:00:00Z" }),
    mov({ insumo: 2, tipo: "compra", cantidad: 2000, valor: 6, ts: "2026-10-20T10:00:00Z" }),
    mov({ insumo: 2, tipo: "consumo", cantidad: -400, valor: -1.2, referencia: "DOC_ITEM-1" }),
    mov({ insumo: 2, tipo: "consumo", cantidad: -200, valor: -0.6, referencia: "DOC_ITEM-2" }),
    // Una compra mal puesta y su anulación (cuenta contra las compras), un ajuste y un consumo de otra empresa y de fuera del rango
    mov({ insumo: 2, tipo: "compra", cantidad: 100000, valor: 300, ts: "2026-10-20T11:00:00Z" }),
    mov({ insumo: 2, tipo: "anulacion", cantidad: -100000, valor: -300, anulaTipo: "compra", ts: "2026-10-20T11:05:00Z" }),
    mov({ insumo: 2, tipo: "ajuste", cantidad: -20, valor: -0.06, ts: "2026-10-20T18:00:00Z" }),
    mov({ insumo: 1, tipo: "consumo", cantidad: -10, valor: -0.8, referencia: "DOC_ITEM-9", ts: "2026-09-01T10:00:00Z" }),
    mov({ insumo: 1, tipo: "consumo", cantidad: -999, valor: -999, referencia: "DOC_ITEM-1", empresaId: "e2" }),
  ];
}

function modelosFalsos(docs) {
  const aggr = (filtro) => async (pipeline) => {
    const empresaId = empresaActual();
    assert.ok(empresaId, "debe correr dentro de la empresa activa (conEmpresa)");
    const propios = docs.filter(filtro);
    return new Aggregator([{ $match: { empresaId } }, ...pipeline], { collectionResolver: () => docs.filter((d) => d.insumoId) }).run(propios);
  };
  const insumos = [
    { _id: oid(1), codigo: "CAFE", nombre: "Café molido", unidad: "g" },
    { _id: oid(2), codigo: "LECHE", nombre: "Leche", unidad: "ml" },
  ];
  return {
    Documento: { aggregate: aggr((d) => d.tipo === "doc_item") },
    MovimientoKardex: { aggregate: aggr((d) => d.insumoId) },
    Insumo: { find: (f) => ({ select: () => ({ lean: async () => insumos.filter((i) => f._id.$in.includes(i._id)) }) }) },
    Empresa: { findById: (id) => ({ lean: async () => ({ _id: id, pais: "PE", moneda: "PEN" }) }) },
  };
}

const AHORA = ms("2026-10-21T14:00:00Z");
const ADMIN = { usuarioId: "u1", permisos: ["*"] };
const consulta = { empresaId: "e1", actor: ADMIN, desde: "2026-10-19", hasta: "2026-10-21" };
const crear = (docs = datos()) => crearReportesInventario({ conEmpresa, permite, modelos: modelosFalsos(docs), ahora: () => AHORA });

describe("reportes de inventario (agregación real con mingo)", () => {
  let r;
  before(async () => {
    r = await crear().inventario(consulta);
  });

  it("consumo por insumo: compras, consumo, mermas y ajustes del rango, de esta empresa, netos de anulaciones", () => {
    assert.equal(r.insumos.length, 2);
    const [cafe, leche] = r.insumos; // ordenados por costo consumido
    assert.deepEqual([cafe.codigo, cafe.unidad], ["CAFE", "g"]);
    assert.deepEqual(cafe.compras, { cantidad: 1000, valor: 80 });
    assert.deepEqual(cafe.consumo, { cantidad: 54, valor: 4.32 });
    assert.deepEqual(cafe.merma, { cantidad: 50, valor: 4 });
    assert.deepEqual(leche.consumo, { cantidad: 600, valor: 1.8 });
    assert.deepEqual(leche.compras, { cantidad: 2000, valor: 6 }, "la compra mal puesta y su anulación se cancelan");
    assert.deepEqual(leche.ajuste, { cantidad: -20, valor: -0.06 });
    assert.equal(r.insumos[0].nombre, "Café molido", "el que más costo consumió va primero");
  });

  it("platos: ventas del rango con el costo real del kardex; sin consumo no hay costo ni margen", () => {
    const por = Object.fromEntries(r.platos.map((p) => [p.nombre, p]));
    assert.deepEqual([por.Latte.unidades, por.Latte.ventas, por.Latte.costo, por.Latte.margen, por.Latte.margenPct], [3, 19.5, 6.12, 13.38, 68.6]);
    assert.deepEqual([por.Latte.items, por.Latte.itemsSinCosto], [2, 0]);
    assert.deepEqual([por.Moka.costo, por.Moka.margen, por.Moka.margenPct, por.Moka.itemsSinCosto], [0, null, null, 1]);
    assert.deepEqual([por["Torta casera"].codigo, por["Torta casera"].margen], [null, null]);
    assert.equal(r.platos.length, 3, "no entran lo no cobrado, lo de fuera del rango ni lo de otra empresa");
  });

  it("resumen: el margen solo cuenta lo vendido con costo; avisa cuánto quedó sin costo", () => {
    assert.deepEqual(
      [r.resumen.ventas, r.resumen.ventasConCosto, r.resumen.costoDeVentas, r.resumen.margen, r.resumen.margenPct, r.resumen.itemsSinCosto, r.resumen.ventasSinCosto],
      [32.5, 19.5, 6.12, 13.38, 68.6, 2, 13],
    );
    assert.deepEqual([r.resumen.compras, r.resumen.consumo, r.resumen.merma, r.resumen.ajuste], [86, 6.12, 4, -0.06]);
    assert.deepEqual([r.desde, r.hasta, r.dias, r.zona, r.moneda, r.platosTruncados], ["2026-10-19", "2026-10-21", 3, "America/Lima", "PEN", false]);
  });

  it("sin movimientos ni ventas devuelve listas vacías y ceros, sin dividir entre cero", async () => {
    const v = await crear([]).inventario(consulta);
    assert.deepEqual([v.insumos, v.platos, v.resumen.margen, v.resumen.margenPct, v.resumen.costoDeVentas], [[], [], 0, null, 0]);
  });

  it("pide reporte:leer y kardex:leer, y valida las fechas", async () => {
    const s = crear();
    for (const permisos of [["reporte:leer"], ["kardex:leer"], []])
      await assert.rejects(s.inventario({ ...consulta, actor: { usuarioId: "u1", permisos } }), (e) => e.codigo === "PERMISO_INSUFICIENTE");
    const ok = await s.inventario({ ...consulta, actor: { usuarioId: "u1", permisos: ["reporte:leer", "kardex:leer"] } });
    assert.equal(ok.resumen.ventas, 32.5);
    await assert.rejects(s.inventario({ ...consulta, desde: "hoy" }), (e) => e.codigo === "DATOS_INVALIDOS");
  });

  it("el `$lookup` del costo se limita a la misma empresa y al consumo y la reversa", async () => {
    let capturado;
    const modelos = modelosFalsos(datos());
    const orig = modelos.Documento.aggregate;
    modelos.Documento.aggregate = (p) => ((capturado = p), orig(p));
    await crearReportesInventario({ conEmpresa, permite, modelos, ahora: () => AHORA }).inventario(consulta);
    const look = JSON.stringify(capturado.find((e) => e.$lookup).$lookup);
    assert.ok(look.includes('"$$e"') && look.includes('"consumo"') && look.includes('"reversa"'));
  });
});

describe("reportes de inventario: piezas puras", () => {
  it("una anulación sin `anulaTipo` (anterior a 5.78) se clasifica por su signo", () => {
    const filas = [
      { _id: { i: "a", t: "compra", a: null }, cantidad: 100, valor: 10 },
      { _id: { i: "a", t: "anulacion", a: null }, cantidad: -40, valor: -4 }, // entrada anulada
      { _id: { i: "a", t: "merma", a: null }, cantidad: -10, valor: -1 },
      { _id: { i: "a", t: "anulacion", a: null }, cantidad: 10, valor: 1 }, // salida anulada
    ];
    const [f] = armarConsumo(filas);
    assert.deepEqual([f.compras, f.merma, f.nombre], [{ cantidad: 60, valor: 6 }, { cantidad: 0, valor: 0 }, "(insumo eliminado)"]);
  });
  it("la reversa devuelve consumo; una venta con costo cero real sigue contando como con costo", () => {
    const [f] = armarConsumo([{ _id: { i: "a", t: "consumo", a: null }, cantidad: -50, valor: -5 }, { _id: { i: "a", t: "reversa", a: null }, cantidad: 20, valor: 2 }]);
    assert.deepEqual(f.consumo, { cantidad: 30, valor: 3 });
    const [p] = armarPlatos([{ _id: "X", nombre: "X", unidades: 1, ventas: 10, items: 1, itemsConCosto: 1, ventasConCosto: 10, costo: 0 }]);
    assert.deepEqual([p.margen, p.margenPct], [10, 100]);
    assert.equal(resumirInventario([], [p]).margenPct, 100);
  });
});

describe("reportes de inventario: ruta GET /reportes/inventario", () => {
  let server, url, sesion;
  before(async () => {
    const svc = { reportesInventario: crear() };
    const router = express.Router();
    const ctx = {
      autenticar: () => (req, res, next) => (Object.assign(req, structuredClone(sesion)), next()),
      requierePermiso: () => (req, res, next) => next(),
      eventos: { middleware: () => (req, res, next) => next() },
      auth: { exigirCsrf() {} },
    };
    montarRutas(router, ctx, svc);
    const app = express();
    app.use("/tobt", router);
    await new Promise((ok) => (server = app.listen(0, ok)));
    url = `http://127.0.0.1:${server.address().port}/tobt`;
  });
  after(() => server.close());
  const con = (permisos) => (sesion = { auth: { usuarioId: "u1", empresaId: "e1" }, rol: { permisos } });

  it("200 con los dos permisos, sin caché; 403 si falta kardex:leer; 400 con fechas malas", async () => {
    con(["reporte:leer", "kardex:leer"]);
    const r = await fetch(`${url}/reportes/inventario?desde=2026-10-19&hasta=2026-10-21`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal((await r.json()).resumen.costoDeVentas, 6.12);
    con(["reporte:leer"]);
    assert.equal((await fetch(`${url}/reportes/inventario`)).status, 403);
    con(["*"]);
    assert.equal((await fetch(`${url}/reportes/inventario?desde=hoy`)).status, 400);
  });
});
