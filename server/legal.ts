import { createHash } from "node:crypto";

export const PERSONAL_DATA_CONSENT_VERSION = "2026-07-10-v1";
export const PERSONAL_DATA_CONSENT_PATH = "/legal/personal-data-consent";
export const MARKETING_CONSENT_PATH = "/legal/marketing-consent";
export const PRIVACY_POLICY_URL = "https://fajfood.ru/privacy";

export const PERSONAL_DATA_CONSENT_TEXT = `
Согласие на обработку персональных данных

Я свободно, своей волей и в своем интересе даю Индивидуальному предпринимателю Магомедову Хирамагомеду Гаджиевичу, ИНН 055200298875, ОГРНИП 324050000027152, адрес: 414000, г. Астрахань, ул. Максима Горького, д. 29а, согласие на обработку моих персональных данных.

Перечень данных: имя, номер телефона, дата рождения (если указана), сведения об участии в программе лояльности, номер карты гостя, бонусный баланс, история начисления и списания бонусов, а также технические сведения о подтверждении согласия: дата и время, IP-адрес, сведения о браузере и версия текста согласия.

Цели обработки: регистрация и идентификация в программе лояльности Faj, выпуск цифровой карты, начисление и списание бонусов, отображение баланса, предотвращение повторных начислений и злоупотреблений, обработка обращений и исполнение требований законодательства.

Разрешенные действия: сбор, запись, систематизация, накопление, хранение, уточнение, извлечение, использование, сопоставление, передача в информационные системы CRM и iiko в объеме, необходимом для работы программы лояльности, обезличивание, блокирование и удаление. Обработка может выполняться с использованием средств автоматизации и без них.

Согласие действует до достижения целей обработки или до его отзыва. Отозвать согласие и запросить сведения, исправление или удаление данных можно по адресу faj_food@mail.ru. Отзыв не влияет на законность обработки, выполненной до его получения, и не прекращает обработку, для которой у оператора имеются иные законные основания.

Политика обработки персональных данных опубликована по адресу https://fajfood.ru/privacy.
`.trim();

export const MARKETING_CONSENT_TEXT = `
Согласие на получение информационных и рекламных сообщений

Я даю Индивидуальному предпринимателю Магомедову Хирамагомеду Гаджиевичу согласие направлять мне сообщения о бонусах, акциях и специальных предложениях по указанному номеру телефона и через подключенные мессенджеры.

Согласие является добровольным и не требуется для участия в программе лояльности. Отказаться от сообщений можно через обращение по адресу faj_food@mail.ru или способом, указанным в полученном сообщении.
`.trim();

export const PERSONAL_DATA_CONSENT_HASH = createHash("sha256")
  .update(PERSONAL_DATA_CONSENT_TEXT, "utf8")
  .digest("hex");

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderLegalDocument(title: string, text: string) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;background:#120f17;color:#fffdfa;font:16px/1.55 system-ui,-apple-system,sans-serif}
    main{max-width:760px;margin:0 auto;padding:32px 20px 64px}
    h1{font-size:28px;line-height:1.2;letter-spacing:0;margin:0 0 24px}
    p{margin:0 0 18px;color:rgba(255,253,250,.78)}
    a{color:#e3b86f} .meta{font-size:13px;color:rgba(255,253,250,.5)}
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${paragraphs}<p class="meta">Версия: ${PERSONAL_DATA_CONSENT_VERSION}</p></main></body>
</html>`;
}
