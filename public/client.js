// ================= State =================
let token = localStorage.getItem('rtc_token') || null;
let username = localStorage.getItem('rtc_username') || null;
let socket = null;
let localStream = null;
let screenStream = null;
let currentRoom = null;
const peerConnections = new Map(); // socketId -> RTCPeerConnection
const peerNames = new Map();       // socketId -> username

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }, // STUN for NAT traversal
    // Add a TURN server here for production (required behind restrictive NATs):
    // { urls: 'turn:your-turn-server:3478', username: 'user', credential: 'pass' }
  ],
};

// ================= DOM refs =================
const $ = (id) => document.getElementById(id);
const authScreen = $('auth-screen');
const lobbyScreen = $('lobby-screen');
const callScreen = $('call-screen');

// ================= Auth =================
async function authRequest(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Auth failed');
  return data;
}

$('registerBtn').onclick = () => doAuth('register');
$('loginBtn').onclick = () => doAuth('login');

async function doAuth(mode) {
  const u = $('username').value.trim();
  const p = $('password').value;
  $('authError').textContent = '';
  try {
    const data = await authRequest(mode, { username: u, password: p });
    token = data.token;
    username = data.username;
    localStorage.setItem('rtc_token', token);
    localStorage.setItem('rtc_username', username);
    showLobby();
  } catch (e) {
    $('authError').textContent = e.message;
  }
}

function showLobby() {
  authScreen.classList.add('hidden');
  lobbyScreen.classList.remove('hidden');
}

if (token && username) showLobby();

// ================= Join room =================
$('joinBtn').onclick = async () => {
  const roomId = $('roomId').value.trim() || 'default-room';
  currentRoom = roomId;
  await startLocalMedia();
  connectSocket();
  lobbyScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');
  $('roomLabel').textContent = `Room: ${roomId}`;
};

async function startLocalMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  addVideoTile('local', localStream, `${username} (You)`, true);
}

function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    alert('Connection failed: ' + err.message);
  });

  socket.on('existing-peers', (peers) => {
    peers.forEach(({ socketId }) => createPeerConnection(socketId, true));
  });

  socket.on('peer-joined', ({ socketId, username: uname }) => {
    peerNames.set(socketId, uname);
  });

  socket.on('signal', async ({ from, data }) => {
    let pc = peerConnections.get(from);
    if (!pc) pc = createPeerConnection(from, false);

    if (data.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: pc.localDescription });
    } else if (data.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data); } catch (e) { console.warn(e); }
    }
  });

  socket.on('peer-left', ({ socketId }) => {
    const pc = peerConnections.get(socketId);
    if (pc) pc.close();
    peerConnections.delete(socketId);
    removeVideoTile(socketId);
  });

  socket.on('screen-share-toggle', ({ socketId, sharing }) => {
    const tile = document.getElementById(`tile-${socketId}`);
    if (tile) tile.querySelector('.label').textContent =
      (peerNames.get(socketId) || 'Peer') + (sharing ? ' (sharing screen)' : '');
  });

  socket.on('chat-message', ({ from, text, ts }) => {
    appendChat(from, text);
  });

  socket.on('file-shared', ({ fileName, url, from }) => {
    appendFile(fileName, url, from);
  });

  socket.on('whiteboard-draw', (stroke) => drawStroke(stroke, false));
  socket.on('whiteboard-clear', () => clearCanvas(false));

  socket.emit('join-room', currentRoom);
}

// ================= WebRTC mesh =================
function createPeerConnection(socketId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peerConnections.set(socketId, pc);

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: socketId, data: e.candidate });
  };

  pc.ontrack = (e) => {
    addVideoTile(socketId, e.streams[0], peerNames.get(socketId) || 'Peer', false);
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      removeVideoTile(socketId);
    }
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: socketId, data: pc.localDescription });
    };
  }

  return pc;
}

