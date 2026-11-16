// Facturas pedidas (5.88): la lista de recibos en que el cliente pidió factura (5.86), para marcar cuáles ya se emitieron.
// La factura se emite FUERA del sistema (esto no es facturación electrónica); aquí solo se lleva la cuenta de lo pendiente.
//   pendiente = el recibo sigue `emitido`; emitida = `facturado`, con el número de la factura, quién la marcó y cuándo.
// Marcar y deshacer usan las transiciones del recibo (motor de documentos): quedan en su historial y en sus versiones.
import { ErrorPedido } from "./errores.js";
import { MOTIVOS_FACTURA, TIPO_RECIBO as DEF_RECIBO } from "./tipos.js";
import { METODOS_PAGO } from "./recibo.js";
import { validarConsulta, zonaDe } from "./reportes.js";

export const MAX_FACTURAS_LISTA = 500;
export const MAX_NUMERO_FACTURA = 30;
const RE_NUMERO = /^[\p{L}\p{N}][\p{L}\p{N} .\-/]*$/u;
const ESTADOS = { pendientes: "emitido", emitidas: "facturado", todas: null };

/** El número de la factura limpio, o null si no se dio; lanza si es inválido. */
export function validarNumeroFactura(numero) {
  if (numero === undefined || numero === null || (typeof numero === "string" && !numero.trim())) return null;
  if (typeof numero !== "string") throw new ErrorPedido("DATOS_INVALIDOS", "numero: texto, por ejemplo F001-123");
  const t = numero.trim().replace(/\s+/g, " ");
  if (t.length > MAX_NUMERO_FACTURA) throw new ErrorPedido("DATOS_INVALIDOS", `numero: hasta ${MAX_NUMERO_FACTURA} caracteres`);
  if (!RE_NUMERO.test(t)) throw new ErrorPedido("DATOS_INVALIDOS", "numero: solo letras, números, espacios y . - /");
  return t;
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** El recibo como fila de la lista de facturas. `usuarios`: Map id → nombre. */
export function facturaDto(d, usuarios = new Map()) {
  const doc = d.payload?.doc ?? d.doc ?? {};
  const em = doc.factura?.emision ?? null;
  const total = doc.total ?? (Number(doc.subtotal) || 0) + (Number(doc.propina) || 0);
  return {
    recibo: d.code,
    estado: d.estado === "facturado" ? "emitida" : "pendiente",
    version: d.version ?? null,
    ts: d.createdAt ?? null,
    pedido: doc.pedidoCode ?? null,
    rucReferencia: doc.factura?.rucReferencia ?? null,
    cliente: (doc.clientes ?? []).map((c) => c.nombre).filter(Boolean).join(", ") || null,
    subtotal: r2(doc.subtotal), propina: r2(doc.propina), total: r2(total),
    metodo: doc.metodo ?? null, metodoTexto: doc.metodo ? METODOS_PAGO[doc.metodo] ?? doc.metodo : null,
    emision: em ? { numero: em.numero ?? null, por: em.usuarioId ? usuarios.get(String(em.usuarioId)) ?? "Usuario eliminado" : null, ts: em.ts ?? null } : null,
  };
}

/** Lo que cuenta cada estado en el rango (pendientes y emitidas), sin importar el filtro de la lista. */
export function pipelineResumenFacturas(rango) {
  return [
    { $match: { tipo: "recibo", "payload.doc.factura.requerida": true, ...(rango ? { createdAt: { $gte: rango.desdeTs, $lt: rango.hastaTs } } : {}) } },
    { $group: { _id: "$estado", n: { $sum: 1 }, total: { $sum: { $ifNull: ["$payload.doc.total", 0] } } } },
  ];
}

/** La lista: los pendientes del más antiguo al más reciente; los demás, del más reciente al más antiguo. */
export function pipelineListaFacturas({ estado, rango }) {
  const filtro = { tipo: "recibo", "payload.doc.factura.requerida": true };
  if (ESTADOS[estado]) filtro.estado = ESTADOS[estado];
  if (rango) filtro.createdAt = { $gte: rango.desdeTs, $lt: rango.hastaTs };
  return [
    { $match: filtro },
    { $sort: { createdAt: estado === "pendientes" ? 1 : -1, code: 1 } },
    { $limit: MAX_FACTURAS_LISTA },
  ];
}

export function crearFacturas({ conEmpresa, permite, documentos, modelos }) {
  const exigir = (actor, permiso) => {
    if (!actor || !permite(actor.permisos ?? [], permiso)) throw new ErrorPedido("PERMISO_INSUFICIENTE", `permiso insuficiente (${permiso})`);
  };

  async function empresaDe(empresaId) {
    try {
      return (await modelos.Empresa?.findById(empresaId).lean()) ?? null;
    } catch {
      return null;
    }
  }
  const numeroObligatorio = (empresa) => empresa?.facturacion?.numeroObligatorio === true;

  async function nombres(docs) {
    const ids = [...new Set(docs.map((d) => d.payload?.doc?.factura?.emision?.usuarioId).filter(Boolean).map(String))];
    const m = new Map();
    if (ids.length && modelos.Usuario) {
      const filas = await modelos.Usuario.find({ _id: { $in: ids } }).select("nombre correo").lean();
      for (const u of filas) m.set(String(u._id), u.nombre || u.correo || "Sin nombre");
    }
    return m;
  }

  /** Pendientes / emitidas / todas. Sin fechas, todo lo que haya (así no se pierde un pendiente antiguo). */
  /** `soloResumen` (5.89): solo los contadores, sin la lista; es lo que usa Inicio para el aviso de pendientes. */
  async function listar({ empresaId, actor, estado = "pendientes", desde, hasta, dias, soloResumen = false }) {
    exigir(actor, "documento:leer");
    if (!Object.hasOwn(ESTADOS, estado)) throw new ErrorPedido("DATOS_INVALIDOS", `estado: uno de ${Object.keys(ESTADOS).join(", ")}`);
    const empresa = await empresaDe(empresaId);
    const zona = zonaDe(empresa);
    const conRango = [desde, hasta, dias].some((v) => v !== undefined && v !== null && v !== "");
    const rango = conRango ? validarConsulta({ desde, hasta, dias }, { zona }) : null;
    return await conEmpresa(empresaId, async () => {
      const [lista, cuentas] = await Promise.all([
        soloResumen ? [] : modelos.Documento.aggregate(pipelineListaFacturas({ estado, rango })),
        modelos.Documento.aggregate(pipelineResumenFacturas(rango)),
      ]);
      const usuarios = await nombres(lista);
      const por = (e) => cuentas.find((c) => c._id === e);
      return {
        desde: rango?.desde ?? null, hasta: rango?.hasta ?? null, dias: rango?.dias ?? null, zona, moneda: empresa?.moneda ?? null,
        estado, numeroObligatorio: numeroObligatorio(empresa),
        resumen: {
          pendientes: { cantidad: por("emitido")?.n ?? 0, total: r2(por("emitido")?.total) },
          emitidas: { cantidad: por("facturado")?.n ?? 0, total: r2(por("facturado")?.total) },
        },
        facturas: lista.map((d) => facturaDto(d, usuarios)),
        truncado: lista.length >= MAX_FACTURAS_LISTA,
      };
    });
  }

  async function cargar(code) {
    if (typeof code !== "string" || !/^RC-\d{7,}$/.test(code)) throw new ErrorPedido("DATOS_INVALIDOS", "código de recibo inválido (RC-0000001)");
    const d = await documentos.obtener({ code });
    if (!d || d.tipo !== DEF_RECIBO.tipo) throw new ErrorPedido("NO_ENCONTRADO", "recibo no encontrado");
    if (d.payload?.doc?.factura?.requerida !== true) throw new ErrorPedido("ESTADO_INVALIDO", "este recibo no pidió factura");
    return d;
  }

  /** Marca la factura como emitida. El número es opcional, salvo que la empresa lo haya vuelto obligatorio. */
  async function marcarEmitida({ empresaId, actor, code, numero, esperaVersion }) {
    exigir(actor, "documento:editar");
    const n = validarNumeroFactura(numero);
    const empresa = await empresaDe(empresaId);
    if (n === null && numeroObligatorio(empresa)) throw new ErrorPedido("DATOS_INVALIDOS", "numero: esta empresa pide el número de la factura (por ejemplo F001-123)");
    return await conEmpresa(empresaId, async () => {
      const d = await cargar(code);
      if (d.estado !== "emitido") throw new ErrorPedido("ESTADO_INVALIDO", "esta factura ya está marcada como emitida");
      const doc = d.payload.doc;
      const nuevo = await documentos.transicionar({
        code, a: "facturado", usuarioId: actor.usuarioId, permisos: actor.permisos,
        esperaVersion: esperaVersion ?? d.version,
        doc: { ...doc, factura: { ...doc.factura, emision: { numero: n, usuarioId: actor.usuarioId ?? null, ts: new Date().toISOString() } } },
      });
      return facturaDto(nuevo, await nombres([nuevo]));
    });
  }

  /** Vuelve la factura a pendiente (se marcó por error, o la factura se anuló). Pide un motivo; queda en el historial. */
  async function deshacer({ empresaId, actor, code, motivo, esperaVersion }) {
    exigir(actor, "documento:editar");
    if (!motivo || !MOTIVOS_FACTURA.includes(motivo.codigo)) throw new ErrorPedido("DATOS_INVALIDOS", `motivo.codigo: uno de ${MOTIVOS_FACTURA.join(", ")}`);
    const detalle = typeof motivo.detalle === "string" ? motivo.detalle.trim().slice(0, 200) : "";
    if (motivo.codigo === "otro" && !detalle) throw new ErrorPedido("DATOS_INVALIDOS", "motivo.detalle: cuenta el motivo");
    return await conEmpresa(empresaId, async () => {
      const d = await cargar(code);
      if (d.estado !== "facturado") throw new ErrorPedido("ESTADO_INVALIDO", "esta factura no está marcada como emitida");
      const doc = d.payload.doc;
      const nuevo = await documentos.transicionar({
        code, a: "emitido", usuarioId: actor.usuarioId, permisos: actor.permisos,
        esperaVersion: esperaVersion ?? d.version,
        motivo: { codigo: motivo.codigo, ...(detalle ? { detalle } : {}) },
        doc: { ...doc, factura: { ...doc.factura, emision: null } },
      });
      return facturaDto(nuevo, new Map());
    });
  }

  return { listar, marcarEmitida, deshacer };
}
