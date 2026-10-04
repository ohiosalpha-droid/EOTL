import base64
import json
import mimetypes
import os
import secrets
import uuid
from pathlib import Path

from authlib.integrations.starlette_client import OAuth
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import httpx
from openai import APIStatusError, AsyncOpenAI
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

load_dotenv()

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "bilder"
UPLOADS_DIR = DATA_DIR / "uploads"
for d in (IMAGES_DIR, UPLOADS_DIR):
    d.mkdir(parents=True, exist_ok=True)

GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"
USE_GEMINI = not os.getenv("OPENAI_API_KEY") and bool(os.getenv("GEMINI_API_KEY"))
CHAT_MODEL = os.getenv("EOTL_CHAT_MODEL", "gemini-flash-latest" if USE_GEMINI else "gpt-4o")
IMAGE_MODEL = os.getenv("EOTL_IMAGE_MODEL", "gemini-2.5-flash-image" if USE_GEMINI else "gpt-image-1")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_UPLOAD_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}

BASE_PROMPT = (
    "Du bist EOTL, ein vielseitiger KI-Assistent. Du antwortest standardmäßig auf Deutsch, "
    "freundlich, klar und präzise. Du kannst normale Gespräche führen, Fragen beantworten, "
    "Bilder analysieren, die der Nutzer hochlädt, und mit dem Werkzeug `bild_erstellen` neue "
    "Bilder generieren, wenn der Nutzer ein Bild, eine Grafik, ein Logo oder Ähnliches möchte. "
    "Formatiere Antworten mit Markdown. Code steht immer in Codeblöcken mit Sprachangabe. "
    "Verwende keine Emojis."
)

MODE_PROMPTS = {
    "chat": BASE_PROMPT,
    "code": BASE_PROMPT
    + (
        " Du bist jetzt im Coder-Modus: Du bist ein erfahrener Softwareentwickler. Schreibe "
        "vollständigen, lauffähigen und sauberen Code, erkläre kurz die Lösung, weise auf "
        "Fehlerquellen hin und schlage Tests vor. Frage nach, wenn Anforderungen unklar sind."
    ),
}

IMAGE_TOOL = {
    "type": "function",
    "function": {
        "name": "bild_erstellen",
        "description": "Erstellt ein neues Bild aus einer Beschreibung.",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Detaillierte Bildbeschreibung (am besten auf Englisch).",
                },
                "groesse": {
                    "type": "string",
                    "enum": ["1024x1024", "1536x1024", "1024x1536"],
                    "description": "Quadratisch, Querformat oder Hochformat.",
                },
            },
            "required": ["prompt"],
        },
    },
}

app = FastAPI(title="EOTL")

# ---------- Anmeldung ----------

PROVIDERS = {
    "google": {
        "label": "Google",
        "server_metadata_url": os.getenv(
            "EOTL_GOOGLE_METADATA_URL",
            "https://accounts.google.com/.well-known/openid-configuration",
        ),
        "client_kwargs": {"scope": "openid email profile"},
    },
    "github": {
        "label": "GitHub",
        "authorize_url": "https://github.com/login/oauth/authorize",
        "access_token_url": "https://github.com/login/oauth/access_token",
        "api_base_url": "https://api.github.com/",
        "client_kwargs": {"scope": "read:user user:email"},
    },
    "microsoft": {
        "label": "Microsoft",
        "authorize_url": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "access_token_url": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "api_base_url": "https://graph.microsoft.com/v1.0/",
        "client_kwargs": {"scope": "User.Read"},
    },
}

oauth = OAuth()
ENABLED_PROVIDERS: dict[str, str] = {}
for _name, _cfg in PROVIDERS.items():
    _id = os.getenv(f"{_name.upper()}_CLIENT_ID")
    _secret = os.getenv(f"{_name.upper()}_CLIENT_SECRET")
    if _id and _secret:
        _kwargs = {k: v for k, v in _cfg.items() if k != "label"}
        oauth.register(_name, client_id=_id, client_secret=_secret, **_kwargs)
        ENABLED_PROVIDERS[_name] = _cfg["label"]

