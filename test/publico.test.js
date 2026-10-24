// Vista pública de la carta (sin sesión): servicio contra un núcleo falso, rutas HTTP y lógica pura del front.
import { describe, it, before, after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createRouter } from "../src/index.js";
import { ErrorCatalogo } from "core";
import { agruparPorCategoria, crearPublico, urlImagenSegura } from "../src/publico.js";
import { resenasDe } from "../src/resenas-demo.js";
import { limitadorPorIp, paginaCatalogo } from "../src/publico-http.js";
import { slugDesdeUbicacion, formatoPrecio, filtrarCarta, totalItems, formatoPuntos, rutaDesdeHash, hashPlato, estrellasLlenas, formatoNota, validarRegistro, cuerpoRegistro, textoMovimiento, faltanPuntos, formatoCodigoVale, agruparVales, textoVence, textoAvance, textoFaltan, porcentajeReto, normalizarCodigoReferido, validarCodigoReferido, codigoDeEnlace, enlaceInvitacion, textoPremioReferidos, ESTADO_REFERIDO, textoFecha, textoDias, textoCuando, textoRegla, estadoPromocion, ordenarPromociones } from "../client/src/catalogo/logica.js";

const middleware = () => (req, res, next) => next();

const EMPRESAS = {
  "cafe-central": { _id: "e1", nombre: "Café Central", slug: "cafe-central", moneda: "PEN", activa: true, servicios: [{ codigo: "tobt", activa: true }] },
  "sin-servicio": { _id: "e2", nombre: "Otra", slug: "sin-servicio", activa: true, servicios: [{ codigo: "siscore", activa: true }] },
  "servicio-off": { _id: "e3", nombre: "Off", slug: "servicio-off", activa: true, servicios: [{ codigo: "tobt", activa: false }] },
  "empresa-baja": { _id: "e4", nombre: "Baja", slug: "empresa-baja", activa: false, servicios: [{ codigo: "tobt", activa: true }] },
};
const CATALOGO = [
  { id: "1", codigo: "CAF-1", nombre: "Café americano", categoria: "Bebidas", precio: 6.5, atributos: { INTERNO: "x", DESCRIPCION: "  Espresso doble alargado.  ", IMAGEN: "https://img.example.com/cafe.jpg" } },
  { id: "2", codigo: "TOR-1", nombre: "Torta de chocolate", categoria: "Postres", precio: 12, atributos: {} },
  { id: "3", codigo: "AGU-1", nombre: "Agua", categoria: "Bebidas", precio: null, atributos: {} },
  { id: "4", codigo: "ESP-1", nombre: "Especial del día", categoria: null, precio: 20, atributos: { IMAGEN: "javascript:alert(1)", DESCRIPCION: "   " } },
  { id: "5", codigo: "OFF-1", nombre: "Plato retirado", categoria: "Bebidas", precio: 1, atributos: {}, activo: false },
];

function nucleoFalso() {
  const llamadas = [];
  return {
    llamadas,
    documentos: { registrarTipo() {} },
    clientes: {},
    catalogo: {
      async listar(args) {
        llamadas.push(args);
        assert.equal(args.empresaId, "e1", "solo se lee el catálogo de la empresa del slug");
        return CATALOGO.filter((i) => i.activo !== false).slice(args.saltar ?? 0, (args.saltar ?? 0) + args.limite);
      },
      async obtener({ empresaId, codigo }) {
        assert.equal(empresaId, "e1");
        if (typeof codigo !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(codigo)) throw new ErrorCatalogo("DATOS_INVALIDOS", "código inválido");
        const i = CATALOGO.find((x) => x.codigo.toLowerCase() === codigo.toLowerCase());
        if (!i) throw new ErrorCatalogo("NO_ENCONTRADO", "ítem no encontrado");
        return { activo: true, ...i };
      },
    },
    modelos: { Empresa: { findOne: ({ slug }) => ({ lean: async () => EMPRESAS[slug] ?? null }) } },
    autenticar: () => (req, res, next) => res.status(401).json({ error: "no autenticado" }),
    requierePermiso: middleware,
    eventos: { middleware },
    auth: { exigirCsrf() {} },
    // Núcleo de cuentas falso: cada manejador responde quién es la empresa que le pasó el servicio.
    cuentasCliente: {
      manejadores({ empresaDe }) {
        const m = (nombre) => async (req, res, next) => {
          try {
            const e = await empresaDe(req);
            res.setHeader("Cache-Control", "no-store");
            res.status(200).json({ manejador: nombre, empresa: e.slug });
          } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
            next(err);
          }
        };
        return { yo: m("yo"), registro: m("registro"), login: m("login"), logout: m("logout"), password: m("password"), consentimiento: m("consentimiento") };
      },
    },
  };
}

