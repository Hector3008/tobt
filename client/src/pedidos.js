// Lógica pura del front de ítems (sin React ni navegador): se prueba con `node --test`.
//
// IMPORTANTE: ocultar o mostrar un botón aquí NO es seguridad. El servicio comprueba el permiso de
// cada operación y el motor de documentos exige la estación de cada paso (arquitectura 5.18).

/** Misma regla que `permite` del núcleo (core/src/permisos.js) y que `cuenta/client/src/destinos.js`. */
export function permite(permisos, requerido) {
  if (!Array.isArray(permisos) || typeof requerido !== "string") return false;
  const [recurso] = requerido.split(":");
  return permisos.some((p) => p === "*" || p === requerido || p === `${recurso}:*`);
}

export const ESTADOS_PEDIDO = { abierto: "Abierto", pagado: "Pagado", anulado: "Anulado" };
export const ESTADOS_ITEM = { en_cocina: "En cocina", lista: "Lista", entregado: "Entregado", pagado: "Pagado", anulado: "Anulado" };
export const CANALES = { salon: "Salón", llevar: "Para llevar", delivery: "Delivery" };
// Mismos que MOTIVOS_ANULACION del servicio (src/tipos.js)
export const MOTIVOS_ANULACION = [
  ["error_pedido", "Error en el pedido"],
  ["cliente_se_fue", "El cliente se fue"],
  ["sin_stock", "Sin stock"],
  ["cortesia", "Cortesía"],
  ["otro", "Otro"],
];
export const MAX_CANTIDAD = 99;

/** Filtros de la lista de pedidos: `estado` es el parámetro `?estado=` de GET /pedidos. */
export const FILTROS = [
  { id: "abierto", titulo: "Abiertos", estado: "abierto" },
  { id: "pagado", titulo: "Pagados", estado: "pagado" },
  { id: "anulado", titulo: "Anulados", estado: "anulado" },
];

// ---------- dinero ----------

/** Con moneda conocida, formato de moneda; sin ella, el número con 2 decimales. null = sin precio. */
export function formatoDinero(valor, moneda) {
  if (valor === null || valor === undefined) return "—";
  const n = Number(valor);
  if (!Number.isFinite(n)) return "—";
  if (!moneda) return n.toFixed(2);
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency: moneda }).format(n);
  } catch {
    return `${n.toFixed(2)} ${moneda}`;
  }
}

/** El núcleo rechaza más de 2 decimales (5.16): se valida antes de enviar. Vacío = sin precio. */
export function parsearPrecio(texto) {
  const t = String(texto ?? "").trim().replace(",", ".");
  if (t === "") return { ok: true, valor: null };
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return { ok: false };
  return { ok: true, valor: Number(t) };
}

/** Total que se muestra mientras se arma el ítem (el que vale es el que calcula el servidor).
 *  Con enteros en centavos y `null` si alguna línea no tiene precio: nunca se inventa un precio. */
export function totalEstimado(lineas) {
  let centavos = 0;
  for (const l of lineas) {
    if (l.precio === null || l.precio === undefined) return null;
    centavos += Math.round(Number(l.precio) * 100) * l.cantidad;
  }
  return centavos / 100;
}

// ---------- ítems que se están pidiendo (antes de enviarlos) ----------

let contador = 0;
const clave = () => `l${++contador}`;

/** Línea del catálogo: { clave, codigo, nombre, precio, cantidad, notas }. Si ya está, suma 1. */
export function agregarDelCatalogo(lineas, item) {
  const i = lineas.findIndex((l) => l.codigo && l.codigo.toLowerCase() === String(item.codigo).toLowerCase());
  if (i >= 0)
    return lineas.map((l, j) => (j === i ? { ...l, cantidad: Math.min(l.cantidad + 1, MAX_CANTIDAD) } : l));
  return [
    ...lineas,
    {
      clave: clave(),
      codigo: item.codigo,
      nombre: item.nombre,
      precio: item.precio ?? null,
      precioCatalogo: item.precio ?? null,
      modificado: false,
      agotado: item.agotado === true, // cocina lo marcó agotado (5.60): es un aviso, se puede pedir igual
      cantidad: 1,
      notas: "",
    },
  ];
}

