// ¿Pagó este cliente este plato? (arquitectura 5.62). Lo único que `core.resenas` le pregunta al servicio de pedidos:
// un cliente puede reseñar un plato si tiene al menos un ítem `doc_item` en estado `pagado` con ese plato del catálogo.
// Las líneas libres no cuentan (no son un plato de la carta) y lo anulado nunca llega a `pagado`.
//
// `modelos` son los del núcleo (`core.modelos`): `Documento` lleva multiempresa (conEmpresa antepone la empresa).
export function crearFuenteConsumo({ conEmpresa, modelos }) {
  return async function pagoElPlato({ empresaId, clienteId, itemCodigo }) {
    if (typeof clienteId !== "string" || typeof itemCodigo !== "string" || !itemCodigo.trim()) return false;
    const codigos = [...new Set([itemCodigo, itemCodigo.trim().toLowerCase()])];
    const hay = await conEmpresa(
      empresaId,
      async () =>
        await modelos.Documento.exists({
          tipo: "doc_item",
          estado: "pagado",
          "snapshot.cliente.clienteId": clienteId,
          "snapshot.item.origen": "catalogo",
          "snapshot.item.codigo": { $in: codigos },
        }),
    );
    return Boolean(hay);
  };
}
