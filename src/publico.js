import { ErrorPedido } from "./errores.js";
import { ErrorCatalogo, marcaPublica } from "core";

// Vista pública de la carta (sin sesión). La empresa se identifica por su `slug` (arquitectura 5.13: los pedidos
// por QR serán una ruta pública con la empresa por slug). Solo se expone lo que un cliente puede ver:
// nombre de la empresa, moneda y, de cada ítem ACTIVO del catálogo, código, nombre, categoría y precio; el detalle
// de un plato suma su descripción y foto. Nunca el resto de `atributos` (son internos del servicio), ni ítems
// desactivados, ni nada de pedidos o clientes reales.

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SIN_CATEGORIA = "Otros";
const TOPE_ITEMS = 1000; // la carta se lee por páginas de 200 (máximo de core.catalogo.listar)

const noEncontrada = () => new ErrorPedido("NO_ENCONTRADO", "carta no encontrada");
const platoNoEncontrado = () => new ErrorPedido("NO_ENCONTRADO", "plato no encontrado");

// La descripción y la foto de un plato viven en los atributos del ítem: DESCRIPCION (texto) e IMAGEN (URL).
// Solo esos dos campos salen al público, nunca el resto de `atributos`.
export const CAMPOS_PLATO = { DESCRIPCION: "texto", IMAGEN: "texto" };

