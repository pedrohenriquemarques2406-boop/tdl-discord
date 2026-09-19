// DC Web — Cliente JavaScript (Chat, Voz & Compartilhamento de Tela WebRTC)

// Configurações e Estado (Multi-STUN para garantir conexão com qualquer provedor)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  iceCandidatePoolSize: 10
};

let myId = localStorage.getItem('dc_user_id');
if (!myId) {
  myId = 'user_' + Math.random().toString(36).substring(2, 9);
  localStorage.setItem('dc_user_id', myId);
}

let myUsername = localStorage.getItem('dc_username') || 'TDL';
let myAvatarStyle = localStorage.getItem('dc_avatar_style') || 'bottts';
let myCustomAvatar = localStorage.getItem('dc_custom_avatar');
let myAvatar = myCustomAvatar || `https://api.dicebear.com/7.x/${myAvatarStyle}/svg?seed=${myUsername}`;
let myBannerColor = localStorage.getItem('dc_banner_color') || '#f59e0b';
let myBannerImage = localStorage.getItem('dc_banner_image') || '';
let myBio = localStorage.getItem('dc_bio') || 'Membro oficial da TDL 🚀';
let myRole = localStorage.getItem('dc_role') || 'owner';

let serverConfig = {
  server_name: "TDL — Tropa do Liro",
  server_icon: "",
  server_banner: "",
  text_channels: [],
  voice_channels: [],
  roles: []
};

let ws = null;
let currentTextChannel = 'resenha-tdl';
let currentVoiceChannel = null;

// Áudio e Vídeo Locais
let rawMicStream = null;
let localAudioStream = null; // Stream processado com Portão de Ruído e Filtro Anti-Ventilador
let localScreenStream = null;
let localCameraStream = null;
let isMuted = false;
let isDeafened = false;
let isScreenSharing = false;
let isCameraOn = false;

// Audio Pipeline Nodes (Noise Gate & DSP)
let audioCtx = null;
let micSourceNode = null;
let highpassNode = null;
let gateGainNode = null;
let micAnalyser = null;
let audioDestinationNode = null;
let isGateOpen = false;
let gateHoldTimeout = null;
let speakingCheckInterval = null;
let wasSpeaking = false;
let autoNoiseFloor = 10;
let userGateThreshold = parseInt(localStorage.getItem('dc_gate_threshold') || '18', 10);
let isAutoGate = localStorage.getItem('dc_auto_gate') !== 'false';
let isHighpassOn = localStorage.getItem('dc_highpass') !== 'false';
let isTypingCancelOn = localStorage.getItem('dc_typing_cancel') !== 'false';
let isTestingMic = false;
let testMicStream = null;

// Som de Entrada Customizado (Grito do Breno)
let customJoinSoundUrl = null;
let brenoRecorder = null;
let brenoRecordChunks = [];
let isRecordingBreno = false;

// Conexões WebRTC Mesh: peerId -> { pc, stream, remoteAudioEl }
const peerConnections = {};

// Histórico local de mensagens e membros
const channelMessages = {
  'resenha-tdl': [],
  'rocket-league': [],
  'clipes-e-jogadas': [],
  'comandos': []
};
let serverUsers = [];

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  updateMyProfileUI();
  connectWebSocket();
});

// Reproduzir Chimes de Áudio estilo Discord via Web Audio Sintetizado
function playDiscordSound(type = 'join') {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === 'join') {
      // Tom duplo agradável estilo Discord Connect (D5 -> G5)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(783.99, now + 0.12); // G5
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'leave') {
      // Tom descendente Discord Disconnect (G5 -> D5)
      osc.type = 'sine';
      osc.frequency.setValueAtTime(783.99, now);
      osc.frequency.setValueAtTime(587.33, now + 0.12);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'message') {
      // Som suave de mensagem nova
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(800, now);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
      osc.start(now);
      osc.stop(now + 0.15);
    }
  } catch (e) {
    console.warn("Audio Context error:", e);
  }
}

// ----------------------------------------------------
// 1. WEBSOCKET & SINALIZAÇÃO
// ----------------------------------------------------
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/${myId}`;
  
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    document.getElementById('wsIndicator').innerHTML = `
      <span class="w-2 h-2 rounded-full bg-[#23a55a]"></span>
      <span>Conectado</span>
    `;
    // Envia perfil atual completo
    sendWS({
      type: 'update_profile',
      username: myUsername,
      avatar: myAvatar,
      bannerColor: myBannerColor,
      bannerImage: myBannerImage,
      bio: myBio,
      role: myRole
    });
  };

  ws.onmessage = async (event) => {
    const data = JSON.parse(event.data);

    switch (data.type) {
      case 'init_state':
        handleInitState(data);
        break;

      case 'server_config_updated':
        serverConfig = data.serverConfig;
        applyServerConfigUI();
        if (data.voiceChannels) updateVoiceBadges(data.voiceChannels);
        break;

      case 'user_status_changed':
      case 'user_updated':
        updateOrAddUser(data.user);
        renderMemberList();
        break;

      case 'user_disconnected':
        handleUserDisconnected(data.userId, data.serverState);
        break;

      case 'new_chat_message':
        handleNewChatMessage(data.message);
        break;

      case 'server_voice_update':
        updateVoiceBadges(data.voiceChannels);
        break;

      case 'server_force_reload':
        showUpdateToastAndReload(data.reason || "⚡ Nova atualização da TDL disponível!");
        break;

      case 'custom_join_sound_updated':
        customJoinSoundUrl = data.url;
        updateBrenoSoundUI();
        break;

      case 'joined_voice_success':
        if (data.customJoinSound) customJoinSoundUrl = data.customJoinSound;
        await handleJoinedVoiceSuccess(data.channel, data.existingMembers);
        break;

      case 'user_joined_voice':
        if (data.customJoinSound) customJoinSoundUrl = data.customJoinSound;
        await handleUserJoinedVoice(data.user, data.channel);
        break;

      case 'user_left_voice':
        handleUserLeftVoice(data.userId);
        break;

      case 'webrtc_signal':
        await handleWebRTCSignal(data);
        break;

      case 'user_media_state':
        handleRemoteMediaState(data.userId, data.state);
        break;

      case 'user_speaking':
        handleRemoteSpeaking(data.userId, data.isSpeaking);
        break;
    }
  };

  ws.onclose = () => {
    document.getElementById('wsIndicator').innerHTML = `
      <span class="w-2 h-2 rounded-full bg-[#da373c]"></span>
      <span class="text-[#da373c]">Reconectando...</span>
    `;
    setTimeout(connectWebSocket, 2500);
  };
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ----------------------------------------------------
// 2. ESTADO INICIAL E CHAT
// ----------------------------------------------------
function handleInitState(data) {
  // Verificação de Atualização Automática (Hot Sync sem F5)
  if (data.buildTime) {
    if (!window._tdlBuildTime) {
      window._tdlBuildTime = data.buildTime;
    } else if (window._tdlBuildTime !== data.buildTime) {
      showUpdateToastAndReload("🚀 Nova atualização do servidor detectada! Sincronizando...");
      return;
    }
  }

  if (data.serverState && data.serverState.serverConfig) {
    serverConfig = data.serverState.serverConfig;
    applyServerConfigUI();
  }

  serverUsers = data.serverState.users || [];
  renderMemberList();
  updateVoiceBadges(data.serverState.voiceChannels);

  if (data.customJoinSound) {
    customJoinSoundUrl = data.customJoinSound;
  }
  updateBrenoSoundUI();

  if (data.history) {
    for (const [ch, msgs] of Object.entries(data.history)) {
      channelMessages[ch] = msgs;
    }
    renderMessages();
  }
}

function switchTextChannel(channelName) {
  currentTextChannel = channelName;
  document.getElementById('currentChannelTitle').textContent = channelName;
  document.getElementById('chatInput').placeholder = `Conversar em #${channelName}`;

  // Atualizar visual dos botões
  ['resenha-tdl', 'rocket-league', 'clipes-e-jogadas', 'comandos'].forEach(ch => {
    const btn = document.getElementById(`chan-${ch}`);
    if (btn) {
      if (ch === channelName) {
        btn.className = 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-white bg-[#404249] font-medium text-sm transition';
      } else {
        btn.className = 'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[#949ba4] hover:text-[#dbdee1] font-medium text-sm hover:bg-[#35373c] transition';
      }
    }
  });

  renderMessages();
}

let pendingAttachedImage = null;

// Capturar colagem de imagem (Ctrl+V) em qualquer lugar da tela
window.addEventListener('paste', (e) => {
  const items = (e.clipboardData || window.clipboardData).items;
  if (!items) return;
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image') !== -1) {
      const blob = items[i].getAsFile();
      const reader = new FileReader();
      reader.onload = (event) => {
        setAttachedImage(event.target.result);
      };
      reader.readAsDataURL(blob);
      e.preventDefault();
      break;
    }
  }
});

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file && file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      setAttachedImage(e.target.result);
    };
    reader.readAsDataURL(file);
  }
}

function setAttachedImage(dataUrl) {
  pendingAttachedImage = dataUrl;
  const tray = document.getElementById('imagePreviewTray');
  const previewImg = document.getElementById('imagePreviewImg');
  if (tray && previewImg) {
    previewImg.src = dataUrl;
    tray.classList.remove('hidden');
  }
  document.getElementById('chatInput').focus();
  lucide.createIcons();
}

function clearAttachedImage() {
  pendingAttachedImage = null;
  const tray = document.getElementById('imagePreviewTray');
  const previewImg = document.getElementById('imagePreviewImg');
  const fileInput = document.getElementById('imageFileInput');
  if (tray) tray.classList.add('hidden');
  if (previewImg) previewImg.src = '';
  if (fileInput) fileInput.value = '';
}

function openImageModal(src) {
  const modal = document.getElementById('imageModal');
  const img = document.getElementById('imageModalImg');
  if (modal && img) {
    img.src = src;
    modal.classList.remove('hidden');
    lucide.createIcons();
  }
}

function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (modal) modal.classList.add('hidden');
}

function handleSendMessage(event) {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  const imgToSend = pendingAttachedImage;

  if (!text && !imgToSend) return;

  sendWS({
    type: 'chat_message',
    channel: currentTextChannel,
    text: text,
    image: imgToSend
  });

  input.value = '';
  clearAttachedImage();
}

