import { useEffect, useState } from 'react';
import { fetchAzureAvailability } from '../lib/voices';

/**
 * Reports whether the backend has Azure Neural voices configured.
 * Returns `null` while the check is in flight, then `true` / `false`.
 */
export function useAzureVoices(): boolean | null {
    const [isAzureAvailable, setIsAzureAvailable] = useState<boolean | null>(null);

    useEffect(() => {
        let isCancelled = false;
        fetchAzureAvailability().then(available => {
            if (!isCancelled) setIsAzureAvailable(available);
        });
        return () => { isCancelled = true; };
    }, []);

    return isAzureAvailable;
}

export default useAzureVoices;
