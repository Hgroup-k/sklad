# Склад: отдельная программа (GitHub Pages + Firebase)

- `index.html` собирается из `../sklad.html` командой `python3 build.py`. Код страницы общий с версией в Claude; `shim.js` подменяет `window.claude.use()` на Firebase (Firestore + вход Google).
- `firebase-config.js` — настройки проекта Firebase (не секрет).
- `firestore.rules` — правила базы: владелец (`access/main.owner`), `editors` вносят, `viewers` смотрят. Вставить в Firebase Console → Firestore → Rules.
- Первый вошедший становится владельцем (создаёт `access/main`).
- Раздел «Доступ» (кнопка в шапке у владельца): добавить почту, выбрать права; там же перенос данных из файла копии (.json).
- `make_snapshot.py` собирает файл копии из выгрузки базы артефакта.
- PWA: `manifest.webmanifest`, `sw.js`, `icons/`. Установка: Chrome/Edge → «Установить», iPhone Safari → «На экран Домой».
