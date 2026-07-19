#!/usr/bin/env node
/**
 * Patches apache-arrow's builder/valid.js to remove new Function() usage,
 * which is blocked by Electron's Content Security Policy.
 */
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../node_modules/apache-arrow/builder/valid.js');
if (!fs.existsSync(target)) {
  console.log('apache-arrow not found, skipping CSP patch');
  process.exit(0);
}

const patched = `"use strict";
// Patched for Electron CSP compatibility — replaced new Function() with Set-based lookup
Object.defineProperty(exports, "__esModule", { value: true });
exports.createIsValidFunction = void 0;

function createIsValidFunction(nullValues) {
    if (!nullValues || nullValues.length <= 0) {
        return function isValid(value) { return true; };
    }
    const hasNaN = nullValues.some((x) => x !== x);
    const nullSet = new Set(nullValues.filter((x) => x === x));
    return function isValid(x) {
        if (hasNaN && x !== x) return false;
        return !nullSet.has(x);
    };
}
exports.createIsValidFunction = createIsValidFunction;
`;

fs.writeFileSync(target, patched);
console.log('apache-arrow CSP patch applied.');
