# EOTL – dein eigener KI-Assistent

EOTL ist eine Web-App mit grün-schwarzem Design, die
- **chattet** (Antworten werden live gestreamt, Verlauf bleibt im Browser gespeichert),
- **programmiert** (Coder-Modus, Syntax-Highlighting, Kopieren-Button),
- **Bilder erstellt** (Bild-Modus oder einfach im Chat „Mach mir ein Bild von …“),
- **Bilder versteht** (📎 Bild anhängen und Fragen dazu stellen).

Im Hintergrund nutzt EOTL die OpenAI-API (Standard: `gpt-4o` für den Chat, `gpt-image-1` für Bilder).

## Starten

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # OPENAI_API_KEY eintragen
uvicorn app:app --host 0.0.0.0 --port 8000
```

Danach im Browser http://localhost:8000 öffnen.

## Einstellungen (`.env`)

| Variable | Bedeutung | Standard |
|---|---|---|
| `OPENAI_API_KEY` | Dein OpenAI-API-Key | – |
| `EOTL_CHAT_MODEL` | Modell für Chat und Code | `gpt-4o` |
| `EOTL_IMAGE_MODEL` | Modell für Bilder (`gpt-image-1` oder `dall-e-3`) | `gpt-image-1` |

Erstellte und hochgeladene Bilder landen im Ordner `data/`.
