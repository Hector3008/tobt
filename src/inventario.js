import mongoose from "mongoose";
import { tenancyPlugin, conEmpresa, permite } from "core";
import { ErrorPedido } from "./errores.js";

// Inventario de tobt (arquitectura 5.76): recetas de los platos y descuento de insumos del kardex del núcleo (5.75).
//
// Una receta dice qué insumos gasta UNA porción de un plato del catálogo: `{ insumoId, cantidad }` con la cantidad en la
// unidad base del insumo (15 g de café, 200 ml de leche). Al pasar un ítem a cocina (el ítem nace `en_cocina`) se descuenta
// receta × cantidad del ítem; el kardex registra un `consumo` cuya referencia es el código del ítem (DOC_ITEM-…), así que
// repetir no descuenta dos veces. Los ítems no se editan (si se equivocó, se anula y se pide otro), por eso descontar al
// crearlos es exacto.
//
// Reglas (decisiones de Héctor, 6 nov 2026):
//   - Nunca bloquea: el pedido se crea aunque falte stock o falle el kardex. La respuesta avisa con `stockBajo` y `sinReceta`.
//   - Sin kardex en el núcleo (versión anterior) o sin modelo, el módulo no hace nada y el servicio se comporta como antes.
//   - `sinReceta` solo se avisa si la empresa ya usa recetas: una empresa que no usa inventario no recibe avisos.
//   - Al anular un ítem que sigue en cocina el insumo vuelve (reversa). Si ya salió de cocina (lista o entregado) se
//     preparó y se gastó: el consumo se queda.

const ID = /^[0-9a-f]{24}$/i;
export const MAX_LINEAS_RECETA = 30;

const malo = (m, d) => new ErrorPedido("DATOS_INVALIDOS", m, d);
const clave = (c) => String(c).trim().toLowerCase();

const decimales = (n) => {
  const s = String(n);
  if (s.includes("e-")) return 99;
  const i = s.indexOf(".");
  return i === -1 ? 0 : s.length - i - 1;
};

/** Valida las líneas de una receta. Devuelve [{ insumoId, cantidad }] sin repetir insumos. */
export function validarLineas(lineas) {
  if (!Array.isArray(lineas) || lineas.length < 1 || lineas.length > MAX_LINEAS_RECETA)
    throw malo(`lineas: una lista de 1 a ${MAX_LINEAS_RECETA} insumos`);
  const vistos = new Set();
  return lineas.map((l, i) => {
    if (!l || typeof l !== "object" || Array.isArray(l)) throw malo(`lineas[${i}]: { insumoId, cantidad }`);
    const extra = Object.keys(l).filter((k) => !["insumoId", "cantidad"].includes(k));
    if (extra.length) throw malo(`lineas[${i}]: campos no admitidos (${extra.join(", ")})`);
    if (typeof l.insumoId !== "string" || !ID.test(l.insumoId)) throw malo(`lineas[${i}].insumoId: inválido`);
    if (vistos.has(l.insumoId)) throw malo(`lineas[${i}]: el insumo está repetido; suma las cantidades en una sola línea`);
    vistos.add(l.insumoId);
    if (typeof l.cantidad !== "number" || !Number.isFinite(l.cantidad) || l.cantidad <= 0 || l.cantidad > 1e6)
      throw malo(`lineas[${i}].cantidad: un número mayor que 0`);
    if (decimales(l.cantidad) > 3) throw malo(`lineas[${i}].cantidad: como máximo 3 decimales`);
    return { insumoId: l.insumoId, cantidad: l.cantidad };
  });
}

