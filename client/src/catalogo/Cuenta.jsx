import { useEffect, useState } from "react";
import { api } from "./api.js";
import Vales from "./Vales.jsx";
import Logros from "./Logros.jsx";
import Retos from "./Retos.jsx";
import Invitar from "./Invitar.jsx";
import BotonGoogle from "./BotonGoogle.jsx";
import { clientIdGoogle, codigoDeEnlace, cuerpoGoogle, cuerpoRegistro, formatoFecha, formatoPuntos, textoMovimiento, validarRegistro } from "./logica.js";

// Cuenta del cliente en la carta: entrar, crearla (con casilla de consentimiento para el programa de puntos),
// cambiar la contraseña temporal que dio el personal y ver sus puntos reales. `estado` es lo que responde
// GET .../cliente: { sesion: false } | { sesion: true, cliente, puntos }.
export default function Cuenta({ slug, estado, alCambiar, moneda }) {
  // Un enlace de invitación (?ref=CODIGO) abre «Crear cuenta» con el código ya puesto (5.47).
  const [refEnlace] = useState(() => codigoDeEnlace(window.location.search));
  const [modo, setModo] = useState(refEnlace ? "crear" : null); // null | "entrar" | "crear"
  const [f, setF] = useState({ nombre: "", usuario: "", password: "", repetir: "", quierePuntos: false, codigoReferido: refEnlace });
  const [cambio, setCambio] = useState({ actual: "", nueva: "", repetir: "" });
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [verMovimientos, setVerMovimientos] = useState(false);
  const campo = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  // El Client ID de Google solo llega sin sesión; se recuerda para que el botón siga ahí después de salir (5.51).
  const [googleId, setGoogleId] = useState(null);
  useEffect(() => {
    const id = clientIdGoogle(estado);
    if (id) setGoogleId(id);
  }, [estado]);

  async function ejecutar(fn) {
    if (enviando) return;
    setEnviando(true);
    setError("");
    try {
      const r = await fn();
      setF({ nombre: "", usuario: "", password: "", repetir: "", quierePuntos: false, codigoReferido: "" });
      setCambio({ actual: "", nueva: "", repetir: "" });
      setModo(null);
      return r;
    } catch (e) {
      setError(e.message);
    } finally {
      setEnviando(false);
    }
  }

  if (!estado) return null;

  // ----- con sesión -----
  if (estado.sesion) {
    const { cliente, puntos } = estado;

    // La contraseña temporal obliga a cambiarla antes de ver nada más.
    if (cliente.debeCambiarPassword)
      return (
        <section className="cat-puntos" aria-label="Cambiar contraseña">
          <p>Hola, {cliente.nombre}. Por seguridad, elige una contraseña nueva para continuar.</p>
          <form
            className="rs-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (cambio.nueva.length < 8) return setError("La contraseña nueva debe tener al menos 8 caracteres.");
              if (cambio.nueva !== cambio.repetir) return setError("Las contraseñas nuevas no coinciden.");
              ejecutar(async () => {
                await api.cambiarPassword(slug, { passwordActual: cambio.actual, passwordNueva: cambio.nueva });
                alCambiar(await api.cliente(slug));
              });
            }}
          >
            <label className="campo"><span>Contraseña temporal</span><input type="password" autoComplete="current-password" value={cambio.actual} onChange={(e) => setCambio({ ...cambio, actual: e.target.value })} /></label>
            <label className="campo"><span>Contraseña nueva</span><input type="password" autoComplete="new-password" value={cambio.nueva} onChange={(e) => setCambio({ ...cambio, nueva: e.target.value })} /></label>
            <label className="campo"><span>Repite la contraseña nueva</span><input type="password" autoComplete="new-password" value={cambio.repetir} onChange={(e) => setCambio({ ...cambio, repetir: e.target.value })} /></label>
            {error && <p className="aviso-error" role="alert">{error}</p>}
            <div className="rs-acciones">
              <button type="submit" className="rs-btn rs-btn--primario" disabled={enviando}>Guardar contraseña</button>
              <button type="button" className="rs-btn" disabled={enviando} onClick={() => ejecutar(async () => { await api.logout(slug); alCambiar({ sesion: false }); })}>Salir</button>
            </div>
          </form>
        </section>
      );

    return (
      <section className="cat-puntos" aria-label="Tus puntos">
        <div className="cat-puntos__fila">
          <div>
            <small>Hola, {cliente.nombre}</small>
            {cliente.programaPuntos && puntos?.habilitada !== false ? (
              <p className="cat-puntos__total"><strong>{puntos?.saldo ?? 0}</strong> puntos acumulados</p>
            ) : puntos?.habilitada === false ? (
              <p className="rs-vacio">El programa de puntos no está activo por ahora.</p>
            ) : (
              <p className="rs-vacio">No participas en el programa de puntos.</p>
            )}
          </div>
          <div className="rs-acciones">
            {cliente.programaPuntos && puntos?.movimientos?.length > 0 && (
              <button type="button" className="rs-btn" onClick={() => setVerMovimientos((v) => !v)} aria-expanded={verMovimientos}>
                {verMovimientos ? "Ocultar movimientos" : "Ver movimientos"}
              </button>
            )}
            <button type="button" className="rs-btn" disabled={enviando} onClick={() => ejecutar(async () => { await api.logout(slug); alCambiar({ sesion: false }); })}>Salir</button>
          </div>
        </div>
        {verMovimientos && (
          <ul className="cat-movimientos">
            {puntos.movimientos.map((m) => (
              <li key={m.id} className="rs-tarjeta__fila">
                <span>{textoMovimiento(m)} <small>{formatoFecha(m.ts)}</small></span>
                <span className={`rs-num cat-mov--${m.puntos < 0 ? "canje" : "acumulo"}`}>{formatoPuntos(m.puntos)}</span>
              </li>
            ))}
          </ul>
        )}
        {cliente.programaPuntos && puntos?.habilitada !== false && <Logros logros={puntos?.logros} />}
        {cliente.programaPuntos && puntos?.habilitada !== false && <Retos retos={puntos?.retos} />}
        {cliente.programaPuntos && puntos?.habilitada !== false && (
          <Vales slug={slug} saldo={puntos?.saldo ?? 0} alCanjear={async () => alCambiar(await api.cliente(slug))} />
        )}
        <Invitar referidos={estado.referidos} programaPuntos={cliente.programaPuntos} moneda={moneda} />
        <label className="rs-check">
          <input
            type="checkbox"
            checked={cliente.programaPuntos}
            disabled={enviando}
            onChange={(e) => ejecutar(async () => { await api.consentimiento(slug, e.target.checked); alCambiar(await api.cliente(slug)); })}
          />
          <span>Quiero acumular puntos con mis consumos</span>
        </label>
        {!cliente.programaPuntos && <small className="rs-vacio">Los puntos solo se acumulan desde que lo aceptas; no se dan por consumos anteriores.</small>}
        {error && <p className="aviso-error" role="alert">{error}</p>}
      </section>
    );
  }

  // ----- sin sesión -----
  if (!modo)
    return (
      <section className="cat-puntos" aria-label="Tu cuenta">
        <div className="cat-puntos__fila">
          <p style={{ margin: 0 }}>¿Ya eres cliente? Entra para ver tus puntos.</p>
          <div className="rs-acciones">
            <button type="button" className="rs-btn rs-btn--primario" onClick={() => { setModo("entrar"); setError(""); }}>Entrar</button>
            <button type="button" className="rs-btn" onClick={() => { setModo("crear"); setError(""); }}>Crear cuenta</button>
          </div>
        </div>
      </section>
    );

  const entrar = modo === "entrar";
  return (
    <section className="cat-puntos" aria-label={entrar ? "Entrar" : "Crear cuenta"}>
      {googleId && (
        <>
          <BotonGoogle
            clientId={googleId}
            texto={entrar ? "signin_with" : "signup_with"}
            deshabilitado={enviando}
            alCredencial={(credencial) =>
              ejecutar(async () => alCambiar(await api.google(slug, cuerpoGoogle(credencial, { crear: !entrar, quierePuntos: f.quierePuntos, codigoReferido: f.codigoReferido }))))
            }
          />
          {!entrar && <small className="rs-vacio">Si eliges Google, se usan las casillas de abajo (puntos y código de un amigo).</small>}
          <p className="cat-google__o" role="separator"><span>o con tu correo o teléfono</span></p>
        </>
      )}
      <form
        className="rs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (entrar) {
            if (!f.usuario.trim() || !f.password) return setError("Escribe tu correo o teléfono y tu contraseña.");
            return ejecutar(async () => alCambiar(await api.login(slug, { usuario: f.usuario.trim(), password: f.password })));
          }
          const problema = validarRegistro(f);
          if (problema) return setError(problema);
          ejecutar(async () => alCambiar(await api.registro(slug, cuerpoRegistro(f))));
        }}
      >
        {!entrar && <label className="campo"><span>Nombre</span><input value={f.nombre} maxLength={100} autoComplete="name" onChange={campo("nombre")} /></label>}
        <label className="campo"><span>Correo o teléfono</span><input value={f.usuario} maxLength={200} autoComplete="username" onChange={campo("usuario")} /></label>
        <label className="campo"><span>Contraseña</span><input type="password" autoComplete={entrar ? "current-password" : "new-password"} value={f.password} onChange={campo("password")} /></label>
        {!entrar && (
          <>
            <label className="campo"><span>Repite la contraseña</span><input type="password" autoComplete="new-password" value={f.repetir} onChange={campo("repetir")} /></label>
            <label className="campo">
              <span>¿Te invitó un amigo? Su código (opcional)</span>
              <input value={f.codigoReferido} maxLength={12} autoCapitalize="characters" autoComplete="off" onChange={campo("codigoReferido")} />
              <small className="rs-vacio">Si tu amigo te dio un código, anótalo: los dos ganan puntos cuando pagues tu primer consumo.</small>
            </label>
            <label className="rs-check">
              <input type="checkbox" checked={f.quierePuntos} onChange={(e) => setF((x) => ({ ...x, quierePuntos: e.target.checked }))} />
              <span>Acepto participar en el programa de puntos: guardar mis consumos para acumular puntos. Puedo retirarlo cuando quiera.</span>
            </label>
          </>
        )}
        {error && <p className="aviso-error" role="alert">{error}</p>}
        <div className="rs-acciones">
          <button type="submit" className="rs-btn rs-btn--primario" disabled={enviando}>{enviando ? "Enviando…" : entrar ? "Entrar" : "Crear cuenta"}</button>
          <button type="button" className="rs-btn" onClick={() => { setModo(null); setError(""); }}>Cancelar</button>
        </div>
      </form>
    </section>
  );
}
