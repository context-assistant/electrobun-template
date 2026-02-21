import type { Extension } from "@codemirror/state";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";

const MAKEFILE_DIRECTIVES =
  /^(?:include|-include|sinclude|ifdef|ifndef|ifeq|ifneq|else|endif|define|endef|export|unexport|override|private|vpath)\b/;

const makefileParser: StreamParser<null> = {
  startState: () => null,
  token(stream) {
    // Comments
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }

    // Recipe lines start with a TAB (shell commands).
    if (stream.sol() && stream.peek() === "\t") {
      stream.skipToEnd();
      return "meta";
    }

    // Variables like $(FOO) or ${FOO}
    if (stream.match(/\$\([^)]+\)|\$\{[^}]+\}/)) return "variableName";

    // Operators
    if (stream.match(/::=|:=|\?=|\+=|!=|=/)) return "operator";
    if (stream.match(/::|:/)) return "operator";

    // Only treat these as line-leading constructs.
    if (stream.sol()) {
      stream.eatWhile(/[ ]/);

      if (stream.match(MAKEFILE_DIRECTIVES)) return "keyword";

      // Variable assignment name (the operator will be tokenized on next call).
      if (stream.match(/[A-Za-z0-9_.%/@+-]+(?=\s*(?:\?|\\+|:)?=)/)) return "variableName";

      // Target definition (everything up to ':' or '::' at line start).
      if (stream.match(/[^=\s:#][^:#=]*?(?=\s*::?\s)/)) return "def";
    }

    // Whitespace
    if (stream.eatWhile(/\s/)) return null;

    // Fallback: consume one char to avoid infinite loops
    stream.next();
    return null;
  },
};

export function resolveLanguageExtensions(path: string): Extension[] {
  const normalized = path.toLowerCase().trim();
  const fileName = normalized.split("/").pop() ?? normalized;

  // Special filename-based languages.
  if (
    fileName === "dockerfile" ||
    fileName === "containerfile" ||
    fileName.startsWith("dockerfile.") ||
    fileName.startsWith("containerfile.") ||
    fileName.endsWith(".dockerfile") ||
    fileName.endsWith(".containerfile")
  ) {
    return [StreamLanguage.define(dockerFile)];
  }
  if (
    fileName === "makefile" ||
    fileName === "gnumakefile" ||
    fileName.endsWith(".mk") ||
    fileName.endsWith(".mak")
  ) {
    return [StreamLanguage.define(makefileParser)];
  }

  // Extension-based languages.
  if (fileName.endsWith(".tsx")) return [javascript({ typescript: true, jsx: true })];
  if (fileName.endsWith(".ts") || fileName.endsWith(".mts") || fileName.endsWith(".cts")) {
    return [javascript({ typescript: true })];
  }
  if (fileName.endsWith(".jsx")) return [javascript({ jsx: true })];
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
    return [javascript()];
  }
  if (fileName.endsWith(".json") || fileName.endsWith(".jsonc") || fileName.endsWith(".jsonl") || fileName.endsWith(".jsonld") || fileName.endsWith(".geojson") || fileName.endsWith(".webmanifest")) return [json()];
  if (fileName.endsWith(".css")) return [css()];
  if (fileName.endsWith(".html") || fileName.endsWith(".htm")) return [html()];
  if (fileName.endsWith(".md") || fileName.endsWith(".markdown")) return [markdown()];
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) return [yaml()];
  if (fileName.endsWith(".py")) return [python()];
  if (fileName.endsWith(".sql")) return [sql()];
  if (fileName.endsWith(".xml") ||
    fileName.endsWith(".atom") ||
    fileName.endsWith(".rdf") ||
    fileName.endsWith(".rss") ||
    fileName.endsWith(".rss") ||
    fileName.endsWith(".xht") ||
    fileName.endsWith(".xhtml") ||
    fileName.endsWith(".svg")) return [xml()];
  return [];
}

