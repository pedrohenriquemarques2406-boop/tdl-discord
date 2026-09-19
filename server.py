import sys
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
import os
import json
import asyncio
from typing import Dict, Any, Set
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI(title="Discord Web Clone - TDL")

# Diretório base
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_FILE = os.path.join(BASE_DIR, "server_config.json")

DEFAULT_CONFIG = {
    "server_name": "TDL — Tropa do Liro",
    "server_icon": "",
    "server_banner": "",
    "text_channels": [
        {"id": "resenha-tdl", "name": "resenha-tdl", "icon": "💬", "topic": "Resenha oficial da Tropa do Liro (TDL) 🚀⚽"},
        {"id": "rocket-league", "name": "rocket-league", "icon": "⚽", "topic": "Dicas, treinos e partidas de Rocket League"},
        {"id": "clipes-e-jogadas", "name": "clipes-e-jogadas", "icon": "🎥", "topic": "Mande prints, gols e jogadas épicas"},
        {"id": "comandos", "name": "comandos", "icon": "🤖", "topic": "Comandos e novidades do bot"}
    ],
    "voice_channels": [
        {"id": "rl-ranked", "name": "⚽ Rocket League 1 (Ranked)"},
        {"id": "rl-casual", "name": "⚽ Rocket League 2 (Casual)"},
        {"id": "stream-tela", "name": "🖥️ Transmissão & Tela"},
        {"id": "sala-vip", "name": "👑 Sala VIP da Tropa"}
    ],
    "roles": [
        {"id": "owner", "name": "👑 FUNDADOR", "color": "#f59e0b", "is_admin": True},
        {"id": "mod", "name": "🛡️ MODERADOR", "color": "#3b82f6", "is_admin": False},
        {"id": "pro", "name": "⚽ ROCKET PRO", "color": "#10b981", "is_admin": False},
        {"id": "member", "name": "🚀 MEMBRO TDL", "color": "#949ba4", "is_admin": False}
    ]
}

def load_server_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return DEFAULT_CONFIG.copy()

def save_server_config(cfg):
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"Erro ao salvar config: {e}")

server_config = load_server_config()

# Estado em memória
# clients: client_id -> { "ws": WebSocket, "username": str, "avatar": str, "banner_color": str, "bio": str, "role": str, "voice_channel": str | None, "state": dict }
clients: Dict[str, Dict[str, Any]] = {}
voice_channels: Dict[str, Set[str]] = {
    ch["name"]: set() for ch in server_config.get("voice_channels", [])
}

# Histórico recente de mensagens por canal de texto
message_history: Dict[str, list] = {
    ch["id"]: [] for ch in server_config.get("text_channels", [])
}
if "resenha-tdl" in message_history:
    message_history["resenha-tdl"].append({
        "id": "welcome-msg",
        "userId": "system",
        "username": "TDL Bot 🤖",
        "avatar": "https://api.dicebear.com/7.x/bottts/svg?seed=TDLBotRocket",
        "text": "🔥 Bem-vindos ao servidor oficial da **TDL — Tropa do Liro**! Conectem-se nos canais de Rocket League, transmitam suas partidas e compartilhem a tela pra resenha!",
        "timestamp": datetime.now().strftime("%H:%M"),
        "channel": "resenha-tdl"
    })

@app.get("/")
async def get_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# Montar arquivos estáticos
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

async def broadcast_all(message: dict):
    """Envia mensagem para todos os clientes conectados."""
    dead_clients = []
    for cid, client in clients.items():
        try:
            await client["ws"].send_text(json.dumps(message))
        except Exception:
            dead_clients.append(cid)
    for cid in dead_clients:
        clients.pop(cid, None)

async def broadcast_to_voice(channel: str, message: dict, exclude_id: str = None):
    """Envia mensagem para todos no canal de voz especificado."""
    if channel not in voice_channels:
        return
    for cid in list(voice_channels[channel]):
        if cid == exclude_id:
            continue
        client = clients.get(cid)
        if client and "ws" in client:
            try:
                await client["ws"].send_text(json.dumps(message))
            except Exception:
                pass

def get_server_state():
    """Retorna lista de usuários e canais para sincronização."""
    users_list = []
    for cid, data in clients.items():
        users_list.append({
            "id": cid,
            "username": data.get("username", "Anônimo"),
            "avatar": data.get("avatar", ""),
            "bannerColor": data.get("banner_color", "#f59e0b"),
            "bannerImage": data.get("banner_image", ""),
            "bio": data.get("bio", ""),
            "role": data.get("role", "member"),
            "voiceChannel": data.get("voice_channel"),
            "state": data.get("state", {})
        })
    
    voice_state = {ch: list(uids) for ch, uids in voice_channels.items()}
    return {
        "users": users_list,
        "voiceChannels": voice_state,
        "serverConfig": server_config
    }

