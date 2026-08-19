/**
 * Offline timeline export via WebCodecs + webm-muxer.
 * Works when the tab is backgrounded or the window is minimized (no RAF / video.play).
 */
(function (global) {
  "use strict";

  const AUDIO_SAMPLE_RATE = 48000;
  const AUDIO_CHANNELS = 2;
  const AUDIO_BITRATE = 128000;
  const ENCODE_QUEUE_LIMIT = 6;
  const YIELD_EVERY_FRAMES = 8;

  function yieldToMain() {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(null);
    });
  }

  function waitEncoderDequeue(encoder) {
    if (encoder.encodeQueueSize <= ENCODE_QUEUE_LIMIT) return Promise.resolve();
    return new Promise((resolve) => {
      const onDequeue = () => {
        if (encoder.encodeQueueSize <= ENCODE_QUEUE_LIMIT) {
          encoder.removeEventListener("dequeue", onDequeue);
          resolve();
        }
      };
      encoder.addEventListener("dequeue", onDequeue);
    });
  }

  function canOfflineExport() {
    if (typeof global.VideoEncoder === "undefined") return false;
    if (typeof global.AudioEncoder === "undefined") return false;
    if (typeof global.VideoFrame === "undefined") return false;
    if (typeof global.OfflineAudioContext === "undefined") return false;
    if (!global.WebMMuxer || !global.WebMMuxer.Muxer) return false;
    return true;
  }

  async function pickVideoCodecAsync(width, height, fps) {
    const candidates = [
      { codec: "vp09.00.10.08", muxCodec: "V_VP9" },
      { codec: "vp8", muxCodec: "V_VP8" },
    ];
    for (const c of candidates) {
      const support = await VideoEncoder.isConfigSupported({
        codec: c.codec,
        width,
        height,
        bitrate: Math.min(
          8_000_000,
          Math.max(2_500_000, width * height * fps * 0.12)
        ),
        framerate: fps,
      });
      if (support && support.supported) return c;
    }
    return null;
  }

  async function pickAudioCodecAsync() {
    const support = await AudioEncoder.isConfigSupported({
      codec: "opus",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: AUDIO_BITRATE,
    });
    return support && support.supported ? "opus" : null;
  }

  function computeTotalDuration(plan) {
    let maxEnd = 0;
    (plan.videoSegments || []).forEach((s) => {
      maxEnd = Math.max(maxEnd, Number(s.gEnd) || 0);
    });
    (plan.audioSegments || []).forEach((s) => {
      maxEnd = Math.max(maxEnd, Number(s.gEnd) || 0);
    });
    return Math.max(0.05, maxEnd);
  }

  function findVideoSegmentAt(segments, t) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (t >= seg.gStart && t < seg.gEnd) return seg;
    }
    return null;
  }

  async function decodeAudioUrl(url, cache, signal) {
    if (cache.has(url)) return cache.get(url);
    if (signal && signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("audio fetch failed");
    const arrayBuffer = await resp.arrayBuffer();
    const Ctx = global.AudioContext || global.webkitAudioContext;
    const decodeCtx = new Ctx();
    try {
      const buffer = await decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      cache.set(url, buffer);
      return buffer;
    } finally {
      try {
        decodeCtx.close();
      } catch (_) {}
    }
  }

  async function renderOfflineAudioMix(audioSegments, totalDurationSec, signal) {
    if (!audioSegments || !audioSegments.length) return null;
    const length = Math.ceil(totalDurationSec * AUDIO_SAMPLE_RATE);
    if (length <= 0) return null;

    const offlineCtx = new OfflineAudioContext(
      AUDIO_CHANNELS,
      length,
      AUDIO_SAMPLE_RATE
    );
    const cache = new Map();
    let scheduled = 0;

    for (const seg of audioSegments) {
      if (signal && signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (!seg.playUrl) continue;
      const dur = Math.max(0, Number(seg.duration) || seg.gEnd - seg.gStart);
      if (dur < 0.01) continue;
      try {
        const buffer = await decodeAudioUrl(seg.playUrl, cache, signal);
        const source = offlineCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(offlineCtx.destination);
        const when = Math.max(0, Number(seg.gStart) || 0);
        const offset = Math.max(0, Number(seg.srcIn) || 0);
        source.start(when, offset, dur);
        scheduled++;
      } catch (e) {
        console.warn("[export-offline] audio segment skipped", seg.playUrl, e);
      }
    }

    if (!scheduled) return null;
    return offlineCtx.startRendering();
  }

  function audioBufferToAudioData(buffer, offsetFrames, frameCount, timestampUs) {
    const ch0 = buffer.getChannelData(0);
    const ch1 =
      buffer.numberOfChannels > 1
        ? buffer.getChannelData(1)
        : buffer.getChannelData(0);
    const planar = new Float32Array(frameCount * AUDIO_CHANNELS);
    for (let i = 0; i < frameCount; i++) {
      planar[i] = ch0[offsetFrames + i];
      planar[frameCount + i] = ch1[offsetFrames + i];
    }
    return new AudioData({
      format: "f32-planar",
      sampleRate: AUDIO_SAMPLE_RATE,
      numberOfFrames: frameCount,
      numberOfChannels: AUDIO_CHANNELS,
      timestamp: timestampUs,
      data: planar,
    });
  }

  async function encodeAudioTrack(rendered, audioEncoder, signal) {
    if (!rendered || !audioEncoder) return;
    const samplesPerChunk = 1024;
    const totalFrames = rendered.length;
    for (let offset = 0; offset < totalFrames; offset += samplesPerChunk) {
      if (signal && signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const frames = Math.min(samplesPerChunk, totalFrames - offset);
      const timestampUs = Math.round((offset / AUDIO_SAMPLE_RATE) * 1e6);
      const audioData = audioBufferToAudioData(
        rendered,
        offset,
        frames,
        timestampUs
      );
      await waitEncoderDequeue(audioEncoder);
      audioEncoder.encode(audioData);
      audioData.close();
      if (offset % (samplesPerChunk * 32) === 0) await yieldToMain();
    }
    await audioEncoder.flush();
  }

  async function encodeVideoTrack(
    plan,
    video,
    ctx,
    canvas,
    videoEncoder,
    helpers,
    signal,
    onProgress
  ) {
    const fps = Math.max(1, Number(plan.fps) || 24);
    const segments = (plan.videoSegments || []).filter((s) => s.duration > 0);
    const totalDuration = computeTotalDuration(plan);
    const totalFrames = Math.max(1, Math.ceil(totalDuration * fps));
    const frameDurationUs = Math.round(1e6 / fps);
    const keyFrameInterval = Math.max(1, Math.round(fps * 2));

    const { loadVideo, seekVideo, drawFrame } = helpers;
    let currentUrl = null;
    let lastSeekTime = -Infinity;
    const seekThreshold = 0.5 / fps;

    for (let i = 0; i < totalFrames; i++) {
      if (signal && signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const t = i / fps;
      const seg = findVideoSegmentAt(segments, t);

      if (!seg || seg.kind === "gap" || !seg.playUrl) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        const srcTime = (Number(seg.srcIn) || 0) + (t - seg.gStart);
        if (seg.playUrl !== currentUrl) {
          await loadVideo(video, seg.playUrl, signal);
          currentUrl = seg.playUrl;
          lastSeekTime = -Infinity;
        }
        if (Math.abs(lastSeekTime - srcTime) >= seekThreshold) {
          await seekVideo(video, srcTime, signal);
          lastSeekTime = srcTime;
        }
        drawFrame(ctx, video, canvas.width, canvas.height);
      }

      const timestamp = i * frameDurationUs;
      const frame = new VideoFrame(canvas, {
        timestamp,
        duration: frameDurationUs,
      });

      await waitEncoderDequeue(videoEncoder);
      videoEncoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
      frame.close();

      if (onProgress) {
        onProgress({
          phase: "video",
          frame: i + 1,
          totalFrames,
          ratio: (i + 1) / totalFrames,
        });
      }

      if (i > 0 && i % YIELD_EVERY_FRAMES === 0) await yieldToMain();
    }

    await videoEncoder.flush();
  }

  /**
   * @param {object} plan - from buildExportPlan()
   * @param {object} options
   * @param {AbortSignal} [options.signal]
   * @param {function} [options.onProgress]
   * @param {function} options.loadVideo(video, url, signal)
   * @param {function} options.seekVideo(video, timeSec, signal)
   * @param {function} options.drawFrame(ctx, video, w, h)
   * @returns {Promise<Blob>}
   */
  async function encodeTimelineWebm(plan, options) {
    if (!canOfflineExport()) {
      throw new Error("Offline export not supported in this browser");
    }

    const signal = options && options.signal;
    const onProgress = options && options.onProgress;
    const helpers = {
      loadVideo: options.loadVideo,
      seekVideo: options.seekVideo,
      drawFrame: options.drawFrame,
    };
    if (
      !helpers.loadVideo ||
      !helpers.seekVideo ||
      !helpers.drawFrame
    ) {
      throw new Error("Missing video helpers for offline export");
    }

    const { Muxer, ArrayBufferTarget } = global.WebMMuxer;
    const width = Math.max(2, Number(plan.width) || 1280);
    const height = Math.max(2, Number(plan.height) || 720);
    const fps = Math.max(1, Number(plan.fps) || 24);
    const totalDuration = computeTotalDuration(plan);
    const hasAudio = !!(plan.audioSegments && plan.audioSegments.length);

    const videoCodec = await pickVideoCodecAsync(width, height, fps);
    if (!videoCodec) throw new Error("No supported video codec");

    const audioCodecStr = hasAudio ? await pickAudioCodecAsync() : null;
    if (hasAudio && !audioCodecStr) {
      console.warn("[export-offline] Opus not supported; exporting video only");
    }

    const target = new ArrayBufferTarget();
    const muxerOptions = {
      target,
      video: {
        codec: videoCodec.muxCodec,
        width,
        height,
        frameRate: fps,
      },
      firstTimestampBehavior: "offset",
    };
    if (hasAudio && audioCodecStr) {
      muxerOptions.audio = {
        codec: "A_OPUS",
        numberOfChannels: AUDIO_CHANNELS,
        sampleRate: AUDIO_SAMPLE_RATE,
      };
    }
    const muxer = new Muxer(muxerOptions);

    let wakeLock = null;
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (_) {}

    let videoEncoder = null;
    let audioEncoder = null;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.style.cssText =
      "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(video);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Canvas 2D unavailable");

    try {
      videoEncoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: (e) => {
          console.error("[export-offline] video encoder", e);
        },
      });
      videoEncoder.configure({
        codec: videoCodec.codec,
        width,
        height,
        bitrate: Math.min(
          8_000_000,
          Math.max(2_500_000, width * height * fps * 0.12)
        ),
        framerate: fps,
        latencyMode: "quality",
      });

      if (hasAudio && audioCodecStr) {
        audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (e) => {
            console.error("[export-offline] audio encoder", e);
          },
        });
        audioEncoder.configure({
          codec: audioCodecStr,
          sampleRate: AUDIO_SAMPLE_RATE,
          numberOfChannels: AUDIO_CHANNELS,
          bitrate: AUDIO_BITRATE,
        });
      }

      if (onProgress) {
        onProgress({ phase: "audio", ratio: 0 });
      }

      const audioMixPromise =
        hasAudio && audioCodecStr
          ? renderOfflineAudioMix(plan.audioSegments, totalDuration, signal)
          : Promise.resolve(null);

      await encodeVideoTrack(
        plan,
        video,
        ctx,
        canvas,
        videoEncoder,
        helpers,
        signal,
        onProgress
      );

      if (signal && signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (onProgress) {
        onProgress({ phase: "audio", ratio: 0.5 });
      }

      const renderedAudio = await audioMixPromise;
      if (renderedAudio && audioEncoder) {
        await encodeAudioTrack(renderedAudio, audioEncoder, signal);
      }

      if (onProgress) {
        onProgress({ phase: "finish", ratio: 1 });
      }

      muxer.finalize();
      const buffer = target.buffer;
      if (!buffer || !buffer.byteLength) {
        throw new Error("Export produced empty file");
      }
      return new Blob([buffer], { type: "video/webm" });
    } finally {
      try {
        video.pause();
      } catch (_) {}
      video.removeAttribute("src");
      try {
        video.load();
      } catch (_) {}
      video.remove();
      if (videoEncoder && videoEncoder.state !== "closed") {
        try {
          videoEncoder.close();
        } catch (_) {}
      }
      if (audioEncoder && audioEncoder.state !== "closed") {
        try {
          audioEncoder.close();
        } catch (_) {}
      }
      if (wakeLock) {
        try {
          wakeLock.release();
        } catch (_) {}
      }
    }
  }

  global.VflowOfflineExport = {
    canOfflineExport,
    encodeTimelineWebm,
  };
})(typeof window !== "undefined" ? window : globalThis);
