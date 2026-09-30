import { useRef } from "react";
import { CircleHelp, X } from "lucide-react";
import type { GuestLoyaltyTerms } from "../shared/loyalty-terms";

export function LoyaltyInfo({ terms, reload }: { terms: GuestLoyaltyTerms | null; reload: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="loyalty-info-button" onClick={() => dialog.current?.showModal()}>
      <CircleHelp size={20} /> Как работают бонусы
    </button>
    <dialog ref={dialog} className="loyalty-info-dialog" aria-labelledby="loyalty-info-title"
      onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="loyalty-info-content">
        <div className="loyalty-info-heading">
          <h2 id="loyalty-info-title">Как работают бонусы</h2>
          <button type="button" className="icon-button" aria-label="Закрыть условия" onClick={() => dialog.current?.close()}><X size={22} /></button>
        </div>
        {terms ? terms.sections.map(section => <section key={section.title}>
          <h3>{section.title}</h3><p>{section.text}</p>
        </section>) : <>
          <p role="status">Условия пока не загрузились. Попробуйте ещё раз или уточните их у сотрудника до оплаты.</p>
          <button type="button" className="ghost-button" onClick={reload}>Загрузить условия</button>
        </>}
      </div>
    </dialog>
  </>;
}
