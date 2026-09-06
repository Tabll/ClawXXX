#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, join, relative } from 'node:path';
import ts from 'typescript';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const packageDir = resolve(args.get('--package-dir') || 'node_modules/openclaw');
const pluginRoot = resolve(args.get('--plugins-root') || 'node_modules');
const requireSdk = createRequire(join(packageDir, 'package.json'));
const packages = ['@openclaw/discord', '@openclaw/whatsapp', '@openclaw/qqbot', '@soimy/dingtalk', '@larksuite/openclaw-lark', '@wecom/wecom-openclaw-plugin', '@tencent-weixin/openclaw-weixin'];
const results = [];
for (const name of packages) {
  const root = join(pluginRoot, name);
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const imports = new Map();
  const visitFile = path => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const namespaces = new Map();
    const add = (specifier, names) => {
      if (!specifier.startsWith('openclaw/plugin-sdk')) return;
      const item = imports.get(specifier) ?? { names: new Set(), files: new Set() };
      for (const name of names) item.names.add(name);
      item.files.add(relative(root, path));
      imports.set(specifier, item);
    };
    const walk = node => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
        const spec = node.moduleSpecifier.text;
        const bindings = node.importClause?.namedBindings;
        add(spec, bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(e => !e.isTypeOnly).map(e => (e.propertyName ?? e.name).text) : []);
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, spec);
      }
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
        && node.initializer.expression.getText(source) === 'require' && ts.isStringLiteral(node.initializer.arguments[0])) {
        const spec = node.initializer.arguments[0].text;
        if (ts.isIdentifier(node.name)) { namespaces.set(node.name.text, spec); add(spec, []); }
        else if (ts.isObjectBindingPattern(node.name)) add(spec, node.name.elements.map(e => (e.propertyName ?? e.name).getText(source)));
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    const properties = node => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) add(namespaces.get(node.expression.text), [node.name.text]);
      ts.forEachChild(node, properties);
    };
    properties(source);
  };
  const scan = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (['node_modules', 'tests', '__tests__', '.git'].includes(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) scan(child);
      else if (/\.(?:[cm]?js|ts)$/.test(entry.name) && !/\.d\.ts$|\.(test|spec)\./.test(entry.name)) visitFile(child);
    }
  };
  scan(root);
  const missing = [];
  for (const [specifier, item] of imports) {
    try {
      const target = requireSdk.resolve(specifier);
      const source = ts.createSourceFile(target, readFileSync(target, 'utf8'), ts.ScriptTarget.Latest, true);
      const exports = new Set();
      for (const node of source.statements) {
        if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) for (const entry of node.exportClause.elements) exports.add(entry.name.text);
        if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) && node.name) exports.add(node.name.text);
      }
      const absent = [...item.names].filter(name => !exports.has(name));
      if (absent.length) missing.push({ specifier, absent, files: [...item.files] });
    } catch (error) { missing.push({ specifier, missingPath: true, names: [...item.names], files: [...item.files], reason: error.code }); }
  }
  results.push({ package: name, version: metadata.version, sdkPaths: imports.size, missing });
}
process.stdout.write(`${JSON.stringify({ ok: results.every(item => item.missing.length === 0), results }, null, 2)}\n`);
if (results.some(item => item.missing.length)) process.exitCode = 1;
