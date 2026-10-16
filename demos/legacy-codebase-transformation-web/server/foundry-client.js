'use strict';

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 60000;
const FINDING_CATEGORIES = Object.freeze([
  'redundant-control-flow', 'repeated-local-expression', 'complex-function-simplification',
  'code-duplication', 'excessive-complexity', 'unnecessary-abstraction', 'unclear-intent',
  'obsolete-pattern', 'fragile-structure', 'other-technical-debt'
]);

const FINDING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'category', 'rationale', 'confidence', 'symbol', 'functionStartLine', 'functionEndLine',
          'startLine', 'startCharacter', 'endLine', 'endCharacter', 'originalText', 'replacementText'
        ],
        properties: {
          category: { type: 'string', enum: [...FINDING_CATEGORIES] },
          rationale: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          symbol: { type: 'string' },
          functionStartLine: { type: 'integer' },
          functionEndLine: { type: 'integer' },
          startLine: { type: 'integer' },
          startCharacter: { type: 'integer' },
          endLine: { type: 'integer' },
          endCharacter: { type: 'integer' },
          originalText: { type: 'string' },
          replacementText: { type: 'string' }
        }
      }
    }
  }
});

function getFoundryConfiguration(env = process.env) {
  const apiKey = env.FOUNDRY_API_KEY;
  const model = env.FOUNDRY_MODEL || 'gpt-4.1-mini';
  const rewriteModel = env.FOUNDRY_REWRITE_MODEL || model;
  const endpoint = env.FOUNDRY_ENDPOINT;
  const validModel = (value) => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\r\n]/.test(value);
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey) || !validModel(model) || !validModel(rewriteModel)) {
    throw new Error('Set FOUNDRY_API_KEY, FOUNDRY_ENDPOINT, and FOUNDRY_MODEL in the server environment.');
  }

  let parsed;
  try { parsed = new URL(endpoint); } catch { }
  const supportedHost = parsed && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:openai\.azure\.com|services\.ai\.azure\.com)$/i.test(parsed.hostname);
  if (!supportedHost || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash ||
      !/^\/?(?:openai\/v1\/?)?$/.test(parsed.pathname)) {
    throw new Error('FOUNDRY_ENDPOINT must be a canonical HTTPS Azure OpenAI or Foundry resource endpoint.');
  }

  return { apiKey, model: model.trim(), rewriteModel: rewriteModel.trim(), url: `${parsed.origin}/openai/v1/chat/completions` };
}

async function readBoundedJson(response) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('The Foundry response exceeded the size limit.');
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('The Foundry response exceeded the size limit.');
  return JSON.parse(text);
}

async function requestStructured(prompt, { schemaName, schema, ...options } = {}) {
  if (typeof schemaName !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(schemaName) || !schema || typeof schema !== 'object') {
    throw new TypeError('A valid structured-output schema name and schema are required.');
  }
  const config = options.config ?? getFoundryConfiguration(options.env);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime does not provide fetch.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey },
      body: JSON.stringify({
        model: options.purpose === 'rewrite' ? (config.rewriteModel ?? config.model) : config.model,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema }
        }
      })
    });
    if (!response.ok) throw new Error(`Foundry returned HTTP ${response.status}. Check the deployment and endpoint configuration.`);

    const result = await readBoundedJson(response);
    const choice = result.choices?.[0];
    if (choice?.message?.refusal) throw new Error('Foundry refused the analysis request.');
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
      throw new Error('Foundry returned an incomplete analysis response.');
    }
    if (choice.message.content.includes(config.apiKey)) throw new Error('Foundry response was discarded because it contained a configured credential.');
    return JSON.parse(choice.message.content);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Foundry request timed out.');
    if (error.message.startsWith('Foundry ') || error.message.startsWith('The Foundry ')) throw error;
    throw new Error('Could not complete the Foundry analysis request. Check the deployment and network configuration.');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function requestFindings(prompt, options = {}) {
  return requestStructured(prompt, { schemaName: 'codebase_findings', schema: FINDING_SCHEMA, ...options });
}

module.exports = { FINDING_SCHEMA, getFoundryConfiguration, requestFindings, requestStructured };
