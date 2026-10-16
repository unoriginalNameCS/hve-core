'use strict';

function serialise(value, seen = new Map(), location = '$') {
  if (value === undefined) return { $type: 'undefined' };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $type: 'number', value: String(value) };
  if (typeof value === 'number' && Object.is(value, -0)) return { $type: 'number', value: '-0' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: value.toString() };
  if (typeof value === 'symbol') return { $type: 'symbol', value: value.description ?? '' };
  if (typeof value === 'function') return { $type: 'function', name: value.name || '' };
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return { $type: 'reference', path: seen.get(value) };
  seen.set(value, location);

  if (value instanceof Date) return { $type: 'date', value: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString() };
  if (value instanceof RegExp) return { $type: 'regexp', source: value.source, flags: value.flags };
  if (value instanceof Error) return {
    $type: 'error', name: value.name, message: value.message,
    cause: value.cause === undefined ? null : serialise(value.cause, seen, `${location}.cause`)
  };
  if (Buffer.isBuffer(value)) return { $type: 'buffer', value: value.toString('base64') };
  if (ArrayBuffer.isView(value)) return { $type: value.constructor.name, value: Array.from(value) };
  if (Array.isArray(value)) return value.map((item, index) => serialise(item, seen, `${location}[${index}]`));
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, item], index) => [
      serialise(key, seen, `${location}.key${index}`), serialise(item, seen, `${location}.value${index}`)
    ]);
    entries.sort((left, right) => JSON.stringify(left[0]).localeCompare(JSON.stringify(right[0])));
    return { $type: 'map', entries };
  }
  if (value instanceof Set) {
    const values = [...value].map((item, index) => serialise(item, seen, `${location}.set${index}`));
    values.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return { $type: 'set', values };
  }
  const entries = Object.keys(value).sort().map((key) => [key, serialise(value[key], seen, `${location}.${key}`)]);
  return { $type: 'object', entries };
}

module.exports = { serialise };
