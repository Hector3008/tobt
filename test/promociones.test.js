import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ErrorDocumento, ErrorCatalogo, ErrorFidelizacion, calcularDescuento, evaluarPromociones, permite } from "core";
import { crearServicio, TIPO_ITEM, TIPO_PEDIDO, TIPO_RECIBO } from "../src/index.js";
import { armarCuenta, armarRecibo, reciboDto } from "../src/recibo.js";
import { extraerConsumo } from "../src/fuente-puntos.js";

// Promociones en el pedido (5.42). Núcleo falso en memoria (como servicio-logica.test.js) con el evaluador REAL de
// `core` detrás de `core.promociones.evaluar`: lo que se prueba aquí es cómo `tobt` arma las líneas, aplica el resultado
// a los ítems y lo recalcula cuando el pedido cambia. Las reglas de cada promoción se prueban en `core`.

const ZONA = "America/Lima";
// Jueves 22 de octubre de 2026 (hora de Lima = UTC−5)
const LIMA = (hhmm, dia = 22) => new Date(`2026-10-${dia}T${hhmm}:00-05:00`).toISOString();

function nucleoFalso({ promos = [], reloj }) {
  const docs = new Map();
  const tipos = { doc_item: TIPO_ITEM, pedido: TIPO_PEDIDO, recibo: TIPO_RECIBO };
  const contadores = {};
  const llamadas = [];
  const catalogoItems = {
    LATTE: { nombre: "Latte", precio: 10, categoria: "Cafés" },
    CAPPU: { nombre: "Capuchino", precio: 8, categoria: "Cafés" },
    TORTA: { nombre: "Torta", precio: 12, categoria: "Postres" },
    SINPRECIO: { nombre: "Especial", precio: null, categoria: "Cafés" },
  };
  const err = (c, m) => new ErrorDocumento(c, m);
  const core = {
    llamadas,
    docs,
    promos,
    evaluaciones: [],
    catalogo: {
      moneda: async () => "PEN",
      async instantanea({ items }) {
        return items.map((it) => {
          if (typeof it === "object") return { origen: "libre", itemId: null, codigo: null, nombre: it.libre.nombre, precio: it.libre.precio ?? null, categoria: null, atributos: {} };
          const i = catalogoItems[it.toUpperCase()];
          if (!i) throw new ErrorCatalogo("ITEM_NO_DISPONIBLE", `no disponible: ${it}`, { noEncontrados: [it], inactivos: [] });
          return { origen: "catalogo", itemId: "id-" + it, codigo: it.toUpperCase(), ...i, atributos: {} };
        });
      },
    },
    clientes: { instantanea: async ({ clienteId }) => ({ clienteId, nombre: "Ana", telefono: "+51987654321" }) },
    promociones: {
      async evaluar({ lineas, ahora }) {
        core.evaluaciones.push(structuredClone(lineas));
        if (core.fallaEvaluar) throw new Error("evaluar caído");
        return evaluarPromociones({ lineas, promociones: core.promos, ahora, zona: ZONA });
      },
    },
    documentos: {
      async crear({ tipo, snapshot, doc, usuarioId }) {
        llamadas.push(["crear", tipo]);
        contadores[tipo] = (contadores[tipo] ?? 0) + 1;
        const t = tipos[tipo];
        const d = { tipo, code: `${t.prefijo}-${String(contadores[tipo]).padStart(7, "0")}`, estado: t.estadoInicial, version: 1, snapshot, payload: { doc }, creadoPor: usuarioId, historial: [{ de: null, a: t.estadoInicial }], createdAt: reloj.ahora };
        docs.set(d.code, d);
        return structuredClone(d);
      },
      async obtener({ code }) { const d = docs.get(code); return d ? structuredClone(d) : null; },
      async listar({ tipo, estado }) {
        const lista = estado === undefined ? null : [].concat(estado);
        return [...docs.values()].filter((d) => d.tipo === tipo && (!lista || lista.includes(d.estado))).map((d) => structuredClone(d));
      },
      async nuevaVersion(p) {
        llamadas.push(["nuevaVersion", p.code]);
        const d = docs.get(p.code);
        if (core.conflictos > 0 && d.tipo === "doc_item" && p.doc?.promociones) {
          core.conflictos--;
          throw err("CONFLICTO_VERSION", "otro cambió el documento");
        }
        if (p.esperaVersion !== undefined && p.esperaVersion !== d.version) throw err("CONFLICTO_VERSION", "otro cambió el documento");
        if (!tipos[d.tipo].editables.includes(d.estado)) throw err("ESTADO_NO_EDITABLE", "no editable");
        if (p.doc) d.payload = { doc: p.doc }; if (p.snapshot) d.snapshot = p.snapshot; d.version++;
        return structuredClone(d);
      },
      async transicionar(p) {
        llamadas.push(["transicionar", p.code, p.a]);
        const d = docs.get(p.code);
        const t = tipos[d.tipo];
        if (p.esperaVersion !== undefined && p.esperaVersion !== d.version) throw err("CONFLICTO_VERSION", "otro cambió el documento");
        if (!(t.transiciones[d.estado] ?? []).includes(p.a)) throw err("TRANSICION_INVALIDA", `${d.estado} → ${p.a}`);
        const req = t.permisos?.[p.a];
        if (req && !p.sistema && !permite(p.permisos ?? [], req)) throw err("PERMISO_INSUFICIENTE", `falta ${req}`);
        if (t.motivos?.[p.a] && !t.motivos[p.a].includes(p.motivo?.codigo)) throw err("MOTIVO_REQUERIDO", "motivo");
        if (p.doc) d.payload = { doc: p.doc };
        if (p.snapshot) d.snapshot = p.snapshot;
        d.historial.push({ de: d.estado, a: p.a, motivo: p.motivo });
        d.estado = p.a;
        return structuredClone(d);
      },
    },
  };
  return core;
}

