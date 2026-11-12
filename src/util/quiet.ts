/**
 * Drop Node's one-line SQLite ExperimentalWarning so stdio clients and shell
 * users see only tool output. Every other warning still prints. Import this
 * module before anything that loads `node:sqlite`.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  const name = typeof warning === "string" ? type : warning.name;
  if (name === "ExperimentalWarning" && /sqlite/i.test(text)) return;
  (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
