import { useCallback, useEffect, useRef, useState } from "react";
import { api, mensajeDeError } from "./api.js";
import { haceCuanto, itemsDeCocina } from "./pedidos.js";

const REFRESCO_MS = 10000;

// Cocina: una tarjeta por ítem (por ítem), no por pedido. Así se saca primero lo que va antes (el café)
// y se lleva sin esperar al resto (el sándwich). "Listo" lleva la versión que se ve: si el ítem cambió
// (por ejemplo, lo anularon), el servidor responde 409 y se recarga.
export default function Cocina({ puedeMarcar, alVolver, alDisponibilidad = null }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");
  const [moviendo, setMoviendo] = useState(() => new Set()); // ítems que se están marcando: cada botón bloquea solo el suyo
  const [ahora, setAhora] = useState(Date.now());
  const viva = useRef(true);

  const cargar = useCallback(async (silencioso = false) => {
    try {
      const lista = await api.items.listar("en_cocina");
      if (viva.current) {
        setItems(lista);
        setAhora(Date.now());
        if (!silencioso) setError("");
      }
    } catch (e) {
      if (viva.current && !silencioso) setError(mensajeDeError(e));
    }
  }, []);

  useEffect(() => {
    viva.current = true;
    cargar();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") cargar(true);
    }, REFRESCO_MS);
    return () => {
      viva.current = false;
      clearInterval(id);
    };
  }, [cargar]);

  const enviando = useRef(new Set());
  async function listo(p) {
    if (enviando.current.has(p.code)) return;
    enviando.current.add(p.code);
    setMoviendo(new Set(enviando.current));
    setError("");
    try {
      await api.items.paso(p.code, "lista", { esperaVersion: p.version });
    } catch (e) {
      setError(`${p.code}: ${mensajeDeError(e)}`);
    } finally {
      await cargar(true);
      enviando.current.delete(p.code);
      if (viva.current) setMoviendo(new Set(enviando.current));
    }
  }

  const lista = itemsDeCocina(items);

  return (
    <section aria-labelledby="t-cocina">
      <header className="rs-cabecera">
        <h1 id="t-cocina">Cocina</h1>
        <div className="rs-acciones">
          <button type="button" className="rs-btn" onClick={() => cargar()}>Actualizar</button>
          {alDisponibilidad && <button type="button" className="rs-btn" onClick={alDisponibilidad}>Platos agotados</button>}
          <button type="button" className="rs-btn" onClick={alVolver}>Ver pedidos</button>
        </div>
      </header>

      {error && <p className="aviso-error" role="alert">{error}</p>}
      {!puedeMarcar && <p className="rs-vacio">Tu rol puede ver la cocina pero no marcar ítems como listos.</p>}

      {items === null && !error ? (
        <p className="cargando">Cargando…</p>
      ) : lista.length === 0 ? (
        <p className="rs-vacio">No hay nada pendiente en cocina.</p>
      ) : (
        <ul className="rs-cocina">
          {lista.map((p) => (
            <li key={p.code} className="rs-item-cocina">
              <div className="rs-tarjeta__fila">
                <strong>{p.cantidad} × {p.nombre}</strong>
                <small>{p.code}</small>
              </div>
              <div className="rs-tarjeta__fila">
                <span>{p.destino}</span>
                <small>{haceCuanto(p.creadoTs, ahora)}</small>
              </div>
              {p.notas && <small className="rs-nota-cocina">{p.notas}</small>}
              {puedeMarcar && (
                <button type="button" className="rs-btn rs-btn--primario" disabled={moviendo.has(p.code)} onClick={() => listo(p)}>
                  {moviendo.has(p.code) ? "Marcando…" : "Listo"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