let seq = 0;
const P = (o) => ({
  id: o.id ?? `p${++seq}`, nombre: "Promo", activa: true, prioridad: 100, acumulable: false, descripcion: null,
  objetivo: null, disparador: null, n: null, m: null, efecto: null, valor: null, vigencia: null, dias: null, horario: null, ...o,
});
const item = (itemCodigo) => ({ itemCodigo, categoria: null });
const cat = (categoria) => ({ itemCodigo: null, categoria });
const DOS_X_UNO = (extra = {}) => P({ id: "2x1", nombre: "2x1 en lattes", tipo: "nxm", n: 2, m: 1, objetivo: item("LATTE"), ...extra });
const TORTA_CAFE = (extra = {}) => P({ id: "combo", nombre: "Torta con café", tipo: "combo", disparador: item("TORTA"), objetivo: cat("Cafés"), efecto: "porcentaje", valor: 50, ...extra });
const HAPPY = (extra = {}) => P({ id: "happy", nombre: "Happy hour", tipo: "directo", objetivo: item("LATTE"), efecto: "porcentaje", valor: 50, horario: { desde: "18:00", hasta: "21:00" }, ...extra });

const ADMIN = { usuarioId: "u1", permisos: ["*"] };
const MESERO = { usuarioId: "u2", permisos: ["documento:crear", "documento:leer", "documento:editar", "estacion:creacion", "fidelizacion:canjear"] };
const COCINA = { usuarioId: "u5", permisos: ["documento:leer", "documento:editar", "estacion:cocina"] };
const CAJERO = { usuarioId: "u4", permisos: ["documento:crear", "documento:leer", "documento:editar", "estacion:administracion", "estacion:creacion", "fidelizacion:canjear"] };
const E = "e1";
const cod = (c) => (e) => e?.codigo === c;
const m = (actor, code, extra = {}) => ({ empresaId: E, actor, code, ...extra });