function handleNewChatMessage(msg) {
  if (!channelMessages[msg.channel]) {
    channelMessages[msg.channel] = [];
  }
  channelMessages[msg.channel].push(msg);

  if (msg.channel === currentTextChannel) {
    appendMessageUI(msg);
    playDiscordSound('message');
  }
}

function renderMessages() {
  const container = document.getElementById('messagesContainer');
  container.innerHTML = '';
  const msgs = channelMessages[currentTextChannel] || [];

  if (msgs.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-[#949ba4] space-y-2 py-12">
        <div class="w-16 h-16 rounded-full bg-[#2b2d31] flex items-center justify-center text-amber-400">
          <i data-lucide="message-square" class="w-8 h-8"></i>
        </div>
        <h2 class="text-xl font-bold text-white">Bem-vindo a #${currentTextChannel}!</h2>
        <p class="text-sm">Este é o começo da resenha da TDL em #${currentTextChannel}.</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  msgs.forEach(msg => appendMessageUI(msg, false));
  container.scrollTop = container.scrollHeight;
  lucide.createIcons();
}

function toggleStickerDrawer() {
  const drawer = document.getElementById('stickerDrawer');
  if (drawer) {
    drawer.classList.toggle('hidden');
    lucide.createIcons();
  }
}

function sendSticker(text, bgGradient) {
  sendWS({
    type: 'chat_message',
    channel: currentTextChannel,
    text: text,
    isSticker: true,
    stickerText: text,
    stickerBg: bgGradient
  });
  toggleStickerDrawer();
  playDiscordSound('message');
}

function appendMessageUI(msg, scrollToBottom = true) {
  const container = document.getElementById('messagesContainer');
  const isMe = msg.userId === myId;

  const div = document.createElement('div');
  div.className = 'flex gap-3 hover:bg-[#2e3035] -mx-4 px-4 py-1.5 rounded transition group';

  const user = serverUsers.find(u => u.id === msg.userId) || { username: msg.username, role: isMe ? myRole : 'member' };
  const userRole = getRoleForUser(user);
  const isBot = msg.userId === 'system';
  const nameColor = isBot ? '#5865f2' : (userRole ? userRole.color : '#dbdee1');
  const roleBadge = isBot 
    ? '<span class="bg-[#5865f2] text-white text-[10px] font-bold px-1.5 py-0.5 rounded">BOT</span>'
    : (userRole ? `<span class="role-pill" style="background-color: ${userRole.color}">${escapeHtml(userRole.name)}</span>` : '');

  const imageHtml = msg.image ? `
    <div class="mt-2">
      <img src="${msg.image}" onclick="openImageModal('${msg.image}')" alt="Foto colada" class="max-h-72 max-w-sm rounded-lg object-contain cursor-pointer hover:opacity-95 transition border border-[#3f4147] shadow-lg bg-black/20">
    </div>
  ` : '';

  const stickerHtml = msg.isSticker ? `
    <div class="mt-2 inline-block">
      <div class="bg-gradient-to-r ${msg.stickerBg || 'from-amber-600 to-orange-500'} text-white font-extrabold text-sm py-2 px-4 rounded-xl shadow-lg border border-white/20 flex items-center gap-2 transform hover:scale-105 transition-all">
        <span>${escapeHtml(msg.stickerText || msg.text)}</span>
      </div>
    </div>
  ` : '';

  div.innerHTML = `
    <img src="${msg.avatar}" onclick="openUserProfilePopout('${msg.userId}', event)" alt="${msg.username}" class="w-10 h-10 rounded-full bg-[#1e1f22] flex-shrink-0 mt-0.5 object-cover cursor-pointer hover:opacity-85 transition">
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2">
        <span onclick="openUserProfilePopout('${msg.userId}', event)" class="font-bold text-sm hover:underline cursor-pointer" style="color: ${nameColor}">
          ${escapeHtml(msg.username)}
        </span>
        ${roleBadge}
        <span class="text-[11px] text-[#949ba4] ml-1">${msg.timestamp}</span>
      </div>
      ${msg.text && !msg.isSticker ? `
      <div class="text-sm text-[#dbdee1] break-words selectable mt-0.5 leading-relaxed">
        ${formatMessageContent(msg.text)}
      </div>` : ''}
      ${stickerHtml}
      ${imageHtml}
    </div>
  `;

  container.appendChild(div);
  if (scrollToBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function formatMessageContent(text) {
  let escaped = escapeHtml(text);
  // URLs clicáveis
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  escaped = escaped.replace(urlRegex, url => `<a href="${url}" target="_blank" rel="noopener noreferrer" class="text-[#00a8fc] hover:underline">${url}</a>`);
  return escaped;
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function insertQuickEmoji(emoji) {
  const input = document.getElementById('chatInput');
  input.value += emoji;
  input.focus();
}

// ----------------------------------------------------
// 3. CANAIS DE VOZ & WEBRTC
// ----------------------------------------------------
async function toggleJoinVoice(channelName) {
  if (currentVoiceChannel === channelName) {
    leaveVoiceChannel();
    return;
  }
  await joinVoiceChannel(channelName);
}

async function joinVoiceChannel(channelName) {
  if (currentVoiceChannel) {
    leaveVoiceChannel(false);
  }

  currentVoiceChannel = channelName;
  playDiscordSound('join');
  setTimeout(playBrenoEntranceSound, 300);

  // Adquirir Microfone local com Supressão Avançada Anti-Ruído, Anti-Ventilador e Anti-Teclado
  try {
    isHighpassOn = localStorage.getItem('dc_highpass') !== 'false';
    isTypingCancelOn = localStorage.getItem('dc_typing_cancel') !== 'false';

    rawMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1, // Mono obrigatório para melhor beamforming e cancelamento de ruído
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        googEchoCancellation: true,
        googAutoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: isHighpassOn,
        googTypingNoiseDetection: isTypingCancelOn,
        googAudioMirroring: false
      },
      video: false
    });
    setupAudioProcessingPipeline(rawMicStream);
  } catch (err) {
    console.warn("Sem microfone detectado ou permissão negada:", err);
    rawMicStream = null;
    localAudioStream = null;
  }

  // Notificar o servidor
  sendWS({
    type: 'join_voice',
    channel: channelName
  });

  // Atualizar UI
  document.getElementById('voiceConnectedPanel').classList.remove('hidden');
  document.getElementById('connectedVoiceName').textContent = channelName;
  document.getElementById('voiceStage').classList.remove('hidden');
  document.getElementById('stageRoomName').textContent = channelName;

  renderLocalStageCard();
}

function leaveVoiceChannel(notifyServer = true) {
  if (!currentVoiceChannel) return;

  playDiscordSound('leave');

  // Fechar e limpar todas as conexões WebRTC
  for (const peerId in peerConnections) {
    closePeerConnection(peerId);
  }

  // Fechar tracks de áudio e tela
  if (rawMicStream) {
    rawMicStream.getTracks().forEach(t => t.stop());
    rawMicStream = null;
  }
  if (localAudioStream) {
    localAudioStream.getTracks().forEach(t => t.stop());
    localAudioStream = null;
  }
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(t => t.stop());
    localScreenStream = null;
    isScreenSharing = false;
  }
  if (localCameraStream) {
    localCameraStream.getTracks().forEach(t => t.stop());
    localCameraStream = null;
    isCameraOn = false;
  }

  if (speakingCheckInterval) {
    clearInterval(speakingCheckInterval);
    speakingCheckInterval = null;
  }
  if (gateHoldTimeout) {
    clearTimeout(gateHoldTimeout);
    gateHoldTimeout = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }

  if (notifyServer) {
    sendWS({ type: 'leave_voice' });
  }

  currentVoiceChannel = null;

  // Restaurar UI
  document.getElementById('voiceConnectedPanel').classList.add('hidden');
  document.getElementById('voiceStage').classList.add('hidden');
  document.getElementById('videoGrid').innerHTML = '';
  resetMediaButtonsUI();
}

async function handleJoinedVoiceSuccess(channelName, existingMembers) {
  // Renderizar imediatamente todos os membros que já estavam na chamada
  for (const member of existingMembers) {
    if (member.id !== myId) {
      renderUserInStageGrid(member.id, member.username, member.avatar, member.state);
      await createPeerConnection(member.id, member.username, true);
    }
  }
  updateStageParticipantsCount();
}

async function handleUserJoinedVoice(user, channelName) {
  if (channelName !== currentVoiceChannel) return;
  // Membro que acabou de entrar
  renderUserInStageGrid(user.id, user.username, user.avatar, user.state);
  updateStageParticipantsCount();
  playDiscordSound('join');
  setTimeout(playBrenoEntranceSound, 300);

  // Se já estiver transmitindo tela, garantir envio para o novo usuário
  if (isScreenSharing && localScreenStream) {
    setTimeout(async () => {
      const pc = await createPeerConnection(user.id, user.username, true);
      if (pc) {
        localScreenStream.getTracks().forEach(track => {
          const sender = pc.addTrack(track, localScreenStream);
          if (track.kind === 'video') tuneSenderBitrate(sender);
        });
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWS({
          type: 'webrtc_signal',
          targetId: user.id,
          signal: { sdp: pc.localDescription }
        });
      }
    }, 500);
  }
}

function handleUserLeftVoice(userId) {
  closePeerConnection(userId);
  removeUserFromStageGrid(userId);
  updateStageParticipantsCount();
  playDiscordSound('leave');
}

// Criar PeerConnection WebRTC
async function createPeerConnection(targetId, targetUsername, isInitiator) {
  if (peerConnections[targetId]) {
    return peerConnections[targetId].pc;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  const connData = {
    pc,
    targetUsername,
    remoteAudioEl: null,
    remoteVideoEl: null
  };
  peerConnections[targetId] = connData;

  // Adicionar tracks locais de áudio do microfone
  if (localAudioStream) {
    localAudioStream.getAudioTracks().forEach(track => {
      pc.addTrack(track, localAudioStream);
    });
  }

  // Adicionar tracks de tela/câmera se já estiver transmitindo
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localScreenStream);
      if (track.kind === 'video') tuneSenderBitrate(sender);
    });
  } else if (localCameraStream) {
    localCameraStream.getTracks().forEach(track => {
      pc.addTrack(track, localCameraStream);
    });
  }

  // Candidatos ICE
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendWS({
        type: 'webrtc_signal',
        targetId: targetId,
        signal: { ice: event.candidate }
      });
    }
  };

  // Receber tracks remotos
  pc.ontrack = (event) => {
    const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
    const track = event.track;

    // Se a track for de VÍDEO, só cria card se estiver ao vivo (evita tela preta!)
    if (track.kind === 'video') {
      if (track.readyState === 'live') {
        attachRemoteVideo(targetId, targetUsername, stream);
        track.onended = () => removeRemoteVideo(targetId);
        track.onmute = () => removeRemoteVideo(targetId);
        track.onunmute = () => attachRemoteVideo(targetId, targetUsername, stream);
      }
    } else if (track.kind === 'audio') {
      // Se este áudio veio da transmissão de tela (stream com vídeo), anexa à tela
      if (stream.getVideoTracks().length > 0) {
        attachRemoteVideo(targetId, targetUsername, stream);
      } else {
        // Áudio do microfone (voz dos amigos)
        let audioEl = connData.remoteAudioEl;
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.autoplay = true;
          audioEl.id = `remote-audio-${targetId}`;
          document.getElementById('remoteAudioContainer').appendChild(audioEl);
          connData.remoteAudioEl = audioEl;
        }
        audioEl.srcObject = stream;
        if (isDeafened) {
          audioEl.muted = true;
        }
        audioEl.play().catch(err => {
          console.warn("Navegador aguardando clique para áudio:", err);
          showAudioUnlockBanner();
        });
      }
    }
  };

  // Se for o iniciador da chamada para esse peer, criar Oferta SDP
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({
        type: 'webrtc_signal',
        targetId: targetId,
        signal: { sdp: pc.localDescription }
      });
    } catch (e) {
      console.error("Erro ao criar oferta WebRTC:", e);
    }
  }

  return pc;
}