describe("servicio público: carta", () => {
  const publico = crearPublico(nucleoFalso());

  it("agrupa por categoría, lo sin categoría va al final y no expone atributos", async () => {
    const c = await publico.carta({ slug: "cafe-central" });
    assert.deepEqual(c.empresa, { nombre: "Café Central", slug: "cafe-central", moneda: "PEN", marca: null });
    assert.deepEqual(c.categorias.map((x) => x.nombre), ["Bebidas", "Postres", "Otros"]);
    assert.deepEqual(c.categorias[0].items, [
      { codigo: "CAF-1", nombre: "Café americano", precio: 6.5 },
      { codigo: "AGU-1", nombre: "Agua", precio: null },
    ]);
    assert.ok(!JSON.stringify(c).includes("INTERNO"));
  });

  it("la marca de la empresa sale ya calculada por el núcleo y sin lo que no es público", async () => {
    const e = EMPRESAS["cafe-central"];
    e.marca = { logo: "https://img.example.com/logo.png", eslogan: "Desde 1999", colorPrincipal: "#8B1E3F", _interno: "x" };
    try {
      const { empresa } = await publico.carta({ slug: "cafe-central" });
      assert.equal(empresa.marca.logo, "https://img.example.com/logo.png");
      assert.equal(empresa.marca.eslogan, "Desde 1999");
      assert.equal(empresa.marca.tema, "claro");
      assert.equal(empresa.marca.colores["--color-principal"], "#8b1e3f");
      assert.deepEqual(Object.keys(empresa.marca).sort(), ["colores", "eslogan", "logo", "tema"]);
      assert.ok(!JSON.stringify(empresa).includes("_interno"));
      // un logo guardado que no es https no se publica
      e.marca = { logo: "javascript:alert(1)", eslogan: "Hola" };
      assert.deepEqual((await publico.carta({ slug: "cafe-central" })).empresa.marca, { logo: null, eslogan: "Hola", tema: null, colores: null });
    } finally {
      delete e.marca;
    }
  });

  it("rechaza con el mismo 404 slug inexistente, mal formado, sin el servicio, servicio apagado o empresa dada de baja", async () => {
    for (const slug of ["no-existe", "../x", "Cafe-Central", "", "sin-servicio", "servicio-off", "empresa-baja", undefined]) {
      await assert.rejects(publico.carta({ slug }), (e) => e.status === 404 && e.codigo === "NO_ENCONTRADO", `slug ${slug}`);
    }
  });

  it("agruparPorCategoria no cambia el orden dentro de cada categoría", () => {
    const g = agruparPorCategoria([{ codigo: "B", nombre: "B", categoria: " X " }, { codigo: "A", nombre: "A", categoria: "X" }]);
    assert.deepEqual(g, [{ nombre: "X", items: [{ codigo: "B", nombre: "B", precio: null }, { codigo: "A", nombre: "A", precio: null }] }]);
  });
});

describe("servicio público: detalle del plato", () => {
  const publico = crearPublico(nucleoFalso());

  it("trae descripción y foto, y solo esos dos campos de los atributos", async () => {
    const d = await publico.plato({ slug: "cafe-central", codigo: "CAF-1" });
    assert.deepEqual(d.plato, { codigo: "CAF-1", nombre: "Café americano", categoria: "Bebidas", precio: 6.5, descripcion: "Espresso doble alargado.", imagen: "https://img.example.com/cafe.jpg" });
    assert.deepEqual(d.empresa, { nombre: "Café Central", slug: "cafe-central", moneda: "PEN" });
    assert.ok(!JSON.stringify(d).includes("INTERNO"));
  });

  it("foto y descripción son opcionales: sin ellas o con valores inservibles salen null", async () => {
    const sin = await publico.plato({ slug: "cafe-central", codigo: "AGU-1" });
    assert.equal(sin.plato.imagen, null);
    assert.equal(sin.plato.descripcion, null);
    const malo = await publico.plato({ slug: "cafe-central", codigo: "ESP-1" });
    assert.equal(malo.plato.imagen, null, "javascript: no sale");
    assert.equal(malo.plato.descripcion, null, "solo espacios = sin descripción");
  });

  it("urlImagenSegura: solo https absolutas, sin credenciales ni exceso de largo", () => {
    assert.equal(urlImagenSegura("https://a.com/x.png"), "https://a.com/x.png");
    for (const v of ["http://a.com/x.png", "javascript:alert(1)", "data:image/png;base64,AAA", "//a.com/x.png", "/x.png", "https://u:p@a.com/x.png", "", null, 5, `https://a.com/${"x".repeat(500)}`])
      assert.equal(urlImagenSegura(v), null, String(v).slice(0, 30));
  });

  it("las reseñas son de ejemplo, solo texto y estrellas, y el promedio cuadra", async () => {
    const { resenas } = await publico.plato({ slug: "cafe-central", codigo: "CAF-1" });
    assert.equal(resenas.demo, true);
    assert.equal(resenas.total, resenas.resenas.length);
    assert.equal(resenas.promedio, Math.round((resenas.resenas.reduce((n, r) => n + r.estrellas, 0) / resenas.total) * 10) / 10);
    for (const r of resenas.resenas) assert.deepEqual(Object.keys(r).sort(), ["autor", "estrellas", "texto", "ts"], "sin imágenes ni videos");
    resenas.resenas[0].texto = "cambiado";
    assert.notEqual(resenasDe().resenas[0].texto, "cambiado");
  });

  it("404 con el mismo mensaje: plato inexistente, desactivado, código inválido o empresa inválida", async () => {
    for (const codigo of ["NO-HAY", "OFF-1", "../etc", "a b"])
      await assert.rejects(publico.plato({ slug: "cafe-central", codigo }), (e) => e.status === 404 && e.codigo === "NO_ENCONTRADO" && /plato/.test(e.message), codigo);
    await assert.rejects(publico.plato({ slug: "no-existe", codigo: "CAF-1" }), (e) => e.status === 404);
  });
});

