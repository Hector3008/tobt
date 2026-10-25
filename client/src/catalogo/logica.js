// Lógica pura de la vista pública de la carta (sin React ni navegador): se prueba con node --test.

/** El slug de la empresa: último tramo de `/tobt/catalogo/<slug>`; en desarrollo, `?empresa=<slug>`. */
export function slugDesdeUbicacion(pathname, search = "") {
  const m = /\/catalogo\/([^/]+)\/?$/.exec(pathname ?? "");
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  const q = new URLSearchParams(search).get("empresa");
  return q ? q : null;
}

/** Con moneda conocida, formato de moneda; null = sin precio ("Consultar"). */
export function formatoPrecio(valor, moneda) {
  if (valor === null || valor === undefined) return "Consultar";
  const n = Number(valor);
  if (!Number.isFinite(n)) return "Consultar";
  if (!moneda) return n.toFixed(2);
  try {
    return new Intl.NumberFormat("es-PE", { style: "currency", currency: moneda }).format(n);
  } catch {
    return `${n.toFixed(2)} ${moneda}`;
  }
}

const sinTildes = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Filtra la carta por texto (nombre o código, sin distinguir mayúsculas ni tildes) y por categoría. */
export function filtrarCarta(categorias, { texto = "", categoria = null } = {}) {
  const t = sinTildes(texto.trim());
  const salida = [];
  for (const c of categorias ?? []) {
    if (categoria && c.nombre !== categoria) continue;
    const items = t ? c.items.filter((i) => sinTildes(i.nombre).includes(t) || sinTildes(i.codigo).includes(t)) : c.items;
    if (items.length) salida.push({ ...c, items });
  }
  return salida;
}

export const totalItems = (categorias) => (categorias ?? []).reduce((n, c) => n + c.items.length, 0);

