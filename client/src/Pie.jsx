// Pie de página de todas las vistas: enlaza a la raíz de la plataforma (el landing de Ilnapo, `<base>/`), a los términos y a
// la política de privacidad, que sirve el gateway en `<base>/terminos` y `<base>/privacidad`. La ruta base se obtiene como en el resto del front ("../" relativo al
// documento), sin conocer el BASE_PATH.
const BASE = new URL("../", document.baseURI).pathname;
export const urlRaiz = BASE;
export const urlTerminos = BASE + "terminos";
export const urlPrivacidad = BASE + "privacidad";

export default function Pie() {
  return (
    <footer className="pie-legal">
      <nav aria-label="Información legal">
        <a href={urlRaiz}>Ilnapo</a>
        <span aria-hidden="true"> · </span>
        <a href={urlTerminos}>Términos y condiciones</a>
        <span aria-hidden="true"> · </span>
        <a href={urlPrivacidad}>Política de privacidad</a>
      </nav>
    </footer>
  );
}