/**
 * Precio unitario escrito a mano en una línea. Devuelve las líneas nuevas, o las mismas si el texto no es
 * un precio válido (hasta 2 decimales). En una línea del catálogo, vacío = volver al precio del catálogo;
 * en una libre, vacío = sin precio. El servidor solo acepta el precio propio de una línea del catálogo
 * con estacion:administracion (ver `puedeCambiarPrecio`).
 */
export function fijarPrecio(lineas, k, texto) {
  const p = parsearPrecio(texto);
  if (!p.ok) return lineas;
  return lineas.map((l) => {
    if (l.clave !== k) return l;
    if (l.libre) return { ...l, precio: p.valor };
    if (p.valor === null) return { ...l, precio: l.precioCatalogo ?? null, modificado: false };
    return { ...l, precio: p.valor, modificado: p.valor !== (l.precioCatalogo ?? null) };
  });
}

/** Cambiar el precio de una línea del catálogo lo permite la estación de administración (igual que en el servicio). */
export const puedeCambiarPrecio = (permisos) => permite(permisos, "estacion:administracion");

/** Línea libre (no está en el catálogo): { clave, libre: true, nombre, precio, cantidad, notas }. */
export function agregarLibre(lineas, { nombre, precio }) {
  return [...lineas, { clave: clave(), libre: true, nombre: nombre.trim(), precio: precio ?? null, cantidad: 1, notas: "" }];
}

export function cambiarCantidad(lineas, k, delta) {
  return lineas.map((l) =>
    l.clave === k ? { ...l, cantidad: Math.min(Math.max(l.cantidad + delta, 1), MAX_CANTIDAD) } : l,
  );
}

/** Un ítem del formulario → el que acepta POST /pedidos y POST /pedidos/:code/items. */
export function itemAEnvio(l) {
  const base = { cantidad: l.cantidad, ...(l.notas?.trim() ? { notas: l.notas.trim() } : {}) };
  if (!l.libre) return { codigo: l.codigo, ...(l.modificado ? { precio: l.precio } : {}), ...base };
  const libre = { nombre: l.nombre };
  if (l.precio !== null && l.precio !== undefined) libre.precio = l.precio;
  if (l.codigoLibre) libre.codigo = l.codigoLibre;
  return { libre, ...base };
}

// ---------- formulario del pedido ----------

export const formularioVacio = (canal = "salon") => ({
  canal,
  mesa: "",
  referencia: "",
  direccion: "",
  telefono: "",
  referenciaEntrega: "",
  notas: "",
  cliente: null, // { id, nombre, ... } elegido en el selector; null = sin cliente cargado
  items: [],
});

/** Ayuda antes de enviar; el servidor es quien valida de verdad. Devuelve un texto o null. */
export function validarFormulario(f) {
  if (f.canal === "salon" && !f.mesa.trim()) return "Indica la mesa.";
  if (f.canal === "llevar" && !f.referencia.trim()) return "Indica a nombre de quién es el pedido.";
  if (f.canal === "delivery") {
    if (!f.direccion.trim()) return "Indica la dirección de entrega.";
    if (!f.telefono.trim()) return "Indica el teléfono de contacto.";
    if (!/^\+?[0-9 ()-]{6,30}$/.test(f.telefono.trim()))
      return "El teléfono solo admite dígitos, espacios, guiones y un + inicial.";
  }
  if (!f.items.length) return "Agrega al menos un ítem.";
  return null;
}

const nulo = (t) => (t.trim() ? t.trim() : null);

/** Datos del canal, sin los campos de los otros canales (el servicio los rechaza). */
function datosDelCanal(f) {
  if (f.canal === "salon") return { mesa: f.mesa.trim() };
  if (f.canal === "llevar") return { referencia: f.referencia.trim() };
  return {
    entrega: { direccion: f.direccion.trim(), telefono: f.telefono.trim(), referencia: nulo(f.referenciaEntrega) },
  };
}

