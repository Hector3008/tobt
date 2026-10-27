import { useEffect, useState } from "react";
import { api } from "./api.js";
import { estrellasLlenas, formatoFecha, formatoNota, formatoPrecio } from "./logica.js";

function Estrellas({ n }) {
  const llenas = estrellasLlenas(n);
  return (
    <span className="est-par" role="img" aria-label={`${llenas} de 5 estrellas`}>
      <span className="est">{"★".repeat(llenas)}</span>
      <span className="est-off">{"★".repeat(5 - llenas)}</span>
    </span>
  );
}

// Tarjeta de detalle de un plato: foto opcional, descripción y reseñas (solo texto y estrellas).
export default function Plato({ slug, codigo, onVolver }) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [fotoRota, setFotoRota] = useState(false);

  useEffect(() => {
    let vigente = true;
    setDatos(null);
    setError(null);
    setFotoRota(false);
    api.plato(slug, codigo).then((d) => vigente && setDatos(d), (e) => vigente && setError(e.message));
    return () => {
      vigente = false;
    };
  }, [slug, codigo]);

  useEffect(() => {
    if (datos?.plato?.nombre) document.title = `${datos.plato.nombre} · ${datos.empresa.nombre}`;
  }, [datos]);

  const volver = (
    <button type="button" className="enlace-volver" onClick={onVolver}>
      ← Volver a la carta
    </button>
  );

  if (error)
    return (
      <main className="rs cat">
        {volver}
        <p className="aviso-error" role="alert">{error}</p>
      </main>
    );
  if (!datos)
    return (
      <main className="rs cat">
        {volver}
        <p className="cargando">Cargando el plato…</p>
      </main>
    );

  const { empresa, plato, resenas } = datos;
  return (
    <main className="rs cat det">
      <div className="det-top">
        {volver}
        <small>{empresa.nombre}</small>
      </div>

      {plato.imagen && !fotoRota && (
        <img className="det-foto" src={plato.imagen} alt={plato.nombre} loading="lazy" referrerPolicy="no-referrer" onError={() => setFotoRota(true)} />
      )}

      <div className="det-cuerpo">
        {plato.categoria && (
          <div className="det-chips">
            <span className="det-chip">{plato.categoria}</span>
          </div>
        )}
        <div className="det-fila">
          <h1>{plato.nombre}</h1>
          <span className="det-precio">{formatoPrecio(plato.precio, empresa.moneda)}</span>
        </div>
        {plato.agotado === true && <p><span className="rs-etiqueta-agotado" style={{ marginLeft: 0 }}>Agotado por hoy</span></p>}
        {plato.descripcion && <p className="det-desc">{plato.descripcion}</p>}
      </div>

      {resenas?.total > 0 && (
        <section className="det-resenas" aria-label="Reseñas">
          <h2 className="rs-subtitulo">Reseñas</h2>
          <div className="det-resumen">
            <span className="det-nota">{formatoNota(resenas.promedio)}</span>
            <div>
              <Estrellas n={resenas.promedio} />
              <small>{resenas.total} {resenas.total === 1 ? "reseña" : "reseñas"}</small>
            </div>
          </div>
          {resenas.resenas.map((r, i) => (
            <article key={i} className="res">
              <div className="res-cab">
                <strong>{r.autor}</strong>
                <small>{formatoFecha(r.ts)}</small>
              </div>
              <Estrellas n={r.estrellas} />
              <p>{r.texto}</p>
            </article>
          ))}
          {resenas.demo && <small className="cat-demo">Reseñas de ejemplo: aún no son opiniones reales.</small>}
        </section>
      )}
    </main>
  );
}