describe("promociones en el pedido (5.42)", () => {
  let core, svc, reloj;
  const montar = (promos) => {
    reloj = { ahora: LIMA("20:00") };
    core = nucleoFalso({ promos, reloj });
    svc = crearServicio(core);
  };
  const abrir = (items, actor = MESERO) => svc.pedidos.crear({ empresaId: E, actor, canal: "salon", mesa: "4", items });
  const pedir = (code, items, actor = MESERO) => svc.pedidos.agregarItems({ empresaId: E, actor, code, items });
  const ver = (code = "PD-0000001") => svc.pedidos.obtener(m(MESERO, code));
  const A = "DOC_ITEM-0000001", B = "DOC_ITEM-0000002", C = "DOC_ITEM-0000003", D = "DOC_ITEM-0000004";
  const de = (c, code) => c.items.find((i) => i.code === code);
  const entregar = async (code) => {
    await svc.items.marcarLista(m(COCINA, code));
    await svc.items.entregar(m(MESERO, code));
  };
  const nuevasVersiones = () => core.llamadas.filter((l) => l[0] === "nuevaVersion" && l[1].startsWith("DOC_ITEM")).length;

  beforeEach(() => montar([DOS_X_UNO()]));

  describe("recalcular al pedir", () => {
    it("el 2x1 se forma entre ítems pedidos por separado: el segundo latte sale gratis y el pedido lo dice", async () => {
      const c1 = await abrir([{ codigo: "LATTE" }]);
      assert.equal(c1.total, 10);
      assert.equal(c1.ahorroPromociones, 0);
      assert.deepEqual(de(c1, A).promociones, []);
      const c2 = await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      assert.equal(de(c2, A).subtotal, 10);
      assert.equal(de(c2, B).subtotal, 0);
      assert.equal(de(c2, B).subtotalBase, 10);
      assert.deepEqual(de(c2, B).promociones, [{ id: "2x1", nombre: "2x1 en lattes", monto: 10, unidades: 1 }]);
      assert.equal(c2.total, 10);
      assert.equal(c2.ahorroPromociones, 10);
      assert.equal(c2.promocionesError, undefined);
    });

    it("una línea con cantidad 2 también: el descuento cae en esa línea y el precio por unidad no cambia", async () => {
      const c = await abrir([{ codigo: "LATTE", cantidad: 2 }, { codigo: "TORTA" }]);
      assert.equal(de(c, A).subtotalBase, 20);
      assert.equal(de(c, A).subtotal, 10);
      assert.equal(de(c, A).precio, 10);
      assert.equal(de(c, B).subtotal, 12);
      assert.equal(c.total, 22);
    });

    it("sin promociones el pedido sale como antes: base igual al subtotal y sin ahorro", async () => {
      montar([]);
      const c = await abrir([{ codigo: "LATTE", cantidad: 2 }]);
      assert.deepEqual([de(c, A).subtotal, de(c, A).subtotalBase, c.ahorroPromociones], [20, 20, 0]);
      assert.equal(nuevasVersiones(), 0);
    });

    it("un combo se forma aunque el disparador llegue después que el objetivo", async () => {
      montar([TORTA_CAFE()]);
      const c1 = await abrir([{ codigo: "CAPPU" }]);
      assert.equal(c1.total, 8);
      const c2 = await pedir("PD-0000001", [{ codigo: "TORTA" }]);
      assert.equal(de(c2, A).subtotal, 4); // el café lleva 50 %
      assert.equal(de(c2, B).subtotal, 12);
      assert.equal(c2.total, 16);
    });

    it("recalcular no escribe de más: un recálculo sin cambios no crea versiones", async () => {
      await abrir([{ codigo: "LATTE" }]);
      await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      const antes = nuevasVersiones();
      await pedir("PD-0000001", [{ codigo: "TORTA" }]); // no cambia nada de lo ya calculado
      assert.equal(nuevasVersiones(), antes);
    });

    it("las líneas libres, los ítems sin precio y los anulados no entran al cálculo", async () => {
      const c = await abrir([{ libre: { nombre: "Extra", precio: 3 } }, { codigo: "SINPRECIO" }, { codigo: "LATTE" }, { codigo: "LATTE" }]);
      const lineas = core.evaluaciones.at(-1);
      assert.deepEqual(lineas.map((l) => l.id), [C, D]);
      assert.equal(de(c, A).subtotal, 3);
      assert.equal(de(c, B).subtotal, null);
      assert.equal(c.total, null); // un ítem sin precio deja el total en null, como siempre
    });

    it("cada línea viaja con su categoría, su código y la hora en que se pidió", async () => {
      await abrir([{ codigo: "LATTE" }]);
      assert.deepEqual(core.evaluaciones.at(-1), [{ id: A, codigo: "LATTE", categoria: "Cafés", cantidad: 1, precio: 10, ahora: LIMA("20:00") }]);
    });
  });

  describe("anular", () => {
    it("anular el ítem que recibía la promoción deja el otro a su precio; el anulado no cuenta", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      await svc.items.anular(m(MESERO, B, { motivo: { codigo: "error_pedido" } }));
      const c = await ver();
      assert.equal(de(c, A).subtotal, 10);
      assert.equal(c.total, 10);
      assert.equal(c.ahorroPromociones, 0);
    });

    it("anular el primer latte también: el que quedó ya no tiene con quién formar el 2x1 y vuelve a su precio", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      await svc.items.anular(m(MESERO, A, { motivo: { codigo: "error_pedido" } }));
      const c = await ver();
      assert.equal(de(c, B).subtotal, 10);
      assert.deepEqual(de(c, B).promociones, []);
    });

    it("quitar la torta quita el descuento del café; volver a pedirla lo devuelve", async () => {
      montar([TORTA_CAFE()]);
      await abrir([{ codigo: "TORTA" }, { codigo: "CAPPU" }]);
      assert.equal((await ver()).total, 16);
      await svc.items.anular(m(MESERO, A, { motivo: { codigo: "error_pedido" } }));
      assert.equal((await ver()).total, 8);
      await pedir("PD-0000001", [{ codigo: "TORTA" }]);
      assert.equal((await ver()).total, 16);
    });
  });

  describe("la hora en que se pidió cada ítem", () => {
    it("un happy hour concedido dentro del horario no se quita porque después se pida algo fuera de él", async () => {
      montar([HAPPY()]);
      await abrir([{ codigo: "LATTE" }]); // 20:00
      assert.equal(de(await ver(), A).subtotal, 5);
      reloj.ahora = LIMA("21:30");
      const c = await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      assert.equal(de(c, A).subtotal, 5); // se conserva
      assert.equal(de(c, B).subtotal, 10); // este se pidió fuera del horario
    });

    it("un ítem pedido fuera del horario no gana el descuento aunque se recalcule dentro de él", async () => {
      montar([HAPPY()]);
      reloj.ahora = LIMA("17:00");
      await abrir([{ codigo: "LATTE" }]);
      reloj.ahora = LIMA("19:00");
      const c = await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      assert.equal(de(c, A).subtotal, 10);
      assert.equal(de(c, B).subtotal, 5);
    });
  });

  describe("cuenta dividida: ítems pagados", () => {
    it("un ítem pagado sigue contando para el grupo: cobrarlo no rompe el 2x1 de los demás ni lo cambia", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      await entregar(A);
      await entregar(B);
      await svc.pedidos.cobrarItems(m(CAJERO, "PD-0000001", { items: [A] }));
      const versionA = (await svc.items.obtener(m(MESERO, A))).version;
      const c = await pedir("PD-0000001", [{ codigo: "TORTA" }]); // dispara un recálculo
      assert.equal(de(c, A).estado, "pagado");
      assert.equal(de(c, A).subtotal, 10);
      assert.equal(de(c, B).subtotal, 0); // sigue gratis
      assert.equal((await svc.items.obtener(m(MESERO, A))).version, versionA); // el pagado no se tocó
      assert.equal(c.total, 22);
      assert.equal(c.cobrado, 10);
      assert.equal(c.porCobrar, 12);
    });

    it("al cobrar, el monto es el subtotal ya rebajado y los puntos salen de ahí", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      await entregar(A);
      await entregar(B);
      const r = await svc.pedidos.cobrar(m(CAJERO, "PD-0000001"));
      assert.equal(r.estado, "pagado");
      assert.equal(r.doc.total, 10);
      assert.equal(extraerConsumo(core.docs.get(B)).monto, 0);
      assert.equal(extraerConsumo(core.docs.get(A)).monto, 10);
    });

    it("un pedido ya cerrado no se recalcula", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      await entregar(A);
      await entregar(B);
      await svc.pedidos.cobrar(m(CAJERO, "PD-0000001"));
      core.evaluaciones.length = 0;
      await assert.rejects(pedir("PD-0000001", [{ codigo: "LATTE" }]), cod("ESTADO_INVALIDO"));
      assert.equal(core.evaluaciones.length, 0);
    });
  });

  describe("cambiar el precio", () => {
    it("con otro precio la promoción se recalcula sobre la base nueva", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      // B es el gratis (10). Se corrige su precio a 20: ahora el más barato es A, que pasa a ser el gratis
      const it = await svc.items.cambiarPrecio(m(CAJERO, B, { precio: 20 }));
      const c = await ver();
      assert.equal(it.subtotalBase, 20);
      assert.equal(de(c, A).subtotal, 0);
      assert.equal(de(c, B).subtotal, 20);
      assert.equal(c.total, 20);
    });

    it("la respuesta trae el ítem ya recalculado", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      const it = await svc.items.cambiarPrecio(m(CAJERO, A, { precio: 4 }));
      assert.equal(it.subtotalBase, 4);
      assert.equal(it.subtotal, 0);
      assert.equal(it.promociones[0].monto, 4);
    });
  });

  describe("vale y promoción no se suman", () => {
    const conVales = () => {
      const vales = new Map([["K7M2QX", { estado: "activo", cliente: { id: "64b7f0f0f0f0f0f0f0f0f0f0", nombre: "Ana" }, beneficio: { nombre: "Descuento" }, beneficioCompleto: { tipo: "descuento_porcentaje", valor: 50, itemCodigo: null } }]]);
      const llamadas = [];
      core.fidelizacion = {
        tickets: {
          consultar: async ({ codigo }) => {
            const v = vales.get(codigo);
            if (!v) throw new ErrorFidelizacion("NO_ENCONTRADO", "vale no encontrado");
            return { codigo, ...structuredClone(v) };
          },
          consumir: async ({ codigo }) => { llamadas.push(["consumir", codigo]); vales.get(codigo).estado = "usado"; },
          liberar: async ({ codigo }) => { llamadas.push(["liberar", codigo]); vales.get(codigo).estado = "activo"; },
          calcularDescuento,
        },
      };
      return { vales, llamadas };
    };

    it("un ítem con promoción no admite un vale y el vale no se gasta", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      const { vales, llamadas } = conVales();
      await assert.rejects(svc.items.aplicarVale(m(MESERO, B, { codigo: "K7M2QX" })), (e) => e.codigo === "ESTADO_INVALIDO" && /promoción/.test(e.message));
      assert.equal(vales.get("K7M2QX").estado, "activo");
      assert.deepEqual(llamadas, []);
    });

    it("un ítem con vale cuenta para formar el grupo pero no recibe promoción: lleva el vale o la promoción, no los dos", async () => {
      await abrir([{ codigo: "LATTE" }]);
      const { llamadas } = conVales();
      const conVale = await svc.items.aplicarVale(m(MESERO, A, { codigo: "K7M2QX" }));
      assert.equal(conVale.subtotal, 5);
      assert.deepEqual(llamadas, [["consumir", "K7M2QX"]]);
      const c = await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      assert.equal(de(c, A).subtotal, 5); // sigue con su vale y sin promoción
      assert.deepEqual(de(c, A).promociones, []);
      assert.equal(de(c, B).subtotal, 0); // el segundo latte forma el 2x1 con el que tiene vale
      assert.deepEqual(core.evaluaciones.at(-1).map((l) => l.id), [A, B]);
    });

    it("poner un vale a un ítem no le quita la promoción a los demás", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }, { codigo: "TORTA" }]);
      assert.equal((await ver()).total, 22); // el segundo latte es gratis
      conVales();
      await svc.items.aplicarVale(m(MESERO, C, { codigo: "K7M2QX" })); // la torta, 50 %
      const c = await ver();
      assert.equal(de(c, B).subtotal, 0);
      assert.equal(de(c, C).subtotal, 6);
      assert.equal(c.total, 16);
    });
  });

  describe("si el cálculo falla", () => {
    it("el pedido se crea igual y la respuesta avisa con promocionesError; los ítems quedan a precio completo", async () => {
      core.fallaEvaluar = true;
      const e = console.error;
      console.error = () => {};
      try {
        const c = await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
        assert.equal(c.promocionesError, true);
        assert.equal(c.total, 20);
        assert.equal(c.estado, "abierto");
      } finally {
        console.error = e;
      }
    });

    it("anular un ítem también avisa y la anulación se mantiene", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      core.fallaEvaluar = true;
      const e = console.error;
      console.error = () => {};
      try {
        const r = await svc.items.anular(m(MESERO, B, { motivo: { codigo: "error_pedido" } }));
        assert.equal(r.estado, "anulado");
        assert.equal(r.promocionesError, true);
      } finally {
        console.error = e;
      }
    });

    it("sin `core.promociones` (otro montaje) todo funciona como antes", async () => {
      delete core.promociones;
      const c = await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      assert.equal(c.total, 20);
      assert.equal(c.promocionesError, undefined);
    });

    it("un conflicto de versión se reintenta y el resultado sale completo", async () => {
      core.conflictos = 1;
      const c = await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      assert.equal(c.promocionesError, undefined);
      assert.equal(c.total, 10);
    });

    it("si el conflicto no cede, avisa en vez de quedarse en un bucle", async () => {
      core.conflictos = 99;
      const e = console.error;
      console.error = () => {};
      try {
        const c = await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
        assert.equal(c.promocionesError, true);
      } finally {
        console.error = e;
      }
    });
  });

  describe("ítems anteriores a 5.42", () => {
    it("sin subtotalBase ni promociones se leen con la base = subtotal (o lo de antes del vale) y sin promociones", async () => {
      montar([]);
      await abrir([{ codigo: "LATTE" }, { codigo: "TORTA" }]);
      for (const code of [A, B]) {
        const d = core.docs.get(code);
        delete d.payload.doc.subtotalBase;
        delete d.payload.doc.promociones;
      }
      core.docs.get(B).payload.doc.descuento = { vale: "K7M2QX", beneficio: "Descuento", monto: 6, subtotalAntes: 12 };
      core.docs.get(B).payload.doc.subtotal = 6;
      const c = await ver();
      assert.deepEqual([de(c, A).subtotalBase, de(c, A).promociones], [10, []]);
      assert.deepEqual([de(c, B).subtotalBase, de(c, B).subtotal], [12, 6]);
    });

    it("al recalcular, un ítem viejo recibe su base y su promoción", async () => {
      await abrir([{ codigo: "LATTE" }]);
      delete core.docs.get(A).payload.doc.subtotalBase;
      delete core.docs.get(A).payload.doc.promociones;
      const c = await pedir("PD-0000001", [{ codigo: "LATTE" }]);
      assert.deepEqual([de(c, A).subtotalBase, de(c, A).subtotal], [10, 10]);
      assert.equal(de(c, B).subtotal, 0);
    });
  });

  describe("listar", () => {
    it("los pedidos abiertos de la lista traen el total con promociones y su ahorro", async () => {
      await abrir([{ codigo: "LATTE" }, { codigo: "LATTE" }]);
      const [p] = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["abierto"] });
      assert.equal(p.total, 10);
      assert.equal(p.ahorroPromociones, 10);
    });
  });
});

