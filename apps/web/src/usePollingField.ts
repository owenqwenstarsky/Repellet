import { useEffect, useRef, useState } from 'react';

// Follow server updates only while a field still matches its last server value.
export function usePollingField<T>(remote: T) {
  const [value, setValue] = useState(remote);
  const previous = useRef(remote);
  useEffect(() => {
    const old = previous.current;
    setValue((current) => (JSON.stringify(current) === JSON.stringify(old) ? remote : current));
    previous.current = remote;
  }, [remote]);
  return [value, setValue] as const;
}
