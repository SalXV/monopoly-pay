export const TOKENS = [
  { id: 'cane', label: 'Cane', emoji: '🐕' },
  { id: 'cilindro', label: 'Cilindro', emoji: '🎩' },
  { id: 'auto', label: 'Auto', emoji: '🏎️' },
  { id: 'nave', label: 'Nave', emoji: '🚢' },
  { id: 'ferro', label: 'Ferro da stiro', emoji: '🧺' },
  { id: 'ditale', label: 'Ditale', emoji: '🪡' },
  { id: 'carriola', label: 'Carriola', emoji: '🛒' },
  { id: 'scarpa', label: 'Scarpa', emoji: '👞' },
];

export const CARD_COLORS = [
  { id: '#0A84FF', name: 'Blu Apple', gradient: 'linear-gradient(135deg, #0A84FF 0%, #5E5CE6 100%)' },
  { id: '#30D158', name: 'Verde Smeraldo', gradient: 'linear-gradient(135deg, #30D158 0%, #00A86B 100%)' },
  { id: '#BF5AF2', name: 'Viola Revolut', gradient: 'linear-gradient(135deg, #BF5AF2 0%, #5E5CE6 100%)' },
  { id: '#FF9F0A', name: 'Oro Ambra', gradient: 'linear-gradient(135deg, #FF9F0A 0%, #FF375F 100%)' },
  { id: '#FF375F', name: 'Rosso Rubino', gradient: 'linear-gradient(135deg, #FF375F 0%, #9E1B32 100%)' },
  { id: '#64D2FF', name: 'Ciano Ghiaccio', gradient: 'linear-gradient(135deg, #007AFF 0%, #64D2FF 100%)' },
  { id: '#2C2C2E', name: 'Titanio Nero', gradient: 'linear-gradient(135deg, #3A3A3C 0%, #1C1C1E 100%)' },
];

export function getTokenInfo(tokenId) {
  return TOKENS.find((t) => t.id === tokenId) || TOKENS[0];
}

export function getCardGradient(colorHex) {
  const found = CARD_COLORS.find((c) => c.id === colorHex);
  return found ? found.gradient : `linear-gradient(135deg, ${colorHex || '#0A84FF'} 0%, #1C1C2E 100%)`;
}

export function tokenBadgeSvg(tokenId) {
  const info = getTokenInfo(tokenId);
  return `<span class="token-emoji" aria-label="${info.label}">${info.emoji}</span>`;
}
