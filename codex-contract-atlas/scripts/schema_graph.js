'use strict';
const S = require('../src/schema.js');
const scope = /^\/(responses|models|images|audio|realtime|live)(?:\/|\?|$)/;
const mapKeys = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const singleKeys = new Set(['items', 'contains', 'additionalProperties', 'unevaluatedProperties',
  'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else']);
const arrayKeys = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function schemaGraph(document) {
  if (!document.paths || !document.openapi) throw new Error('OpenAPI document requires paths and openapi.');
  const operations = S.operations(document).filter(op => scope.test(op.path));
  const issues = operations.flatMap(op => op.issues.map(issue => ({ ...issue, operation: op.pointer })));
  for (const operation of operations) for (const parameter of operation.parameters) {
    if (S.get(document, parameter.pointer).content) issues.push({ pointer: parameter.pointer, reason: 'parameter_content_requires_manual_resolution' });
  }
  for (const [name, item] of Object.entries(document.paths)) {
    if (scope.test(name) && item.$ref) issues.push({ pointer: '#/paths/' + S.escapePointer(name), reason: 'path_item_ref_not_supported' });
  }
  const pending = operations.flatMap(op => [
    ...op.schemas.map(s => s.pointer), ...op.parameters.map(p => p.schemaPointer).filter(Boolean),
  ]);
  const visited = new Set();
  const nodes = [];
  let propertyDeclarations = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const pointer = pending[cursor];
    if (visited.has(pointer)) continue;
    visited.add(pointer);
    let raw;
    try { raw = S.get(document, pointer); }
    catch (error) { issues.push({ pointer, reason: 'unresolved_reference', detail: error.message }); continue; }
    if (typeof raw !== 'boolean' && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
      issues.push({ pointer, reason: 'invalid_schema' });
      continue;
    }
    const edges = [];
    const node = { pointer, schema: typeof raw === 'boolean' ? raw : Object.create(null), edges };
    function link(keyword, target, name) {
      edges.push({ keyword, ...(name === undefined ? {} : { name }), target });
      pending.push(target);
    }
    for (const [keyword, value] of Object.entries(raw)) {
      if (mapKeys.has(keyword) && value && typeof value === 'object') {
        for (const name of Object.keys(value)) {
          link(keyword, pointer + '/' + keyword + '/' + S.escapePointer(name), name);
          if (keyword === 'properties') propertyDeclarations++;
        }
      } else if (arrayKeys.has(keyword) && Array.isArray(value)) {
        value.forEach((_, index) => link(keyword, pointer + '/' + keyword + '/' + index, index));
      } else if (singleKeys.has(keyword) && (typeof value === 'boolean' || (value && typeof value === 'object' && !Array.isArray(value)))) {
        link(keyword, pointer + '/' + keyword);
      } else {
        node.schema[keyword] = value;
        if (keyword === '$ref') {
          if (typeof value === 'string' && value.startsWith('#/')) link(keyword, value);
          else issues.push({ pointer, reason: 'non_pointer_reference', ref: value });
        }
        if (['$id', '$anchor', '$dynamicRef', '$dynamicAnchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', 'dependencies', 'additionalItems'].includes(keyword)) {
          issues.push({ pointer, keyword, reason: 'keyword_requires_manual_resolution' });
        }
        if ((singleKeys.has(keyword) || mapKeys.has(keyword) || arrayKeys.has(keyword))) {
          issues.push({ pointer, keyword, reason: 'unsupported_schema_shape' });
        }
      }
    }
    nodes.push(node);
  }
  nodes.sort((a, b) => a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0);
  return {
    meta: {
      openapi: document.openapi, apiVersion: document.info?.version,
      scope: 'Responses,Models,Images,Audio,Realtime,Live',
      operationCount: operations.length, schemaNodes: nodes.length, propertyDeclarations,
      complete: issues.length === 0, backendValidated: false, semanticMappingCompleted: false,
      representation: 'Each reachable schema declaration once; references and compositions remain graph edges.',
      limitations: [
        'Complete means traversal of supported schema keywords, not semantic validation or backend parity.',
        'Only local JSON pointer references; unsupported resolution rules are reported.',
        'Required and composition constraints stay on their declaring nodes; no global requiredness inferred.',
        'Examples/defaults/const are data, not references. Cycles stay graph edges.',
        'Path Item references and parameter content schemas require manual review.',
      ],
    }, operations, nodes, issues,
  };
}
module.exports = { schemaGraph };