describe("empresa de las cuentas públicas", () => {
  it("empresaDe entrega { id, slug } de la empresa del slug de la ruta", async () => {
    const publico = crearPublico(nucleoFalso());
    assert.deepEqual(await publico.empresaDe({ params: { empresa: "cafe-central" } }), { id: "e1", slug: "cafe-central" });
  });
  it("rechaza con 404 una empresa inexistente, sin servicio, apagada o dada de baja", async () => {
    const publico = crearPublico(nucleoFalso());
    for (const slug of ["no-existe", "sin-servicio", "servicio-off", "empresa-baja", undefined])
      await assert.rejects(publico.empresaDe({ params: { empresa: slug } }), (e) => e.status === 404, String(slug));
  });
  it("ya no existe el cliente de ejemplo", () => {
    assert.equal(crearPublico(nucleoFalso()).cliente, undefined);
  });
});

describe("rutas públicas por HTTP", () => {
  let server, url, nucleo;
  before(async () => {
    nucleo = nucleoFalso();
    const app = express();
    app.use("/base/tobt", createRouter({ core: nucleo }));
    await new Promise((r) => (server = app.listen(0, r)));
    url = `http://127.0.0.1:${server.address().port}/base/tobt`;
  });
  after(() => server.close());

  it("la página responde sin sesión, sin caché, con <base> en la raíz del montaje", async () => {
    const r = await fetch(`${url}/catalogo/cafe-central`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /html/);
    assert.match(r.headers.get("cache-control"), /no-cache/);
    const html = await r.text();
    assert.match(html, /<base href="\/base\/tobt\/" \/>/);
    assert.match(html, /id="raiz"/);
    assert.match(html, /assets\/catalogo-[^"]+\.js/);
    assert.ok(html.indexOf("<base") < html.indexOf("<script"), "<base> va antes de cualquier recurso");
  });

  it("la carta responde sin sesión", async () => {
    const r = await fetch(`${url}/publico/cafe-central/carta`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /max-age=30/);
    const d = await r.json();
    assert.equal(d.empresa.nombre, "Café Central");
    assert.equal(d.categorias.length, 3);
  });

  it("el detalle del plato responde sin sesión; un plato desconocido da 404 y no 500", async () => {
    const r = await fetch(`${url}/publico/cafe-central/plato/CAF-1`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).plato.nombre, "Café americano");
    const no = await fetch(`${url}/publico/cafe-central/plato/NO-HAY`);
    assert.equal(no.status, 404);
    assert.equal((await no.json()).error, "plato no encontrado");
  });

  it("las rutas de cuenta llegan a los manejadores del núcleo con la empresa del slug y nunca se cachean", async () => {
    const casos = [
      ["GET", "cliente", "yo"],
      ["POST", "cuenta/registro", "registro"],
      ["POST", "cuenta/login", "login"],
      ["POST", "cuenta/logout", "logout"],
      ["POST", "cuenta/password", "password"],
      ["PUT", "cuenta/consentimiento", "consentimiento"],
    ];
    for (const [metodo, ruta, manejador] of casos) {
      const r = await fetch(`${url}/publico/cafe-central/${ruta}`, {
        method: metodo,
        headers: { "content-type": "application/json", "x-requested-with": "fetch" },
        body: metodo === "GET" ? undefined : "{}",
      });
      assert.equal(r.status, 200, ruta);
      assert.equal(r.headers.get("cache-control"), "no-store", ruta);
      assert.deepEqual(await r.json(), { manejador, empresa: "cafe-central" }, ruta);
    }
  });

  it("las rutas de cuenta de una empresa desconocida dan 404, no 500", async () => {
    const r = await fetch(`${url}/publico/no-existe/cuenta/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).codigo, "NO_ENCONTRADO");
  });

  it("sin cuentas en el núcleo no se montan rutas de cuenta", async () => {
    const sin = nucleoFalso();
    delete sin.cuentasCliente;
    const app = express();
    app.use("/x", createRouter({ core: sin }));
    const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/x/publico/cafe-central/cliente`);
      assert.equal(r.status, 404);
    } finally {
      srv.close();
    }
  });

  it("empresa desconocida: 404 con mensaje, no un error 500", async () => {
    const r = await fetch(`${url}/publico/no-existe/carta`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).codigo, "NO_ENCONTRADO");
  });

  it("la API de personal sigue exigiendo sesión", async () => {
    assert.equal((await fetch(`${url}/pedidos`)).status, 401);
  });
});

