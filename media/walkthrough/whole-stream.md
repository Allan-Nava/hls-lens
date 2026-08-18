## Look at more than one file

Every rule so far judges one manifest, which is all a single open file allows. Three commands go
wider:

- [Check Renditions Together](command:hlsLens.checkTogether) loads every rung of the open master and
  reports what they disagree about — a segment count that does not match, boundaries that drift, one
  rung that already ended while the others are live.
- [Check All Manifests in Workspace](command:hlsLens.checkWorkspace) reads every manifest in the
  folder, including the ones nobody has opened. That is usually where the defect is.
- [Compare With…](command:hlsLens.compareWith) takes another manifest and says what changed: rungs
  added, removed or re-rated, a group that disappeared.
