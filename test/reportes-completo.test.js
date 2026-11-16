// Reporte de ventas completo (5.89): con `completo=1` no se acota a los primeros (para exportar a Excel).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "mingo";
import { conEmpresa, empresaActual, permite } from "core";
import { crearReportes, validarConsulta, TOP_PLATOS, TOP_CLIENTES, TOP_CATEGORIAS, TOP_PROMOCIONES } from "../src/reportes.js";

const N = 14; // más que cualquier tope
const docs = Array.from({ length: N }, (_, i) => ({
  empresaId: "e1", tipo: "doc_item", code: `DOC_ITEM-${i + 1}`, estado: "pagado",
  payload: { doc: { pedidoCode: "PD-1", cantidad: 1, subtotal: 10 + i, promociones: [{ id: `p${i}`, nombre: `Promo ${i}`, monto: 1 + i, unidades: 1 }] } },
  snapshot: { item: { origen: "catalogo", codigo: `P${i}`, nombre: `Plato ${i}`, categoria: `Cat ${i}` }, cliente: { clienteId: `c${i}`, nombre: `Cliente ${i}` } },
  historial: [{ de: "entregado", a: "pagado", usuarioId: "u1", sistema: false, ts: new Date("2026-10-20T15:00:00Z") }],
}));
const modelos = {
  Documento: { aggregate: async (p) => new Aggregator([{ $match: { empresaId: empresaActual() } }, ...p], { collectionResolver: () => docs }).run(docs) },
  Empresa: { findById: () => ({ lean: async () => ({ pais: "PE", moneda: "PEN" }) }) },
  Usuario: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
};
const svc = crearReportes({ conEmpresa, permite, modelos, ahora: () => new Date("2026-10-21T14:00:00Z").getTime() });
const q = { empresaId: "e1", actor: { usuarioId: "u1", permisos: ["*"] }, desde: "2026-10-19", hasta: "2026-10-21" };

describe("reportes: completo (5.89)", () => {
  it("validarConsulta acepta completo=1 / true y por defecto es falso", () => {
    const v = (completo) => validarConsulta({ dias: 1, completo }, { zona: "UTC" }).completo;
    assert.deepEqual([v("1"), v("true"), v(true), v(undefined), v("0"), v("")], [true, true, true, false, false, false]);
  });

  it("sin `completo` se acota a los primeros y el resto va en «Otros»", async () => {
    const r = await svc.ventas(q);
    assert.deepEqual([r.completo, r.platos.length, r.clientes.top.length, r.categorias.length, r.promociones.porPromocion.length], [false, TOP_PLATOS, TOP_CLIENTES, TOP_CATEGORIAS, TOP_PROMOCIONES]);
    assert.ok(r.clientes.otros && r.promociones.otras);
  });

  it("con `completo` salen todos, sin «Otros», y todo suma igual", async () => {
    const r = await svc.ventas({ ...q, completo: "1" });
    assert.deepEqual([r.completo, r.platos.length, r.clientes.top.length, r.categorias.length, r.promociones.porPromocion.length], [true, N, N, N, N]);
    assert.deepEqual([r.clientes.otros, r.promociones.otras, r.categorias.some((c) => c.otros)], [null, null, false]);
    const total = docs.reduce((n, d) => n + d.payload.doc.subtotal, 0);
    assert.equal(r.resumen.ventas, total);
    assert.equal(r.clientes.top.reduce((n, c) => n + c.ventas, 0), total);
    assert.equal(r.promociones.ahorro, docs.reduce((n, d) => n + d.payload.doc.promociones[0].monto, 0));
  });
});
