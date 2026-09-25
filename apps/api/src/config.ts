import "dotenv/config";

const booleanValue = (value: string | undefined, fallback: boolean) => value === undefined ? fallback : value.toLowerCase() === "true";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  databaseUrl: process.env.DATABASE_URL,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  demoMode: booleanValue(process.env.ENABLE_DEMO_MODE, true),
  openAiKey: process.env.OPENAI_API_KEY,
  openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  chatModel: process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini",
  embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  googleAiKey: process.env.GOOGLE_AI_API_KEY,
  googleChatModel: process.env.GOOGLE_AI_CHAT_MODEL ?? "gemini-3.8-flash",
  googleEmbeddingModel: process.env.GOOGLE_AI_EMBEDDING_MODEL ?? "gemini-embedding-2",
  publicApiUrl: process.env.PUBLIC_API_URL?.replace(/\/$/, ""),
  ingestionSigningSecret: process.env.INGESTION_SIGNING_SECRET,
  publicWebUrl: process.env.PUBLIC_WEB_URL?.replace(/\/$/, ""),
  resendApiKey: process.env.RESEND_API_KEY,
  inviteFromEmail: process.env.INVITE_FROM_EMAIL,
  replayTargetBaseUrl: process.env.REPLAY_TARGET_BASE_URL?.replace(/\/$/, "")
};