/** "+45" / "−20" con su signo; los puntos son enteros. */
export function formatoPuntos(p) {
  const n = Math.trunc(Number(p) || 0);
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

export function formatoFecha(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** Ruta por hash (como el front de personal): `#/plato/<codigo>` abre el detalle; cualquier otra cosa, la carta. */
export function rutaDesdeHash(hash) {
  const m = /^#\/plato\/([^/]+)$/.exec(hash ?? "");
  if (!m) return { vista: "carta" };
  try {
    return { vista: "plato", codigo: decodeURIComponent(m[1]) };
  } catch {
    return { vista: "carta" };
  }
}

export const hashPlato = (codigo) => `#/plato/${encodeURIComponent(codigo)}`;

/** Estrellas llenas (0 a 5) para una nota; redondea al entero más cercano. */
export function estrellasLlenas(nota) {
  const n = Math.round(Number(nota));
  return Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 0;
}

/** "4,7" con coma decimal. */
export const formatoNota = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(1).replace(".", ",") : "—");

/** Texto de un movimiento de puntos para la lista (el servicio manda `detalle` solo en algunos). */
export function textoMovimiento(m) {
  if (m?.detalle) return m.detalle;
  return { acumulo: "Puntos ganados", canje: "Canje de puntos", ajuste: "Ajuste", vencimiento: "Puntos vencidos", bono: "Bono por referidos" }[m?.tipo] ?? "Movimiento";
}

/** Valida el formulario de registro antes de enviarlo (el servidor valida de verdad). Devuelve un texto o null. */
export function validarRegistro({ nombre, usuario, password, repetir, codigoReferido }) {
  const problemaNombre = validarNombreCuenta(nombre);
  if (problemaNombre) return problemaNombre;
  if (!String(usuario ?? "").trim()) return "Escribe tu correo o tu teléfono.";
  if (String(password ?? "").length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (password !== repetir) return "Las contraseñas no coinciden.";
  return validarCodigoReferido(codigoReferido);
}

/** Máximo de caracteres del nombre de la ficha (el mismo que valida el núcleo). */
export const MAX_NOMBRE = 80;

/** Revisa el nombre que el cliente quiere ponerse. Devuelve el mensaje del problema, o "" si está bien. */
export function validarNombreCuenta(nombre) {
  const t = String(nombre ?? "").trim();
  if (!t) return "Escribe tu nombre.";
  if (t.length > MAX_NOMBRE) return `El nombre admite como máximo ${MAX_NOMBRE} caracteres.`;
  return "";
}

/** Separa lo que escribió el cliente en correo o teléfono (lo que lleva @ es correo). */
export function cuerpoRegistro({ nombre, usuario, password, quierePuntos, codigoReferido }) {
  const u = String(usuario).trim();
  const codigo = normalizarCodigoReferido(codigoReferido);
  return {
    nombre: String(nombre).trim(),
    ...(u.includes("@") ? { correo: u } : { telefono: u }),
    password,
    quierePuntos: quierePuntos === true,
    ...(codigo ? { codigoReferido: codigo } : {}),
  };
}

// ---------- referidos (5.47) ----------

const CODIGO_REFERIDO = /^[A-HJ-NP-Z2-9]{7}$/; // 7 caracteres sin 0/O/1/I (igual que el núcleo)

/** Lo que escribe una persona → «K7M2QXA»: mayúsculas, sin espacios ni guiones. */
export const normalizarCodigoReferido = (t) => String(t ?? "").toUpperCase().replace(/[\s-]/g, "");

/** Vacío es válido (el código es opcional). Devuelve un texto de error o null. */
export function validarCodigoReferido(t) {
  const c = normalizarCodigoReferido(t);
  if (!c) return null;
  return CODIGO_REFERIDO.test(c) ? null : "El código de tu amigo tiene 7 letras y números (por ejemplo K7M2QXA).";
}

/** El código que trae el enlace de invitación (?ref=…), o "" si no hay uno válido. */
export function codigoDeEnlace(search) {
  const c = normalizarCodigoReferido(new URLSearchParams(search ?? "").get("ref"));
  return CODIGO_REFERIDO.test(c) ? c : "";
}

/** El enlace que se comparte: la misma carta con ?ref=CODIGO (se quita otro ref y el #). */
export function enlaceInvitacion(href, codigo) {
  const u = new URL(href);
  u.hash = "";
  u.searchParams.set("ref", normalizarCodigoReferido(codigo));
  return u.toString();
}

export const ESTADO_REFERIDO = { pendiente: "Aún no consume", premiado: "Premiado", sin_cupo: "Sin premio" };

/** «Tú ganas 50 puntos y tu amigo 25 cuando pague su primer consumo (de S/ 30 o más).» */
export function textoPremioReferidos(r, moneda) {
  const tu = r?.puntosReferente > 0;
  const amigo = r?.puntosReferido > 0;
  if (!tu && !amigo) return "";
  const quien = tu && amigo ? `Tú ganas ${r.puntosReferente} puntos y tu amigo ${r.puntosReferido}` : tu ? `Tú ganas ${r.puntosReferente} puntos` : `Tu amigo gana ${r.puntosReferido} puntos`;
  const min = r.consumoMinimo > 0 ? ` (de ${formatoPrecio(r.consumoMinimo, moneda)} o más)` : "";
  return `${quien} cuando pague su primer consumo${min}.`;
}

// ---------- beneficios y vales (5.30) ----------

/** Cuántos puntos le faltan al cliente para un beneficio (0 si ya le alcanza). */
export const faltanPuntos = (beneficio, saldo) => Math.max(0, (Number(beneficio?.puntos) || 0) - (Number(saldo) || 0));

/** «K7M2QX» → «K7M 2QX»: se lee y se dicta mejor en dos grupos. */
export const formatoCodigoVale = (codigo) => (String(codigo ?? "").length === 6 ? `${codigo.slice(0, 3)} ${codigo.slice(3)}` : String(codigo ?? ""));

/** Los vales que se pueden usar (activos, primero el que vence antes) y el resto (usados, cancelados, vencidos). */
export function agruparVales(vales) {
  const lista = Array.isArray(vales) ? vales : [];
  return {
    activos: lista.filter((v) => v.estado === "activo").sort((a, b) => new Date(a.venceTs) - new Date(b.venceTs)),
    otros: lista.filter((v) => v.estado !== "activo"),
  };
}

/** «Vence hoy», «Vence mañana», «Vence en 5 días». Los días se cuentan desde la fecha de hoy, no por horas. */
export function textoVence(venceTs, ahora = new Date()) {
  const f = new Date(venceTs);
  if (Number.isNaN(f.getTime())) return "";
  const dia = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const dias = Math.round((dia(f) - dia(ahora)) / 86_400_000);
  if (dias <= 0) return "Vence hoy";
  if (dias === 1) return "Vence mañana";
  return `Vence en ${dias} días`;
}

export const ESTADO_VALE = { usado: "Usado", cancelado: "Cancelado", vencido: "Vencido" };

// ---------- retos de colección (5.31) ----------

/** «2 de 5 cafés»: lo probado sobre el total del reto. */
export const textoAvance = (r) => `${r?.logrados ?? 0} de ${r?.total ?? 0}`;

/** Lo que falta por probar, para decirlo en una línea: «Te faltan: Moka y Cortado». */
export function textoFaltan(faltan) {
  const nombres = (Array.isArray(faltan) ? faltan : []).map((i) => i.nombre ?? i.codigo).filter(Boolean);
  if (!nombres.length) return "";
  if (nombres.length === 1) return `Te falta: ${nombres[0]}`;
  if (nombres.length <= 4) return `Te faltan: ${nombres.slice(0, -1).join(", ")} y ${nombres.at(-1)}`;
  return `Te faltan ${nombres.length}: ${nombres.slice(0, 3).join(", ")}…`;
}

/** Porcentaje (0 a 100) de avance de un reto. */
export const porcentajeReto = (r) => (r?.total > 0 ? Math.round(((r.logrados ?? 0) / r.total) * 100) : 0);

// ---------- promociones en la carta (5.43) ----------
// El servicio manda la regla (GET .../promociones) y aquí se escribe en palabras. Los nombres de los ítems ya vienen resueltos.

const DIAS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];
const mayuscula = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/** «2026-10-22» → «22 oct 2026»; algo que no es fecha se devuelve igual. */
export function textoFecha(f) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f ?? ""));
  return m ? `${Number(m[3])} ${MESES_ES[Number(m[2]) - 1]} ${m[1]}` : String(f ?? "");
}

