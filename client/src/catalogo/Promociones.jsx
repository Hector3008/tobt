import { estadoPromocion, ordenarPromociones, textoCuando, textoRegla } from "./logica.js";

// Promociones vigentes de la empresa (5.43). Informativas: el descuento se aplica solo al hacer el pedido en el local.
export default function Promociones({ datos, moneda }) {
  const lista = ordenarPromociones(datos?.promociones);
  if (lista.length === 0) return null;
  return (
    <section className="cat-promos" aria-label="Promociones">
      <h2 className="rs-subtitulo">Promociones</h2>
      <ul className="rs-lista">
        {lista.map((p) => {
          const estado = estadoPromocion(p, datos.hoy);
          return (
            <li key={p.id} className={`rs-tarjeta cat-promo cat-promo--${estado.clave}`}>
              <span className="rs-tarjeta__fila">
                <strong>{p.nombre}</strong>
                <span className={`cat-promo__estado cat-promo__estado--${estado.clave}`}>{estado.texto}</span>
              </span>
              <span>{textoRegla(p, moneda)}</span>
              {p.descripcion && <small className="rs-vacio">{p.descripcion}</small>}
              <small className="rs-vacio">{textoCuando(p)}</small>
            </li>
          );
        })}
      </ul>
      <small className="rs-vacio">Los descuentos se aplican solos al pedir en el local.</small>
    </section>
  );
}
