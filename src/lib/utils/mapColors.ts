// HDX token values from src/styles/hdx-tokens.css; MapLibre paint properties can't read CSS variables.
export const MAP_COLORS = {
  original: "#7dc1ad", // brand-3
  result: "#a3c0ef", // primary-2
  outline: "#1f2324", // neutral-9
  overlap: "#c44536", // error-5
  gap: "#d48f2a", // warning-5
  micro: "#3f4748", // neutral-8
  notch: "#0e3b82", // primary-7
  selected: "#1862d8", // primary-5
  fallback: "#7e8e8f", // neutral-6
  water: "#d1e0f7", // primary-1
  land: "#f5f7f7", // neutral-05
} as const;

export const MAP_FILL_OPACITY = 0.8;
