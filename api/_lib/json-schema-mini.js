// api/_lib/json-schema-mini.js
//
// Kleine, pure JSON-Schema-validator (draft-7-subset) voor de blokschema's van de
// Weekeditie (api/_lib/weekeditie-blokken.json, export van dfo-website zod). Dekt
// precies wat die export gebruikt: type, const, enum, min/maxLength, pattern,
// format uuid, minimum/maximum, min/maxItems, items, properties, required,
// additionalProperties (false of schema), propertyNames, anyOf/oneOf.
// → [{ pad, fout }] (leeg = geldig).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function typeVan(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function klopttype(v, t) {
  const echt = typeVan(v);
  if (t === 'number') return echt === 'number' || echt === 'integer';
  return echt === t;
}

export function valideer(schema, v, pad = '', uit = []) {
  if (!schema || typeof schema !== 'object') return uit;
  const f = (fout) => uit.push({ pad: pad || '(root)', fout });
  if (schema.anyOf || schema.oneOf) {
    const opties = schema.anyOf || schema.oneOf;
    const ok = opties.some((s) => valideer(s, v, pad, []).length === 0);
    if (!ok) f('past in geen enkele toegelaten vorm');
    return uit;
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => klopttype(v, t))) { f(`verwacht ${types.join('|')}, kreeg ${typeVan(v)}`); return uit; }
  }
  if ('const' in schema && v !== schema.const) f(`moet ${JSON.stringify(schema.const)} zijn`);
  if (schema.enum && !schema.enum.includes(v)) f(`moet een van ${schema.enum.join(', ')} zijn`);
  if (typeof v === 'string') {
    if (schema.minLength != null && v.trim().length < schema.minLength) f('te kort of leeg');
    if (schema.maxLength != null && v.length > schema.maxLength) f(`te lang (max ${schema.maxLength} tekens, nu ${v.length})`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) f('vorm klopt niet');
    if (schema.format === 'uuid' && !UUID_RE.test(v)) f('geen geldig id');
  }
  if (typeof v === 'number') {
    if (schema.minimum != null && v < schema.minimum) f(`minstens ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) f(`hoogstens ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && v <= schema.exclusiveMinimum) f(`groter dan ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum != null && v >= schema.exclusiveMaximum) f(`kleiner dan ${schema.exclusiveMaximum}`);
    if (!Number.isFinite(v)) f('geen eindig getal');
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) f(`minstens ${schema.minItems} items`);
    if (schema.maxItems != null && v.length > schema.maxItems) f(`hoogstens ${schema.maxItems} items`);
    if (schema.items) v.forEach((x, i) => valideer(schema.items, x, `${pad}[${i}]`, uit));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const props = schema.properties || {};
    for (const k of schema.required || []) if (!(k in v) || v[k] === undefined) uit.push({ pad: pad ? `${pad}.${k}` : k, fout: 'ontbreekt' });
    for (const [k, x] of Object.entries(v)) {
      const p = pad ? `${pad}.${k}` : k;
      if (x === undefined) continue;
      if (props[k]) valideer(props[k], x, p, uit);
      else if (schema.additionalProperties === false) uit.push({ pad: p, fout: 'onbekend veld' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') valideer(schema.additionalProperties, x, p, uit);
      if (schema.propertyNames) valideer(schema.propertyNames, k, p + ' (sleutel)', uit);
    }
  }
  return uit;
}

/** Schema zonder "$schema"-sleutels (voor de tool-definitie van het model). */
export function zonderMeta(schema) {
  if (Array.isArray(schema)) return schema.map(zonderMeta);
  if (!schema || typeof schema !== 'object') return schema;
  const uit = {};
  for (const [k, v] of Object.entries(schema)) if (k !== '$schema') uit[k] = zonderMeta(v);
  return uit;
}