// Tratar sinalização WebRTC recebida do servidor
async function handleWebRTCSignal(data) {
  const senderId = data.senderId;
  const signal = data.signal;

  let conn = peerConnections[senderId];
  if (!conn) {
    await createPeerConnection(senderId, data.senderUsername || 'Membro', false);
    conn = peerConnections[senderId];
  }

  const pc = conn.pc;

  if (signal.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

    if (signal.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendWS({
        type: 'webrtc_signal',
        targetId: senderId,
        signal: { sdp: pc.localDescription }
      });
    }
  } else if (signal.ice) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.ice));
    } catch (e) {
      console.warn("Erro ao adicionar ICE candidate:", e);
    }
  }
}

function closePeerConnection(peerId) {
  const conn = peerConnections[peerId];
  if (conn) {
    if (conn.pc) conn.pc.close();
    if (conn.remoteAudioEl) conn.remoteAudioEl.remove();
    delete peerConnections[peerId];
  }
  removeUserFromStageGrid(peerId);
}

// Ajustar parâmetros de vídeo para alta taxa de bits e modo anti-lag
async function tuneSenderBitrate(sender, targetBitrate = 3500000) {
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxBitrate = targetBitrate;
    params.encodings[0].maxFramerate = 60;
    // maintain-framerate garante que o jogo nunca fique travando ou com delay
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch (e) {
    // Aplicado pelo navegador
  }
}

// ----------------------------------------------------
// 4. COMPARTILHAMENTO DE TELA & CÂMERA
// ----------------------------------------------------
async function toggleScreenShare() {
  if (isScreenSharing) {
    stopScreenShare();
    return;
  }

  try {
    const quality = document.getElementById('selectScreenQuality') ? document.getElementById('selectScreenQuality').value : 'optimized';
    let idealW = 1280, idealH = 720, targetBitrate = 3500000;
    if (quality === 'hd') {
      idealW = 1920; idealH = 1080; targetBitrate = 6000000;
    } else if (quality === 'ultra') {
      idealW = 2560; idealH = 1440; targetBitrate = 8500000;
    }

    // Captura de tela otimizada com 60 FPS
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: "always",
        displaySurface: "monitor",
        width: { ideal: idealW, max: idealW },
        height: { ideal: idealH, max: idealH },
        frameRate: { ideal: 60, max: 60 }
      },
      audio: {
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2,
        sampleRate: 48000
      }
    });

    isScreenSharing = true;
    updateScreenShareUI(true);

    // Se o usuário parar de compartilhar pela barra do próprio navegador
    const videoTrack = localScreenStream.getVideoTracks()[0];
    videoTrack.onended = () => {
      stopScreenShare();
    };

    // Renderizar preview local no Stage
    renderLocalVideo(localScreenStream, 'Tela de ' + myUsername);

    // Enviar a nova track de tela para todas as conexões ativas
    for (const peerId in peerConnections) {
      const pc = peerConnections[peerId].pc;
      localScreenStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, localScreenStream);
        if (track.kind === 'video') {
          tuneSenderBitrate(sender, targetBitrate);
        }
      });
      // Renegociar oferta
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendWS({
        type: 'webrtc_signal',
        targetId: peerId,
        signal: { sdp: pc.localDescription }
      });
    }

    sendWS({
      type: 'media_state',
      state: { isScreenSharing: true }
    });

  } catch (err) {
    console.warn("Compartilhamento de tela cancelado ou falhou:", err);
    stopScreenShare();
  }
}

function stopScreenShare() {
  if (localScreenStream) {
    localScreenStream.getTracks().forEach(track => track.stop());
    localScreenStream = null;
  }
  isScreenSharing = false;
  updateScreenShareUI(false);
  removeLocalVideo();

  sendWS({
    type: 'media_state',
    state: { isScreenSharing: false }
  });

  // Renegociar fechamento das tracks de vídeo nos peers
  for (const peerId in peerConnections) {
    const pc = peerConnections[peerId].pc;
    const senders = pc.getSenders();
    senders.forEach(sender => {
      if (sender.track && sender.track.kind === 'video') {
        pc.removeTrack(sender);
      }
    });
    pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
      sendWS({
        type: 'webrtc_signal',
        targetId: peerId,
        signal: { sdp: pc.localDescription }
      });
    }).catch(e => console.warn(e));
  }
}

function updateScreenShareUI(sharing) {
  const btn = document.getElementById('btnShareScreen');
  const icon = document.getElementById('iconScreenShare');
  const text = document.getElementById('textScreenShare');

  if (sharing) {
    btn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#da373c] hover:bg-[#a1282c] text-white text-xs font-semibold transition shadow badge-live';
    text.textContent = 'Parar Tela';
  } else {
    btn.className = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#2b2d31] hover:bg-[#5865f2] text-white text-xs font-semibold transition shadow';
    text.textContent = 'Transmitir Tela';
  }
  lucide.createIcons();
}

