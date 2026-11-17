/**
 * Generatore QR Code SVG (zero dipendenze, Byte Mode, EC Level L) + Scanner fotocamera.
 */

// GF(256) con polinomio primitivo 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(deg) {
  let poly = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(data.length + ecLen);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Versioni 1..6 EC Level L: [version, size, totalDataCodewords, ecPerBlock, alignmentCenters]
const QR_VERSIONS = [
  [1, 21, 19, 7, []],
  [2, 25, 34, 10, [6, 18]],
  [3, 29, 55, 15, [6, 22]],
  [4, 33, 80, 20, [6, 26]],
  [5, 37, 108, 26, [6, 30]],
  [6, 41, 136, 18, [6, 34]], // 2 blocks of 68 data + 18 ec
];

function encodeByteMode(text) {
  const bytes = new TextEncoder().encode(text);
  let verSpec = QR_VERSIONS.find((v) => bytes.length + 2 <= v[2]);
  if (!verSpec) verSpec = QR_VERSIONS[QR_VERSIONS.length - 1];
  const [ver, size, dataCap, ecLen, align] = verSpec;

  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = dataCap * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    codewords.push(byte);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (codewords.length < dataCap) {
    codewords.push(pads[p++ % 2]);
  }

  let finalBytes = [];
  if (ver === 6) {
    // Version 6-L: 2 blocks of 68 data codewords, 18 EC each
    const b1 = codewords.slice(0, 68);
    const b2 = codewords.slice(68, 136);
    const ec1 = rsRemainder(b1, ecLen);
    const ec2 = rsRemainder(b2, ecLen);
    for (let i = 0; i < 68; i++) {
      finalBytes.push(b1[i], b2[i]);
    }
    for (let i = 0; i < ecLen; i++) {
      finalBytes.push(ec1[i], ec2[i]);
    }
  } else {
    const ec = rsRemainder(codewords, ecLen);
    finalBytes = [...codewords, ...ec];
  }

  return { ver, size, align, finalBytes };
}

function buildMatrix(text) {
  const { size, align, finalBytes } = encodeByteMode(text);
  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const setModule = (r, c, val, isReserved = true) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    grid[r][c] = val;
    if (isReserved) reserved[r][c] = 1;
  };

  const drawFinder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on =
          r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        setModule(rr, cc, on ? 1 : 0, true);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setModule(6, i, i % 2 === 0 ? 1 : 0, true);
    setModule(i, 6, i % 2 === 0 ? 1 : 0, true);
  }

  // Alignment patterns
  for (const r of align) {
    for (const c of align) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const on = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
          setModule(r + dr, c + dc, on ? 1 : 0, true);
        }
      }
    }
  }

  // Format info placeholder + dark module
  setModule(size - 8, 8, 1, true);
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) reserved[8][i] = 1;
    if (!reserved[i][8]) reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][size - 1 - i]) reserved[8][size - 1 - i] = 1;
    if (!reserved[size - 1 - i][8]) reserved[size - 1 - i][8] = 1;
  }

  // Place data bits
  const bitStream = [];
  for (const b of finalBytes) {
    for (let i = 7; i >= 0; i--) bitStream.push((b >> i) & 1);
  }

  let bitIdx = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = up ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (!reserved[r][c]) {
          const bit = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0;
          // Mask 0: (r + c) % 2 === 0
          grid[r][c] = (r + c) % 2 === 0 ? bit ^ 1 : bit;
        }
      }
    }
    up = !up;
  }

  // Format info for EC Level L (01) + Mask 0 (000) -> 15-bit BCH: 0b111011111000100
  const fmt = 0b111011111000100;
  const fmtBits = [];
  for (let i = 14; i >= 0; i--) fmtBits.push((fmt >> i) & 1);

  const coords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const coords2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8],
    [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i++) {
    grid[coords1[i][0]][coords1[i][1]] = fmtBits[i];
    grid[coords2[i][0]][coords2[i][1]] = fmtBits[i];
  }

  return grid;
}

export function renderQrSvg(text, sizePx = 200) {
  const grid = buildMatrix(text);
  const n = grid.length;
  const pad = 2;
  const total = n + pad * 2;
  let paths = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (grid[r][c] === 1) {
        paths += `<rect x="${c + pad}" y="${r + pad}" width="1" height="1"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges">
    <rect width="${total}" height="${total}" rx="2" fill="#FFFFFF"/>
    <g fill="#090B10">${paths}</g>
  </svg>`;
}

export async function startQrScanner(videoEl, onDetect, onError) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    onError('Fotocamera non disponibile su questo browser.');
    return () => {};
  }
  if (!('BarcodeDetector' in window)) {
    onError('Scansione QR nativa non supportata da questo browser: usa la selezione rapida o inserisci il codice.');
    return () => {};
  }

  let stream = null;
  let active = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    videoEl.srcObject = stream;
    await videoEl.play();

    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const tick = async () => {
      if (!active) return;
      try {
        const codes = await detector.detect(videoEl);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          active = false;
          onDetect(codes[0].rawValue);
          return;
        }
      } catch (_) {}
      if (active) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    onError('Permesso fotocamera negato o non disponibile.');
  }

  return () => {
    active = false;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
  };
}
