const PREVIEW_EXTENSION_MAP: Record<
  string,
  { kind: PreviewKind; mimeType: string }
> = {
  // Images
  png: { kind: "image", mimeType: "image/png" },
  jpg: { kind: "image", mimeType: "image/jpeg" },
  jpeg: { kind: "image", mimeType: "image/jpeg" },
  gif: { kind: "image", mimeType: "image/gif" },
  webp: { kind: "image", mimeType: "image/webp" },
  bmp: { kind: "image", mimeType: "image/bmp" },
  svg: { kind: "image", mimeType: "image/svg+xml" },
  ico: { kind: "image", mimeType: "image/x-icon" },

  // Video
  mp4: { kind: "video", mimeType: "video/mp4" },
  ogv: { kind: "video", mimeType: "video/ogv" },
  webm: { kind: "video", mimeType: "video/webm" },
  mov: { kind: "video", mimeType: "video/quicktime" },
  avi: { kind: "video", mimeType: "video/x-msvideo" },
  mkv: { kind: "video", mimeType: "video/x-matroska" },

  // Audio
  aac: { kind: "audio", mimeType: "audio/aac" },
  mp3: { kind: "audio", mimeType: "audio/mpeg" },
  m4a: { kind: "audio", mimeType: "audio/mp4" },
  wav: { kind: "audio", mimeType: "audio/wav" },
  ogg: { kind: "audio", mimeType: "audio/ogg" },
  flac: { kind: "audio", mimeType: "audio/flac" },

  // Documents
  pdf: { kind: "pdf", mimeType: "application/pdf" },

  // 3D (currently classified for preview-tab routing)
  glb: { kind: "model", mimeType: "model/gltf-binary" },
  gltf: { kind: "model", mimeType: "model/gltf+json" },
  obj: { kind: "model", mimeType: "model/obj" },
  stl: { kind: "model", mimeType: "model/stl" },
  fbx: { kind: "model", mimeType: "application/octet-stream" },
  dae: { kind: "model", mimeType: "model/vnd.collada+xml" },
  ply: { kind: "model", mimeType: "application/octet-stream" },
  "3mf": { kind: "model", mimeType: "model/3mf" },
  usdz: { kind: "model", mimeType: "model/vnd.usdz+zip" },
};

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "model";

export type PreviewDescriptor = {
  kind: PreviewKind;
  mimeType: string;
  extension: string;
};

const PLAIN_TEXT_EXTENSIONS = new Set([
  // source code
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "cxx",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "lua",
  "r",
  "pl",
  "scala",
  "clj",
  "ex",
  "exs",
  "erl",
  "hrl",
  // web/data/config/docs
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "xml",
  "xsd",
  "svg",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "properties",
  "md",
  "markdown",
  "mdx",
  "txt",
  "log",
  "csv",
  "tsv",
  "sql",
  "graphql",
  "gql",
  // infra/build/package files
  "dockerfile",
  "containerfile",
  "mk",
  "mak",
  "gradle",
  "cmake",
  "lock",
  "gitignore",
  "gitattributes",
  "editorconfig",
  // env and templates
  "env",
  "tmpl",
  "template",
  "mustache",
  "hbs",
]);

const PLAIN_TEXT_FILENAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gnumakefile",
  "readme",
  "readme.md",
  "license",
  "changelog",
  "contributing",
  "authors",
  "notice",
  "copying",
  ".env",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".eslintignore",
  ".nvmrc",
]);

export const getFileExtension = (path: string) => {
  const normalized = path.replaceAll("\\", "/").trim();
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return "";
  return fileName.slice(dotIndex + 1).toLowerCase();
};

export const isMarkdownPath = (path: string): boolean => {
  const extension = getFileExtension(path);
  return extension === "md" || extension === "markdown" || extension === "mdx";
};

export const isPreviewBackedByTextBufferPath = (path: string): boolean => {
  const extension = getFileExtension(path);
  return (
    extension === "svg" ||
    extension === "md" ||
    extension === "markdown" ||
    extension === "mdx"
  );
};

export const getPreviewDescriptor = (
  path: string,
): PreviewDescriptor | null => {
  const extension = getFileExtension(path);
  if (!extension) return null;
  const match = PREVIEW_EXTENSION_MAP[extension];
  if (!match) return null;
  return { ...match, extension };
};

export const isLikelyPlainTextPath = (path: string): boolean => {
  const normalized = path.replaceAll("\\", "/").trim();
  const fileName = normalized
    .slice(normalized.lastIndexOf("/") + 1)
    .toLowerCase();
  const extension = getFileExtension(normalized);

  if (!fileName) return false;
  if (PLAIN_TEXT_FILENAMES.has(fileName)) return true;
  if (fileName.startsWith(".env.")) return true;
  if (fileName.startsWith("dockerfile.") || fileName.endsWith(".dockerfile"))
    return true;
  if (
    fileName.startsWith("containerfile.") ||
    fileName.endsWith(".containerfile")
  )
    return true;
  if (extension && PLAIN_TEXT_EXTENSIONS.has(extension)) return true;

  return false;
};

export const isLikelyBinaryDecodedContent = (content: string): boolean => {
  if (!content) return false;

  // NUL bytes are the strongest indicator of binary payload.
  if (content.includes("\u0000")) return true;

  const sample = content.slice(0, 8192);
  let suspicious = 0;

  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    // Keep common text control chars (\t, \n, \r) and printable ranges.
    const allowed =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code <= 0x7e) ||
      code >= 0xa0;
    if (!allowed) suspicious += 1;
  }

  const replacementCharCount = (sample.match(/\uFFFD/g) ?? []).length;
  const suspiciousRatio = (suspicious + replacementCharCount) / sample.length;

  // Conservative threshold: catches most binary blobs while preserving text.
  return suspiciousRatio > 0.12;
};
