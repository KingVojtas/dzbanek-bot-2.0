// Loads variables from a local .env file (if present) into process.env using
// Node's built-in loader — no `dotenv` dependency needed.
try {
  process.loadEnvFile();
} catch {
  // No .env file found; assume the variables are provided by the environment.
}
