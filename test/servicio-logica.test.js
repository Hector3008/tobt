import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ErrorDocumento, ErrorCatalogo, ErrorFidelizacion, calcularDescuento, permite } from "core";
import { crearServicio, ErrorPedido, TIPO_ITEM, TIPO_PEDIDO, TIPO_RECIBO } from "../src/index.js";
import { montarRutas } from "../src/http.js";

// Núcleo falso en memoria: prueba la lógica del servicio y las rutas sin base de datos. El motor falso
// aplica las reglas reales de los dos tipos (transiciones, permisos de estado, motivos, editables y
// versión esperada), así que lo que se comprueba aquí es la composición pedido ↔ ítems.
// Las reglas del motor de verdad se prueban en pedidos.test.js (MongoDB real).
function nucleoFalso() {
  const docs = new Map();
  const tipos = { doc_item: TIPO_ITEM, pedido: TIPO_PEDIDO, recibo: TIPO_RECIBO };
  const contadores = {};
  const llamadas = [];
  const catalogoItems = {
    "CAFE-1": { nombre: "Café", precio: 6.5, categoria: "bebidas" },
    "SAND-1": { nombre: "Sándwich", precio: 12, categoria: "comida" },
    "SINPRECIO": { nombre: "Especial", precio: null, categoria: null },
  };
  const err = (c, m) => new ErrorDocumento(c, m);
  return {
    llamadas,
    docs,
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
    clientes: { instantanea: async ({ clienteId, campos }) => ({ clienteId, nombre: "Ana", telefono: "+51987654321", campos }) },
    documentos: {
      async crear({ tipo, snapshot, doc, usuarioId }) {
        llamadas.push(["crear", tipo]);
        contadores[tipo] = (contadores[tipo] ?? 0) + 1;
        const t = tipos[tipo];
        const d = { tipo, code: `${t.prefijo}-${String(contadores[tipo]).padStart(7, "0")}`, estado: t.estadoInicial, version: 1, snapshot, payload: { doc }, creadoPor: usuarioId, historial: [{ de: null, a: t.estadoInicial }], createdAt: new Date(2026, 9, 11, 21, contadores[tipo]).toISOString() };
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
        if (p.esperaVersion !== undefined && p.esperaVersion !== d.version) throw err("CONFLICTO_VERSION", "otro cambió el documento");
        if (!tipos[d.tipo].editables.includes(d.estado)) throw err("ESTADO_NO_EDITABLE", "no editable");
        if (p.doc) d.payload = { doc: p.doc }; if (p.snapshot) d.snapshot = p.snapshot; d.version++;
        return structuredClone(d);
      },
      async transicionar(p) {
        llamadas.push(["transicionar", p.code, p.a, p.sistema ? "sistema" : p.usuarioId]);
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
}

// Fidelización falsa por ítem: `puntos(item)` recibe { subtotal, cliente } y devuelve lo que daría el núcleo
function conPuntosPorItem(core, puntos) {
  const llamadas = [];
  core.fidelizacion = {
    acumularPorDocumento: async ({ code }) => {
      llamadas.push(code);
      const d = core.docs.get(code);
      return puntos({ subtotal: d.payload.doc.subtotal, cliente: d.snapshot?.cliente?.clienteId });
    },
  };
  return llamadas;
}

const ADMIN = { usuarioId: "u1", permisos: ["*"] };
const MESERO = { usuarioId: "u2", permisos: ["documento:crear", "documento:leer", "documento:editar", "estacion:creacion"] };
const COCINA = { usuarioId: "u5", permisos: ["documento:leer", "documento:editar", "estacion:cocina"] };
const CAJERO = { usuarioId: "u4", permisos: ["documento:crear", "documento:leer", "documento:editar", "estacion:administracion", "estacion:creacion"] };
const SOLO_LEER = { usuarioId: "u3", permisos: ["documento:leer"] };
const E = "e1";
const cod = (c) => (e) => e?.codigo === c;
const motivo = { codigo: "cortesia" };

describe("servicio: pedidos y ítems (núcleo falso)", () => {
  let core, svc;
  const nuevo = () => {
    core = nucleoFalso();
    svc = crearServicio(core);
  };
  const salon = { canal: "salon", mesa: "4" };
  const dosItems = [{ codigo: "cafe-1", cantidad: 2, notas: "sin azúcar" }, { libre: { nombre: "Torta del día", precio: 5 } }];
  const abrir = (items = dosItems, actor = MESERO) => svc.pedidos.crear({ empresaId: E, actor, ...salon, items });
  const m = (actor, code, extra = {}) => ({ empresaId: E, actor, code, ...extra });

  describe("abrir el pedido con el primer ítem", () => {
    it("el pedido nace al pedir el primer ítem, y cada ítem es un ítem propio en cocina", async () => {
      nuevo();
      const c = await abrir();
      assert.equal(c.code, "PD-0000001");
      assert.equal(c.estado, "abierto");
      assert.deepEqual(c.items.map((i) => [i.code, i.estado, i.pedidoCode, i.nombre, i.cantidad, i.subtotal]), [
        ["DOC_ITEM-0000001", "en_cocina", "PD-0000001", "Café", 2, 13],
        ["DOC_ITEM-0000002", "en_cocina", "PD-0000001", "Torta del día", 1, 5],
      ]);
      assert.equal(c.total, 18);
      assert.equal(c.moneda, "PEN");
      assert.deepEqual(c.doc.codigosItems, ["DOC_ITEM-0000001", "DOC_ITEM-0000002"]);
      assert.equal(c.items[0].notas, "sin azúcar");
    });

    it("un ítem que no existe frena todo y no crea ni el pedido", async () => {
      nuevo();
      await assert.rejects(abrir([{ codigo: "CAFE-1" }, { codigo: "NOEXISTE" }]), cod("ITEM_NO_DISPONIBLE"));
      assert.equal(core.docs.size, 0);
    });

    it("sin sesión de escritura no abre: cada operación comprueba el permiso del actor", async () => {
      nuevo();
      await assert.rejects(abrir(dosItems, SOLO_LEER), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(svc.pedidos.obtener(m(null, "PD-0000001")), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(svc.items.listar({ empresaId: E, actor: undefined }), cod("PERMISO_INSUFICIENTE"));
    });

    it("el total queda en null si algún ítem no tiene precio (nunca se inventa uno)", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SINPRECIO" }]);
      assert.equal(c.total, null);
      assert.equal(c.items[1].subtotal, null);
    });

    it("cada canal pide lo suyo y rechaza lo de los otros", async () => {
      nuevo();
      const items = [{ codigo: "CAFE-1" }];
      await assert.rejects(svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "salon", items }), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "llevar", mesa: "1", referencia: "Ana", items }), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "salon", mesa: "1", lineas: items }), cod("DATOS_INVALIDOS"));
      const d = await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "delivery", entrega: { direccion: "Av. 1", telefono: "999 111 222" }, items, clienteId: "c1" });
      assert.equal(d.snapshot.cliente.nombre, "Ana");
    });

    it("un precio propio en un ítem del catálogo exige administración y guarda el original", async () => {
      nuevo();
      const items = [{ codigo: "CAFE-1", precio: 5 }];
      await assert.rejects(abrir(items, MESERO), cod("PERMISO_INSUFICIENTE"));
      assert.equal(core.docs.size, 0);
      const c = await abrir(items, CAJERO);
      assert.deepEqual([c.items[0].precio, c.items[0].precioCatalogo, c.items[0].precioModificado, c.total], [5, 6.5, true, 5]);
    });
  });

  describe("más ítems en el mismo pedido", () => {
    it("se agregan al pedido abierto y el total los suma", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      const d = await svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code: c.code, items: [{ codigo: "SAND-1" }] });
      assert.deepEqual(d.items.map((i) => i.code), ["DOC_ITEM-0000001", "DOC_ITEM-0000002"]);
      assert.equal(d.total, 18.5);
      assert.deepEqual(d.doc.codigosItems, ["DOC_ITEM-0000001", "DOC_ITEM-0000002"]);
    });

    it("no se agregan a un pedido que ya no está abierto, ni a uno que no existe", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      await assert.rejects(svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code: c.code, items: [{ codigo: "SAND-1" }] }), cod("ESTADO_INVALIDO"));
      await assert.rejects(svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code: "PD-0009999", items: [{ codigo: "SAND-1" }] }), cod("NO_ENCONTRADO"));
    });

    it("ítems que se agregan a la vez no se pisan en la lista del pedido", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await Promise.all([
        svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code: c.code, items: [{ codigo: "SAND-1" }] }),
        svc.pedidos.agregarItems({ empresaId: E, actor: MESERO, code: c.code, items: [{ codigo: "SAND-1" }] }),
      ]);
      const d = await svc.pedidos.obtener(m(MESERO, c.code));
      assert.equal(d.items.length, 3);
    });
  });

  describe("el ítem se mueve solo, el pedido sigue abierto", () => {
    it("cocina marca lista un ítem sin tocar al otro ni al pedido", async () => {
      nuevo();
      const c = await abrir();
      const p = await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      assert.equal(p.estado, "lista");
      const d = await svc.pedidos.obtener(m(MESERO, c.code));
      assert.deepEqual(d.items.map((i) => i.estado), ["lista", "en_cocina"]);
      assert.equal(d.estado, "abierto");
    });

    it("el motor exige la estación de cocina para marcar lista", async () => {
      nuevo();
      await abrir();
      await assert.rejects(svc.items.marcarLista(m(MESERO, "DOC_ITEM-0000001")), cod("PERMISO_INSUFICIENTE"));
    });

    it("solo se entrega lo que está lista", async () => {
      nuevo();
      await abrir();
      await assert.rejects(svc.items.entregar(m(MESERO, "DOC_ITEM-0000001")), cod("TRANSICION_INVALIDA"));
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      assert.equal((await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"))).estado, "entregado");
    });

    it("la versión esperada protege de dos cambios a la vez", async () => {
      nuevo();
      await abrir();
      await assert.rejects(svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001", { esperaVersion: 7 })), cod("CONFLICTO_VERSION"));
    });

    it("anular antes de que salga de cocina lo puede hacer quien toma ítems; después, administración", async () => {
      nuevo();
      await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      assert.equal((await svc.items.anular(m(MESERO, "DOC_ITEM-0000001", { motivo }))).estado, "anulado");
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000002"));
      await assert.rejects(svc.items.anular(m(MESERO, "DOC_ITEM-0000002", { motivo })), cod("PERMISO_INSUFICIENTE"));
      assert.equal((await svc.items.anular(m(CAJERO, "DOC_ITEM-0000002", { motivo }))).estado, "anulado");
      await assert.rejects(svc.items.anular(m(CAJERO, "DOC_ITEM-0000002", {})), cod("TRANSICION_INVALIDA"));
    });

    it("anular pide motivo", async () => {
      nuevo();
      await abrir();
      await assert.rejects(svc.items.anular(m(MESERO, "DOC_ITEM-0000001", {})), cod("MOTIVO_REQUERIDO"));
    });

    it("un ítem anulado no cuenta en el total", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.anular(m(MESERO, "DOC_ITEM-0000002", { motivo }));
      assert.equal((await svc.pedidos.obtener(m(MESERO, c.code))).total, 6.5);
    });

    it("solo ve items: un pedido no se obtiene como ítem ni al revés", async () => {
      nuevo();
      const c = await abrir();
      await assert.rejects(svc.items.obtener(m(MESERO, c.code)), cod("NO_ENCONTRADO"));
      await assert.rejects(svc.pedidos.obtener(m(MESERO, "DOC_ITEM-0000001")), cod("NO_ENCONTRADO"));
      await assert.rejects(svc.items.marcarLista(m(COCINA, "PD-0000001")), cod("NO_ENCONTRADO"));
    });

    it("cocina lista los ítems en cocina con la mesa o el nombre de su pedido", async () => {
      nuevo();
      await abrir([{ codigo: "CAFE-1" }]);
      await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "llevar", referencia: "Ana", items: [{ codigo: "SAND-1" }] });
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      const enCocina = await svc.items.listar({ empresaId: E, actor: COCINA, estado: ["en_cocina"] });
      assert.deepEqual(enCocina.map((p) => [p.code, p.nombre, p.pedido.referencia]), [["DOC_ITEM-0000002", "Sándwich", "Ana"]]);
      const todos = await svc.items.listar({ empresaId: E, actor: COCINA });
      assert.equal(todos.find((p) => p.code === "DOC_ITEM-0000001").pedido.mesa, "4");
    });
  });

  describe("corregir el precio de un ítem sin anularlo", () => {
    const precio = (actor, code, p, extra = {}) => svc.items.cambiarPrecio(m(actor, code, { precio: p, ...extra }));

    it("administración le pone precio a un ítem que se cargó sin él, y el total del pedido se recalcula", async () => {
      nuevo();
      const c = await abrir([{ codigo: "SINPRECIO", cantidad: 2 }, { codigo: "CAFE-1" }]);
      assert.equal(c.total, null);
      const i = await precio(CAJERO, "DOC_ITEM-0000001", 4.5);
      assert.deepEqual([i.precio, i.subtotal, i.version], [4.5, 9, 2]);
      assert.equal(i.estado, "en_cocina"); // no se movió ni se anuló
      assert.equal((await svc.pedidos.obtener(m(MESERO, c.code))).total, 15.5);
    });

    it("guarda el precio del catálogo como original; volver a él deja de marcarlo como cambiado", async () => {
      nuevo();
      await abrir([{ codigo: "CAFE-1" }]);
      const a = await precio(CAJERO, "DOC_ITEM-0000001", 5);
      assert.deepEqual([a.precio, a.precioCatalogo, a.precioModificado], [5, 6.5, true]);
      const b = await precio(CAJERO, "DOC_ITEM-0000001", 6.5);
      assert.deepEqual([b.precio, b.precioCatalogo, b.precioModificado], [6.5, 6.5, false]);
    });

    it("un ítem libre cambia su precio sin marcarse como modificado", async () => {
      nuevo();
      await abrir([{ libre: { nombre: "Torta del día", precio: 5 } }]);
      const i = await precio(CAJERO, "DOC_ITEM-0000001", 7);
      assert.deepEqual([i.precio, i.subtotal, i.precioModificado], [7, 7, false]);
    });

    it("funciona en cualquier estado vivo del ítem (en cocina, lista, entregado)", async () => {
      nuevo();
      await abrir([{ codigo: "CAFE-1" }]);
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      assert.equal((await precio(CAJERO, "DOC_ITEM-0000001", 6)).estado, "lista");
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      assert.equal((await precio(CAJERO, "DOC_ITEM-0000001", 7)).estado, "entregado");
    });

    it("pide la estación de administración; quien solo toma ítems no puede", async () => {
      nuevo();
      await abrir([{ codigo: "SINPRECIO" }]);
      await assert.rejects(precio(MESERO, "DOC_ITEM-0000001", 3), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(precio(SOLO_LEER, "DOC_ITEM-0000001", 3), cod("PERMISO_INSUFICIENTE"));
    });

    it("no se cambia en un ítem anulado ni cuando el pedido ya no está abierto", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.anular(m(MESERO, "DOC_ITEM-0000002", { motivo }));
      await assert.rejects(precio(CAJERO, "DOC_ITEM-0000002", 1), cod("ESTADO_INVALIDO"));
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      await assert.rejects(precio(CAJERO, "DOC_ITEM-0000001", 1), cod("ESTADO_INVALIDO"));
    });

    it("valida el precio y protege con la versión esperada", async () => {
      nuevo();
      await abrir([{ codigo: "CAFE-1" }]);
      for (const malo of [undefined, null, -1, 1.234, "5", NaN])
        await assert.rejects(precio(CAJERO, "DOC_ITEM-0000001", malo), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.items.cambiarPrecio(m(CAJERO, "DOC_ITEM-0000001", { precio: 3, otro: 1 })), cod("DATOS_INVALIDOS"));
      await assert.rejects(precio(CAJERO, "DOC_ITEM-0000001", 3, { esperaVersion: 9 }), cod("CONFLICTO_VERSION"));
    });

    it("lo demás del ítem sigue sin editarse (cantidad, notas, qué ítem): solo existen el precio, el cliente y el vale", () => {
      nuevo();
      assert.deepEqual(Object.keys(svc.items).sort(), ["anular", "aplicarVale", "asociarCliente", "cambiarPrecio", "entregar", "listar", "marcarLista", "obtener"]);
    });
  });

  describe("cliente del pedido y puntos al pagar", () => {
    const entregarTodo = async (c) => {
      for (const i of c.items) {
        await svc.items.marcarLista(m(COCINA, i.code));
        await svc.items.entregar(m(MESERO, i.code));
      }
    };
    const ID = "64b7f0f0f0f0f0f0f0f0f0f0";
    const conPuntos = (resultado) => {
      const llamadas = [];
      core.fidelizacion = {
        acumularPorDocumento: async (a) => {
          llamadas.push(a);
          const r = typeof resultado === "function" ? resultado(a) : resultado;
          if (r instanceof Error) throw r;
          return r;
        },
      };
      svc = crearServicio(core);
      return llamadas;
    };

    it("asocia al cliente a un pedido abierto, guarda su nombre y teléfono y lo muestra en el resumen", async () => {
      nuevo();
      const c = await abrir();
      assert.equal(c.cliente, null);
      const p = await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID }));
      assert.deepEqual(p.cliente, { id: ID, nombre: "Ana" });
      assert.equal(p.snapshot.cliente.telefono, "+51987654321");
      assert.equal(p.version, c.version + 1);
      assert.equal(p.items.length, 2, "los ítems no se tocan");
    });

    it("cambia y quita al cliente (null) mientras el pedido está abierto", async () => {
      nuevo();
      const c = await abrir();
      await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID }));
      const q = await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: null }));
      assert.equal(q.cliente, null);
    });

    it("no asocia a un pedido cerrado, sin permiso, con versión vieja ni con un id que no es texto", async () => {
      nuevo();
      const c = await abrir();
      await assert.rejects(svc.pedidos.asociarCliente(m(SOLO_LEER, c.code, { clienteId: ID })), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: 5 })), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID, esperaVersion: 99 })), cod("CONFLICTO_VERSION"));
      await entregarTodo(c);
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      await assert.rejects(svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID })), cod("ESTADO_INVALIDO"));
    });

    it("cobrar con clienteId asocia al cliente en la misma operación", async () => {
      nuevo();
      const c = await abrir();
      await entregarTodo(c);
      const p = await svc.pedidos.cobrar(m(CAJERO, c.code, { clienteId: ID }));
      assert.equal(p.estado, "pagado");
      assert.equal(p.cliente.id, ID);
    });

    it("al cobrar un pedido con cliente informa los puntos acumulados", async () => {
      nuevo();
      // Los puntos salen por ítem (13 y 5 de subtotal → 13 y 5 puntos); el pedido los suma
      const llamadas = conPuntos(({ code }) => (code.endsWith("1") ? { acumulados: 13, saldo: 113 } : { acumulados: 5, saldo: 118 }));
      const c = await abrir();
      await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID }));
      await entregarTodo(c);
      const p = await svc.pedidos.cobrar(m(CAJERO, c.code));
      assert.deepEqual(p.puntos, { acumulados: 18, saldo: 118, clientes: [{ id: ID, nombre: "Ana", acumulados: 18, saldo: 118 }] });
      assert.deepEqual(llamadas.map((l) => l.code), ["DOC_ITEM-0000001", "DOC_ITEM-0000002"]);
    });

    it("sin consentimiento informa el motivo; sin cliente ni siquiera consulta", async () => {
      nuevo();
      const llamadas = conPuntos({ acumulados: 0, motivo: "sin_consentimiento" });
      const a = await abrir();
      await svc.pedidos.asociarCliente(m(MESERO, a.code, { clienteId: ID }));
      await entregarTodo(a);
      assert.deepEqual((await svc.pedidos.cobrar(m(CAJERO, a.code))).puntos, {
        acumulados: 0,
        saldo: null,
        motivo: "sin_consentimiento",
        clientes: [{ id: ID, nombre: "Ana", acumulados: 0, saldo: null, motivo: "sin_consentimiento" }],
      });
      const b = await abrir();
      await entregarTodo(b);
      const p = await svc.pedidos.cobrar(m(CAJERO, b.code));
      assert.equal(p.puntos, undefined);
      assert.equal(llamadas.length, 2, "solo se consultó por los dos ítems del pedido con cliente");
    });

    it("si la fidelización falla, el pago se mantiene y se avisa en puntos.error", async () => {
      nuevo();
      conPuntos(new Error("base caída"));
      const c = await abrir();
      await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID }));
      await entregarTodo(c);
      const p = await svc.pedidos.cobrar(m(CAJERO, c.code));
      assert.equal(p.estado, "pagado");
      assert.equal(p.puntos.error, true);
      assert.equal(p.puntos.acumulados, 0);
    });

    it("sin fidelización en el núcleo, cobrar sigue igual y no trae puntos", async () => {
      nuevo();
      const c = await abrir();
      await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: ID }));
      await entregarTodo(c);
      assert.equal((await svc.pedidos.cobrar(m(CAJERO, c.code))).puntos, undefined);
    });
  });

  describe("cuenta dividida: cliente por ítem y cobro por ítem", () => {
    const A = "64b7f0f0f0f0f0f0f0f0f0a1";
    const B = "64b7f0f0f0f0f0f0f0f0f0b2";
    // Tres ítems entregados: Café x2 (13), Torta (5) y Sándwich (12)
    const mesa = async () => {
      const c = await abrir([{ codigo: "CAFE-1", cantidad: 2 }, { libre: { nombre: "Torta", precio: 5 } }, { codigo: "SAND-1" }]);
      for (const i of c.items) {
        await svc.items.marcarLista(m(COCINA, i.code));
        await svc.items.entregar(m(MESERO, i.code));
      }
      return c;
    };
    const clienteDe = { [A]: "Ana", [B]: "Beto" };
    const conClientes = () => {
      core.clientes.instantanea = async ({ clienteId }) => ({ clienteId, nombre: clienteDe[clienteId] ?? "Otro", telefono: null });
    };
    const I1 = "DOC_ITEM-0000001", I2 = "DOC_ITEM-0000002", I3 = "DOC_ITEM-0000003";

    it("asigna y quita el cliente de un ítem, y el resumen lo muestra", async () => {
      nuevo();
      conClientes();
      await mesa();
      const i = await svc.items.asociarCliente(m(MESERO, I1, { clienteId: A }));
      assert.deepEqual(i.cliente, { id: A, nombre: "Ana" });
      assert.equal(i.version, 2);
      const c = await svc.pedidos.obtener(m(MESERO, "PD-0000001"));
      assert.deepEqual(c.items.map((x) => x.cliente?.nombre ?? null), ["Ana", null, null]);
      assert.equal((await svc.items.asociarCliente(m(MESERO, I1, { clienteId: null }))).cliente, null);
    });

    it("pide permiso, valida el id y la versión, y no cambia ítems pagados, anulados ni de pedidos cerrados", async () => {
      nuevo();
      conClientes();
      await mesa();
      await assert.rejects(svc.items.asociarCliente(m(SOLO_LEER, I1, { clienteId: A })), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(svc.items.asociarCliente(m(MESERO, I1, { clienteId: 7 })), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.items.asociarCliente(m(MESERO, I1, { clienteId: A, esperaVersion: 99 })), cod("CONFLICTO_VERSION"));
      await svc.pedidos.cobrarItems(m(CAJERO, "PD-0000001", { items: [I1] }));
      await assert.rejects(svc.items.asociarCliente(m(MESERO, I1, { clienteId: A })), cod("ESTADO_INVALIDO"));
      await svc.items.anular(m(CAJERO, I2, { motivo }));
      await assert.rejects(svc.items.asociarCliente(m(MESERO, I2, { clienteId: A })), cod("ESTADO_INVALIDO"));
      await svc.pedidos.cobrar(m(CAJERO, "PD-0000001"));
      await assert.rejects(svc.items.asociarCliente(m(MESERO, I3, { clienteId: A })), cod("ESTADO_INVALIDO"));
    });

    it("cobra solo los ítems elegidos: el pedido sigue abierto con lo cobrado y lo que falta", async () => {
      nuevo();
      const c = await mesa();
      const p = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      assert.equal(p.estado, "abierto");
      assert.deepEqual(p.items.map((i) => i.estado), ["pagado", "entregado", "entregado"]);
      assert.deepEqual([p.total, p.cobrado, p.porCobrar], [30, 13, 17]);
      assert.equal(p.puntos, undefined, "sin cliente no hay puntos");
    });

    it("al cobrar el último ítem el pedido se cierra solo y guarda el total de todos", async () => {
      nuevo();
      const c = await mesa();
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      const p = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I2, I3] }));
      assert.equal(p.estado, "pagado");
      assert.equal(p.total, 30);
      assert.deepEqual(p.historial.map((h) => h.a), ["abierto", "pagado"]);
    });

    it("cobrar todo lo que falta paga solo los ítems pendientes de cobro y cierra el pedido", async () => {
      nuevo();
      const c = await mesa();
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I3] }));
      const p = await svc.pedidos.cobrar(m(CAJERO, c.code));
      assert.equal(p.estado, "pagado");
      assert.equal(p.total, 30);
      assert.deepEqual(p.items.map((i) => i.estado), ["pagado", "pagado", "pagado"]);
    });

    it("los puntos de cada ítem van a su cliente; lo que no tiene cliente va al del pedido", async () => {
      nuevo();
      conClientes();
      const llamadas = conPuntosPorItem(core, (c) => ({ acumulados: Math.floor(c.subtotal), saldo: 100, clienteId: c.cliente }));
      svc = crearServicio(core);
      const c = await mesa();
      await svc.pedidos.asociarCliente(m(MESERO, c.code, { clienteId: B }));
      await svc.items.asociarCliente(m(MESERO, I1, { clienteId: A }));
      const p1 = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      assert.deepEqual(p1.puntos.clientes.map((x) => [x.nombre, x.acumulados]), [["Ana", 13]]);
      const p2 = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I2] }));
      assert.deepEqual(p2.puntos.clientes.map((x) => [x.nombre, x.acumulados]), [["Beto", 5]], "el ítem sin cliente usa al del pedido");
      const copia = core.docs.get(I2).snapshot.cliente;
      assert.equal(copia.clienteId, B, "la copia queda guardada en el ítem");
      assert.deepEqual(llamadas, [I1, I2]);
    });

    it("cobrar varios ítems de clientes distintos informa los puntos por cliente", async () => {
      nuevo();
      conClientes();
      conPuntosPorItem(core, (c) => ({ acumulados: Math.floor(c.subtotal), saldo: 100, clienteId: c.cliente }));
      svc = crearServicio(core);
      const c = await mesa();
      await svc.items.asociarCliente(m(MESERO, I1, { clienteId: A }));
      await svc.items.asociarCliente(m(MESERO, I3, { clienteId: B }));
      const p = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1, I3] }));
      assert.deepEqual(p.puntos.clientes.map((x) => [x.nombre, x.acumulados]), [["Ana", 13], ["Beto", 12]]);
      assert.equal(p.puntos.acumulados, 25);
      assert.equal(p.puntos.saldo, null, "con varios clientes no hay un solo saldo");
    });

    it("no cobra ítems sin entregar, repetidos, ajenos, ya pagados ni con otro formato; ni un pedido cerrado", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.marcarLista(m(COCINA, I1));
      await svc.items.entregar(m(MESERO, I1));
      await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I2] })), cod("ESTADO_INVALIDO")); // en cocina
      for (const malo of [undefined, [], "x", [I1, I1], [5], ["PD-0000001"]])
        await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: malo })), cod("DATOS_INVALIDOS"));
      const otro = await abrir([{ codigo: "CAFE-1" }]);
      await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [otro.items[0].code] })), cod("DATOS_INVALIDOS"));
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] })), cod("ESTADO_INVALIDO"));
      await svc.items.anular(m(MESERO, I2, { motivo })); // lo último pendiente se anula: cierra solo
      await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] })), cod("ESTADO_INVALIDO"));
    });

    it("cobrar ítems pide la estación de administración", async () => {
      nuevo();
      const c = await mesa();
      await assert.rejects(svc.pedidos.cobrarItems(m(MESERO, c.code, { items: [I1] })), cod("PERMISO_INSUFICIENTE"));
      assert.equal(core.docs.get(I1).estado, "entregado");
    });

    it("un ítem pagado ya no se anula, no cambia de precio y el pedido no se anula entero", async () => {
      nuevo();
      const c = await mesa();
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      await assert.rejects(svc.items.anular(m(CAJERO, I1, { motivo })), cod("TRANSICION_INVALIDA"));
      await assert.rejects(svc.items.cambiarPrecio(m(CAJERO, I1, { precio: 1 })), cod("ESTADO_INVALIDO"));
      await assert.rejects(svc.pedidos.anular(m(CAJERO, c.code, { motivo })), cod("ESTADO_INVALIDO"));
      assert.equal(core.docs.get(c.code).estado, "abierto");
    });

    it("anular lo último que faltaba cierra el pedido solo, aunque quien anula no cobre", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.marcarLista(m(COCINA, I1));
      await svc.items.entregar(m(MESERO, I1));
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      assert.equal(core.docs.get(c.code).estado, "abierto", "falta el sándwich, que sigue en cocina");
      await svc.items.anular(m(MESERO, I2, { motivo })); // el mesero no tiene administración
      const p = await svc.pedidos.obtener(m(MESERO, c.code));
      assert.equal(p.estado, "pagado");
      assert.equal(p.total, 6.5);
    });

    it("un pedido con todo anulado y nada cobrado no se cierra solo", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await svc.items.anular(m(MESERO, I1, { motivo }));
      assert.equal((await svc.pedidos.obtener(m(MESERO, c.code))).estado, "abierto");
    });

    it("el listado de pedidos abiertos trae los ítems pagados", async () => {
      nuevo();
      const c = await mesa();
      await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1] }));
      const [p] = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["abierto"] });
      assert.deepEqual(p.items.map((i) => i.estado), ["pagado", "entregado", "entregado"]);
      assert.deepEqual([p.cobrado, p.porCobrar], [13, 17]);
    });
  });

  describe("cobrar y anular el pedido", () => {
    const entregarTodo = async (c) => {
      for (const i of c.items) {
        await svc.items.marcarLista(m(COCINA, i.code));
        await svc.items.entregar(m(MESERO, i.code));
      }
    };

    it("cobra todo el pedido cuando todo está entregado y guarda el total", async () => {
      nuevo();
      const c = await abrir();
      await entregarTodo(c);
      const p = await svc.pedidos.cobrar(m(CAJERO, c.code));
      assert.equal(p.estado, "pagado");
      assert.equal(p.total, 18);
      assert.equal(p.doc.total, 18);
      assert.deepEqual(p.historial.map((h) => h.a), ["abierto", "pagado"]);
    });

    it("no cobra con ítems sin entregar, y dice cuáles", async () => {
      nuevo();
      const c = await abrir();
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      await assert.rejects(svc.pedidos.cobrar(m(CAJERO, c.code)), (e) => e.codigo === "ESTADO_INVALIDO" && e.detalle.pendientes[0] === "DOC_ITEM-0000002");
    });

    it("lo anulado no impide cobrar, pero un pedido sin nada entregado no se cobra", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.anular(m(MESERO, "DOC_ITEM-0000002", { motivo }));
      await assert.rejects(svc.pedidos.cobrar(m(CAJERO, c.code)), cod("ESTADO_INVALIDO"));
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      assert.equal((await svc.pedidos.cobrar(m(CAJERO, c.code))).total, 6.5);
    });

    it("cobrar y anular piden la estación de administración", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await entregarTodo(c);
      await assert.rejects(svc.pedidos.cobrar(m(MESERO, c.code)), cod("PERMISO_INSUFICIENTE"));
      await assert.rejects(svc.pedidos.anular(m(MESERO, c.code, { motivo })), cod("PERMISO_INSUFICIENTE"));
    });

    it("un pedido pagado deja sus ítems quietos", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await entregarTodo(c);
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      await assert.rejects(svc.items.anular(m(CAJERO, "DOC_ITEM-0000001", { motivo })), cod("ESTADO_INVALIDO"));
      await assert.rejects(svc.pedidos.cobrar(m(CAJERO, c.code)), cod("TRANSICION_INVALIDA"));
    });

    it("anular el pedido anula todo lo que seguía en pie, con el mismo motivo", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      const a = await svc.pedidos.anular(m(CAJERO, c.code, { motivo }));
      assert.equal(a.estado, "anulado");
      assert.deepEqual(a.items.map((i) => i.estado), ["anulado", "anulado"]);
      assert.equal(a.sinAnular, undefined);
      assert.deepEqual(core.llamadas.filter((l) => l[0] === "transicionar" && l[3] === "sistema").length, 2);
    });
  });

  describe("datos del pedido", () => {
    it("editar cambia mesa y notas, usa la versión esperada y no deja el pedido incoherente", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      const e = await svc.pedidos.editar(m(MESERO, c.code, { mesa: "7", notas: "cumpleaños" }));
      assert.deepEqual([e.mesa, e.doc.notas], ["7", "cumpleaños"]);
      assert.equal(e.items.length, 1);
      await assert.rejects(svc.pedidos.editar(m(MESERO, c.code, { mesa: null })), cod("DATOS_INVALIDOS"));
      await assert.rejects(svc.pedidos.editar(m(MESERO, c.code, { esperaVersion: 1, mesa: "8" })), cod("CONFLICTO_VERSION"));
      await assert.rejects(svc.pedidos.editar(m(MESERO, c.code, { items: [] })), cod("DATOS_INVALIDOS"));
    });
  });

  describe("listar pedidos", () => {
    it("los abiertos traen sus ítems en curso; filtra por estado", async () => {
      nuevo();
      const a = await abrir([{ codigo: "CAFE-1" }, { codigo: "SAND-1" }]);
      await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "llevar", referencia: "Ana", items: [{ codigo: "CAFE-1" }] });
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      const abiertos = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["abierto"] });
      assert.equal(abiertos.length, 2);
      const la = abiertos.find((x) => x.code === a.code);
      assert.deepEqual(la.items.map((i) => i.estado), ["lista", "en_cocina"]);
      assert.equal(la.total, 18.5);
      assert.deepEqual((await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["pagado"] })), []);
    });

    it("cada pedido trae la fecha en que se creó, abierto o cerrado, en la lista y en el detalle", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      const [ab] = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["abierto"] });
      assert.match(ab.creadoTs, /^2026-10-1\d/);
      assert.ok(Number.isFinite(Date.parse(ab.creadoTs)));
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      const [pa] = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["pagado"] });
      assert.equal(pa.creadoTs, ab.creadoTs, "la fecha es la de creación, no cambia al pagar");
      assert.equal((await svc.pedidos.obtener({ empresaId: E, actor: MESERO, code: c.code })).creadoTs, ab.creadoTs);
    });

    it("los cerrados no cargan ítems y muestran el total guardado", async () => {
      nuevo();
      const c = await abrir([{ codigo: "CAFE-1" }]);
      await svc.items.marcarLista(m(COCINA, "DOC_ITEM-0000001"));
      await svc.items.entregar(m(MESERO, "DOC_ITEM-0000001"));
      await svc.pedidos.cobrar(m(CAJERO, c.code));
      const [p] = await svc.pedidos.listar({ empresaId: E, actor: MESERO, estado: ["pagado"] });
      assert.deepEqual([p.estado, p.total, p.items], ["pagado", 6.5, null]);
    });
  });
});

