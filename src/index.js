import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { conEmpresa, permite } from "core";
import { crearServicio } from "./servicio.js";
import { crearReportes } from "./reportes.js";
import { montarRutas } from "./http.js";
import { crearPublico, CAMPOS_PLATO } from "./publico.js";
import { montarRutasPublicas } from "./publico-http.js";
import { crearManejadoresVales } from "./publico-vales.js";
import { crearManejadoresResenas } from "./publico-resenas.js";
import { crearFuenteConsumo } from "./consumo-resenas.js";
import { TIPO_ITEM, TIPO_PEDIDO, TIPO_RECIBO } from "./tipos.js";
import { extraerConsumo } from "./fuente-puntos.js";

export { TIPO_ITEM, TIPO_PEDIDO, TIPO_RECIBO, MOTIVOS_ANULACION } from "./tipos.js";
export { ErrorPedido } from "./errores.js";
export { crearServicio } from "./servicio.js";
export { crearReportes } from "./reportes.js";

const DIST_POR_DEFECTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "client", "dist");

/**
 * Punto de entrada del servicio. El gateway lo monta así (misma forma que microservicio-prueba-):
 *
 *   import { createRouter } from "tobt";
 *   gateway.use("/tobt", createRouter({ core }));
 *
 * Registra los tipos de documento `doc_item` y `pedido` al montarse (idempotente). No abre conexiones: usa el núcleo
 * del gateway. `db` se acepta por compatibilidad con los demás servicios y hoy no se usa.
 *
 * Además de la API (/pedidos y /items), sirve el front compilado (client/dist, commiteado) en la raíz del montaje:
 * `<base>/tobt/`. El front pide la API en relativo (`../tobt/pedidos`), así que debe
 * montarse en `<base>/tobt/`, igual que `cuenta`.
 *
 * Y la vista pública de la carta, sin sesión: `<base>/tobt/catalogo/<slug-de-la-empresa>` (publico-http.js).
 */
export function createRouter({ core, dist = DIST_POR_DEFECTO } = {}) {
  if (!core?.documentos || !core?.catalogo || !core?.clientes)
    throw new Error("createRouter: se requiere { core } (el núcleo creado por el gateway)");
  for (const archivo of ["index.html", "catalogo.html"])
    if (!fs.existsSync(path.join(dist, archivo)))
      throw new Error(
        `tobt: no existe ${path.join(dist, archivo)}. Ejecuta "npm run build" y commitea client/dist.`,
      );

  core.documentos.registrarTipo(TIPO_ITEM);
  core.documentos.registrarTipo(TIPO_PEDIDO);
  core.documentos.registrarTipo(TIPO_RECIBO);
  // Campos del plato que el catálogo valida por tipo (descripción y foto de la carta pública).
  core.catalogo.registrarEsquema?.({ campos: CAMPOS_PLATO });
  // Fidelización: cada ítem que se paga acumula puntos a SU cliente (o, si no tiene, al del pedido), si dio su
  // consentimiento. Los puntos van por ítem porque la cuenta se puede dividir (5.27): el monto es el subtotal del ítem.
  core.fidelizacion?.registrarFuente({
    tipo: TIPO_ITEM.tipo ?? "doc_item",
    estado: "pagado",
    extraer: extraerConsumo,
  });
  const servicio = crearServicio(core);
  // Reportes de ventas (5.35): agregación sobre los documentos de la empresa; permiso `reporte:leer`.
  servicio.reportes = core.modelos?.Documento
    ? crearReportes({ conEmpresa, permite, modelos: core.modelos })
    : null;

  // Reseñas de platos (5.62): el núcleo pregunta aquí si un cliente pagó el plato. Un núcleo anterior no las trae.
  const pagoElPlato = core.resenas && core.modelos?.Documento ? crearFuenteConsumo({ conEmpresa, modelos: core.modelos }) : null;
  if (pagoElPlato) core.resenas.definirFuenteConsumo(pagoElPlato);

  const router = express.Router();
  router.use(express.json());
  montarRutas(router, core, servicio);
  // Vista pública de la carta (sin sesión): /catalogo/:empresa y /publico/:empresa/...
  const publico = crearPublico(core);
  montarRutasPublicas(
    router,
    publico,
    fs.readFileSync(path.join(dist, "catalogo.html"), "utf8"),
    undefined,
    core.cuentasCliente?.manejadores({ empresaDe: publico.empresaDe }) ?? null,
    core.cuentasCliente && core.fidelizacion?.tickets ? crearManejadoresVales(core, publico.empresaDe) : null,
    core.cuentasCliente && pagoElPlato ? crearManejadoresResenas(core, publico.empresaDe, { pagoElPlato }) : null,
  );
  router.use(
    express.static(dist, {
      index: "index.html",
      setHeaders(res, archivo) {
        // El HTML no se cachea; los archivos con hash en el nombre sí.
        if (archivo.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
        else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  router.servicio = servicio; // para pruebas y para otros módulos del servicio
  return router;
}
