import { useCallback, useEffect, useState } from "react";
import { api, ErrorApi, mensajeDeError, urlCarta, urlCuenta } from "./api.js";
import { avisoRespuesta, permite, puedeCambiarPrecio, puedeMarcarListos, puedeVerDisponibilidad } from "./pedidos.js";
import Cocina from "./Cocina.jsx";
import Disponibilidad from "./Disponibilidad.jsx";
import ListaPedidos from "./ListaPedidos.jsx";
import FormularioPedido from "./FormularioPedido.jsx";
import DetallePedido from "./DetallePedido.jsx";

// Sin enrutador (como `cuenta`): la vista sale del estado.
//   sin sesión / sin empresa / contraseña temporal → se manda a `cuenta` (ahí se resuelve)
//   si no → pedidos (lista) · nueva · detalle de un pedido · pedir más en un pedido · cocina
export default function App() {
  const [yo, setYo] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [problema, setProblema] = useState(null); // { texto, irACuenta }
  // `#cocina` abre la pantalla de cocina y `#disponibilidad` la de platos agotados (son los enlaces de Inicio en `cuenta`)
  const [vista, setVista] = useState({ tipo: location.hash === "#cocina" ? "cocina" : location.hash === "#disponibilidad" ? "disponibilidad" : "lista" });
  const [version, setVersion] = useState(0); // fuerza recargar la lista al volver

  const cargarYo = useCallback(async () => {
    try {
      const d = await api.yo();
      if (d.debeCambiarPassword)
        setProblema({ texto: "Debes cambiar tu contraseña temporal antes de usar tobt.", irACuenta: true });
      else if (!d.empresaActivaId)
        setProblema({ texto: "Elige una empresa para continuar.", irACuenta: true });
      else {
        setYo(d);
        setProblema(null);
      }
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 401) setProblema({ texto: "Inicia sesión para continuar.", irACuenta: true });
      else if (e instanceof ErrorApi && e.codigo === "CAMBIO_PASSWORD_REQUERIDO")
        setProblema({ texto: "Debes cambiar tu contraseña temporal antes de usar tobt.", irACuenta: true });
      else setProblema({ texto: mensajeDeError(e), irACuenta: false });
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => { cargarYo(); }, [cargarYo]);

  const aLista = () => { setVista({ tipo: "lista" }); setVersion((v) => v + 1); history.replaceState(null, "", location.pathname + location.search); };
  const aCocina = () => { setVista({ tipo: "cocina" }); history.replaceState(null, "", "#cocina"); };
  const aDisponibilidad = () => { setVista({ tipo: "disponibilidad" }); history.replaceState(null, "", "#disponibilidad"); };

  if (cargando) return <main className="rs-centrado"><p className="cargando">Cargando…</p></main>;
  if (problema)
    return (
      <main className="rs-centrado">
        <section className="rs-aviso-pantalla">
          <p>{problema.texto}</p>
          {problema.irACuenta ? (
            <a className="rs-btn rs-btn--primario" href={urlCuenta}>Ir a mi cuenta</a>
          ) : (
            <button type="button" className="rs-btn rs-btn--primario" onClick={() => { setCargando(true); cargarYo(); }}>Reintentar</button>
          )}
        </section>
      </main>
    );

  const permisos = yo.permisos;
  if (!permite(permisos, "documento:leer"))
    return (
      <main className="rs-centrado">
        <section className="rs-aviso-pantalla">
          <p>Tu rol no tiene acceso a los pedidos y ítems.</p>
          <a className="rs-btn" href={urlCuenta}>Volver a mi cuenta</a>
        </section>
      </main>
    );

  return (
    <main className="rs">
      <nav className="rs-barra" aria-label="Navegación">
        <a className="enlace-volver" href={urlCuenta}>← Inicio</a>
        <span className="rs-barra__der">
          {yo.empresa?.slug && (
            <a className="enlace-volver" href={urlCarta(yo.empresa.slug)} target="_blank" rel="noopener">Ver carta pública ↗</a>
          )}
          {yo.empresa?.nombre && <span className="rs-empresa">{yo.empresa.nombre}</span>}
        </span>
      </nav>

      {vista.tipo === "lista" && (
        <ListaPedidos
          key={version}
          permisos={permisos}
          alCocina={aCocina}
          alDisponibilidad={puedeVerDisponibilidad(permisos) ? aDisponibilidad : null}
          alAbrir={(code) => setVista({ tipo: "detalle", code })}
          alCrear={() => setVista({ tipo: "nuevo" })}
        />
      )}
      {vista.tipo === "cocina" && (
        <Cocina puedeMarcar={puedeMarcarListos(permisos)} alVolver={aLista} alDisponibilidad={puedeVerDisponibilidad(permisos) ? aDisponibilidad : null} />
      )}
      {vista.tipo === "disponibilidad" && (
        puedeVerDisponibilidad(permisos)
          ? <Disponibilidad alVolver={aLista} alCocina={permite(permisos, "estacion:cocina") ? aCocina : null} />
          : (
            <section className="rs-aviso-pantalla">
              <p>Tu rol no puede marcar platos como agotados.</p>
              <button type="button" className="rs-btn" onClick={aLista}>Ver pedidos</button>
            </section>
          )
      )}
      {vista.tipo === "nuevo" && (
        <FormularioPedido
          puedeVerCatalogo={permite(permisos, "catalogo:leer")}
          puedeCambiarPrecio={puedeCambiarPrecio(permisos)}
          puedeVerClientes={permite(permisos, "cliente:leer")}
          puedeCrearClientes={permite(permisos, "cliente:crear")}
          puedeCuentas={permite(permisos, "cliente:cuenta")}
          alGuardar={(c) => setVista({ tipo: "detalle", code: c.code, aviso: avisoRespuesta(c) })}
          alCancelar={aLista}
        />
      )}
      {vista.tipo === "detalle" && (
        <DetallePedido
          key={vista.code}
          code={vista.code}
          avisoInicial={vista.aviso ?? ""}
          permisos={permisos}
          alVolver={aLista}
          alPedirMas={(pedido) => setVista({ tipo: "mas", pedido })}
        />
      )}
      {vista.tipo === "mas" && (
        <FormularioPedido
          pedido={vista.pedido}
          puedeVerCatalogo={permite(permisos, "catalogo:leer")}
          puedeCambiarPrecio={puedeCambiarPrecio(permisos)}
          alGuardar={(c) => setVista({ tipo: "detalle", code: vista.pedido.code, aviso: avisoRespuesta(c) })}
          alCancelar={() => setVista({ tipo: "detalle", code: vista.pedido.code })}
        />
      )}
    </main>
  );
}
