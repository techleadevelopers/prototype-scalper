const API_URL = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, "") ?? "";

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_URL}${normalizedPath}`;
}