async function toggleCamera() {
  if (isCameraOn) {
    if (localCameraStream) {
      localCameraStream.getTracks().forEach(t => t.stop());
      localCameraStream = null;
    }
    isCameraOn = false;
    document.getElementById('btnToggleCamera').className = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#2b2d31] hover:bg-[#35373c] text-white text-xs font-semibold transition shadow';
    removeLocalVideo();
  } else {
    try {
      localCameraStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      isCameraOn = true;
      document.getElementById('btnToggleCamera').className = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#23a55a] hover:bg-green-600 text-white text-xs font-semibold transition shadow';
      renderLocalVideo(localCameraStream, 'Câmera de ' + myUsername);

      // Adiciona nos peers
      for (const peerId in peerConnections) {
        const pc = peerConnections[peerId].pc;
        localCameraStream.getTracks().forEach(track => pc.addTrack(track, localCameraStream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendWS({
          type: 'webrtc_signal',
          targetId: peerId,
          signal: { sdp: pc.localDescription }
        });
      }
    } catch (e) {
      alert("Não foi possível acessar a câmera: " + e.message);
    }
  }
}

// ----------------------------------------------------
// 5. RENDERIZAÇÃO DO STAGE DE VÍDEO & PARTICIPANTES
// ----------------------------------------------------
function renderLocalStageCard() {
  const grid = document.getElementById('videoGrid');
  let card = document.getElementById('stage-card-' + myId);

  if (!card) {
    card = document.createElement('div');
    card.id = 'stage-card-' + myId;
    card.className = 'video-card min-h-[140px] flex flex-col items-center justify-center p-3 relative rounded-lg bg-[#2b2d31] border-2 border-transparent';
    card.innerHTML = `
      <div id="avatar-ring-${myId}" class="w-16 h-16 rounded-full bg-[#1e1f22] flex items-center justify-center p-1 transition-all">
        <img src="${myAvatar}" class="w-full h-full rounded-full">
      </div>
      <span class="text-xs font-semibold text-white mt-2 flex items-center gap-1">
        ${myUsername} (Você)
      </span>
      <div class="absolute bottom-2 right-2 flex items-center gap-1">
        <span id="mic-badge-${myId}" class="p-1 rounded bg-[#1e1f22]/80 text-[#949ba4]">
          <i data-lucide="mic" class="w-3.5 h-3.5"></i>
        </span>
      </div>
    `;
    grid.appendChild(card);
    lucide.createIcons();
  }
}

function renderUserInStageGrid(userId, username, avatar, state = {}) {
  const grid = document.getElementById('videoGrid');
  let card = document.getElementById('stage-card-' + userId);

  if (!card) {
    card = document.createElement('div');
    card.id = 'stage-card-' + userId;
    card.className = 'video-card min-h-[140px] flex flex-col items-center justify-center p-3 relative rounded-lg bg-[#2b2d31] border-2 border-transparent';
    card.innerHTML = `
      <div id="avatar-ring-${userId}" class="w-16 h-16 rounded-full bg-[#1e1f22] flex items-center justify-center p-1 transition-all">
        <img src="${avatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + username}" class="w-full h-full rounded-full">
      </div>
      <span class="text-xs font-semibold text-white mt-2">${username}</span>
      <div class="mt-1 flex items-center gap-1 bg-[#1e1f22]/80 px-2 py-0.5 rounded-full" title="Volume individual deste membro">
        <i data-lucide="volume-2" class="w-3 h-3 text-amber-400"></i>
        <input type="range" min="0" max="1" step="0.05" value="1" oninput="setUserAudioVolume('${userId}', this.value)" class="w-14 accent-amber-500 cursor-pointer h-1">
        <span id="user-vol-${userId}" class="text-[10px] text-[#949ba4] font-bold">100%</span>
      </div>
      <div class="absolute bottom-2 right-2 flex items-center gap-1">
        <span id="mic-badge-${userId}" class="p-1 rounded bg-[#1e1f22]/80 ${state.isMuted ? 'text-[#da373c]' : 'text-[#949ba4]'}">
          <i data-lucide="${state.isMuted ? 'mic-off' : 'mic'}" class="w-3.5 h-3.5"></i>
        </span>
      </div>
    `;
    grid.appendChild(card);
    lucide.createIcons();
  }
}

function setUserAudioVolume(userId, val) {
  const el = document.getElementById(`remote-audio-${userId}`);
  const label = document.getElementById(`user-vol-${userId}`);
  if (el) {
    el.volume = parseFloat(val);
  }
  if (label) {
    label.textContent = Math.round(val * 100) + '%';
  }
}

function showAudioUnlockBanner() {
  let banner = document.getElementById('audioUnlockBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'audioUnlockBanner';
    banner.className = 'fixed top-4 left-1/2 transform -translate-x-1/2 bg-amber-500 text-black font-extrabold px-4 py-2.5 rounded-xl shadow-2xl z-50 flex items-center gap-3 cursor-pointer animate-bounce';
    banner.innerHTML = `
      <span>🔊 Clique na tela para ativar o som de todos na chamada!</span>
      <button class="bg-black text-white text-xs px-2 py-1 rounded">Ativar</button>
    `;
    banner.onclick = () => {
      unlockAllAudio();
      banner.remove();
    };
    document.body.appendChild(banner);
  }
}

function unlockAllAudio() {
  const audios = document.querySelectorAll('audio, video');
  audios.forEach(a => {
    if (a.paused) a.play().catch(() => {});
  });
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

// Desbloquear áudio de voz no primeiro clique de qualquer pessoa
window.addEventListener('click', () => {
  unlockAllAudio();
  const banner = document.getElementById('audioUnlockBanner');
  if (banner) banner.remove();
}, { once: true });

function removeUserFromStageGrid(userId) {
  const card = document.getElementById('stage-card-' + userId);
  if (card) card.remove();
  const videoCard = document.getElementById('video-card-' + userId);
  if (videoCard) videoCard.remove();
}

function renderLocalVideo(stream, label) {
  const grid = document.getElementById('videoGrid');
  let videoCard = document.getElementById('local-video-card');

  if (!videoCard) {
    videoCard = document.createElement('div');
    videoCard.id = 'local-video-card';
    videoCard.className = 'video-card min-h-[180px] col-span-1 sm:col-span-2 relative bg-black rounded-lg overflow-hidden border-2 border-[#5865f2]';
    videoCard.innerHTML = `
      <video id="localVideoElement" autoplay muted playsinline class="w-full h-full object-contain"></video>
      <div class="absolute top-2 left-2 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-md text-xs font-bold text-white">
        <span class="w-2 h-2 rounded-full bg-[#da373c] animate-ping"></span>
        <span>AO VIVO — ${label}</span>
      </div>
      <button onclick="toggleFullScreen('localVideoElement')" class="absolute bottom-2 right-2 p-1.5 bg-black/60 rounded hover:bg-black text-white" title="Tela Cheia">
        <i data-lucide="maximize" class="w-4 h-4"></i>
      </button>
    `;
    grid.prepend(videoCard);
    lucide.createIcons();
  }

  const video = document.getElementById('localVideoElement');
  video.srcObject = stream;
}

function removeLocalVideo() {
  const videoCard = document.getElementById('local-video-card');
  if (videoCard) videoCard.remove();
}

function attachRemoteVideo(targetId, targetUsername, stream) {
  const grid = document.getElementById('videoGrid');
  let videoCard = document.getElementById('video-card-' + targetId);

  if (!videoCard) {
    videoCard = document.createElement('div');
    videoCard.id = 'video-card-' + targetId;
    videoCard.className = 'video-card min-h-[180px] col-span-1 sm:col-span-2 relative bg-black rounded-lg overflow-hidden border-2 border-amber-500/70 shadow-2xl';
    videoCard.innerHTML = `
      <video id="remote-video-${targetId}" autoplay playsinline class="w-full h-full object-contain"></video>
      <div class="absolute top-2 left-2 flex items-center gap-2 bg-black/60 backdrop-blur px-2.5 py-1 rounded-md text-xs font-bold text-white">
        <span class="w-2 h-2 rounded-full bg-[#da373c] animate-pulse"></span>
        <span>AO VIVO — Tela de ${targetUsername}</span>
      </div>

      <!-- Barra de Controle de Áudio da Tela (Slider de Volume) -->
      <div class="absolute bottom-2 right-2 flex items-center gap-2 bg-black/75 backdrop-blur px-2.5 py-1.5 rounded-lg border border-white/10 shadow-lg">
        <i data-lucide="volume-2" class="w-3.5 h-3.5 text-amber-400"></i>
        <input type="range" min="0" max="1" step="0.05" value="0.4" oninput="setStreamVolume('${targetId}', this.value)" class="w-16 sm:w-20 accent-amber-500 cursor-pointer h-1.5" title="Ajustar Volume do Jogo">
        <span id="vol-label-${targetId}" class="text-[11px] font-bold text-white w-7 text-right">40%</span>
        <button onclick="toggleFullScreen('remote-video-${targetId}')" class="p-1 rounded hover:bg-white/20 text-white ml-1 transition" title="Tela Cheia">
          <i data-lucide="maximize" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `;
    grid.prepend(videoCard);
    lucide.createIcons();
  }

  const video = document.getElementById(`remote-video-${targetId}`);
  video.srcObject = stream;
  video.volume = 0.4; // Volume inicial em 40% para não estourar o áudio da live!
}

function setStreamVolume(targetId, val) {
  const video = document.getElementById(`remote-video-${targetId}`);
  const label = document.getElementById(`vol-label-${targetId}`);
  if (video) {
    video.volume = parseFloat(val);
  }
  if (label) {
    label.textContent = Math.round(val * 100) + '%';
  }
}

function toggleFullScreen(videoId) {
  const video = document.getElementById(videoId);
  if (!video) return;
  if (video.requestFullscreen) {
    video.requestFullscreen();
  } else if (video.webkitRequestFullscreen) {
    video.webkitRequestFullscreen();
  }
}

function updateStageParticipantsCount() {
  const cards = document.querySelectorAll('.video-card');
  const count = cards.length;
  document.getElementById('stageUserCount').textContent = `${count} participante${count === 1 ? '' : 's'}`;
}

// ----------------------------------------------------
// 6. PIPELINE AVANÇADO DE ÁUDIO & SUPRESSÃO DE RUÍDO
//    (Anti-Ventilador, Anti-Teclado e Portão de Ruído / Noise Gate)
// ----------------------------------------------------
function setupAudioProcessingPipeline(stream) {
  try {
    if (!stream) return;
    
    // Se o AudioContext já existir e estiver suspenso/fechado, recria
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    } else if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    micSourceNode = audioCtx.createMediaStreamSource(stream);

    // 1. Filtro Passa-Altas Biquad (Highpass Filter):
    // Corta frequências abaixo de 120Hz onde se concentram vibrações de motor de ventilador, ar-condicionado e ressonância de mesa
    highpassNode = audioCtx.createBiquadFilter();
    highpassNode.type = 'highpass';
    highpassNode.frequency.value = isHighpassOn ? 120 : 20;
    highpassNode.Q.value = 0.707;

    // 2. Portão de Ruído (Noise Gate Gain Node):
    // Quando fechado (0.0), silêncio absoluto. Quando aberto (1.0), voz limpa.
    gateGainNode = audioCtx.createGain();
    gateGainNode.gain.setValueAtTime(0.0, audioCtx.currentTime);

    // 3. Analisador para detecção de energia e sensibilidade
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyser.smoothingTimeConstant = 0.15;

    // 4. Destino de Áudio para o WebRTC
    audioDestinationNode = audioCtx.createMediaStreamDestination();

    // Roteamento do gráfico de áudio
    micSourceNode.connect(highpassNode);
    highpassNode.connect(micAnalyser);
    highpassNode.connect(gateGainNode);
    gateGainNode.connect(audioDestinationNode);

    // O stream filtrado com Portão de Ruído é o que vai para os outros participantes
    localAudioStream = audioDestinationNode.stream;

    startNoiseGateLoop();
  } catch (err) {
    console.error("Falha ao configurar pipeline de áudio Web Audio API:", err);
    localAudioStream = stream;
  }
}

function startNoiseGateLoop() {
  if (speakingCheckInterval) clearInterval(speakingCheckInterval);

  const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);

  speakingCheckInterval = setInterval(() => {
    if (!micAnalyser) return;

    if (isMuted) {
      if (gateGainNode && audioCtx && audioCtx.state === 'running') {
        gateGainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01);
      }
      if (wasSpeaking) {
        wasSpeaking = false;
        triggerSpeakingUI(myId, false);
        sendWS({ type: 'speaking', isSpeaking: false });
      }
      updateMicMeterUI(0);
      return;
    }

    micAnalyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    const rawAvg = sum / dataArray.length;
    // Escala de 0 a 100
    const currentLevel = Math.min(100, Math.round((rawAvg / 160) * 100));

    updateMicMeterUI(currentLevel);

    // Limiar do Portão de Ruído (Noise Gate)
    let threshold = userGateThreshold;
    if (isAutoGate) {
      // Calibração dinâmica com ruído de fundo da sala (ventilador, etc.)
      if (currentLevel < autoNoiseFloor + 5) {
        autoNoiseFloor = autoNoiseFloor * 0.96 + currentLevel * 0.04;
      }
      threshold = Math.max(14, Math.min(45, Math.round(autoNoiseFloor + 8)));
      updateGateMarkerUI(threshold);
    } else {
      updateGateMarkerUI(userGateThreshold);
    }

    const isSpeakingNow = currentLevel >= threshold;

    if (isSpeakingNow) {
      // Abre o portão instantaneamente (15ms para não cortar início de palavras)
      if (!isGateOpen) {
        isGateOpen = true;
        if (gateGainNode && audioCtx && audioCtx.state === 'running') {
          gateGainNode.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.015);
        }
        if (!wasSpeaking) {
          wasSpeaking = true;
          triggerSpeakingUI(myId, true);
          sendWS({ type: 'speaking', isSpeaking: true });
        }
      }

      // Reinicia o tempo de sustentação
      clearTimeout(gateHoldTimeout);
      gateHoldTimeout = setTimeout(() => {
        // Fecha o portão suavemente (silêncio total de ventilador/teclado)
        isGateOpen = false;
        if (gateGainNode && audioCtx && audioCtx.state === 'running') {
          gateGainNode.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.05);
        }
        wasSpeaking = false;
        triggerSpeakingUI(myId, false);
        sendWS({ type: 'speaking', isSpeaking: false });
      }, 260); // 260ms de hold para não cortar final de frases
    }
  }, 40);
}