describe("límite de frecuencia", () => {
  it("responde 429 con Retry-After al pasar el máximo y se renueva con la ventana", () => {
    let t = 0;
    const lim = limitadorPorIp({ ventanaMs: 1000, max: 2, ahora: () => t });
    const llamar = () => {
      const r = { code: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json() { return this; } };
      let paso = false;
      lim({ ip: "1.1.1.1" }, r, () => (paso = true));
      return { paso, r };
    };
    assert.equal(llamar().paso, true);
    assert.equal(llamar().paso, true);
    const bloqueada = llamar();
    assert.equal(bloqueada.paso, false);
    assert.equal(bloqueada.r.code, 429);
    assert.ok(Number(bloqueada.r.headers["Retry-After"]) >= 1);
    t = 1500;
    assert.equal(llamar().paso, true);
  });
});

test("paginaCatalogo escapa la base y no duplica la barra final", () => {
  assert.match(paginaCatalogo("<head></head>", "/a/b/"), /<base href="\/a\/b\/" \/>/);
  assert.match(paginaCatalogo("<head></head>", '/x"y'), /href="\/x&quot;y\/"/);
});

describe("lógica del front de la carta", () => {
  it("slugDesdeUbicacion: ruta normal, con barra final, codificada y por query en desarrollo", () => {
    assert.equal(slugDesdeUbicacion("/tobt/catalogo/cafe-central"), "cafe-central");
    assert.equal(slugDesdeUbicacion("/base/tobt/catalogo/cafe-central/"), "cafe-central");
    assert.equal(slugDesdeUbicacion("/tobt/catalogo/caf%C3%A9"), "café");
    assert.equal(slugDesdeUbicacion("/catalogo.html", "?empresa=mi-local"), "mi-local");
    assert.equal(slugDesdeUbicacion("/catalogo.html", ""), null);
    assert.equal(slugDesdeUbicacion("/tobt/catalogo/%E0%A4%A"), null);
  });
  it("formatoPrecio: moneda, sin precio y moneda inválida", () => {
    assert.equal(formatoPrecio(null, "PEN"), "Consultar");
    assert.match(formatoPrecio(6.5, "PEN"), /6[.,]50/);
    assert.equal(formatoPrecio(6.5), "6.50");
    assert.equal(formatoPrecio(6.5, "XX"), "6.50 XX");
  });
  it("filtrarCarta: por texto sin tildes ni mayúsculas, por código y por categoría", () => {
    const cats = [{ nombre: "Bebidas", items: [{ codigo: "CAF-1", nombre: "Café americano", precio: 1 }, { codigo: "AGU-1", nombre: "Agua", precio: 1 }] }, { nombre: "Postres", items: [{ codigo: "TOR-1", nombre: "Torta", precio: 1 }] }];
    assert.equal(totalItems(filtrarCarta(cats)), 3);
    assert.deepEqual(filtrarCarta(cats, { texto: "CAFE" }).map((c) => c.items[0].codigo), ["CAF-1"]);
    assert.deepEqual(filtrarCarta(cats, { texto: "tor-1" }).map((c) => c.nombre), ["Postres"]);
    assert.deepEqual(filtrarCarta(cats, { categoria: "Postres" }).map((c) => c.nombre), ["Postres"]);
    assert.deepEqual(filtrarCarta(cats, { texto: "zzz" }), []);
  });
  it("rutaDesdeHash y hashPlato: ida y vuelta, y lo desconocido cae en la carta", () => {
    assert.deepEqual(rutaDesdeHash("#/plato/CAF-1"), { vista: "plato", codigo: "CAF-1" });
    assert.deepEqual(rutaDesdeHash(hashPlato("A/B 1")), { vista: "plato", codigo: "A/B 1" });
    for (const h of ["", "#", "#/otra", "#/plato/", "#/plato/a/b", "#/plato/%E0%A4%A", undefined])
      assert.deepEqual(rutaDesdeHash(h), { vista: "carta" }, String(h));
  });
  it("estrellasLlenas y formatoNota", () => {
    assert.equal(estrellasLlenas(4.7), 5);
    assert.equal(estrellasLlenas(4.4), 4);
    assert.equal(estrellasLlenas(9), 5);
    assert.equal(estrellasLlenas(-1), 0);
    assert.equal(estrellasLlenas("x"), 0);
    assert.equal(formatoNota(4.67), "4,7");
    assert.equal(formatoNota(undefined), "—");
  });
  it("formatoPuntos", () => {
    assert.equal(formatoPuntos(45), "+45");
    assert.equal(formatoPuntos(-20), "−20");
    assert.equal(formatoPuntos(0), "0");
  });
});

