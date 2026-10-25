import { useState } from "react";
import { hayAnuncios, textoEvento, textoVigenciaAnuncio } from "./logica.js";

// Foto del anuncio: si no carga, la tarjeta se ve igual, sin foto (nunca un ícono roto).
function Foto({ url }) {
  const [rota, setRota] = useState(false);
  if (!url || rota) return null;
  return <img className="cat-anuncio__foto" src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setRota(true)} />;
}

// Eventos y publicidad del local (5.49): «Próximos eventos» (un concierto, con día, hora y lugar) y «Novedades» (avisos).
// Sin anuncios, no se dibuja nada.
export default function Anuncios({ datos }) {
  if (!hayAnuncios(datos)) return null;
  const { eventos = [], publicidad = [], hoy } = datos;
  return (
    <>
      {eventos.length > 0 && (
        <section className="cat-anuncios" aria-label="Próximos eventos">
          <h2 className="rs-subtitulo">Próximos eventos</h2>
          <ul className="rs-lista">
            {eventos.map((e) => (
              <li key={e.id} className="rs-tarjeta cat-anuncio cat-anuncio--evento">
                <Foto url={e.imagen} />
                <strong>{e.titulo}</strong>
                <span className="cat-anuncio__cuando">{textoEvento(e, hoy)}</span>
                {e.descripcion && <span>{e.descripcion}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {publicidad.length > 0 && (
        <section className="cat-anuncios" aria-label="Novedades">
          <h2 className="rs-subtitulo">Novedades</h2>
          <ul className="rs-lista">
            {publicidad.map((a) => (
              <li key={a.id} className="rs-tarjeta cat-anuncio cat-anuncio--publicidad">
                <Foto url={a.imagen} />
                <strong>{a.titulo}</strong>
                {a.descripcion && <span>{a.descripcion}</span>}
                {textoVigenciaAnuncio(a) && <small className="rs-vacio">{textoVigenciaAnuncio(a)}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
