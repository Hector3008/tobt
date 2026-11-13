# tobt

Servicio tobt sobre la base común (`core`). Paso 5 de la pieza 5: pedidos (`pedido`, `PD-`) e ítems (`doc_item`, `DOC_ITEM-`), sus rutas y el **front** con pantalla de Cocina (React + Vite, `client/`). Faltan mesas, croquis, carta, método de pago y seguimiento de delivery (ver `arquitectura.md`, 5.18).

No abre conexiones: el gateway le pasa el núcleo.

```js
// Mi-Servidor / src/services.js (o donde se monten los servicios)
import { createRouter } from "tobt";
gateway.use("/tobt", createRouter({ core }));
```

`package.json` del gateway: `npm install github:Hector3008/tobt`.

## Pedidos e ítems

Dos tipos de documento separados. Necesita `core` con prefijos de hasta 12 caracteres (`DOC_ITEM`):

- **`doc_item`** (`DOC_ITEM-0000001`): **un ítem** (cantidad, notas, subtotal). Estados `en_cocina → lista → entregado`, y `anulado` (con motivo). Se mueve ítem por ítem.
- **`pedido`** (`PD-0000001`): agrupa los ítems de una persona o mesa. Se abre al pedir el primer ítem y sigue `abierto` hasta que se paga todo (`pagado`) o se anula (`anulado`, con motivo). Guarda canal, mesa, referencia, entrega y notas, y los códigos de sus ítems (`codigosItems`).

| Acción | Ruta | Permiso/estación |
|---|---|---|
| Abrir pedido con sus primeros ítems | `POST /pedidos` | ninguna (la ruta exige `documento:editar`) |
| Pedir más ítems | `POST /pedidos/:code/items` | ídem |
| Editar datos | `PUT /pedidos/:code` | ídem |
| Cobrar | `POST /pedidos/:code/cobrar` | `estacion:administracion` |
| Anular pedido (anula también sus ítems) | `POST /pedidos/:code/anular` `{ motivo }` | `estacion:administracion` |
| Marcar ítem listo | `POST /items/:code/lista` | `estacion:cocina` |
| Entregar ítem | `POST /items/:code/entregar` | ninguna |
| Corregir el precio de un ítem (sin anularlo) | `POST /items/:code/precio` `{ precio }` | `estacion:administracion` |
| Anular ítem | `POST /items/:code/anular` `{ motivo }` | `estacion:creacion`; si ya no está en cocina, además `estacion:administracion` |

Lecturas: `GET /pedidos`, `GET /pedidos/:code`, `GET /items` (ítems con su pedido; `?estado=`), `GET /items/:code`. Las que escriben exigen `x-requested-with`.

Cobrar exige que no queden ítems en cocina ni listos y que haya al menos uno entregado; guarda el total. Totales en céntimos, sin contar anulados; `null` si algún ítem no tiene precio. Crear/agregar no es transaccional: si algo falla a medias, los ítems ya creados quedan vinculados.

**Precio propio** (`precio` en una línea del catálogo): cambia el precio solo en ese ítem. Exige `estacion:administracion`; el snapshot guarda `precioCatalogo` y `precioModificado: true`. En una línea libre el precio va dentro de `libre` y no pide permiso. Para corregirlo **después** (un ítem sin precio, o uno equivocado) está `POST /items/:code/precio`: vale en cualquier estado vivo del ítem mientras el pedido esté abierto, solo cambia el precio (cantidad, notas y qué ítem siguen sin editarse: se anula y se pide otro) y el total del pedido se recalcula. Hasta 2 decimales, mínimo 0.

## Front de Pedidos y Cocina

`client/` (React + Vite, como `cuenta`) con `client/dist` **commiteado**. `createRouter` lo sirve en la raíz del montaje, junto a la API: `<base>/tobt/`. El cliente pide la API en relativo (`../tobt/pedidos`, `../auth/yo`, `../catalogo/`), así que **debe montarse en `<base>/tobt/`** (sin la barra final redirige). Mismo origen que el gateway: la cookie `sid` funciona sin CORS.

Sin enrutador: lista de pedidos · nueva · detalle · pedir más · cocina (`#cocina`). La lista muestra los ítems de cada pedido con entrega rápida; Cocina muestra **una tarjeta por ítem** con botón «Listo» (sondeo cada 10 s). Si no hay sesión, hay que cambiar la contraseña temporal o falta elegir empresa, manda a `cuenta` (`../cuenta/`). Ítems del catálogo o libres, en los tres canales; el servidor copia nombre y precio y calcula los importes. Cada botón se muestra según permisos y estación (`client/src/pedidos.js`, `accionesItem`/`accionesPedido`): ocultarlo **no es seguridad**.

