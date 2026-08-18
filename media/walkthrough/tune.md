## Make it yours, and take it with you

Rule ids are stable, so a team can pin them. A rule you disagree with about *how loud* it should be
does not have to be switched off — `hlsLens.diagnostics.severity` re-grades it by id or by whole
category, and `hlsLens.diagnostics.profile` gives you `apple` or `low-latency` as a starting point
with your own settings applied on top.

[Show the Rule Reference](command:hlsLens.showRules) opens the whole catalogue, generated from the
extension itself, with the reason each rule matters rather than just what it matches.

When you need to hand the findings to whoever produced the manifest,
[Export Findings as a Report](command:hlsLens.exportReport) writes them as markdown for a ticket or
as JSON for whatever reads it next.