function updateMicMeterUI(level) {
  const bar = document.getElementById('micLiveLevelBar');
  if (bar) {
    bar.style.width = `${Math.min(100, Math.max(0, level))}%`;
  }
}

function updateGateMarkerUI(thresholdVal) {
  const marker = document.getElementById('micGateThresholdMarker');
  if (marker) {
    marker.style.left = `${Math.min(95, Math.max(5, thresholdVal))}%`;
  }
}

function toggleAutoGateUI() {
  const check = document.getElementById('checkAutoGate');
  isAutoGate = check ? check.checked : true;
  localStorage.setItem('dc_auto_gate', isAutoGate ? 'true' : 'false');
  const sliderContainer = document.getElementById('manualGateSliderContainer');
  if (sliderContainer) {
    if (isAutoGate) {
      sliderContainer.classList.add('hidden');
    } else {
      sliderContainer.classList.remove('hidden');
    }
  }
}

function onGateThresholdChange(val) {
  userGateThreshold = parseInt(val, 10);
  localStorage.setItem('dc_gate_threshold', userGateThreshold);
  const label = document.getElementById('labelGateThreshold');
  if (label) label.textContent = userGateThreshold;
  updateGateMarkerUI(userGateThreshold);
}

function saveAudioSettings() {
  const highpass = document.getElementById('checkHighpass');
  const typing = document.getElementById('checkTypingCancel');
  if (highpass) {
    isHighpassOn = highpass.checked;
    localStorage.setItem('dc_highpass', isHighpassOn ? 'true' : 'false');
    if (highpassNode) {
      highpassNode.frequency.value = isHighpassOn ? 120 : 20;
    }
  }
  if (typing) {
    isTypingCancelOn = typing.checked;
    localStorage.setItem('dc_typing_cancel', isTypingCancelOn ? 'true' : 'false');
  }
}

async function toggleTestMic() {
  const btnText = document.getElementById('btnTestMicText');
  if (isTestingMic) {
    isTestingMic = false;
    if (testMicStream) {
      testMicStream.getTracks().forEach(t => t.stop());
      testMicStream = null;
    }
    if (!currentVoiceChannel) {
      if (speakingCheckInterval) clearInterval(speakingCheckInterval);
      if (audioCtx) {
        audioCtx.close().catch(() => {});
        audioCtx = null;
      }
    }
    if (btnText) btnText.textContent = "Testar Microfone";
    updateMicMeterUI(0);
    return;
  }

  try {
    isTestingMic = true;
    if (btnText) btnText.textContent = "Parar Teste (Ouvindo...)";

    isHighpassOn = localStorage.getItem('dc_highpass') !== 'false';
    isTypingCancelOn = localStorage.getItem('dc_typing_cancel') !== 'false';

    testMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        googEchoCancellation: true,
        googAutoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: isHighpassOn,
        googTypingNoiseDetection: isTypingCancelOn
      },
      video: false
    });

    if (!currentVoiceChannel) {
      setupAudioProcessingPipeline(testMicStream);
    }
  } catch (err) {
    console.warn("Erro ao testar microfone:", err);
    isTestingMic = false;
    if (btnText) btnText.textContent = "Microfone não encontrado";
  }
}

function triggerSpeakingUI(userId, isSpeaking) {
  const ring = document.getElementById(`avatar-ring-${userId}`);
  if (ring) {
    if (isSpeaking) {
      ring.classList.add('speaking-border');
    } else {
      ring.classList.remove('speaking-border');
    }
  }
}

function handleRemoteSpeaking(userId, isSpeaking) {
  triggerSpeakingUI(userId, isSpeaking);
}

function removeRemoteVideo(targetId) {
  const videoCard = document.getElementById('video-card-' + targetId);
  if (videoCard) {
    videoCard.remove();
    updateStageParticipantsCount();
  }
}

function handleRemoteMediaState(userId, state) {
  if (state) {
    if (state.isScreenSharing === false && state.isCamera === false) {
      removeRemoteVideo(userId);
    }
  }

  const badge = document.getElementById(`mic-badge-${userId}`);
  if (badge && state) {
    if (state.isMuted) {
      badge.className = 'p-1 rounded bg-[#1e1f22]/80 text-[#da373c]';
      badge.innerHTML = '<i data-lucide="mic-off" class="w-3.5 h-3.5"></i>';
    } else {
      badge.className = 'p-1 rounded bg-[#1e1f22]/80 text-[#949ba4]';
      badge.innerHTML = '<i data-lucide="mic" class="w-3.5 h-3.5"></i>';
    }
    lucide.createIcons();
  }
}

function toggleMute() {
  isMuted = !isMuted;
  if (rawMicStream) {
    rawMicStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }
  if (localAudioStream) {
    localAudioStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  }

  const iconMic = document.getElementById('iconMic');
  const btn = document.getElementById('btnToggleMic');
  const stageMicBtn = document.getElementById('btnStageMic');

  if (isMuted) {
    btn.className = 'p-1.5 rounded hover:bg-[#35373c] text-[#da373c] transition';
    iconMic.setAttribute('data-lucide', 'mic-off');
    if (stageMicBtn) stageMicBtn.className = 'p-2 rounded-md bg-[#da373c] text-white transition';
  } else {
    btn.className = 'p-1.5 rounded hover:bg-[#35373c] text-[#b5bac1] hover:text-white transition';
    iconMic.setAttribute('data-lucide', 'mic');
    if (stageMicBtn) stageMicBtn.className = 'p-2 rounded-md bg-[#2b2d31] hover:bg-[#35373c] text-white transition';
  }

  handleRemoteMediaState(myId, { isMuted });
  sendWS({
    type: 'media_state',
    state: { isMuted }
  });

  lucide.createIcons();
}

function toggleDeafen() {
  isDeafened = !isDeafened;
  const iconDeaf = document.getElementById('iconDeaf');
  const btn = document.getElementById('btnToggleDeaf');

  // Muta ou desmuta todas as tags <audio> remotas
  for (const peerId in peerConnections) {
    const audioEl = peerConnections[peerId].remoteAudioEl;
    if (audioEl) audioEl.muted = isDeafened;
  }

  if (isDeafened) {
    btn.className = 'p-1.5 rounded hover:bg-[#35373c] text-[#da373c] transition';
    if (!isMuted) toggleMute(); // Se ensurdece, também muta o microfone por padrão Discord
  } else {
    btn.className = 'p-1.5 rounded hover:bg-[#35373c] text-[#b5bac1] hover:text-white transition';
  }

  lucide.createIcons();
}

function resetMediaButtonsUI() {
  isScreenSharing = false;
  isCameraOn = false;
  updateScreenShareUI(false);
  document.getElementById('btnToggleCamera').className = 'flex items-center gap-2 px-3 py-1.5 rounded-md bg-[#2b2d31] hover:bg-[#35373c] text-white text-xs font-semibold transition shadow';
}

// ----------------------------------------------------
// 7. MEMBROS, BADGES E PERFIL
// ----------------------------------------------------
function updateOrAddUser(user) {
  const idx = serverUsers.findIndex(u => u.id === user.id);
  if (idx >= 0) {
    serverUsers[idx] = user;
  } else {
    serverUsers.push(user);
  }
}

function handleUserDisconnected(userId, serverState) {
  if (serverState) {
    serverUsers = serverState.users || [];
    updateVoiceBadges(serverState.voiceChannels);
  } else {
    serverUsers = serverUsers.filter(u => u.id !== userId);
  }
  handleUserLeftVoice(userId);
  renderMemberList();
}

function renderMemberList() {
  const list = document.getElementById('membersList');
  if (!list) return;
  document.getElementById('memberCount').textContent = serverUsers.length;
  list.innerHTML = '';

  serverUsers.forEach(u => {
    const isMe = u.id === myId;
    const userRole = getRoleForUser(u);
    const nameColor = userRole ? userRole.color : '#dbdee1';

    const item = document.createElement('div');
    item.className = 'flex items-center gap-2 p-1.5 rounded hover:bg-[#35373c] cursor-pointer transition select-none group';
    item.onclick = (e) => openUserProfilePopout(u.id, e);

    item.innerHTML = `
      <div class="relative flex-shrink-0">
        <img src="${u.avatar || 'https://api.dicebear.com/7.x/bottts/svg?seed=' + u.username}" class="w-8 h-8 rounded-full bg-[#1e1f22] object-cover">
        <div class="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-[#23a55a] border-2 border-[#2b2d31]"></div>
      </div>
      <div class="truncate flex-1 min-w-0">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold truncate" style="color: ${nameColor}">
            ${escapeHtml(u.username)}
          </span>
          ${userRole ? `<span class="role-pill text-[9px] py-0 px-1.5" style="background-color: ${userRole.color}">${escapeHtml(userRole.name)}</span>` : ''}
        </div>
        ${u.voiceChannel ? `<span class="text-[10px] text-[#23a55a] flex items-center gap-1 font-bold mt-0.5 truncate"><i data-lucide="volume-2" class="w-2.5 h-2.5"></i> ${escapeHtml(u.voiceChannel)}</span>` : ''}
      </div>
    `;
    list.appendChild(item);
  });

  lucide.createIcons();
}

function updateVoiceBadges(voiceMap = {}) {
  for (const [channelName, uids] of Object.entries(voiceMap)) {
    const badge = document.getElementById(`badge-count-${channelName}`);
    const membersContainer = document.getElementById(`members-${channelName}`);

    if (badge && membersContainer) {
      if (uids.length > 0) {
        badge.classList.remove('hidden');
        badge.textContent = uids.length;

        // Preenche mini lista de membros abaixo do canal
        membersContainer.innerHTML = uids.map(uid => {
          const user = serverUsers.find(u => u.id === uid);
          const name = user ? user.username : 'Usuário';
          const avatar = user ? user.avatar : '';
          return `
            <div class="flex items-center gap-1.5 text-xs text-[#dbdee1] py-0.5">
              <img src="${avatar}" class="w-4 h-4 rounded-full bg-[#1e1f22]">
              <span class="truncate">${name}</span>
            </div>
          `;
        }).join('');
      } else {
        badge.classList.add('hidden');
        membersContainer.innerHTML = '';
      }
    }
  }
}

