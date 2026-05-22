const API_URL = import.meta.env.VITE_API_URL as string;
const API_SECRET = import.meta.env.VITE_API_SECRET as string | undefined;

function authHeaders(): Record<string, string> {
    return API_SECRET ? { Authorization: `Bearer ${API_SECRET}` } : {};
}

export function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = { ...authHeaders(), ...(init.headers as Record<string, string> ?? {}) };
    return fetch(`${API_URL}${path}`, { ...init, headers });
}