DEMO_LOGIN = os.getenv("EOTL_DEMO_LOGIN", "").lower() in {"1", "true", "ja"}
ALLOWED_EMAILS = {
    e.strip().lower() for e in os.getenv("EOTL_ALLOWED_EMAILS", "").split(",") if e.strip()
}
BASE_URL = os.getenv("EOTL_BASE_URL", "").rstrip("/")
PUBLIC_PREFIXES = ("/login", "/auth/", "/static/", "/api/auth/")


def _session_secret() -> str:
    if os.getenv("EOTL_SESSION_SECRET"):
        return os.environ["EOTL_SESSION_SECRET"]
    path = DATA_DIR / ".session_secret"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48))
        path.chmod(0o600)
    return path.read_text().strip()


@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if request.session.get("user") or path.startswith(PUBLIC_PREFIXES):
        return await call_next(request)
    if path.startswith("/api/"):
        return JSONResponse({"detail": "Bitte zuerst anmelden."}, status_code=401)
    return RedirectResponse("/login")


app.add_middleware(
    SessionMiddleware,
    secret_key=_session_secret(),
    session_cookie="eotl_session",
    max_age=60 * 60 * 24 * 30,
    same_site="lax",
    https_only=BASE_URL.startswith("https://"),
)


def _login_error(text: str) -> RedirectResponse:
    return RedirectResponse(f"/login?fehler={text}")


@app.get("/api/auth/anbieter")
async def auth_providers():
    return {"anbieter": ENABLED_PROVIDERS, "demo": DEMO_LOGIN}


@app.get("/login")
async def login_page(request: Request):
    if request.session.get("user"):
        return RedirectResponse("/")
    return FileResponse(BASE_DIR / "static" / "login.html")


@app.get("/auth/demo")
async def auth_demo(request: Request):
    if not DEMO_LOGIN:
        raise HTTPException(status_code=404)
    request.session["user"] = {
        "id": "demo:1", "name": "Demo-Nutzer", "email": "demo@eotl.local", "bild": "", "anbieter": "demo",
    }
    return RedirectResponse("/")


@app.get("/auth/{provider}")
async def auth_start(provider: str, request: Request):
    client = oauth.create_client(provider) if provider in ENABLED_PROVIDERS else None
    if not client:
        raise HTTPException(status_code=404, detail="Unbekannter Anmeldeanbieter.")
    redirect_uri = (
        f"{BASE_URL}/auth/{provider}/callback"
        if BASE_URL
        else str(request.url_for("auth_callback", provider=provider))
    )
    return await client.authorize_redirect(request, redirect_uri)


async def _fetch_user(provider: str, client, token: dict) -> dict:
    if provider == "google":
        info = token.get("userinfo") or await client.userinfo(token=token)
        return {"sub": info["sub"], "name": info.get("name"), "email": info.get("email"),
                "bild": info.get("picture", ""), "verified": info.get("email_verified", False)}
    if provider == "github":
        info = (await client.get("user", token=token)).json()
        emails = (await client.get("user/emails", token=token)).json()
        primary = next((e for e in emails if isinstance(e, dict) and e.get("primary")), {})
        return {"sub": str(info["id"]), "name": info.get("name") or info.get("login"),
                "email": primary.get("email") or info.get("email"),
                "bild": info.get("avatar_url", ""), "verified": primary.get("verified", False)}
    info = (await client.get("me", token=token)).json()
    return {"sub": info["id"], "name": info.get("displayName"),
            "email": info.get("mail") or info.get("userPrincipalName"), "bild": "", "verified": True}


