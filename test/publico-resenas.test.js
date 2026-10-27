// Reseñas de platos en la carta pública (5.62): manejadores con sesión de cliente y la comprobación «¿lo pagó?».
import { describe, it, before, after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { ErrorResena } from "core";
import { montarRutasPublicas } from "../src/publico-http.js";
import { crearManejadoresResenas } from "../src/publico-resenas.js";
import { crearFuenteConsumo } from "../src/consumo-resenas.js";

describe("reseñas del cliente (rutas públicas)", () => {
  let server, base;
  const llamadas = [];
  let pago = true;
  const core = {
    cuentasCliente: {
      autenticarCliente: ({ empresaDe }) => async (req, res, next) => {
        const e = await empresaDe(req);
        if (!req.headers["x-cliente"]) return res.status(401).json({ error: "no autenticado", codigo: "SIN_SESION" });
        req.cliente = { clienteId: req.headers["x-cliente"], empresaId: e.id, sesionId: "s1" };
        next();
      },
    },
    resenas: {
      deItem: async (q) => (llamadas.push(["deItem", q.empresaId, q.clienteId, q.itemCodigo]), { total: 1, promedio: 5, resenas: [{ id: "r1", autor: "María P.", estrellas: 5, texto: null, ts: "x", mia: true }], mia: { id: "r1", estrellas: 5, texto: null, oculta: false } }),
      guardarMia: async (q) => {
        llamadas.push(["guardarMia", q.empresaId, q.clienteId, q.itemCodigo, q.estrellas, q.texto, q.clienteIdDelCuerpo]);
        if (q.estrellas === 9) throw new ErrorResena("DATOS_INVALIDOS", "estrellas: un número entero de 1 a 5");
        if (q.estrellas === 1) throw new ErrorResena("NO_PERMITIDO", "solo puedes opinar de un plato que ya pediste y pagaste");
        return { id: "r1", estrellas: q.estrellas, texto: q.texto ?? null, oculta: false };
      },
      borrarMia: async (q) => (llamadas.push(["borrarMia", q.clienteId, q.itemCodigo]), { ok: true }),
      reportar: async (q) => {
        llamadas.push(["reportar", q.clienteId, q.resenaId]);
        if (q.resenaId === "propia") throw new ErrorResena("ESTADO_INVALIDO", "no puedes reportar tu propia reseña");
        return { reportada: true };
      },
    },
  };
  const pagoElPlato = async (q) => (llamadas.push(["pago", q.clienteId, q.itemCodigo]), pago);

  before(async () => {
    const router = express.Router();
    router.use(express.json());
    const publico = { empresaDe: async (req) => ({ id: "e1", slug: req.params.empresa }) };
    montarRutasPublicas(router, publico, "<html><head></head></html>", (req, res, next) => next(), null, null, crearManejadoresResenas(core, publico.empresaDe, { pagoElPlato }));
    const app = express();
    app.use("/tobt", router);
    await new Promise((r) => (server = app.listen(0, r)));
    base = `http://127.0.0.1:${server.address().port}/tobt/publico/cafe/cuenta/resenas`;
  });
  after(() => server.close());

  const pedir = (metodo, ruta, cuerpo, cab = { "x-cliente": "c1" }) =>
    fetch(base + ruta, { method: metodo, headers: { "content-type": "application/json", ...cab }, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });

  it("sin sesión de cliente: 401 en las cuatro rutas y no se llama al núcleo", async () => {
    llamadas.length = 0;
    for (const [m, r] of [["GET", "/CAF-1"], ["PUT", "/CAF-1"], ["DELETE", "/CAF-1"], ["POST", "/r1/reportar"]])
      assert.equal((await pedir(m, r, m === "PUT" ? { estrellas: 5 } : undefined, {})).status, 401, `${m} ${r}`);
    assert.deepEqual(llamadas, []);
  });

  it("GET: la lista fresca con la reseña propia y si puede reseñar; sin caché", async () => {
    llamadas.length = 0;
    pago = true;
    const r = await pedir("GET", "/CAF-1");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const j = await r.json();
    assert.equal(j.puedeResenar, true);
    assert.equal(j.mia.estrellas, 5);
    assert.equal(j.total, 1);
    assert.deepEqual(llamadas.find((l) => l[0] === "deItem"), ["deItem", "e1", "c1", "CAF-1"]);
    pago = false;
    assert.equal((await (await pedir("GET", "/CAF-1")).json()).puedeResenar, false);
  });

  it("PUT: el cliente es el de la sesión aunque el cuerpo traiga otro; guarda estrellas y texto", async () => {
    llamadas.length = 0;
    const r = await pedir("PUT", "/CAF-1", { estrellas: 4, texto: "rico", clienteId: "otro" });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).resena.estrellas, 4);
    const g = llamadas.find((l) => l[0] === "guardarMia");
    assert.deepEqual(g.slice(0, 6), ["guardarMia", "e1", "c1", "CAF-1", 4, "rico"]);
  });

  it("PUT: los errores del núcleo salen con su estado y código (400 datos, 403 no lo pagó)", async () => {
    let r = await pedir("PUT", "/CAF-1", { estrellas: 9 });
    assert.equal(r.status, 400);
    r = await pedir("PUT", "/CAF-1", { estrellas: 1 });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).codigo, "NO_PERMITIDO");
    r = await pedir("PUT", "/CAF-1", [1, 2]); // un arreglo no es un cuerpo válido: llega como objeto vacío
    assert.equal(r.status, 200);
  });

  it("DELETE y reportar usan al cliente de la sesión", async () => {
    llamadas.length = 0;
    assert.equal((await pedir("DELETE", "/CAF-1")).status, 200);
    assert.deepEqual(llamadas.at(-1), ["borrarMia", "c1", "CAF-1"]);
    const r = await pedir("POST", "/r7/reportar");
    assert.equal(r.status, 200);
    assert.deepEqual(llamadas.at(-1), ["reportar", "c1", "r7"]);
    assert.equal((await pedir("POST", "/propia/reportar")).status, 409);
  });
});