describe("lógica de la cuenta en la carta", () => {
  it("validarRegistro: pide nombre, usuario, 8+ caracteres y que coincidan", () => {
    const ok = { nombre: "Ana", usuario: "ana@correo.pe", password: "12345678", repetir: "12345678" };
    assert.equal(validarRegistro(ok), null);
    assert.match(validarRegistro({ ...ok, nombre: " " }), /nombre/);
    assert.match(validarRegistro({ ...ok, usuario: "" }), /correo o tu teléfono/);
    assert.match(validarRegistro({ ...ok, password: "123", repetir: "123" }), /8 caracteres/);
    assert.match(validarRegistro({ ...ok, repetir: "otra-cosa" }), /no coinciden/);
  });
  it("cuerpoRegistro: lo que lleva @ es correo, lo demás teléfono; el consentimiento solo si se marcó", () => {
    assert.deepEqual(cuerpoRegistro({ nombre: " Ana ", usuario: " a@b.pe ", password: "x", quierePuntos: true }), { nombre: "Ana", correo: "a@b.pe", password: "x", quierePuntos: true });
    assert.deepEqual(cuerpoRegistro({ nombre: "Ana", usuario: "987654321", password: "x" }), { nombre: "Ana", telefono: "987654321", password: "x", quierePuntos: false });
  });
  it("textoMovimiento usa el detalle o un texto por tipo", () => {
    assert.equal(textoMovimiento({ detalle: "Pedido pagado", tipo: "acumulo" }), "Pedido pagado");
    assert.equal(textoMovimiento({ tipo: "canje" }), "Canje de puntos");
    assert.equal(textoMovimiento({}), "Movimiento");
  });
});

test("beneficios y vales en la carta: puntos que faltan, código en dos grupos, vales activos primero", () => {
  assert.equal(faltanPuntos({ puntos: 100 }, 40), 60);
  assert.equal(faltanPuntos({ puntos: 100 }, 100), 0);
  assert.equal(faltanPuntos({ puntos: 100 }, 250), 0);
  assert.equal(faltanPuntos(undefined, undefined), 0);
  assert.equal(formatoCodigoVale("K7M2QX"), "K7M 2QX");
  assert.equal(formatoCodigoVale("abc"), "abc");
  const g = agruparVales([
    { id: "1", estado: "usado", venceTs: "2026-11-01" },
    { id: "2", estado: "activo", venceTs: "2026-12-01" },
    { id: "3", estado: "activo", venceTs: "2026-11-05" },
    { id: "4", estado: "vencido", venceTs: "2026-10-01" },
  ]);
  assert.deepEqual(g.activos.map((v) => v.id), ["3", "2"]);
  assert.deepEqual(g.otros.map((v) => v.id), ["1", "4"]);
  assert.deepEqual(agruparVales(undefined), { activos: [], otros: [] });
});

test("textoVence cuenta días de calendario", () => {
  const hoy = new Date(2026, 9, 17, 23, 30);
  assert.equal(textoVence(new Date(2026, 9, 17, 23, 59), hoy), "Vence hoy");
  assert.equal(textoVence(new Date(2026, 9, 18, 0, 5), hoy), "Vence mañana");
  assert.equal(textoVence(new Date(2026, 9, 22, 12), hoy), "Vence en 5 días");
  assert.equal(textoVence(new Date(2026, 9, 1), hoy), "Vence hoy");
  assert.equal(textoVence("basura", hoy), "");
});