import base64

# Som de entrada personalizado da Tropa (Grito do Breno)
def check_existing_sound():
    for ext in ["mp3", "wav", "webm", "ogg"]:
        p = os.path.join(STATIC_DIR, f"breno_scream.{ext}")
        if os.path.exists(p):
            return f"/static/breno_scream.{ext}"
    return None

custom_join_sound = check_existing_sound()

@app.post("/api/upload-breno-sound")
async def upload_breno_sound(payload: dict):
    global custom_join_sound
    data_url = payload.get("audioData")
    if not data_url:
        return {"success": False, "error": "Nenhum dado de áudio recebido"}

    try:
        if "," in data_url:
            header, b64data = data_url.split(",", 1)
            ext = "webm" if "webm" in header else ("mp3" if "mp3" in header else ("ogg" if "ogg" in header else "wav"))
        else:
            b64data = data_url
            ext = "webm"

        file_bytes = base64.b64decode(b64data)
        sound_filename = f"breno_scream.{ext}"
        sound_path = os.path.join(STATIC_DIR, sound_filename)
        with open(sound_path, "wb") as f:
            f.write(file_bytes)

        custom_join_sound = f"/static/{sound_filename}?v={int(datetime.now().timestamp())}"
        await broadcast_all({
            "type": "custom_join_sound_updated",
            "url": custom_join_sound
        })
        return {"success": True, "url": custom_join_sound}
    except Exception as e:
        return {"success": False, "error": str(e)}

SERVER_BUILD_TIME = datetime.now().strftime("%Y%m%d%H%M%S")

