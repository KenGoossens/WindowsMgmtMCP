import { psQuote } from "../../core/powershell.js";

export interface CimQueryInput {
  className?: string;
  wql?: string;
  namespace?: string;
  filter?: string;
  depth?: number;
}

/**
 * Build a safe `Get-CimInstance` script that emits JSON. Every interpolated
 * value is single-quote escaped to prevent script injection through tool input.
 */
export function buildCimQueryScript(input: CimQueryInput): string {
  const depth = input.depth ?? 4;
  const ns = input.namespace ? ` -Namespace ${psQuote(input.namespace)}` : "";

  let base: string;
  if (input.wql) {
    base = `Get-CimInstance -Query ${psQuote(input.wql)}${ns}`;
  } else if (input.className) {
    const filter = input.filter ? ` -Filter ${psQuote(input.filter)}` : "";
    base = `Get-CimInstance -ClassName ${psQuote(input.className)}${ns}${filter}`;
  } else {
    throw new Error("wmi_query requires either 'className' or 'wql'");
  }

  return `${base} -ErrorAction Stop | ConvertTo-Json -Depth ${depth}`;
}
