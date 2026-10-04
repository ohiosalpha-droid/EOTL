import base64
import json
import mimetypes
import os
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from pydantic import BaseModel

load_dotenv()

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
IMAGES_DIR = DATA_DIR / "bilder"
UPLOADS_DIR = DATA_DIR / "uploads"
for d in (IMAGES_DIR, UPLOADS_DIR):
    d.mkdir(parents=True, exist_ok=True)

CHAT_MODEL = os.getenv("EOTL_CHAT_MODEL", "gpt-4o")
IMAGE_MODEL = os.getenv("EOTL_IMAGE_MODEL", "gpt-image-1")
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


def get_client() -> AsyncOpenAI:
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(
            status_code=503,
            detail="Kein OPENAI_API_KEY gesetzt. Bitte in der Datei .env eintragen.",
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


async def generate_image(client: AsyncOpenAI, prompt: str, size: str) -> str:
    if size not in {"1024x1024", "1536x1024", "1024x1536"}:
        size = "1024x1024"
    if IMAGE_MODEL.startswith("dall-e-3"):
        size = {"1536x1024": "1792x1024", "1024x1536": "1024x1792"}.get(size, size)
        result = await client.images.generate(
            model=IMAGE_MODEL, prompt=prompt, size=size, response_format="b64_json"
        )
    else:
        result = await client.images.generate(model=IMAGE_MODEL, prompt=prompt, size=size)
    name = f"{uuid.uuid4().hex}.png"
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
            yield sse({"type": "error", "text": f"Fehler: {exc}"})
        yield sse({"type": "done"})

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/bild")
async def image(req: ImageRequest):
    client = get_client()
    try:
        url = await generate_image(client, req.prompt, req.groesse)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Fehler: {exc}") from exc
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
        "key_gesetzt": bool(os.getenv("OPENAI_API_KEY")),
        "chat_modell": CHAT_MODEL,
        "bild_modell": IMAGE_MODEL,
    }


app.mount("/bilder", StaticFiles(directory=IMAGES_DIR), name="bilder")
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    return FileResponse(BASE_DIR / "static" / "index.html")
