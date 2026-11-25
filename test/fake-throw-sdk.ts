// Stands in for the SDK's query(): yields a typed assistant error, then throws, as the CLI does for an invalid API key. Env: FAKE_CODE, FAKE_THROW.
export async function* query() {
  yield { type: 'assistant', error: process.env.FAKE_CODE, message: { content: [{ type: 'text', text: 'x' }] } };
  throw new Error(process.env.FAKE_THROW);
}
