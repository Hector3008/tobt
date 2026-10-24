import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import Plato from "./Plato.jsx";
import Cuenta from "./Cuenta.jsx";
import Promociones from "./Promociones.jsx";
import { aplicarPaleta, esloganDe, logoSeguro } from "./marca.js";
import { filtrarCarta, formatoPrecio, hashPlato, rutaDesdeHash, slugDesdeUbicacion, totalItems } from "./logica.js";

// Vista pública de la carta: la carta se ve sin iniciar sesión. Carta y cuenta se piden por separado: si la cuenta
// falla, la carta se sigue viendo. Los puntos que se muestran son los reales del cliente que entró.
export default function Catalogo() {
  const slug = useMemo(() => slugDesdeUbicacion(window.location.pathname, window.location.search), []);
  const [carta, setCarta] = useState(null);
  const [cliente, setCliente] = useState(null);
  const [promos, setPromos] = useState(null); // promociones vigentes (5.43); si no cargan, la carta se ve igual
  const [errorCarta, setErrorCarta] = useState(null);
  const [texto, setTexto] = useState("");
  const [categoria, setCategoria] = useState(null);
  const [ruta, setRuta] = useState(() => rutaDesdeHash(window.location.hash));
  const scrollCarta = useRef(0);

  // Ruta por hash: el botón «atrás» del navegador vuelve a la carta, que conserva búsqueda, filtro y posición.
  useEffect(() => {
    const alCambiar = () => setRuta(rutaDesdeHash(window.location.hash));
    window.addEventListener("hashchange", alCambiar);
    return () => window.removeEventListener("hashchange", alCambiar);
  }, []);
  useEffect(() => {
    if (ruta.vista === "plato") window.scrollTo(0, 0);
    else window.scrollTo(0, scrollCarta.current);
  }, [ruta]);
  const abrirPlato = (codigo) => {
    scrollCarta.current = window.scrollY;
    window.location.hash = hashPlato(codigo);
  };
  const volver = () => {
    if (window.history.length > 1) window.history.back();
    else window.location.hash = "";
  };

  useEffect(() => {
    if (!slug) {
      setErrorCarta("No encontramos esta carta. Revisa el enlace.");
      return;
    }
    let vigente = true;
    api.carta(slug).then((d) => vigente && setCarta(d), (e) => vigente && setErrorCarta(e.message));
    api.cliente(slug).then((d) => vigente && setCliente(d), () => {});
    api.promociones(slug).then((d) => vigente && setPromos(d), () => {});
    return () => {
      vigente = false;
    };
  }, [slug]);

  useEffect(() => {
    if (carta?.empresa?.nombre) document.title = `Carta · ${carta.empresa.nombre}`;
  }, [carta]);

  // La marca de la empresa (5.33): colores en todo el documento mientras se ve la carta; si no hay, la apariencia por defecto
  const marca = carta?.empresa?.marca ?? null;
  useEffect(() => aplicarPaleta(marca, document.documentElement), [marca]);
  const [logoRoto, setLogoRoto] = useState(false);
  const logo = logoRoto ? null : logoSeguro(marca);

  const visibles = useMemo(() => filtrarCarta(carta?.categorias, { texto, categoria }), [carta, texto, categoria]);

  if (errorCarta)
    return (
      <main className="rs-centrado">
        <div className="rs-aviso-pantalla">
          <p className="aviso-error" role="alert">{errorCarta}</p>
        </div>
      </main>
    );
  if (!carta)
    return (
      <main className="rs-centrado">
        <p className="cargando">Cargando la carta…</p>
      </main>
    );

  const { empresa, categorias } = carta;
  if (ruta.vista === "plato") return <Plato slug={slug} codigo={ruta.codigo} onVolver={volver} />;
  return (
    <main className="rs cat">
      <header className="cat-cabecera">
        {logo && <img className="cat-logo" src={logo} alt={`Logo de ${empresa.nombre}`} referrerPolicy="no-referrer" onError={() => setLogoRoto(true)} />}
        <h1>{empresa.nombre}</h1>
        <p className="rs-empresa">{esloganDe(marca) ?? "Nuestra carta"}</p>
      </header>

      <Cuenta slug={slug} estado={cliente} alCambiar={setCliente} moneda={empresa.moneda} />

      <Promociones datos={promos} moneda={empresa.moneda} />

      {totalItems(categorias) === 0 ? (
        <p className="rs-vacio">Esta carta todavía no tiene platos.</p>
      ) : (
        <>
          <label className="campo cat-buscar">
            <span>Buscar en la carta</span>
            <input type="search" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Nombre o código" />
          </label>

          {categorias.length > 1 && (
            <div className="rs-filtros" role="group" aria-label="Categorías">
              <button type="button" className={`rs-chip${categoria === null ? " rs-chip--activo" : ""}`} onClick={() => setCategoria(null)}>
                Todo
              </button>
              {categorias.map((c) => (
                <button
                  key={c.nombre}
                  type="button"
                  className={`rs-chip${categoria === c.nombre ? " rs-chip--activo" : ""}`}
                  onClick={() => setCategoria(categoria === c.nombre ? null : c.nombre)}
                >
                  {c.nombre}
                </button>
              ))}
            </div>
          )}

          {visibles.length === 0 ? (
            <p className="rs-vacio">Ningún plato coincide con tu búsqueda.</p>
          ) : (
            visibles.map((c) => (
              <section key={c.nombre} aria-label={c.nombre}>
                <h2 className="rs-subtitulo">{c.nombre}</h2>
                <ul className="rs-lista">
                  {c.items.map((i) => (
                    <li key={i.codigo}>
                      <button type="button" className="rs-tarjeta cat-plato" onClick={() => abrirPlato(i.codigo)}>
                        <span className="rs-tarjeta__fila">
                          <span>{i.nombre}</span>
                          <span className="rs-num">{formatoPrecio(i.precio, empresa.moneda)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </main>
  );
}
