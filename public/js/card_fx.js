/**
 * Effetto olografico 3D della carta (giroscopio + pointer) e animazione numerica saldo.
 */

export function attachHolographicCard(cardEl) {
  if (!cardEl || cardEl.dataset.holoBound === '1') return;
  cardEl.dataset.holoBound = '1';

  const setTilt = (rx, ry, gx, gy) => {
    cardEl.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    cardEl.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    cardEl.style.setProperty('--gx', `${gx.toFixed(1)}%`);
    cardEl.style.setProperty('--gy', `${gy.toFixed(1)}%`);
  };

  cardEl.addEventListener('pointermove', (e) => {
    const rect = cardEl.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const ry = (x - 0.5) * 14;
    const rx = (0.5 - y) * 12;
    setTilt(rx, ry, x * 100, y * 100);
  });

  cardEl.addEventListener('pointerleave', () => {
    setTilt(0, 0, 50, 50);
  });

  if (window.DeviceOrientationEvent) {
    window.addEventListener('deviceorientation', (e) => {
      if (e.gamma === null || e.beta === null) return;
      const ry = Math.max(-10, Math.min(10, e.gamma * 0.35));
      const rx = Math.max(-10, Math.min(10, (e.beta - 40) * 0.25));
      const gx = 50 + ry * 3;
      const gy = 50 + rx * 3;
      setTilt(rx, ry, gx, gy);
    });
  }
}

export function animateNumber(el, targetValue, currency = '€', duration = 550) {
  if (!el) return;
  const startVal = Number(el.dataset.currentVal ?? targetValue);
  if (startVal === targetValue) {
    el.textContent = `${Number(targetValue).toLocaleString('it-IT')} ${currency}`;
    el.dataset.currentVal = String(targetValue);
    return;
  }

  const startTime = performance.now();
  const diff = targetValue - startVal;

  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const current = Math.round(startVal + diff * eased);
    el.textContent = `${current.toLocaleString('it-IT')} ${currency}`;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.dataset.currentVal = String(targetValue);
    }
  }
  requestAnimationFrame(step);
}