function getRoleForUser(user) {
  if (!serverConfig || !serverConfig.roles) return { name: 'MEMBRO TDL', color: '#949ba4' };
  const roleId = user.role || 'member';
  let role = serverConfig.roles.find(r => r.id === roleId);
  if (!role && user.username) {
    if (user.username.toUpperCase() === 'TDL' || user.username.toUpperCase().includes('LIRO')) {
      role = serverConfig.roles.find(r => r.id === 'owner' || r.is_admin);
    }
  }
  return role || serverConfig.roles.find(r => r.id === 'member') || { name: 'MEMBRO TDL', color: '#949ba4' };
}

function updateMyProfileUI() {
  document.getElementById('myUsername').textContent = myUsername;
  document.getElementById('myAvatar').src = myAvatar;
  document.getElementById('inputNickname').value = myUsername;
  document.getElementById('selectAvatarStyle').value = myAvatarStyle;
  document.getElementById('inputBannerColor').value = myBannerColor;
  document.getElementById('inputBio').value = myBio;

  const noiseCheck = document.getElementById('checkNoiseSuppression');
  if (noiseCheck) {
    noiseCheck.checked = localStorage.getItem('dc_noise_suppression') !== 'false';
  }

  renderRoleSelectOptions();
  updateProfilePreview();
}

function renderRoleSelectOptions() {
  const select = document.getElementById('selectUserRole');
  if (select && serverConfig.roles) {
    select.innerHTML = serverConfig.roles.map(r => `
      <option value="${r.id}" ${r.id === myRole ? 'selected' : ''}>${escapeHtml(r.name)}</option>
    `).join('');
  }
}

function setBannerColorPreset(color) {
  myBannerColor = color;
  document.getElementById('inputBannerColor').value = color;
  removeCustomBannerImage();
}

function onBannerColorInputChange() {
  myBannerColor = document.getElementById('inputBannerColor').value;
  removeCustomBannerImage();
}

function onAvatarStyleChange() {
  myAvatarStyle = document.getElementById('selectAvatarStyle').value;
  myAvatar = `https://api.dicebear.com/7.x/${myAvatarStyle}/svg?seed=${myUsername}`;
  localStorage.removeItem('dc_custom_avatar');
  updateProfilePreview();
}

function handleCustomAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onloadend = () => {
    myAvatar = reader.result;
    localStorage.setItem('dc_custom_avatar', myAvatar);
    updateProfilePreview();
  };
  reader.readAsDataURL(file);
}

function handleCustomBannerUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onloadend = () => {
    myBannerImage = reader.result;
    localStorage.setItem('dc_banner_image', myBannerImage);
    const removeBtn = document.getElementById('btnRemoveBannerImage');
    if (removeBtn) removeBtn.classList.remove('hidden');
    updateProfilePreview();
  };
  reader.readAsDataURL(file);
}

function removeCustomBannerImage() {
  myBannerImage = '';
  localStorage.removeItem('dc_banner_image');
  const removeBtn = document.getElementById('btnRemoveBannerImage');
  if (removeBtn) removeBtn.classList.add('hidden');
  const fileInput = document.getElementById('customBannerFileInput');
  if (fileInput) fileInput.value = '';
  updateProfilePreview();
}

function updateProfilePreview() {
  const name = document.getElementById('inputNickname')?.value.trim() || myUsername;
  const bannerColor = document.getElementById('inputBannerColor')?.value || myBannerColor;
  const bio = document.getElementById('inputBio')?.value || myBio;
  const roleId = document.getElementById('selectUserRole')?.value || myRole;

  const role = (serverConfig.roles || []).find(r => r.id === roleId) || { name: 'MEMBRO TDL', color: '#949ba4' };

  const previewBanner = document.getElementById('previewBannerEl');
  if (previewBanner) {
    if (myBannerImage) {
      previewBanner.style.backgroundImage = `url("${myBannerImage}")`;
      previewBanner.style.backgroundColor = '';
    } else {
      previewBanner.style.backgroundImage = 'none';
      previewBanner.style.backgroundColor = bannerColor;
    }
  }

  const previewAvatar = document.getElementById('previewModalAvatar');
  if (previewAvatar) previewAvatar.src = myAvatar;

  const previewName = document.getElementById('previewModalNickname');
  if (previewName) {
    previewName.textContent = name;
    previewName.style.color = role.color;
  }

  const previewBadge = document.getElementById('previewModalRoleBadge');
  if (previewBadge) {
    previewBadge.textContent = role.name;
    previewBadge.style.backgroundColor = role.color;
  }

  const previewBio = document.getElementById('previewModalBio');
  if (previewBio) previewBio.textContent = bio || 'Membro oficial da TDL 🚀';
}

function openSettingsModal() {
  document.getElementById('settingsModal').classList.remove('hidden');
  updateMyProfileUI();

  // Carregar estado do botão de remover banner
  const removeBannerBtn = document.getElementById('btnRemoveBannerImage');
  if (removeBannerBtn) {
    if (myBannerImage) removeBannerBtn.classList.remove('hidden');
    else removeBannerBtn.classList.add('hidden');
  }

  // Carregar configurações de supressão de ruído
  const checkHighpass = document.getElementById('checkHighpass');
  const checkTyping = document.getElementById('checkTypingCancel');
  const checkAutoGate = document.getElementById('checkAutoGate');
  const inputGate = document.getElementById('inputGateThreshold');
  const labelGate = document.getElementById('labelGateThreshold');

  if (checkHighpass) checkHighpass.checked = isHighpassOn;
  if (checkTyping) checkTyping.checked = isTypingCancelOn;
  if (checkAutoGate) checkAutoGate.checked = isAutoGate;
  if (inputGate) inputGate.value = userGateThreshold;
  if (labelGate) labelGate.textContent = userGateThreshold;
  updateGateMarkerUI(userGateThreshold);
  toggleAutoGateUI();

  lucide.createIcons();
}

function closeSettingsModal() {
  if (isTestingMic) {
    toggleTestMic();
  }
  document.getElementById('settingsModal').classList.add('hidden');
}

function saveProfileSettings() {
  const newName = document.getElementById('inputNickname').value.trim();
  const bannerColor = document.getElementById('inputBannerColor').value;
  const bio = document.getElementById('inputBio').value.trim();
  const roleId = document.getElementById('selectUserRole').value;

  if (newName) {
    myUsername = newName;
    localStorage.setItem('dc_username', myUsername);
  }
  myBannerColor = bannerColor;
  localStorage.setItem('dc_banner_color', myBannerColor);
  localStorage.setItem('dc_banner_image', myBannerImage);

  myBio = bio;
  localStorage.setItem('dc_bio', myBio);

  myRole = roleId;
  localStorage.setItem('dc_role', myRole);

  localStorage.setItem('dc_avatar_style', myAvatarStyle);

  saveAudioSettings();

  document.getElementById('myUsername').textContent = myUsername;
  document.getElementById('myAvatar').src = myAvatar;

  sendWS({
    type: 'update_profile',
    username: myUsername,
    avatar: myAvatar,
    bannerColor: myBannerColor,
    bannerImage: myBannerImage,
    bio: myBio,
    role: myRole
  });

  closeSettingsModal();
}

// ----------------------------------------------------
// 7. SISTEMA DE SERVIDOR, CANAIS E POPOUT FLUTUANTE
// ----------------------------------------------------
function applyServerConfigUI() {
  // Nome do Servidor
  const nameEl = document.getElementById('serverHeaderName');
  if (nameEl) nameEl.textContent = serverConfig.server_name || "TDL — Tropa do Liro";
  const titleEl = document.getElementById('settingsServerTitle');
  if (titleEl) titleEl.textContent = serverConfig.server_name || "TDL";

  // Ícone do Servidor
  const iconEl = document.getElementById('serverHeaderIcon');
  const previewEl = document.getElementById('serverIconPreview');
  if (serverConfig.server_icon) {
    if (iconEl) iconEl.innerHTML = `<img src="${serverConfig.server_icon}" class="w-5 h-5 rounded-full object-cover">`;
    if (previewEl) previewEl.innerHTML = `<img src="${serverConfig.server_icon}" class="w-full h-full object-cover rounded-2xl">`;
  } else {
    if (iconEl) iconEl.innerHTML = '👑';
    if (previewEl) previewEl.innerHTML = 'TDL';
  }

  // Banner do Servidor
  const serverBannerHeader = document.getElementById('serverHeaderBanner');
  const serverBannerPreview = document.getElementById('serverBannerPreview');
  const btnRemoveBanner = document.getElementById('btnRemoveServerBanner');
  if (serverConfig.server_banner) {
    if (serverBannerHeader) {
      serverBannerHeader.style.backgroundImage = `url("${serverConfig.server_banner}")`;
      serverBannerHeader.classList.remove('hidden');
    }
    if (serverBannerPreview) {
      serverBannerPreview.style.backgroundImage = `url("${serverConfig.server_banner}")`;
      serverBannerPreview.innerHTML = '';
    }
    if (btnRemoveBanner) btnRemoveBanner.classList.remove('hidden');
  } else {
    if (serverBannerHeader) {
      serverBannerHeader.classList.add('hidden');
      serverBannerHeader.style.backgroundImage = 'none';
    }
    if (serverBannerPreview) {
      serverBannerPreview.style.backgroundImage = 'none';
      serverBannerPreview.innerHTML = '<span id="serverBannerPlaceholderText">Sem imagem de banner configurada</span>';
    }
    if (btnRemoveBanner) btnRemoveBanner.classList.add('hidden');
  }

  renderDynamicChannels();
  renderServerSettingsChannels();
  renderServerSettingsRoles();
  renderRoleSelectOptions();
}

