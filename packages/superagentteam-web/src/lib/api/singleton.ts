import { createApiClient } from "./client.ts";
import { getCsrfToken } from "./token.ts";

export const api = createApiClient({ getCsrfToken });
