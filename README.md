# EOTL – dein eigener KI-Assistent

EOTL ist eine Web-App mit grün-schwarzem Design, die
- **chattet** (Antworten werden live gestreamt, Verlauf bleibt im Browser gespeichert),
- **programmiert** (eigene Kategorie „Code“ in der Seitenleiste, Syntax-Highlighting, Kopieren-Button),
- **Bilder erstellt** (Bild-Modus oder einfach im Chat „Mach mir ein Bild von …“),
- **Bilder versteht** (Bild über die Büroklammer anhängen und Fragen dazu stellen),
- **Projekte** verwaltet (eigene Anweisungen, die für alle Chats im Projekt gelten),
- eine **Anmeldung** verlangt (Google/Gmail, optional GitHub und Microsoft). Jeder Nutzer sieht nur seine eigenen Chats.

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
| `GEMINI_API_KEY` | Kostenlose Alternative, wenn kein OpenAI-Key gesetzt ist (https://aistudio.google.com/apikey). Chat-Modell `gemini-flash-latest`, Bilder mit `gemini-2.5-flash-image` (nur mit aktivierter Abrechnung) | – |
| `GEMINI_API_KEY` | Alternativ: kostenloser Google-Gemini-Key (aistudio.google.com/apikey), wird genutzt, wenn kein OpenAI-Key gesetzt ist | – |
| `EOTL_CHAT_MODEL` | Modell für Chat und Code | `gpt-4o` |
| `EOTL_IMAGE_MODEL` | Modell für Bilder (`gpt-image-1` oder `dall-e-3`) | `gpt-image-1` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google-Anmeldung | – |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub-Anmeldung (optional) | – |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Microsoft-Anmeldung (optional) | – |
| `EOTL_ALLOWED_EMAILS` | Kommagetrennte Liste erlaubter E-Mails; leer = jedes Konto | – |
| `EOTL_BASE_URL` | Öffentliche Adresse, z. B. `https://eotl.example.com` (für Weiterleitungs-URLs) | aus Anfrage |
| `EOTL_SESSION_SECRET` | Schlüssel für Login-Cookies | wird in `data/` erzeugt |
| `EOTL_DEMO_LOGIN` | `1` zeigt einen Demo-Zugang ohne Konto (nur zum Testen) | aus |

## Anmeldung einrichten

**Google:** In der [Google Cloud Console](https://console.cloud.google.com/apis/credentials) unter „APIs & Dienste“ → „Anmeldedaten“ eine OAuth-Client-ID vom Typ „Webanwendung“ anlegen.
Als autorisierte Weiterleitungs-URI `http://localhost:8000/auth/google/callback` eintragen (bzw. `<EOTL_BASE_URL>/auth/google/callback`).

**GitHub:** Unter Settings → Developer settings → OAuth Apps eine App anlegen, Callback-URL `<Adresse>/auth/github/callback`.

**Microsoft:** Im Azure-Portal eine App-Registrierung (Konten in beliebigen Verzeichnissen und persönliche Konten) anlegen, Umleitungs-URI `<Adresse>/auth/microsoft/callback`.

Ohne konfigurierten Anbieter zeigt die Anmeldeseite einen Hinweis und niemand kann sich anmelden.

Erstellte und hochgeladene Bilder landen im Ordner `data/`.