describe("recibos y cuenta con promociones (5.42)", () => {
  const it0 = (code, nombre, cantidad, precio, extra = {}) => ({ code, nombre, codigo: nombre.toUpperCase(), cantidad, precio, subtotal: cantidad * precio, descuento: null, promociones: [], cliente: null, estado: "pagado", ...extra });
  const pedido = { code: "PD-0000001", estado: "abierto", canal: "salon", mesa: "4", referencia: null, moneda: "PEN", cliente: null, creadoTs: "2026-10-22T20:00:00Z" };
  const promo = (monto) => [{ id: "2x1", nombre: "2x1 en lattes", monto, unidades: 1 }];

  it("el recibo lleva por renglón sus promociones y en total lo descontado; el subtotal ya viene rebajado", () => {
    const items = [it0("DOC_ITEM-1", "Latte", 1, 10), it0("DOC_ITEM-2", "Latte", 1, 10, { subtotal: 0, subtotalBase: 10, promociones: promo(10) })];
    const r = armarRecibo({ pedido, items });
    assert.deepEqual([r.subtotal, r.total, r.promociones, r.descuentos], [10, 10, 10, 0]);
    assert.deepEqual(r.lineas[1].promociones, [{ nombre: "2x1 en lattes", monto: 10 }]);
    assert.deepEqual(r.lineas[0].promociones, []);
  });

  it("el recibo guardado devuelve el total de promociones y los recibos viejos, 0", () => {
    const doc = armarRecibo({ pedido, items: [it0("DOC_ITEM-2", "Latte", 1, 10, { subtotal: 0, promociones: promo(10) })] });
    assert.equal(reciboDto({ code: "RC-0000001", payload: { doc } }).promociones, 10);
    const { promociones, ...viejo } = doc;
    assert.equal(reciboDto({ code: "RC-0000002", payload: { doc: viejo } }).promociones, 0);
  });

  it("la cuenta suma lo descontado por promociones de lo que no está anulado", () => {
    const cuenta = armarCuenta({
      pedido: { ...pedido, items: [it0("DOC_ITEM-1", "Latte", 1, 10, { estado: "entregado" }), it0("DOC_ITEM-2", "Latte", 1, 10, { subtotal: 0, promociones: promo(10), estado: "entregado" }), it0("DOC_ITEM-3", "Latte", 1, 10, { subtotal: 0, promociones: promo(10), estado: "anulado" })] },
    });
    assert.deepEqual([cuenta.promociones, cuenta.total, cuenta.lineas.length], [10, 10, 2]);
  });
});

