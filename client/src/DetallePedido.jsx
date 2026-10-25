import { useCallback, useEffect, useRef, useState } from "react";
import { api, mensajeDeError } from "./api.js";
import SelectorCliente from "./SelectorCliente.jsx";
import Recibo from "./Recibo.jsx";
import { METODOS_PAGO, PAGO_INICIAL, avisoRecibo, cuerpoPago, formatoFechaHora, validarPagoForm } from "./recibos.js";
import {
  CANALES,
  ESTADOS_PEDIDO,
  ESTADOS_ITEM,
  MOTIVOS_ANULACION,
  accionesPedido,
  accionesItem,
  gruposPorCliente,
  resumenItems,
  cuerpoDatos,
  formularioDesdePedido,
  validarFormulario,
  cuerpoPrecio,
  destinoDe,
  formatoDinero,
  permite,
  textoPuntos,
  textoPromociones,
  avisoPromociones,
  normalizarCodigoVale,
  puedeAplicarVale,
  textoDescuento,
  resumenVale,
} from "./pedidos.js";

// Aplicar un vale a un ítem: el mesero escribe el código que le muestra el cliente, lo revisa (de quién es, qué da,
// si sirve) y recién entonces lo aplica. Revisar no gasta el vale.
function FormularioVale({ estado, moneda, ocupado, alCambiar, alRevisar, alAplicar, alCerrar }) {
  const r = resumenVale(estado.vale);
  return (
    <form
      className="rs-vale"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (r?.sirve && estado.codigo === normalizarCodigoVale(estado.texto)) alAplicar();
        else alRevisar();
      }}
    >
      <label>
        <span>Código del vale</span>
        <input
          autoFocus
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={10}
          value={estado.texto}
          onChange={(ev) => alCambiar({ texto: ev.target.value.toUpperCase(), vale: null, aviso: "" })}
        />
      </label>
      {r && (
        <p className={r.sirve ? "rs-vale__ok" : "rs-vale__no"} role="status">
          <strong>{r.titulo}</strong> · {r.detalle} · de {r.cliente} · {r.estado}
        </p>
      )}
      {estado.aviso && <small className="rs-precio__aviso" role="alert">{estado.aviso}</small>}
      <div className="rs-acciones">
        {r?.sirve ? (
          <button type="submit" className="rs-btn rs-btn--primario" disabled={ocupado}>{ocupado ? "Aplicando…" : "Aplicar a este ítem"}</button>
        ) : (
          <button type="submit" className="rs-btn rs-btn--primario" disabled={ocupado || !estado.texto.trim()}>Revisar vale</button>
        )}
        <button type="button" className="rs-btn" onClick={alCerrar}>Cancelar</button>
      </div>
    </form>
  );
}

