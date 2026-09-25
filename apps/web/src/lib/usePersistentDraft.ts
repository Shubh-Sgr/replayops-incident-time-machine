import { useCallback, useEffect, useRef, useState } from "react";

type DraftEnvelope<T> = { value: T; savedAt: string };

function readDraft<T>(key: string, fallback: T): DraftEnvelope<T> {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return { value: fallback, savedAt: "" };
    return JSON.parse(stored) as DraftEnvelope<T>;
  } catch {
    return { value: fallback, savedAt: "" };
  }
}

export function usePersistentDraft<T>(key: string, fallback: T) {
  const fallbackRef = useRef(fallback);
  const initial = readDraft(key, fallbackRef.current);
  const [value, setValue] = useState<T>(initial.value);
  const [savedAt, setSavedAt] = useState(initial.savedAt);
  const skipNextPersist = useRef(false);
  const hasMounted = useRef(false);

  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      return;
    }
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    const envelope: DraftEnvelope<T> = { value, savedAt: new Date().toISOString() };
    const handle = window.setTimeout(() => {
      localStorage.setItem(key, JSON.stringify(envelope));
      setSavedAt(envelope.savedAt);
    }, 220);
    return () => window.clearTimeout(handle);
  }, [key, value]);

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key !== key || !event.newValue) return;
      try {
        const envelope = JSON.parse(event.newValue) as DraftEnvelope<T>;
        setValue(envelope.value);
        setSavedAt(envelope.savedAt);
      } catch {
        // A malformed draft is ignored; the current editor content remains intact.
      }
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, [key]);

  const clear = useCallback(() => {
    localStorage.removeItem(key);
    skipNextPersist.current = true;
    setValue(fallbackRef.current);
    setSavedAt("");
  }, [key]);

  return { value, setValue, savedAt, clear };
}
