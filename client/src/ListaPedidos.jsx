import { useCallback, useEffect, useRef, useState } from "react";
import { api, mensajeDeError } from "./api.js";
import {
  CANALES,
  ESTADOS_PEDIDO,
  ESTADOS_ITEM,
  FILTROS,
  accionesPedido,
  accionesItem,
  destinoDe,
  formatoDinero,
  permite,
  resumenItems,
} from "./pedidos.js";
import { formatoFechaHora } from "./recibos.js";

const REFRESCO_MS = 15000;

// Los pedidos: cada una agrupa los ítems (ítems) de una mesa o persona hasta que se paga toda. Cada
// ítem se mueve solo; aquí se ve en qué va cada uno y se puede entregar el que ya está listo sin entrar.
export default function ListaPedidos({ permisos, alCocina, alDisponibilidad = null, alAbrir, alCrear }) {
  const [filtro, setFiltro] = useState("abierto");
  const [pedidos, setPedidos] = useState(null);
  const [error, setError] = useState("");
  const [actualizando, setActualizando] = useState(false);
  const [moviendo, setMoviendo] = useState(() => new Set()); // códigos de ítems o pedidos en curso: cada botón bloquea solo el suyo
  const enviando = useRef(new Set());
  const filtroRef = useRef(filtro);
  filtroRef.current = filtro;

  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) setActualizando(true);
    const f = FILTROS.find((x) => x.id === filtroRef.current);
    try {
      const lista = await api.pedidos.listar(f.estado);
      if (filtroRef.current === f.id) {
        setPedidos([...lista].sort((a, b) => String(b.code).localeCompare(String(a.code))));
        if (!silencioso) setError("");
      }
    } catch (e) {
      if (!silencioso) setError(mensajeDeError(e));
    } finally {
      setActualizando(false);
    }
  }, []);

  useEffect(() => {
    setPedidos(null);
    cargar();
  }, [filtro, cargar]);

  // Consulta periódica sencilla (sin Socket.IO): solo mientras la pestaña está visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") cargar(true);
    }, REFRESCO_MS);
    return () => clearInterval(id);
  }, [cargar]);

  // Una acción rápida lleva la versión que se ve: si otra persona cambió algo antes, el servidor responde
  // 409 y la lista se recarga con lo último.
  async function ejecutar(clave, texto, fn) {
    if (enviando.current.has(clave)) return;
    enviando.current.add(clave);
    setMoviendo(new Set(enviando.current));
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(`${texto}: ${mensajeDeError(e)}`);
    } finally {
      await cargar(true);
      enviando.current.delete(clave);
      setMoviendo(new Set(enviando.current));
    }
  }
  const pasoItem = (c, i, ruta) => ejecutar(i.code, `${c.code}`, () => api.items.paso(i.code, ruta, { esperaVersion: i.version }));
  const cobrar = (c) => ejecutar(c.code, `${c.code}`, () => api.pedidos.cobrar(c.code, { esperaVersion: c.version }));

  return (
    <section aria-labelledby="t-pedidos">
      <header className="rs-cabecera">
        <h1 id="t-pedidos">Pedidos</h1>
        <div className="rs-acciones">
          <button type="button" className="rs-btn" onClick={() => cargar()} disabled={actualizando}>
            {actualizando ? "Actualizando…" : "Actualizar"}
          </button>
          {alCocina && permite(permisos, "estacion:cocina") && (
            <button type="button" className="rs-btn" onClick={alCocina}>Cocina</button>
          )}
          {alDisponibilidad && <button type="button" className="rs-btn" onClick={alDisponibilidad}>Platos agotados</button>}
          {permite(permisos, "documento:crear") && (
            <button type="button" className="rs-btn rs-btn--primario" onClick={alCrear}>Nuevo pedido</button>
          )}
        </div>
      </header>

      <div className="rs-filtros" role="tablist" aria-label="Estado">
        {FILTROS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filtro === f.id}
            className={filtro === f.id ? "rs-chip rs-chip--activo" : "rs-chip"}
            onClick={() => setFiltro(f.id)}
          >
            {f.titulo}
          </button>
        ))}
      </div>

      {error && <p className="aviso-error" role="alert">{error}</p>}

      {pedidos === null && !error ? (
        <p className="cargando">Cargando…</p>
      ) : pedidos?.length === 0 ? (
        <p className="rs-vacio">No hay pedidos {FILTROS.find((f) => f.id === filtro).titulo.toLowerCase()}.</p>
      ) : (
        <ul className="rs-lista">
          {(pedidos ?? []).map((c) => {
            const r = resumenItems(c.items);
            const acc = accionesPedido(c, permisos);
            return (
              <li key={c.code} className="rs-tarjeta-caja">
                <button type="button" className="rs-tarjeta" onClick={() => alAbrir(c.code)}>
                  <span className="rs-tarjeta__fila">
                    <strong>{destinoDe(c) || c.code}</strong>
                    <span className={`rs-estado rs-estado--${c.estado}`}>{ESTADOS_PEDIDO[c.estado] ?? c.estado}</span>
                  </span>
                  <span className="rs-tarjeta__fila">
                    <small>
                      {c.code} · {CANALES[c.canal] ?? c.canal}
                      {formatoFechaHora(c.creadoTs) && (
                        <>
                          {" · "}
                          <time dateTime={c.creadoTs}>{formatoFechaHora(c.creadoTs)}</time>
                        </>
                      )}
                    </small>
                    <span className="rs-num">{formatoDinero(c.total, c.moneda)}</span>
                  </span>
                </button>

                {c.items && c.items.length > 0 && (
                  <ul className="rs-mini">
                    {c.items.map((i) => {
                      const { pasos } = accionesItem(i.estado, permisos);
                      // En la lista solo se entrega lo que ya está listo; marcar listo es de la pantalla de cocina
                      const entregar = pasos.find((p) => p.id === "entregar");
                      return (
                        <li key={i.code} className={i.estado === "anulado" ? "rs-mini__item rs-mini__item--anulado" : "rs-mini__item"}>
                          <span>{i.cantidad} × {i.nombre}</span>
                          <span className={`rs-estado rs-estado--${i.estado}`}>{ESTADOS_ITEM[i.estado] ?? i.estado}</span>
                          {entregar && (
                            <button type="button" className="rs-btn rs-btn--primario" disabled={moviendo.has(i.code)} onClick={() => pasoItem(c, i, "entregar")}>
                              {moviendo.has(i.code) ? "…" : "Entregar"}
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {c.estado === "abierto" && r.activos > 0 && (
                  <div className="rs-tarjeta__acciones">
                    {acc.puedeCobrarAhora ? (
                      <button type="button" className="rs-btn rs-btn--primario" disabled={moviendo.has(c.code) || c.items.some((i) => moviendo.has(i.code))} onClick={() => cobrar(c)}>
                        {moviendo.has(c.code) ? "Cobrando…" : `Cobrar ${formatoDinero(c.total, c.moneda)}`}
                      </button>
                    ) : (
                      <small className="rs-vacio">{r.enCocina + r.listos > 0 ? `${r.entregados + r.listos}/${r.activos} listos o entregados` : ""}</small>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
