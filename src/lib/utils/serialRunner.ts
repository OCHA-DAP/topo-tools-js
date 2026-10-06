// Runs `task` now, or once more after the in-flight run ends; overlapping requests coalesce.
export function serialRunner(task: () => Promise<void>): () => void {
  let active = false;
  let pending = false;
  return async () => {
    if (active) {
      pending = true;
      return;
    }
    active = true;
    try {
      do {
        pending = false;
        await task();
      } while (pending);
    } finally {
      active = false;
    }
  };
}
