/** Secrets are not present in wrangler.jsonc, so augment the generated binding interface. */
interface Env {
  OPENAI_API_KEY: string;
}
