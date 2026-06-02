const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

class VoiceChat {
  constructor(socket, roomId, onStatusChange) {
    this.socket = socket;
    this.roomId = roomId;
    this.pc = null;
    this.localStream = null;
    this.isMuted = false;
    this.connected = false;
    this.connecting = false;
    this.mySocketId = null;
    this.otherSocketId = null;
    this.onStatusChange = onStatusChange || (() => {});
    this.pendingCandidates = [];
    this.pendingOffer = null;
    this.started = false;
  }

  setSocketId(id) {
    this.mySocketId = id;
  }

  updateStatus(status) {
    this.onStatusChange(status);
  }

  async startWith(otherSocketId) {
    if (this.started) return;
    this.started = true;
    this.otherSocketId = otherSocketId;
    this.connecting = true;

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      this.connecting = false;
      this.updateStatus('mic-error');
      return;
    }

    this.createPeerConnection();

    this.localStream.getTracks().forEach(track => {
      this.pc.addTrack(track, this.localStream);
    });

    if (this.pendingOffer) {
      await this._handleOfferInternal(this.pendingOffer.sdp, this.pendingOffer.from);
      this.pendingOffer = null;
      return;
    }

    if (this.mySocketId > this.otherSocketId) {
      this.updateStatus('connecting');
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.socket.emit('webrtc-offer', { roomId: this.roomId, sdp: offer });
    } else {
      this.updateStatus('connecting');
    }
  }

  handleOffer(sdp, fromSocketId) {
    if (!this.started) {
      this.pendingOffer = { sdp, from: fromSocketId };
      return;
    }
    this._handleOfferInternal(sdp, fromSocketId);
  }

  async _handleOfferInternal(sdp, fromSocketId) {
    this.otherSocketId = fromSocketId;
    this.connecting = true;
    this.updateStatus('connecting');

    if (!this.localStream) {
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch (err) {
        this.connecting = false;
        this.updateStatus('mic-error');
        return;
      }
    }

    if (!this.pc) {
      this.createPeerConnection();
      this.localStream.getTracks().forEach(track => {
        this.pc.addTrack(track, this.localStream);
      });
    }

    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));

    for (const candidate of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
    this.pendingCandidates = [];

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.socket.emit('webrtc-answer', { roomId: this.roomId, sdp: answer });
  }

  async handleAnswer(sdp) {
    if (!this.pc) {
      setTimeout(() => this.handleAnswer(sdp), 500);
      return;
    }
    await this.pc.setRemoteDescription(new RTCSessionDescription(sdp));

    for (const candidate of this.pendingCandidates) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
    }
    this.pendingCandidates = [];
  }

  async handleIceCandidate(candidate) {
    if (!this.pc) {
      this.pendingCandidates.push(candidate);
      return;
    }
    try {
      if (this.pc.remoteDescription && this.pc.remoteDescription.type) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        this.pendingCandidates.push(candidate);
      }
    } catch (e) {}
  }

  createPeerConnection() {
    this.pc = new RTCPeerConnection(STUN_SERVERS);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('webrtc-ice-candidate', {
          roomId: this.roomId,
          candidate: event.candidate,
        });
      }
    };

    this.pc.ontrack = (event) => {
      const audioEl = document.createElement('audio');
      audioEl.srcObject = event.streams[0];
      audioEl.autoplay = true;
      audioEl.style.display = 'none';
      audioEl.setAttribute('data-webrtc', '');
      document.body.appendChild(audioEl);
    };

    this.pc.oniceconnectionstatechange = () => {
      if (this.pc.iceConnectionState === 'connected' || this.pc.iceConnectionState === 'completed') {
        this.connected = true;
        this.connecting = false;
        this.updateStatus('connected');
      } else if (this.pc.iceConnectionState === 'disconnected' || this.pc.iceConnectionState === 'failed') {
        this.connected = false;
        this.updateStatus('disconnected');
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'connected') {
        this.connected = true;
        this.connecting = false;
        this.updateStatus('connected');
      } else if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'disconnected') {
        this.connected = false;
        this.updateStatus('disconnected');
      }
    };
  }

  toggleMute() {
    if (this.localStream) {
      this.isMuted = !this.isMuted;
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
      this.updateStatus(this.isMuted ? 'muted' : (this.connected ? 'connected' : 'connecting'));
    }
  }

  destroy() {
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.connected = false;
    this.connecting = false;
    this.started = false;
    this.pendingCandidates = [];
    this.pendingOffer = null;
    document.querySelectorAll('audio[data-webrtc]').forEach(el => el.remove());
  }
}