test("retos en la carta: avance, lo que falta y porcentaje", () => {
  const r = { total: 4, logrados: 1, faltan: [{ codigo: "A", nombre: "Moka" }, { codigo: "B", nombre: "Cortado" }, { codigo: "C", nombre: "Flat" }] };
  assert.equal(textoAvance(r), "1 de 4");
  assert.equal(porcentajeReto(r), 25);
  assert.equal(textoFaltan(r.faltan), "Te faltan: Moka, Cortado y Flat");
  assert.equal(textoFaltan([{ codigo: "A", nombre: "Moka" }]), "Te falta: Moka");
  assert.equal(textoFaltan([{ codigo: "A" }, { codigo: "B" }, { codigo: "C" }, { codigo: "D" }, { codigo: "E" }]), "Te faltan 5: A, B, C…");
  assert.equal(textoFaltan([]), "");
  assert.equal(textoFaltan(undefined), "");
  assert.equal(textoAvance(undefined), "0 de 0");
  assert.equal(porcentajeReto({ total: 0, logrados: 0 }), 0);
});

describe("referidos en la carta (5.47)", () => {
  it("el código del enlace ?ref= se lee, se normaliza y se descarta si no es válido", () => {
    assert.equal(codigoDeEnlace("?ref=k7m-2qxa"), "K7M2QXA");
    assert.equal(codigoDeEnlace("?empresa=geckocafe&ref=K7M2QXA"), "K7M2QXA");
    for (const m of ["", "?ref=", "?ref=corto", "?ref=K7M2QX0A", "?otro=K7M2QXA"]) assert.equal(codigoDeEnlace(m), "", m);
  });
  it("enlaceInvitacion pone ?ref= en la carta actual, sin # ni otro ref", () => {
    assert.equal(enlaceInvitacion("https://x.pe/tobt/catalogo/geckocafe#/plato/LATTE", "k7m2qxa"), "https://x.pe/tobt/catalogo/geckocafe?ref=K7M2QXA");
    assert.equal(enlaceInvitacion("https://x.pe/tobt/catalogo/geckocafe?ref=OTRO1234&a=1", "K7M2QXA"), "https://x.pe/tobt/catalogo/geckocafe?ref=K7M2QXA&a=1");
  });
  it("validarCodigoReferido: vacío vale; si hay algo, debe tener el formato", () => {
    assert.equal(validarCodigoReferido(""), null);
    assert.equal(validarCodigoReferido(undefined), null);
    assert.equal(validarCodigoReferido(" k7m 2qxa "), null);
    assert.match(validarCodigoReferido("abc"), /7 letras y números/);
    assert.match(validarRegistro({ nombre: "Ana", usuario: "a@b.pe", password: "12345678", repetir: "12345678", codigoReferido: "abc" }), /código/);
    assert.equal(validarRegistro({ nombre: "Ana", usuario: "a@b.pe", password: "12345678", repetir: "12345678", codigoReferido: "" }), null);
  });
  it("cuerpoRegistro manda codigoReferido normalizado solo si lo hay", () => {
    assert.deepEqual(cuerpoRegistro({ nombre: "Ana", usuario: "987654321", password: "x", codigoReferido: " k7m-2qxa " }), { nombre: "Ana", telefono: "987654321", password: "x", quierePuntos: false, codigoReferido: "K7M2QXA" });
    assert.equal("codigoReferido" in cuerpoRegistro({ nombre: "Ana", usuario: "987654321", password: "x", codigoReferido: "  " }), false);
  });
  it("textoPremioReferidos dice lo que gana cada quien y el mínimo; sin puntos no dice nada", () => {
    assert.equal(textoPremioReferidos({ puntosReferente: 50, puntosReferido: 25, consumoMinimo: 0 }, "PEN"), "Tú ganas 50 puntos y tu amigo 25 cuando pague su primer consumo.");
    assert.match(textoPremioReferidos({ puntosReferente: 50, puntosReferido: 0, consumoMinimo: 30 }, "PEN"), /^Tú ganas 50 puntos cuando pague su primer consumo \(de .*30.* o más\)\.$/);
    assert.equal(textoPremioReferidos({ puntosReferente: 0, puntosReferido: 10, consumoMinimo: 0 }), "Tu amigo gana 10 puntos cuando pague su primer consumo.");
    assert.equal(textoPremioReferidos({ puntosReferente: 0, puntosReferido: 0 }), "");
  });
  it("los estados y el bono tienen texto", () => {
    assert.deepEqual(Object.keys(ESTADO_REFERIDO), ["pendiente", "premiado", "sin_cupo"]);
    assert.equal(textoMovimiento({ tipo: "bono" }), "Bono por referidos");
    assert.equal(normalizarCodigoReferido("a b-c"), "ABC");
  });
});