@app.get("/auth/{provider}/callback", name="auth_callback")
async def auth_callback(provider: str, request: Request):
    client = oauth.create_client(provider) if provider in ENABLED_PROVIDERS else None
    if not client:
        raise HTTPException(status_code=404, detail="Unbekannter Anmeldeanbieter.")
    try:
        token = await client.authorize_access_token(request)
        info = await _fetch_user(provider, client, token)
    except Exception:  # noqa: BLE001
        return _login_error("Anmeldung fehlgeschlagen. Bitte erneut versuchen.")
    email = (info.get("email") or "").lower()
    if ALLOWED_EMAILS and (email not in ALLOWED_EMAILS or not info.get("verified")):
        return _login_error("Dieses Konto ist für EOTL nicht freigeschaltet.")
    request.session["user"] = {
        "id": f"{provider}:{info['sub']}",
        "name": info.get("name") or email or "Nutzer",
        "email": email,
        "bild": info.get("bild") or "",
        "anbieter": provider,
    }
    return RedirectResponse("/")


@app.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/login")


@app.get("/api/me")
async def me(request: Request):
    return request.session["user"]


def get_client() -> AsyncOpenAI:
    if USE_GEMINI:
        return AsyncOpenAI(api_key=os.environ["GEMINI_API_KEY"], base_url=GEMINI_BASE_URL)
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Kein API-Key gesetzt. Bitte OPENAI_API_KEY oder GEMINI_API_KEY in der Datei .env eintragen.",
        )
    return AsyncOpenAI()


class Message(BaseModel):
    role: str
    content: str
    images: list[str] = []


class ChatRequest(BaseModel):
    messages: list[Message]
    mode: str = "chat"
    instructions: str = ""


class ImageRequest(BaseModel):
    prompt: str
    groesse: str = "1024x1024"


def _local_file(url: str) -> Path | None:
    for prefix, folder in (("/bilder/", IMAGES_DIR), ("/uploads/", UPLOADS_DIR)):
        if url.startswith(prefix):
            path = (folder / url[len(prefix):]).resolve()
            if path.parent == folder.resolve() and path.is_file():
                return path
    return None


def _to_openai_message(msg: Message) -> dict:
    if msg.role != "user" or not msg.images:
        return {"role": msg.role, "content": msg.content}
    parts: list[dict] = [{"type": "text", "text": msg.content or "Beschreibe dieses Bild."}]
    for url in msg.images:
        path = _local_file(url)
        if not path:
            continue
        mime = mimetypes.guess_type(path.name)[0] or "image/png"
        b64 = base64.b64encode(path.read_bytes()).decode()
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
    return {"role": "user", "content": parts}


async def _gemini_image(prompt: str, size: str) -> bytes:
    ratio = {"1536x1024": "3:2", "1024x1536": "2:3"}.get(size, "1:1")
    async with httpx.AsyncClient(timeout=120) as http:
        res = await http.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{IMAGE_MODEL}:generateContent",
            headers={"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": ratio}},
            },
        )
    if res.status_code == 429:
        raise RuntimeError(
            "Das Kontingent für Bilder ist aufgebraucht. Beim kostenlosen Gemini-Key ist die "
            "Bilderstellung nicht enthalten; dafür muss in Google AI Studio die Abrechnung aktiviert werden."
        )
    if res.status_code >= 400:
        raise RuntimeError(res.json().get("error", {}).get("message", res.text)[:300])
    for cand in res.json().get("candidates", []):
        for part in cand.get("content", {}).get("parts", []):
            if "inlineData" in part:
                return base64.b64decode(part["inlineData"]["data"])
    raise RuntimeError("Das Modell hat kein Bild zurückgegeben.")


def _error_text(exc: Exception) -> str:
    if isinstance(exc, APIStatusError):
        if exc.status_code == 429:
            return "Das Anfrage-Limit des API-Keys ist erreicht. Bitte kurz warten und erneut versuchen."
        if exc.status_code == 503:
            return "Das KI-Modell ist gerade überlastet. Bitte gleich noch einmal versuchen."
    return f"Fehler: {exc}"


