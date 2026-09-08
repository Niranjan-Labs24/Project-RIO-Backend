/**
 * Smoke test for Cohere Command A on OCI Generative AI.
 *
 *   npm run ai:oci-smoke
 *
 * Confirms four things a unit test cannot, in the order they usually break:
 *
 *   1. the API key authenticates (bearer, no request signing);
 *   2. the compartment id is one the key's IAM policy actually allows;
 *   3. the model answers in the configured region;
 *   4. `responseFormat: JSON_OBJECT` really is enforced, and the response
 *      envelope is the `{ chatResponse: { text } }` shape AiService reads.
 *
 * Nothing here touches the database, and it costs one short on-demand call.
 */
import * as dotenv from 'dotenv';
dotenv.config();

const region = process.env.OCI_GENAI_REGION ?? 'me-riyadh-1';
const apiKey = process.env.OCI_GENAI_API_KEY;
const compartmentId = process.env.OCI_GENAI_COMPARTMENT_ID;
const modelId = process.env.OCI_GENAI_MODEL_ID ?? 'cohere.command-a-03-2025';
const servingType = process.env.OCI_GENAI_SERVING_TYPE ?? 'ON_DEMAND';
const url = `https://inference.generativeai.${region}.oci.oraclecloud.com/20231130/actions/chat`;

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

if (!apiKey) fail('OCI_GENAI_API_KEY is not set in .env');
if (!compartmentId) {
  fail(
    'OCI_GENAI_COMPARTMENT_ID is not set in .env.\n' +
      '  Find it in the OCI Console: Identity > Compartments > the compartment\n' +
      '  the Generative AI policy was granted on. It starts ocid1.compartment...\n' +
      '  (or ocid1.tenancy... for the root compartment).',
  );
}

// A deliberately tiny schema: if JSON_OBJECT enforcement is not working, the
// model answers in prose and JSON.parse below fails loudly.
const schema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    region: { type: 'string' },
  },
  required: ['ok', 'region'],
};

async function main(): Promise<void> {
  console.log(`→ ${url}`);
  console.log(`  model       ${modelId} (${servingType})`);
  console.log(`  compartment ${compartmentId!.slice(0, 22)}…`);
  console.log(`  key         ${apiKey!.slice(0, 6)}…${apiKey!.slice(-4)}\n`);

  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      compartmentId,
      servingMode: { servingType, modelId },
      chatRequest: {
        apiFormat: 'COHERE',
        preambleOverride: 'You reply only with JSON matching the given schema.',
        message: `Set ok to true and region to "${region}".`,
        temperature: 0,
        maxTokens: 100,
        responseFormat: { type: 'JSON_OBJECT', schema },
      },
    }),
  });

  const elapsed = Date.now() - started;
  const raw = await res.text();

  if (!res.ok) {
    console.error(`HTTP ${res.status} after ${elapsed}ms`);
    console.error(raw);
    if (res.status === 400 && raw.includes('Compartment')) {
      fail('The compartment id was rejected. Check OCI_GENAI_COMPARTMENT_ID.');
    }
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      fail(
        'Credential or policy problem. OCI answers an unauthorized caller with 404,\n' +
          '  so this is usually the IAM policy rather than a wrong URL. Check that:\n' +
          '   - the key was created in this same region;\n' +
          '   - a policy grants it use of generative-ai-family in this compartment;\n' +
          '   - the key has not expired.',
      );
    }
    fail(`Unexpected status ${res.status}.`);
  }

  const payload: unknown = JSON.parse(raw);
  console.log(`HTTP ${res.status} in ${elapsed}ms`);
  console.log('\n── raw envelope ──');
  console.log(JSON.stringify(payload, null, 2).slice(0, 1200));

  const envelope = payload as {
    chatResponse?: { text?: string; finishReason?: string };
    text?: string;
  };
  const text = envelope.chatResponse?.text ?? envelope.text;
  if (typeof text !== 'string' || text.length === 0) {
    fail(
      'No text in the response. AiService reads chatResponse.text — if the\n' +
        '  envelope above differs, update extractOciText in oci-cohere.provider.ts.',
    );
  }

  console.log('\n── model text ──');
  console.log(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(
      'The model returned text that is not JSON, so responseFormat is not being\n' +
        '  enforced. Every AI task depends on it — do not switch AI_PROVIDER until\n' +
        '  this passes.',
    );
  }

  const wrapped = envelope.chatResponse !== undefined;
  console.log('\n✓ authenticated, model answered, and the reply parsed as JSON');
  console.log(`✓ envelope shape: ${wrapped ? 'chatResponse.text (expected)' : 'top-level text'}`);
  console.log(`✓ parsed: ${JSON.stringify(parsed)}`);
  console.log('\nSafe to set AI_PROVIDER=oci_cohere.\n');
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