/** Solo URLs https absolutas y sin credenciales: lo demás (javascript:, data:, http:, relativas) se descarta. */
export function urlImagenSegura(valor) {
  if (typeof valor !== "string" || valor.length > 500) return null;
  try {
    const u = new URL(valor.trim());
    if (u.protocol !== "https:" || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

const textoONulo = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Agrupa por categoría conservando el orden alfabético del catálogo; lo sin categoría va al final. */
export function agruparPorCategoria(items) {
  const grupos = new Map();
  for (const i of items) {
    const nombre = i.categoria?.trim() ? i.categoria.trim() : SIN_CATEGORIA;
    if (!grupos.has(nombre)) grupos.set(nombre, []);
    // `agotado` (5.60): cocina lo marcó hoy. El plato sigue en la carta, con su etiqueta.
    grupos.get(nombre).push({ codigo: i.codigo, nombre: i.nombre, precio: i.precio ?? null, agotado: i.agotado === true });
  }
  const lista = [...grupos].map(([nombre, its]) => ({ nombre, items: its }));
  lista.sort((a, b) => {
    if (a.nombre === SIN_CATEGORIA) return b.nombre === SIN_CATEGORIA ? 0 : 1;
    if (b.nombre === SIN_CATEGORIA) return -1;
    return a.nombre.localeCompare(b.nombre, "es");
  });
  return lista;
}

export function crearPublico(core) {
  /**
   * Empresa pública por slug: debe existir, estar activa y tener el servicio `tobt` activo.
   * Todos los casos de rechazo dan el mismo 404: no se revela qué empresas existen.
   */
  async function empresaPorSlug(slug) {
    if (typeof slug !== "string" || !SLUG.test(slug)) throw noEncontrada();
    // Empresa es un modelo global (sin tenancy): se consulta sin empresa activa.
    const e = await core.modelos.Empresa.findOne({ slug }).lean();
    if (!e || e.activa === false) throw noEncontrada();
    const sirve = (e.servicios ?? []).some((s) => s.codigo === "tobt" && s.activa !== false);
    if (!sirve) throw noEncontrada();
    return e;
  }

  async function carta({ slug }) {
    const e = await empresaPorSlug(slug);
    const empresaId = e._id;
    const items = [];
    for (let saltar = 0; saltar < TOPE_ITEMS; saltar += 200) {
      const pagina = await core.catalogo.listar({ empresaId, limite: 200, saltar });
      items.push(...pagina);
      if (pagina.length < 200) break;
    }
    return {
      // `marca` (5.33): logo, eslogan y paleta ya calculada por el núcleo; null si la empresa no personalizó nada
      empresa: { nombre: e.nombre, slug: e.slug, moneda: e.moneda ?? "PEN", marca: marcaPublica(e) },
      categorias: agruparPorCategoria(items),
    };
  }

  /**
   * Las reseñas visibles de un plato para cualquiera (5.62): total, promedio y las más recientes, con el autor como
   * «María P.». Es la misma para todos (la lee la caché pública), así que no lleva nada del que mira: `mia` se quita.
   * Con un núcleo sin reseñas o si falla la lectura, el plato sale igual sin reseñas.
   */
  async function resenasPublicas({ empresaId, codigo }) {
    const vacio = { total: 0, promedio: null, resenas: [] };
    if (typeof core.resenas?.deItem !== "function") return vacio;
    try {
      const r = await core.resenas.deItem({ empresaId, itemCodigo: codigo });
      return { total: r.total, promedio: r.promedio, resenas: r.resenas.map(({ id, autor, estrellas, texto, ts }) => ({ id, autor, estrellas, texto, ts })) };
    } catch (err) {
      console.error("[tobt] no se pudieron leer las reseñas:", err?.message ?? err);
      return vacio;
    }
  }

  /** Un plato (ítem activo) con descripción y foto opcionales, y sus reseñas reales (solo estrellas y texto). */
  async function plato({ slug, codigo }) {
    const e = await empresaPorSlug(slug);
    let i;
    try {
      i = await core.catalogo.obtener({ empresaId: e._id, codigo });
    } catch (err) {
      if (err instanceof ErrorCatalogo) throw platoNoEncontrado();
      throw err;
    }
    if (i.activo === false) throw platoNoEncontrado();
    const a = i.atributos ?? {};
    return {
      empresa: { nombre: e.nombre, slug: e.slug, moneda: e.moneda ?? "PEN" },
      plato: {
        codigo: i.codigo,
        nombre: i.nombre,
        categoria: i.categoria ?? null,
        precio: i.precio ?? null,
        agotado: i.agotado === true,
        descripcion: textoONulo(a.DESCRIPCION),
        imagen: urlImagenSegura(a.IMAGEN),
      },
      resenas: await resenasPublicas({ empresaId: e._id, codigo: i.codigo }),
    };
  }

  /**
   * Promociones vigentes para mostrar en la carta (5.43). Solo la regla (el front la escribe en palabras) y, de cada ítem
   * al que se refiere, su nombre. Una promoción cuyo ítem ya no existe o está retirado no se muestra: el cliente no
   * podría pedirlo. Con un núcleo sin promociones, lista vacía.
   */
  async function promociones({ slug, ahora = new Date() }) {
    const e = await empresaPorSlug(slug);
    const empresa = { nombre: e.nombre, moneda: e.moneda ?? "PEN" };
    if (typeof core.promociones?.vigentes !== "function") return { empresa, hoy: null, promociones: [] };
    const r = await core.promociones.vigentes({ empresaId: e._id, ahora });
    const nombres = new Map(); // código (en minúsculas) → nombre del ítem, o null si ya no se puede pedir
    const codigos = new Set(
      r.promociones.flatMap((p) => [p.objetivo?.itemCodigo, p.disparador?.itemCodigo]).filter(Boolean).map((c) => c.toLowerCase()),
    );
    for (const c of [...codigos].slice(0, 100)) {
      try {
        const i = await core.catalogo.obtener({ empresaId: e._id, codigo: c });
        nombres.set(c, i.activo === false ? null : i.nombre);
      } catch (err) {
        if (!(err instanceof ErrorCatalogo)) throw err;
        nombres.set(c, null);
      }
    }
    const selector = (s) => (s ? { itemCodigo: s.itemCodigo, categoria: s.categoria, nombre: s.itemCodigo ? nombres.get(s.itemCodigo.toLowerCase()) ?? null : null } : null);
    const visibles = r.promociones
      .filter((p) => [p.objetivo, p.disparador].every((s) => !s?.itemCodigo || nombres.get(s.itemCodigo.toLowerCase())))
      .map((p) => ({
        id: p.id, nombre: p.nombre, descripcion: p.descripcion, tipo: p.tipo, objetivo: selector(p.objetivo), disparador: selector(p.disparador),
        n: p.n, m: p.m, efecto: p.efecto, valor: p.valor, vigencia: p.vigencia, dias: p.dias, horario: p.horario, vigenteAhora: p.vigenteAhora,
      }));
    return { empresa, hoy: r.hoy, promociones: visibles };
  }

  /**
   * Eventos y publicidad para mostrar en la carta (5.49). El núcleo ya filtra por activo y vigencia (a la hora de la
   * empresa) y ordena; aquí solo se vuelve a pasar la foto por `urlImagenSegura` (https y nada más) antes de salir al
   * público, aunque el núcleo ya la validó. Con un núcleo sin anuncios, listas vacías.
   */
  async function anuncios({ slug, ahora = new Date() }) {
    const e = await empresaPorSlug(slug);
    const empresa = { nombre: e.nombre };
    if (typeof core.anuncios?.vigentes !== "function") return { empresa, hoy: null, eventos: [], publicidad: [] };
    const r = await core.anuncios.vigentes({ empresaId: e._id, ahora });
    const salida = (a) => ({
      id: a.id, tipo: a.tipo, titulo: a.titulo, descripcion: a.descripcion ?? null, imagen: urlImagenSegura(a.imagen),
      fecha: a.fecha ?? null, hora: a.hora ?? null, lugar: a.lugar ?? null, vigencia: a.vigencia ?? null,
    });
    return { empresa, hoy: r.hoy, eventos: r.eventos.map(salida), publicidad: r.publicidad.map(salida) };
  }

  /** La empresa de una petición pública, en la forma que piden los manejadores de cuentas del núcleo. */
  async function empresaDe(req) {
    const e = await empresaPorSlug(req.params?.empresa);
    return { id: e._id, slug: e.slug };
  }

  return { carta, plato, promociones, anuncios, empresaPorSlug, empresaDe };
}
