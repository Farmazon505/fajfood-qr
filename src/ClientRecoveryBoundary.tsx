import { Component, type ErrorInfo, type ReactNode } from "react";
import { claimClientRecovery, resetClientRecovery } from "./network-recovery";

type Props = { children: ReactNode };
type State = { error: Error | null; online: boolean };

export default class ClientRecoveryBoundary extends Component<Props, State> {
  state: State = { error: null, online: true };
  private reloadTimer: number | null = null;

  static getDerivedStateFromError(error: Error): State {
    return { error, online: typeof navigator === "undefined" || navigator.onLine };
  }

  componentDidMount() {
    window.addEventListener("online", this.recover);
    window.addEventListener("offline", this.markOffline);
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[QRNASTOL_CLIENT_ERROR]", error, info.componentStack);
    this.recover();
  }

  componentWillUnmount() {
    window.removeEventListener("online", this.recover);
    window.removeEventListener("offline", this.markOffline);
    if (this.reloadTimer !== null) window.clearTimeout(this.reloadTimer);
  }

  private markOffline = () => {
    this.setState({ online: false });
  };

  private recover = () => {
    const online = navigator.onLine;
    this.setState({ online });
    if (!this.state.error || !online || !claimClientRecovery(window.sessionStorage)) return;
    this.reloadTimer = window.setTimeout(() => window.location.reload(), 700);
  };

  private reloadNow = () => {
    resetClientRecovery(window.sessionStorage);
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="guest-shell empty-state">
        <h1>{this.state.online ? "Восстанавливаем приложение" : "Нет соединения"}</h1>
        <p>
          {this.state.online
            ? "Соединение вернулось. Приложение автоматически перезапустится один раз."
            : "Приложение продолжит восстановление, когда интернет снова появится."}
        </p>
        <button className="primary-button" type="button" onClick={this.reloadNow}>
          Повторить сейчас
        </button>
      </main>
    );
  }
}