// Fidelización falsa para los vales: `vales` es un Map código → { estado, cliente: { id }, beneficio: { nombre }, beneficioCompleto }.
// El cálculo del descuento es el real del núcleo; el consumo único y la liberación se simulan como los hace el núcleo.
function conVales(core, vales) {
  const llamadas = [];
  const hallar = (codigo) => {
    const v = vales.get(codigo);
    if (!v) throw new ErrorFidelizacion("NO_ENCONTRADO", "vale no encontrado");
    return v;
  };
  core.fidelizacion = {
    tickets: {
      consultar: async ({ codigo }) => ({ codigo, ...structuredClone(hallar(codigo)) }),
      consumir: async ({ codigo, uso }) => {
        llamadas.push(["consumir", codigo, uso]);
        const v = hallar(codigo);
        if (v.estado !== "activo") throw new ErrorFidelizacion("ESTADO_INVALIDO", "el vale ya fue usado");
        v.estado = "usado";
      },
      liberar: async ({ codigo, itemCode }) => {
        llamadas.push(["liberar", codigo, itemCode]);
        hallar(codigo).estado = "activo";
      },
      calcularDescuento,
    },
  };
  return llamadas;
}

const MESERO_VALES = { ...MESERO, permisos: [...MESERO.permisos, "fidelizacion:canjear"] };
const vale = (extra = {}) => ({
  estado: "activo",
  cliente: { id: "64b7f0f0f0f0f0f0f0f0f0f0", nombre: "Ana" },
  beneficio: { nombre: "Descuento" },
  beneficioCompleto: { tipo: "descuento_porcentaje", valor: 50, itemCodigo: null },
  ...extra,
});