// ---------- topes de usos (5.44) ----------
// El núcleo falso trae contadores con el mismo contrato que `core.promociones.cupos/confirmarUsos/liberarUsos`
// (el comportamiento real de los contadores se prueba en `core`); aquí se prueba cómo `tobt` los usa.
function conContadores(core) {
  const reservas = new Map(); // referencia → { clienteId, usos: { idPromo: n } }
  const total = (id) => [...reservas.values()].reduce((n, r) => n + (r.usos[id] ?? 0), 0);
  const delCliente = (id, cli) => [...reservas.values()].filter((r) => r.clienteId === cli).reduce((n, r) => n + (r.usos[id] ?? 0), 0);
  const conTope = () => core.promos.filter((p) => p.activa && (p.topes?.diario || p.topes?.porCliente));
  core.reservas = reservas;
  core.total = total;
  core.promociones.cupos = async ({ referencia, clienteId }) => {
    const mia = reservas.get(referencia);
    const salida = {};
    for (const p of conTope()) {
      let max = Infinity;
      let motivo = "dia";
      const mio = mia?.usos[p.id] ?? 0;
      if (p.topes.diario) max = mio + Math.max(0, p.topes.diario - total(p.id));
      if (p.topes.porCliente) {
        const t = clienteId ? (mia?.clienteId === clienteId ? mio : 0) + Math.max(0, p.topes.porCliente - delCliente(p.id, clienteId)) : 0;
        if (t < max) [max, motivo] = [t, clienteId ? "cliente" : "sin_cliente"];
      }
      salida[p.id] = { max, motivo };
    }
    return salida;
  };
  core.promociones.confirmarUsos = async ({ referencia, clienteId, usos }) => {
    core.confirmaciones = (core.confirmaciones ?? 0) + 1;
    const previo = Object.fromEntries(Object.entries(reservas.get(referencia)?.usos ?? {}).map(([k, v]) => [k, { usos: v }]));
    const antes = reservas.get(referencia);
    const nuevo = { clienteId, usos: Object.fromEntries(Object.entries(usos).filter(([, n]) => n > 0)) };
    reservas.delete(referencia);
    for (const p of conTope()) {
      const n = nuevo.usos[p.id] ?? 0;
      const excede = (p.topes.diario && total(p.id) + n > p.topes.diario) || (p.topes.porCliente && n > 0 && (!clienteId || delCliente(p.id, clienteId) + n > p.topes.porCliente));
      if (excede && !core.permitirExceso) {
        if (antes) reservas.set(referencia, antes);
        return { ok: false };
      }
    }
    if (Object.keys(nuevo.usos).length) reservas.set(referencia, nuevo);
    return { ok: true, previo };
  };
  core.promociones.liberarUsos = async ({ referencia }) => void reservas.delete(referencia);
  const evaluar = core.promociones.evaluar;
  core.promociones.evaluar = (p) => evaluarPromociones({ lineas: p.lineas, promociones: core.promos, ahora: p.ahora, zona: ZONA, cupos: p.cupos });
  void evaluar;
  return core;
}

