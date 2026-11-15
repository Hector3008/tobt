// Reportes del inventario (5.78): consumo de insumos, costo de ventas y margen por plato, en un rango de fechas.
// Todo sale de lo que ya guardan el kardex del núcleo (5.75) y los ítems cobrados (5.35); no se inventa ningún dato.
//
// • Insumos: el libro del kardex en el rango, resumido por insumo en compras, consumo, mermas y ajustes (netos de
//   anulaciones: una anulación cuenta contra el tipo del movimiento que deshace, `anulaTipo`). Es el movimiento FÍSICO:
//   el consumo es lo que salió de la despensa al hacerse el pedido.
// • Platos: lo VENDIDO en el rango (ítems `pagado`, con la fecha del cobro, igual que el reporte de ventas). El costo de
//   cada ítem es lo que descontó el kardex con su código como referencia (`consumo` menos `reversa`), valorizado al costo
//   promedio de ese momento. Un ítem sin ningún consumo (plato sin receta, o cobrado antes del kardex) NO tiene costo: se
//   cuenta aparte y su venta no entra en el margen, para no inflarlo.
// Las fechas, la zona horaria y los permisos siguen las reglas del reporte de ventas; además pide `kardex:leer`.
import { ErrorPedido } from "./errores.js";
import { validarConsulta, zonaDe } from "./reportes.js";

export const MAX_PLATOS = 500;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/** El libro del rango agrupado por insumo, tipo y tipo anulado (el índice `{ empresaId, ts }` acota la lectura). */
export function pipelineConsumo({ desdeTs, hastaTs }) {
  return [
    { $match: { ts: { $gte: desdeTs, $lt: hastaTs } } },
    { $group: { _id: { i: "$insumoId", t: "$tipo", a: "$anulaTipo" }, cantidad: { $sum: "$cantidad" }, valor: { $sum: "$valor" } } },
  ];
}

/** Lo vendido en el rango con su costo real del kardex, por plato. El `$lookup` se limita a la misma empresa. */
export function pipelineMargen({ desdeTs, hastaTs }) {
  const costoDe = { $ifNull: [{ $arrayElemAt: ["$_consumo.valor", 0] }, 0] };
  return [
    { $match: { tipo: "doc_item", estado: "pagado", historial: { $elemMatch: { a: "pagado", ts: { $gte: desdeTs, $lt: hastaTs } } } } },
    { $addFields: { _pago: { $last: { $filter: { input: "$historial", as: "h", cond: { $eq: ["$$h.a", "pagado"] } } } } } },
    { $match: { "_pago.ts": { $gte: desdeTs, $lt: hastaTs } } },
    {
      $lookup: {
        from: "kardex_movimientos",
        let: { c: "$code", e: "$empresaId" },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$referencia", "$$c"] }, { $eq: ["$empresaId", "$$e"] }, { $in: ["$tipo", ["consumo", "reversa"]] }] } } },
          { $group: { _id: null, valor: { $sum: "$valor" }, n: { $sum: 1 } } },
        ],
        as: "_consumo",
      },
    },
    {
      $addFields: {
        importe: { $ifNull: ["$payload.doc.subtotal", 0] },
        unidades: { $ifNull: ["$payload.doc.cantidad", 1] },
        plato: { $ifNull: ["$snapshot.item.codigo", { $concat: ["libre:", { $ifNull: ["$snapshot.item.nombre", "?"] }] }] },
        costo: { $multiply: [-1, costoDe] },
        conCosto: { $cond: [{ $gt: [{ $ifNull: [{ $arrayElemAt: ["$_consumo.n", 0] }, 0] }, 0] }, 1, 0] },
      },
    },
    {
      $group: {
        _id: "$plato",
        nombre: { $first: "$snapshot.item.nombre" },
        categoria: { $first: "$snapshot.item.categoria" },
        unidades: { $sum: "$unidades" },
        ventas: { $sum: "$importe" },
        items: { $sum: 1 },
        itemsConCosto: { $sum: "$conCosto" },
        ventasConCosto: { $sum: { $cond: [{ $eq: ["$conCosto", 1] }, "$importe", 0] } },
        costo: { $sum: "$costo" },
      },
    },
    { $sort: { ventas: -1, _id: 1 } },
    { $limit: MAX_PLATOS },
  ];
}

const grupoDe = (tipo, anulaTipo, cantidad) => {
  const t = tipo === "anulacion" ? anulaTipo ?? (cantidad < 0 ? "compra" : "merma") : tipo;
  if (t === "compra" || t === "inventario_inicial") return "compras";
  if (t === "consumo" || t === "reversa") return "consumo";
  if (t === "merma") return "merma";
  return "ajuste";
};

/**
 * Del libro agrupado a una fila por insumo. `compras`, `consumo` y `merma` salen en positivo (lo que entró, lo que salió);
 * `ajuste` lleva signo (+ sobraba, − faltaba). Cada uno es `{ cantidad, valor }` en la unidad base del insumo.
 */