describe("vales de fidelización aplicados a un ítem (5.30)", () => {
  let core, svc, vales, llamadas;
  const IT1 = "DOC_ITEM-0000001"; // 2 × Café (6.50) = 13
  const IT2 = "DOC_ITEM-0000002"; // Torta del día 5
  const aplicar = (code, codigo, actor = MESERO_VALES, extra = {}) => svc.items.aplicarVale({ empresaId: E, actor, code, codigo, ...extra });
  beforeEach(async () => {
    core = nucleoFalso();
    vales = new Map([["K7M2QX", vale()]]);
    llamadas = conVales(core, vales);
    svc = crearServicio(core);
    await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "salon", mesa: "4", items: [{ codigo: "cafe-1", cantidad: 2 }, { libre: { nombre: "Torta del día", precio: 5 } }] });
  });

  it("un descuento en porcentaje baja el subtotal de ese ítem y guarda lo que había; el total se recalcula", async () => {
    const it = await aplicar(IT1, "K7M2QX");
    assert.equal(it.subtotal, 6.5);
    assert.deepEqual(it.descuento, { vale: "K7M2QX", beneficio: "Descuento", monto: 6.5, subtotalAntes: 13 });
    assert.equal((await svc.pedidos.obtener({ empresaId: E, actor: MESERO, code: "PD-0000001" })).total, 11.5);
    assert.equal(vales.get("K7M2QX").estado, "usado");
    assert.deepEqual(llamadas, [["consumir", "K7M2QX", { pedidoCode: "PD-0000001", itemCode: IT1, descuento: 6.5 }]]);
  });

  it("ítem gratis: descuenta UNA unidad del plato del vale y solo en ese plato", async () => {
    vales.set("GRATIS", vale({ beneficioCompleto: { tipo: "item_gratis", valor: null, itemCodigo: "CAFE-1" } }));
    await assert.rejects(aplicar(IT2, "GRATIS"), (e) => e.codigo === "ESTADO_INVALIDO" && /CAFE-1/.test(e.message));
    assert.equal(vales.get("GRATIS").estado, "activo"); // no se gastó
    const it = await aplicar(IT1, "GRATIS");
    assert.equal(it.subtotal, 6.5);
    assert.equal(it.descuento.monto, 6.5);
  });

  it("un ítem lleva un solo vale", async () => {
    await aplicar(IT1, "K7M2QX");
    vales.set("OTRO22", vale());
    await assert.rejects(aplicar(IT1, "OTRO22"), cod("ESTADO_INVALIDO"));
    assert.equal(vales.get("OTRO22").estado, "activo");
  });

  it("el vale gastado, cancelado o vencido no se aplica y no cambia nada", async () => {
    for (const [estado, re] of [["usado", /ya fue usado/], ["cancelado", /cancelado/], ["vencido", /vencido/]]) {
      vales.set("V" + estado, vale({ estado }));
      await assert.rejects(aplicar(IT1, "V" + estado), (e) => e.codigo === "ESTADO_INVALIDO" && re.test(e.message));
    }
    assert.equal((await svc.items.obtener({ empresaId: E, actor: MESERO, code: IT1 })).subtotal, 13);
    assert.deepEqual(llamadas, []);
  });

  it("un vale que no existe da 404 del núcleo", async () => {
    await assert.rejects(aplicar(IT1, "ZZZZZZ"), cod("NO_ENCONTRADO"));
  });

  it("si el pedido o el ítem ya tiene cliente, el vale tiene que ser suyo", async () => {
    await svc.pedidos.asociarCliente({ empresaId: E, actor: MESERO, code: "PD-0000001", clienteId: "64b7f0f0f0f0f0f0f0f0f0aa" });
    await assert.rejects(aplicar(IT1, "K7M2QX"), (e) => e.codigo === "ESTADO_INVALIDO" && /otro cliente/.test(e.message));
    assert.equal(vales.get("K7M2QX").estado, "activo");
    await svc.pedidos.asociarCliente({ empresaId: E, actor: MESERO, code: "PD-0000001", clienteId: "64b7f0f0f0f0f0f0f0f0f0f0" });
    assert.equal((await aplicar(IT1, "K7M2QX")).subtotal, 6.5);
  });

  it("sin cliente en el pedido el vale se acepta (el mesero ve de quién es antes de aplicar)", async () => {
    assert.equal((await aplicar(IT2, "K7M2QX")).subtotal, 2.5);
  });

  it("no se aplica a un ítem pagado ni anulado, ni con el pedido cerrado", async () => {
    await svc.items.anular({ empresaId: E, actor: MESERO, code: IT2, motivo });
    await assert.rejects(aplicar(IT2, "K7M2QX"), cod("ESTADO_INVALIDO"));
    await svc.pedidos.anular({ empresaId: E, actor: CAJERO, code: "PD-0000001", motivo });
    await assert.rejects(aplicar(IT1, "K7M2QX"), cod("ESTADO_INVALIDO"));
    assert.equal(vales.get("K7M2QX").estado, "activo");
  });

  it("si el ítem no se pudo actualizar, el vale se libera", async () => {
    await assert.rejects(aplicar(IT1, "K7M2QX", MESERO_VALES, { esperaVersion: 99 }), cod("CONFLICTO_VERSION"));
    assert.equal(vales.get("K7M2QX").estado, "activo");
    assert.deepEqual(llamadas.map((l) => l[0]), ["consumir", "liberar"]);
  });

  it("necesita documento:editar y fidelizacion:canjear; el código tiene que venir", async () => {
    await assert.rejects(aplicar(IT1, "K7M2QX", MESERO), cod("PERMISO_INSUFICIENTE"));
    await assert.rejects(aplicar(IT1, "K7M2QX", { ...MESERO_VALES, permisos: ["fidelizacion:canjear", "documento:leer"] }), cod("PERMISO_INSUFICIENTE"));
    await assert.rejects(aplicar(IT1, ""), cod("DATOS_INVALIDOS"));
    await assert.rejects(aplicar(IT1, undefined), cod("DATOS_INVALIDOS"));
  });

  it("con un ítem rebajado ya no se cambia su precio", async () => {
    await aplicar(IT1, "K7M2QX");
    await assert.rejects(svc.items.cambiarPrecio({ empresaId: E, actor: CAJERO, code: IT1, precio: 9 }), (e) => e.codigo === "ESTADO_INVALIDO" && /vale/.test(e.message));
  });

  it("consultar un vale no lo gasta y pide fidelizacion:canjear", async () => {
    const v = await svc.vales.consultar({ empresaId: E, actor: MESERO_VALES, codigo: "K7M2QX" });
    assert.equal(v.cliente.nombre, "Ana");
    assert.equal(vales.get("K7M2QX").estado, "activo");
    await assert.rejects(svc.vales.consultar({ empresaId: E, actor: MESERO, codigo: "K7M2QX" }), cod("PERMISO_INSUFICIENTE"));
  });

  it("al pagar el ítem rebajado, los puntos se calculan sobre lo que de verdad se cobra", async () => {
    const puntos = [];
    core.fidelizacion.acumularPorDocumento = async ({ code }) => {
      puntos.push(core.docs.get(code).payload.doc.subtotal);
      return { acumulados: 3, saldo: 3 };
    };
    await svc.pedidos.asociarCliente({ empresaId: E, actor: MESERO, code: "PD-0000001", clienteId: "64b7f0f0f0f0f0f0f0f0f0f0" });
    await aplicar(IT1, "K7M2QX");
    for (const code of [IT1, IT2]) {
      await svc.items.marcarLista({ empresaId: E, actor: COCINA, code });
      await svc.items.entregar({ empresaId: E, actor: MESERO, code });
    }
    const r = await svc.pedidos.cobrar({ empresaId: E, actor: CAJERO, code: "PD-0000001" });
    assert.equal(r.total, 11.5);
    assert.deepEqual(puntos, [6.5, 5]);
  });

  it("sin fidelización en el núcleo no hay vales", async () => {
    delete core.fidelizacion;
    await assert.rejects(aplicar(IT1, "K7M2QX"), cod("ESTADO_INVALIDO"));
  });
});