describe("topes de usos de las promociones (5.44)", () => {
  let core, svc;
  const montar = (promos) => {
    core = conContadores(nucleoFalso({ promos, reloj: { ahora: LIMA("20:00") } }));
    svc = crearServicio(core);
  };
  const abrir = (items, extra = {}) => svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "salon", mesa: "4", items, ...extra });
  const pedir = (code, items) => svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code, items });
  const lattes = (n) => Array.from({ length: n }, () => ({ codigo: "LATTE" }));
  const GRATIS = (topes, extra = {}) => P({ id: "g", nombre: "Latte gratis", tipo: "directo", objetivo: item("LATTE"), efecto: "gratis", topes, ...extra });

  it("el tope diario es de toda la empresa: el segundo pedido ya no recibe descuento y el aviso lo dice", async () => {
    montar([GRATIS({ diario: 2 })]);
    const a = await abrir(lattes(3));
    assert.equal(a.total, 10);
    assert.deepEqual(a.promocionesAviso.map((x) => [x.id, x.motivo]), [["g", "dia"]]);
    assert.equal(core.total("g"), 2);
    const b = await abrir(lattes(2));
    assert.equal(b.total, 20);
    assert.equal(b.promocionesAviso[0].motivo, "dia");
    assert.equal(core.total("g"), 2);
  });

  it("sin tope alcanzado no hay aviso, y recalcular no cuenta dos veces los mismos usos", async () => {
    montar([GRATIS({ diario: 5 })]);
    const a = await abrir(lattes(2));
    assert.equal(a.promocionesAviso, undefined);
    await pedir(a.code, lattes(1));
    await pedir(a.code, [{ codigo: "TORTA" }]);
    assert.equal(core.total("g"), 3);
  });

  it("al anular el pedido sus usos se liberan y otro pedido puede aprovecharlos", async () => {
    montar([GRATIS({ diario: 2 })]);
    const a = await abrir(lattes(2));
    assert.equal(core.total("g"), 2);
    const b = await abrir(lattes(1));
    assert.equal(b.total, 10);
    await svc.pedidos.anular({ empresaId: E, actor: ADMIN, code: a.code, motivo: { codigo: "error_pedido" } });
    assert.equal(core.total("g"), 0);
    const c = await pedir(b.code, lattes(1));
    assert.equal(c.total, 0, "con cupo libre el pedido recupera su descuento (los dos lattes salen gratis)");
    assert.equal(core.total("g"), 2);
  });

  it("anular el último ítem libera los usos aunque el pedido siga abierto", async () => {
    montar([GRATIS({ diario: 2 })]);
    const a = await abrir(lattes(1));
    assert.equal(core.total("g"), 1);
    await svc.items.anular(m(MESERO, "DOC_ITEM-0000001", { motivo: { codigo: "error_pedido" } }));
    assert.equal(core.total("g"), 0);
  });

  it("el tope por cliente exige cliente: sin él avisa «sin_cliente»; al asociarlo se recalcula y se aplica", async () => {
    montar([GRATIS({ porCliente: 1 })]);
    const a = await abrir(lattes(2));
    assert.equal(a.total, 20);
    assert.equal(a.promocionesAviso[0].motivo, "sin_cliente");
    const b = await svc.pedidos.asociarCliente({ empresaId: E, actor: MESERO, code: a.code, clienteId: "c1" });
    assert.equal(b.total, 10);
    assert.equal(b.promocionesAviso[0].motivo, "cliente");
    assert.equal(core.total("g"), 1);
    const quitado = await svc.pedidos.asociarCliente({ empresaId: E, actor: MESERO, code: a.code, clienteId: null });
    assert.equal(quitado.total, 20);
    assert.equal(core.total("g"), 0);
  });

  it("el tope por pedido lo resuelve el evaluador sin contadores", async () => {
    montar([GRATIS({ porPedido: 1 })]);
    const a = await abrir(lattes(3));
    assert.equal(a.total, 20);
    assert.equal(a.promocionesAviso[0].motivo, "pedido");
  });

  it("si no se pudieron guardar los ítems, los usos vuelven a como estaban", async () => {
    montar([GRATIS({ diario: 5 })]);
    const a = await abrir(lattes(1));
    assert.equal(core.total("g"), 1);
    core.conflictos = 99;
    const e = console.error;
    console.error = () => {};
    try {
      const r = await pedir(a.code, lattes(2));
      assert.equal(r.promocionesError, true);
    } finally {
      console.error = e;
    }
    assert.equal(core.total("g"), 1, "no quedó reservado lo que no se guardó");
  });

  it("si los cupos cambian a la vez (otro pedido se llevó el último) se reintenta y se respeta el tope", async () => {
    montar([GRATIS({ diario: 1 })]);
    const original = core.promociones.confirmarUsos;
    let robado = false;
    core.promociones.confirmarUsos = async (p) => {
      if (!robado) {
        robado = true;
        core.reservas.set("OTRO", { clienteId: null, usos: { g: 1 } }); // otro pedido toma el único cupo justo antes
      }
      return original(p);
    };
    const a = await abrir(lattes(2));
    assert.equal(a.total, 20);
    assert.equal(a.promocionesError, undefined, "se reintentó con los cupos nuevos");
    assert.equal(a.promocionesAviso[0].motivo, "dia");
    assert.equal(core.total("g"), 1, "solo el del otro pedido");
  });

  it("si el cupo no deja de cambiar, avisa en vez de repetir sin fin", async () => {
    montar([GRATIS({ diario: 1 })]);
    core.promociones.confirmarUsos = async () => ({ ok: false });
    const e = console.error;
    console.error = () => {};
    try {
      const a = await abrir(lattes(2));
      assert.equal(a.promocionesError, true);
      assert.equal(a.total, 20);
    } finally {
      console.error = e;
    }
  });

  it("un ítem ya pagado conserva sus usos: no se cuentan dos veces ni se le quita el descuento", async () => {
    montar([GRATIS({ diario: 1 })]);
    const a = await abrir(lattes(2)); // el primero sale gratis (1 uso)
    await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
    await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
    await svc.pedidos.cobrarItems?.({ empresaId: E, actor: ADMIN, code: a.code, items: ["DOC_ITEM-0000001"] });
    const c = await pedir(a.code, lattes(1));
    assert.equal(core.total("g"), 1);
    assert.equal(c.items.find((i) => i.code === "DOC_ITEM-0000001").subtotal, 0);
    assert.equal(c.items.find((i) => i.code === "DOC_ITEM-0000003").subtotal, 10);
  });

  it("lo ya cobrado cuenta con los usos que guardó, aunque la evaluación nueva se los repartiría distinto", async () => {
    montar([GRATIS({ diario: 2 })]);
    const a = await abrir([{ codigo: "LATTE" }, { codigo: "TORTA" }]);
    const A = "DOC_ITEM-0000001";
    await svc.items.marcarLista(m(COCINA, A));
    await svc.items.entregar(m(MESERO, A));
    await svc.pedidos.cobrarItems({ empresaId: E, actor: ADMIN, code: a.code, items: [A] });
    // El ítem pagado guardó 2 usos (p. ej. de una regla anterior) y el pedido los tiene reservados.
    core.docs.get(A).payload.doc.promociones = [{ id: "g", nombre: "Latte gratis", monto: 10, unidades: 2 }];
    core.reservas.set(a.code, { clienteId: null, usos: { g: 2 } });
    const c = await pedir(a.code, lattes(1));
    assert.equal(c.promocionesError, undefined);
    assert.equal(c.items.find((i) => i.code === "DOC_ITEM-0000003").subtotal, 10, "no queda cupo para el nuevo");
    assert.equal(core.total("g"), 2);
  });

  it("sin los contadores del núcleo (un núcleo anterior) todo sigue como antes", async () => {
    montar([GRATIS({ diario: 1 })]);
    delete core.promociones.cupos;
    const a = await abrir(lattes(2));
    assert.equal(a.total, 0, "sin contadores el tope diario no se aplica (no hay con qué contarlo), pero nada se rompe");
    assert.equal(a.promocionesAviso, undefined);
    assert.equal(a.promocionesError, undefined);
  });
});
