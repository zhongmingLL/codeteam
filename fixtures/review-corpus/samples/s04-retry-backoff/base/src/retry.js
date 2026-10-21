export const DEFAULT_ATTEMPTS = 3;

export async function retry(operation, attempts = DEFAULT_ATTEMPTS) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
