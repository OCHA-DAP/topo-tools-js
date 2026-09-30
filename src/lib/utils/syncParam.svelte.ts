import { onMount } from "svelte";
import { getUrlParam, setUrlParam } from "./url";

export interface ParamCodec<T> {
  parse(raw: string): T | undefined;
  format(value: T): string;
}

export const textParam: ParamCodec<string> = {
  parse: (raw) => raw,
  format: (value) => value,
};

export const numberParam: ParamCodec<number> = {
  parse: (raw) => (raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : undefined),
  format: (value) => (Number.isFinite(value) ? String(value) : ""),
};

export const boolParam: ParamCodec<boolean> = {
  parse: (raw) => (raw === "true" ? true : raw === "false" ? false : undefined),
  format: (value) => String(value),
};

export function choiceParam<T extends string>(values: readonly T[]): ParamCodec<T> {
  return {
    parse: (raw) => values.find((v) => v === raw),
    format: (value) => value,
  };
}

// Call during component init: reads `key` on mount, then writes every change, omitting the default.
// Writes are debounced because Safari throttles replaceState during a slider drag.
export function syncParam<T>(
  key: string,
  codec: ParamCodec<T>,
  get: () => T,
  set: (value: T) => void,
): void {
  const initial = codec.format(get());
  onMount(() => {
    const raw = getUrlParam(key);
    const value = raw === null ? undefined : codec.parse(raw);
    if (value !== undefined) set(value);
  });
  $effect(() => {
    const value = codec.format(get());
    const timer = setTimeout(() => setUrlParam(key, value === initial ? null : value), 250);
    return () => clearTimeout(timer);
  });
}
