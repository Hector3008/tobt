import { useEffect, useState } from "react";
import { api } from "./api.js";
import { formatoPrecio } from "./logica.js";
import Resenas from "./Resenas.jsx";

// Tarjeta de detalle de un plato: foto opcional, descripción y reseñas reales (solo texto y estrellas, 5.62).
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

      <Resenas slug={slug} codigo={plato.codigo} inicial={resenas} />
    </main>
  );
}
