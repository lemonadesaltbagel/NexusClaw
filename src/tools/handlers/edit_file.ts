import { readFileSync, writeFileSync } from "node:fs";

function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'") // curly single -> straight
    .replace(/[\u201C\u201D\u2033]/g, '"'); // curly double -> straight
}

function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normSearch = normalizeQuotes(searchString);
  const normFile = normalizeQuotes(fileContent);
  const idx = normFile.indexOf(normSearch);
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
  return null;
}

function formatDiff(
  content: string,
  actualOld: string,
  newString: string,
): string {
  const lines = content.split("\n");
  const oldLines = actualOld.split("\n");

  // Find the starting line number of the match
  const beforeMatch = content.slice(0, content.indexOf(actualOld));
  const startLine = beforeMatch.split("\n").length;

  const newLines = newString.split("\n");
  const removals = oldLines.map((l) => `- ${l}`);
  const additions = newLines.map((l) => `+ ${l}`);

  return (
    `\n@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@\n` +
    [...removals, ...additions].join("\n")
  );
}

export function editFile(input: {
  file_path: string;
  old_string: string;
  new_string: string;
}): string {
  try {
    const content = readFileSync(input.file_path, "utf-8");

    const actualOld = findActualString(content, input.old_string);
    if (!actualOld) return `Error: old_string not found in ${input.file_path}`;

    const usedQuoteNorm = actualOld !== input.old_string;

    // Unique match check
    const count = content.split(actualOld).length - 1;
    if (count > 1)
      return `Error: old_string found ${count} times. Must be unique.`;

    const diff = formatDiff(content, actualOld, input.new_string);
    const newContent = content.replace(actualOld, input.new_string);
    writeFileSync(input.file_path, newContent);

    const suffix = usedQuoteNorm ? " (matched via quote normalization)" : "";
    return `Successfully edited ${input.file_path}${suffix}\n${diff}`;
  } catch (e: any) {
    return `Error editing file: ${e.message}`;
  }
}
