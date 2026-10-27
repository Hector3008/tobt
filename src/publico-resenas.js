import { ErrorResena } from "core";

/**
 * Reseñas de platos del cliente en la carta pública (arquitectura 5.62). Van con la sesión del cliente (`cs_<slug>`):
 * el cliente es siempre el de la sesión, nunca uno que mande el cuerpo. Las guarda y modera `core.resenas`.
 * Lo que ve cualquiera (sin sesión) sale en `GET /publico/:empresa/plato/:codigo` (publico.js).
 *
 *   GET    /publico/:empresa/cuenta/resenas/:codigo   { puedeResenar, mia, total, promedio, resenas }   lista fresca, sin caché
 *   PUT    /publico/:empresa/cuenta/resenas/:codigo   { estrellas, texto? }   → { resena }   crea o edita la mía
 *   DELETE /publico/:empresa/cuenta/resenas/:codigo   → { ok }
 *   POST   /publico/:empresa/cuenta/resenas/:resenaId/reportar   → { reportada }
 */
export function crearManejadoresResenas(core, empresaDe, { pagoElPlato }) {
  const r = core.resenas;
  const sesion = core.cuentasCliente.autenticarCliente({ empresaDe });

  const envolver = (fn) => async (req, res, next) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      await fn(req, res);
    } catch (e) {
      if (e instanceof ErrorResena) return res.status(e.status).json({ error: e.message, codigo: e.codigo });
      next(e);
    }
  };
  const quien = (req) => ({ empresaId: req.cliente.empresaId, clienteId: req.cliente.clienteId });

  return {
    sesion,
    ver: envolver(async (req, res) => {
      const q = quien(req);
      const codigo = req.params.codigo;
      const [lista, puede] = await Promise.all([
        r.deItem({ ...q, itemCodigo: codigo }),
        pagoElPlato({ ...q, itemCodigo: codigo }).catch(() => false),
      ]);
      res.status(200).json({ ...lista, puedeResenar: puede === true });
    }),
    guardar: envolver(async (req, res) => {
      const cuerpo = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      // Solo estrellas y texto salen del cuerpo; el cliente, la empresa y el plato nunca (van al final y pisan lo demás).
      const { estrellas, texto } = cuerpo;
      res.status(200).json({ resena: await r.guardarMia({ estrellas, texto, ...quien(req), itemCodigo: req.params.codigo }) });
    }),
    borrar: envolver(async (req, res) => res.status(200).json(await r.borrarMia({ ...quien(req), itemCodigo: req.params.codigo }))),
    reportar: envolver(async (req, res) => res.status(200).json(await r.reportar({ ...quien(req), resenaId: req.params.resenaId }))),
  };
}
