/**
 * Obtains a post-create inventory snapshot even when refresh deduplicates an older GET.
 *
 * @param refresh - Existing read-only refresh callback, which may reuse an in-flight read.
 * @returns Whether the second read succeeded. The first await drains any read started
 * before creation; its success cannot confirm new inventory, and its failure does not
 * prevent the next read. Neither call creates or retries a write.
 */
export async function refreshCreatedInventorySnapshot(
  refresh: (showLoading?: boolean) => Promise<boolean>,
): Promise<boolean> {
  try {
    await refresh(false);
  } catch {
    // An older read may have failed; still attempt a new post-create read.
  }
  try {
    return await refresh(false);
  } catch {
    return false;
  }
}
