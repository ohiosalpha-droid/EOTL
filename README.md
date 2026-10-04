# EOTL – dein eigener KI-Assistent

EOTL ist eine Web-App mit grün-schwarzem Design, die
- **chattet** (Antworten werden live gestreamt, Verlauf bleibt im Browser gespeichert),
- **programmiert** (eigene Kategorie „Code“ in der Seitenleiste, Syntax-Highlighting, Kopieren-Button),
- **Bilder erstellt** (Bild-Modus oder einfach im Chat „Mach mir ein Bild von …“),
- **Bilder versteht** (Bild über die Büroklammer anhängen und Fragen dazu stellen),
- **Projekte** verwaltet (eigene Anweisungen, die für alle Chats im Projekt gelten),
- eine **Anmeldung** mit Name und gemeinsamem Zugangscode verlangt. Jeder Nutzer sieht nur seine eigenen Chats.

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
| `GEMINI_API_KEY` | Alternativ: kostenloser Google-Gemini-Key (aistudio.google.com/apikey), wird genutzt, wenn kein OpenAI-Key gesetzt ist. Chat mit `gemini-flash-latest`, Bilder mit `gemini-2.5-flash-image` (nur mit aktivierter Abrechnung) | – |
| `EOTL_CHAT_MODEL` | Modell für Chat und Code | `gpt-4o` |
| `EOTL_IMAGE_MODEL` | Modell für Bilder (`gpt-image-1` oder `dall-e-3`) | `gpt-image-1` |
| `EOTL_ZUGANGSCODE` | Gemeinsamer Zugangscode für die Anmeldung; ohne Code kann sich niemand anmelden | – |
| `EOTL_BASE_URL` | Öffentliche Adresse, z. B. `https://eotl.example.com` (Cookies nur über HTTPS, wenn sie mit `https://` beginnt) | – |
| `EOTL_SESSION_SECRET` | Schlüssel für Login-Cookies | wird in `data/` erzeugt |

## Anmeldung

Auf der Anmeldeseite gibt man seinen Namen und den Zugangscode aus `EOTL_ZUGANGSCODE` ein. Gib den Code nur an Leute weiter, die EOTL benutzen dürfen, denn alle nutzen denselben KI-Key. Chats, Projekte und Bilder werden pro Name getrennt im Browser gespeichert.

Erstellte und hochgeladene Bilder landen im Ordner `data/`.