function renderDynamicChannels() {
  // 1. Canais de Texto
  const textContainer = document.getElementById('textChannelsList');
  if (textContainer && serverConfig.text_channels) {
    textContainer.innerHTML = serverConfig.text_channels.map(ch => {
      const isActive = ch.id === currentTextChannel;
      const icon = ch.icon || '💬';
      return `
        <button onclick="switchTextChannel('${ch.id}')" id="chan-${ch.id}" class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md ${isActive ? 'text-white bg-[#404249]' : 'text-[#949ba4] hover:text-[#dbdee1]'} font-medium text-sm hover:bg-[#35373c] transition group">
          <span class="text-sm">${icon}</span>
          <span class="truncate">${escapeHtml(ch.name)}</span>
        </button>
      `;
    }).join('');
  }

  // 2. Canais de Voz
  const voiceContainer = document.getElementById('voiceChannelsContainer');
  if (voiceContainer && serverConfig.voice_channels) {
    voiceContainer.innerHTML = serverConfig.voice_channels.map(ch => {
      const isConnected = currentVoiceChannel === ch.name;
      return `
        <div class="voice-channel-group">
          <button onclick="toggleJoinVoice('${escapeHtml(ch.name)}')" id="voice-btn-${ch.name}" class="w-full flex items-center justify-between px-2 py-1.5 rounded-md ${isConnected ? 'text-[#23a55a] bg-[#35373c]' : 'text-[#949ba4] hover:text-[#dbdee1]'} hover:bg-[#35373c] font-medium text-xs transition">
            <div class="flex items-center gap-2 truncate">
              <span class="text-sm">🔊</span>
              <span class="truncate font-semibold">${escapeHtml(ch.name)}</span>
            </div>
            <span id="badge-count-${ch.name}" class="text-xs bg-[#1e1f22] px-1.5 py-0.5 rounded text-[#949ba4] hidden">0</span>
          </button>
          <div id="members-${ch.name}" class="pl-7 pr-2 space-y-1 my-1"></div>
        </div>
      `;
    }).join('');
  }

  lucide.createIcons();
}

function toggleServerDropdown(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('serverDropdownMenu');
  const chevron = document.getElementById('serverChevronIcon');
  if (menu) {
    const isHidden = menu.classList.toggle('hidden');
    if (chevron) {
      chevron.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(180deg)';
    }
    lucide.createIcons();
  }
}

function openServerSettingsModal(tab = 'overview') {
  const dropdown = document.getElementById('serverDropdownMenu');
  if (dropdown) dropdown.classList.add('hidden');

  const modal = document.getElementById('serverSettingsModal');
  if (modal) {
    modal.classList.remove('hidden');
    switchServerTab(tab);
    document.getElementById('inputServerName').value = serverConfig.server_name || "TDL — Tropa do Liro";
    renderServerSettingsChannels();
    renderServerSettingsRoles();
    lucide.createIcons();
  }
}

function closeServerSettingsModal() {
  const modal = document.getElementById('serverSettingsModal');
  if (modal) modal.classList.add('hidden');
}

function switchServerTab(tabName) {
  document.querySelectorAll('.server-tab-btn').forEach(b => b.classList.remove('active', 'bg-[#404249]', 'text-white'));
  document.querySelectorAll('.server-tab-content').forEach(c => c.classList.add('hidden'));

  const btn = document.getElementById(`tabBtn-${tabName}`);
  const content = document.getElementById(`serverTab-${tabName}`);
  if (btn) btn.classList.add('active', 'bg-[#404249]', 'text-white');
  if (content) content.classList.remove('hidden');
  lucide.createIcons();
}

function saveServerOverviewSettings() {
  const newName = document.getElementById('inputServerName').value.trim();
  sendWS({
    type: 'update_server_settings',
    serverName: newName
  });
  alert('Configurações do servidor salvas com sucesso! ✅');
}

function handleServerIconUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = reader.result;
    document.getElementById('serverIconPreview').innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover rounded-2xl">`;
    sendWS({
      type: 'update_server_settings',
      serverIcon: dataUrl
    });
  };
  reader.readAsDataURL(file);
}

function handleServerBannerUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = reader.result;
    const preview = document.getElementById('serverBannerPreview');
    if (preview) {
      preview.style.backgroundImage = `url("${dataUrl}")`;
      preview.innerHTML = '';
    }
    const removeBtn = document.getElementById('btnRemoveServerBanner');
    if (removeBtn) removeBtn.classList.remove('hidden');
    sendWS({
      type: 'update_server_settings',
      serverBanner: dataUrl
    });
  };
  reader.readAsDataURL(file);
}

function removeServerBanner() {
  const preview = document.getElementById('serverBannerPreview');
  if (preview) {
    preview.style.backgroundImage = 'none';
    preview.innerHTML = '<span id="serverBannerPlaceholderText">Sem imagem de banner configurada</span>';
  }
  const removeBtn = document.getElementById('btnRemoveServerBanner');
  if (removeBtn) removeBtn.classList.add('hidden');
  const fileInput = document.getElementById('serverBannerFileInput');
  if (fileInput) fileInput.value = '';
  sendWS({
    type: 'update_server_settings',
    serverBanner: ''
  });
}

function renderServerSettingsChannels() {
  const list = document.getElementById('serverSettingsChannelsList');
  if (!list) return;

  let html = '<div class="text-xs font-bold text-[#949ba4] uppercase tracking-wider mb-2">Canais de Texto</div>';
  (serverConfig.text_channels || []).forEach(ch => {
    html += `
      <div class="flex items-center justify-between p-3 rounded-lg bg-[#232428] border border-[#1f2023]">
        <div class="flex items-center gap-2">
          <span>${ch.icon || '💬'}</span>
          <span class="font-bold text-white text-sm">#${escapeHtml(ch.name)}</span>
        </div>
        <button onclick="confirmDeleteChannel('text', '${ch.id}', '${ch.name}')" class="p-1.5 rounded hover:bg-[#35373c] text-[#da373c] hover:text-red-400 transition" title="Excluir Canal">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });

  html += '<div class="text-xs font-bold text-[#949ba4] uppercase tracking-wider mt-4 mb-2">Canais de Voz</div>';
  (serverConfig.voice_channels || []).forEach(ch => {
    html += `
      <div class="flex items-center justify-between p-3 rounded-lg bg-[#232428] border border-[#1f2023]">
        <div class="flex items-center gap-2">
          <span>🔊</span>
          <span class="font-bold text-white text-sm">${escapeHtml(ch.name)}</span>
        </div>
        <button onclick="confirmDeleteChannel('voice', '${ch.id}', '${ch.name}')" class="p-1.5 rounded hover:bg-[#35373c] text-[#da373c] hover:text-red-400 transition" title="Excluir Canal">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `;
  });

  list.innerHTML = html;
  lucide.createIcons();
}

function confirmDeleteChannel(type, id, name) {
  if (confirm(`Tem certeza que deseja excluir o canal "${name}"?`)) {
    sendWS({
      type: 'delete_channel',
      channelType: type,
      id: id,
      name: name
    });
  }
}

function renderServerSettingsRoles() {
  const list = document.getElementById('serverSettingsRolesList');
  if (!list) return;

  list.innerHTML = (serverConfig.roles || []).map(r => `
    <div class="flex items-center justify-between p-3 rounded-lg bg-[#232428] border border-[#1f2023]">
      <div class="flex items-center gap-2.5">
        <span class="w-3.5 h-3.5 rounded-full" style="background-color: ${r.color}"></span>
        <span class="font-bold text-sm" style="color: ${r.color}">${escapeHtml(r.name)}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-mono text-[#949ba4]">${r.color}</span>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

function openNewRoleForm() {
  const form = document.getElementById('newRoleFormContainer');
  if (form) form.classList.remove('hidden');
}

function saveNewRole() {
  const name = document.getElementById('inputNewRoleName').value.trim();
  const color = document.getElementById('inputNewRoleColor').value;
  if (!name) return alert('Digite o nome do cargo');

  const roleId = 'role_' + Math.random().toString(36).substring(2, 7);
  const updatedRoles = [...(serverConfig.roles || []), { id: roleId, name: name, color: color, is_admin: false }];
  sendWS({
    type: 'update_roles',
    roles: updatedRoles
  });
  document.getElementById('inputNewRoleName').value = '';
  document.getElementById('newRoleFormContainer').classList.add('hidden');
}

function openCreateChannelModal(defaultType = 'text') {
  const dropdown = document.getElementById('serverDropdownMenu');
  if (dropdown) dropdown.classList.add('hidden');

  const modal = document.getElementById('createChannelModal');
  if (modal) {
    modal.classList.remove('hidden');
    const radios = document.getElementsByName('newChanType');
    radios.forEach(r => { if (r.value === defaultType) r.checked = true; });
    updateChanPrefix();
    document.getElementById('inputNewChannelName').value = '';
    document.getElementById('inputNewChannelTopic').value = '';
    lucide.createIcons();
  }
}

function closeCreateChannelModal() {
  const modal = document.getElementById('createChannelModal');
  if (modal) modal.classList.add('hidden');
}

function updateChanPrefix() {
  const type = document.querySelector('input[name="newChanType"]:checked')?.value || 'text';
  const prefix = document.getElementById('newChanPrefix');
  const topicBox = document.getElementById('newChannelTopicContainer');
  if (prefix) prefix.textContent = type === 'text' ? '#' : '🔊';
  if (topicBox) topicBox.style.display = type === 'text' ? 'block' : 'none';
}

function submitCreateChannel() {
  const type = document.querySelector('input[name="newChanType"]:checked')?.value || 'text';
  const name = document.getElementById('inputNewChannelName').value.trim();
  const topic = document.getElementById('inputNewChannelTopic').value.trim();
  if (!name) return alert('Digite o nome do canal');

  sendWS({
    type: 'create_channel',
    channelType: type,
    name: name,
    icon: type === 'text' ? '💬' : '🔊',
    topic: topic
  });

  closeCreateChannelModal();
}

function openUserProfilePopout(userId, event) {
  if (event) event.stopPropagation();

  const popout = document.getElementById('userProfilePopout');
  if (!popout) return;

  const isMe = userId === myId;
  let user = serverUsers.find(u => u.id === userId);
  if (isMe) {
    user = {
      id: myId,
      username: myUsername,
      avatar: myAvatar,
      bannerColor: myBannerColor,
      bannerImage: myBannerImage,
      bio: myBio,
      role: myRole
    };
  }
  if (!user) return;

  const userRole = getRoleForUser(user);
  const bannerColor = user.bannerColor || '#f59e0b';

  const popoutBanner = document.getElementById('popoutBanner');
  if (popoutBanner) {
    if (user.bannerImage) {
      popoutBanner.style.backgroundImage = `url("${user.bannerImage}")`;
      popoutBanner.style.backgroundColor = '';
    } else {
      popoutBanner.style.backgroundImage = 'none';
      popoutBanner.style.backgroundColor = bannerColor;
    }
  }
  document.getElementById('popoutAvatar').src = user.avatar;
  document.getElementById('popoutUsername').textContent = user.username;
  document.getElementById('popoutUsername').style.color = userRole ? userRole.color : '#fff';
  
  const badgeEl = document.getElementById('popoutRoleBadge');
  if (userRole) {
    badgeEl.textContent = userRole.name;
    badgeEl.style.backgroundColor = userRole.color;
    badgeEl.classList.remove('hidden');
  } else {
    badgeEl.classList.add('hidden');
  }

  document.getElementById('popoutBio').textContent = user.bio || 'Membro oficial da TDL 🚀';

  const volumeContainer = document.getElementById('popoutVolumeContainer');
  const slider = document.getElementById('popoutVolumeSlider');
  const valLabel = document.getElementById('popoutVolumeVal');

  if (isMe) {
    volumeContainer.classList.add('hidden');
  } else {
    volumeContainer.classList.remove('hidden');
    const peer = peerConnections[userId];
    const currentVol = peer && peer.remoteAudioEl ? Math.round(peer.remoteAudioEl.volume * 100) : 100;
    slider.value = currentVol;
    valLabel.textContent = `${currentVol}%`;
    slider.oninput = () => {
      valLabel.textContent = `${slider.value}%`;
      setUserVolume(userId, slider.value);
    };
  }

  if (event) {
    const x = Math.min(window.innerWidth - 310, Math.max(10, event.clientX - 100));
    const y = Math.min(window.innerHeight - 360, Math.max(10, event.clientY - 40));
    popout.style.left = `${x}px`;
    popout.style.top = `${y}px`;
  } else {
    popout.style.left = '30%';
    popout.style.top = '25%';
  }

  popout.classList.remove('hidden');
  lucide.createIcons();
}

function closeUserProfilePopout() {
  const popout = document.getElementById('userProfilePopout');
  if (popout) popout.classList.add('hidden');
}

window.addEventListener('click', (e) => {
  const popout = document.getElementById('userProfilePopout');
  if (popout && !popout.classList.contains('hidden') && !popout.contains(e.target)) {
    popout.classList.add('hidden');
  }

  const dropdown = document.getElementById('serverDropdownMenu');
  const header = document.querySelector('header[onclick="toggleServerDropdown(event)"]');
  if (dropdown && !dropdown.classList.contains('hidden') && !dropdown.contains(e.target) && header && !header.contains(e.target)) {
    dropdown.classList.add('hidden');
    const chevron = document.getElementById('serverChevronIcon');
    if (chevron) chevron.style.transform = 'rotate(0deg)';
  }
});

function toggleMemberList() {
  const sidebar = document.getElementById('memberSidebar');
  sidebar.classList.toggle('hidden');
}

// ----------------------------------------------------
// 8. MEME DA TROPA: GRITO DO BRENO ("AÍ MEU CU!")
// ----------------------------------------------------
function playBrenoEntranceSound() {
  const isEnabled = localStorage.getItem('dc_breno_meme') !== 'false';
  if (!isEnabled) return;

  if (customJoinSoundUrl) {
    try {
      const audio = new Audio(customJoinSoundUrl);
      audio.volume = 1.0;
      audio.play().catch(e => {
        console.warn("Autoplay impedido ou arquivo inválido, tocando sintetizado:", e);
        playBrenoSynthScream();
      });
      return;
    } catch (e) {
      console.warn("Erro ao tocar áudio customizado:", e);
    }
  }
  playBrenoSynthScream();
}

function playBrenoSynthScream() {
  // 1. Efeito de áudio sintetizado caricato (Web Audio API)
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.6);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.linearRampToValueAtTime(0.35, now + 0.12);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.65);
  } catch (e) {}

  // 2. TTS Gritando em português
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance("AÍ MEU CU!");
      utter.lang = 'pt-BR';
      utter.pitch = 2.0; // Agudo/esganiçado
      utter.rate = 1.4;  // Rápido
      utter.volume = 1.0;
      window.speechSynthesis.speak(utter);
    } catch (e) {}
  }
}