async def generate_image(client: AsyncOpenAI, prompt: str, size: str) -> str:
    if size not in {"1024x1024", "1536x1024", "1024x1536"}:
        size = "1024x1024"
    name = f"{uuid.uuid4().hex}.png"
    if IMAGE_MODEL.startswith("gemini"):
        (IMAGES_DIR / name).write_bytes(await _gemini_image(prompt, size))
        return f"/bilder/{name}"
    if IMAGE_MODEL.startswith("imagen"):
        result = await client.images.generate(
            model=IMAGE_MODEL, prompt=prompt, response_format="b64_json", n=1
        )
    elif IMAGE_MODEL.startswith("dall-e-3"):
        size = {"1536x1024": "1792x1024", "1024x1536": "1024x1792"}.get(size, size)
        result = await client.images.generate(
            model=IMAGE_MODEL, prompt=prompt, size=size, response_format="b64_json"
        )
    else:
        result = await client.images.generate(model=IMAGE_MODEL, prompt=prompt, size=size)
    (IMAGES_DIR / name).write_bytes(base64.b64decode(result.data[0].b64_json))
    return f"/bilder/{name}"


def sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest):
    client = get_client()
    system = MODE_PROMPTS.get(req.mode, BASE_PROMPT)
    if req.instructions.strip():
        system += "\n\nProjekt-Anweisungen des Nutzers:\n" + req.instructions.strip()[:8000]
    messages = [{"role": "system", "content": system}] + [
        _to_openai_message(m) for m in req.messages[-40:]
    ]

    async def stream():
        try:
            response = await client.chat.completions.create(
                model=CHAT_MODEL, messages=messages, tools=[IMAGE_TOOL], stream=True
            )
            tool_calls: dict[int, dict] = {}
            async for chunk in response:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    yield sse({"type": "text", "text": delta.content})
                for tc in delta.tool_calls or []:
                    entry = tool_calls.setdefault(tc.index, {"name": "", "args": ""})
                    if tc.function and tc.function.name:
                        entry["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        entry["args"] += tc.function.arguments

            for call in tool_calls.values():
                if call["name"] != "bild_erstellen":
                    continue
                args = json.loads(call["args"] or "{}")
                prompt = args.get("prompt", "")
                yield sse({"type": "status", "text": "Erstelle Bild …"})
                url = await generate_image(client, prompt, args.get("groesse", "1024x1024"))
                yield sse({"type": "image", "url": url, "prompt": prompt})
        except Exception as exc:  # noqa: BLE001
            yield sse({"type": "error", "text": _error_text(exc)})
        yield sse({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/bild")
async def image(req: ImageRequest):
    client = get_client()
    try:
        url = await generate_image(client, req.prompt, req.groesse)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=_error_text(exc)) from exc
    return {"url": url, "prompt": req.prompt}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_UPLOAD_TYPES:
        raise HTTPException(status_code=400, detail="Nur PNG, JPEG, WEBP oder GIF erlaubt.")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Datei ist größer als 10 MB.")
    ext = mimetypes.guess_extension(file.content_type) or ".png"
    name = f"{uuid.uuid4().hex}{ext}"
    (UPLOADS_DIR / name).write_bytes(data)
    return {"url": f"/uploads/{name}"}


@app.get("/api/status")
async def status():
    return {
        "key_gesetzt": bool(os.getenv("OPENAI_API_KEY") or os.getenv("GEMINI_API_KEY")),
        "chat_modell": CHAT_MODEL,
        "bild_modell": IMAGE_MODEL,
    }


app.mount("/bilder", StaticFiles(directory=IMAGES_DIR), name="bilder")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index(request: Request):
    user = json.dumps(request.session["user"], ensure_ascii=False).replace("</", "<\\/")
    html = (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html.replace("<!--EOTL_USER-->", f"<script>window.EOTL_USER = {user};</script>"))