describe("recibos y cuenta (núcleo falso)", () => {
  let core, svc;
  const m = (actor, code, extra = {}) => ({ empresaId: E, actor, code, ...extra });
  const nuevo = () => {
    core = nucleoFalso();
    core.modelos = { Empresa: { findById: () => ({ lean: async () => ({ _id: E, nombre: "Café Central" }) }) } };
    svc = crearServicio(core);
  };
  const I1 = "DOC_ITEM-0000001", I2 = "DOC_ITEM-0000002", I3 = "DOC_ITEM-0000003";
  // Café x2 (13), Torta (5), Sándwich (12): total 30, todo entregado
  const mesa = async () => {
    const c = await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "salon", mesa: "4", items: [{ codigo: "CAFE-1", cantidad: 2 }, { libre: { nombre: "Torta", precio: 5 } }, { codigo: "SAND-1" }] });
    for (const i of c.items) {
      await svc.items.marcarLista(m(COCINA, i.code));
      await svc.items.entregar(m(MESERO, i.code));
    }
    return c;
  };
  const silencio = async (fn) => {
    const e = console.error;
    console.error = () => {};
    try { return await fn(); } finally { console.error = e; }
  };

  it("cobrar todo emite un recibo RC-… con lo cobrado, la forma de pago, la propina y el vuelto", async () => {
    nuevo();
    const c = await mesa();
    const r = await svc.pedidos.cobrar(m(CAJERO, c.code, { pago: { metodo: "efectivo", propina: 2, recibido: 50 } }));
    assert.equal(r.estado, "pagado");
    assert.equal(r.recibo.code, "RC-0000001");
    assert.equal(r.recibo.tipo, "pago");
    assert.deepEqual([r.recibo.subtotal, r.recibo.propina, r.recibo.total, r.recibo.recibido, r.recibo.vuelto], [30, 2, 32, 50, 18]);
    assert.equal(r.recibo.metodo, "efectivo");
    assert.equal(r.recibo.metodoTexto, "Efectivo");
    assert.equal(r.recibo.empresa.nombre, "Café Central");
    assert.equal(r.recibo.mesa, "4");
    assert.deepEqual(r.recibo.lineas.map((l) => [l.nombre, l.cantidad, l.subtotal]), [["Café", 2, 13], ["Torta", 1, 5], ["Sándwich", 1, 12]]);
    assert.deepEqual(r.recibos, ["RC-0000001"]);
    assert.equal(r.reciboError, undefined);
  });

  it("cobrar sin `pago` sigue funcionando: recibo con método sin indicar y sin propina", async () => {
    nuevo();
    const c = await mesa();
    const r = await svc.pedidos.cobrar(m(CAJERO, c.code));
    assert.equal(r.recibo.metodo, null);
    assert.equal(r.recibo.metodoTexto, null);
    assert.deepEqual([r.recibo.propina, r.recibo.total, r.recibo.vuelto], [0, 30, null]);
  });

  it("cada cobro por ítems deja su propio recibo, solo con lo que cobró", async () => {
    nuevo();
    const c = await mesa();
    const a = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1], pago: { metodo: "yape" } }));
    assert.equal(a.estado, "abierto");
    assert.equal(a.recibo.code, "RC-0000001");
    assert.deepEqual(a.recibo.lineas.map((l) => l.itemCode), [I1]);
    assert.equal(a.recibo.total, 13);
    const b = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I2, I3], pago: { metodo: "tarjeta", propina: 1.5 } }));
    assert.equal(b.estado, "pagado");
    assert.equal(b.recibo.code, "RC-0000002");
    assert.deepEqual([b.recibo.subtotal, b.recibo.total], [17, 18.5]);
    assert.deepEqual(b.recibos, ["RC-0000001", "RC-0000002"]);
    const lista = await svc.pedidos.recibos(m(SOLO_LEER, c.code));
    assert.deepEqual(lista.map((r) => [r.code, r.metodo, r.total]), [["RC-0000001", "yape", 13], ["RC-0000002", "tarjeta", 18.5]]);
    assert.equal((await svc.recibos.obtener(m(SOLO_LEER, "RC-0000002"))).metodo, "tarjeta");
  });

  it("cobrar lo que falta no emite recibo de lo ya cobrado antes", async () => {
    nuevo();
    const c = await mesa();
    await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I3] }));
    const r = await svc.pedidos.cobrar(m(CAJERO, c.code));
    assert.equal(r.recibo.code, "RC-0000002");
    assert.deepEqual(r.recibo.lineas.map((l) => l.itemCode), [I1, I2]);
    assert.equal(r.recibo.total, 18);
  });

  it("un pago inválido se rechaza ANTES de cobrar nada", async () => {
    nuevo();
    const c = await mesa();
    for (const pago of [{ metodo: "cripto" }, { metodo: "efectivo", propina: -1 }, { metodo: "yape", recibido: 40 }, "efectivo", { propina: 1 }, { metodo: "efectivo", extra: 1 }]) {
      await assert.rejects(svc.pedidos.cobrar(m(CAJERO, c.code, { pago })), cod("DATOS_INVALIDOS"), JSON.stringify(pago));
      await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1], pago })), cod("DATOS_INVALIDOS"), JSON.stringify(pago));
    }
    // El efectivo recibido tiene que alcanzar para lo que se cobra (más la propina)
    await assert.rejects(svc.pedidos.cobrar(m(CAJERO, c.code, { pago: { metodo: "efectivo", recibido: 31, propina: 2 } })), cod("DATOS_INVALIDOS"));
    await assert.rejects(svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1], pago: { metodo: "efectivo", recibido: 13.5, propina: 1 } })), cod("DATOS_INVALIDOS"));
    const p = await svc.pedidos.obtener(m(CAJERO, c.code));
    assert.equal(p.estado, "abierto");
    assert.deepEqual(p.items.map((i) => i.estado), ["entregado", "entregado", "entregado"]);
    assert.deepEqual(p.recibos, []);
  });

  it("si el recibo falla, el cobro se mantiene y se avisa con reciboError", async () => {
    nuevo();
    const c = await mesa();
    const crear = core.documentos.crear;
    core.documentos.crear = async (p) => { if (p.tipo === "recibo") throw new Error("falla"); return crear(p); };
    const r = await silencio(() => svc.pedidos.cobrar(m(CAJERO, c.code)));
    assert.equal(r.estado, "pagado");
    assert.equal(r.reciboError, true);
    assert.equal(r.recibo, undefined);
  });

  it("el recibo muestra el vale aplicado y los puntos no cambian el total", async () => {
    nuevo();
    const c = await mesa();
    const doc = core.docs.get(I1);
    doc.payload.doc = { ...doc.payload.doc, subtotal: 6.5, descuento: { vale: "K7M2QX", beneficio: "Café gratis", monto: 6.5, subtotalAntes: 13 } };
    const r = await svc.pedidos.cobrar(m(CAJERO, c.code));
    assert.equal(r.recibo.total, 23.5);
    assert.equal(r.recibo.descuentos, 6.5);
    assert.deepEqual(r.recibo.lineas[0].descuento, { vale: "K7M2QX", beneficio: "Café gratis", monto: 6.5 });
  });

  it("el recibo guarda el logo y los datos de la empresa de ese momento; la cuenta, los de ahora (5.34)", async () => {
    nuevo();
    const empresa = { _id: E, nombre: "Café Central", pais: "PE", datos: { razonSocial: "Café Central SAC", idFiscal: "20123456789", direccion: "Av. 1", pie: "Gracias" }, marca: { logo: "https://e.com/l.png" } };
    core.modelos = { Empresa: { findById: () => ({ lean: async () => structuredClone(empresa) }) } };
    const c = await mesa();
    const r = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1], pago: { metodo: "yape" } }));
    assert.deepEqual(r.recibo.empresa, { nombre: "Café Central", razonSocial: "Café Central SAC", idFiscal: "20123456789", etiquetaIdFiscal: "RUC", direccion: "Av. 1", telefono: null, pie: "Gracias", logo: "https://e.com/l.png" });
    // la empresa cambia sus datos y su logo: el recibo ya emitido no cambia, la cuenta sí
    empresa.datos.direccion = "Av. Nueva 99";
    empresa.marca.logo = "https://e.com/otro.png";
    const viejo = await svc.recibos.obtener(m(SOLO_LEER, r.recibo.code));
    assert.equal(viejo.empresa.direccion, "Av. 1");
    assert.equal(viejo.empresa.logo, "https://e.com/l.png");
    const cuenta = await svc.pedidos.cuenta(m(SOLO_LEER, c.code));
    assert.equal(cuenta.empresa.direccion, "Av. Nueva 99");
    assert.equal(cuenta.empresa.logo, "https://e.com/otro.png");
    // un logo que no es https no llega al recibo
    empresa.marca.logo = "javascript:alert(1)";
    const r2 = await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I2] }));
    assert.equal(r2.recibo.empresa.logo, null);
  });

  it("la cuenta muestra lo consumido, lo cobrado y lo que falta, sin lo anulado, y no se guarda", async () => {
    nuevo();
    const c = await mesa();
    const antes = core.docs.size;
    let cuenta = await svc.pedidos.cuenta(m(SOLO_LEER, c.code));
    assert.deepEqual([cuenta.tipo, cuenta.total, cuenta.cobrado, cuenta.porCobrar, cuenta.estadoPedido], ["consumo", 30, 0, 30, "abierto"]);
    assert.equal(cuenta.empresa.nombre, "Café Central");
    assert.equal(cuenta.lineas.length, 3);
    await svc.pedidos.cobrarItems(m(CAJERO, c.code, { items: [I1], pago: { metodo: "plin", propina: 1 } }));
    cuenta = await svc.pedidos.cuenta(m(SOLO_LEER, c.code));
    assert.deepEqual([cuenta.total, cuenta.cobrado, cuenta.porCobrar, cuenta.propinas], [30, 13, 17, 1]);
    assert.deepEqual(cuenta.lineas.map((l) => l.pagado), [true, false, false]);
    assert.deepEqual(cuenta.pagos.map((p) => [p.code, p.total, p.metodoTexto]), [["RC-0000001", 14, "Plin"]]);
    await svc.items.anular(m(CAJERO, I3, { motivo }));
    cuenta = await svc.pedidos.cuenta(m(SOLO_LEER, c.code));
    assert.deepEqual([cuenta.lineas.length, cuenta.total, cuenta.porCobrar], [2, 18, 5]);
    assert.equal(core.docs.size, antes + 1, "solo el recibo del cobro se guardó; la cuenta no");
  });

  it("un pedido con un ítem sin precio deja la cuenta en null (nunca se inventa un precio)", async () => {
    nuevo();
    const c = await svc.pedidos.crear({ empresaId: E, actor: MESERO, canal: "llevar", referencia: "Ana", items: [{ codigo: "SINPRECIO" }] });
    const cuenta = await svc.pedidos.cuenta(m(SOLO_LEER, c.code));
    assert.deepEqual([cuenta.total, cuenta.cobrado, cuenta.porCobrar], [null, 0, null]);
  });

  it("leer pide documento:leer y los códigos se validan", async () => {
    nuevo();
    const c = await mesa();
    const sin = { usuarioId: "x", permisos: [] };
    await assert.rejects(svc.pedidos.cuenta(m(sin, c.code)), cod("PERMISO_INSUFICIENTE"));
    await assert.rejects(svc.pedidos.recibos(m(sin, c.code)), cod("PERMISO_INSUFICIENTE"));
    await assert.rejects(svc.recibos.obtener(m(sin, "RC-0000001")), cod("PERMISO_INSUFICIENTE"));
    await assert.rejects(svc.recibos.obtener(m(SOLO_LEER, "RC-0000009")), cod("NO_ENCONTRADO"));
    await assert.rejects(svc.recibos.obtener(m(SOLO_LEER, c.code)), cod("NO_ENCONTRADO"), "un pedido no se lee como recibo");
    await assert.rejects(svc.recibos.obtener(m(SOLO_LEER, "otra")), cod("NO_ENCONTRADO"));
  });
});

