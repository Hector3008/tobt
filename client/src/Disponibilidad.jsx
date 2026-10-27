import { useCallback, useEffect, useRef, useState } from "react";
import { api, mensajeDeError } from "./api.js";
import { textoAgotado } from "./pedidos.js";

const REFRESCO_MS = 30000;

// Platos agotados (5.60): cocina marca lo que no hay hoy y lo quita cuando vuelve. Es un aviso: el mesero ve la
// advertencia al cargar el pedido y la carta pública muestra la etiqueta «Agotado», pero el plato se puede pedir igual.
// Queda agotado hasta que cocina lo quite (no se reinicia solo). Cada botón bloquea solo el suyo.
export default function Disponibilidad({ alVolver, alCocina = null }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState("");
  const [soloAgotados, setSoloAgotados] = useState(false);
  const [error, setError] = useState("");
  const [moviendo, setMoviendo] = useState(() => new Set());
  const [ahora, setAhora] = useState(Date.now());
  const viva = useRef(true);
  const enviando = useRef(new Set());
  const ultima = useRef(0); // una respuesta vieja nunca pisa a una más nueva

  const cargar = useCallback(async (silencioso = false) => {
    const n = ++ultima.current;
    try {
      const lista = await api.disponibilidad.listar({ q, soloAgotados });
      if (viva.current && n === ultima.current) {
        setItems(lista);
        setAhora(Date.now());
        if (!silencioso) setError("");
      }
    } catch (e) {
      if (viva.current && n === ultima.current && !silencioso)
        setError(e.status === 403 ? "Tu rol no puede ver ni marcar la disponibilidad de los platos." : mensajeDeError(e));
    }
  }, [q, soloAgotados]);

  // Al escribir se espera un instante antes de buscar; el refresco periódico se salta si la pestaña está oculta.
  useEffect(() => {
    viva.current = true;
    const t = setTimeout(() => cargar(), q ? 250 : 0);
    const id = setInterval(() => {
      if (document.visibilityState === "visible") cargar(true);
    }, REFRESCO_MS);
    return () => {
      viva.current = false;
      clearTimeout(t);
      clearInterval(id);
    };
  }, [cargar, q]);

  async function marcar(it, agotado) {
    if (enviando.current.has(it.id)) return;
    enviando.current.add(it.id);
    setMoviendo(new Set(enviando.current));
    setError("");
    try {
      const r = await api.disponibilidad.marcar(it.id, agotado);
      // Se actualiza en su sitio (sin reordenar bajo el dedo); el orden con los agotados primero llega en la próxima recarga.
      if (viva.current) setItems((l) => (l ?? []).map((x) => (x.id === it.id ? { ...x, agotado: r.agotado === true, agotadoTs: r.agotadoTs ?? null } : x)));
    } catch (e) {
      setError(`${it.nombre}: ${mensajeDeError(e)}`);
      await cargar(true);
    } finally {
      enviando.current.delete(it.id);
      if (viva.current) setMoviendo(new Set(enviando.current));
    }
  }

  const agotados = (items ?? []).filter((i) => i.agotado).length;

  return (
    <section aria-labelledby="t-disp">
      <header className="rs-cabecera">
        <h1 id="t-disp">Platos agotados</h1>
        <div className="rs-acciones">
          <button type="button" className="rs-btn" onClick={() => cargar()}>Actualizar</button>
          {alCocina && <button type="button" className="rs-btn" onClick={alCocina}>Cocina</button>}
          <button type="button" className="rs-btn" onClick={alVolver}>Ver pedidos</button>
        </div>
      </header>

      <p className="rs-vacio">
        Marca lo que hoy no hay. Los meseros verán una advertencia al cargar el pedido y la carta mostrará «Agotado». Queda así hasta que lo quites.
      </p>

      <div className="rs-disp-filtros">
        <input
          type="search"
          placeholder="Buscar por código o nombre"
          aria-label="Buscar plato"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
        />
        <label className="rs-disp-solo">
          <input type="checkbox" checked={soloAgotados} onChange={(e) => setSoloAgotados(e.target.checked)} />
          <span>Solo agotados</span>
        </label>
      </div>

      {error && <p className="aviso-error" role="alert">{error}</p>}

      {items === null && !error ? (
        <p className="cargando">Cargando…</p>
      ) : items && items.length === 0 ? (
        <p className="rs-vacio">
          {soloAgotados && !q.trim() ? "No hay ningún plato marcado como agotado." : "Ningún plato coincide."}
        </p>
      ) : (
        items && (
          <>
            <p className="rs-vacio" role="status">
              {agotados === 0 ? "Nada agotado en esta lista." : `${agotados} ${agotados === 1 ? "plato agotado" : "platos agotados"} en esta lista.`}
              {items.length >= 200 && " Se muestran los primeros 200: usa el buscador para encontrar otros."}
            </p>
            <ul className="rs-disp">
              {items.map((it) => (
                <li key={it.id} className={`rs-disp__item${it.agotado ? " rs-disp__item--agotado" : ""}`}>
                  <span className="rs-disp__nombre">
                    <strong>{it.nombre}</strong>
                    <small>{it.codigo}{it.categoria ? ` · ${it.categoria}` : ""}</small>
                    {it.agotado && <small className="rs-etiqueta-agotado">{textoAgotado(it, ahora)}</small>}
                  </span>
                  <button
                    type="button"
                    className={`rs-btn${it.agotado ? "" : " rs-btn--peligro"}`}
                    disabled={moviendo.has(it.id)}
                    aria-label={it.agotado ? `Ya hay ${it.nombre}` : `Marcar ${it.nombre} como agotado`}
                    onClick={() => marcar(it, !it.agotado)}
                  >
                    {moviendo.has(it.id) ? "Guardando…" : it.agotado ? "Ya hay" : "Marcar agotado"}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </section>
  );
}
