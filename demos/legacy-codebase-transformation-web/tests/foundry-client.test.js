'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { FINDING_SCHEMA, getFoundryConfiguration, requestFindings, requestStructured } = require('../server/foundry-client');

const env = {
  FOUNDRY_API_KEY: 'test-key',
  FOUNDRY_ENDPOINT: 'https://sample.services.ai.azure.com',
  FOUNDRY_MODEL: 'gpt-4.1-mini'
};

test('Foundry configuration resolves the deployment and v1 chat endpoint', () => {
  assert.deepEqual(getFoundryConfiguration(env), {
    apiKey: 'test-key', model: 'gpt-4.1-mini', rewriteModel: 'gpt-4.1-mini',
    url: 'https://sample.services.ai.azure.com/openai/v1/chat/completions'
  });
  assert.equal(getFoundryConfiguration({ ...env, FOUNDRY_REWRITE_MODEL: 'gpt-4.1' }).rewriteModel, 'gpt-4.1');
  assert.throws(() => getFoundryConfiguration({ ...env, FOUNDRY_REWRITE_MODEL: 'a\nb' }), /FOUNDRY_MODEL/);
  assert.throws(() => getFoundryConfiguration({ ...env, FOUNDRY_ENDPOINT: 'https://attacker.example' }), /canonical HTTPS/);
});

test('Foundry call sends a strict schema and parses structured findings', async () => {
  let request;
  const payload = { findings: [] };
  const result = await requestFindings('source prompt', {
    config: { apiKey: 'test-key', model: 'gpt-4.1-mini', url: 'https://sample.services.ai.azure.com/openai/v1/chat/completions' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });

  const body = JSON.parse(request.options.body);
  assert.equal(result.findings.length, 0);
  assert.equal(request.url, 'https://sample.services.ai.azure.com/openai/v1/chat/completions');
  assert.equal(request.options.headers['api-key'], 'test-key');
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema, FINDING_SCHEMA);
});

test('Foundry client accepts another strict JSON schema', async () => {
  let request;
  const schema = { type: 'object', additionalProperties: false, required: ['cases'], properties: { cases: { type: 'array' } } };
  const result = await requestStructured('characterisation prompt', {
    schemaName: 'characterisation_inputs',
    schema,
    config: { apiKey: 'test-key', model: 'gpt-4.1-mini', url: 'https://sample.services.ai.azure.com/openai/v1/chat/completions' },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cases: [] }) } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.deepEqual(result, { cases: [] });
  assert.equal(request.response_format.json_schema.name, 'characterisation_inputs');
  assert.deepEqual(request.response_format.json_schema.schema, schema);
  assert.equal(request.model, 'gpt-4.1-mini');
});

test('rewrite requests use the configured rewrite model', async () => {
  let request;
  await requestStructured('rewrite prompt', {
    schemaName: 'source_replacement', schema: { type: 'object' }, purpose: 'rewrite',
    config: { apiKey: 'k', model: 'gpt-4.1-mini', rewriteModel: 'gpt-4.1', url: 'https://sample.services.ai.azure.com/openai/v1/chat/completions' },
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { status: 200 });
    }
  });
  assert.equal(request.model, 'gpt-4.1');
});