describe("¿pagó el plato? (consumo-resenas)", () => {
  const armar = (hay) => {
    const consultas = [];
    const modelos = { Documento: { exists: async (f) => (consultas.push(f), hay) } };
    const conEmpresa = async (e, fn) => ((consultas.empresa = e), fn());
    return { consultas, fuente: crearFuenteConsumo({ conEmpresa, modelos }) };
  };

  test("busca un ítem de catálogo pagado de ese cliente, dentro de su empresa", async () => {
    const { consultas, fuente } = armar({ _id: "x" });
    assert.equal(await fuente({ empresaId: "e1", clienteId: "c1", itemCodigo: "Moka" }), true);
    assert.equal(consultas.empresa, "e1");
    assert.deepEqual(consultas[0], {
      tipo: "doc_item", estado: "pagado", "snapshot.cliente.clienteId": "c1", "snapshot.item.origen": "catalogo", "snapshot.item.codigo": { $in: ["Moka", "moka"] },
    });
  });
  test("sin ítems pagados, falso", async () => {
    assert.equal(await armar(null).fuente({ empresaId: "e1", clienteId: "c1", itemCodigo: "Moka" }), false);
  });
  test("entradas raras: falso y sin consultar", async () => {
    const { consultas, fuente } = armar({ _id: "x" });
    for (const q of [{ clienteId: null, itemCodigo: "Moka" }, { clienteId: "c1", itemCodigo: "" }, { clienteId: "c1", itemCodigo: 5 }, { clienteId: 7, itemCodigo: "Moka" }])
      assert.equal(await fuente({ empresaId: "e1", ...q }), false);
    assert.equal(consultas.length, 0);
  });
});
