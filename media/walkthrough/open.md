## Open a manifest

Any `.m3u8` or `.mpd` file in the workspace is read as you type: the findings appear on the line you
have to fix, with the rule id as the diagnostic code.

To read one from a CDN instead, run [Open Manifest URL…](command:hlsLens.openUrl). Redirects are
followed, and the URL the content *actually* came from is what child URIs resolve against — so
opening a variant after a CDN redirect goes to the right host rather than the one you typed.

Nothing is sent anywhere: the rules read the manifest's own declarations.