// Los recibos de pago que ya emitió el pedido (uno por cobro). Se recarga cuando el pedido cambia (`clave`).
function ListaRecibos({ code, clave, moneda, alVer }) {
  const [lista, setLista] = useState([]);
  useEffect(() => {
    let vigente = true;
    api.pedidos.recibos(code).then((l) => vigente && setLista(l)).catch(() => vigente && setLista([]));
    return () => {
      vigente = false;
    };
  }, [code, clave]);
  if (!lista.length) return null;
  return (
    <>
      <h2 className="rs-subtitulo">Recibos de pago</h2>
      <ul className="rs-recibos">
        {lista.map((r) => (
          <li key={r.code}>
            <span><strong>{r.code}</strong> · {r.metodoTexto ?? "forma de pago sin indicar"} · {formatoDinero(r.total, moneda)}</span>
            <button type="button" className="rs-btn" onClick={() => alVer({ codigo: r.code })}>Ver recibo</button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Fila({ etiqueta, children }) {
  return (
    <>
      <dt>{etiqueta}</dt>
      <dd>{children}</dd>
    </>
  );
}

// Un pedido con todos sus ítems. Cada ítem se mueve solo (listo en cocina, entregado por el mesero);
// el pedido se cobra de una vez cuando todo está entregado. Las acciones llevan la versión que se ve: si
// otra persona cambió algo, el servidor responde 409 y se recarga con lo último.
export default function DetallePedido({ code, permisos, alVolver, alPedirMas, avisoInicial = "" }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState("");
  const [avisoPromo, setAvisoPromo] = useState(avisoInicial); // el cambio se guardó pero no se recalcularon las promociones (5.42)
  // Qué se está enviando ahora: cada botón bloquea solo lo suyo y las demás acciones siguen disponibles,
  // así se pueden lanzar varias a la vez. Claves: el código del ítem, o "pedido" para lo que toca al pedido entero.
  const [enCurso, setEnCurso] = useState(() => new Set());
  const enCursoRef = useRef(new Set());
  const ultima = useRef(0); // una respuesta vieja nunca pisa a una más nueva
  const [anulando, setAnulando] = useState(null); // { tipo: "pedido" } | { tipo: "ítem", ítem }
  const [editandoPrecio, setEditandoPrecio] = useState(null); // { code, texto }
  const [motivo, setMotivo] = useState("");
  const [detalleMotivo, setDetalleMotivo] = useState("");
  const [editando, setEditando] = useState(null); // formulario de los datos del pedido (mesa, a nombre de, entrega, notas)
  const [avisoPuntos, setAvisoPuntos] = useState(""); // lo que ganó el cliente al cobrar (sobrevive a la recarga)
  const [claveSinAnotar, setClaveSinAnotar] = useState(false);
  const [clienteItem, setClienteItem] = useState(null); // código del ítem al que se le está eligiendo cliente
  const [valeItem, setValeItem] = useState(null); // { code, texto, vale, aviso }: el ítem al que se le está aplicando un vale
  const [pago, setPago] = useState({ ...PAGO_INICIAL }); // forma de pago que se anota en el próximo cobro (5.32)
  const [avisoRec, setAvisoRec] = useState(null); // { code } | { error: true }: el recibo del último cobro
  const [verRecibo, setVerRecibo] = useState(null); // { codigo } | { cuenta: true }

  // `conservarError`: tras un conflicto se recarga pero el aviso tiene que seguir a la vista.
  const cargar = useCallback(async (conservarError = false) => {
    try {
      const n = ++ultima.current;
      const d = await api.pedidos.obtener(code);
      if (n === ultima.current) setC(d);
      if (!conservarError) setError("");
    } catch (e) {
      setError(e.status === 404 ? "No se encontró este pedido." : mensajeDeError(e));
    }
  }, [code]);

  useEffect(() => {
    setC(null);
    cargar();
  }, [cargar]);

  const marcar = (claves, activo) => {
    for (const k of claves) activo ? enCursoRef.current.add(k) : enCursoRef.current.delete(k);
    setEnCurso(new Set(enCursoRef.current));
  };
  // Un ítem está ocupado si se está enviando algo suyo o algo del pedido entero; lo del pedido entero
  // espera a que no haya nada más en curso.
  const ocupado = (k) => enCurso.has(k) || enCurso.has("pedido");
  const ocupadoPedido = enCurso.size > 0;

  // `claves`: qué se bloquea mientras dura. `alTerminar`: lo que se limpia al salir bien (solo el formulario de esta acción).
  async function ejecutar(claves, fn, alTerminar) {
    const ks = [].concat(claves);
    const ref = enCursoRef.current;
    if (ks.some((k) => ref.has(k)) || ref.has("pedido") || (ks.includes("pedido") && ref.size > 0)) return;
    marcar(ks, true);
    setError("");
    try {
      const r = await fn();
      alTerminar?.();
      await cargar();
      setAvisoPromo(avisoPromociones(r));
    } catch (e) {
      setError(mensajeDeError(e));
      if (["CONFLICTO_VERSION", "TRANSICION_INVALIDA", "ESTADO_INVALIDO"].includes(e.codigo)) await cargar(true);
    } finally {
      marcar(ks, false);
    }
  }

  if (!c)
    return (
      <section>
        <button type="button" className="enlace-volver" onClick={alVolver}>← Pedidos</button>
        {error ? <p className="aviso-error" role="alert">{error}</p> : <p className="cargando">Cargando…</p>}
      </section>
    );

  const doc = c.doc ?? {};
  const acc = accionesPedido(c, permisos);
  const res = resumenItems(c.items);
  const grupos = acc.dividir ? gruposPorCliente(c) : [];
  // La forma de pago se valida antes de enviar; tras cobrar se limpian la propina y el efectivo (la forma de pago se queda).
  const conPago = () => {
    const problema = validarPagoForm(pago);
    if (problema) {
      setError(problema);
      return null;
    }
    const p = cuerpoPago(pago);
    return p ? { pago: p } : {};
  };
  const despuesDeCobrar = (r) => {
    setAvisoPuntos(textoPuntos(r.puntos) ?? "");
    setAvisoRec(avisoRecibo(r));
    setPago((x) => ({ ...x, propina: "", recibido: "" }));
  };
  const cobrarItems = (codigos) => {
    const extra = conPago();
    if (!extra) return;
    return ejecutar(codigos, async () => despuesDeCobrar(await api.pedidos.cobrarItems(c.code, { items: codigos, ...extra })));
  };
  const moneda = c.moneda;
  const cuerpoMotivo = { codigo: motivo, ...(detalleMotivo.trim() ? { detalle: detalleMotivo.trim() } : {}) };

  return (
    <section aria-labelledby="t-pedido">
      <button type="button" className="enlace-volver" onClick={alVolver}>← Pedidos</button>
      <header className="rs-cabecera">
        <h1 id="t-pedido">
          {destinoDe(c) || c.code} <span className={`rs-estado rs-estado--${c.estado}`}>{ESTADOS_PEDIDO[c.estado] ?? c.estado}</span>
        </h1>
      </header>

      {error && <p className="aviso-error" role="alert">{error}</p>}
      {avisoPromo && <p className="aviso-error" role="status">{avisoPromo}</p>}

      <dl className="rs-datos">
        <Fila etiqueta="Pedido">{c.code}</Fila>
        {formatoFechaHora(c.creadoTs) && <Fila etiqueta="Fecha">{formatoFechaHora(c.creadoTs)}</Fila>}
        <Fila etiqueta="Canal">{CANALES[doc.canal] ?? doc.canal}</Fila>
        {doc.entrega && (
          <>
            <Fila etiqueta="Dirección">{doc.entrega.direccion}</Fila>
            <Fila etiqueta="Teléfono">{doc.entrega.telefono}</Fila>
            {doc.entrega.referencia && <Fila etiqueta="Referencia">{doc.entrega.referencia}</Fila>}
          </>
        )}
        {c.estado !== "abierto" && c.snapshot?.cliente?.nombre && <Fila etiqueta="Cliente">{c.snapshot.cliente.nombre}</Fila>}
        {doc.notas && <Fila etiqueta="Notas">{doc.notas}</Fila>}
      </dl>

      {avisoPuntos && <p className="rs-puntos" role="status">{avisoPuntos}</p>}
      {avisoRec && (
        <p className="rs-aviso-recibo" role="status">
          {avisoRec.error ? (
            <span>Se cobró, pero no se pudo emitir el recibo. Avisa a un administrador.</span>
          ) : (
            <>
              <span>Recibo <strong>{avisoRec.code}</strong> emitido.</span>
              <button type="button" className="rs-btn" onClick={() => setVerRecibo({ codigo: avisoRec.code })}>Ver recibo</button>
            </>
          )}
        </p>
      )}
      {verRecibo && <Recibo codigo={verRecibo.codigo} pedido={c.code} alCerrar={() => setVerRecibo(null)} />}

      {c.estado === "abierto" && permite(permisos, "documento:editar") && permite(permisos, "cliente:leer") && (
        <SelectorCliente
          valor={c.cliente ? { id: c.cliente.id, nombre: c.cliente.nombre, telefono: c.snapshot?.cliente?.telefono ?? null } : null}
          alCambiar={(cl) => ejecutar("pedido", () => api.pedidos.asociarCliente(c.code, { clienteId: cl?.id ?? null, esperaVersion: c.version }))}
          puedeCrear={permite(permisos, "cliente:crear")}
          puedeCuenta={permite(permisos, "cliente:cuenta")}
          deshabilitado={ocupadoPedido}
          alPendiente={setClaveSinAnotar}
        />
      )}

      <h2 className="rs-subtitulo">Ítems</h2>
      <ul className="rs-lineas">
        {c.items.map((i) => {
          const { pasos, anular, precio, cliente: puedeCliente, cobrar: puedeCobrarItem } = accionesItem(i.estado, permisos);
          const nuevoPrecio = editandoPrecio?.code === i.code ? cuerpoPrecio(editandoPrecio.texto) : null;
          const enPedidoAbierto = c.estado === "abierto";
          return (
            <li key={i.code} className={i.estado === "anulado" ? "rs-linea rs-linea--anulado" : "rs-linea"}>
              <div className="rs-linea__cab">
                <span>
                  <strong>{i.cantidad} × {i.nombre}</strong>
                  {i.origen === "libre" ? <small> · libre</small> : i.codigo ? <small> · {i.codigo}</small> : null}
                  {" "}
                  <span className={`rs-estado rs-estado--${i.estado}`}>{ESTADOS_ITEM[i.estado] ?? i.estado}</span>
                </span>
                <span className="rs-num">{formatoDinero(i.subtotal, moneda)}</span>
              </div>
              {i.precioModificado && (
                <small>Precio cambiado: {formatoDinero(i.precio, moneda)} (catálogo: {formatoDinero(i.precioCatalogo, moneda)})</small>
              )}
              {i.notas && <small>{i.notas}</small>}
              {i.descuento && <small className="rs-descuento">{textoDescuento(i, moneda)}</small>}
              {i.estado !== "anulado" && textoPromociones(i, moneda) && <small className="rs-promocion">{textoPromociones(i, moneda)}</small>}
              {(i.cliente || (c.cliente && i.estado !== "anulado")) && (
                <small>
                  {i.cliente ? `Cliente: ${i.cliente.nombre}` : `Cuenta de ${c.cliente.nombre}`}
                </small>
              )}
              {enPedidoAbierto && puedeCliente && clienteItem === i.code && permite(permisos, "cliente:leer") && (
                <div>
                  <SelectorCliente
                    valor={i.cliente ? { id: i.cliente.id, nombre: i.cliente.nombre } : null}
                    alCambiar={(cl) => ejecutar(i.code, () => api.items.asociarCliente(i.code, { clienteId: cl?.id ?? null, esperaVersion: i.version }), () => setClienteItem(null))}
                    puedeCrear={permite(permisos, "cliente:crear")}
                    puedeCuenta={permite(permisos, "cliente:cuenta")}
                    deshabilitado={ocupado(i.code)}
                    alPendiente={setClaveSinAnotar}
                  />
                  <button type="button" className="rs-btn" onClick={() => setClienteItem(null)}>Cerrar</button>
                </div>
              )}
              {enPedidoAbierto && valeItem?.code === i.code && puedeAplicarVale(i, permisos) && (
                <FormularioVale
                  estado={valeItem}
                  moneda={moneda}
                  ocupado={ocupado(i.code)}
                  alCambiar={(v) => setValeItem({ ...valeItem, ...v })}
                  alRevisar={async () => {
                    const codigo = normalizarCodigoVale(valeItem.texto);
                    if (!codigo) return setValeItem({ ...valeItem, vale: null, aviso: "El código tiene 6 letras y números (por ejemplo K7M2QX)." });
                    try {
                      setValeItem({ ...valeItem, vale: await api.vales.consultar(codigo), aviso: "", codigo });
                    } catch (e) {
                      setValeItem({ ...valeItem, vale: null, aviso: e.status === 404 ? "No existe un vale con ese código." : mensajeDeError(e) });
                    }
                  }}
                  alAplicar={() =>
                    ejecutar(i.code, () => api.items.aplicarVale(i.code, { codigo: valeItem.codigo, esperaVersion: i.version }), () => setValeItem(null))
                  }
                  alCerrar={() => setValeItem(null)}
                />
              )}
              {enPedidoAbierto && precio && editandoPrecio?.code === i.code && (
                <form
                  className="rs-precio"
                  onSubmit={(ev) => {
                    ev.preventDefault();
                    if (nuevoPrecio.ok) ejecutar(i.code, () => api.items.paso(i.code, "precio", { precio: nuevoPrecio.precio, esperaVersion: i.version }), () => setEditandoPrecio(null));
                  }}
                >
                  <label>
                    <span>Precio</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      autoFocus
                      value={editandoPrecio.texto}
                      aria-invalid={editandoPrecio.texto !== "" && !nuevoPrecio.ok}
                      onChange={(ev) => setEditandoPrecio({ code: i.code, texto: ev.target.value })}
                    />
                  </label>
                  <button type="submit" className="rs-btn rs-btn--primario" disabled={ocupado(i.code) || !nuevoPrecio.ok}>Guardar</button>
                  <button type="button" className="rs-btn" onClick={() => setEditandoPrecio(null)}>Cancelar</button>
                  {editandoPrecio.texto !== "" && !nuevoPrecio.ok && <small className="rs-precio__aviso" role="alert">{nuevoPrecio.error}</small>}
                </form>
              )}
              {enPedidoAbierto && (pasos.some((p) => p.id === "entregar") || anular || puedeCobrarItem || (puedeCliente && clienteItem !== i.code) || (puedeAplicarVale(i, permisos) && valeItem?.code !== i.code) || (precio && editandoPrecio?.code !== i.code)) && (
                <div className="rs-acciones">
                  {puedeCobrarItem && (
                    <button type="button" className="rs-btn rs-btn--primario" disabled={ocupado(i.code) || claveSinAnotar} onClick={() => cobrarItems([i.code])}>
                      {ocupado(i.code) ? "Cobrando…" : `Cobrar ${formatoDinero(i.subtotal, moneda)}`}
                    </button>
                  )}
                  {puedeCliente && clienteItem !== i.code && permite(permisos, "cliente:leer") && (
                    <button type="button" className="rs-btn" disabled={ocupado(i.code)} onClick={() => setClienteItem(i.code)}>
                      {i.cliente ? "Cambiar cliente" : "Asignar cliente"}
                    </button>
                  )}
                  {puedeAplicarVale(i, permisos) && valeItem?.code !== i.code && (
                    <button type="button" className="rs-btn" disabled={ocupado(i.code)} onClick={() => setValeItem({ code: i.code, texto: "", vale: null, aviso: "", codigo: null })}>
                      Aplicar vale
                    </button>
                  )}
                  {pasos.filter((p) => p.id === "entregar").map((p) => (
                    <button key={p.id} type="button" className="rs-btn rs-btn--primario" disabled={ocupado(i.code)} onClick={() => ejecutar(i.code, () => api.items.paso(i.code, p.id, { esperaVersion: i.version }))}>
                      {ocupado(i.code) ? "Enviando…" : p.etiqueta}
                    </button>
                  ))}
                  {precio && editandoPrecio?.code !== i.code && (
                    <button type="button" className="rs-btn" disabled={ocupado(i.code)} onClick={() => setEditandoPrecio({ code: i.code, texto: i.precio ?? "" })}>
                      {i.precio === null ? "Poner precio" : "Cambiar precio"}
                    </button>
                  )}
                  {anular && (
                    <button type="button" className="rs-btn rs-btn--peligro" disabled={ocupado(i.code)} onClick={() => setAnulando({ tipo: "item", item: i })}>
                      Anular
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="rs-total">
        Total: <strong>{formatoDinero(c.total, moneda)}</strong>
        {c.total === null && <small> · hay ítems sin precio</small>}
        {c.ahorroPromociones > 0 && <small> · incluye −{formatoDinero(c.ahorroPromociones, moneda)} por promociones</small>}
        {c.estado === "abierto" && res.pagados > 0 && (
          <small> · cobrado {formatoDinero(res.cobrado, moneda)} · falta {formatoDinero(res.porCobrar, moneda)}</small>
        )}
      </p>

      {acc.cobrar && c.estado === "abierto" && res.entregados > 0 && (
        <div className="rs-pago">
          <h2 className="rs-subtitulo">Forma de pago</h2>
          <div className="rs-pago__campos">
            <label className="campo">
              <span>Pago con</span>
              <select value={pago.metodo} onChange={(e) => setPago({ ...pago, metodo: e.target.value, ...(e.target.value === "efectivo" ? {} : { recibido: "" }) })}>
                <option value="">Sin indicar</option>
                {METODOS_PAGO.map(([id, titulo]) => (<option key={id} value={id}>{titulo}</option>))}
              </select>
            </label>
            <label className="campo">
              <span>Propina (opcional)</span>
              <input inputMode="decimal" value={pago.propina} disabled={!pago.metodo} onChange={(e) => setPago({ ...pago, propina: e.target.value })} />
            </label>
            {pago.metodo === "efectivo" && (
              <label className="campo">
                <span>Efectivo recibido (opcional)</span>
                <input inputMode="decimal" value={pago.recibido} onChange={(e) => setPago({ ...pago, recibido: e.target.value })} />
              </label>
            )}
          </div>
          <small className="rs-vacio">Se anota en el recibo del próximo cobro. Con el efectivo recibido, el recibo calcula el vuelto.</small>
        </div>
      )}

      {grupos.length > 0 && (grupos.length > 1 || res.pagados > 0) && (
        <>
          <h2 className="rs-subtitulo">Dividir la cuenta</h2>
          <ul className="rs-lineas">
            {grupos.map((g) => (
              <li key={g.clave} className="rs-linea">
                <div className="rs-linea__cab">
                  <span>
                    <strong>{g.cliente ? g.cliente.nombre : "Sin cliente"}</strong>
                    <small> · {g.items.length} ítem{g.items.length === 1 ? "" : "s"}{g.enCurso ? ` (${g.enCurso} sin entregar)` : ""}</small>
                  </span>
                  <span className="rs-num">{g.sinPrecio ? "—" : formatoDinero(g.subtotal, moneda)}</span>
                </div>
                {g.entregados.length > 0 && (
                  <div className="rs-acciones">
                    <button type="button" className="rs-btn rs-btn--primario" disabled={g.entregados.some(ocupado) || claveSinAnotar} onClick={() => cobrarItems(g.entregados)}>
                      Cobrar {g.cliente ? `a ${g.cliente.nombre}` : "estos ítems"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="rs-acciones">
        {acc.agregar && (
          <button type="button" className="rs-btn" disabled={ocupadoPedido} onClick={() => alPedirMas(c)}>Pedir más</button>
        )}
        {acc.editarDatos && !editando && (
          <button type="button" className="rs-btn" disabled={ocupadoPedido} onClick={() => setEditando(formularioDesdePedido(c))}>
            {doc.canal === "salon" ? "Cambiar mesa y notas" : doc.canal === "llevar" ? "Cambiar nombre y notas" : "Editar datos de entrega"}
          </button>
        )}
        <button type="button" className="rs-btn" onClick={() => setVerRecibo({ cuenta: true })}>Ver cuenta</button>
        {acc.cobrar && (
          <button
            type="button"
            className="rs-btn rs-btn--primario"
            disabled={ocupadoPedido || !acc.puedeCobrarAhora || claveSinAnotar}
            title={acc.motivoNoCobrar ?? (claveSinAnotar ? "Anota primero la contraseña temporal del cliente" : undefined)}
            onClick={() => {
              const extra = conPago();
              if (!extra) return;
              ejecutar("pedido", async () => despuesDeCobrar(await api.pedidos.cobrar(c.code, { esperaVersion: c.version, ...extra })));
            }}
          >
            {res.pagados > 0 ? "Cobrar lo que falta" : "Cobrar todo"} {formatoDinero(res.porCobrar, moneda)}
          </button>
        )}
        {acc.anular && !anulando && (
          <button type="button" className="rs-btn rs-btn--peligro" disabled={ocupadoPedido} onClick={() => setAnulando({ tipo: "pedido" })}>Anular pedido</button>
        )}
      </div>
      {acc.cobrar && acc.motivoNoCobrar && <small className="rs-vacio">{acc.motivoNoCobrar}</small>}

      {editando && acc.editarDatos && (
        <form
          className="rs-form"
          onSubmit={(e) => {
            e.preventDefault();
            // validarFormulario también pide ítems: aquí no se editan, se le pasa uno de relleno
            const problema = validarFormulario({ ...editando, items: [1] });
            if (problema) return setError(problema);
            ejecutar("pedido", () => api.pedidos.editar(c.code, cuerpoDatos(editando, c.version)), () => setEditando(null));
          }}
        >
          <h2 className="rs-subtitulo">Editar datos del pedido</h2>
          {editando.canal === "salon" && (
            <label className="campo"><span>Mesa</span><input autoFocus value={editando.mesa} maxLength={20} onChange={(e) => setEditando({ ...editando, mesa: e.target.value })} /></label>
          )}
          {editando.canal === "llevar" && (
            <label className="campo"><span>A nombre de</span><input autoFocus value={editando.referencia} maxLength={60} onChange={(e) => setEditando({ ...editando, referencia: e.target.value })} /></label>
          )}
          {editando.canal === "delivery" && (
            <>
              <label className="campo"><span>Dirección de entrega</span><input autoFocus value={editando.direccion} maxLength={200} onChange={(e) => setEditando({ ...editando, direccion: e.target.value })} /></label>
              <label className="campo"><span>Teléfono de contacto</span><input value={editando.telefono} inputMode="tel" maxLength={30} onChange={(e) => setEditando({ ...editando, telefono: e.target.value })} /></label>
              <label className="campo"><span>Referencia (opcional)</span><input value={editando.referenciaEntrega} maxLength={200} onChange={(e) => setEditando({ ...editando, referenciaEntrega: e.target.value })} /></label>
            </>
          )}
          <label className="campo"><span>Notas del pedido (opcional)</span><input value={editando.notas} maxLength={500} onChange={(e) => setEditando({ ...editando, notas: e.target.value })} /></label>
          <div className="rs-acciones">
            <button type="submit" className="rs-btn rs-btn--primario" disabled={ocupadoPedido}>Guardar cambios</button>
            <button type="button" className="rs-btn" onClick={() => setEditando(null)}>Cancelar</button>
          </div>
        </form>
      )}

      {anulando && (
        <form
          className="rs-form rs-anular"
          onSubmit={(e) => {
            e.preventDefault();
            ejecutar(
              anulando.tipo === "pedido" ? "pedido" : anulando.item.code,
              () =>
                anulando.tipo === "pedido"
                  ? api.pedidos.anular(c.code, { esperaVersion: c.version, motivo: cuerpoMotivo })
                  : api.items.paso(anulando.item.code, "anular", { esperaVersion: anulando.item.version, motivo: cuerpoMotivo }),
              () => {
                setAnulando(null);
                setMotivo("");
                setDetalleMotivo("");
              },
            );
          }}
        >
          <h2 className="rs-subtitulo">
            {anulando.tipo === "pedido" ? "Anular todo el pedido" : `Anular ${anulando.item.cantidad} × ${anulando.item.nombre}`}
          </h2>
          {anulando.tipo === "pedido" && <p className="rs-vacio">También se anulan todos sus ítems.</p>}
          <label className="campo">
            <span>Motivo</span>
            <select required value={motivo} onChange={(e) => setMotivo(e.target.value)}>
              <option value="" disabled>Elige un motivo</option>
              {MOTIVOS_ANULACION.map(([id, titulo]) => (<option key={id} value={id}>{titulo}</option>))}
            </select>
          </label>
          <label className="campo">
            <span>Detalle (opcional)</span>
            <input value={detalleMotivo} onChange={(e) => setDetalleMotivo(e.target.value)} maxLength={200} />
          </label>
          <div className="rs-acciones">
            <button type="submit" className="rs-btn rs-btn--peligro" disabled={(anulando.tipo === "pedido" ? ocupadoPedido : ocupado(anulando.item.code)) || !motivo}>Confirmar anulación</button>
            <button type="button" className="rs-btn" onClick={() => setAnulando(null)}>No anular</button>
          </div>
        </form>
      )}

      <ListaRecibos code={c.code} clave={`${c.version}:${(c.recibos ?? []).length}`} moneda={moneda} alVer={setVerRecibo} />

      <h2 className="rs-subtitulo">Historial del pedido</h2>
      <ol className="rs-historial">
        {(c.historial ?? []).map((h, i) => (
          <li key={i}>
            <span>
              {h.de ? `${ESTADOS_PEDIDO[h.de] ?? h.de} → ` : "Abierto con el primer ítem · "}
              <strong>{ESTADOS_PEDIDO[h.a] ?? h.a}</strong>
              {h.motivo?.codigo ? ` · ${MOTIVOS_ANULACION.find(([k]) => k === h.motivo.codigo)?.[1] ?? h.motivo.codigo}` : ""}
              {h.motivo?.detalle ? ` (${h.motivo.detalle})` : ""}
            </span>
            {h.ts && <small>{new Date(h.ts).toLocaleString("es", { dateStyle: "short", timeStyle: "short" })}</small>}
          </li>
        ))}
      </ol>
    </section>
  );
}
