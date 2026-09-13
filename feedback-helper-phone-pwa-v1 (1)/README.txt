Feedback Helper — PHONE PWA

Це саме веб/PWA для телефона.

Як працює:
- на телефоні: фото чека -> QR -> збережений пресет -> progress bar;
- на сервері: Playwright відкриває Qualtrics і проходить анкету у фоновому браузері;
- CORS на телефоні більше не заважає.

Деплой:
- проєкт має Dockerfile і railway.toml;
- підходить для Railway/Render/іншого Docker-хостингу;
- після деплою відкрий HTTPS-адресу з телефона та "Додати на головний екран".

Локальний запуск (не обов'язковий):
npm install
npx playwright install --with-deps chromium
npm start
