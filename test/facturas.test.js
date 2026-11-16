// Facturas pedidas (5.88): lista, marcar como emitida y deshacer. La agregación corre con `mingo`; `documentos` es un falso que
// aplica las transiciones, permisos y motivos reales de TIPO_RECIBO. No se probó contra MongoDB real.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "mingo";
import { conEmpresa, empresaActual, permite } from "core";
import { crearFacturas, validarNumeroFactura } from "../src/facturas.js";
import { TIPO_RECIBO } from "../src/tipos.js";
import { pipelineFacturas, armarReporte } from "../src/reportes.js";

const recibo = ({ n, estado = "emitido", factura = { requerida: true, rucReferencia: "20123456789" }, ts = "2026-10-20T15:00:00Z", empresaId = "e1", total = 10 }) => ({
  empresaId, tipo: "recibo", code: `RC-${String(n).padStart(7, "0")}`, estado, version: 1, createdAt: new Date(ts), historial: [],
  payload: { doc: { pedidoCode: `PD-${n}`, subtotal: total, propina: 0, total, metodo: "efectivo", clientes: [{ nombre: "Ana" }], factura } },
});

function entorno(docs, empresa = { _id: "e1", pais: "PE", moneda: "PEN" }) {
  const modelos = {
    Documento: { aggregate: async (p) => new Aggregator([{ $match: { empresaId: empresaActual() } }, ...p]).run(docs) },
    Empresa: { findById: () => ({ lean: async () => empresa }) },
    Usuario: { find: (f) => ({ select: () => ({ lean: async () => [{ _id: "u1", nombre: "Marta" }].filter((u) => f._id.$in.includes(u._id)) }) }) },
  };
  const documentos = {
    obtener: async ({ code }) => docs.find((d) => d.empresaId === empresaActual() && d.code === code) ?? null,
    transicionar: async ({ code, a, doc, usuarioId, permisos, motivo, esperaVersion }) => {
      const d = docs.find((x) => x.empresaId === empresaActual() && x.code === code);
      if (esperaVersion !== d.version) throw Object.assign(new Error("version"), { codigo: "VERSION_DESACTUALIZADA" });
      if (!TIPO_RECIBO.transiciones[d.estado]?.includes(a)) throw new Error("transición no permitida");
      if (!permite(permisos, TIPO_RECIBO.permisos[a])) throw new Error("permiso");
      if (TIPO_RECIBO.motivos[d.estado] && a === "emitido" && !motivo) throw new Error("motivo");
      d.historial.push({ de: d.estado, a, usuarioId, motivo });
      d.estado = a; d.version += 1;
      if (doc) d.payload.doc = doc;
      return d;
    },
  };
  return crearFacturas({ conEmpresa, permite, documentos, modelos });
}

const ADMIN = { usuarioId: "u1", permisos: ["*"] };
const VER = { usuarioId: "u2", permisos: ["documento:leer"] };
const datos = () => [
  recibo({ n: 1, ts: "2026-10-18T15:00:00Z" }),
  recibo({ n: 2, ts: "2026-10-19T15:00:00Z", total: 20 }),
  recibo({ n: 3, estado: "facturado", ts: "2026-10-17T15:00:00Z", total: 5, factura: { requerida: true, rucReferencia: "R-1", emision: { numero: "F001-9", usuarioId: "u1", ts: "2026-10-18T10:00:00Z" } } }),
  recibo({ n: 4, factura: { requerida: false, rucReferencia: null } }),
  recibo({ n: 5, factura: null }),
  recibo({ n: 6, empresaId: "e2" }),
];

