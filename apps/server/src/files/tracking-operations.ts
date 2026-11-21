import { checkpointDiff, createCheckpoint, gitDiff, gitStatus, restoreCheckpoint } from "./git.js";
import { snapshotFiles } from "./tracker.js";

// These operations also run in the offline executor. Keep their results JSON-safe.
export const trackingOperations = {
  status: gitStatus,
  diff: gitDiff,
  snapshot: async (root: string) => [...await snapshotFiles(root)],
  before: async (root: string, turnId: string) => ({
    entries: [...await snapshotFiles(root)], ref: await createCheckpoint(root, turnId),
  }),
  after: async (root: string, turnId: string) => ({
    entries: [...await snapshotFiles(root)], changes: await checkpointDiff(root, turnId),
  }),
  restore: async (root: string, turnId: string) => { await restoreCheckpoint(root, turnId); return true; },
};
export type TrackingOperation = keyof typeof trackingOperations;
export type TrackingResult<K extends TrackingOperation> = Awaited<ReturnType<(typeof trackingOperations)[K]>>;
