/**
 * Serialises note selection changes behind a flush of the current editor content.
 */

export function createNoteSelectionQueue(
  flush: () => Promise<void>,
  commitSelection: (id: string) => void,
): (id: string) => void {
  let chain = Promise.resolve();

  return (id: string) => {
    chain = chain.then(async () => {
      try {
        await flush();
        commitSelection(id);
      } catch {
        /* flush failed — keep current selection */
      }
    });
  };
}