/** [4, 5] → «jueves y viernes»; [1..5] → «de lunes a viernes»; todos o ninguno → null. Los días son 0 (domingo) a 6. */
export function textoDias(dias) {
  const orden = [1, 2, 3, 4, 5, 6, 0];
  const set = new Set(Array.isArray(dias) ? dias : []);
  const lista = orden.filter((d) => set.has(d));
  if (lista.length === 0 || lista.length === 7) return null;
  // Tramos de días seguidos (lunes a domingo): de 3 o más se dicen «de X a Y»
  const tramos = [];
  for (const d of lista) {
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && orden.indexOf(d) === orden.indexOf(ultimo[ultimo.length - 1]) + 1) ultimo.push(d);
    else tramos.push([d]);
  }
  const partes = tramos.flatMap((t) => (t.length >= 3 ? [`de ${DIAS_ES[t[0]]} a ${DIAS_ES[t[t.length - 1]]}`] : t.map((d) => DIAS_ES[d])));
  return partes.length === 1 ? partes[0] : `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

/** Cuándo rige: «Jueves y viernes, de 18:00 a 21:00 · hasta el 30 nov 2026». Sin condiciones: «Todos los días». */
export function textoCuando(p) {
  const dias = textoDias(p?.dias) ?? "todos los días";
  const horario = p?.horario?.desde && p?.horario?.hasta ? `, de ${p.horario.desde} a ${p.horario.hasta}` : "";
  const v = p?.vigencia;
  const vigencia = v?.desde && v?.hasta ? ` · del ${textoFecha(v.desde)} al ${textoFecha(v.hasta)}` : v?.hasta ? ` · hasta el ${textoFecha(v.hasta)}` : v?.desde ? ` · desde el ${textoFecha(v.desde)}` : "";
  return `${mayuscula(dias)}${horario}${vigencia}`;
}

const numero = (n) => new Intl.NumberFormat("es", { maximumFractionDigits: 2 }).format(Number(n));
const queItem = (s) => (s?.itemCodigo ? s.nombre ?? s.itemCodigo : `un producto de ${s?.categoria ?? "la carta"}`);
const enItem = (s) => (s?.itemCodigo ? s.nombre ?? s.itemCodigo : `productos de ${s?.categoria ?? "la carta"}`);
const descuento = (efecto, valor, moneda) => (efecto === "porcentaje" ? `${numero(valor)} % de descuento` : `${formatoPrecio(valor, moneda)} de descuento`);

/** La regla en una frase para el cliente. */
export function textoRegla(p, moneda) {
  if (p?.tipo === "nxm") return `${p.n}×${p.m} en ${enItem(p.objetivo)}: lleva ${p.n} y paga ${p.m}.`;
  if (p?.tipo === "directo")
    return p.efecto === "gratis" ? `${mayuscula(queItem(p.objetivo))} gratis.` : `${mayuscula(descuento(p.efecto, p.valor, moneda))} en ${enItem(p.objetivo)}.`;
  if (p?.tipo === "combo")
    return `Llevando ${queItem(p.disparador)}, ${queItem(p.objetivo)} ${p.efecto === "gratis" ? "gratis" : `con ${descuento(p.efecto, p.valor, moneda)}`}.`;
  return "";
}

/** «Vigente ahora», «Desde el 1 nov 2026» o «Hoy no rige», y su clave para el estilo. `hoy` es la fecha de la empresa. */
export function estadoPromocion(p, hoy) {
  if (p?.vigenteAhora) return { clave: "ahora", texto: "Vigente ahora" };
  if (p?.vigencia?.desde && hoy && p.vigencia.desde > hoy) return { clave: "pronto", texto: `Desde el ${textoFecha(p.vigencia.desde)}` };
  return { clave: "fuera", texto: "Hoy no rige" };
}

/** Las vigentes primero (conservan el orden del servicio dentro de cada grupo). */
export const ordenarPromociones = (lista) => [...(lista ?? [])].sort((a, b) => Number(b.vigenteAhora === true) - Number(a.vigenteAhora === true));

// ---------- eventos y publicidad en la carta (5.49) ----------
// El servicio manda los anuncios ya filtrados y ordenados (GET .../anuncios); aquí se escriben en palabras.

const diaDeSemana = (f) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(f ?? ""));
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : null;
};
const diasEntre = (desde, hasta) => {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(desde ?? ""));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(hasta ?? ""));
  return a && b ? Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86_400_000) : null;
};

/** «Hoy», «Mañana» o «Sábado 7 nov» (el año solo si no es el de hoy). `hoy` es la fecha de la empresa. */
export function textoDiaEvento(fecha, hoy) {
  const faltan = diasEntre(hoy, fecha);
  if (faltan === 0) return "Hoy";
  if (faltan === 1) return "Mañana";
  const dia = diaDeSemana(fecha);
  if (dia === null) return String(fecha ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const sinAnio = `${mayuscula(DIAS_ES[dia])} ${Number(m[3])} ${MESES_ES[Number(m[2]) - 1]}`;
  return String(hoy ?? "").slice(0, 4) === m[1] ? sinAnio : `${sinAnio} ${m[1]}`;
}

/** «Sábado 7 nov · 21:00 · Terraza». */
export function textoEvento(e, hoy) {
  return [`${textoDiaEvento(e?.fecha, hoy)} · ${e?.hora ?? ""}`.replace(/ · $/, ""), e?.lugar].filter(Boolean).join(" · ");
}

/** Hasta cuándo es válida una publicidad: «Hasta el 30 nov 2026», «Desde el 1 nov 2026» o null si siempre. */
export function textoVigenciaAnuncio(a) {
  const v = a?.vigencia;
  if (v?.desde && v?.hasta) return `Del ${textoFecha(v.desde)} al ${textoFecha(v.hasta)}`;
  if (v?.hasta) return `Hasta el ${textoFecha(v.hasta)}`;
  if (v?.desde) return `Desde el ${textoFecha(v.desde)}`;
  return null;
}

export const hayAnuncios = (datos) => (datos?.eventos?.length ?? 0) + (datos?.publicidad?.length ?? 0) > 0;

// ---------- entrar con Google (5.51) ----------

export const URL_SCRIPT_GOOGLE = "https://accounts.google.com/gsi/client";
const CLIENT_ID_GOOGLE = /^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/;

/** El Client ID de Google que anuncia GET .../cliente (solo sin sesión y si está activado), o null. Solo se acepta con la forma de un Client ID. */
export function clientIdGoogle(estado) {
  const id = estado?.google?.clientId;
  return typeof id === "string" && CLIENT_ID_GOOGLE.test(id) ? id : null;
}

/**
 * Lo que se manda a POST .../cuenta/google. El consentimiento y el código de un amigo solo se envían al «Crear cuenta»:
 * al «Entrar» no se decide nada nuevo (y el núcleo los ignora si la ficha ya existe).
 */
export function cuerpoGoogle(credencial, { crear = false, quierePuntos = false, codigoReferido = "" } = {}) {
  const cuerpo = { credencial };
  if (crear) {
    cuerpo.quierePuntos = quierePuntos === true;
    const codigo = normalizarCodigoReferido(codigoReferido);
    if (codigo) cuerpo.codigoReferido = codigo;
  }
  return cuerpo;
}
