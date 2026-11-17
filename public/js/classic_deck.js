export const COLOR_GROUPS = {
  marrone: { label: 'Marrone', hex: '#8B4513' },
  azzurro: { label: 'Azzurro', hex: '#5AC8FA' },
  rosa: { label: 'Rosa', hex: '#FF2D55' },
  arancione: { label: 'Arancione', hex: '#FF9500' },
  rosso: { label: 'Rosso', hex: '#FF3B30' },
  giallo: { label: 'Giallo', hex: '#FFCC00' },
  verde: { label: 'Verde', hex: '#34C759' },
  blu: { label: 'Blu', hex: '#0A84FF' },
  stazione: { label: 'Stazione', hex: '#8E8E93' },
  societa: { label: 'Società', hex: '#64D2FF' },
};

const STORAGE_KEY = 'monopoly_pay_custom_deck_v1';

export function saveDeckLocally(deck) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(deck));
}

export function loadLocalDeck() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function getClassicItalianDeckClient() {
  const street = (id, name, colorGroup, price, houseCost, r) => ({
    id,
    name,
    type: 'street',
    colorGroup,
    price,
    mortgageValue: Math.floor(price / 2),
    unmortgageCost: Math.round((price / 2) * 1.1),
    houseCost,
    rents: {
      base: r[0],
      monopoly: r[1],
      house1: r[2],
      house2: r[3],
      house3: r[4],
      house4: r[5],
      hotel: r[6],
    },
  });
  const station = (id, name) => ({
    id,
    name,
    type: 'station',
    colorGroup: 'stazione',
    price: 200,
    mortgageValue: 100,
    unmortgageCost: 110,
    stationRents: { s1: 25, s2: 50, s3: 100, s4: 200 },
  });
  const utility = (id, name) => ({
    id,
    name,
    type: 'utility',
    colorGroup: 'societa',
    price: 150,
    mortgageValue: 75,
    unmortgageCost: 83,
    multipliers: { u1: 4, u2: 10 },
  });

  return [
    street('vicolo_corto', 'Vicolo Corto', 'marrone', 60, 50, [2, 4, 10, 30, 90, 160, 250]),
    street('vicolo_stretto', 'Vicolo Stretto', 'marrone', 60, 50, [4, 8, 20, 60, 180, 320, 450]),
    street('bastioni_gran_sasso', 'Bastioni Gran Sasso', 'azzurro', 100, 50, [6, 12, 30, 90, 270, 400, 550]),
    street('viale_monterosa', 'Viale Monterosa', 'azzurro', 100, 50, [6, 12, 30, 90, 270, 400, 550]),
    street('viale_vesuvio', 'Viale Vesuvio', 'azzurro', 120, 50, [8, 16, 40, 100, 300, 450, 600]),
    street('via_accademia', 'Via Accademia', 'rosa', 140, 100, [10, 20, 50, 150, 450, 625, 750]),
    street('corso_ateneo', 'Corso Ateneo', 'rosa', 140, 100, [10, 20, 50, 150, 450, 625, 750]),
    street('piazza_universita', 'Piazza Università', 'rosa', 160, 100, [12, 24, 60, 180, 500, 700, 900]),
    street('via_verdi', 'Via Verdi', 'arancione', 180, 100, [14, 28, 70, 200, 550, 750, 950]),
    street('corso_raffaello', 'Corso Raffaello', 'arancione', 180, 100, [14, 28, 70, 200, 550, 750, 950]),
    street('piazza_dante', 'Piazza Dante', 'arancione', 200, 100, [16, 32, 80, 220, 600, 800, 1000]),
    street('via_marco_polo', 'Via Marco Polo', 'rosso', 220, 150, [18, 36, 90, 250, 700, 875, 1050]),
    street('corso_magellano', 'Corso Magellano', 'rosso', 220, 150, [18, 36, 90, 250, 700, 875, 1050]),
    street('largo_colombo', 'Largo Colombo', 'rosso', 240, 150, [20, 40, 100, 300, 750, 925, 1100]),
    street('viale_costantino', 'Viale Costantino', 'giallo', 260, 150, [22, 44, 110, 330, 800, 975, 1150]),
    street('viale_traiano', 'Viale Traiano', 'giallo', 260, 150, [22, 44, 110, 330, 800, 975, 1150]),
    street('piazza_giulio_cesare', 'Piazza Giulio Cesare', 'giallo', 280, 150, [24, 48, 120, 360, 850, 1025, 1200]),
    street('via_roma', 'Via Roma', 'verde', 300, 200, [26, 52, 130, 390, 900, 1100, 1275]),
    street('corso_impero', 'Corso Impero', 'verde', 300, 200, [26, 52, 130, 390, 900, 1100, 1275]),
    street('largo_augusto', 'Largo Augusto', 'verde', 320, 200, [28, 56, 150, 450, 1000, 1200, 1400]),
    street('viale_dei_giardini', 'Viale dei Giardini', 'blu', 350, 200, [35, 70, 175, 500, 1100, 1300, 1500]),
    street('parco_della_vittoria', 'Parco della Vittoria', 'blu', 400, 200, [50, 100, 200, 600, 1400, 1700, 2000]),
    station('stazione_sud', 'Stazione Sud'),
    station('stazione_ovest', 'Stazione Ovest'),
    station('stazione_nord', 'Stazione Nord'),
    station('stazione_est', 'Stazione Est'),
    utility('societa_elettrica', 'Società Elettrica'),
    utility('societa_acqua', 'Società Acqua Potabile'),
  ];
}
