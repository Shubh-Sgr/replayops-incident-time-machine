/** Renders text with http(s) URLs as links, so generated guidance can point straight at diffs and logs. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return <>{parts.map((part, index) => /^https?:\/\//.test(part)
    ? <a key={index} href={part} target="_blank" rel="noreferrer" className="break-all font-semibold text-info underline decoration-info/40 underline-offset-2 hover:decoration-info">{part.replace(/^https?:\/\/(www\.)?/, "").replace(/^github\.com\//, "GitHub › ")}</a>
    : <span key={index}>{part}</span>)}</>;
}