// ---------- promociones en la carta (5.43) ----------

const regla = (o) => ({ id: "x", nombre: "N", descripcion: null, tipo: "directo", objetivo: null, disparador: null, n: null, m: null, efecto: null, valor: null, vigencia: null, dias: null, horario: null, vigenteAhora: true, ...o });
const por = (itemCodigo, categoria = null) => ({ itemCodigo, categoria });

function nucleoConPromos(promociones) {
  const nucleo = nucleoFalso();
  nucleo.promociones = {
    async vigentes({ empresaId, ahora }) {
      assert.equal(empresaId, "e1", "solo las promociones de la empresa del slug");
      assert.ok(ahora instanceof Date);
      return { zona: "America/Lima", hoy: "2026-10-22", promociones };
    },
  };
  return nucleo;
}

describe("servicio público: promociones", () => {
  it("resuelve el nombre de cada ítem y conserva las categorías y la regla", async () => {
    const publico = crearPublico(nucleoConPromos([
      regla({ id: "a", nombre: "2×1", tipo: "nxm", n: 2, m: 1, objetivo: por("caf-1") }),
      regla({ id: "b", nombre: "Combo", tipo: "combo", disparador: por("TOR-1"), objetivo: por(null, "Bebidas"), efecto: "porcentaje", valor: 50, dias: [4, 5], horario: { desde: "18:00", hasta: "21:00" }, vigenteAhora: false }),
    ]));
    const r = await publico.promociones({ slug: "cafe-central" });
    assert.deepEqual(r.empresa, { nombre: "Café Central", moneda: "PEN" });
    assert.equal(r.hoy, "2026-10-22");
    assert.equal(r.promociones.length, 2);
    assert.deepEqual(r.promociones[0].objetivo, { itemCodigo: "caf-1", categoria: null, nombre: "Café americano" }, "sin distinguir mayúsculas");
    assert.deepEqual(r.promociones[1].disparador, { itemCodigo: "TOR-1", categoria: null, nombre: "Torta de chocolate" });
    assert.deepEqual(r.promociones[1].objetivo, { itemCodigo: null, categoria: "Bebidas", nombre: null });
    assert.deepEqual([r.promociones[1].efecto, r.promociones[1].valor, r.promociones[1].vigenteAhora, r.promociones[1].dias], ["porcentaje", 50, false, [4, 5]]);
  });

  it("no muestra una promoción cuyo ítem no existe o está retirado", async () => {
    const publico = crearPublico(nucleoConPromos([
      regla({ id: "ok", objetivo: por("CAF-1"), efecto: "gratis" }),
      regla({ id: "retirado", objetivo: por("OFF-1"), efecto: "gratis" }),
      regla({ id: "inexistente", tipo: "combo", disparador: por("NO-HAY"), objetivo: por(null, "Bebidas"), efecto: "gratis" }),
    ]));
    assert.deepEqual((await publico.promociones({ slug: "cafe-central" })).promociones.map((p) => p.id), ["ok"]);
  });

  it("no filtra datos internos, y un núcleo sin promociones da una lista vacía", async () => {
    const publico = crearPublico(nucleoConPromos([{ ...regla({ objetivo: por("CAF-1") }), prioridad: 3, acumulable: true, creadoPor: "u1" }]));
    const json = JSON.stringify(await publico.promociones({ slug: "cafe-central" }));
    for (const interno of ["prioridad", "acumulable", "creadoPor"]) assert.equal(json.includes(interno), false, interno);
    assert.deepEqual((await crearPublico(nucleoFalso()).promociones({ slug: "cafe-central" })).promociones, []);
  });

  it("una carta desconocida da 404 como las demás", async () => {
    await assert.rejects(crearPublico(nucleoConPromos([])).promociones({ slug: "no-existe" }), (e) => e.status === 404);
  });
});

