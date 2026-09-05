import {
  inventorySearchOptionsSchema,
  searchInventoryInputSchema,
  type SearchInventoryOutput,
} from "@beautio/contracts";
import { BeautioError, parseIsoDate } from "@beautio/domain";
import { parseInput } from "./input-parsing.ts";
import { inventoryMatchesQuery, toInventorySearchItemOutput } from "./output-mappers.ts";
import type { InventoryRepository } from "./ports.ts";
import { loadProducts } from "./repository-queries.ts";

const maximumSearchCandidateItems = 1_000;

/**
 * Searches a bounded inventory collection with scope filtering before pagination.
 *
 * @param repository - Read-only access to inventory candidates and shared Products.
 * @param untrustedInput - Existing strict search input, without adapter-specific fields.
 * @param options - Strict scope options; omitted scope preserves the all-inventory default.
 * @returns Stable ID-ordered matches and totals, deriving status only for explicit dates.
 */
export async function searchInventoryRecords(
  repository: Pick<InventoryRepository, "findAll" | "findProductById">,
  untrustedInput: unknown,
  options: unknown = { scope: "all" },
): Promise<SearchInventoryOutput> {
  const input = parseInput(searchInventoryInputSchema, untrustedInput);
  const { scope } = parseInput(inventorySearchOptionsSchema, options);
  const items = await repository.findAll({ maximumItems: maximumSearchCandidateItems + 1 });
  if (items.length > maximumSearchCandidateItems) {
    throw new BeautioError("INTERNAL_ERROR", "inventory search exceeds the 1000-item safety limit");
  }
  const scopedItems = items.filter((item) => {
    const active = item.lifecycleStatus === "unopened" || item.lifecycleStatus === "opened";
    return scope === "all" || (scope === "active" ? active : !active);
  });
  const productsById = await loadProducts(repository, scopedItems);
  const normalizedQuery = input.query?.toLowerCase() ?? null;
  const asOf = input.as_of === undefined ? null : parseIsoDate(input.as_of, "as_of");
  const matches = scopedItems.flatMap((item) => {
    const product = item.productId === null ? null : (productsById.get(item.productId) ?? null);
    return inventoryMatchesQuery(item, product, normalizedQuery) ? [{ item, product }] : [];
  });
  matches.sort((left, right) => left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0);
  const page = matches.slice(input.offset, input.offset + input.limit);
  const consumedOffset = input.offset + page.length;
  return {
    query: input.query ?? null,
    offset: input.offset,
    limit: input.limit,
    total: matches.length,
    next_offset: consumedOffset < matches.length ? consumedOffset : null,
    items: page.map(({ item, product }) => toInventorySearchItemOutput(item, product, asOf)),
  };
}
