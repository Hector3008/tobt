import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { cuerpoResena, estrellasLlenas, formatoFecha, formatoNota, MAX_TEXTO_RESENA, modoResenar, textoRestante, validarResenaForm } from "./logica.js";

export function Estrellas({ n }) {
  const llenas = estrellasLlenas(n);
  return (
    <span className="est-par" role="img" aria-label={`${llenas} de 5 estrellas`}>
      <span className="est">{"★".repeat(llenas)}</span>
      <span className="est-off">{"★".repeat(5 - llenas)}</span>
    </span>
  );
}

// Reseñas de un plato (5.62): las de todos (de la caché pública) y, si el cliente tiene sesión, su propia reseña y el
// formulario cuando ya pagó el plato. Solo estrellas y texto. El servidor decide quién puede opinar; aquí solo se explica.
export default function Resenas({ slug, codigo, inicial }) {
  const [lista, setLista] = useState(inicial ?? { total: 0, promedio: null, resenas: [] });
  const [estado, setEstado] = useState(null); // null | { sesion:false } | { puedeResenar, mia, ... }
  const [estrellas, setEstrellas] = useState(0);
  const [texto, setTexto] = useState("");
  const [editando, setEditando] = useState(false);
  const [enCurso, setEnCurso] = useState(false);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [reportadas, setReportadas] = useState(() => new Set());

  const aplicar = useCallback((r) => {
    setEstado(r);
    setLista({ total: r.total, promedio: r.promedio, resenas: r.resenas });
  }, []);

  // Con sesión se pide la lista fresca (la pública puede tener hasta 30 s de caché). Sin sesión se queda la pública.
  const cargar = useCallback(async () => {
    try {
      const yo = await api.cliente(slug);
      if (!yo?.sesion) return setEstado({ sesion: false });
      aplicar(await api.resenas(slug, codigo));
    } catch {
      setEstado({ sesion: false }); // si falla, se ve la lista pública y nada más
    }
  }, [slug, codigo, aplicar]);

  useEffect(() => {
    setLista(inicial ?? { total: 0, promedio: null, resenas: [] });
    setEstado(null);
    setEditando(false);
    cargar();
  }, [cargar, inicial]);

  const modo = modoResenar(estado);
  const mia = estado?.mia ?? null;

  function empezarEdicion() {
    setEstrellas(mia?.estrellas ?? 0);
    setTexto(mia?.texto ?? "");
    setError("");
    setAviso("");
    setEditando(true);
  }

  async function guardar(e) {
    e.preventDefault();
    if (enCurso) return;
    const datos = { estrellas, texto };
    const malo = validarResenaForm(datos);
    if (malo) return setError(malo);
    setEnCurso(true);
    setError("");
    try {
      await api.guardarResena(slug, codigo, cuerpoResena(datos));
      aplicar(await api.resenas(slug, codigo));
      setEditando(false);
      setAviso("Gracias por tu opinión.");
    } catch (err) {
      setError(err.message);
    } finally {
      setEnCurso(false);
    }
  }

  async function borrar() {
    if (enCurso || !window.confirm("¿Borrar tu reseña?")) return;
    setEnCurso(true);
    setError("");
    try {
      await api.borrarResena(slug, codigo);
      aplicar(await api.resenas(slug, codigo));
      setEditando(false);
      setAviso("Tu reseña se borró.");
    } catch (err) {
      setError(err.message);
    } finally {
      setEnCurso(false);
    }
  }

  async function reportar(id) {
    if (reportadas.has(id)) return;
    setError("");
    try {
      await api.reportarResena(slug, id);
      setReportadas((s) => new Set(s).add(id));
    } catch (err) {
      setError(err.message);
    }
  }

  const formulario = (
    <form className="res-form" onSubmit={guardar}>
      <fieldset className="res-estrellas">
        <legend>Tu nota</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={`res-estrella${n <= estrellas ? " res-estrella--on" : ""}`} aria-pressed={n === estrellas} aria-label={`${n} ${n === 1 ? "estrella" : "estrellas"}`} onClick={() => setEstrellas(n)}>
            ★
          </button>
        ))}
      </fieldset>
      <label className="res-texto">
        <span>Tu comentario (opcional)</span>
        <textarea rows={3} value={texto} maxLength={MAX_TEXTO_RESENA + 50} onChange={(e) => setTexto(e.target.value)} />
        <small>{textoRestante(texto)}</small>
      </label>
      <p className="res-nota">Se publicará con tu nombre y la inicial de tu apellido.</p>
      <div className="res-acciones">
        <button type="submit" className="rs-btn rs-btn--primario" disabled={enCurso}>{enCurso ? "Guardando…" : mia ? "Guardar cambios" : "Publicar reseña"}</button>
        {mia && <button type="button" className="rs-btn" onClick={() => setEditando(false)} disabled={enCurso}>Cancelar</button>}
      </div>
    </form>
  );

  return (
    <section className="det-resenas" aria-label="Reseñas">
      <h2 className="rs-subtitulo">Reseñas</h2>

      {lista.total > 0 ? (
        <div className="det-resumen">
          <span className="det-nota">{formatoNota(lista.promedio)}</span>
          <div>
            <Estrellas n={lista.promedio} />
            <small>{lista.total} {lista.total === 1 ? "reseña" : "reseñas"}</small>
          </div>
        </div>
      ) : (
        <p className="rs-vacio">Aún no hay reseñas de este plato.</p>
      )}

      {error && <p className="aviso-error" role="alert">{error}</p>}
      {aviso && !editando && <p className="res-aviso" role="status">{aviso}</p>}

      {modo === "entrar" && <p className="res-nota">Entra a tu cuenta (arriba, en la carta) para dejar tu opinión de un plato que ya pediste.</p>}
      {modo === "pagar" && <p className="res-nota">Podrás dejar tu reseña cuando hayas pedido y pagado este plato.</p>}
      {modo === "escribir" && !editando && (
        <button type="button" className="rs-btn rs-btn--primario" onClick={empezarEdicion}>Escribir una reseña</button>
      )}
      {editando && formulario}
      {mia && !editando && (
        <div className="res res-propia">
          <div className="res-cab">
            <strong>Tu reseña</strong>
            <small>{mia.oculta ? "Oculta por el equipo del local" : "Publicada"}</small>
          </div>
          <Estrellas n={mia.estrellas} />
          {mia.texto && <p>{mia.texto}</p>}
          <div className="res-acciones">
            {!mia.oculta && <button type="button" className="rs-btn" onClick={empezarEdicion}>Editar</button>}
            <button type="button" className="rs-btn rs-btn--peligro" onClick={borrar} disabled={enCurso}>Borrar</button>
          </div>
        </div>
      )}

      {lista.resenas.map((r) => (
        <article key={r.id} className="res">
          <div className="res-cab">
            <strong>{r.mia ? `${r.autor} (tú)` : r.autor}</strong>
            <small>{formatoFecha(r.ts)}</small>
          </div>
          <Estrellas n={r.estrellas} />
          {r.texto && <p>{r.texto}</p>}
          {estado?.sesion !== false && estado && !r.mia && (
            <button type="button" className="res-reportar" onClick={() => reportar(r.id)} disabled={reportadas.has(r.id)}>
              {reportadas.has(r.id) ? "Reportada, gracias" : "Reportar"}
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