describe("ruta pública de promociones", () => {
  let server, url;
  before(async () => {
    const app = express();
    app.use("/base/tobt", createRouter({ core: nucleoConPromos([regla({ objetivo: por("CAF-1"), efecto: "gratis" })]) }));
    await new Promise((r) => (server = app.listen(0, r)));
    url = `http://127.0.0.1:${server.address().port}/base/tobt`;
  });
  after(() => server.close());

  it("responde sin sesión, con caché corta; una carta desconocida da 404", async () => {
    const r = await fetch(`${url}/publico/cafe-central/promociones`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control"), /max-age=30/);
    assert.equal((await r.json()).promociones.length, 1);
    assert.equal((await fetch(`${url}/publico/no-existe/promociones`)).status, 404);
  });
});

describe("textos de las promociones en la carta", () => {
  it("fechas y días: tramos seguidos, listas y «todos los días»", () => {
    assert.equal(textoFecha("2026-11-01"), "1 nov 2026");
    assert.equal(textoFecha("basura"), "basura");
    assert.equal(textoDias([4, 5]), "jueves y viernes");
    assert.equal(textoDias([1, 2, 3, 4, 5]), "de lunes a viernes");
    assert.equal(textoDias([5, 6, 0]), "de viernes a domingo");
    assert.equal(textoDias([1, 3, 5]), "lunes, miércoles y viernes");
    assert.equal(textoDias([1, 2, 4, 5, 6]), "lunes, martes y de jueves a sábado");
    for (const todos of [null, [], [0, 1, 2, 3, 4, 5, 6]]) assert.equal(textoDias(todos), null);
  });
  it("cuándo rige: días, horario y vigencia", () => {
    assert.equal(textoCuando(regla({})), "Todos los días");
    assert.equal(textoCuando(regla({ dias: [4, 5], horario: { desde: "18:00", hasta: "21:00" } })), "Jueves y viernes, de 18:00 a 21:00");
    assert.equal(textoCuando(regla({ vigencia: { desde: "2026-11-01", hasta: "2026-11-30" } })), "Todos los días · del 1 nov 2026 al 30 nov 2026");
    assert.equal(textoCuando(regla({ vigencia: { hasta: "2026-11-30" } })), "Todos los días · hasta el 30 nov 2026");
    assert.equal(textoCuando(regla({ vigencia: { desde: "2026-11-01" } })), "Todos los días · desde el 1 nov 2026");
  });
  it("la regla en palabras, para cada tipo y efecto", () => {
    const latte = { itemCodigo: "LATTE", categoria: null, nombre: "Latte" };
    const cafes = { itemCodigo: null, categoria: "Cafés", nombre: null };
    assert.equal(textoRegla(regla({ tipo: "nxm", n: 2, m: 1, objetivo: latte })), "2×1 en Latte: lleva 2 y paga 1.");
    assert.equal(textoRegla(regla({ tipo: "nxm", n: 3, m: 2, objetivo: cafes })), "3×2 en productos de Cafés: lleva 3 y paga 2.");
    assert.equal(textoRegla(regla({ efecto: "porcentaje", valor: 10, objetivo: latte })), "10 % de descuento en Latte.");
    assert.equal(textoRegla(regla({ efecto: "porcentaje", valor: 12.5, objetivo: cafes })), "12,5 % de descuento en productos de Cafés.");
    assert.match(textoRegla(regla({ efecto: "monto", valor: 3, objetivo: latte }), "PEN"), /^S\/\s?3[.,]00 de descuento en Latte\.$/);
    assert.equal(textoRegla(regla({ efecto: "gratis", objetivo: latte })), "Latte gratis.");
    assert.equal(textoRegla(regla({ tipo: "combo", disparador: { itemCodigo: "TORTA", categoria: null, nombre: "Torta" }, objetivo: cafes, efecto: "porcentaje", valor: 50 })), "Llevando Torta, un producto de Cafés con 50 % de descuento.");
    assert.equal(textoRegla(regla({ tipo: "combo", disparador: cafes, objetivo: latte, efecto: "gratis" })), "Llevando un producto de Cafés, Latte gratis.");
  });
  it("estado y orden: las vigentes primero; las que aún no empiezan dicen cuándo", () => {
    assert.deepEqual(estadoPromocion(regla({ vigenteAhora: true }), "2026-10-22"), { clave: "ahora", texto: "Vigente ahora" });
    assert.deepEqual(estadoPromocion(regla({ vigenteAhora: false, vigencia: { desde: "2026-11-01" } }), "2026-10-22"), { clave: "pronto", texto: "Desde el 1 nov 2026" });
    assert.deepEqual(estadoPromocion(regla({ vigenteAhora: false, dias: [1] }), "2026-10-22"), { clave: "fuera", texto: "Hoy no rige" });
    assert.deepEqual(ordenarPromociones([regla({ id: "a", vigenteAhora: false }), regla({ id: "b" }), regla({ id: "c", vigenteAhora: false }), regla({ id: "d" })]).map((p) => p.id), ["b", "d", "a", "c"]);
    assert.deepEqual(ordenarPromociones(undefined), []);
  });
});
