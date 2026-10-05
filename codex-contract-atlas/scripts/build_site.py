#!/usr/bin/env python3
"""Build the offline HTML from separately editable data and UI sources."""
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
data = json.loads((root/'data/mapping.json').read_text())
html = '''<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="description" content="Exploration sourcée des contrats OpenAI, du backend Codex et du runtime. Mapping, provenances, schémas et feuille de route."><title>Codex Contract Atlas</title><style>__CSS__</style></head>
<body><a href="#main" onclick="event.preventDefault();document.getElementById('main').focus()" style="position:absolute;left:-10000px" onfocus="this.style.left='10px'" onblur="this.style.left='-10000px'">Aller au contenu</a><aside class="sidebar" id="sidebar" aria-label="Navigation principale"></aside><div class="mobile-scrim" aria-hidden="true"></div><header class="topbar" id="topbar"></header><main class="main" id="main" tabindex="-1"></main><noscript>Ce site nécessite JavaScript. Les données restent disponibles dans data/mapping.json et data/mapping.csv dans l’archive.</noscript><script id="atlas-data" type="application/json">__DATA__</script><script>__SCHEMA__</script><script>__APP__</script></body></html>'''
html = html.replace('__CSS__',(root/'src/style.css').read_text())
html = html.replace('__DATA__',json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c'))
html = html.replace('__SCHEMA__',(root/'src/schema.js').read_text().replace('</script','<\\/script'))
html = html.replace('__APP__',(root/'src/app.js').read_text().replace('</script','<\\/script'))
(root/'index.html').write_text(html)
print('Built',len(html.encode()),'bytes;',len(data['entries']),'records')
