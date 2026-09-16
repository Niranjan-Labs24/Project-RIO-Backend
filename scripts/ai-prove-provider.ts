// Proves which model actually answered — not which one the config claims.
//
//   pnpm ai:prove
//
// Four independent checks, strongest last:
//   1  what the config says
//   2  the RAW upstream payload, which carries the model id and a
//      provider-specific envelope shape Gemini cannot produce
//   3  sabotage the OCI key: if OCI is really the path, every call must now
//      fail rather than quietly succeed from somewhere else
//   4  the same task against Gemini, so the two envelopes sit side by side
//
// Read-only apart from in-memory config edits, which are discarded on exit.

import 'dotenv/config';
import { ConfigService } from '../src/config/config.service';
import { AiService } from '../src/modules/ai/ai.service';
import { NEED_CLASSIFICATION_TASK } from '../src/modules/ai/prompts/need-classification.task';

const DOMAINS = JSON.stringify([
  { name: 'Health', subDomains: [{ name: 'Access to Basic Healthcare' }] },
  { name: 'Water & Sanitation', subDomains: [{ name: 'Drinking Water' }] },
]);
const PROMPT =
  `Available domains: ${DOMAINS}\n\n` +
  'Need statement: "The village has no clean drinking water during the summer months."';

function heading(text: string): void {
  console.log(`\n${'─'.repeat(76)}\n${text}\n${'─'.repeat(76)}`);
}

/** Overrides one config getter in memory for the length of this process. */
function override(config: ConfigService, key: string, value: unknown): void {
  Object.defineProperty(config, key, { get: () => value, configurable: true });
}

async function main(): Promise<void> {
  const config = new ConfigService();
  const ai = new AiService(config);

  // ── 1. what the configuration claims ─────────────────────────────────
  heading('1. Configuration');
  console.log(`  AI_PROVIDER            ${config.aiProvider}`);
  console.log(`  OCI_GENAI_MODEL_ID     ${config.ociGenAiModelId}`);
  console.log(`  OCI_GENAI_REGION       ${config.ociGenAiRegion}`);
  console.log(`  OCI endpoint           ${config.ociGenAiChatUrl}`);
  console.log(`  GEMINI_API_KEY set?    ${config.geminiApiKey ? 'yes' : 'no'}`);
  console.log('\n  Config is a claim, not proof. The next check is the evidence.');

  // ── 2. the raw upstream payload ──────────────────────────────────────
  heading('2. Raw upstream response (the actual evidence)');
  const { response, raw } = await ai.run(NEED_CLASSIFICATION_TASK, PROMPT);
  const envelope = raw as Record<string, unknown>;

  console.log(JSON.stringify(envelope, null, 2).slice(0, 900));

  const modelId = typeof envelope.modelId === 'string' ? envelope.modelId : null;
  const isCohereShape =
    typeof envelope.chatResponse === 'object' && envelope.chatResponse !== null;
  const isGeminiShape = Array.isArray(envelope.candidates);

  console.log('\n  Verdict:');
  console.log(`    modelId field          ${modelId ?? '(absent)'}`);
  console.log(`    Cohere envelope        ${isCohereShape ? 'YES — has chatResponse' : 'no'}`);
  console.log(`    Gemini envelope        ${isGeminiShape ? 'YES — has candidates[]' : 'no'}`);
  console.log(`    parsed answer          ${JSON.stringify(response).slice(0, 100)}`);

  if (modelId === 'cohere.command-a-03-2025' && isCohereShape && !isGeminiShape) {
    console.log('\n  ==> Cohere Command A answered. Gemini cannot produce this shape.');
  } else if (isGeminiShape) {
    console.log('\n  ==> GEMINI answered, not Cohere.');
  } else {
    console.log('\n  ==> Unrecognised envelope — inspect the payload above.');
  }

  // ── 3. sabotage the OCI key ──────────────────────────────────────────
  heading('3. Break the OCI key on purpose');
  console.log('  If OCI is genuinely the path, every call must now fail.');
  console.log('  If something else were quietly serving these, it would still succeed.\n');
  override(config, 'ociGenAiApiKey', 'sk-deliberately-invalid-key');
  try {
    await ai.run(NEED_CLASSIFICATION_TASK, PROMPT);
    console.log('  !! STILL SUCCEEDED — the answer did NOT come from OCI.');
  } catch (err) {
    console.log(`  Failed as expected: ${err instanceof Error ? err.message.slice(0, 150) : String(err)}`);
    console.log('  ==> Confirms the call really goes to OCI.');
  }
  override(config, 'ociGenAiApiKey', process.env.OCI_GENAI_API_KEY);

  // ── 4. the same task against Gemini, for contrast ────────────────────
  heading('4. The same task on Gemini, for comparison');
  if (!config.geminiApiKey) {
    console.log('  GEMINI_API_KEY is not set, so Gemini could not be answering anything.');
    console.log('  ==> On its own this already rules Gemini out.');
  } else {
    override(config, 'aiProvider', 'gemini');
    try {
      const { raw: geminiRaw } = await ai.run(NEED_CLASSIFICATION_TASK, PROMPT);
      const g = geminiRaw as Record<string, unknown>;
      console.log(`  Gemini envelope keys:  ${Object.keys(g).join(', ')}`);
      console.log(`  has candidates[]       ${Array.isArray(g.candidates) ? 'yes' : 'no'}`);
      console.log(`  has chatResponse       ${g.chatResponse ? 'yes' : 'no'}`);
      console.log(`  has modelId            ${g.modelId ? 'yes' : 'no'}`);
      console.log('\n  ==> Completely different shape from check 2. The two are');
      console.log('      impossible to confuse.');
    } catch (err) {
      console.log(`  Gemini call failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
      console.log('  ==> Gemini is not usable here, so it cannot be the source.');
    }
    override(config, 'aiProvider', config.aiProvider);
  }

  heading('How to check this yourself, any time');
  console.log('  pnpm ai:prove                 this script');
  console.log('  pnpm ai:oci-smoke             one call, prints the raw envelope');
  console.log('  grep AI_PROVIDER .env         should read oci_cohere');
  console.log('  backend log on any AI call    names "OCI cohere.command-a-03-2025"');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
