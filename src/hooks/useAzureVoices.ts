import { useEffect, useState } from 'react';
import { fetchAzureAvailability, getCachedAzureAvailability } from '../lib/voices';

/**
 * Reports whether the backend has Azure Neural voices configured.
 * Returns `null` while the check is in flight, then `true` / `false`.
 */
export function useAzureVoices(): boolean | null {
    // Start from the cached answer so views mounted later (ReaderView) know it immediately.
    const [isAzureAvailable, setIsAzureAvailable] = useState<boolean | null>(getCachedAzureAvailability);

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
