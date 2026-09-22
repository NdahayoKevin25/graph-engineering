import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { Parser, Language as Grammar, type Node } from "web-tree-sitter";
import type {
  CodeSymbol,
  GraphEdge,
  Language,
  SourceReference,
} from "@graph-engineering/contracts";

export const PARSER_VERSION =
  "web-tree-sitter:0.25.10/grammars:0.1.13/extractor:2";
export const hash = (input: string | Uint8Array) =>
  createHash("sha256").update(input).digest("hex");
const grammars = new Map<string, Promise<Grammar>>();
let initialized: Promise<void> | undefined;
const require = createRequire(import.meta.url);
const grammarRoot = dirname(require.resolve("tree-sitter-wasms/package.json"));
const languages: Record<string, [Language, string]> = {
  ".ts": ["typescript", "typescript"],
  ".tsx": ["typescript", "tsx"],
  ".mts": ["typescript", "typescript"],
  ".cts": ["typescript", "typescript"],
  ".js": ["javascript", "javascript"],
  ".jsx": ["javascript", "javascript"],
  ".mjs": ["javascript", "javascript"],
  ".cjs": ["javascript", "javascript"],
  ".py": ["python", "python"],
  ".go": ["go", "go"],
  ".rs": ["rust", "rust"],
  ".java": ["java", "java"],
  ".cs": ["csharp", "c_sharp"],
};
const declarations = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method_declaration",
  "method_definition",
  "class_declaration",
  "class_definition",
  "class_specifier",
  "interface_declaration",
  "struct_item",
  "struct_specifier",
  "enum_item",
  "enum_declaration",
  "type_alias_declaration",
  "type_spec",
  "record_declaration",
  "constructor_declaration",
  "trait_item",
]);
const calls = new Set([
  "call_expression",
  "call",
  "method_invocation",
  "invocation_expression",
  "object_creation_expression",
]);
const imports = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "use_declaration",
  "using_directive",
  "import_spec",
]);
export interface ParsedFile {
  parserVersion: string;
  path: string;
  hash: string;
  language: Language;
  text: string;
  symbols: CodeSymbol[];
  edges: GraphEdge[];
  errors: string[];
  parsed: boolean;
}

export async function parseFile(
  path: string,
  text: string,
  snapshotId: string,
): Promise<ParsedFile> {
  const language = languages[extname(path).toLowerCase()];
  const contentHash = hash(text);
  const source = (startLine: number, endLine: number): SourceReference => ({
    path,
    startLine,
    endLine,
    contentHash,
    snapshotId,
  });
  const fileId = hash(`file:${path}`);
  const result: ParsedFile = {
    parserVersion: PARSER_VERSION,
    path,
    hash: contentHash,
    text,
    language: language?.[0] ?? "text",
    symbols: [
      {
        id: fileId,
        name: path,
        kind: "file",
        language: language?.[0] ?? "text",
        source: source(1, text.split("\n").length),
        signature: path,
      },
    ],
    edges: [],
    errors: [],
    parsed: false,
  };
  if (!language) return result;
  initialized ??= Parser.init();
  await initialized;
  let grammar = grammars.get(language[1]);
  if (!grammar) {
    grammar = Grammar.load(
      join(grammarRoot, "out", `tree-sitter-${language[1]}.wasm`),
    );
    grammars.set(language[1], grammar);
  }
  const parser = new Parser();
  try {
    parser.setLanguage(await grammar);
    const tree = parser.parse(text);
    if (!tree) throw new Error("Parser returned no syntax tree");
    try {
      result.parsed = true;
      if (tree.rootNode.hasError)
        result.errors.push(`${path}: syntax errors; graph may be incomplete`);
      const visit = (node: Node, owner: string) => {
        let currentOwner = owner;
        let isDeclaration = declarations.has(node.type);
        if (node.type === "variable_declarator") {
          const value = node.childForFieldName("value");
          isDeclaration =
            !!value &&
            ["arrow_function", "function_expression"].includes(value.type);
        }
        if (isDeclaration) {
          const name =
            node.childForFieldName("name") ??
            node.childForFieldName("declarator");
          if (name) {
            currentOwner = hash(
              `${path}:${node.type}:${name.text}:${node.startIndex}`,
            );
            result.symbols.push({
              id: currentOwner,
              name: name.text,
              kind: node.type,
              language: language[0],
              source: source(
                node.startPosition.row + 1,
                node.endPosition.row + 1,
              ),
              signature: node.text.split(/[\n{]/, 1)[0]!.trim().slice(0, 500),
            });
            result.edges.push({
              id: hash(`${owner}:${currentOwner}:contains`),
              from: owner,
              to: currentOwner,
              target: name.text,
              kind: "contains",
              evidence: "resolved",
              source: source(
                node.startPosition.row + 1,
                node.endPosition.row + 1,
              ),
            });
          }
        }
        if (calls.has(node.type) || imports.has(node.type)) {
          const callable =
            node.childForFieldName("function") ??
            node.childForFieldName("name") ??
            node.childForFieldName("expression");
          const target = imports.has(node.type)
            ? node.text.slice(0, 500)
            : (
                callable?.text ??
                node.namedChildren[0]?.text ??
                node.text
              ).slice(0, 500);
          result.edges.push({
            id: hash(
              `${path}:${node.startIndex}:${node.endIndex}:${node.type}`,
            ),
            from: currentOwner,
            to: null,
            target,
            kind: imports.has(node.type) ? "imports" : "calls",
            evidence: "syntactic",
            source: source(
              node.startPosition.row + 1,
              node.endPosition.row + 1,
            ),
          });
        }
        for (const child of node.namedChildren)
          if (child) visit(child, currentOwner);
      };
      visit(tree.rootNode, fileId);
    } finally {
      tree.delete();
    }
  } catch (error) {
    result.errors.push(
      `${path}: parser unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    parser.delete();
  }
  return result;
}

// Split at declaration boundaries where possible. Chunk size is conservative
// UTF-8 bytes, not an assumed provider tokenizer. Source lines remain exact.
export function chunkFile(
  file: ParsedFile,
  snapshotId: string,
): { id: string; text: string; source: SourceReference }[] {
  const lines = file.text.split("\n");
  const boundaries = new Set(
    file.symbols
      .filter((symbol) => symbol.kind !== "file")
      .map((symbol) => symbol.source.startLine - 1),
  );
  const chunks: { id: string; text: string; source: SourceReference }[] = [];
  let start = 0,
    accumulated: string[] = [],
    bytes = 0;
  const flush = () => {
    if (!accumulated.length) return;
    const text = accumulated.join("\n");
    if (text.trim())
      chunks.push({
        id: hash(`${file.path}:${start}:${hash(text)}`),
        text,
        source: {
          path: file.path,
          startLine: start + 1,
          endLine: start + accumulated.length,
          contentHash: file.hash,
          snapshotId,
        },
      });
    accumulated = [];
    bytes = 0;
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (
      accumulated.length &&
      (bytes + Buffer.byteLength(line) > 2048 || boundaries.has(index))
    )
      flush();
    if (!accumulated.length) start = index;
    accumulated.push(line);
    bytes += Buffer.byteLength(line) + 1;
  }
  flush();
  return chunks;
}
