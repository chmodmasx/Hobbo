import { DomainInvariantError } from "@hobbo/domain";

export function toJsonParameter(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new DomainInvariantError(`${label} is not JSON-serializable`);
    }
    return encoded;
  } catch (error) {
    if (error instanceof DomainInvariantError) throw error;
    throw new DomainInvariantError(
      `${label} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
