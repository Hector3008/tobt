import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Pie from "./Pie.jsx";
import "./estilos.css";

createRoot(document.getElementById("raiz")).render(
  <StrictMode>
    <div className="app-con-pie">
      <div className="app-contenido">
        <App />
      </div>
      <Pie />
    </div>
  </StrictMode>
);
