import type { GuestLoyaltyTerms } from "../shared/loyalty-terms";
import type { PopupNotification } from "../server/types";
import { isLoyaltyPopup } from "./marketing";

export function guestPopups(popups: PopupNotification[], terms: GuestLoyaltyTerms | null, enabled: boolean, hasTable: boolean): PopupNotification[] {
  if (!enabled || !hasTable || !terms || popups.some(isLoyaltyPopup)) return popups;
  return [{
    id: "faj-welcome-gift", purpose: "loyalty", active: true, sort: 0, createdAt: "2026-09-30T00:00:00Z",
    title: `Дарим ${terms.welcomeAmount.toLocaleString("ru-RU")} бонусных рублей`,
    body: "За первую регистрацию в программе лояльности Faj. Подтвердите свой номер и получите карту — она работает в зале, на доставку и самовывоз.\n\nУже есть карта? Откроем её с вашим балансом. Повторный подарок не начисляется.",
    imageUrl: "", buttonText: "Получить карту и бонусы", buttonUrl: "/loyalty",
  }, ...popups];
}