describe("facturas pedidas (5.88)", () => {
  let docs, f;
  beforeEach(() => { docs = datos(); f = entorno(docs); });

  it("número: opcional, limpio y validado", () => {
    assert.equal(validarNumeroFactura(undefined), null);
    assert.equal(validarNumeroFactura("  "), null);
    assert.equal(validarNumeroFactura("  F001-123  "), "F001-123");
    for (const malo of ["x".repeat(31), "<b>", 12]) assert.throws(() => validarNumeroFactura(malo), (e) => e.codigo === "DATOS_INVALIDOS");
  });

  it("lista: por defecto los pendientes, del más antiguo al más reciente, solo de esta empresa y con factura pedida", async () => {
    const r = await f.listar({ empresaId: "e1", actor: VER });
    assert.deepEqual(r.facturas.map((x) => x.recibo), ["RC-0000001", "RC-0000002"]);
    assert.deepEqual(r.resumen, { pendientes: { cantidad: 2, total: 30 }, emitidas: { cantidad: 1, total: 5 } });
    assert.equal(r.numeroObligatorio, false);
    assert.equal(r.facturas[0].estado, "pendiente");
    assert.equal(r.facturas[0].cliente, "Ana");
  });

  it("lista: emitidas con número y quién la marcó; todas; filtro por fechas", async () => {
    const e = await f.listar({ empresaId: "e1", actor: VER, estado: "emitidas" });
    assert.deepEqual(e.facturas.map((x) => [x.recibo, x.estado, x.emision.numero, x.emision.por]), [["RC-0000003", "emitida", "F001-9", "Marta"]]);
    const t = await f.listar({ empresaId: "e1", actor: VER, estado: "todas" });
    assert.deepEqual(t.facturas.map((x) => x.recibo), ["RC-0000002", "RC-0000001", "RC-0000003"]);
    const rango = await f.listar({ empresaId: "e1", actor: VER, estado: "todas", desde: "2026-10-19", hasta: "2026-10-19" });
    assert.deepEqual(rango.facturas.map((x) => x.recibo), ["RC-0000002"]);
    assert.equal(rango.resumen.pendientes.cantidad, 1, "el resumen respeta el rango");
    await assert.rejects(f.listar({ empresaId: "e1", actor: VER, estado: "raro" }), (x) => x.codigo === "DATOS_INVALIDOS");
    await assert.rejects(f.listar({ empresaId: "e1", actor: { usuarioId: "u3", permisos: [] } }), (x) => x.codigo === "PERMISO_INSUFICIENTE");
  });

  it("marcar: pasa a facturado con número, quién y cuándo; queda en el historial", async () => {
    const r = await f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000001", numero: " F001-77 " });
    assert.equal(r.estado, "emitida");
    assert.equal(r.emision.numero, "F001-77");
    assert.equal(r.emision.por, "Marta");
    assert.equal(docs[0].estado, "facturado");
    assert.deepEqual([docs[0].historial[0].de, docs[0].historial[0].a], ["emitido", "facturado"]);
    await assert.rejects(f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000001" }), (e) => e.codigo === "ESTADO_INVALIDO");
  });

  it("marcar: sin número vale, salvo que la empresa lo pida", async () => {
    const ok = await f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000001" });
    assert.equal(ok.emision.numero, null);
    const g = entorno(docs, { _id: "e1", pais: "PE", moneda: "PEN", facturacion: { numeroObligatorio: true } });
    await assert.rejects(g.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000002" }), (e) => e.codigo === "DATOS_INVALIDOS");
    assert.equal((await g.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000002", numero: "F1-2" })).emision.numero, "F1-2");
    assert.equal((await g.listar({ empresaId: "e1", actor: VER })).numeroObligatorio, true);
  });

  it("marcar: pide documento:editar; rechaza recibos sin factura pedida, inexistentes o de otra empresa", async () => {
    await assert.rejects(f.marcarEmitida({ empresaId: "e1", actor: VER, code: "RC-0000001" }), (e) => e.codigo === "PERMISO_INSUFICIENTE");
    for (const code of ["RC-0000004", "RC-0000005"]) await assert.rejects(f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code }), (e) => e.codigo === "ESTADO_INVALIDO");
    await assert.rejects(f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "RC-0000006" }), (e) => e.codigo === "NO_ENCONTRADO");
    await assert.rejects(f.marcarEmitida({ empresaId: "e1", actor: ADMIN, code: "xx" }), (e) => e.codigo === "DATOS_INVALIDOS");
  });

  it("deshacer: vuelve a pendiente con motivo y borra la marca; solo si estaba emitida", async () => {
    const m = { codigo: "error_de_marca" };
    await assert.rejects(f.deshacer({ empresaId: "e1", actor: ADMIN, code: "RC-0000001", motivo: m }), (e) => e.codigo === "ESTADO_INVALIDO");
    await assert.rejects(f.deshacer({ empresaId: "e1", actor: ADMIN, code: "RC-0000003", motivo: { codigo: "otro" } }), (e) => e.codigo === "DATOS_INVALIDOS");
    await assert.rejects(f.deshacer({ empresaId: "e1", actor: ADMIN, code: "RC-0000003", motivo: { codigo: "nada" } }), (e) => e.codigo === "DATOS_INVALIDOS");
    await assert.rejects(f.deshacer({ empresaId: "e1", actor: VER, code: "RC-0000003", motivo: m }), (e) => e.codigo === "PERMISO_INSUFICIENTE");
    const r = await f.deshacer({ empresaId: "e1", actor: ADMIN, code: "RC-0000003", motivo: { codigo: "otro", detalle: "se anuló en el SRI" } });
    assert.deepEqual([r.estado, r.emision], ["pendiente", null]);
    assert.equal(docs[2].payload.doc.factura.emision, null);
    assert.equal(docs[2].historial.at(-1).motivo.detalle, "se anuló en el SRI");
  });

  it("el reporte de ventas trae estado y número de cada factura", async () => {
    const filas = await new Aggregator(pipelineFacturas({ desdeTs: new Date("2026-10-01"), hastaTs: new Date("2026-11-01") })).run(docs.filter((d) => d.empresaId === "e1"));
    const por = Object.fromEntries(filas.map((x) => [x.code, x]));
    assert.equal(por["RC-0000003"].estado, "facturado");
    assert.equal(por["RC-0000003"].emision.numero, "F001-9");
    assert.equal(por["RC-0000001"].emision, undefined);
    assert.ok(armarReporte);
  });
});
