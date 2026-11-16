// Reglas de los dos documentos de tobt. Se registran en el motor al montar el servicio
// (core.documentos.registrarTipo); viajan con este código, los documentos viven en MongoDB.
//
// Dos cosas distintas (arquitectura 5.18):
//
//   ITEM (tipo `doc_item`): un solo ítem que se mueve por las estaciones. Es lo que ve cocina.
//     en_cocina → lista → entregado → pagado    anulado: salida final antes de pagar (también tras entregar), con motivo
//     `pagado` es el cobro de ESE ítem (cuenta dividida, 5.27): un ítem pagado ya no cambia.
//
//   PEDIDO (tipo `pedido`): todo lo que pidió una mesa o una persona, desde el primer ítem hasta que se
//   paga todo el pedido. Es lo que se cobra.
//     abierto → pagado                      anulado: salida final desde abierto, con motivo
//
// Decisiones: el ítem nace ya en cocina (se crea al pedir el ítem); `entregado` no pide estación del
// motor (la entrega la hace el mesero o el repartidor y el motor admite un solo permiso por estado; la
// ruta exige documento:editar); anular un ítem pide estacion:creacion en el motor y el servicio exige
// además estacion:administracion cuando el ítem ya salió de cocina; pagar y anular un pedido piden la
// estación de administración.
export const MOTIVOS_ANULACION = [
  "error_pedido",
  "cliente_se_fue",
  "sin_stock",
  "cortesia",
  "otro",
];

export const TIPO_ITEM = Object.freeze({
  tipo: "doc_item",
  prefijo: "DOC_ITEM",
  estadoInicial: "en_cocina",
  transiciones: {
    en_cocina: ["lista", "anulado"],
    lista: ["entregado", "anulado"],
    entregado: ["pagado", "anulado"],
  },
  permisos: {
    lista: "estacion:cocina",
    pagado: "estacion:administracion",
    anulado: "estacion:creacion",
  },
  motivos: { anulado: MOTIVOS_ANULACION },
  // Lo que cocina prepara no se edita (cantidad, notas, qué ítem): si se equivocó, se anula y se pide otro.
  // Lo único que cambia sobre un ítem vivo es su precio (administración) y el cliente al que se le cobra
  // (`snapshot.cliente`): el servicio no admite otra edición. Un ítem pagado no se edita.
  editables: ["en_cocina", "lista", "entregado"],
});

export const TIPO_PEDIDO = Object.freeze({
  tipo: "pedido",
  prefijo: "PD",
  estadoInicial: "abierto",
  transiciones: {
    abierto: ["pagado", "anulado"],
  },
  permisos: {
    pagado: "estacion:administracion",
    anulado: "estacion:administracion",
  },
  motivos: { anulado: MOTIVOS_ANULACION },
  editables: ["abierto"],
});

// RECIBO (tipo `recibo`, 5.32): el comprobante NO fiscal de un cobro (entero o por ítems). Se crea al cobrar y su contenido
// no cambia. Su número es el código (RC-0000001), consecutivo por empresa.
// Factura pedida (5.88): `emitido` es el estado normal; si el cliente pidió factura y ya se emitió fuera del sistema, se
// marca `facturado` (con el número de la factura) y se puede deshacer con motivo. Solo `facturas.js` toca esa marca.
export const MOTIVOS_FACTURA = Object.freeze(["error_de_marca", "factura_anulada", "otro"]);
export const TIPO_RECIBO = Object.freeze({
  tipo: "recibo",
  prefijo: "RC",
  estadoInicial: "emitido",
  transiciones: { emitido: ["facturado"], facturado: ["emitido"] },
  permisos: { facturado: "documento:editar", emitido: "documento:editar" },
  motivos: { emitido: MOTIVOS_FACTURA },
  editables: ["emitido", "facturado"],
});