// ================= Video tiles =================
function addVideoTile(id, stream, label, muted) {
  let tile = document.getElementById(`tile-${id}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `<video autoplay playsinline ${muted ? 'muted' : ''}></video><span class="label">${label}</span>`;
    $('videoGrid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
}
function removeVideoTile(id) {
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
}

// ================= Mic / Camera toggles =================
$('toggleMicBtn').onclick = () => {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  $('toggleMicBtn').textContent = track.enabled ? '🎤 Mute' : '🎤 Unmute';
};
$('toggleCamBtn').onclick = () => {
  const track = localStream.getVideoTracks()[0];
  track.enabled = !track.enabled;
  $('toggleCamBtn').textContent = track.enabled ? '📷 Camera Off' : '📷 Camera On';
};

// ================= Screen sharing =================
$('screenShareBtn').onclick = async () => {
  if (!screenStream) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) { return; }
    const screenTrack = screenStream.getVideoTracks()[0];
    replaceOutgoingVideoTrack(screenTrack);
    screenTrack.onended = () => stopScreenShare();
    socket.emit('screen-share-toggle', { sharing: true });
    $('screenShareBtn').textContent = '🛑 Stop Sharing';
  } else {
    stopScreenShare();
  }
};

function stopScreenShare() {
  if (!screenStream) return;
  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  const camTrack = localStream.getVideoTracks()[0];
  replaceOutgoingVideoTrack(camTrack);
  socket.emit('screen-share-toggle', { sharing: false });
  $('screenShareBtn').textContent = '🖥️ Share Screen';
}

function replaceOutgoingVideoTrack(newTrack) {
  peerConnections.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(newTrack);
  });
  document.querySelector('#tile-local video').srcObject = new MediaStream([
    newTrack,
    localStream.getAudioTracks()[0],
  ]);
}

// ================= Side panel tabs =================
$('fileBtn').onclick = () => $('sidePanel').classList.toggle('hidden');
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.add('hidden'));
    $(`${btn.dataset.tab}Tab`).classList.remove('hidden');
  };
});

// ================= Chat =================
$('sendChatBtn').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('chat-message', text);
  appendChat(username, text);
  $('chatInput').value = '';
}
function appendChat(from, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="from">${from}:</span>${escapeHtml(text)}`;
  $('chatMessages').appendChild(div);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ================= File sharing =================
$('fileInput').onchange = (e) => uploadFile(e.target.files[0]);
async function uploadFile(file) {
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) return alert(data.error || 'Upload failed');
  socket.emit('file-shared', data);
  appendFile(data.fileName, data.url, username);
}
function appendFile(fileName, url, from) {
  const div = document.createElement('div');
  div.innerHTML = `<a href="${url}" target="_blank">${escapeHtml(fileName)}</a> <span style="color:#9aa0a6">— ${from}</span>`;
  $('fileList').appendChild(div);
}

// ================= Whiteboard =================
const wbCanvas = $('whiteboardCanvas');
const wbCtx = wbCanvas.getContext('2d');
let drawing = false;
let lastPoint = null;

$('whiteboardBtn').onclick = () => {
  $('whiteboardOverlay').classList.remove('hidden');
  resizeCanvas();
};
$('wbCloseBtn').onclick = () => $('whiteboardOverlay').classList.add('hidden');
$('wbClearBtn').onclick = () => { clearCanvas(true); };

function resizeCanvas() {
  wbCanvas.width = wbCanvas.clientWidth;
  wbCanvas.height = wbCanvas.clientHeight;
}
window.addEventListener('resize', () => { if (!$('whiteboardOverlay').classList.contains('hidden')) resizeCanvas(); });

function getPos(e) {
  const rect = wbCanvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function startDraw(e) { drawing = true; lastPoint = getPos(e); }
function endDraw() { drawing = false; lastPoint = null; }
function moveDraw(e) {
  if (!drawing) return;
  const point = getPos(e);
  const stroke = {
    x0: lastPoint.x, y0: lastPoint.y, x1: point.x, y1: point.y,
    color: $('wbColor').value, size: $('wbSize').value,
  };
  drawStroke(stroke, true);
  lastPoint = point;
}
wbCanvas.addEventListener('mousedown', startDraw);
wbCanvas.addEventListener('mouseup', endDraw);
wbCanvas.addEventListener('mouseleave', endDraw);
wbCanvas.addEventListener('mousemove', moveDraw);
wbCanvas.addEventListener('touchstart', startDraw);
wbCanvas.addEventListener('touchend', endDraw);
wbCanvas.addEventListener('touchmove', moveDraw);

function drawStroke(stroke, emit) {
  wbCtx.strokeStyle = stroke.color;
  wbCtx.lineWidth = stroke.size;
  wbCtx.lineCap = 'round';
  wbCtx.beginPath();
  wbCtx.moveTo(stroke.x0, stroke.y0);
  wbCtx.lineTo(stroke.x1, stroke.y1);
  wbCtx.stroke();
  if (emit) socket.emit('whiteboard-draw', stroke);
}
function clearCanvas(emit) {
  wbCtx.clearRect(0, 0, wbCanvas.width, wbCanvas.height);
  if (emit) socket.emit('whiteboard-clear');
}

// ================= Leave =================
$('leaveBtn').onclick = () => {
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  if (socket) socket.disconnect();
  location.reload();
};
