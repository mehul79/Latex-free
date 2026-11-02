export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}/api${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error ?? "Could not reach your workspace. Please try again.",
      response.status,
      data,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