/** Cuerpo de POST /pedidos: el pedido se abre con su primer ítem. */
export function cuerpoPedido(f) {
  return {
    canal: f.canal,
    ...datosDelCanal(f),
    notas: nulo(f.notas),
    ...(f.cliente?.id ? { clienteId: f.cliente.id } : {}),
    items: f.items.map(itemAEnvio),
  };
}

/** Cuerpo de POST /pedidos/:code/items. */
export const cuerpoItems = (items) => ({ items: items.map(itemAEnvio) });

/** Formulario de los datos de un pedido ya abierto (PUT /pedidos/:code). */
export function formularioDesdePedido(c) {
  const d = c?.doc ?? {};
  return {
    canal: d.canal ?? "salon",
    mesa: d.mesa ?? "",
    referencia: d.referencia ?? "",
    direccion: d.entrega?.direccion ?? "",
    telefono: d.entrega?.telefono ?? "",
    referenciaEntrega: d.entrega?.referencia ?? "",
    notas: d.notas ?? "",
    cliente: null,
    items: [],
  };
}

/** Cuerpo de PUT /pedidos/:code (el canal no cambia). Los ítems no se editan aquí. */
export function cuerpoDatos(f, esperaVersion) {
  return { esperaVersion, ...datosDelCanal(f), notas: nulo(f.notas) };
}

// ---------- qué se ofrece ----------

const EN_CURSO = ["en_cocina", "lista"];

/**
 * Acciones de un ítem (un ítem) según su estado y los permisos. Refleja lo que exige el servidor:
 * documento:editar en la ruta; marcar lista pide la estación de cocina; entregar no pide estación; anular
 * pide estacion:creacion mientras está en cocina y administración después; el precio lo corrige administración.
 * Ocultar un botón NO es seguridad.
 */
export function accionesItem(estado, permisos) {
  const editar = permite(permisos, "documento:editar");
  const pasos = [];
  if (estado === "en_cocina" && editar && permite(permisos, "estacion:cocina")) pasos.push({ id: "lista", etiqueta: "Listo" });
  if (estado === "lista" && editar) pasos.push({ id: "entregar", etiqueta: "Entregar" });
  const anular =
    editar &&
    (estado === "en_cocina" ? permite(permisos, "estacion:creacion") : ["lista", "entregado"].includes(estado) && permite(permisos, "estacion:administracion"));
  // Corregir el precio sin anular: administración, en cualquier estado vivo. Ocultar el botón NO es seguridad.
  const precio = editar && estado !== "anulado" && estado !== "pagado" && permite(permisos, "estacion:administracion");
  // Cuenta dividida: a quién se le cobra el ítem (quien edita pedidos) y cobrarlo solo (administración, ya entregado).
  const cliente = editar && ["en_cocina", "lista", "entregado"].includes(estado);
  const cobrar = editar && estado === "entregado" && permite(permisos, "estacion:administracion");
  return { pasos, anular: Boolean(anular), precio: Boolean(precio), cliente: Boolean(cliente), cobrar: Boolean(cobrar) };
}

/** Lo que se envía a POST /items/:code/precio: el precio es obligatorio (para quitarlo se anula y se pide otro). */
export function cuerpoPrecio(texto) {
  const p = parsearPrecio(texto);
  if (!p.ok) return { ok: false, error: "Hasta 2 decimales." };
  if (p.valor === null) return { ok: false, error: "Escribe el precio." };
  return { ok: true, precio: p.valor };
}

/**
 * Cuántos ítems hay en cada estado y el total de lo que se cobra. `total` es de todo lo no anulado; `cobrado` lo ya
 * pagado y `porCobrar` lo que falta (null si algún ítem de esa parte no tiene precio).
 */
