import { useEffect, useRef, useState } from "react";
import { URL_SCRIPT_GOOGLE } from "./logica.js";

// «Continuar con Google» (5.51): el botón oficial de Google Identity Services. Google entrega un ID token
// (`credential`) que el servidor comprueba; aquí no se lee ni se guarda nada de la cuenta de Google.
let cargaScript = null;
function cargarScriptGoogle() {
  if (window.google?.accounts?.id) return Promise.resolve();
  cargaScript ??= new Promise((ok, ko) => {
    const s = document.createElement("script");
    s.src = URL_SCRIPT_GOOGLE;
    s.async = true;
    s.onload = ok;
    s.onerror = () => {
      cargaScript = null; // se puede reintentar
      ko(new Error("script"));
    };
    document.head.appendChild(s);
  });
  return cargaScript;
}

// `alCredencial(credencial)` se llama cuando la persona elige su cuenta. `texto`: "continue_with" | "signin_with" | "signup_with".
export default function BotonGoogle({ clientId, alCredencial, texto = "continue_with", deshabilitado = false }) {
  const caja = useRef(null);
  const ultimo = useRef(alCredencial);
  ultimo.current = alCredencial; // el callback de Google se registra una vez: siempre llama a la versión más reciente
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    let vivo = true;
    cargarScriptGoogle().then(
      () => {
        if (!vivo || !caja.current) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => r?.credential && ultimo.current?.(r.credential),
          ux_mode: "popup",
          auto_select: false,
        });
        caja.current.replaceChildren();
        window.google.accounts.id.renderButton(caja.current, {
          type: "standard", theme: "outline", size: "large", text: texto, shape: "pill", locale: "es",
          width: Math.min(320, Math.max(200, caja.current.clientWidth || 280)),
        });
      },
      () => vivo && setFallo(true),
    );
    return () => {
      vivo = false;
    };
  }, [clientId, texto]);

  if (fallo) return <p className="rs-vacio">No se pudo cargar el acceso con Google. Puedes entrar con tu correo o teléfono.</p>;
  return <div className="cat-google" ref={caja} aria-disabled={deshabilitado} style={deshabilitado ? { opacity: 0.5, pointerEvents: "none" } : undefined} />;
}
