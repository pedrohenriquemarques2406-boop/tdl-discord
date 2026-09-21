import os
import json
import time
import asyncio
from typing import Dict, List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Discord Web Clone - TDL", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CHAT_FILE = os.path.join(BASE_DIR, "chat_history.json")
CONFIG_FILE = os.path.join(BASE_DIR, "server_config.json")
BRENO_FILE = os.path.join(BASE_DIR, "breno_sound.json")

# Versão estável da build (não gera F5 desnecessário ao reiniciar o servidor)
APP_BUILD_VERSION = "tdl-build-2026.09.21"

# Estado em Memória + Persistência em Disco
def load_json(filepath: str, default_val):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Erro ao carregar {filepath}: {e}")
    return default_val

def save_json(filepath: str, data):
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Erro ao salvar {filepath}: {e}")

chat_history: Dict[str, List[dict]] = load_json(CHAT_FILE, {
    "resenha-tdl": [],
    "rocket-league": [],
    "clipes-e-jogadas": [],
    "comandos": []
})

server_config: dict = load_json(CONFIG_FILE, {
    "server_name": "TDL — Tropa do Liro",
    "server_icon": "",
    "server_banner": "",
    "text_channels": ["resenha-tdl", "rocket-league", "clipes-e-jogadas", "comandos"],
    "voice_channels": ["Geral 🚀", "Rocket League 1", "Rocket League 2", "Tela & Resenha"],
    "roles": [
        {"id": "owner", "name": "Líder TDL", "color": "#f59e0b"},
        {"id": "mod", "name": "Moderador", "color": "#3b82f6"},
        {"id": "member", "name": "Tropa", "color": "#10b981"}
    ]
})

custom_join_sound: Optional[str] = load_json(BRENO_FILE, {"url": None}).get("url")

