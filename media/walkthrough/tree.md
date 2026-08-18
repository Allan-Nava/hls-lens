## Read the shape of the stream

The **HLS** view in the activity bar shows the manifest as it is structured rather than as it is
written: the ladder in ascending bitrate (with the I-frame streams kept out of it, where they
belong), the alternate audio and subtitle groups, the segments with their discontinuity and gap
marks, the low-latency parts, and the findings.

Clicking any row reveals its line. An `.mpd` gets the same treatment: periods, adaptation sets and
the representations under them.

[Show the timeline](command:hlsLens.showTimeline) draws the same thing as a strip, with the rungs
stacked on one axis so that boundaries which do not line up are visible instead of computed.
