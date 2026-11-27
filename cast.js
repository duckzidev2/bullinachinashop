// Poke Party viewer stream, host side. Loaded by the web export's head_include
// (copy this file to the website as /cast.js).
//
// Viewers open pokeparty.club/v and type the room code. The game's own page
// sends them its picture (the canvas) and its sound over WebRTC: peer to peer,
// so the delay is a fraction of a second instead of a Discord stream's seconds.
// The relay (barrelofmonkeys) only passes the handshake along. The game tells
// this script its room with window.ppRoom = {code, key, relay} (autoload/net.gd).
(() => {
  "use strict";
  const STUN = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const FPS = 30;
  const MAX_HEIGHT = 720;          // bigger canvases are scaled down before sending
  const MAX_BITRATE = 2500000;     // per viewer, bits per second

  // ------------------------------------------------------------ sound tap
  // Godot plays its sound into the AudioContext's speakers. Anything connected
  // to the speakers is also connected to a stream we can send to viewers.
  // This has to run before Godot starts, which is why it lives in <head>.
  const taps = new WeakMap();
  let soundStream = null;
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  function tapFor(ctx) {
    let tap = taps.get(ctx);
    if (!tap && typeof ctx.createMediaStreamDestination === "function") {
      tap = ctx.createMediaStreamDestination();
      taps.set(ctx, tap);
    }
    if (tap) soundStream = tap.stream;
    return tap;
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = connect.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      try { const tap = tapFor(this.context); if (tap) connect.call(this, tap, rest[0] || 0); } catch (e) {}
    }
    return out;
  };
  AudioNode.prototype.disconnect = function (...args) {
    const out = disconnect.apply(this, args);
    if (args[0] instanceof AudioDestinationNode) {
      const tap = taps.get(this.context);
      if (tap) { try { disconnect.call(this, tap); } catch (e) {} }
    }
    return out;
  };

  // ------------------------------------------------------------ picture
  let picture = null;
  function pictureStream() {
    if (!picture) {
      const canvas = document.getElementById("canvas");
      if (!canvas || typeof canvas.captureStream !== "function") return null;
      picture = canvas.captureStream(FPS);
      for (const t of picture.getVideoTracks()) t.contentHint = "motion";
    }
    return picture;
  }

  // ------------------------------------------------------------ relay
  let ws = null, wsFor = "", retryAt = 0;
  const viewers = new Map();  // viewer id -> { pc, n, ready, ice: [] }
  let offers = 0;             // every offer has a number; answers and ICE carry it back

  setInterval(() => {
    const room = window.ppRoom;
    if (!room || !room.code || !room.key) return;
    const wanted = room.code + "/" + room.key;
    if (ws && wsFor === wanted) return;
    if (Date.now() < retryAt) return;
    openRelay(room, wanted);
  }, 1000);

  function openRelay(room, wanted) {
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    wsFor = wanted;
    const sock = new WebSocket(`${room.relay}/caster?room=${room.code}&key=${encodeURIComponent(room.key)}`);
    ws = sock;
    sock.onmessage = (e) => onRelay(e.data);
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      wsFor = "";
      retryAt = Date.now() + 3000;  // viewers already connected keep watching: they don't need the relay
    };
  }

  function sendTo(id, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "to", id, d: data }));
  }

  function onRelay(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m.id !== "string") return;
    if (m.t === "vjoin") { if (!viewers.has(m.id)) offer(m.id); return; }
    if (m.t === "vleave") { drop(m.id); return; }
    if (m.t !== "vsig" || !m.d) return;
    const d = m.d;
    if (d.hello) { offer(m.id); return; }  // the viewer asks again (its link failed)
    const v = viewers.get(m.id);
    if (!v || d.n !== v.n) return;  // an answer to an older offer
    if (d.type === "answer" && typeof d.sdp === "string") {
      v.pc.setRemoteDescription({ type: "answer", sdp: d.sdp })
        .then(() => { v.ready = true; v.ice.forEach((c) => addIce(v, c)); v.ice = []; })
        .catch(() => { if (viewers.get(m.id) === v) drop(m.id); });
    } else if (d.ice) {
      if (v.ready) addIce(v, d.ice); else v.ice.push(d.ice);
    }
  }

  function addIce(v, c) {
    v.pc.addIceCandidate(c).catch(() => {});
  }

  // ------------------------------------------------------------ ICE servers
  // STUN, plus a TURN relay from the relay server when it has one: many networks
  // block a direct link between two computers, and TURN passes the picture then.
  let ice = null, iceFor = "", iceAt = 0;
  async function iceServers() {
    const room = window.ppRoom;
    if (!room) return STUN;
    if (ice && iceFor === room.code && Date.now() - iceAt < 3600000) return ice;
    try {
      const r = await fetch(`${room.relay.replace(/^ws/, "http")}/ice?room=${room.code}`);
      const j = await r.json();
      if (Array.isArray(j.iceServers) && j.iceServers.length) { ice = j.iceServers; iceFor = room.code; iceAt = Date.now(); return ice; }
    } catch (e) {}
    return STUN;
  }

  // ------------------------------------------------------------ one link per viewer
  async function offer(id) {
    drop(id);
    const video = pictureStream();
    if (!video) return;
    const servers = await iceServers();
    if (viewers.has(id)) return;  // a newer offer started meanwhile
    const pc = new RTCPeerConnection({ iceServers: servers });
    const v = { pc, n: ++offers, ready: false, ice: [] };
    viewers.set(id, v);
    for (const t of video.getVideoTracks()) pc.addTrack(t, video);
    if (soundStream) for (const t of soundStream.getAudioTracks()) pc.addTrack(t, video);
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) sendTo(id, { ice: e.candidate.toJSON(), n: v.n }); };
    pc.onconnectionstatechange = () => {
      if (viewers.get(id) !== v) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") drop(id);
      else if (pc.connectionState === "connected") tune(pc);
      showCount();
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      sendTo(id, { type: "offer", sdp: pc.localDescription.sdp, n: v.n });
    } catch (e) {
      if (viewers.get(id) === v) drop(id);
    }
  }

  function drop(id) {
    const v = viewers.get(id);
    if (!v) return;
    viewers.delete(id);
    try { v.pc.close(); } catch (e) {}
    showCount();
  }

  // Keeps each stream at most 720 tall (less work for this computer and the Wi-Fi).
  function tune(pc) {
    const canvas = document.getElementById("canvas");
    const scale = canvas && canvas.height > MAX_HEIGHT ? canvas.height / MAX_HEIGHT : 1;
    for (const sender of pc.getSenders()) {
      if (!sender.track || sender.track.kind !== "video") continue;
      const p = sender.getParameters();
      if (!p.encodings || p.encodings.length === 0) continue;
      const e = p.encodings[0];
      if (e.scaleResolutionDownBy === scale && e.maxBitrate === MAX_BITRATE) continue;
      e.scaleResolutionDownBy = scale;
      e.maxBitrate = MAX_BITRATE;
      e.maxFramerate = FPS;
      sender.setParameters(p).catch(() => {});
    }
  }
  setInterval(() => {  // the window can change size (full screen)
    for (const v of viewers.values()) if (v.pc.connectionState === "connected") tune(v.pc);
  }, 3000);

  // ------------------------------------------------------------ "2 watching"
  // A page element, not part of the game's picture, so viewers don't see it.
  let badge = null;
  function showCount() {
    let n = 0;
    for (const v of viewers.values()) if (v.pc.connectionState === "connected") n++;
    if (!badge) {
      if (!document.body) return;
      badge = document.createElement("div");
      badge.style.cssText = "position:fixed;left:6px;top:4px;z-index:9;font:11px system-ui,sans-serif;" +
        "color:#ebede9;background:rgba(9,10,20,0.55);padding:1px 6px;pointer-events:none;display:none";
      document.body.appendChild(badge);
    }
    badge.textContent = n === 1 ? "1 watching" : `${n} watching`;
    badge.style.display = n > 0 ? "block" : "none";
  }
})();