function crearModelo(core) {
  if (typeof core.model !== "function") return null;
  const schema = new mongoose.Schema(
    {
      platoCodigo: { type: String, required: true },
      platoClave: { type: String, required: true }, // el código en minúsculas
      lineas: { type: [{ _id: false, insumoId: mongoose.Schema.Types.ObjectId, cantidad: Number }], default: [] },
      actualizadoPor: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    { timestamps: true },
  );
  schema.plugin(tenancyPlugin);
  schema.index({ empresaId: 1, platoClave: 1 }, { unique: true });
  return core.model("TobtReceta", schema, "tobt_recetas");
}

export function crearInventario(core, { Receta = crearModelo(core) } = {}) {
  const kardex = core.kardex;
  const activo = Boolean(kardex && Receta);

  const exigir = (actor, permiso) => {
    if (!actor || !permite(actor.permisos ?? [], permiso))
      throw new ErrorPedido("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };
  const exigirVer = (actor) => {
    if (!actor || !["kardex:leer", "kardex:registrar", "kardex:gestionar"].some((p) => permite(actor.permisos ?? [], p)))
      throw new ErrorPedido("PERMISO_INSUFICIENTE", "permiso insuficiente (kardex:leer)");
  };
  const requiereActivo = () => {
    if (!activo) throw new ErrorPedido("ESTADO_INVALIDO", "el inventario no está disponible en este servidor");
  };

  const dto = (r) => ({
    platoCodigo: r.platoCodigo,
    lineas: (r.lineas ?? []).map((l) => ({ insumoId: String(l.insumoId), cantidad: l.cantidad })),
    actualizado: r.updatedAt ?? null,
  });

  // ---------- recetas ----------
  async function listarRecetas({ empresaId, actor }) {
    exigirVer(actor);
    requiereActivo();
    const lista = await conEmpresa(empresaId, async () => await Receta.find({}).sort({ platoCodigo: 1 }).lean());
    return lista.map(dto);
  }

  async function obtenerReceta({ empresaId, actor, platoCodigo }) {
    exigirVer(actor);
    requiereActivo();
    const r = await conEmpresa(empresaId, async () => await Receta.findOne({ platoClave: clave(platoCodigo) }).lean());
    if (!r) throw new ErrorPedido("NO_ENCONTRADO", "el plato no tiene receta");
    return dto(r);
  }

  /** Crea o reemplaza la receta de un plato del catálogo. Cada insumo tiene que existir y estar activo. */
  async function guardarReceta({ empresaId, actor, platoCodigo, lineas }) {
    exigir(actor, "kardex:gestionar");
    requiereActivo();
    if (typeof platoCodigo !== "string" || !platoCodigo.trim() || platoCodigo.length > 60) throw malo("platoCodigo: obligatorio");
    const limpias = validarLineas(lineas);
    return await conEmpresa(empresaId, async () => {
      // El plato tiene que estar en el catálogo (y activo): evita recetas de platos que no existen.
      const [snap] = await core.catalogo.instantanea({ empresaId, items: [platoCodigo.trim()] });
      for (const l of limpias) {
        const insumo = await kardex.obtenerInsumo({ empresaId, actor, insumoId: l.insumoId });
        if (insumo.activo === false) throw malo(`el insumo «${insumo.codigo}» está desactivado`, { insumoId: l.insumoId });
      }
      const codigo = snap.codigo ?? platoCodigo.trim();
      const previa = await Receta.findOne({ platoClave: clave(codigo) }).lean();
      if (previa) {
        await Receta.updateOne({ _id: previa._id }, { $set: { lineas: limpias, actualizadoPor: actor.usuarioId ?? null } });
      } else {
        await Receta.create({ platoCodigo: codigo, platoClave: clave(codigo), lineas: limpias, actualizadoPor: actor.usuarioId ?? null });
      }
      return dto(await Receta.findOne({ platoClave: clave(codigo) }).lean());
    });
  }

  /** Quita la receta (el plato deja de descontar insumos). Lo ya consumido no se toca. */
  async function borrarReceta({ empresaId, actor, platoCodigo }) {
    exigir(actor, "kardex:gestionar");
    requiereActivo();
    return await conEmpresa(empresaId, async () => {
      const r = await Receta.findOne({ platoClave: clave(platoCodigo) }).lean();
      if (!r) throw new ErrorPedido("NO_ENCONTRADO", "el plato no tiene receta");
      await Receta.deleteOne({ _id: r._id });
      return { platoCodigo: r.platoCodigo, eliminada: true };
    });
  }

  // ---------- descuento y reversa (los llama el servicio de pedidos; nunca lanzan) ----------

  /**
   * `items`: [{ code, pedidoCode, platoCodigo|null, nombre, cantidad }] (los ítems recién creados). Devuelve los avisos:
   * `sinReceta` ([{ codigo, nombre }]: platos del catálogo sin receta, solo si la empresa usa recetas) y
   * `stockBajo` ([{ insumo, nombre, existencia, negativo, bajoMinimo }]). Vacío si no hay nada que avisar.
   */
  async function descontar({ empresaId, items }) {
    if (!activo) return {};
    try {
      const delCatalogo = items.filter((i) => typeof i.platoCodigo === "string" && i.platoCodigo);
      if (!delCatalogo.length) return {};
      const claves = [...new Set(delCatalogo.map((i) => clave(i.platoCodigo)))];
      const recetas = await conEmpresa(empresaId, async () => await Receta.find({ platoClave: { $in: claves } }).lean());
      const porPlato = new Map(recetas.map((r) => [r.platoClave, r]));
      const avisos = {};
      const usaRecetas = recetas.length > 0 || (await conEmpresa(empresaId, async () => await Receta.countDocuments({}))) > 0;
      if (usaRecetas) {
        const sin = new Map();
        for (const i of delCatalogo) if (!porPlato.has(clave(i.platoCodigo))) sin.set(clave(i.platoCodigo), { codigo: i.platoCodigo, nombre: i.nombre ?? i.platoCodigo });
        if (sin.size) avisos.sinReceta = [...sin.values()];
      }
      const bajos = new Map();
      for (const i of delCatalogo) {
        const receta = porPlato.get(clave(i.platoCodigo));
        if (!receta) continue;
        try {
          const r = await kardex.consumirVarios({
            empresaId,
            referencia: i.code,
            detalle: i.pedidoCode ? `Pedido ${i.pedidoCode}` : null,
            lineas: receta.lineas.map((l) => ({ insumoId: String(l.insumoId), cantidad: Math.round(l.cantidad * i.cantidad * 1000) / 1000 })),
          });
          for (const a of r.aplicados ?? []) {
            if (!a.negativo && !a.bajoMinimo) continue;
            bajos.set(a.insumoId, { insumo: a.codigo, nombre: a.nombre, existencia: a.existencia, negativo: Boolean(a.negativo), bajoMinimo: Boolean(a.bajoMinimo) });
          }
          for (const e of r.errores ?? []) console.error(`tobt: no se pudo descontar un insumo de ${i.code}: ${e.codigo} ${e.mensaje}`);
        } catch (e) {
          console.error(`tobt: no se pudo descontar el inventario de ${i.code}`, e);
        }
      }
      if (bajos.size) avisos.stockBajo = [...bajos.values()];
      return avisos;
    } catch (e) {
      console.error("tobt: no se pudo consultar las recetas", e);
      return {};
    }
  }

  /** Devuelve al kardex lo que descontaron esos ítems (al costo con que salió). Idempotente. */
  async function devolver({ empresaId, codes }) {
    if (!activo || !codes?.length) return;
    for (const code of codes) {
      try {
        await kardex.revertir({ empresaId, referencia: code, detalle: "Ítem anulado antes de salir de cocina" });
      } catch (e) {
        console.error(`tobt: no se pudo devolver el inventario de ${code}`, e);
      }
    }
  }

  return { activo, listarRecetas, obtenerReceta, guardarReceta, borrarReceta, descontar, devolver };
}
