import { z } from "zod";

export const commandExecutionPrincipals = ["custom_gpt"] as const;

export const commandExecutionPrincipalSchema = z.enum(
  commandExecutionPrincipals,
);

export type CommandExecutionPrincipal = z.infer<
  typeof commandExecutionPrincipalSchema
>;

export const consequentialCommandOperationIds = [
  "upload_product_images",
  "create_inventory_batch",
  "revise_product_profile",
  "set_product_display_image",
  "correct_inventory_item_facts",
  "set_inventory_item_custom_notes",
  "record_product_opened",
  "end_inventory_item_use",
] as const;

export const consequentialCommandOperationIdSchema = z.enum(
  consequentialCommandOperationIds,
);

export type ConsequentialCommandOperationId = z.infer<
  typeof consequentialCommandOperationIdSchema
>;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const canonicalUuidSchema = z
  .string()
  .regex(CANONICAL_UUID_PATTERN, "command_id must be a canonical lowercase UUID");

export const commandIdSchema = canonicalUuidSchema.brand<"CommandId">();

export type CommandId = z.infer<typeof commandIdSchema>;

export const commandExecutionStatusSchema = z.enum([
  "in_progress",
  "succeeded",
  "failed",
]);

export type CommandExecutionStatus = z.infer<
  typeof commandExecutionStatusSchema
>;

export const getCommandStatusInputSchema = z.strictObject({
  operation_id: consequentialCommandOperationIdSchema,
  command_id: commandIdSchema,
});

export type GetCommandStatusInput = z.infer<
  typeof getCommandStatusInputSchema
>;
