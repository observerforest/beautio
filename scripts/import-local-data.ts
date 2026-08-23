import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localInventoryImportSchema } from "../packages/contracts/src/index.ts";
import {
  createInventoryItem,
  createProduct,
} from "../packages/domain/src/index.ts";
import { SqliteInventoryRepository } from "../packages/database/src/index.ts";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const importPathArgument = process.argv.slice(2).find((argument) => argument !== "--");
if (importPathArgument === undefined || importPathArgument.trim().length === 0) {
  throw new Error(
    "Usage: pnpm import:local -- <path-to-import.json>",
  );
}

const importPath = resolve(process.cwd(), importPathArgument);
const databasePath =
  process.env.BEAUTIO_DB_PATH ??
  join(repositoryRoot, ".local", "beautio-validation.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const parsed = localInventoryImportSchema.parse(
  JSON.parse(await readFile(importPath, "utf8")) as unknown,
);
const repository = new SqliteInventoryRepository(databasePath);

try {
  const result = await repository.importInventoryData({
    products: parsed.products.map((product) =>
      createProduct({
        id: product.id,
        name: product.name,
        category: product.category,
        sizeLabel: product.size_label,
        imageRef: product.image_ref,
        ingredientListText: product.ingredient_list_text,
        sharedNotes: product.shared_notes,
      }),
    ),
    inventoryItems: parsed.inventory_items.map((item) =>
      createInventoryItem({
        id: item.id,
        productId: item.product_id,
        lifecycleStatus: item.lifecycle_status,
        openedOn: item.opened_on,
        openedOnAccuracy: item.opened_on_accuracy,
        expiresOn: item.expires_on,
        paoDurationMonths: item.pao_duration_months,
        paoDeadline: item.pao_deadline,
        usableUntil: item.usable_until,
        customNotes: item.custom_notes,
      }),
    ),
  });

  console.log(
    JSON.stringify(
      {
        database: databasePath,
        import_file: importPath,
        ...result,
      },
      null,
      2,
    ),
  );
} finally {
  repository.close();
}
