(() => {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('roomId');
  const username = params.get('username');
  const isHost = params.get('isHost') === 'true';

  if (!roomId || !username) {
    window.location.href = '/';
    return;
  }

  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  let player = null;
  let playerReady = false;
  let currentVideoId = null;
  let localPlaying = false;
  let localCurrentTime = 0;
  let lastTimeUpdate = Date.now();
  let isExternalChange = false;
  let syncInterval = null;
  let heartbeatInterval = null;
  let voiceChats = new Map();
  let peerStatuses = new Map();
  const STATUS_PRIORITY = { 'connected': 0, 'muted': 0, 'connecting': 1, 'waiting': 2, 'disconnected': 3, 'mic-error': 4 };
  const playerDiv = document.getElementById('player');

  roomCodeDisplay.textContent = roomId;
  roomLinkDisplay.textContent = `${window.location.origin}/room.html?roomId=${roomId}`;

  const updateVoiceStatus = (status) => {
    if (!voiceStatus) return;
    const icons = {
      'waiting': 'Sesli sohbet iÃ§in diÄŸer kiÅŸi bekleniyor...',
      'connecting': 'Sesli sohbet baÄŸlanÄ±yor...',
      'connected': 'Sesli sohbet baÄŸlandÄ±',
      'muted': 'Sesiniz kapalÄ±',
      'disconnected': 'BaÄŸlantÄ± koptu, yeniden baÄŸlanÄ±lÄ±yor...',
      'mic-error': 'Mikrofona eriÅŸilemedi',
    };
    voiceStatus.textContent = icons[status] || status;
    voiceStatus.className = 'voice-status ' + status;
    if (muteBtn) {
      muteBtn.classList.toggle('hidden', status !== 'connected' && status !== 'muted');
    }
  };

  const onPeerStatusChange = (peerId, status) => {
    peerStatuses.set(peerId, status);
    let bestStatus = 'waiting';
    let bestPriority = 99;
    peerStatuses.forEach((s) => {
      const p = STATUS_PRIORITY[s] !== undefined ? STATUS_PRIORITY[s] : 99;
      if (p < bestPriority) { bestPriority = p; bestStatus = s; }
    });
    if (peerStatuses.size === 0) bestStatus = 'waiting';
    updateVoiceStatus(bestStatus);
  };

  const startVoiceChatIfNeeded = (users) => {
    if (users.length < 2) return;

    users.forEach(otherUser => {
      if (otherUser.id === socket.id) return;
      if (voiceChats.has(otherUser.id)) return;

      const vc = new VoiceChat(socket, roomId, (status) => onPeerStatusChange(otherUser.id, status));
      vc.setSocketId(socket.id);
      voiceChats.set(otherUser.id, vc);
      vc.startWith(otherUser.id);
    });
  };

  const getVoiceChatForPeer = (peerId) => {
    if (voiceChats.has(peerId)) return voiceChats.get(peerId);
    for (const [, vc] of voiceChats) {
      if (vc.otherSocketId === peerId) return vc;
    }
    return null;
  };

  let apiReadyPromise = null;
  let pendingVideoId = null;

  const loadYouTubeAPI = () => {
    if (apiReadyPromise) return apiReadyPromise;
    apiReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) {
        resolve();
        return;
      }
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      const first = document.getElementsByTagName('script')[0];
      first.parentNode.insertBefore(tag, first);
      window.onYouTubeIframeAPIReady = () => {
        resolve();
        if (pendingVideoId) {
          const vid = pendingVideoId;
          pendingVideoId = null;
          createPlayer(vid);
        }
      };
    });
    return apiReadyPromise;
  };

  const createPlayer = (videoId) => {
    if (player) {
      player.destroy();
      player = null;
    }
    emptyVideo.style.display = 'none';
    playerDiv.innerHTML = '';
    player = new YT.Player(playerDiv, {
      height: '100%',
      width: '100%',
      videoId: videoId,
      playerVars: {
        autoplay: 0, rel: 0, controls: 1,
        modestbranding: 1, playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  };

  const onPlayerReady = () => {
    playerReady = true;
    currentVideoId = player.getVideoData().video_id;
    const savedVol = localStorage.getItem('watchparty-volume');
    if (savedVol !== null) {
      player.setVolume(parseInt(savedVol, 10));
      volumeSlider.value = savedVol;
      volumeLabel.textContent = savedVol + '%';
    }
    requestSync();
    startHeartbeat();
  };

  const onPlayerStateChange = (event) => {
    if (isExternalChange) return;
    const time = player.getCurrentTime();
    localCurrentTime = time;
    lastTimeUpdate = Date.now();
    switch (event.data) {
      case YT.PlayerState.PLAYING:
        localPlaying = true;
        sendState({ isPlaying: true, currentTime: time, timestamp: Date.now() });
        break;
      case YT.PlayerState.PAUSED:
        localPlaying = false;
        sendState({ isPlaying: false, currentTime: time, timestamp: Date.now() });
        break;
      case YT.PlayerState.ENDED:
        localPlaying = false;
        sendState({ isPlaying: false, currentTime: player.getDuration(), timestamp: Date.now() });
        break;
    }
  };

  const onPlayerError = (event) => {
    console.error('YouTube player error:', event.data);
  };

  const sendState = (state) => {
    socket.emit('video-state-change', { roomId, state });
  };

  const requestSync = () => {
    socket.emit('sync-request', { roomId });
  };

  const startHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (playerReady && player && player.getCurrentTime) {
        try {
          const time = player.getCurrentTime();
          localCurrentTime = time;
          lastTimeUpdate = Date.now();
          if (localPlaying) {
            socket.emit('video-state-change', {
              roomId,
              state: { isPlaying: true, currentTime: time, timestamp: Date.now() },
            });
          }
        } catch (e) {}
      }
    }, 10000);
  };

  const setSyncStatus = (connected) => {
    syncDot.className = `sync-dot ${connected ? '' : 'disconnected'}`;
    syncLabel.textContent = connected ? 'Senkronize' : 'BaÄŸlantÄ± kesildi';
  };

  const updateUserList = (users) => {
    if (!users || users.length === 0) {
      userList.innerHTML = '<li style="color:#555;justify-content:center;padding:20px">KatÄ±lÄ±mcÄ± bekleniyor...</li>';
      return;
    }
    userList.innerHTML = users.map(u => `
      <li>
        <span class="user-status"></span>
        <span>${escapeHtml(u.username)}</span>
        ${u.id === socket.id ? '<span style="color:#666;font-size:12px">(sen)</span>' : ''}
        ${u.isHost ? '<span class="host-badge">Ev Sahibi</span>' : ''}
      </li>
    `).join('');
  };

  const escapeHtml = (text) => {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  };

  socket.on('connect', () => {
    setSyncStatus(true);
    socket.emit('join-room', { roomId, username });
  });

  socket.on('disconnect', () => {
    setSyncStatus(false);
  });

  socket.on('connect_error', () => {
    setSyncStatus(false);
  });

  socket.on('set-socket-id', (data) => {
    mySocketId = data.id;
  });

  socket.on('room-joined', (data) => {
    mySocketId = socket.id;
    const users = data.users.map(u => ({
      ...u,
      isHost: u.id === socket.id && isHost,
    }));
    updateUserList(users);

    if (data.videoState && data.videoState.videoId && !currentVideoId) {
      loadVideoById(data.videoState.videoId);
    }

    startVoiceChatIfNeeded(users);
  });

  socket.on('user-joined', (data) => {
    const items = userList.querySelectorAll('li');
    if (items.length === 1 && items[0].textContent.includes('KatÄ±lÄ±mcÄ± bekleniyor')) {
      userList.innerHTML = '';
    }
    userList.insertAdjacentHTML('beforeend', `
      <li>
        <span class="user-status"></span>
        <span>${escapeHtml(data.username)}</span>
      </li>
    `);

    startVoiceChatIfNeeded([
      { id: socket.id, username },
      { id: data.id, username: data.username },
    ]);
  });

  socket.on('user-left', (data) => {
    const items = userList.querySelectorAll('li');
    items.forEach(item => {
      if (item.textContent.includes(escapeHtml(data.username))) {
        item.remove();
      }
    });
    if (userList.children.length === 0) {
      userList.innerHTML = '<li style="color:#555;justify-content:center;padding:20px">KatÄ±lÄ±mcÄ± bekleniyor...</li>';
    }
    if (voiceChats.size > 0) {
      const vc = voiceChats.get(data.id);
      if (vc) { vc.destroy(); voiceChats.delete(data.id); peerStatuses.delete(data.id); }
      if (voiceChats.size === 0) { updateVoiceStatus('waiting'); peerStatuses.clear(); }
    }
  });

  socket.on('video-set', (data) => {
    if (data.videoId) loadVideoById(data.videoId);
  });

  let lastSyncTime = 0;
  const SYNC_COOLDOWN = 800;

  socket.on('video-state-sync', (data) => {
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;
    const state = data.state;
    if (!state || !playerReady || !player) return;
    isExternalChange = true;
    const elapsed = state.timestamp ? (now - state.timestamp) / 1000 : 0;
    const targetTime = (state.currentTime || 0) + (state.isPlaying ? elapsed : 0);
    if (Math.abs((player.getCurrentTime() || 0) - targetTime) > 1.5) {
      player.seekTo(targetTime, true);
    }
    if (state.isPlaying) {
      player.playVideo();
      localPlaying = true;
    } else {
      player.pauseVideo();
      localPlaying = false;
    }
    localCurrentTime = targetTime;
    lastTimeUpdate = now;
    setTimeout(() => { isExternalChange = false; }, 500);
  });

  socket.on('video-seek-sync', (data) => {
    const now = Date.now();
    if (now - lastSyncTime < SYNC_COOLDOWN) return;
    lastSyncTime = now;
    if (!playerReady || !player) return;
    isExternalChange = true;
    player.seekTo(data.currentTime, true);
    localCurrentTime = data.currentTime;
    lastTimeUpdate = now;
    setTimeout(() => { isExternalChange = false; }, 500);
  });

  socket.on('webrtc-offer', async (data) => {
    const vc = getVoiceChatForPeer(data.from);
    if (vc) {
      await vc.handleOffer(data.sdp, data.from);
    } else {
      const newVc = new VoiceChat(socket, roomId, updateVoiceStatus);
      newVc.setSocketId(socket.id);
      voiceChats.set(data.from, newVc);
      await newVc.handleOffer(data.sdp, data.from);
    }
  });

  socket.on('webrtc-answer', async (data) => {
    const vc = getVoiceChatForPeer(data.from);
    if (vc) await vc.handleAnswer(data.sdp);
  });

  socket.on('webrtc-ice-candidate', async (data) => {
    const vc = getVoiceChatForPeer(data.from);
    if (vc) await vc.handleIceCandidate(data.candidate);
  });

  socket.on('error', (msg) => {
    console.error('Socket error:', msg);
  });

  const extractVideoId = (url) => {
    if (!url) return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  };

  const loadVideoById = (videoId) => {
    if (!videoId) return;
    currentVideoId = videoId;
    if (playerReady && player) {
      player.loadVideoById(videoId);
    } else if (window.YT && window.YT.Player) {
      createPlayer(videoId);
    } else {
      pendingVideoId = videoId;
      loadYouTubeAPI();
    }
  };

  loadVideoBtn.addEventListener('click', () => {
    const url = videoUrlInput.value.trim();
    const videoId = extractVideoId(url);
    if (!videoId) {
      alert('GeÃ§erli bir YouTube linki girin.');
      return;
    }
    loadVideoById(videoId);
    socket.emit('set-video', { roomId, videoId });
  });

  videoUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVideoBtn.click();
  });

  volumeSlider.addEventListener('input', () => {
    const val = parseInt(volumeSlider.value, 10);
    volumeLabel.textContent = val + '%';
    if (playerReady && player) player.setVolume(val);
    localStorage.setItem('watchparty-volume', val);
  });

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      voiceChats.forEach(vc => vc.toggleMute());
      const anyMuted = Array.from(voiceChats.values()).some(vc => vc.isMuted);
      muteBtn.textContent = anyMuted ? 'Sesi AÃ§' : 'Sesi Kapat';
    });
  }

  leaveBtn.addEventListener('click', () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    if (syncInterval) clearInterval(syncInterval);
    voiceChats.forEach(vc => vc.destroy());
    voiceChats.clear();
    if (player) { player.destroy(); player = null; }
    socket.disconnect();
    window.location.href = '/';
  });

  setSyncStatus(true);
  loadYouTubeAPI().catch(console.error);
})();
