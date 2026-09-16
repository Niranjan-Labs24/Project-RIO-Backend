/**
 * Smoke test for Cohere Embed on OCI Generative AI.
 *
 *   npm run ai:oci-embed-smoke
 *
 * The sibling of ai:oci-smoke, for the OTHER model this platform calls. Chat
 * passing proves nothing about embedding: it is a different action, a
 * different model id, and on many tenancies a different IAM grant.
 *
 * Confirms five things a unit test cannot, in the order they usually break:
 *
 *   1. the API key authenticates against /actions/embedText (bearer, no
 *      request signing);
 *   2. the compartment id is one the key's IAM policy allows for EMBEDDING,
 *      not only for chat;
 *   3. the configured model is served ON_DEMAND in the configured region —
 *      which model ids a region offers genuinely varies;
 *   4. the width the model returns, printed, so OCI_GENAI_EMBED_DIMENSIONS is
 *      set from what the tenancy does rather than from documentation;
 *   5. that the vectors are usable — an Arabic need and its English twin score
 *      close together, which is the entire reason the semantic pass exists.
 *
 * Nothing here touches the database. It costs one on-demand embedding call
 * over three short inputs.
 *
 * This DOES send text to the model. The three inputs below are invented for
 * the purpose and contain no real need and no respondent data.
 */
import * as dotenv from 'dotenv';
dotenv.config();

const region = process.env.OCI_GENAI_REGION ?? 'me-riyadh-1';
const apiKey = process.env.OCI_GENAI_API_KEY;
const compartmentId = process.env.OCI_GENAI_COMPARTMENT_ID;
const modelId = process.env.OCI_GENAI_EMBED_MODEL_ID ?? 'cohere.embed-multilingual-v3.0';
const servingType = process.env.OCI_GENAI_SERVING_TYPE ?? 'ON_DEMAND';
const expectedDimensions = Number(process.env.OCI_GENAI_EMBED_DIMENSIONS ?? 1024);
const url = `https://inference.generativeai.${region}.oci.oraclecloud.com/20231130/actions/embedText`;

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

// Three inputs, chosen so the result is interpretable rather than merely
// non-empty: [0] and [1] are the same need in two languages, [2] is a
// different need entirely. If cross-language similarity is not clearly the
// highest of the three, this model will not do the job the pass needs.
const INPUTS = [
  'Shortage of clean drinking water in the village',
  'نقص في مياه الشرب النظيفة في القرية',
  'Risk of student dropouts in the 2026 academic year',
];

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

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
      inputs: INPUTS,
      // CLUSTERING, not SEARCH_*: a duplicate pair is two documents of the
      // same kind compared to each other, the symmetric case. Must match
      // OciCohereEmbeddingProvider — a smoke test on a different input type
      // would not be testing what the app does.
      inputType: 'CLUSTERING',
      truncate: 'END',
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
    if (res.status === 400 && /model/i.test(raw)) {
      fail(
        `The model id was rejected. ${modelId} may not be served ON_DEMAND in\n` +
          `  ${region}. Check Analytics & AI > Generative AI > the region's model\n` +
          '  list in the OCI Console, and set OCI_GENAI_EMBED_MODEL_ID to one that\n' +
          '  is offered there. It must be an EMBEDDING model — a chat model such as\n' +
          '  cohere.command-a-03-2025 is rejected here.',
      );
    }
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      fail(
        'Credential or policy problem. OCI answers an unauthorized caller with 404,\n' +
          '  so this is usually the IAM policy rather than a wrong URL. Note that a\n' +
          '  policy allowing chat does NOT necessarily allow embedding. Check that:\n' +
          '   - the key was created in this same region;\n' +
          '   - a policy grants it use of generative-ai-family in this compartment;\n' +
          '   - the key has not expired.',
      );
    }
    fail(`Unexpected status ${res.status}.`);
  }

  const payload = JSON.parse(raw) as { embeddings?: number[][] };
  console.log(`HTTP ${res.status} in ${elapsed}ms`);

  const vectors = payload.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== INPUTS.length) {
    console.error(JSON.stringify(payload, null, 2).slice(0, 1200));
    fail(
      `Expected ${INPUTS.length} vectors, got ${vectors?.length ?? 0}. If the envelope\n` +
        '  above is not { embeddings: [...] }, update OciCohereEmbeddingProvider.',
    );
  }

  const width = vectors[0]!.length;
  console.log(`\n✓ authenticated, model answered, ${vectors.length} vectors returned`);
  console.log(`✓ width: ${width} dimensions`);

  if (width !== expectedDimensions) {
    fail(
      `OCI_GENAI_EMBED_DIMENSIONS is ${expectedDimensions} but this model returns ${width}.\n` +
        `  Set OCI_GENAI_EMBED_DIMENSIONS=${width} in .env, and make\n` +
        '  need_embeddings.embedding vector(' +
        width +
        ') to keep the indexed path —\n' +
        '  migration 20260911000000 declares 1024. Without the migration the pass\n' +
        '  still works, comparing in the application instead of against the index.',
    );
  }

  const crossLanguage = cosine(vectors[0]!, vectors[1]!);
  const unrelated = cosine(vectors[0]!, vectors[2]!);
  console.log(`\n── what the vectors actually say ──`);
  console.log(`  same need, EN vs AR   ${crossLanguage.toFixed(3)}`);
  console.log(`  different need, EN    ${unrelated.toFixed(3)}`);

  if (crossLanguage <= unrelated) {
    fail(
      'The same need in two languages did not score above two different needs.\n' +
        '  This model will not do what the semantic pass needs — check that\n' +
        `  ${modelId} is a MULTILINGUAL embedding model (embed-english-* is not).`,
    );
  }

  console.log(
    `\n✓ cross-language similarity (${crossLanguage.toFixed(3)}) is above unrelated ` +
      `(${unrelated.toFixed(3)})`,
  );
  console.log('\nSafe to run the semantic scan with AI_PROVIDER=oci_cohere.');
  console.log('Remember that turning it on sends need text to the model on every scan.\n');
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
