#!/usr/bin/env node
// hydra/scripts/jsonschema.mjs — minimal, dependency-free JSON Schema validator.
//
// Supports the subset the Wave 0 schemas use: type, required, properties,
// additionalProperties, enum, items, minItems, const, and nested objects.
// Not a general-purpose validator — deliberately small so the trust boundary
// has no third-party dependency.
//
// Usage: node jsonschema.mjs <schema.json> <instance.json>
// Exit 0 = valid; exit 1 = invalid (errors printed to stderr, one per line).

import { readFileSync } from "node:fs";

const [, , schemaPath, instancePath] = process.argv;
if (!schemaPath || !instancePath) {
  console.error("usage: jsonschema.mjs <schema.json> <instance.json>");
  process.exit(2);
}

let schema, instance;
try {
  schema = JSON.parse(readFileSync(schemaPath, "utf8"));
} catch (e) {
  console.error(`cannot read/parse schema: ${e.message}`);
  process.exit(2);
}
try {
  instance = JSON.parse(readFileSync(instancePath, "utf8"));
} catch (e) {
  console.error(`instance is not valid JSON: ${e.message}`);
  process.exit(1);
}

const errors = [];

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (Number.isInteger(v)) return "integer";
  return typeof v; // string | number | boolean | object
}

function typeMatches(expected, actual) {
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function validate(node, sch, path) {
  if (sch == null || typeof sch !== "object") return;

  if (sch.type) {
    const actual = typeOf(node);
    const expected = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!expected.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected type ${expected.join("|")}, got ${actual}`);
      return; // downstream checks assume the type held
    }
  }

  if (sch.const !== undefined && JSON.stringify(node) !== JSON.stringify(sch.const)) {
    errors.push(`${path}: must equal const ${JSON.stringify(sch.const)}`);
  }

  if (sch.enum && !sch.enum.some((e) => JSON.stringify(e) === JSON.stringify(node))) {
    errors.push(`${path}: value ${JSON.stringify(node)} not in enum ${JSON.stringify(sch.enum)}`);
  }

  if (typeOf(node) === "object") {
    for (const req of sch.required || []) {
      if (!(req in node)) errors.push(`${path}: missing required property '${req}'`);
    }
    for (const [key, val] of Object.entries(node)) {
      const childPath = `${path}/${key}`;
      if (sch.properties && key in sch.properties) {
        validate(val, sch.properties[key], childPath);
      } else if (sch.additionalProperties === false) {
        errors.push(`${childPath}: additional property not allowed`);
      } else if (sch.additionalProperties && typeof sch.additionalProperties === "object") {
        validate(val, sch.additionalProperties, childPath);
      }
    }
  }

  if (typeOf(node) === "array") {
    if (typeof sch.minItems === "number" && node.length < sch.minItems) {
      errors.push(`${path}: array shorter than minItems ${sch.minItems}`);
    }
    if (sch.items) {
      node.forEach((el, i) => validate(el, sch.items, `${path}/${i}`));
    }
  }
}

validate(instance, schema, "$");

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
process.exit(0);
