//! Node bindings for `wavekat-vad`.
//!
//! Exposes a single class `Vad` that wraps any `wavekat-vad` backend
//! (currently WebRTC default and TEN-VAD optional). Designed for use in voice
//! pipelines where audio arrives in arbitrary chunk sizes — the underlying
//! `FrameAdapter` buffers samples until the backend's required frame size is
//! reached and only then runs inference.
//!
//! Sample shape: PCM 16-bit signed little-endian, single channel. The Buffer
//! passed to `process()` should contain `i16` samples (so 320 bytes = 160
//! samples = 10ms @ 16kHz).

#![deny(clippy::all)]

use napi::bindgen_prelude::Buffer;
use napi::Result;
use napi_derive::napi;

use wavekat_vad::backends::ten_vad::TenVad;
use wavekat_vad::backends::webrtc::{WebRtcVad, WebRtcVadMode};
use wavekat_vad::{FrameAdapter, VoiceActivityDetector};

/// Backend selector exposed to JS as a string enum.
#[napi(string_enum)]
pub enum VadBackend {
  /// Google's WebRTC VAD. Binary 0/1 output. ~3µs / frame. Sample rates 8/16/32/48 kHz.
  Webrtc,
  /// Agora's TEN-VAD. Continuous probability. ~62µs / frame. 16 kHz only.
  TenVad,
}

/// Aggressiveness for the WebRTC backend (Quality .. VeryAggressive).
#[napi(string_enum)]
pub enum WebRtcMode {
  Quality,
  LowBitrate,
  Aggressive,
  VeryAggressive,
}

impl WebRtcMode {
  fn into_inner(self) -> WebRtcVadMode {
    match self {
      WebRtcMode::Quality => WebRtcVadMode::Quality,
      WebRtcMode::LowBitrate => WebRtcVadMode::LowBitrate,
      WebRtcMode::Aggressive => WebRtcVadMode::Aggressive,
      WebRtcMode::VeryAggressive => WebRtcVadMode::VeryAggressive,
    }
  }
}

/// Voice activity detector handle.
///
/// ```js
/// const { Vad, WebRtcMode } = require('@kuralle-agents/wavekat-vad-node');
/// const vad = Vad.webrtc(16000, WebRtcMode.Quality);
/// const ten = Vad.tenVad(); // 16 kHz fixed
/// const probability = vad.process(pcmBuffer); // 0..1 (or null until first frame is full)
/// ```
#[napi]
pub struct Vad {
  inner: FrameAdapter,
  sample_rate: u32,
  backend: VadBackend,
}

#[napi]
impl Vad {
  /// Create a WebRTC-backed VAD. `sampleRate` must be 8000, 16000, 32000 or 48000.
  /// `frameDurationMs` defaults to 30; allowed values are 10, 20, 30.
  #[napi(factory)]
  pub fn webrtc(
    sample_rate: u32,
    mode: WebRtcMode,
    frame_duration_ms: Option<u32>,
  ) -> Result<Self> {
    let detector: Box<dyn VoiceActivityDetector> = match frame_duration_ms {
      Some(ms) => Box::new(
        WebRtcVad::with_frame_duration(sample_rate, mode.into_inner(), ms)
          .map_err(|e| napi::Error::from_reason(format!("WebRtcVad init: {e}")))?,
      ),
      None => Box::new(
        WebRtcVad::new(sample_rate, mode.into_inner())
          .map_err(|e| napi::Error::from_reason(format!("WebRtcVad init: {e}")))?,
      ),
    };
    Ok(Self {
      inner: FrameAdapter::new(detector),
      sample_rate,
      backend: VadBackend::Webrtc,
    })
  }

  /// Create a TEN-VAD-backed VAD. Always 16 kHz, 16ms frames.
  #[napi(factory)]
  pub fn ten_vad() -> Result<Self> {
    let detector: Box<dyn VoiceActivityDetector> = Box::new(
      TenVad::new().map_err(|e| napi::Error::from_reason(format!("TenVad init: {e}")))?,
    );
    Ok(Self {
      inner: FrameAdapter::new(detector),
      sample_rate: 16000,
      backend: VadBackend::TenVad,
    })
  }

  /// Process a PCM 16-bit LE buffer and return the speech probability of the
  /// most recently completed frame. Returns `null` if not enough samples have
  /// arrived to fill a frame yet.
  #[napi]
  pub fn process(&mut self, pcm: Buffer) -> Result<Option<f64>> {
    if pcm.len() % 2 != 0 {
      return Err(napi::Error::from_reason(
        "PCM buffer length must be a multiple of 2 bytes (i16 samples)",
      ));
    }
    let bytes: &[u8] = pcm.as_ref();
    let mut samples = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
      let lo = bytes[i] as i16;
      let hi = bytes[i + 1] as i16;
      samples.push((hi << 8) | (lo & 0x00ff));
      i += 2;
    }
    // FrameAdapter::process returns Some(prob) only when a full frame was completed.
    let prob = self
      .inner
      .process(&samples, self.sample_rate)
      .map_err(|e| napi::Error::from_reason(format!("vad process: {e}")))?;
    Ok(prob.map(|p| p as f64))
  }

  /// Required frame size in samples for the underlying backend.
  #[napi(getter)]
  pub fn frame_size(&self) -> u32 {
    self.inner.capabilities().frame_size as u32
  }

  /// Required frame duration in milliseconds.
  #[napi(getter)]
  pub fn frame_duration_ms(&self) -> u32 {
    self.inner.capabilities().frame_duration_ms as u32
  }

  /// Currently configured sample rate.
  #[napi(getter)]
  pub fn sample_rate(&self) -> u32 {
    self.sample_rate
  }

  /// Backend identifier.
  #[napi(getter)]
  pub fn backend(&self) -> VadBackend {
    self.backend
  }
}
