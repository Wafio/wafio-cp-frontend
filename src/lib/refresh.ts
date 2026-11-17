export function coalesceAsync(job: () => Promise<void>): (key: string) => Promise<void> {
  let active: Promise<void> | null = null;
  let activeKey: string | null = null;
  let nextKey: string | null = null;

  return (key) => {
    if (!active) {
      activeKey = key;
      active = (async () => {
        try {
          for (;;) {
            await job();
            if (nextKey === null) break;
            activeKey = nextKey;
            nextKey = null;
          }
        } finally {
          active = null;
          activeKey = null;
          nextKey = null;
        }
      })();
    } else {
      nextKey = key === activeKey ? null : key;
    }
    return active;
  };
}