export function resumenItems(items) {
  const r = { enCocina: 0, listos: 0, entregados: 0, pagados: 0, anulados: 0, total: 0, cobrado: 0, porCobrar: 0, activos: 0, sinPrecio: false };
  let centavos = 0;
  let cobrado = 0;
  let falta = 0;
  let sinPrecioFalta = false;
  for (const i of items ?? []) {
    if (i.estado === "en_cocina") r.enCocina++;
    else if (i.estado === "lista") r.listos++;
    else if (i.estado === "entregado") r.entregados++;
    else if (i.estado === "pagado") r.pagados++;
    else if (i.estado === "anulado") {
      r.anulados++;
      continue;
    }
    r.activos++;
    const sinPrecio = i.subtotal === null || i.subtotal === undefined;
    if (sinPrecio) r.sinPrecio = true;
    if (sinPrecio && i.estado !== "pagado") sinPrecioFalta = true;
    if (!sinPrecio) {
      const c = Math.round(Number(i.subtotal) * 100);
      centavos += c;
      if (i.estado === "pagado") cobrado += c;
      else falta += c;
    }
  }
  r.total = r.sinPrecio ? null : centavos / 100;
  r.cobrado = cobrado / 100;
  r.porCobrar = sinPrecioFalta ? null : falta / 100;
  return r;
}

/**
 * Cuenta dividida: los ítems de un pedido agrupados por a quién se le cobran (el cliente del ítem, o el del pedido,
 * o nadie). Solo cuenta lo que falta cobrar. Cada grupo: { clave, cliente, items, entregados, subtotal, sinPrecio }
 * donde `entregados` son los códigos que ya se pueden cobrar y `subtotal` suma los entregados.
 */
export function gruposPorCliente(pedido) {
  const grupos = new Map();
  for (const i of pedido?.items ?? []) {
    if (i.estado === "anulado" || i.estado === "pagado") continue;
    const cliente = i.cliente ?? pedido?.cliente ?? null;
    const clave = cliente?.id ?? "sin-cliente";
    const g = grupos.get(clave) ?? { clave, cliente, items: [], entregados: [], subtotal: 0, sinPrecio: false, enCurso: 0 };
    g.items.push(i);
    if (i.estado === "entregado") {
      g.entregados.push(i.code);
      if (i.subtotal === null || i.subtotal === undefined) g.sinPrecio = true;
      else g.subtotal = Math.round((g.subtotal + Number(i.subtotal)) * 100) / 100;
    } else g.enCurso++;
    grupos.set(clave, g);
  }
  // Los que tienen cliente primero, por nombre; el grupo sin cliente al final
  return [...grupos.values()].sort((a, b) => (a.cliente ? 0 : 1) - (b.cliente ? 0 : 1) || (a.cliente?.nombre ?? "").localeCompare(b.cliente?.nombre ?? ""));
}

/**
 * Acciones de un pedido. Cobrar es de todo el pedido y solo cuando todos los ítems ya se entregaron (o se
 * anuló), igual que en el servidor; `motivoNoCobrar` explica por qué todavía no.
 */
export function accionesPedido(pedido, permisos) {
  const abierto = pedido?.estado === "abierto";
  const editar = permite(permisos, "documento:editar");
  const admin = editar && permite(permisos, "estacion:administracion");
  const r = resumenItems(pedido?.items);
  let motivoNoCobrar = null;
  if (r.enCocina + r.listos > 0) motivoNoCobrar = `Faltan ${r.enCocina + r.listos} item(s) por entregar.`;
  else if (r.entregados === 0 && r.pagados === 0) motivoNoCobrar = "No hay nada entregado que cobrar.";
  return {
    agregar: abierto && permite(permisos, "documento:crear"),
    editarDatos: abierto && editar,
    cobrar: abierto && admin,
    puedeCobrarAhora: abierto && admin && motivoNoCobrar === null,
    motivoNoCobrar,
    // Con ítems ya cobrados no se anula el pedido entero (se anulan los que faltan y el pedido se cierra solo)
    anular: abierto && admin && r.pagados === 0,
    // Hay algo para cobrar por separado (el botón de cada ítem y de cada comensal)
    dividir: abierto && admin && r.entregados > 0,
  };
}

// ---------- cocina: una tarjeta por ítem ----------