@app.post("/api/reload-all")
async def api_reload_all():
    await broadcast_all({
        "type": "server_force_reload",
        "reason": "Atualização geral acionada pelo servidor ⚡"
    })
    return {"success": True}

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    global custom_join_sound
    await websocket.accept()
    
    clients[client_id] = {
        "ws": websocket,
        "username": f"User_{client_id[:4]}",
        "avatar": f"https://api.dicebear.com/7.x/bottts/svg?seed={client_id}",
        "banner_color": "#f59e0b",
        "banner_image": "",
        "bio": "Membro da Tropa do Liro (TDL) 🚀",
        "role": "owner" if len(clients) == 0 else "member",
        "voice_channel": None,
        "state": {
            "isMuted": False,
            "isDeafened": False,
            "isScreenSharing": False,
            "isCamera": False
        }
    }
    
    try:
        # Envia estado inicial e histórico ao usuário recém conectado
        await websocket.send_text(json.dumps({
            "type": "init_state",
            "userId": client_id,
            "buildTime": SERVER_BUILD_TIME,
            "serverState": get_server_state(),
            "history": message_history,
            "customJoinSound": custom_join_sound
        }))

        # Notifica os outros usuários que alguém entrou
        await broadcast_all({
            "type": "user_status_changed",
            "user": {
                "id": client_id,
                "username": clients[client_id]["username"],
                "avatar": clients[client_id]["avatar"],
                "bannerColor": clients[client_id]["banner_color"],
                "bannerImage": clients[client_id].get("banner_image", ""),
                "bio": clients[client_id]["bio"],
                "role": clients[client_id]["role"],
                "voiceChannel": None,
                "state": clients[client_id]["state"]
            }
        })

        while True:
            data_text = await websocket.receive_text()
            data = json.loads(data_text)
            action = data.get("type")

            # 1. Configuração do perfil (nome / avatar / banner / bio / cargo)
            if action == "update_profile":
                username = data.get("username", "").strip() or f"User_{client_id[:4]}"
                avatar = data.get("avatar") or f"https://api.dicebear.com/7.x/bottts/svg?seed={username}"
                banner_color = data.get("bannerColor", "#f59e0b")
                banner_image = data.get("bannerImage", "")
                bio = data.get("bio", "").strip()
                role = data.get("role") or clients[client_id].get("role", "member")

                clients[client_id]["username"] = username
                clients[client_id]["avatar"] = avatar
                clients[client_id]["banner_color"] = banner_color
                clients[client_id]["banner_image"] = banner_image
                clients[client_id]["bio"] = bio
                clients[client_id]["role"] = role

                await broadcast_all({
                    "type": "user_updated",
                    "user": {
                        "id": client_id,
                        "username": username,
                        "avatar": avatar,
                        "bannerColor": banner_color,
                        "bannerImage": banner_image,
                        "bio": bio,
                        "role": role,
                        "voiceChannel": clients[client_id]["voice_channel"],
                        "state": clients[client_id]["state"]
                    }
                })

            # Ação de forçar atualização para todos os clientes
            elif action == "trigger_reload_all":
                username = clients.get(client_id, {}).get("username", "Admin")
                await broadcast_all({
                    "type": "server_force_reload",
                    "reason": f"Atualização aplicada por {username} 🚀"
                })

            # 1.1 Configurações Gerais do Servidor (Nome, Ícone, Banner)
            elif action == "update_server_settings":
                s_name = data.get("serverName", "").strip()
                s_icon = data.get("serverIcon")
                s_banner = data.get("serverBanner")
                if s_name:
                    server_config["server_name"] = s_name
                if s_icon is not None:
                    server_config["server_icon"] = s_icon
                if s_banner is not None:
                    server_config["server_banner"] = s_banner
                save_server_config(server_config)
                await broadcast_all({
                    "type": "server_config_updated",
                    "serverConfig": server_config
                })

            # 1.2 Criar Canal (Texto ou Voz)
            elif action == "create_channel":
                ch_type = data.get("channelType", "text")
                ch_name = data.get("name", "").strip()
                ch_icon = data.get("icon", "💬" if ch_type == "text" else "🔊")
                ch_topic = data.get("topic", "")

                if ch_name:
                    ch_id = ch_name.lower().replace(" ", "-")
                    if ch_type == "text":
                        if not any(c["id"] == ch_id for c in server_config["text_channels"]):
                            server_config["text_channels"].append({
                                "id": ch_id,
                                "name": ch_name,
                                "icon": ch_icon,
                                "topic": ch_topic
                            })
                            if ch_id not in message_history:
                                message_history[ch_id] = []
                    else:
                        if not any(c["name"] == ch_name for c in server_config["voice_channels"]):
                            server_config["voice_channels"].append({
                                "id": ch_id,
                                "name": ch_name
                            })
                            voice_channels[ch_name] = set()

                    save_server_config(server_config)
                    await broadcast_all({
                        "type": "server_config_updated",
                        "serverConfig": server_config,
                        "voiceChannels": {ch: list(uids) for ch, uids in voice_channels.items()}
                    })

            # 1.3 Deletar Canal
            elif action == "delete_channel":
                ch_type = data.get("channelType", "text")
                t_id = data.get("id")
                t_name = data.get("name")

                if ch_type == "text":
                    server_config["text_channels"] = [c for c in server_config["text_channels"] if c["id"] != t_id]
                else:
                    server_config["voice_channels"] = [c for c in server_config["voice_channels"] if c.get("id") != t_id and c.get("name") != t_name]
                    if t_name in voice_channels:
                        for uid in list(voice_channels[t_name]):
                            if uid in clients:
                                clients[uid]["voice_channel"] = None
                        voice_channels.pop(t_name, None)

                save_server_config(server_config)
                await broadcast_all({
                    "type": "server_config_updated",
                    "serverConfig": server_config,
                    "voiceChannels": {ch: list(uids) for ch, uids in voice_channels.items()}
                })

            # 1.4 Gerenciar Cargos / Roles
            elif action == "update_roles":
                new_roles = data.get("roles")
                if isinstance(new_roles, list) and len(new_roles) > 0:
                    server_config["roles"] = new_roles
                    save_server_config(server_config)
                    await broadcast_all({
                        "type": "server_config_updated",
                        "serverConfig": server_config
                    })

            # 2. Mensagem de chat de texto, imagens e figurinhas
            elif action == "chat_message":
                channel = data.get("channel", "resenha-tdl")
                text = data.get("text", "").strip()
                image = data.get("image")  # Suporte a colar fotos (Ctrl+V) ou upload
                is_sticker = data.get("isSticker", False)
                sticker_text = data.get("stickerText", "")
                sticker_bg = data.get("stickerBg", "")

                # Comando especial para atualizar a tela de todo mundo
                if text.lower() in ["/atualizar", "/update", "/att"]:
                    username = clients.get(client_id, {}).get("username", "Admin")
                    await broadcast_all({
                        "type": "server_force_reload",
                        "reason": f"Atualização geral acionada por {username} 🚀"
                    })
                    continue

                if text or image or is_sticker:
                    msg = {
                        "id": f"msg-{datetime.now().timestamp()}-{client_id[:4]}",
                        "userId": client_id,
                        "username": clients[client_id]["username"],
                        "avatar": clients[client_id]["avatar"],
                        "text": text,
                        "image": image,
                        "isSticker": is_sticker,
                        "stickerText": sticker_text,
                        "stickerBg": sticker_bg,
                        "timestamp": datetime.now().strftime("%H:%M"),
                        "channel": channel
                    }
                    if channel not in message_history:
                        message_history[channel] = []
                    message_history[channel].append(msg)
                    # Limita histórico aos últimos 100 itens
                    if len(message_history[channel]) > 100:
                        message_history[channel].pop(0)

                    await broadcast_all({
                        "type": "new_chat_message",
                        "message": msg
                    })

            # 3. Entrar em canal de voz
            elif action == "join_voice":
                new_channel = data.get("channel")
                old_channel = clients[client_id]["voice_channel"]

                # Se já estava em canal de voz, sai do anterior
                if old_channel and old_channel in voice_channels:
                    voice_channels[old_channel].discard(client_id)
                    await broadcast_to_voice(old_channel, {
                        "type": "user_left_voice",
                        "userId": client_id,
                        "channel": old_channel
                    })

                # Adiciona ao novo canal
                if new_channel and new_channel in voice_channels:
                    existing_members = [
                        {
                            "id": uid,
                            "username": clients[uid]["username"],
                            "avatar": clients[uid]["avatar"],
                            "state": clients[uid]["state"]
                        }
                        for uid in voice_channels[new_channel]
                        if uid in clients
                    ]
                    voice_channels[new_channel].add(client_id)
                    clients[client_id]["voice_channel"] = new_channel

                    # Envia para o usuário que entrou a lista de membros já existentes
                    await websocket.send_text(json.dumps({
                        "type": "joined_voice_success",
                        "channel": new_channel,
                        "existingMembers": existing_members,
                        "customJoinSound": custom_join_sound
                    }))

                    # Notifica os outros membros da sala que um novo usuário entrou
                    await broadcast_to_voice(new_channel, {
                        "type": "user_joined_voice",
                        "channel": new_channel,
                        "user": {
                            "id": client_id,
                            "username": clients[client_id]["username"],
                            "avatar": clients[client_id]["avatar"],
                            "state": clients[client_id]["state"]
                        },
                        "customJoinSound": custom_join_sound
                    }, exclude_id=client_id)

                    # Atualiza status global para todos no servidor
                    await broadcast_all({
                        "type": "server_voice_update",
                        "voiceChannels": {ch: list(uids) for ch, uids in voice_channels.items()}
                    })

            # 4. Sair do canal de voz
            elif action == "leave_voice":
                current_channel = clients[client_id]["voice_channel"]
                if current_channel and current_channel in voice_channels:
                    voice_channels[current_channel].discard(client_id)
                    clients[client_id]["voice_channel"] = None
                    clients[client_id]["state"]["isScreenSharing"] = False
                    clients[client_id]["state"]["isCamera"] = False

                    await broadcast_to_voice(current_channel, {
                        "type": "user_left_voice",
                        "userId": client_id,
                        "channel": current_channel
                    })

                    await websocket.send_text(json.dumps({
                        "type": "left_voice_success"
                    }))

                    await broadcast_all({
                        "type": "server_voice_update",
                        "voiceChannels": {ch: list(uids) for ch, uids in voice_channels.items()}
                    })

            # 5. Sinalização WebRTC (Offer, Answer, ICE Candidate)
            elif action == "webrtc_signal":
                target_id = data.get("targetId")
                signal_data = data.get("signal")
                media_type = data.get("mediaType", "audio") # "audio" | "screen" | "camera"
                if target_id and target_id in clients:
                    target_ws = clients[target_id].get("ws")
                    if target_ws:
                        await target_ws.send_text(json.dumps({
                            "type": "webrtc_signal",
                            "senderId": client_id,
                            "senderUsername": clients[client_id]["username"],
                            "signal": signal_data,
                            "mediaType": media_type
                        }))

            # 6. Atualização de estado de mídia (Mudo, Som desativado, Compartilhando tela, Câmera)
            elif action == "media_state":
                state = data.get("state", {})
                clients[client_id]["state"].update(state)
                ch = clients[client_id]["voice_channel"]
                if ch:
                    await broadcast_to_voice(ch, {
                        "type": "user_media_state",
                        "userId": client_id,
                        "state": clients[client_id]["state"]
                    })

            # 7. Indicador de fala (Speaking indicator)
            elif action == "speaking":
                is_speaking = data.get("isSpeaking", False)
                ch = clients[client_id]["voice_channel"]
                if ch:
                    await broadcast_to_voice(ch, {
                        "type": "user_speaking",
                        "userId": client_id,
                        "isSpeaking": is_speaking
                    }, exclude_id=client_id)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Erro no websocket {client_id}: {e}")
    finally:
        # Limpeza na desconexão
        current_ch = clients.get(client_id, {}).get("voice_channel")
        if current_ch and current_ch in voice_channels:
            voice_channels[current_ch].discard(client_id)
            await broadcast_to_voice(current_ch, {
                "type": "user_left_voice",
                "userId": client_id,
                "channel": current_ch
            })

        clients.pop(client_id, None)

        await broadcast_all({
            "type": "user_disconnected",
            "userId": client_id,
            "serverState": get_server_state()
        })

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port)
