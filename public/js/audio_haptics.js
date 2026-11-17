/**
 * Sintesi suoni stile Apple Pay (Web Audio API) e feedback aptico (Vibration API).
 */

let audioCtx = null;

function getCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export function triggerHaptic(pattern = [20]) {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(pattern);
    } catch (_) {}
  }
}

export function playPaySuccessSound() {
  triggerHaptic([15, 40, 25]);
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;

  // Doppio chime cristallino stile Apple Pay
  const freqs = [1046.5, 1318.5]; // C6 -> E6
  freqs.forEach((f, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f, now + idx * 0.09);

    gain.gain.setValueAtTime(0.001, now + idx * 0.09);
    gain.gain.exponentialRampToValueAtTime(0.18, now + idx * 0.09 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.09 + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + idx * 0.09);
    osc.stop(now + idx * 0.09 + 0.38);
  });
}

export function playBankAlertSound() {
  triggerHaptic([30, 30, 30]);
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;

  [587.33, 880].forEach((f, idx) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f, now + idx * 0.1);
    gain.gain.setValueAtTime(0.001, now + idx * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.12, now + idx * 0.1 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.1 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + idx * 0.1);
    osc.stop(now + idx * 0.1 + 0.3);
  });
}

export function playErrorSound() {
  triggerHaptic([50, 40, 50]);
  const ctx = getCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(180, now);
  osc.frequency.linearRampToValueAtTime(130, now + 0.18);
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.24);
}
