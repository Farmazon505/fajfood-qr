import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import StaffReservations from "./StaffReservations";
import "./styles.css";

const RootApp = window.location.pathname.startsWith("/staff/reservations")
  ? StaffReservations
  : App;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootApp />
  </StrictMode>
);
