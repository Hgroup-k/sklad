"""Собирает отдельную версию склада: standalone/index.html из ../sklad.html (исходник артефакта).
Запуск: python3 build.py. Код страницы не меняется: shim.js подменяет window.claude на Firebase."""
import re, pathlib
here = pathlib.Path(__file__).parent
src = ((here / 'sklad-artifact.html') if (here / 'sklad-artifact.html').exists() else (here.parent / 'sklad.html')).read_text(encoding='utf8')
# убрать обёртку артефакта, если она есть
src = re.sub(r'^<!doctype html><html><head>.*?</head><body>\n?', '', src, count=1, flags=re.S)
src = re.sub(r'\n?</body></html>\s*$', '', src)
src = src.replace('<title>Складской учёт</title>\n', '', 1)
src = src.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '', 1)
# кнопка установки Claude-версии здесь не нужна
src = src.replace('<button type="button" class="ghost" id="install-app" hidden style="font-size:12px;padding:4px 10px;margin-left:4px">Установить как программу</button>', '')
V = '10.12.2'
head = f'''<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Складской учёт</title>
<meta name="theme-color" content="#2e6a6c">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Склад">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<style>body{{margin:0}}
#auth-gate{{position:fixed;inset:0;z-index:50;background:var(--bg,#f4f6f6);display:grid;place-items:center;padding:16px}}
#sa-access{{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.35);display:grid;place-items:center;padding:16px;overflow:auto}}
.ag-card{{background:var(--surface,#fff);border:1px solid var(--line,#d9e0e1);border-radius:10px;padding:24px;max-width:420px;width:100%;text-align:center;display:grid;gap:12px;font-family:Inter,system-ui,sans-serif}}
.ag-card p{{margin:0}}
#sa-bar{{display:inline-flex;gap:6px;align-items:center;margin-left:8px}}
.sa-t th,.sa-t td{{padding:6px 5px!important}}
.sa-b{{font-size:12px!important;padding:4px 10px!important}}
</style>
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-app-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-auth-compat.js"></script>
<script src="https://www.gstatic.com/firebasejs/{V}/firebase-firestore-compat.js"></script>
<script src="firebase-config.js"></script>
<script src="shim.js"></script>
</head><body>
'''
out = head + src + '\n</body></html>\n'
(here / 'index.html').write_text(out, encoding='utf8')
print('index.html', len(out))