/**
 * Lo que ve cocina: cada ítem en cocina es una tarjeta, no el pedido entera. Así se saca primero
 * lo que va antes (el café) y se lleva sin esperar al resto (el sándwich). Los más antiguos primero.
 */
export function itemsDeCocina(items) {
  const t = (x) => (x.creadoTs ? Date.parse(x.creadoTs) || 0 : 0);
  return [...(items ?? [])]
    .filter((p) => p.estado === "en_cocina")
    .map((p) => ({ ...p, destino: destinoDe(p.pedido) }))
    .sort((a, b) => t(a) - t(b) || a.code.localeCompare(b.code));
}

/** "hace 5 min" para la espera de un ítem en cocina. */
export function haceCuanto(ts, ahora = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.round((ahora - t) / 60000));
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  return `hace ${h} h ${min % 60} min`;
}

/** Marcar ítems como listos es trabajo de cocina (documento:editar + estacion:cocina). */
export const puedeMarcarListos = (permisos) => permite(permisos, "documento:editar") && permite(permisos, "estacion:cocina");

/** Una línea de texto: dónde val pedido. */
export function destinoDe(c) {
  if (!c) return "";
  if (c.canal === "salon") return c.mesa ? `Mesa ${c.mesa}` : "Salón";
  if (c.canal === "llevar") return c.referencia ? `Para llevar · ${c.referencia}` : "Para llevar";
  if (c.canal === "delivery") return c.referencia ? `Delivery · ${c.referencia}` : "Delivery";
  return "";
}

// ---------- cliente del pedido y puntos ----------

/** Lo que se muestra de un cliente en listas y en el pedido: "Ana Ruiz · +51 987 654 321". */
export function etiquetaCliente(c) {
  if (!c) return "";
  const dato = c.telefono || c.correo || "";
  return dato ? `${c.nombre} · ${dato}` : c.nombre;
}

/** Aviso del selector cuando el cliente aún no acepta el programa de puntos (no acumula hasta que lo acepte). Solo si se conoce su ficha. */
export const sinProgramaPuntos = (c) => Boolean(c?.consentimientos) && c.consentimientos.programaPuntos?.otorgado !== true;

/** Cuerpo de POST /clientes: solo lo que se escribió (el servidor valida y normaliza el teléfono). */
export function cuerpoClienteNuevo({ nombre, telefono, correo }) {
  const n = String(nombre ?? "").trim();
  if (!n) return { ok: false, error: "Escribe el nombre del cliente." };
  const t = String(telefono ?? "").trim();
  const c = String(correo ?? "").trim();
  if (!t && !c) return { ok: false, error: "Indica un teléfono o un correo: con eso el cliente entra a su cuenta." };
  return { ok: true, cuerpo: { nombre: n, ...(t ? { telefono: t } : {}), ...(c ? { correo: c } : {}) } };
}

// ---------- referidos (5.47) ----------

const CODIGO_REFERIDO = /^[A-HJ-NP-Z2-9]{7}$/; // el mismo formato que genera el núcleo

/** «k7m-2qxa» → «K7M2QXA». */
export const normalizarCodigoReferido = (t) => String(t ?? "").toUpperCase().replace(/[\s-]/g, "");

/** ¿Lo escrito es un código de referido completo (y no el nombre o teléfono de alguien)? */
export const esCodigoReferido = (t) => CODIGO_REFERIDO.test(normalizarCodigoReferido(t));

/**
 * Quién refirió a un cliente nuevo → el código que se envía a POST /clientes/:id/referente.
 * `referente` es `{ tipo: "cliente", id, nombre }` (se busca su código) o `{ tipo: "codigo", codigo }`.
 */
export function codigoDeReferente(referente, buscarCodigo) {
  if (!referente) return null;
  if (referente.tipo === "codigo") return normalizarCodigoReferido(referente.codigo);
  return buscarCodigo(referente.id);
}

/** Lo que se le dice a quien cobra tras anotar al referente. */
export const textoReferenteAnotado = (nombreReferente) => `Anotado: lo refirió ${nombreReferente}. Los dos ganan puntos cuando pague su primer consumo.`;

