import { useEffect, useState } from "react";
import { api, mensajeDeError } from "./api.js";
import { formatoDinero } from "./pedidos.js";
import { encabezadoRecibo, formatoFechaHora, notaRecibo, textoDescuentoLinea, textoFactura, textoPromocionesLinea, tituloRecibo } from "./recibos.js";

const destino = (r) => {
  if (r.canal === "salon") return r.mesa ? `Mesa ${r.mesa}` : "Salón";
  if (r.canal === "llevar") return r.referencia ? `Para llevar · ${r.referencia}` : "Para llevar";
  if (r.canal === "delivery") return r.referencia ? `Delivery · ${r.referencia}` : "Delivery";
  return "";
};

// Un recibo de pago (`codigo` = RC-…) o la cuenta de un pedido (`pedido` = PD-…), listo para ver e imprimir.
// Al imprimir solo sale el recibo (ver estilos @media print). No es un comprobante fiscal.
export default function Recibo({ codigo, pedido, alCerrar }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const [logoRoto, setLogoRoto] = useState(false);

  useEffect(() => {
    let vigente = true;
    setR(null);
    setError("");
    setLogoRoto(false);
    (codigo ? api.recibos.obtener(codigo) : api.pedidos.cuenta(pedido))
      .then((d) => vigente && setR(d))
      .catch((e) => vigente && setError(mensajeDeError(e)));
    return () => {
      vigente = false;
    };
  }, [codigo, pedido]);

  if (error)
    return (
      <section className="rs-recibo-caja">
        <p className="aviso-error" role="alert">{error}</p>
        <button type="button" className="rs-btn" onClick={alCerrar}>Cerrar</button>
      </section>
    );
  if (!r) return <section className="rs-recibo-caja"><p className="cargando">Cargando…</p></section>;

  const $ = (v) => formatoDinero(v, r.moneda);
  const pago = r.tipo === "pago";
  const enc = encabezadoRecibo(r);
  return (
    <section className="rs-recibo-caja" aria-label={tituloRecibo(r)}>
      <article className="rs-recibo">
        {enc.logo && !logoRoto && <img className="rs-recibo__logo" src={enc.logo} alt={`Logo de ${enc.nombre}`} referrerPolicy="no-referrer" onError={() => setLogoRoto(true)} />}
        {enc.nombre && <h2 className="rs-recibo__empresa">{enc.nombre}</h2>}
        {enc.lineas.length > 0 && <p className="rs-recibo__datos">{enc.lineas.map((l, i) => (<span key={i}>{l}</span>))}</p>}
        <p className="rs-recibo__titulo">{tituloRecibo(r)}{pago && <> · <strong>{r.code}</strong></>}</p>
        <p className="rs-recibo__meta">
          {formatoFechaHora(r.emitidoTs)}
          {destino(r) && <><br />{destino(r)}</>}
          <br />Pedido {r.pedidoCode}
          {pago && r.clientes?.length > 0 && <><br />Cliente: {r.clientes.map((c) => c.nombre).join(", ")}</>}
          {!pago && r.cliente?.nombre && <><br />Cliente: {r.cliente.nombre}</>}
        </p>
        <table className="rs-recibo__lineas">
          <tbody>
            {r.lineas.map((l) => (
              <tr key={l.itemCode}>
                <td>
                  {l.cantidad} × {l.nombre}
                  {textoDescuentoLinea(l, $) && <small className="rs-recibo__desc">{textoDescuentoLinea(l, $)}</small>}
                  {textoPromocionesLinea(l, $) && <small className="rs-recibo__desc">{textoPromocionesLinea(l, $)}</small>}
                  {!pago && <small className="rs-recibo__desc">{l.pagado ? "Pagado" : "Por cobrar"}</small>}
                </td>
                <td className="rs-num">{$(l.subtotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="rs-recibo__totales">
          {pago ? (
            <>
              <dt>Subtotal</dt><dd>{$(r.subtotal)}</dd>
              {r.propina > 0 && (<><dt>Propina</dt><dd>{$(r.propina)}</dd></>)}
              <dt className="rs-recibo__total">Total</dt><dd className="rs-recibo__total">{$(r.total)}</dd>
              {r.metodoTexto && (<><dt>Pago</dt><dd>{r.metodoTexto}</dd></>)}
              {textoFactura(r) && (<><dt>Factura</dt><dd>{textoFactura(r)}</dd></>)}
              {r.recibido != null && (<><dt>Recibido</dt><dd>{$(r.recibido)}</dd></>)}
              {r.vuelto != null && (<><dt>Vuelto</dt><dd>{$(r.vuelto)}</dd></>)}
            </>
          ) : (
            <>
              <dt className="rs-recibo__total">Total</dt><dd className="rs-recibo__total">{$(r.total)}</dd>
              <dt>Cobrado</dt><dd>{$(r.cobrado)}</dd>
              <dt>Por cobrar</dt><dd>{$(r.porCobrar)}</dd>
              {r.propinas > 0 && (<><dt>Propinas</dt><dd>{$(r.propinas)}</dd></>)}
            </>
          )}
        </dl>
        {r.descuentos > 0 && <p className="rs-recibo__meta">Incluye descuentos por vales: {$(r.descuentos)}.</p>}
        {r.promociones > 0 && <p className="rs-recibo__meta">Incluye descuentos por promociones: {$(r.promociones)}.</p>}
        {!pago && r.pagos?.length > 0 && (
          <p className="rs-recibo__meta">
            Pagos: {r.pagos.map((p) => `${p.code}${p.metodoTexto ? ` (${p.metodoTexto})` : ""}`).join(", ")}
          </p>
        )}
        {enc.pie && <p className="rs-recibo__pie">{enc.pie}</p>}
        <p className="rs-recibo__nota">{notaRecibo(r)}</p>
      </article>
      <div className="rs-acciones rs-recibo__acciones">
        <button type="button" className="rs-btn rs-btn--primario" onClick={() => window.print()}>Imprimir</button>
        <button type="button" className="rs-btn" onClick={alCerrar}>Cerrar</button>
      </div>
    </section>
  );
}