```
npm run build   # instala y compila client/ → client/dist (commitearlo)
npm run dev     # Vite en :5173 con proxy al gateway (GATEWAY_URL para cambiarlo)
```

`createRouter` falla al arrancar, con un mensaje claro, si no existe `client/dist/index.html` o `client/dist/catalogo.html`.

## Carta pública y puntos (sin sesión)

Vista para los **clientes**: `<base>/tobt/catalogo/<slug-de-la-empresa>` (por ejemplo `/tobt/catalogo/cafe-central`). Muestra la carta (ítems **activos** del catálogo, agrupados por categoría, con buscador) y los puntos acumulados del cliente. Es una segunda página del mismo `client/` (`catalogo.html`, código en `client/src/catalogo/`), compilada junto a la del personal.

- **API pública** (solo GET, sin sesión, con límite de 60 consultas por minuto por IP, en memoria): `GET /publico/:empresa/carta` y `GET /publico/:empresa/cliente`. La empresa debe existir, estar activa y tener el servicio `tobt` activo; si no, siempre el mismo 404. Solo salen código, nombre, categoría y precio: nunca `atributos` ni ítems desactivados.
- **El cliente está hardcodeado** en `src/cliente-demo.js` (nombre, 120 puntos y 4 movimientos de ejemplo, iguales para todas las empresas). La respuesta lleva `demo: true` y la página lo avisa. Cuando exista la identidad del cliente final y la fidelización (5.11), solo se reemplaza `clienteActual()` de ese archivo.
- **Detalle del plato:** tocar un plato abre `#/plato/<código>` (ruta por hash; «atrás» vuelve a la carta con su búsqueda y filtro). Muestra categoría, nombre, precio, **descripción** y **foto**, ambas opcionales, y las reseñas. API: `GET /publico/:empresa/plato/:codigo` (404 si no existe o está desactivado). Descripción y foto son atributos del ítem del catálogo, `DESCRIPCION` (texto) e `IMAGEN` (URL **https**); el servicio los declara con `registrarEsquema` y solo esos dos campos salen al público. Una URL que no sea https se descarta. Sin foto no se muestra recuadro. Las imágenes van únicamente en la presentación del plato: las reseñas son solo texto y estrellas.
- **Reseñas de ejemplo** en `src/resenas-demo.js` (3, iguales para todos los platos, `demo: true`, la página lo avisa). No hay reseñas reales hasta tener identidad del cliente final y dónde guardarlas; entonces solo se reemplaza `resenasDe()`.
- La página se sirve con `<base href>` en la raíz del montaje, así funciona con cualquier `BASE_PATH`. En desarrollo: `http://localhost:5173/catalogo.html?empresa=<slug>`.

## Inventario: recetas y descuento de insumos (5.76)

Necesita el kardex del núcleo (5.75, `core.kardex`); sin él, tobt funciona igual que antes y las rutas de recetas responden 409.

- Una **receta** dice qué insumos gasta una porción de un plato del catálogo, en la unidad base del insumo (`PUT /recetas/:platoCodigo` con `{ lineas: [{ insumoId, cantidad }] }`, permiso `kardex:gestionar`; `GET /recetas` y `GET /recetas/:platoCodigo` con `kardex:leer`; `DELETE` con `kardex:gestionar`). Colección `tobt_recetas`.
- Al **crear un ítem** (pedido nuevo o más ítems) se descuenta receta × cantidad con el código del ítem como referencia (repetir no descuenta dos veces). **Nunca bloquea**: si falta stock o el kardex falla, el pedido se crea igual. La respuesta puede traer `stockBajo` (`[{ insumo, nombre, existencia, negativo, bajoMinimo }]`) y `sinReceta` (`[{ codigo, nombre }]`, solo si la empresa ya usa recetas).
- Al **anular** un ítem (o el pedido) que sigue en cocina, el insumo vuelve al kardex. Si ya salió de cocina (lista o entregado) se preparó y el consumo se queda.
- Las líneas libres (sin código del catálogo) no descuentan nada.

## Pruebas

```
npm test                                   # pruebas sin base de datos (servicio, front, servido estático y carta pública)
MONGODB_URI=mongodb://localhost:27017 npm test   # suma las de MongoDB real (pedidos.test.js)
```

El humo contra el gateway (`humo-tobt.mjs`) va en la carpeta `test/` del gateway, no aquí.
# tobt

