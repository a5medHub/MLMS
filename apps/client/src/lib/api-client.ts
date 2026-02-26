const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:4000/api/v1" : "/api/v1");

export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  accessToken?: string | null;
};

export const requestJson = async <TResponse>(
  path: string,
  options: RequestOptions = {}
): Promise<TResponse> => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: string }; [key: string]: unknown }
    | null;

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error?.message ?? "Request failed");
  }

  return payload as TResponse;
};

export const getApiBaseUrl = (): string => API_BASE_URL;