export function armarConsumo(filas, insumos = new Map()) {
  const por = new Map();
  for (const f of filas ?? []) {
    const id = String(f._id.i);
    if (!por.has(id)) por.set(id, { compras: [0, 0], consumo: [0, 0], merma: [0, 0], ajuste: [0, 0] });
    const g = grupoDe(f._id.t, f._id.a, f.cantidad);
    por.get(id)[g][0] += f.cantidad;
    por.get(id)[g][1] += f.valor;
  }
  const par = (g, signo) => ({ cantidad: r3(signo * g[0]) + 0, valor: r2(signo * g[1]) + 0 });
  const lista = [...por].map(([id, g]) => {
    const i = insumos.get(id);
    return {
      insumoId: id, codigo: i?.codigo ?? null, nombre: i?.nombre ?? "(insumo eliminado)", unidad: i?.unidad ?? "",
      compras: par(g.compras, 1), consumo: par(g.consumo, -1), merma: par(g.merma, -1), ajuste: par(g.ajuste, 1),
    };
  });
  lista.sort((a, b) => b.consumo.valor - a.consumo.valor || a.nombre.localeCompare(b.nombre, "es"));
  return lista;
}

/** Una fila por plato con costo y margen; el margen solo cuenta lo vendido que tiene costo. */
export function armarPlatos(filas) {
  return (filas ?? []).map((f) => {
    const ventasConCosto = r2(f.ventasConCosto);
    const costo = r2(f.costo);
    const conCosto = f.itemsConCosto > 0;
    const margen = conCosto ? r2(ventasConCosto - costo) : null;
    return {
      codigo: String(f._id).startsWith("libre:") ? null : f._id,
      nombre: f.nombre ?? null, categoria: f.categoria ?? null,
      unidades: f.unidades, ventas: r2(f.ventas), items: f.items, itemsSinCosto: f.items - f.itemsConCosto,
      ventasConCosto, costo, margen,
      margenPct: conCosto && ventasConCosto > 0 ? r1((margen / ventasConCosto) * 100) : null,
    };
  });
}

export function resumirInventario(insumos, platos) {
  const suma = (lista, f) => r2(lista.reduce((n, x) => n + f(x), 0));
  const ventas = suma(platos, (p) => p.ventas);
  const ventasConCosto = suma(platos, (p) => p.ventasConCosto);
  const costo = suma(platos, (p) => p.costo);
  const margen = r2(ventasConCosto - costo);
  return {
    compras: suma(insumos, (i) => i.compras.valor),
    consumo: suma(insumos, (i) => i.consumo.valor), // lo que salió de la despensa en el rango, a costo
    merma: suma(insumos, (i) => i.merma.valor),
    ajuste: suma(insumos, (i) => i.ajuste.valor),
    ventas,
    ventasConCosto,
    costoDeVentas: costo, // el costo de lo vendido en el rango
    margen,
    margenPct: ventasConCosto > 0 ? r1((margen / ventasConCosto) * 100) : null,
    itemsSinCosto: platos.reduce((n, p) => n + p.itemsSinCosto, 0),
    ventasSinCosto: r2(ventas - ventasConCosto),
  };
}

export function crearReportesInventario({ conEmpresa, permite, modelos, ahora = () => Date.now() }) {
  const exigir = (actor, permiso) => {
    if (!actor || !permite(actor.permisos ?? [], permiso)) throw new ErrorPedido("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  async function inventario({ empresaId, actor, ...q }) {
    exigir(actor, "reporte:leer");
    exigir(actor, "kardex:leer");
    const empresa = (await modelos.Empresa.findById(empresaId).lean()) ?? null;
    const zona = zonaDe(empresa);
    const consulta = validarConsulta(q, { zona, ahora: ahora() });
    return await conEmpresa(empresaId, async () => {
      const [libro, vendido] = await Promise.all([
        modelos.MovimientoKardex.aggregate(pipelineConsumo(consulta)),
        modelos.Documento.aggregate(pipelineMargen(consulta)),
      ]);
      const ids = [...new Set(libro.map((f) => String(f._id.i)))];
      const nombres = new Map();
      if (ids.length) {
        const filas = await modelos.Insumo.find({ _id: { $in: ids } }).select("codigo nombre unidad").lean();
        for (const i of filas) nombres.set(String(i._id), i);
      }
      const insumos = armarConsumo(libro, nombres);
      const platos = armarPlatos(vendido);
      return {
        desde: consulta.desde, hasta: consulta.hasta, dias: consulta.dias, zona, moneda: empresa?.moneda ?? null,
        resumen: resumirInventario(insumos, platos),
        insumos, platos,
        platosTruncados: vendido.length >= MAX_PLATOS,
      };
    });
  }

  return { inventario };
}