function testBrenoSound() {
  playBrenoEntranceSound();
}

function updateBrenoSoundUI() {
  const statusEl = document.getElementById('brenoStatusText');
  const checkEl = document.getElementById('checkBrenoMeme');
  if (checkEl) {
    checkEl.checked = localStorage.getItem('dc_breno_meme') !== 'false';
  }
  if (statusEl) {
    if (customJoinSoundUrl) {
      statusEl.innerHTML = '🔥 <b>Áudio oficial do Breno carregado!</b> (Grito real ativo)';
      statusEl.parentElement.className = 'text-[11px] text-amber-300 font-medium bg-[#1e1f22] p-2 rounded flex items-center gap-1.5 border border-amber-500/40';
    } else {
      statusEl.innerHTML = '🔊 Grito sintetizado ativo ("AÍ MEU CU!")';
      statusEl.parentElement.className = 'text-[11px] text-[#23a55a] font-medium bg-[#1e1f22] p-2 rounded flex items-center gap-1.5';
    }
  }
}

async function toggleRecordBreno() {
  const btn = document.getElementById('btnRecordBreno');
  const label = document.getElementById('recordBrenoLabel');

  if (isRecordingBreno) {
    if (brenoRecorder && brenoRecorder.state === 'recording') {
      brenoRecorder.stop();
    }
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    brenoRecordChunks = [];
    brenoRecorder = new MediaRecorder(stream);

    brenoRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) brenoRecordChunks.push(e.data);
    };

    brenoRecorder.onstop = async () => {
      isRecordingBreno = false;
      label.textContent = 'Gravar Breno';
      btn.className = 'bg-[#da373c] hover:bg-red-600 text-white text-xs font-bold py-2 px-2 rounded flex items-center justify-center gap-1 transition shadow';
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(brenoRecordChunks, { type: 'audio/webm' });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64Audio = reader.result;
        label.textContent = 'Salvando...';
        try {
          const resp = await fetch('/api/upload-breno-sound', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audioData: base64Audio })
          });
          const res = await resp.json();
          if (res.success) {
            customJoinSoundUrl = res.url;
            updateBrenoSoundUI();
            testBrenoSound();
            label.textContent = 'Salvo! ✅';
            setTimeout(() => { label.textContent = 'Gravar Breno'; }, 2500);
          } else {
            alert('Erro ao salvar áudio: ' + (res.error || 'Desconhecido'));
          }
        } catch (err) {
          alert('Erro de conexão ao salvar: ' + err.message);
        }
      };
      reader.readAsDataURL(blob);
    };

    brenoRecorder.start();
    isRecordingBreno = true;
    btn.className = 'bg-red-700 animate-pulse text-white text-xs font-bold py-2 px-2 rounded flex items-center justify-center gap-1 transition shadow';

    let seconds = 3;
    label.textContent = `🔴 Gritando... ${seconds}s`;
    const interval = setInterval(() => {
      seconds--;
      if (seconds > 0 && isRecordingBreno) {
        label.textContent = `🔴 Gritando... ${seconds}s`;
      } else {
        clearInterval(interval);
        if (brenoRecorder && brenoRecorder.state === 'recording') {
          brenoRecorder.stop();
        }
      }
    }, 1000);

  } catch (err) {
    alert('Permissão de microfone negada ou indisponível: ' + err.message);
  }
}

async function uploadBrenoAudioFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  const statusEl = document.getElementById('brenoStatusText');
  if (statusEl) statusEl.textContent = 'Enviando áudio do Breno...';

  reader.onloadend = async () => {
    try {
      const resp = await fetch('/api/upload-breno-sound', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioData: reader.result })
      });
      const res = await resp.json();
      if (res.success) {
        customJoinSoundUrl = res.url;
        updateBrenoSoundUI();
        testBrenoSound();
      } else {
        alert('Erro ao enviar áudio: ' + (res.error || 'Desconhecido'));
      }
    } catch (err) {
      alert('Erro na conexão: ' + err.message);
    }
  };
  reader.readAsDataURL(file);
}

// ----------------------------------------------------
// 9. AUTO-UPDATE (HOT SYNC SEM F5) & APLICATIVO PWA
// ----------------------------------------------------
function showUpdateToastAndReload(msg) {
  // Evita múltiplos toasts simultâneos
  if (document.getElementById('tdlUpdateToast')) return;

  const toast = document.createElement('div');
  toast.id = 'tdlUpdateToast';
  toast.className = 'fixed top-4 left-1/2 -translate-x-1/2 z-[100] bg-gradient-to-r from-amber-600 via-orange-600 to-amber-500 text-white font-extrabold px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border border-amber-300/40 text-sm tracking-wide transform transition-all animate-bounce';
  toast.innerHTML = `
    <svg class="animate-spin h-5 w-5 text-white flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
    </svg>
    <span>${msg}</span>
  `;
  document.body.appendChild(toast);

  // Recarrega em 1.5s suavemente
  setTimeout(() => {
    window.location.reload();
  }, 1500);
}

function triggerForceReloadAll() {
  if (confirm("Deseja forçar a atualização imediata da tela de TODOS os usuários conectados sem que precisem dar F5?")) {
    sendWS({
      type: 'trigger_reload_all'
    });
  }
}

// Registro do Service Worker para PWA (Instalar App)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/static/sw.js').catch(e => console.log('SW Info:', e));
}

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btnInstallApp');
  if (btn) {
    btn.classList.remove('hidden');
    btn.classList.add('flex');
  }
});

function installApp() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then(() => {
      deferredInstallPrompt = null;
    });
  } else {
    openInstallModal();
  }
}

function openInstallModal() {
  const modal = document.getElementById('installModal');
  if (modal) {
    modal.classList.remove('hidden');
    lucide.createIcons();
  }
}

function closeInstallModal() {
  const modal = document.getElementById('installModal');
  if (modal) modal.classList.add('hidden');
}
