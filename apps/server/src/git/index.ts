/** Public surface of the git layer. */

export { canonicalizePath } from './paths.ts';

export {
  git,
  gitOrThrow,
  assertAllowed,
  bytesToText,
  GitError,
  GitNotAllowedError,
  type GitResult,
  type GitCallOptions,
} from './run.ts';

export { CatFile } from './catfile.ts';

export {
  parsePorcelainStatusV2,
  readStatus,
  type ParsedStatus,
  type StatusBranch,
  type StatusEntry,
  type OrdinaryStatusEntry,
  type RenamedStatusEntry,
  type UntrackedStatusEntry,
} from './status.ts';

export {
  parseWorktreeListPorcelain,
  listWorktrees,
  findWorktreeForBranch,
  createDetachedWorktree,
  scopedRemoveWorktree,
  worktreeDirName,
  slugifyBranch,
  checkoutDetached,
  type WorktreeEntry,
  type CreateDetachedWorktreeParams,
  type ScopedRemoveParams,
} from './worktree.ts';

export { buildFileList, type BuildFileListParams } from './filelist.ts';

export {
  detectForge,
  forgeFor,
  type Forge,
  type ForgeOptions,
  type ListOpenPullsResult,
  type MergedPrCommits,
  type PullSearchHit,
  type PullSummary,
  type ResolvedPr,
} from './forge/index.ts';

export { getMe, gitUserName, type Me } from './me.ts';

export { countAheadBehind, listBranches, selectBranches, type BranchSummary, type ListBranchesOptions } from './refs.ts';

export {
  blobSideSize,
  getFilePatch,
  getFileContents,
  readBlobSide,
  type BlobSideParams,
  type GetFilePatchParams,
  type GetFileContentsParams,
  type FilePatchEntryInput,
} from './diff.ts';

export {
  gitCommonDir,
  showToplevel,
  defaultBranch,
  parseRemoteIdentity,
  remoteIdentity,
  remoteHost,
  parseRemoteHost,
  baseMergeBase,
  mergeBase,
  revParse,
  divergence,
  detectInProgressOperation,
  pinReviewRef,
  pinReviewBaseRef,
  unpinReviewRefs,
  type RemoteIdentity,
  type Divergence,
} from './repo.ts';