// Por qué no acumuló; `n` es el sujeto ("El cliente", "Ana")
const MOTIVOS_PUNTOS = {
  sin_consentimiento: (n) => `${n} no aceptó el programa de puntos: no acumula`,
  deshabilitada: () => "el programa de puntos está desactivado",
  sin_monto: () => "no hay un total para dar puntos",
  sin_puntos: () => "este monto no alcanza para ganar puntos",
  cliente_inactivo: (n) => `${n} está desactivado: no acumula`,
  cliente_no_encontrado: () => "no se encontró al cliente: no acumula",
};
const ptos = (n) => `${n} punto${n === 1 ? "" : "s"}`;
const porque = (motivo, nombre) => MOTIVOS_PUNTOS[motivo]?.(nombre) ?? null;

/**
 * Frase para el cajero tras cobrar: cuántos puntos ganó el cliente, o por qué no. Con varios clientes (cuenta
 * dividida) dice uno por uno. Null si lo cobrado no tenía cliente.
 */
export function textoPuntos(puntos) {
  if (!puntos) return null;
  if (puntos.clientes?.length > 1) {
    const partes = puntos.clientes.map((c) =>
      c.error ? `${c.nombre}: no se pudieron registrar sus puntos` : c.acumulados > 0 ? `${c.nombre} ganó ${ptos(c.acumulados)}` : porque(c.motivo, c.nombre) ?? `${c.nombre} no acumuló`,
    );
    return `${partes.join(" · ")}.`;
  }
  const quien = puntos.clientes?.[0]?.nombre || "El cliente";
  if (puntos.error) return "Se cobró, pero no se pudieron registrar los puntos. Avisa a un administrador.";
  if (puntos.acumulados > 0) return `${quien} ganó ${ptos(puntos.acumulados)}${puntos.saldo != null ? ` (saldo: ${puntos.saldo})` : ""}.`;
  const m = porque(puntos.motivo, quien);
  return m ? `${m[0].toUpperCase()}${m.slice(1)}.` : null;
}

// ---------- vales de fidelización (5.30) ----------

// Mismo alfabeto que el núcleo (core/src/fidelizacion/beneficios.js): sin I, L, O, 0 ni 1. El servidor valida de
// nuevo; esto solo evita pedir un código que no puede existir y acepta «k7m-2qx» como «K7M2QX».
const CODIGO_VALE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function normalizarCodigoVale(texto) {
  const t = String(texto ?? "").toUpperCase().replace(/[\s-]+/g, "");
  return CODIGO_VALE.test(t) ? t : null;
}

/** ¿Se puede aplicar un vale a este ítem? Quien edita pedidos y canjea; ítem vivo y sin otro vale. Ocultar no es seguridad. */
export function puedeAplicarVale(item, permisos) {
  return (
    permite(permisos, "documento:editar") &&
    permite(permisos, "fidelizacion:canjear") &&
    ["en_cocina", "lista", "entregado"].includes(item?.estado) &&
    !item?.descuento &&
    !item?.promociones?.length // promoción y vale no se suman (5.42)
  );
}

// ---------- promociones (5.42) ----------

/**
 * Lo que el mesero ve bajo un ítem con promoción: «Promo 2x1 en lattes: −12,00 · antes 24,00». Varias promociones se
 * separan con « · ». Null si el ítem no tiene ninguna.
 */
export function textoPromociones(item, moneda) {
  const ps = item?.promociones;
  if (!Array.isArray(ps) || !ps.length) return null;
  const partes = ps.map((p) => `Promo ${p.nombre}: −${formatoDinero(p.monto, moneda)}`);
  if (item.subtotalBase !== null && item.subtotalBase !== undefined) partes.push(`antes ${formatoDinero(item.subtotalBase, moneda)}`);
  return partes.join(" · ");
}