describe("rutas de tobt (núcleo falso)", () => {
  let server, url, core;
  const sesion = { auth: { usuarioId: "u1", empresaId: "e1" }, rol: { permisos: ["*"] } };

  before(async () => {
    core = nucleoFalso();
    const svc = crearServicio(core);
    const router = express.Router();
    router.use(express.json());
    const ctx = {
      autenticar: () => (req, res, next) => {
        if (req.headers["x-sin-sesion"]) return res.status(401).json({ error: "no autenticado" });
        Object.assign(req, structuredClone(sesion));
        next();
      },
      requierePermiso: () => (req, res, next) => next(),
      eventos: { middleware: ({ estacion }) => (req, res, next) => { req.estacionDeRuta = estacion; next(); } },
      auth: { exigirCsrf(req) { if (!req.headers["x-requested-with"]) throw new ErrorPedido("PERMISO_INSUFICIENTE", "falta x-requested-with"); } },
    };
    montarRutas(router, ctx, svc);
    const app = express();
    app.use("/tobt", router);
    await new Promise((r) => (server = app.listen(0, r)));
    url = `http://127.0.0.1:${server.address().port}/tobt`;
  });
  after(() => server.close());

  const pedir = (metodo, ruta, cuerpo, cab = {}) =>
    fetch(url + ruta, {
      method: metodo,
      headers: { "content-type": "application/json", "x-requested-with": "fetch", ...cab },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
  const pedido = (extra = {}) => ({ canal: "llevar", referencia: "Ana", items: [{ codigo: "CAFE-1" }, { codigo: "SAND-1" }], ...extra });

  it("POST /items/:code/precio corrige el precio sin anular; valida el cuerpo y exige x-requested-with", async () => {
    let r = await pedir("POST", "/pedidos", pedido({ items: [{ codigo: "SINPRECIO" }] }));
    const c = await r.json();
    assert.equal(c.total, null);
    const code = c.items[0].code;
    r = await pedir("POST", `/items/${code}/precio`, { precio: 4.25, esperaVersion: c.items[0].version });
    assert.equal(r.status, 200);
    const i = await r.json();
    assert.deepEqual([i.precio, i.subtotal, i.estado], [4.25, 4.25, "en_cocina"]);
    assert.equal((await (await pedir("GET", `/pedidos/${c.code}`)).json()).total, 4.25);
    assert.equal((await pedir("POST", `/items/${code}/precio`, { precio: "x" })).status, 400);
    assert.equal((await pedir("POST", `/items/${code}/precio`, {}, { "x-requested-with": "" })).status, 403);
    await pedir("POST", `/pedidos/${c.code}/anular`, { motivo: { codigo: "otro" } }); // no deja un ítem en cocina a los demás tests
  });

  it("flujo: abrir pedido, más ítems, cocina, entregar, cobrar", async () => {
    let r = await pedir("POST", "/pedidos", pedido());
    assert.equal(r.status, 201);
    const c = await r.json();
    r = await pedir("POST", `/pedidos/${c.code}/items`, { items: [{ codigo: "CAFE-1" }] });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).items.length, 3);
    r = await pedir("GET", "/items?estado=en_cocina");
    const { items } = await r.json();
    assert.equal(items.length, 3);
    assert.equal(items[0].pedido.referencia, "Ana");
    for (const p of items) {
      assert.equal((await pedir("POST", `/items/${p.code}/lista`, {})).status, 200);
      assert.equal((await pedir("POST", `/items/${p.code}/entregar`, {})).status, 200);
    }
    r = await pedir("POST", `/pedidos/${c.code}/cobrar`, {});
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 25);
    r = await pedir("GET", "/pedidos?estado=pagado");
    assert.equal((await r.json()).pedidos.length, 1);
  });

  it("errores con su HTTP: 400 datos, 404 inexistente, 409 ítem no disponible, 409 pedido con pendientes, 409 conflicto", async () => {
    let r = await pedir("POST", "/pedidos", { canal: "salon", items: [{ codigo: "CAFE-1" }] });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).codigo, "DATOS_INVALIDOS");
    assert.equal((await pedir("GET", "/pedidos/PD-0009999")).status, 404);
    assert.equal((await pedir("GET", "/items/xx")).status, 404);
    assert.equal((await pedir("POST", "/pedidos", pedido({ items: [{ codigo: "NOEXISTE" }] }))).status, 409);
    const c = await (await pedir("POST", "/pedidos", pedido())).json();
    r = await pedir("POST", `/pedidos/${c.code}/cobrar`, {});
    assert.equal(r.status, 409);
    const e = await r.json();
    assert.equal(e.codigo, "ESTADO_INVALIDO");
    assert.equal(e.pendientes.length, 2);
    r = await pedir("PUT", `/pedidos/${c.code}`, { esperaVersion: 99, notas: "x" });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).codigo, "CONFLICTO_VERSION");
  });

  it("PUT /pedidos/:code/cliente asocia y quita al cliente; exige x-requested-with", async () => {
    const c = await (await pedir("POST", "/pedidos", pedido())).json();
    let r = await pedir("PUT", `/pedidos/${c.code}/cliente`, { clienteId: "64b7f0f0f0f0f0f0f0f0f0f0" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).cliente.nombre, "Ana");
    r = await pedir("PUT", `/pedidos/${c.code}/cliente`, { clienteId: null });
    assert.equal((await r.json()).cliente, null);
    r = await pedir("PUT", `/pedidos/${c.code}/cliente`, {});
    assert.equal((await r.json()).cliente, null, "sin clienteId equivale a quitarlo");
    assert.equal((await pedir("PUT", `/pedidos/${c.code}/cliente`, { clienteId: 7 })).status, 400);
    assert.equal((await pedir("PUT", `/pedidos/${c.code}/cliente`, {}, { "x-requested-with": "" })).status, 403);
    await pedir("POST", `/pedidos/${c.code}/anular`, { motivo: { codigo: "otro" } });
  });

  it("anular el pedido por HTTP anula sus ítems", async () => {
    const c = await (await pedir("POST", "/pedidos", pedido())).json();
    const r = await pedir("POST", `/pedidos/${c.code}/anular`, { motivo: { codigo: "otro", detalle: "se fueron" } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).items.map((i) => i.estado), ["anulado", "anulado"]);
  });

  it("401 sin sesión y 403 sin x-requested-with en rutas que escriben", async () => {
    assert.equal((await pedir("GET", "/pedidos", undefined, { "x-sin-sesion": "1" })).status, 401);
    assert.equal((await pedir("GET", "/items", undefined, { "x-sin-sesion": "1" })).status, 401);
    assert.equal((await pedir("POST", "/pedidos", pedido(), { "x-requested-with": "" })).status, 403);
    assert.equal((await pedir("POST", "/items/DOC_ITEM-0000001/lista", {}, { "x-requested-with": "" })).status, 403);
  });

  it("recibos por rutas: cobrar con pago, ver el recibo, los recibos del pedido y la cuenta", async () => {
    let r = await pedir("POST", "/pedidos", pedido({ items: [{ codigo: "CAFE-1" }] }));
    const c = await r.json();
    const code = c.items[0].code;
    await pedir("POST", `/items/${code}/lista`, {});
    await pedir("POST", `/items/${code}/entregar`, {});
    assert.equal((await pedir("POST", `/pedidos/${c.code}/cobrar`, { pago: { metodo: "bitcoin" } })).status, 400);
    r = await pedir("POST", `/pedidos/${c.code}/cobrar`, { pago: { metodo: "efectivo", propina: 1, recibido: 10 } });
    assert.equal(r.status, 200);
    const cobrado = await r.json();
    assert.equal(cobrado.estado, "pagado");
    assert.deepEqual([cobrado.recibo.total, cobrado.recibo.vuelto], [7.5, 2.5]);
    const rc = await (await pedir("GET", `/recibos/${cobrado.recibo.code}`)).json();
    assert.equal(rc.metodoTexto, "Efectivo");
    assert.equal((await pedir("GET", "/recibos/RC-9999999")).status, 404);
    assert.equal((await pedir("GET", `/recibos/${c.code}`)).status, 404);
    const lista = await (await pedir("GET", `/pedidos/${c.code}/recibos`)).json();
    assert.deepEqual(lista.recibos.map((x) => x.code), [cobrado.recibo.code]);
    const cuenta = await (await pedir("GET", `/pedidos/${c.code}/cuenta`)).json();
    assert.deepEqual([cuenta.tipo, cuenta.total, cuenta.porCobrar, cuenta.pagos.length], ["consumo", 6.5, 0, 1]);
  });

  it("POST /items/:code/vale aplica el vale a ese ítem y GET /vales/:codigo lo muestra sin gastarlo", async () => {
    const vales = new Map([["K7M2QX", vale()]]);
    conVales(core, vales);
    const c = await (await pedir("POST", "/pedidos", pedido())).json();
    const code = c.items[0].code;
    let r = await pedir("GET", "/vales/K7M2QX");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).cliente.nombre, "Ana");
    assert.equal(vales.get("K7M2QX").estado, "activo");
    r = await pedir("POST", `/items/${code}/vale`, { codigo: "K7M2QX" });
    assert.equal(r.status, 200);
    const it = await r.json();
    assert.equal(it.descuento.vale, "K7M2QX");
    assert.equal(it.subtotal, 3.25);
    r = await pedir("POST", `/items/${code}/vale`, { codigo: "K7M2QX" });
    assert.equal(r.status, 409); // el ítem ya lleva un vale
    r = await pedir("POST", `/items/${c.items[1].code}/vale`, { codigo: "K7M2QX" });
    assert.equal(r.status, 409); // el vale ya se gastó
    assert.equal((await pedir("GET", "/vales/ZZZZZZ")).status, 404);
    assert.equal((await pedir("POST", `/items/${code}/vale`, {}, { "x-requested-with": "" })).status, 403);
    delete core.fidelizacion; // el núcleo falso se comparte con las demás pruebas de rutas
  });
});