# Gerenciador de WebSockets e Estado de Voz
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.users: Dict[str, dict] = {}
        self.voice_channels: Dict[str, List[dict]] = {
            vc: [] for vc in server_config.get("voice_channels", ["Geral 🚀", "Tela & Resenha"])
        }

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        if client_id not in self.users:
            self.users[client_id] = {
                "id": client_id,
                "username": "TDL Member",
                "avatar": f"https://api.dicebear.com/7.x/bottts/svg?seed={client_id}",
                "bannerColor": "#f59e0b",
                "bannerImage": "",
                "bio": "Membro oficial da TDL 🚀",
                "role": "member",
                "state": {"isMuted": False, "isDeafened": False, "isScreenSharing": False, "isCameraOn": False}
            }

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
        # Remove de qualquer canal de voz
        for ch, members in self.voice_channels.items():
            self.voice_channels[ch] = [m for m in members if m["id"] != client_id]

    async def send_to_user(self, client_id: str, message: dict):
        ws = self.active_connections.get(client_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                pass

    async def broadcast(self, message: dict, exclude: Optional[str] = None):
        msg_str = json.dumps(message)
        dead_connections = []
        for cid, ws in self.active_connections.items():
            if exclude and cid == exclude:
                continue
            try:
                await ws.send_text(msg_str)
            except Exception:
                dead_connections.append(cid)
        for cid in dead_connections:
            self.disconnect(cid)

    def get_user_voice_channel(self, client_id: str) -> Optional[str]:
        for ch, members in self.voice_channels.items():
            if any(m["id"] == client_id for m in members):
                return ch
        return None

manager = ConnectionManager()

# Montagem de arquivos estáticos
if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/")
async def get_index():
    index_path = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return JSONResponse({"message": "TDL Discord API Online", "build": APP_BUILD_VERSION})

class SoundUploadRequest(BaseModel):
    audioData: str

@app.post("/api/upload-breno-sound")
async def upload_breno_sound(payload: SoundUploadRequest):
    global custom_join_sound
    custom_join_sound = payload.audioData
    save_json(BRENO_FILE, {"url": custom_join_sound})
    await manager.broadcast({
        "type": "custom_join_sound_updated",
        "url": custom_join_sound
    })
    return {"status": "ok", "message": "Som atualizado com sucesso"}

@app.post("/api/reload-all")
async def api_reload_all():
    await manager.broadcast({
        "type": "server_force_reload",
        "reason": "Atualização administrativa acionada."
    })
    return {"status": "ok"}

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)

    # 1. Enviar estado inicial completo
    server_state = {
        "serverConfig": server_config,
        "users": list(manager.users.values()),
        "voiceChannels": manager.voice_channels
    }
    await manager.send_to_user(client_id, {
        "type": "init_state",
        "buildTime": APP_BUILD_VERSION,
        "serverState": server_state,
        "history": chat_history,
        "customJoinSound": custom_join_sound
    })

    # Notificar outros usuários
    await manager.broadcast({
        "type": "user_status_changed",
        "user": manager.users[client_id]
    }, exclude=client_id)

    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                data = json.loads(raw_text)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            if msg_type == "update_profile":
                user = manager.users.get(client_id, {})
                user["username"] = data.get("username", user.get("username", "TDL"))
                user["avatar"] = data.get("avatar", user.get("avatar", ""))
                user["bannerColor"] = data.get("bannerColor", user.get("bannerColor", "#f59e0b"))
                user["bannerImage"] = data.get("bannerImage", user.get("bannerImage", ""))
                user["bio"] = data.get("bio", user.get("bio", ""))
                user["role"] = data.get("role", user.get("role", "member"))
                manager.users[client_id] = user

                await manager.broadcast({
                    "type": "user_updated",
                    "user": user
                })

            elif msg_type == "chat_message":
                channel = data.get("channel", "resenha-tdl")
                user = manager.users.get(client_id, {})
                msg_payload = {
                    "id": f"msg_{int(time.time() * 1000)}_{client_id[:4]}",
                    "channel": channel,
                    "userId": client_id,
                    "username": user.get("username", "TDL"),
                    "avatar": user.get("avatar", ""),
                    "text": data.get("text", ""),
                    "image": data.get("image"),
                    "isSticker": data.get("isSticker", False),
                    "stickerText": data.get("stickerText"),
                    "stickerBg": data.get("stickerBg"),
                    "timestamp": int(time.time() * 1000)
                }

                if channel not in chat_history:
                    chat_history[channel] = []
                chat_history[channel].append(msg_payload)
                # Manter últimas 200 mensagens por canal para performance
                if len(chat_history[channel]) > 200:
                    chat_history[channel] = chat_history[channel][-200:]
                
                # Salvar no disco para nunca perder histórico
                save_json(CHAT_FILE, chat_history)

                await manager.broadcast({
                    "type": "new_chat_message",
                    "message": msg_payload
                })

            elif msg_type == "join_voice":
                target_channel = data.get("channel")
                # Remove do canal anterior se estiver em algum
                for ch, members in manager.voice_channels.items():
                    manager.voice_channels[ch] = [m for m in members if m["id"] != client_id]

                user = manager.users.get(client_id, {})
                if target_channel not in manager.voice_channels:
                    manager.voice_channels[target_channel] = []
                
                existing_members = list(manager.voice_channels[target_channel])
                manager.voice_channels[target_channel].append(user)

                # Responde sucesso com membros já existentes na sala
                await manager.send_to_user(client_id, {
                    "type": "joined_voice_success",
                    "channel": target_channel,
                    "existingMembers": existing_members,
                    "customJoinSound": custom_join_sound
                })

                # Notifica os outros membros do canal
                await manager.broadcast({
                    "type": "user_joined_voice",
                    "channel": target_channel,
                    "user": user,
                    "customJoinSound": custom_join_sound
                }, exclude=client_id)

                # Atualiza badges de canais de voz
                await manager.broadcast({
                    "type": "server_voice_update",
                    "voiceChannels": manager.voice_channels
                })

            elif msg_type == "leave_voice":
                user_ch = manager.get_user_voice_channel(client_id)
                if user_ch and user_ch in manager.voice_channels:
                    manager.voice_channels[user_ch] = [m for m in manager.voice_channels[user_ch] if m["id"] != client_id]
                    await manager.broadcast({
                        "type": "user_left_voice",
                        "userId": client_id
                    })
                    await manager.broadcast({
                        "type": "server_voice_update",
                        "voiceChannels": manager.voice_channels
                    })

            elif msg_type == "webrtc_signal":
                target_id = data.get("targetId")
                signal = data.get("signal")
                user = manager.users.get(client_id, {})
                if target_id and signal:
                    await manager.send_to_user(target_id, {
                        "type": "webrtc_signal",
                        "senderId": client_id,
                        "senderUsername": user.get("username", "Membro"),
                        "signal": signal
                    })

            elif msg_type == "media_state":
                state = data.get("state", {})
                user = manager.users.get(client_id, {})
                if "state" not in user:
                    user["state"] = {}
                user["state"].update(state)
                manager.users[client_id] = user

                await manager.broadcast({
                    "type": "user_media_state",
                    "userId": client_id,
                    "state": state
                })

            elif msg_type == "speaking":
                is_speaking = data.get("isSpeaking", False)
                await manager.broadcast({
                    "type": "user_speaking",
                    "userId": client_id,
                    "isSpeaking": is_speaking
                }, exclude=client_id)

            elif msg_type == "trigger_reload_all":
                await manager.broadcast({
                    "type": "server_force_reload",
                    "reason": "Atualização forçada pela liderança da TDL."
                })

            elif msg_type == "update_server_config":
                new_cfg = data.get("serverConfig")
                if new_cfg:
                    server_config.update(new_cfg)
                    save_json(CONFIG_FILE, server_config)
                    await manager.broadcast({
                        "type": "server_config_updated",
                        "serverConfig": server_config,
                        "voiceChannels": manager.voice_channels
                    })

    except WebSocketDisconnect:
        user_ch = manager.get_user_voice_channel(client_id)
        manager.disconnect(client_id)
        if user_ch:
            await manager.broadcast({
                "type": "user_left_voice",
                "userId": client_id
            })
        await manager.broadcast({
            "type": "user_disconnected",
            "userId": client_id,
            "serverState": {
                "users": list(manager.users.values()),
                "voiceChannels": manager.voice_channels
            }
        })
    except Exception as e:
        print(f"Erro no websocket {client_id}: {e}")
        manager.disconnect(client_id)