const MOTIVO_TOPE = {
  pedido: "llegó al máximo por pedido",
  dia: "ya no tiene usos disponibles hoy",
  cliente: "el cliente ya usó su máximo de hoy",
  sin_cliente: "solo vale para un cliente identificado: asocia un cliente al pedido",
};

/**
 * Avisos de promociones de una respuesta: si el servidor guardó el cambio pero no pudo recalcular, o si un tope de usos
 * frenó alguna promoción (5.44: «Latte gratis: ya no tiene usos disponibles hoy»). Vacío si todo salió bien.
 */
export function avisoPromociones(respuesta) {
  const partes = [];
  if (respuesta?.promocionesError) partes.push("Se guardó el cambio, pero no se pudieron recalcular las promociones. Revisa los descuentos antes de cobrar.");
  const topadas = Array.isArray(respuesta?.promocionesAviso) ? respuesta.promocionesAviso : [];
  for (const t of topadas) partes.push(`${t.nombre}: ${MOTIVO_TOPE[t.motivo] ?? "alcanzó su límite de usos"}.`);
  return partes.join(" ");
}

// ---------- platos agotados (5.60) ----------

/** Quien tiene `catalogo:disponibilidad` (cocina) puede marcar platos como agotados. */
export const puedeVerDisponibilidad = (permisos) => permite(permisos, "catalogo:disponibilidad");

/** Cuántas líneas del pedido que se está armando son de platos que cocina marcó como agotados. */
export const lineasAgotadas = (lineas) => (Array.isArray(lineas) ? lineas : []).filter((l) => !l.libre && l.agotado === true);

/**
 * Aviso tras enviar un pedido (o pedir más) con platos agotados: el servidor los lista en `agotados` (pasa también si
 * la lista del mesero se había quedado vieja). El pedido ya se creó: es solo para avisar al cliente. Vacío si no hay.
 */
export function avisoAgotados(respuesta) {
  const lista = Array.isArray(respuesta?.agotados) ? respuesta.agotados : [];
  if (!lista.length) return "";
  const nombres = lista.map((a) => a?.nombre || a?.codigo).filter(Boolean).join(", ");
  return lista.length === 1
    ? `Cocina marcó como agotado: ${nombres}. El pedido se tomó igual; confirma con cocina o avisa al cliente.`
    : `Cocina marcó como agotados: ${nombres}. El pedido se tomó igual; confirma con cocina o avisa al cliente.`;
}

/** Todos los avisos de una respuesta del servidor (promociones y agotados) en un solo texto; vacío si no hay ninguno. */
export const avisoRespuesta = (respuesta) => [avisoPromociones(respuesta), avisoAgotados(respuesta)].filter(Boolean).join(" ");

/** «Agotado hace 2 h 5 min», o solo «Agotado» si no hay hora. */
export function textoAgotado(item, ahora = Date.now()) {
  if (!item?.agotado) return "";
  const t = item.agotadoTs ? haceCuanto(item.agotadoTs, ahora) : "";
  return t ? `Agotado ${t}` : "Agotado";
}

/** «Vale K7M2QX: −6,50 (Café gratis) · antes 13,00», o null si el ítem no tiene vale. */
export function textoDescuento(item, moneda) {
  const d = item?.descuento;
  if (!d) return null;
  return `Vale ${d.vale}: −${formatoDinero(d.monto, moneda)} (${d.beneficio}) · antes ${formatoDinero(d.subtotalAntes, moneda)}`;
}

const ESTADOS_VALE = { activo: "Activo", usado: "Ya usado", cancelado: "Cancelado", vencido: "Vencido" };
export const estadoVale = (e) => ESTADOS_VALE[e] ?? e;

/** Lo que el mesero ve al revisar un vale: de quién es, qué da y si sirve todavía. */
export function resumenVale(v) {
  if (!v) return null;
  const sirve = v.estado === "activo";
  return {
    sirve,
    titulo: v.beneficio?.nombre ?? "",
    detalle: v.beneficio?.texto ?? "",
    cliente: v.cliente?.nombre || "cliente sin nombre",
    estado: estadoVale(v.estado),
    vence: v.venceTs ?? null,
  };
}
